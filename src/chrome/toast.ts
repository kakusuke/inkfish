// ---------- トースト / リンクのホバー表示 ----------

export class Toast {
  private el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  show(msg: string) {
    this.el.textContent = msg;
    this.el.classList.remove("hidden");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.add("hidden"), 2800);
  }
}

/// リンクにホバーしたら左下に URL を出す。ビューアの中身に限らず
/// ガワのリンクでも効かせたいので document 全体で拾う。
export function wireLinkStatus(el: HTMLElement) {
  document.addEventListener("mouseover", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href) {
      el.classList.add("hidden");
      return;
    }
    // 表示は読みやすいようデコード(不正な % 列は生のまま)
    let text = href;
    try {
      text = decodeURIComponent(href);
    } catch {
      /* keep raw */
    }
    el.textContent = text;
    el.classList.remove("hidden");
  });
}
