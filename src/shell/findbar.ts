import type { FindState } from "../viewer/find";

/// 検索バーの UI。検索そのものはビューアのエンジンがやるので、
/// ここは入力とナビゲーションボタン、件数表示だけを持つ。
export class FindBar {
  private bar: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private prev: HTMLButtonElement;
  private next: HTMLButtonElement;

  constructor(
    root: HTMLElement,
    private actions: {
      find: (q: string, autoScroll?: boolean) => void;
      findNext: () => void;
      findPrev: () => void;
      clear: () => void;
      onClosed: () => void;
    }
  ) {
    this.bar = root;
    this.input = root.querySelector<HTMLInputElement>(".ink-find-input")!;
    this.count = root.querySelector<HTMLElement>(".ink-find-count")!;
    this.prev = root.querySelector<HTMLButtonElement>('[data-act="prev"]')!;
    this.next = root.querySelector<HTMLButtonElement>('[data-act="next"]')!;

    this.input.addEventListener("input", () => this.actions.find(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.shiftKey ? this.actions.findPrev() : this.actions.findNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.prev.addEventListener("click", () => this.actions.findPrev());
    this.next.addEventListener("click", () => this.actions.findNext());
    root.querySelector('[data-act="close"]')!.addEventListener("click", () => this.close());
  }

  get isOpen() {
    return !this.bar.classList.contains("hidden");
  }

  open() {
    this.bar.classList.remove("hidden");
    const sel = getSelection()?.toString().trim();
    if (sel && sel.length <= 100) this.input.value = sel;
    this.input.focus();
    this.input.select();
    this.actions.find(this.input.value);
  }

  close() {
    this.bar.classList.add("hidden");
    this.actions.clear();
    this.actions.onClosed();
  }

  /// ビューアから届いた件数を反映する
  update({ index, total }: FindState) {
    const q = this.input.value;
    this.count.textContent = q ? `${total ? index + 1 : 0}/${total}` : "";
    this.count.classList.toggle("is-empty", !!q && total === 0);
    this.prev.disabled = total === 0;
    this.next.disabled = total === 0;
  }
}
