import DOMPurify from "dompurify";
import { SCHEME, resolvePath } from "../shared/paths";
import { md, enhanceCodeBlocks } from "./markdown";
import type { ChangeKind } from "./split";
import { buildFrontMatterCard, fmTitle, parseFrontMatter } from "./frontmatter";
import { applyMarpBrowser, fixSlideAspectRatio, isMarpDocument, renderMarp } from "./marp";
import type { MarpCoreBrowser } from "@marp-team/marp-core/browser";
import {
  extractMermaidBlocks,
  mermaidConfigKey,
  runMermaid,
  type MermaidContext,
} from "./mermaid";
import { Lightbox } from "./lightbox";
import { FindEngine, type FindState } from "./find";

/// ビューアが押されたリンクをどう扱ってほしいか。
/// ページ内アンカーはビューアが自分でスクロールするので通知しない。
export type LinkTarget =
  // スキームのあるもの (http(s):// / mailto: / tel: など)
  | { kind: "external"; href: string }
  // スキームなし = ローカルファイルアクセス。baseDir で解決済みの絶対パス
  | { kind: "local"; path: string };

export type ViewerOptions = {
  /// 相対パスの画像を表示できる URL に変換する。Tauri では convertFileSrc。
  /// 関数で受けることでビューア自体は Tauri に依存しない。
  resolveAsset: (absPath: string) => string;
  /// front matter の title / ファイル名。ツールバーやウィンドウタイトルに使う。
  onCaption?: (c: { title: string; name: string }) => void;
  /// 利用者に伝えるべき失敗 (トースト相当)
  onNotice?: (message: string) => void;
  /// 読書位置 0..1
  onProgress?: (ratio: number) => void;
  onFindUpdate?: (s: FindState) => void;
  onLinkActivate?: (t: LinkTarget) => void;
  /// 見出しや脚注の id に付ける接頭辞。ひとつの document にビューアを複数
  /// (タブごとに 1 つ) 載せるときに、文書間で id が衝突しないよう分ける。
  /// 省略すると前置きしない (単一文書のウィンドウは従来どおりの id になる)。
  idPrefix?: string;
};

const MARKUP = `
  <article class="ink-doc markdown-body hidden"></article>
  <div class="ink-slides hidden"></div>
`;

export class DocumentViewer {
  private root: HTMLElement;
  private docEl: HTMLElement;
  private slidesEl: HTMLElement;
  private lightbox: Lightbox;
  private find_: FindEngine;
  private opts: ViewerOptions;

  private source = "";
  /// 差分で変わった行 (元テキストの 0 始まり)。印を付けるためだけに持つ
  private changedLines: Map<number, ChangeKind> | null = null;
  /// 変更の線を引き直すのを 1 フレームにまとめるための印
  private barsQueued = false;
  private barObserver: ResizeObserver;
  private baseDir = "";
  private name = "";
  private scale = 1;
  // 直近の検索語。再描画するとマッチの Range が無効になるので張り直すのに使う。
  // clearFind() で空に戻すので、検索を閉じたあとの再描画では張り直さない。
  private lastQuery = "";
  // 再描画の世代。await をまたいだ後に新しい描画が始まっていたら、古い方は手を引く。
  private renderSeq = 0;
  // 直近の描画が Marp スライドだったか。図のテーマ選びに使う。
  private marpMode = false;
  // PDF 書き出し中か。Chromium (WebView2 の PrintToPdf を含む) は印刷レイアウトに
  // 入るとき prefers-color-scheme を light へ切り替え、生きている DOM 上で change を
  // 発火させる。その通知で再描画すると描き途中の DOM がそのまま紙に乗るため抑止する。
  private exporting = false;
  // 非アクティブなタブは凍結して再描画を溜める。凍結を解くときに描き直す。
  // (凍結しないと、テーマ切替でタブの数だけ同時に再描画が走る)
  private frozen = false;
  private dirty = false;
  // 自分の SVG がどの mermaid 設定で描かれたか (図が無ければ null)。
  // 設定はライブラリ全体で 1 本なので、他のビューアが描くと変わってしまう。
  // 書き出し後に描き直しが要るかの判定に使うため、自分の分を控えておく。
  private lastMermaidKey: string | null = null;
  // Marp の browser() ハンドル。container に束縛されるのでインスタンスごとに持つ。
  private marpBrowser: MarpCoreBrowser | null = null;
  private themeMedia = matchMedia("(prefers-color-scheme: dark)");
  private onThemeChange = () => {
    // Chromium は印刷レイアウトに入るとき prefers-color-scheme を light へ切り替え、
    // 生きているドキュメント上でここを発火させる (WebView2 の PrintToPdf も同じ)。
    // 書き出し中に再描画すると印刷が描き途中の DOM を撮ってしまうので無視する。
    // 書き出しの前後で必要な描き直しは endExport() が自前で行う。
    if (this.exporting) return;
    // 隠れているタブは描き直さず、表に出るときまで溜める
    if (this.frozen) {
      this.dirty = true;
      return;
    }
    // 図のテーマの当て直しは render() が描画の直前に行う
    if (this.source) this.render();
  };

  constructor(container: HTMLElement, opts: ViewerOptions) {
    this.opts = opts;

    this.root = document.createElement("div");
    this.root.className = "ink-viewer";
    this.root.tabIndex = -1;
    this.root.innerHTML = MARKUP;
    container.appendChild(this.root);

    // 差分の線は本文の寸法に合わせて置くので、図の読み込みや幅の変化で
    // 引き直す (変わったところが無ければ何もしない)
    this.barObserver = new ResizeObserver(() => this.queueChangeBars());

    this.docEl = this.root.querySelector<HTMLElement>(".ink-doc")!;
    this.barObserver.observe(this.docEl);
    this.slidesEl = this.root.querySelector<HTMLElement>(".ink-slides")!;
    // ライトボックスはスクロールコンテナの外 (root の兄弟) に置く。
    // 中に入れるとスクロール位置に追従してしまう。
    this.lightbox = new Lightbox(container);

    this.find_ = new FindEngine(
      this.root,
      () => (this.marpMode ? this.slidesEl : this.docEl),
      [this.docEl, this.slidesEl],
      (s) => this.opts.onFindUpdate?.(s)
    );

    this.setScale(1);
    this.root.addEventListener("scroll", () => this.reportProgress(), { passive: true });
    window.addEventListener("resize", this.reportProgress);
    this.themeMedia.addEventListener("change", this.onThemeChange);
    this.root.addEventListener("click", (e) => this.handleClick(e));
  }

  // ---------- 公開 API ----------

  get isMarp() {
    return this.marpMode;
  }

  /// changedLines は差分で変わった行 (元テキストの 0 始まり) とその変わり方。
  /// 渡すと、その行を含むブロックに印が付く。左右に並べるときにガワが渡す。
  async setSource(
    src: string,
    meta: { baseDir: string; name: string; changedLines?: Map<number, ChangeKind> }
  ) {
    this.source = src;
    this.baseDir = meta.baseDir;
    this.name = meta.name;
    this.changedLines = meta.changedLines ?? null;
    this.dirty = false;
    await this.render();
  }

  /// 表示されていない間は描画そのものを止める。凍結を解くときにまとめて描く。
  ///
  /// タブの切り替えで使う。ファイルの変更やテーマの切り替えは全タブに
  /// 届くので、凍結しないとタブの数だけ描画が走る。
  async setFrozen(frozen: boolean) {
    this.frozen = frozen;
    if (frozen || !this.dirty) return;
    this.dirty = false;
    if (this.source) await this.render();
  }

  setScale(v: number) {
    this.scale = Math.min(1.6, Math.max(0.7, v));
    // documentElement ではなく自分の root に載せる。ガワや他のビューアの
    // 文字サイズを巻き込まない。
    this.root.style.setProperty("--scale", String(this.scale));
  }

  nudgeScale(delta: number) {
    this.setScale(this.scale + delta);
  }

  scrollToTop() {
    this.root.scrollTop = 0;
  }

  focus() {
    this.root.focus();
  }

  // 検索 (UI はガワが持ち、エンジンだけこちらが持つ)
  find(query: string, autoScroll = true) {
    this.lastQuery = query;
    this.find_.run(query, autoScroll);
  }
  findNext() {
    this.find_.move(1);
  }
  findPrev() {
    this.find_.move(-1);
  }
  clearFind() {
    this.lastQuery = "";
    this.find_.clear();
  }

  /// ライトボックスが開いていればキー操作を専有する (本文ズームより優先)。
  /// 処理したら true。
  handleLightboxKey(key: string): boolean {
    return this.lightbox.handleKey(key);
  }

  /// PDF 書き出しの準備。ここで描き切ってから印刷させるのが要点。
  /// Windows の PrintToPdf は生きている DOM をその場で撮るので、mermaid の
  /// 非同期描画が終わる前に走らせると図がソースのまま紙に乗る。
  async beginExport() {
    this.exporting = true;
    this.root.classList.add("is-exporting");
    // 紙面は原寸で流す。--scale は root の inline style に載っているので
    // CSS の `.ink-viewer.is-exporting` からは上書きできない (inline が勝つ)。
    // ここで直接 1 に倒し、endExport() で戻す。
    this.root.style.setProperty("--scale", "1");
    // 検索のゴースト消し用 filter が残っていると、Chromium は本文を丸ごと
    // ビットマップへラスタライズしてしまう。書き出し前に必ず外す。
    this.find_.clearRepaint();
    await this.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  async endExport() {
    this.exporting = false;
    this.root.classList.remove("is-exporting");
    this.root.style.setProperty("--scale", String(this.scale));
    // 図の色を画面用へ戻す (設定の当て直しは render() 側でやる)。書き出し中に
    // OS のテーマが変わっていた場合もここで拾える (その間の change 通知は
    // 上で無視しているため)。図が一つも無い文書では描き直す必要がない。
    if (this.lastMermaidKey && this.lastMermaidKey !== mermaidConfigKey(this.mermaidContext())) {
      await this.render();
    }
  }

  /// 破棄。タブを閉じるときに呼ぶ。root と ライトボックス の DOM を外し、
  /// document に残る CSS.highlights も片付ける。
  dispose() {
    this.barObserver.disconnect();
    this.themeMedia.removeEventListener("change", this.onThemeChange);
    window.removeEventListener("resize", this.reportProgress);
    this.find_.dispose();
    this.lightbox.dispose();
    // root の listener はすべて root 自身に付いているのでノードごと回収される
    this.root.remove();
  }

  // ---------- 内部 ----------

  private mermaidContext(): MermaidContext {
    return { exporting: this.exporting, marp: this.marpMode };
  }

  private reportProgress = () => {
    const max = this.root.scrollHeight - this.root.clientHeight;
    this.opts.onProgress?.(max > 0 ? Math.min(1, this.root.scrollTop / max) : 0);
  };

  private notice(msg: string) {
    // 書き出し中のトーストは紙に写ってしまうので出さない
    if (!this.exporting) this.opts.onNotice?.(msg);
  }

  private async render() {
    // 隠れている間は描かない。表に出るとき (setFrozen(false)) にまとめて描く。
    if (this.frozen) {
      this.dirty = true;
      return;
    }

    // 描画は mermaid / Marp の遅延ロードを挟むので、終わる前に次の描画が
    // 始まりうる。自分より新しい描画が走り出していたら、以降の DOM 操作は
    // すべて古い内容の上書きになるので手を引く。
    const seq = ++this.renderSeq;
    const stale = () => seq !== this.renderSeq;

    // ライトボックスは SVG を id ごと複製して表示するため、開いたまま再描画すると
    // 連番 id が複製側と衝突して新しい図が空になる。表示中のクローンは再描画前の
    // 内容で古くなってもいるので、ここで閉じてしまう。
    this.lightbox.close();

    const scrollTop = this.root.scrollTop;
    // 今回の描画で図を描かなければ「図なし」に戻る
    this.lastMermaidKey = null;
    const fm = await parseFrontMatter(this.source);
    if (stale()) return;
    this.marpMode = isMarpDocument(fm, this.source);
    this.opts.onCaption?.({ title: fmTitle(fm.data), name: this.name });
    if (fm.broken) this.notice("front matter を YAML として読めませんでした");

    this.docEl.classList.toggle("hidden", this.marpMode);
    this.slidesEl.classList.toggle("hidden", !this.marpMode);
    // 使わない側の中身は捨てる。残しておくと mermaid の連番 id が前の描画の
    // SVG とぶつかり、mermaid が id セレクタで隠れている古い方を掴むため、
    // 新しい図が空になる (通常 ⇄ Marp を切り替えると図が消える)。
    (this.marpMode ? this.docEl : this.slidesEl).replaceChildren();

    if (this.marpMode) {
      await renderMarp(this.slidesEl, this.source);
      if (stale()) return;
      // 図の器へ差し替えるのは browser() より前。auto-scaling の対象から外す。
      const blocks = extractMermaidBlocks(this.slidesEl);
      this.marpBrowser = await applyMarpBrowser(this.slidesEl, this.marpBrowser);
      if (stale()) return;
      fixSlideAspectRatio(this.slidesEl);
      if (blocks.length) {
        await this.drawMermaid(blocks, stale);
        if (stale()) return;
      }
    } else {
      // 変わった行は元テキストの行番号なので、front matter を剥がしたぶんずらす
      const env = this.changedLines
        ? {
            changedLines: new Map(
              Array.from(this.changedLines, ([n, kind]) => [n - fm.offset, kind] as const)
            ),
          }
        : {};
      // md ファイル内の生 HTML 経由の XSS (IPC 到達) を防ぐためサニタイズする
      this.docEl.innerHTML = DOMPurify.sanitize(md.render(fm.body, env));
      // Marp 側には当てない。Marp が出す CSS が自分の id を参照しているため。
      this.applyIdPrefix(this.docEl);
      // Marp は front matter を自分で消費するので、カードを足すのは本文モードだけ。
      // 自前で組んだ要素なのでサニタイズ後に入れて問題ない。
      const card = fm.data && buildFrontMatterCard(fm.data);
      if (card) this.docEl.prepend(card);
      this.rewriteLocalImages(this.docEl);
      enhanceCodeBlocks(this.docEl, (m) => this.notice(m));
      const blocks = Array.from(this.docEl.querySelectorAll<HTMLElement>(".mermaid-block"));
      if (blocks.length) {
        await this.drawMermaid(blocks, stale);
        if (stale()) return;
      }
    }

    if (stale()) return;
    this.paintChangeBars();
    this.root.scrollTop = scrollTop;
    this.reportProgress();
    // 再描画でマッチ範囲が無効になるので張り直す (スクロールはしない)。
    // 検索が閉じているときは lastQuery が空なので何もしない。
    if (this.lastQuery) this.find_.run(this.lastQuery, false);
    this.root.classList.remove("is-refreshing");
    requestAnimationFrame(() => this.root.classList.add("is-refreshing"));
  }

  /// 変わったところの左に線を引く。
  ///
  /// markdown-it が印を付けたブロック (.ink-changed) の位置を測り、本文の
  /// 左余白に線を置く。続いているブロックは 1 本にまとめるので、間の余白でも
  /// 線が途切れない。図の読み込みや幅の変化で位置が動くため、docEl の寸法が
  /// 変わるたびに引き直す。
  private paintChangeBars() {
    for (const old of Array.from(this.docEl.querySelectorAll(".ink-change-bar"))) {
      old.remove();
    }
    const blocks = Array.from(this.docEl.querySelectorAll<HTMLElement>(".ink-changed"));
    if (!blocks.length) return;

    const groups: { top: number; bottom: number; kind: string; joins: boolean }[] = [];
    let prev: Element | null = null;
    for (const el of blocks) {
      const kind = el.dataset.change ?? "mod";
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      const last = groups[groups.length - 1];
      const adjacent = !!last && el.previousElementSibling === prev;
      // 隣り合っていて種類も同じなら 1 本につなげる (間の余白ごと埋める)
      if (adjacent && last.kind === kind) {
        last.bottom = bottom;
      } else {
        groups.push({ top, bottom, kind, joins: adjacent });
      }
      prev = el;
    }

    // 隣り合っているのに種類が違うところ (変更のすぐ下が追加、など) は、
    // 色を分ける以上 1 本にはできない。境目で継いで、線が途切れないようにする。
    for (let i = 1; i < groups.length; i++) {
      if (!groups[i].joins) continue;
      const mid = Math.round((groups[i - 1].bottom + groups[i].top) / 2);
      groups[i - 1].bottom = mid;
      groups[i].top = mid;
    }

    for (const g of groups) {
      const bar = document.createElement("div");
      bar.className = "ink-change-bar";
      bar.dataset.change = g.kind;
      bar.setAttribute("aria-hidden", "true");
      bar.style.top = `${g.top}px`;
      bar.style.height = `${Math.max(0, g.bottom - g.top)}px`;
      this.docEl.appendChild(bar);
    }
  }

  /// 寸法が変わったら線を引き直す。連続して呼ばれるので 1 フレームにまとめる。
  private queueChangeBars() {
    if (this.barsQueued) return;
    this.barsQueued = true;
    requestAnimationFrame(() => {
      this.barsQueued = false;
      this.paintChangeBars();
    });
  }

  private async drawMermaid(blocks: HTMLElement[], stale: () => boolean) {
    const key = await runMermaid(
      blocks,
      this.mermaidContext(),
      stale,
      (svg) => this.lightbox.open(svg),
      (m) => this.notice(m)
    );
    if (key) this.lastMermaidKey = key;
  }

  /// 見出し (markdown-it-anchor) と脚注 (fn1 / fnref1 の固定 id) を
  /// インスタンスごとの名前空間へ移す。ページ内リンクも合わせて書き換える。
  private applyIdPrefix(root: HTMLElement) {
    const p = this.opts.idPrefix;
    if (!p) return;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[id]"))) {
      el.id = p + el.id;
    }
    for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))) {
      a.setAttribute("href", `#${p}${a.getAttribute("href")!.slice(1)}`);
    }
  }

  // md ファイルからの相対パス画像を表示できる URL に変換する
  private rewriteLocalImages(root: HTMLElement) {
    if (!this.baseDir) return;
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (!src || SCHEME.test(src)) continue;
      img.src = this.opts.resolveAsset(resolvePath(this.baseDir, decodeURIComponent(src)));
    }
  }

  private handleClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    e.preventDefault();

    // ページ内アンカーはビューアが自分で処理する
    if (href.startsWith("#")) {
      // markdown-it-anchor の id は encodeURIComponent 済み文字列そのもの。
      // まず生の値で引き、無ければデコードした値でも引く(手書き id 対策)。
      const rawId = href.slice(1);
      let target = this.root.querySelector<HTMLElement>(`[id="${CSS.escape(rawId)}"]`);
      if (!target) {
        try {
          const decoded = decodeURIComponent(rawId);
          target = this.root.querySelector<HTMLElement>(`[id="${CSS.escape(decoded)}"]`);
        } catch {
          /* 不正な % シーケンスは無視 */
        }
      }
      target?.scrollIntoView({ behavior: "smooth" });
      return;
    }

    // スキームがあるもの (http(s):// / mailto: / tel: など) は外部で開く
    // (`C:\…` のようなドライブレターはスキームではないのでここには来ない)
    if (SCHEME.test(href)) {
      this.opts.onLinkActivate?.({ kind: "external", href });
      return;
    }

    // ここから下はスキームなし = ローカルファイルアクセスとして扱う。
    // 開き方の判断 (md はこのビューアー / それ以外は OS 既定アプリ) はガワの仕事。
    if (!this.baseDir) return;
    const path = resolvePath(this.baseDir, decodeURIComponent(href));
    this.opts.onLinkActivate?.({ kind: "local", path });
  }
}
