// Mermaid 図の拡大表示ライトボックス。
// 図をクリックすると全画面オーバーレイで開き、ホイール拡大縮小 /
// ドラッグ(グラブ)移動 / Shift+ホイールで横移動ができる。
//
// DOM は自分で組む。ビューアに属する機能なので、ガワの無いウィンドウでも
// そのまま使える。

const MARKUP = `
  <div class="ink-lightbox-stage"><div class="ink-lightbox-content"></div></div>
  <div class="ink-lightbox-bar">
    <button class="ink-lightbox-btn" data-act="out" title="縮小 (−)">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 8h9"/></svg>
    </button>
    <span class="ink-lightbox-level">100%</span>
    <button class="ink-lightbox-btn" data-act="in" title="拡大 (+)">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>
    </button>
    <button class="ink-lightbox-btn is-text" data-act="fit" title="全体表示に戻す (0)">リセット</button>
    <button class="ink-lightbox-btn" data-act="close" title="閉じる (Esc)">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  </div>
`;

export class Lightbox {
  private root: HTMLElement;
  private stage: HTMLElement;
  private content: HTMLElement;
  private levelEl: HTMLElement;

  private scale = 1;
  private tx = 0;
  private ty = 0;
  private minScale = 0.1;
  private maxScale = 16;
  private natW = 0;
  private natH = 0;

  // ドラッグ(グラブ)状態
  private dragging = false;
  private moved = false;
  private startX = 0;
  private startY = 0;
  private startTx = 0;
  private startTy = 0;
  private downOnBackdrop = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "ink-lightbox hidden";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML = MARKUP;
    parent.appendChild(this.root);

    this.stage = this.root.querySelector<HTMLElement>(".ink-lightbox-stage")!;
    this.content = this.root.querySelector<HTMLElement>(".ink-lightbox-content")!;
    this.levelEl = this.root.querySelector<HTMLElement>(".ink-lightbox-level")!;

    this.root.querySelectorAll<HTMLButtonElement>(".ink-lightbox-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switch (btn.dataset.act) {
          case "in": this.zoomCenter(1.25); break;
          case "out": this.zoomCenter(1 / 1.25); break;
          case "fit": this.fit(); break;
          case "close": this.close(); break;
        }
      });
    });

    // ホイール操作(Win/Mac 共通の慣習):
    //  - Ctrl/⌘ 併用 or トラックパッドのピンチ(ctrlKey で届く) → カーソル中心にズーム
    //  - Shift 併用 → 横パン
    //  - 修飾なし → パン(トラックパッドの deltaX で横、deltaY で縦)
    this.stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.stage.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          this.zoomAt(Math.exp(-e.deltaY / 100), e.clientX - r.left, e.clientY - r.top);
          return;
        }
        if (e.shiftKey) {
          // 縦ホイールしか出ないマウス向けに deltaY も横移動へ回す
          this.tx -= e.deltaX || e.deltaY;
          this.apply();
          return;
        }
        this.tx -= e.deltaX;
        this.ty -= e.deltaY;
        this.apply();
      },
      { passive: false }
    );

    this.stage.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.moved = false;
      this.startX = e.clientX;
      this.startY = e.clientY;
      this.startTx = this.tx;
      this.startTy = this.ty;
      // 下の pointerup では setPointerCapture により target が stage へ付け替えられ、
      // 図の上で押したのか背景で押したのか区別できない。押した時点で判定しておく。
      this.downOnBackdrop = e.target === this.stage;
      this.stage.setPointerCapture(e.pointerId);
      this.stage.classList.add("is-grabbing");
    });

    this.stage.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.moved = true;
      this.tx = this.startTx + dx;
      this.ty = this.startTy + dy;
      this.apply();
    });

    this.stage.addEventListener("pointerup", () => {
      this.dragging = false;
      this.stage.classList.remove("is-grabbing");
      // 背景(図の外)をドラッグせずクリックしたら閉じる。
      // 図の上のクリックでは閉じない(拡大表示のまま操作を続けられるように)。
      if (!this.moved && this.downOnBackdrop) this.close();
    });
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  /// 破棄。listener はすべて自分の要素に付いているので、
  /// ノードを外せばまとめて回収される。
  dispose() {
    this.close();
    this.root.remove();
  }

  open(svg: SVGSVGElement) {
    const vb = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    this.natW = vb.width || rect.width || 100;
    this.natH = vb.height || rect.height || 100;

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.style.width = `${this.natW}px`;
    clone.style.height = `${this.natH}px`;
    this.content.replaceChildren(clone);

    this.root.classList.remove("hidden");
    this.root.setAttribute("aria-hidden", "false");
    this.fit();
  }

  close() {
    this.root.classList.add("hidden");
    this.root.setAttribute("aria-hidden", "true");
    this.content.replaceChildren();
  }

  /// ライトボックス表示中はキー操作を専有する(本文ズームより優先)。
  /// 処理したら true を返し、呼び出し側にイベントを止めさせる。
  handleKey(key: string): boolean {
    if (!this.isOpen) return false;
    switch (key) {
      case "Escape": this.close(); return true;
      case "+": case "=": this.zoomCenter(1.25); return true;
      case "-": this.zoomCenter(1 / 1.25); return true;
      case "0": this.fit(); return true;
    }
    return false;
  }

  private apply() {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    // 表示倍率は原寸(SVG の viewBox)を 100% とした値
    this.levelEl.textContent = `${Math.round(this.scale * 100)}%`;
  }

  // stage 上の点 (cx, cy) を固定したまま倍率を factor 倍する
  private zoomAt(factor: number, cx: number, cy: number) {
    const next = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    if (next === this.scale) return;
    const localX = (cx - this.tx) / this.scale;
    const localY = (cy - this.ty) / this.scale;
    this.tx = cx - localX * next;
    this.ty = cy - localY * next;
    this.scale = next;
    this.apply();
  }

  private zoomCenter(factor: number) {
    const r = this.stage.getBoundingClientRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }

  // 図全体が収まる倍率で中央に配置(小さい図は拡大、大きい図は縮小される)
  private fit() {
    const r = this.stage.getBoundingClientRect();
    const margin = 0.92;
    const fit = Math.min((r.width * margin) / this.natW, (r.height * margin) / this.natH);
    this.scale = fit || 1;
    this.minScale = this.scale / 4;
    this.maxScale = this.scale * 16;
    this.tx = (r.width - this.natW * this.scale) / 2;
    this.ty = (r.height - this.natH * this.scale) / 2;
    this.apply();
  }
}
