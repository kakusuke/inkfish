import { invoke } from "@tauri-apps/api/core";
import { shortenPath as shortenDir } from "../shared/paths";

/// Rust 側 (list_open_windows) が返すウィンドウ 1 件。
type WindowEntry = {
  label: string;
  /// front matter の title かファイル名
  caption: string;
  /// ファイル名 (caption が title のときの補助)
  name: string;
  /// 2 行目に出す親ディレクトリ
  dir: string;
  current: boolean;
};


/// ファイル名のヘッダーに付くキャレットのドロップダウン。
/// 押すと開いているウィンドウが並び、選ぶとその窓が前面に来る。
///
/// 一覧に出るのはファイルを開いている窓だけ (Rust 側の台帳が根拠)。
/// 自分ひとりのときは自分 1 行だけが出る。
export class WindowMenu {
  private items: WindowEntry[] = [];
  private active = -1;

  constructor(
    private panel: HTMLElement,
    private anchor: HTMLElement,
    private onError: (msg: string) => void
  ) {
    // 行のクリックは パネル に委譲する (中身は開くたびに作り直すため)
    this.panel.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-label]");
      if (row) this.pick(row.dataset.label!);
    });
    this.panel.addEventListener("mousemove", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-label]");
      if (!row) return;
      this.active = this.items.findIndex((w) => w.label === row.dataset.label);
      this.paintActive();
    });
  }

  /// 一覧を取り直して描く。PopoverGroup の onOpen から呼ばれる。
  async refresh() {
    try {
      this.items = await invoke<WindowEntry[]>("list_open_windows");
    } catch (e) {
      this.items = [];
      this.onError(`ウィンドウの一覧を取得できませんでした: ${e}`);
    }
    // 開いた直後は自分の行を選択状態にしておく (↑↓ の起点)
    this.active = Math.max(0, this.items.findIndex((w) => w.current));
    this.render();
    this.position();
  }

  /// ↑↓ で移動、Enter で決定。処理したら true。
  handleKey(key: string): boolean {
    if (!this.items.length) return false;
    switch (key) {
      case "ArrowDown":
        this.active = (this.active + 1) % this.items.length;
        this.paintActive();
        return true;
      case "ArrowUp":
        this.active = (this.active - 1 + this.items.length) % this.items.length;
        this.paintActive();
        return true;
      case "Enter":
        this.pick(this.items[this.active].label);
        return true;
    }
    return false;
  }

  private render() {
    this.panel.replaceChildren(
      ...this.items.map((w, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ink-window-row";
        row.dataset.label = w.label;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(w.current));
        row.classList.toggle("is-current", w.current);
        row.classList.toggle("is-active", i === this.active);

        const check = document.createElement("span");
        check.className = "ink-window-check";
        // 今いる窓に印を付ける。textContent なのでエスケープ不要。
        check.textContent = w.current ? "✓" : "";

        const text = document.createElement("span");
        text.className = "ink-window-text";
        const caption = document.createElement("span");
        caption.className = "ink-window-caption";
        caption.textContent = w.caption;
        const sub = document.createElement("span");
        sub.className = "ink-window-dir";
        // caption が front matter の title のときはファイル名も添える
        sub.textContent =
          w.caption === w.name ? shortenDir(w.dir) : `${w.name} — ${shortenDir(w.dir)}`;
        text.append(caption, sub);

        row.append(check, text);
        return row;
      })
    );
  }

  private paintActive() {
    const rows = Array.from(this.panel.querySelectorAll<HTMLElement>(".ink-window-row"));
    rows.forEach((r, i) => r.classList.toggle("is-active", i === this.active));
  }

  /// capsule の真下に寄せる。capsule は中央寄せなので、はみ出す分だけ内側へ戻す。
  private position() {
    const a = this.anchor.getBoundingClientRect();
    // 一度出してから測らないと幅が取れない
    const w = this.panel.offsetWidth;
    const left = Math.min(
      Math.max(8, a.left + a.width / 2 - w / 2),
      window.innerWidth - w - 8
    );
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${a.bottom + 8}px`;
  }

  private async pick(label: string) {
    const target = this.items.find((w) => w.label === label);
    this.close();
    // 自分の行なら閉じるだけ
    if (!target || target.current) return;
    try {
      await invoke("focus_window_by_label", { label });
    } catch (e) {
      this.onError(`ウィンドウを前面にできませんでした: ${e}`);
    }
  }

  /// PopoverGroup 側の close を呼ぶためのフック。shell が差し込む。
  close: () => void = () => {};
}
