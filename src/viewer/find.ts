// ---------- ページ内検索 ----------
// DOM を書き換えず CSS Custom Highlight API でマッチを塗る。テキストランを
// 分割しないので、折り返し(改行)位置が検索によって変わらない。
// WebKit は highlights を消し替えても旧領域を再描画しないことがあるため、
// 変更後に対象コンテンツを一度だけ同期的に再描画してゴーストを消す。
//
// CSS.highlights は document レベルの API でハイライト名が名前空間そのものなので、
// ひとつの document に複数の FindEngine が載る (タブごとに 1 つ) 場合、名前を
// インスタンスごとに分けないと互いのハイライトを消し合う。名前を連番にし、
// 対応する ::highlight() 規則をここで生成して document に足す。
const HL_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

export type FindState = { index: number; total: number };

let SEQ = 0;
let styleEl: HTMLStyleElement | null = null;

/// インスタンス用の ::highlight() 規則を足す。色はトークン参照なので
/// ダーク / ライトの切り替えにも書き出し時のライト固定にも追従する。
/// (静的な CSS に書けないのは、名前が実行時に決まるため)
function addHighlightRules(match: string, current: string) {
  if (!HL_SUPPORTED) return;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.inkFindHighlights = "";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent += `
::highlight(${match}) {
  background-color: color-mix(in srgb, var(--accent) 26%, transparent);
}
::highlight(${current}) {
  background-color: var(--accent);
  color: #fff;
}
`;
}

export class FindEngine {
  private matches: Range[] = [];
  private index = -1;
  private nudge = false;
  private repaintSeq = 0;
  // このインスタンス専用のハイライト名
  private matchName: string;
  private currentName: string;

  /// scroller: スクロールコンテナ (マッチを画面中央へ寄せるのに使う)
  /// roots: 検索対象になりうる要素。表示中のものだけを走査する
  constructor(
    private scroller: HTMLElement,
    private activeRoot: () => HTMLElement,
    private repaintTargets: HTMLElement[],
    private onUpdate: (s: FindState) => void
  ) {
    const n = ++SEQ;
    this.matchName = `find-match-${n}`;
    this.currentName = `find-current-${n}`;
    addHighlightRules(this.matchName, this.currentName);
  }

  get state(): FindState {
    return { index: this.index, total: this.matches.length };
  }

  run(query: string, autoScroll = true) {
    if (!HL_SUPPORTED) return;
    this.matches = [];
    this.index = -1;

    const q = query.toLowerCase();
    if (q) {
      const walker = document.createTreeWalker(this.activeRoot(), NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          // SVG 要素の tagName は小文字なので、大文字だけの比較では
          // mermaid が図に埋め込む <style> の CSS まで検索対象になる
          const tag = n.parentElement?.tagName?.toUpperCase();
          if (tag === "STYLE" || tag === "SCRIPT") return NodeFilter.FILTER_REJECT;
          return (n.nodeValue ?? "").toLowerCase().includes(q)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const hay = (node.nodeValue ?? "").toLowerCase();
        for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + q.length);
          this.matches.push(range);
        }
      }
    }

    if (this.matches.length) {
      // 現在のスクロール位置以降の最初のマッチを選ぶ
      this.index = this.matches.findIndex((r) => r.getBoundingClientRect().top >= 0);
      if (this.index === -1) this.index = 0;
    }
    this.applyHighlights(autoScroll);
    this.onUpdate(this.state);
  }

  move(delta: number) {
    if (!this.matches.length) return;
    this.index = (this.index + delta + this.matches.length) % this.matches.length;
    this.applyHighlights(true);
    this.onUpdate(this.state);
  }

  clear() {
    this.clearHighlights();
    this.forceRepaint();
    this.matches = [];
    this.index = -1;
    this.onUpdate(this.state);
  }

  /// 再描画用の filter を取り除く。どちらが検索対象だったかに関わらず全部消す。
  ///
  /// 付けっぱなしにしないことが重要。filter が残った状態で PDF を書き出すと、
  /// Chromium (WebView2 の PrintToPdf) は本文を合成レイヤーとして扱い、ページ全体を
  /// 300dpi のビットマップへ焼いてしまう (文字が選択・検索できず、PDF も数十倍に膨らむ)。
  clearRepaint() {
    for (const el of this.repaintTargets) el.style.filter = "";
  }

  /// 破棄。ハイライトは document 側に残るので必ず外す
  /// (タブを閉じたあとも塗られたままにならないように)。
  dispose() {
    this.clearHighlights();
    this.clearRepaint();
    this.matches = [];
    this.index = -1;
  }

  private clearHighlights() {
    if (!HL_SUPPORTED) return;
    CSS.highlights.delete(this.matchName);
    CSS.highlights.delete(this.currentName);
  }

  private applyHighlights(scroll: boolean) {
    if (!HL_SUPPORTED) return;
    if (this.matches.length) {
      CSS.highlights.set(this.matchName, new Highlight(...this.matches));
      CSS.highlights.set(this.currentName, new Highlight(this.matches[this.index]));
    } else {
      this.clearHighlights();
    }
    this.forceRepaint();
    if (scroll && this.matches.length) {
      const rect = this.matches[this.index].getBoundingClientRect();
      const target = this.scroller.scrollTop + rect.top - this.scroller.clientHeight / 2;
      this.scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  // highlights を消し替えても WebKit が旧領域を再描画しないので、描画だけを強制して
  // ゴーストを消す。filter を一度付けて外すと中身がバッファへ再ラスタライズされる。
  // brightness(1) は恒等フィルタなのでピクセルは完全に不変(透明化もなし)。
  // レイアウト・スクロール・見た目はいずれも動かない。
  private forceRepaint() {
    this.nudge = !this.nudge;
    // 交互に別の恒等フィルタへ切り替える。どちらもピクセルは変えないが、値が
    // 変わることで再描画が走る。同じ値を入れ直しても無効化されないため、連打中も
    // 1 打ごとに確実に描き直させるにはこうして値を変える必要がある。
    this.activeRoot().style.filter = this.nudge ? "brightness(1)" : "grayscale(0)";
    // filter 付きのフレームが一度描かれてから外す (rAF 1 回だと描画前に外れて
    // しまい再描画が起きない)。連打中は最後の 1 回だけが後始末をする。
    const seq = ++this.repaintSeq;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (seq === this.repaintSeq) this.clearRepaint();
      })
    );
  }
}
