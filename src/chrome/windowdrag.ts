import { getCurrentWindow } from "@tauri-apps/api/window";
import { dockHover, setWindowOrigin, windowAt, windowRects, type WindowRect } from "./files";

export type WindowDragHooks = {
  /// プロジェクトウィンドウの上で離された。取り込みを頼む相手の label。
  onDrop: (label: string) => void;
};

/// この距離を超えて動いたらドラッグ開始。クリックと区別する。
const THRESHOLD = 4;

/// ハンドル (ファイル名のカプセル) を掴んでウィンドウ自体を動かせるようにする。
///
/// なぜ OS のウィンドウドラッグを使わないか: macOS の
/// `performWindowDragWithEvent:` は投げっぱなしで、どこで離したかを
/// アプリに知らせる手段が無い (Tauri / tao / NSWindow デリゲートのどこにも
/// ドラッグ終了イベントが無く、ドラッグ中の NSWindow はドラッグ
/// ペーストボードにも何も載せないので受け側にも届かない)。
/// 「別のウィンドウの上で離したらタブとして取り込む」を成立させるには、
/// ドラッグを自分で持って離した位置を自分で知る必要がある。
///
/// 実装の要点:
/// - ウィンドウがカーソルに追従するので、ポインタは常にこの窓の上に留まる。
///   そのため pointermove / pointerup が切れない。
/// - 位置は「開始時の原点 + screen 座標の総移動量」で決める。1 フレームごとの
///   client 座標の差分では、窓が動くぶん打ち消されて進まない。
/// - 原点は `screenX - clientX` で求める。`window.screenX` は WKWebView では
///   当てにならない (実測で常に (0, 2160) を返した)。
/// - カプセルは button なので Tauri のドラッグ領域からも AppKit の
///   タイトルバードラッグからも自動で外れる (実測済み)。
export function makeWindowDraggable(handle: HTMLElement, hooks: WindowDragHooks) {
  let startScreenX = 0;
  let startScreenY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  let moved = false;
  // クリックと同時に発火する click を、ドラッグの後だけ握り潰す
  let justDragged = false;
  let rects: WindowRect[] = [];
  let selfLabel = "";
  let hovered: string | null = null;
  // 1 フレームに 1 回だけ動かす (pointermove ごとに IPC を投げない)
  let pending: { x: number; y: number } | null = null;
  let raf = 0;

  const setHover = (label: string | null) => {
    if (label === hovered) return;
    if (hovered) void dockHover(hovered, false).catch(() => {});
    hovered = label;
    if (hovered) void dockHover(hovered, true).catch(() => {});
  };

  const flush = () => {
    raf = 0;
    if (!pending) return;
    const { x, y } = pending;
    pending = null;
    void setWindowOrigin(x, y).catch(() => {});
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    originX = e.screenX - e.clientX;
    originY = e.screenY - e.clientY;
    dragging = true;
    moved = false;
    rects = [];
    selfLabel = getCurrentWindow().label;
    // 受け入れ先の候補は掴んだ時点で確定させる (動くのは自分の窓だけ)
    void windowRects()
      .then((r) => (rects = r.filter((w) => w.label !== selfLabel)))
      .catch(() => {});
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.screenX - startScreenX;
    const dy = e.screenY - startScreenY;
    if (!moved && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
    moved = true;
    handle.classList.add("is-window-dragging");

    pending = { x: originX + dx, y: originY + dy };
    if (!raf) raf = requestAnimationFrame(flush);

    const hit = windowAt(rects, e.screenX, e.screenY);
    setHover(hit && hit.kind === "project" ? hit.label : null);
  });

  const end = (e: PointerEvent | null) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-window-dragging");
    if (raf) {
      cancelAnimationFrame(raf);
      flush();
    }
    const target = hovered;
    setHover(null);
    if (!moved) return;
    justDragged = true;
    e?.preventDefault();
    if (target) hooks.onDrop(target);
  };

  handle.addEventListener("pointerup", (e) => end(e));
  handle.addEventListener("pointercancel", () => end(null));

  // ドラッグ直後の click はメニューを開くためのものではない。
  // capture 段で握り潰すので、同じ要素の click リスナより先に効く。
  handle.addEventListener(
    "click",
    (e) => {
      if (!justDragged) return;
      justDragged = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
}
