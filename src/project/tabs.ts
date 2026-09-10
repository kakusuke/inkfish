/// タブ列に出す 1 つぶんの見え方。
export type TabView = {
  id: string;
  /// 見出し (front matter の title かファイル名)
  caption: string;
  /// tooltip に出すファイル名
  name: string;
  marp: boolean;
  /// 差分タブ (左右に 2 つの版を並べている)
  diff: boolean;
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

/// 掴んだ時点でのタブの並びと位置。ドラッグ中は DOM を動かさないので、
/// 判定はすべてこの控えに対して行う。
type Slot = { id: string; el: HTMLElement; left: number; right: number; center: number };

/// タブを掴んだときの状態。
type Drag = {
  id: string;
  el: HTMLElement;
  /// 掴んだ位置 (client)
  startX: number;
  moved: boolean;
  /// 掴んだ時点の並び
  slots: Slot[];
  /// 掴んだタブの slots 上の位置
  from: number;
  /// 今の差し込み先 (slots の隙間の番号 0..n)
  to: number;
  /// このウィンドウの client 原点 (デスクトップ座標)。
  /// pointer イベントの screenX - clientX で求まる。窓の外へ出たかの
  /// 判定に使う (window.screenX は当てにならないので使わない)。
  originX: number;
  originY: number;
  /// 今カーソルがウィンドウの外にいるか
  outside: boolean;
  /// ドラッグ中だけ window に張るリスナの後始末
  detach: () => void;
};

/// この距離だけタブ列から縦に離れたら「持ち出し」と見なす。
/// 列の中で少し上下にぶれただけで切り離されないための余裕。
const DETACH_MARGIN = 44;

/// クリックと区別するしきい値
const THRESHOLD = 4;

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
  // 差し込み位置を示す線
  private marker: HTMLElement | null = null;

  constructor(
    private root: HTMLElement,
    private hooks: StripHooks
  ) {
    this.root.addEventListener("pointerdown", (e) => this.onDown(e));
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
    this.marker?.remove();
    this.marker = null;
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
        if (v.diff || v.marp) {
          const badge = document.createElement("span");
          badge.className = "ink-tab-badge";
          badge.textContent = v.diff ? "DIFF" : "MARP";
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

  // ---------- ドラッグ (並べ替え / 持ち出し) ----------
  //
  // ドラッグ中に DOM を動かさないのが要点。掴んだ要素を並べ替えのたびに
  // 差し替えていると、WebKit がポインタキャプチャを手放して
  // pointercancel を投げてくることがあり、1 回ずらした直後にドラッグが
  // 死んで並びが元へ戻ってしまう。
  // 掴んだ時点の並びと位置を控え、動かすのは掴んだタブの transform と
  // 差し込み位置の線だけにして、実際の並べ替えは離したときに 1 回だけ行う。
  //
  // pointermove / pointerup は window に張る。setPointerCapture が外れても
  // (タブ列の外や窓の外へ出ても) 取りこぼさないようにするため。

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // × は閉じるボタン。ドラッグの起点にしない
    if (target.closest('[data-act="close-tab"]')) return;
    const el = target.closest<HTMLElement>("[data-tab]");
    if (!el) return;

    const slots: Slot[] = Array.from(this.root.querySelectorAll<HTMLElement>("[data-tab]")).map(
      (t) => {
        const r = t.getBoundingClientRect();
        return { id: t.dataset.tab!, el: t, left: r.left, right: r.right, center: r.left + r.width / 2 };
      }
    );
    const from = slots.findIndex((sl) => sl.el === el);
    if (from < 0) return;

    // キャプチャは取れなくても続行できる (window で拾うため)
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 取れないポインタもある */
    }

    const move = (ev: PointerEvent) => this.onMove(ev);
    const up = (ev: PointerEvent) => this.onUp(ev);
    const cancel = () => this.cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);

    this.drag = {
      id: el.dataset.tab!,
      el,
      startX: e.clientX,
      moved: false,
      slots,
      from,
      to: from,
      originX: e.screenX - e.clientX,
      originY: e.screenY - e.clientY,
      outside: false,
      detach: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      },
    };
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      d.el.classList.add("is-dragging");
    }

    // 掴んだタブをカーソルに追従させる (DOM は動かさない)
    d.el.style.transform = `translateX(${e.clientX - d.startX}px)`;

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
    if (away) {
      d.to = d.from;
      this.showMarker(null);
      return;
    }

    // カーソルより左にある (掴んだもの以外の) タブの数が差し込み位置
    let to = 0;
    for (const sl of d.slots) {
      if (sl.el === d.el) continue;
      if (e.clientX > sl.center) to += 1;
    }
    d.to = to;
    this.showMarker(to === d.from ? null : to);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    if (!d.moved) return;
    e.preventDefault();
    this.justDragged = true;

    if (d.el.classList.contains("is-detaching") || d.outside) {
      d.el.classList.remove("is-detaching");
      this.hooks.onDropOutside(d.id, e.screenX, e.screenY);
      return;
    }
    if (d.to === d.from) {
      // 動かさなかったので描き直すだけ (transform を消す)
      this.render(this.views, this.activeId);
      return;
    }
    // 掴んだものを抜いて、差し込み位置に入れる
    const ids = d.slots.map((sl) => sl.id);
    const [moved] = ids.splice(d.from, 1);
    ids.splice(d.to, 0, moved);
    this.hooks.onReorder(ids);
  }

  private cancel() {
    const d = this.drag;
    this.endDrag();
    // 途中で取り消されたら、状態を持っている側の順序へ描き直す
    if (d?.moved) this.render(this.views, this.activeId);
  }

  /// ドラッグの後始末。並びは触らない (確定は呼び出し側)。
  private endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.detach();
    d.el.classList.remove("is-dragging");
    d.el.style.transform = "";
    this.showMarker(null);
  }

  /// 差し込み位置に線を出す。null で消す。
  private showMarker(to: number | null) {
    const d = this.drag;
    if (to === null || !d) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      this.marker = document.createElement("div");
      this.marker.className = "ink-tab-marker";
      this.marker.setAttribute("aria-hidden", "true");
      this.root.appendChild(this.marker);
    }
    // 掴んだタブを除いた並びのうち、to 番目の左端 (末尾なら最後の右端)
    const rest = d.slots.filter((sl) => sl.el !== d.el);
    const strip = this.root.getBoundingClientRect();
    const x = to < rest.length ? rest[to].left : (rest[rest.length - 1]?.right ?? strip.left);
    this.marker.style.left = `${x - strip.left + this.root.scrollLeft}px`;
  }

}
