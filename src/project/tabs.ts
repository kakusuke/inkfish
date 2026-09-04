/// タブ列に出す 1 つぶんの見え方。
export type TabView = {
  id: string;
  /// 見出し (front matter の title かファイル名)
  caption: string;
  /// tooltip に出すファイル名
  name: string;
  marp: boolean;
};

export type StripHooks = {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /// 並べ替えが確定した。引数は新しい順序の id 列。
  onReorder: (ids: string[]) => void;
  /// タブ列の外で離された。座標はデスクトップ上の位置 (論理ピクセル)。
  /// 切り離すか別の窓へ渡すかの判断はガワが行う。
  onDropOutside: (id: string, screenX: number, screenY: number) => void;
};

/// タブを掴んだときの状態。
type Drag = {
  id: string;
  el: HTMLElement;
  startX: number;
  moved: boolean;
  /// このウィンドウの client 原点 (デスクトップ座標)。
  /// pointer イベントの screenX - clientX で求まる。窓の外へ出たかの
  /// 判定に使う (window.screenX は当てにならないので使わない)。
  originX: number;
  originY: number;
  /// 今カーソルがウィンドウの外にいるか
  outside: boolean;
};

/// この距離だけタブ列から縦に離れたら「持ち出し」と見なす。
/// 列の中で少し上下にぶれただけで切り離されないための余裕。
const DETACH_MARGIN = 44;

/// プロジェクトウィンドウのタブ列。
///
/// タブは `role="tab"` の button にしてある。Tauri のドラッグ領域
/// (`data-tauri-drag-region="deep"`) は composed path 上のクリック可能要素で
/// 打ち切られるので、これだけでタブの上では pointer イベントがこちらに届き、
/// 列の空き領域では従来どおりウィンドウを動かせる。
export class TabStrip {
  private drag: Drag | null = null;
  private views: TabView[] = [];
  private activeId: string | null = null;
  // 並べ替え直後の click を選択と取り違えないための目印
  private justDragged = false;

  constructor(
    private root: HTMLElement,
    private hooks: StripHooks
  ) {
    this.root.addEventListener("pointerdown", (e) => this.onDown(e));
    this.root.addEventListener("pointermove", (e) => this.onMove(e));
    this.root.addEventListener("pointerup", (e) => this.onUp(e));
    this.root.addEventListener("pointercancel", () => this.cancel());
    // 選択は click で受ける。pointerup だけで拾うと、キーボード (Enter /
    // Space) やプログラムからの click では選択できない。
    this.root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (!el) return;
      if ((e.target as HTMLElement).closest('[data-act="close-tab"]')) {
        this.hooks.onClose(el.dataset.tab!);
        return;
      }
      // 並べ替えを終えた直後の click は選択ではない
      if (this.justDragged) {
        this.justDragged = false;
        return;
      }
      this.hooks.onSelect(el.dataset.tab!);
    });
    // 中クリックで閉じる (ブラウザのタブと同じ)
    this.root.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (tab) this.hooks.onClose(tab.dataset.tab!);
    });
  }

  render(views: TabView[], activeId: string | null) {
    this.views = views;
    this.activeId = activeId;
    this.root.replaceChildren(
      ...views.map((v) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "ink-tab";
        tab.dataset.tab = v.id;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(v.id === activeId));
        tab.title = v.name;
        tab.classList.toggle("is-active", v.id === activeId);

        const label = document.createElement("span");
        label.className = "ink-tab-label";
        // textContent なのでエスケープ不要
        label.textContent = v.caption;

        const close = document.createElement("span");
        close.className = "ink-tab-close";
        close.dataset.act = "close-tab";
        close.setAttribute("aria-hidden", "true");
        close.textContent = "×";

        tab.append(label);
        if (v.marp) {
          const badge = document.createElement("span");
          badge.className = "ink-tab-badge";
          badge.textContent = "MARP";
          tab.append(badge);
        }
        tab.append(close);
        return tab;
      })
    );
    // 選択されたタブが隠れていたら見える位置へ寄せる
    this.root
      .querySelector<HTMLElement>(".ink-tab.is-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---------- ドラッグ (並べ替え) ----------

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // × は閉じるボタン。ドラッグの起点にしない
    if (target.closest('[data-act="close-tab"]')) return;
    const el = target.closest<HTMLElement>("[data-tab]");
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    this.drag = {
      id: el.dataset.tab!,
      el,
      startX: e.clientX,
      moved: false,
      originX: e.screenX - e.clientX,
      originY: e.screenY - e.clientY,
      outside: false,
    };
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    if (!d.moved) {
      d.moved = true;
      d.el.classList.add("is-dragging");
    }

    // 窓の外に出たか。client 座標はウィンドウの外でも伸び続けるが、
    // 基準にするのは pointerdown 時に得た原点 (window.screenX は嘘をつく)。
    d.outside =
      e.screenX < d.originX ||
      e.screenY < d.originY ||
      e.screenX > d.originX + window.innerWidth ||
      e.screenY > d.originY + window.innerHeight;

    // タブ列から縦に離れたら持ち出しの構え。並べ替えはやめる。
    const strip = this.root.getBoundingClientRect();
    const away =
      d.outside || e.clientY < strip.top - DETACH_MARGIN || e.clientY > strip.bottom + DETACH_MARGIN;
    d.el.classList.toggle("is-detaching", away);
    if (away) return;

    // ポインタの下にある別のタブの、どちら半分にいるかで差し込み位置を決める。
    // translate ではなく DOM を直接動かすので、離した時点の並びがそのまま結果になる。
    const over = this.tabAt(e.clientX, d.el);
    if (!over) return;
    const rect = over.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    over.insertAdjacentElement(after ? "afterend" : "beforebegin", d.el);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const detaching = d.el.classList.contains("is-detaching");
    d.el.classList.remove("is-dragging", "is-detaching");
    // 選択は click 側でやる。ここで並べ替えと持ち出しだけ確定させる。
    if (!d.moved) return;
    e.preventDefault();
    this.justDragged = true;
    if (detaching) {
      this.hooks.onDropOutside(d.id, e.screenX, e.screenY);
      return;
    }
    this.hooks.onReorder(this.domOrder());
  }

  private cancel() {
    const wasDragging = this.drag?.moved ?? false;
    this.drag?.el.classList.remove("is-dragging", "is-detaching");
    this.drag = null;
    // 並べ替え途中で取り消されたら、状態を持っている側の順序へ描き直す
    if (wasDragging) this.render(this.views, this.activeId);
  }

  /// x にあるタブ (掴んでいるものは除く)
  private tabAt(x: number, exclude: HTMLElement): HTMLElement | null {
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>("[data-tab]"))) {
      if (el === exclude) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return el;
    }
    return null;
  }

  private domOrder(): string[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>("[data-tab]")).map(
      (el) => el.dataset.tab!
    );
  }
}
