import { invoke } from "@tauri-apps/api/core";
import { shortenPath } from "../shared/paths";
import { requestOpen } from "./files";

/// Rust 側 (list_open_windows) が返すタブ 1 件。
type TabEntry = {
  path: string;
  /// front matter の title かファイル名
  caption: string;
  /// ファイル名 (caption が title のときの補助)
  name: string;
  dir: string;
  /// そのウィンドウで今選ばれているタブか
  current: boolean;
};

/// Rust 側 (list_open_windows) が返すウィンドウ 1 件。
type WindowEntry = {
  label: string;
  kind: "file" | "project";
  /// 単一文書なら文書のキャプション、プロジェクトならルートのパス
  caption: string;
  name: string;
  dir: string;
  /// 呼び出し元のウィンドウ自身か
  current: boolean;
  tabs: TabEntry[];
};

/// 一覧に並ぶ 1 行。ウィンドウの下にそのタブがネストする。
type Row =
  | { kind: "window"; label: string; caption: string; sub: string; current: boolean }
  | { kind: "tab"; label: string; path: string; caption: string; sub: string; current: boolean };

/// ヘッダーのカプセルから開くドロップダウン。
/// 開いているウィンドウが並び、タブを持つウィンドウはその下にタブがネストする。
/// 選ぶとその窓が前面に来る (タブを選べばそのタブが表示される)。
///
/// 一覧に出るのは何か開いている窓だけ (Rust 側の台帳が根拠)。
/// プロジェクトウィンドウはタブが 0 でも出る (ルートを開いているため)。
export class WindowMenu {
  private rows: Row[] = [];
  private active = -1;

  constructor(
    private panel: HTMLElement,
    private anchor: HTMLElement,
    private onError: (msg: string) => void
  ) {
    // 行のクリックはパネルに委譲する (中身は開くたびに作り直すため)
    this.panel.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
      if (row) void this.pick(Number(row.dataset.row));
    });
    this.panel.addEventListener("mousemove", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
      if (!row) return;
      this.active = Number(row.dataset.row);
      this.paintActive();
    });
  }

  /// 一覧を取り直して描く。PopoverGroup の onOpen から呼ばれる。
  async refresh() {
    let entries: WindowEntry[] = [];
    try {
      entries = await invoke<WindowEntry[]>("list_open_windows");
    } catch (e) {
      this.onError(`ウィンドウの一覧を取得できませんでした: ${e}`);
    }
    this.rows = toRows(entries);
    // 開いた直後は今いる場所を選択状態にしておく (↑↓ の起点)。
    // タブの行があればそれを、無ければウィンドウの行を選ぶ。
    const activeTab = this.rows.findIndex((r) => r.kind === "tab" && r.current);
    this.active =
      activeTab >= 0 ? activeTab : Math.max(0, this.rows.findIndex((r) => r.current));
    this.render();
    this.position();
  }

  /// ↑↓ で移動 (ネストは平坦に辿る)、Enter で決定。処理したら true。
  handleKey(key: string): boolean {
    if (!this.rows.length) return false;
    switch (key) {
      case "ArrowDown":
        this.active = (this.active + 1) % this.rows.length;
        this.paintActive();
        return true;
      case "ArrowUp":
        this.active = (this.active - 1 + this.rows.length) % this.rows.length;
        this.paintActive();
        return true;
      case "Enter":
        void this.pick(this.active);
        return true;
    }
    return false;
  }

  private render() {
    this.panel.replaceChildren(
      ...this.rows.map((r, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = r.kind === "tab" ? "ink-window-row is-tab" : "ink-window-row";
        row.dataset.row = String(i);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(r.current));
        row.classList.toggle("is-current", r.current);
        row.classList.toggle("is-active", i === this.active);

        const check = document.createElement("span");
        check.className = "ink-window-check";
        // 今いる場所に印を付ける。textContent なのでエスケープ不要。
        check.textContent = r.current ? "✓" : "";

        const text = document.createElement("span");
        text.className = "ink-window-text";
        const caption = document.createElement("span");
        caption.className = "ink-window-caption";
        caption.textContent = r.caption;
        const sub = document.createElement("span");
        sub.className = "ink-window-dir";
        sub.textContent = r.sub;
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

  /// カプセルの真下に寄せる。カプセルは中央寄せなので、はみ出す分だけ内側へ戻す。
  private position() {
    const a = this.anchor.getBoundingClientRect();
    // 一度出してから測らないと幅が取れない
    const w = this.panel.offsetWidth;
    const left = Math.min(Math.max(8, a.left + a.width / 2 - w / 2), window.innerWidth - w - 8);
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${a.bottom + 8}px`;
  }

  private async pick(index: number) {
    const row = this.rows[index];
    this.close();
    if (!row || row.current) return;
    try {
      if (row.kind === "tab") {
        // open_path が「開いている窓を前面化してそのタブを選ばせる」まで
        // やってくれるので、専用のコマンドは要らない
        await requestOpen(row.path);
      } else {
        await invoke("focus_window_by_label", { label: row.label });
      }
    } catch (e) {
      this.onError(`切り替えられませんでした: ${e}`);
    }
  }

  /// PopoverGroup 側の close を呼ぶためのフック。ガワが差し込む。
  close: () => void = () => {};
}

/// ウィンドウとそのタブを、上から下へ並べた 1 本のリストにする。
///
/// 単一文書ウィンドウはタブが 1 つでその内容が窓の見出しと同じなので、
/// タブの行は作らない (同じものが 2 行並ぶのを避ける)。
function toRows(entries: WindowEntry[]): Row[] {
  const rows: Row[] = [];
  for (const w of entries) {
    const nest = w.kind === "project" || w.tabs.length > 1;
    rows.push({
      kind: "window",
      label: w.label,
      caption: w.kind === "project" ? shortenPath(w.caption) : w.caption,
      sub:
        w.kind === "project"
          ? `${w.tabs.length} 個のタブ`
          : w.caption === w.name
            ? shortenPath(w.dir)
            : `${w.name} — ${shortenPath(w.dir)}`,
      // タブを持つ窓は「窓の行」ではなくタブの行に印を付ける
      current: w.current && !nest,
    });
    if (!nest) continue;
    for (const t of w.tabs) {
      rows.push({
        kind: "tab",
        label: w.label,
        path: t.path,
        caption: t.caption,
        sub: t.caption === t.name ? shortenPath(t.dir) : `${t.name} — ${shortenPath(t.dir)}`,
        current: w.current && t.current,
      });
    }
  }
  return rows;
}
