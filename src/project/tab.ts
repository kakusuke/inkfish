import { basename, dirname } from "../shared/paths";
import { DocumentViewer, type LinkTarget } from "../viewer/viewer";
import { readMdFile } from "../chrome/files";
import { keepSynced, loadPair, makeSides, type DiffSync, type Hunk } from "../viewer/split";
import { splitDiff } from "../shared/rev";
import type { FindState } from "../viewer/find";

let SEQ = 0;

export type TabHooks = {
  resolveAsset: (absPath: string) => string;
  /// キャプションが決まった (front matter の title かファイル名)
  onCaption: (tab: DocTab) => void;
  onNotice: (message: string) => void;
  onProgress: (tab: DocTab, ratio: number) => void;
  onFindUpdate: (tab: DocTab, state: FindState) => void;
  onLinkActivate: (target: LinkTarget) => void;
};

/// プロジェクトウィンドウのタブ 1 つ。文書とその中身 (DocumentViewer) を持つ。
///
/// 単一文書ウィンドウでは AppShell が持っていた「開いているパス・読み込んだ
/// ソースの控え・再読込のタイマー」を、タブごとに持つ形にしたもの。
export class DocTab {
  readonly id: string;
  readonly pane: HTMLElement;
  /// 終点側 (差分でないタブではこれだけ)。検索やライトボックスはこちらに効く
  readonly viewer: DocumentViewer;
  /// 起点側。差分タブのときだけ左に並ぶ
  readonly beforeViewer: DocumentViewer | null = null;
  /// 左右の器。片側にしか無いファイルのとき、無い側に印を出すのに使う
  private beforeHost: HTMLElement | null = null;
  private afterHost: HTMLElement | null = null;
  /// 差分の ID を割った結果 (左右それぞれの ID)。ふつうのタブでは null
  private pair: { before: string; after: string } | null = null;
  private track: HTMLElement | null = null;
  private viewport: HTMLElement | null = null;
  /// 差分タブの左右連動。ジャンプもここが受け持つ
  sync: DiffSync | null = null;
  /// 行差分。左右の位置合わせに使う
  private hunks: Hunk[] = [];

  name: string;
  /// front matter の title があればそれ、なければファイル名
  caption: string;
  /// 読み込んだソースの控え。監視は親ディレクトリ単位なので中身が変わって
  /// いない通知も届く。無駄な再描画を避けるために突き合わせる。
  private source = "";
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly path: string,
    panes: HTMLElement,
    hooks: TabHooks
  ) {
    this.id = `t${++SEQ}`;
    this.name = basename(path) || path;
    this.caption = this.name;

    // 差分の ID (diff:/…) なら左右に並べる。ふつうのパスや起点版の ID なら 1 枚
    this.pair = splitDiff(path);

    this.pane = document.createElement("div");
    // display:none ではなく visibility で隠す (project.css の注記参照)。
    // レイアウトを残さないと図とスライドの採寸が壊れる。
    this.pane.className = "ink-tabpane is-inactive";
    this.pane.dataset.tab = this.id;
    panes.appendChild(this.pane);

    let afterHost: HTMLElement = this.pane;
    if (this.pair) {
      const sides = makeSides(this.pane);
      this.beforeHost = sides.beforeHost;
      this.afterHost = sides.afterHost;
      this.track = sides.track;
      this.viewport = sides.viewport;
      afterHost = sides.afterHost;
      this.beforeViewer = new DocumentViewer(sides.beforeHost, {
        resolveAsset: hooks.resolveAsset,
        // ひとつの document に 2 つ載るので、見出しや脚注の id を分ける
        idPrefix: `${this.id}-b-`,
        onNotice: (m) => hooks.onNotice(m),
        onLinkActivate: (t) => hooks.onLinkActivate(t),
      });
      void this.beforeViewer.setFrozen(true);
    }

    this.viewer = new DocumentViewer(afterHost, {
      resolveAsset: hooks.resolveAsset,
      // 見出しと脚注の id はタブごとの名前空間に分ける。ひとつの document に
      // 複数の文書が載るため、前置きしないと id が衝突する。
      idPrefix: this.pair ? `${this.id}-a-` : `${this.id}-`,
      onCaption: ({ title, name }) => {
        this.caption = title || name;
        hooks.onCaption(this);
      },
      onNotice: (m) => hooks.onNotice(m),
      onProgress: (r) => hooks.onProgress(this, r),
      onFindUpdate: (s) => hooks.onFindUpdate(this, s),
      onLinkActivate: (t) => hooks.onLinkActivate(t),
    });
    // 表に出るまで再描画を溜める
    void this.viewer.setFrozen(true);
    // 左右の動きを合わせる。スクロールはタブの器が受け持ち、中身はずらす
    if (this.beforeViewer && this.track && this.viewport) {
      this.sync = keepSynced(
        this.pane,
        this.track,
        this.viewport,
        this.beforeViewer,
        this.viewer,
        () => this.hunks
      );
    }
  }

  get isMarp() {
    return this.viewer.isMarp;
  }

  get isDiff() {
    return !!this.pair;
  }

  /// 読み込んで描く。失敗したら理由を投げる (呼び出し側がタブを捨てる)。
  ///
  /// 差分タブでは片側にしか無いファイル (追加・削除) がふつうにあるので、
  /// 無い側は空のまま印を出すだけにして、タブ自体は開いたままにする。
  async load() {
    if (this.pair && this.beforeViewer && this.beforeHost && this.afterHost) {
      const got = await loadPair(
        { viewer: this.beforeViewer, id: this.pair.before, host: this.beforeHost },
        { viewer: this.viewer, id: this.pair.after, host: this.afterHost },
        this.name
      );
      if (!got.before && !got.after) throw new Error("どちらの版にもありません");
      this.hunks = got.hunks;
      this.sync?.toTop();
      this.sync?.refresh();
      return;
    }

    this.source = await readMdFile(this.path);
    await this.viewer.setSource(this.source, {
      baseDir: dirname(this.path),
      name: this.name,
    });
    this.viewer.scrollToTop();
  }

  /// ファイルが変わったときの再読込。連続した通知はまとめる。
  scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 60);
  }

  private async reload(retry = true) {
    try {
      const src = await readMdFile(this.path);
      // atomic save の途中で空ファイルを読むことがあるため一度だけリトライ
      if (src === "" && this.source !== "" && retry) {
        setTimeout(() => void this.reload(false), 150);
        return;
      }
      if (src === this.source) return;
      this.source = src;
      await this.viewer.setSource(src, {
        baseDir: dirname(this.path),
        name: this.name,
      });
    } catch {
      if (retry) setTimeout(() => void this.reload(false), 150);
    }
  }

  setActive(active: boolean) {
    this.pane.classList.toggle("is-inactive", !active);
    // 隠れている間の再描画は溜めておく (テーマ切替でタブの数だけ走らせない)
    void this.viewer.setFrozen(!active);
    void this.beforeViewer?.setFrozen(!active);
    if (active) this.viewer.focus();
  }

  dispose() {
    this.sync?.stop();
    clearTimeout(this.reloadTimer);
    this.viewer.dispose();
    this.beforeViewer?.dispose();
    this.pane.remove();
  }
}
