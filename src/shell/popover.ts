// 開いているポップオーバーを 1 つに絞る仕組み。
// 設定ポップオーバーとウィンドウ切替メニューが外側クリックの処理を
// 取り合わないよう、開閉と「外側をクリックしたら閉じる」を一箇所に集める。

type Popover = {
  /// ポップオーバー本体。ここの中のクリックでは閉じない
  panel: HTMLElement;
  /// 開閉ボタン。ここのクリックでも閉じない (トグル側で処理する)
  toggle: HTMLElement;
  onOpen?: () => void;
  onClose?: () => void;
};

export class PopoverGroup {
  private items: Popover[] = [];

  constructor() {
    document.addEventListener("mousedown", (e) => {
      const target = e.target as Node;
      for (const p of this.items) {
        if (!this.isOpen(p)) continue;
        if (p.panel.contains(target) || p.toggle.contains(target)) continue;
        this.close(p);
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = this.items.find((p) => this.isOpen(p));
      if (open) {
        e.preventDefault();
        this.close(open);
      }
    });
    // 位置決めが崩れるのでリサイズでは閉じる
    window.addEventListener("resize", () => this.closeAll());
  }

  register(p: Popover) {
    this.items.push(p);
    return p;
  }

  isOpen(p: Popover) {
    return !p.panel.classList.contains("hidden");
  }

  open(p: Popover) {
    // 同時に開けるのは 1 つだけ
    for (const other of this.items) if (other !== p) this.close(other);
    p.panel.classList.remove("hidden");
    p.toggle.setAttribute("aria-expanded", "true");
    p.onOpen?.();
  }

  close(p: Popover) {
    if (!this.isOpen(p)) return;
    p.panel.classList.add("hidden");
    p.toggle.setAttribute("aria-expanded", "false");
    p.onClose?.();
  }

  toggle(p: Popover) {
    this.isOpen(p) ? this.close(p) : this.open(p);
  }

  closeAll() {
    for (const p of this.items) this.close(p);
  }
}
