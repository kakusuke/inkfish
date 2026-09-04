// ---------- ページ内検索 ----------
// DOM を書き換えず CSS Custom Highlight API でマッチを塗る。テキストランを
// 分割しないので、折り返し(改行)位置が検索によって変わらない。
// WebKit は highlights を消し替えても旧領域を再描画しないことがあるため、
// 変更後に対象コンテンツを一度だけ同期的に再描画してゴーストを消す。
//
// CSS.highlights は document レベルの API でハイライト名も固定なので、
// ひとつの document に複数の FindEngine を置くことは今はできない。
// 並べるときは名前をインスタンスごとに分ける必要がある。
const HL_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

export type FindState = { index: number; total: number };

export class FindEngine {
  private matches: Range[] = [];
  private index = -1;
  private nudge = false;
  private repaintSeq = 0;

  /// scroller: スクロールコンテナ (マッチを画面中央へ寄せるのに使う)
  /// roots: 検索対象になりうる要素。表示中のものだけを走査する
  constructor(
    private scroller: HTMLElement,
    private activeRoot: () => HTMLElement,
    private repaintTargets: HTMLElement[],
    private onUpdate: (s: FindState) => void
  ) {}

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
          const tag = n.parentElement?.tagName;
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

  private clearHighlights() {
    if (!HL_SUPPORTED) return;
    CSS.highlights.delete("find-match");
    CSS.highlights.delete("find-current");
  }

  private applyHighlights(scroll: boolean) {
    if (!HL_SUPPORTED) return;
    if (this.matches.length) {
      CSS.highlights.set("find-match", new Highlight(...this.matches));
      CSS.highlights.set("find-current", new Highlight(this.matches[this.index]));
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
