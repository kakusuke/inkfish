import { invoke } from "@tauri-apps/api/core";

/// ディレクトリの行に付けるフォルダの絵。静的な文字列なので innerHTML でよい。
const FOLDER_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.7l1.5 1.6h4.8A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z"/></svg>`;

/// Rust 側 (read_md_tree) が返す節。
export type TreeNode = {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
};

export type MdTree = {
  root: string;
  children: TreeNode[];
  files: number;
  /// 上限に当たって打ち切られた。呼び出し側は自動更新をやめる。
  truncated: boolean;
};

export const readMdTree = (path: string) => invoke<MdTree>("read_md_tree", { path });

/// 展開したディレクトリはルートごとに覚えておく。
/// 中身は絶対パスの配列。localStorage が使えない環境では黙って諦める。
const storeKey = (root: string) => `ink.tree.expanded:${root}`;

function loadExpanded(root: string): Set<string> {
  try {
    const raw = localStorage.getItem(storeKey(root));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(root: string, set: Set<string>) {
  try {
    localStorage.setItem(storeKey(root), JSON.stringify(Array.from(set)));
  } catch {
    /* プライベートウィンドウなどでは保存できないだけ */
  }
}

/// プロジェクトペインのツリー。
///
/// 出るのは md ファイルと、それを子孫に持つディレクトリだけ (絞り込みは
/// Rust 側の read_md_tree が行う)。行はすべて button なので、Tauri の
/// ドラッグ領域に含まれても押せる。
export class TreePane {
  private tree: MdTree | null = null;
  private expanded = new Set<string>();
  /// 開いているファイル (印を付ける)
  private openPaths = new Set<string>();
  private activePath: string | null = null;
  /// キーボード操作の現在位置 (表示されている行の index)
  private cursor = -1;

  constructor(
    private root: HTMLElement,
    private opts: { onOpen: (path: string) => void; onNotice: (msg: string) => void }
  ) {
    this.root.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!row) return;
      const path = row.dataset.path!;
      if (row.dataset.dir === "1") this.toggle(path);
      else this.opts.onOpen(path);
    });
    this.root.addEventListener("keydown", (e) => this.handleKey(e));
  }

  get truncated() {
    return this.tree?.truncated ?? false;
  }

  get files() {
    return this.tree?.files ?? 0;
  }

  /// ルートを読み込んで描く。展開状態は前回のものを引き継ぐ。
  async load(rootPath: string) {
    this.expanded = loadExpanded(rootPath);
    await this.refresh(rootPath);
    // 何も展開されていなければ 1 段目のディレクトリだけ開いておく
    if (this.tree && this.expanded.size === 0) {
      for (const n of this.tree.children) if (n.dir) this.expanded.add(n.path);
      saveExpanded(this.tree.root, this.expanded);
      this.render();
    }
  }

  /// ツリーを取り直す。ファイルが増減したときに呼ぶ。
  async refresh(rootPath?: string) {
    const path = rootPath ?? this.tree?.root;
    if (!path) return;
    try {
      this.tree = await readMdTree(path);
    } catch (e) {
      this.opts.onNotice(`ツリーを読めませんでした: ${e}`);
      return;
    }
    this.render();
  }

  /// 開いているタブに印を付ける。
  markOpen(paths: string[], active: string | null) {
    this.openPaths = new Set(paths);
    this.activePath = active;
    this.paintMarks();
  }

  // ---------- 内部 ----------

  private toggle(path: string) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    if (this.tree) saveExpanded(this.tree.root, this.expanded);
    this.render();
  }

  private render() {
    if (!this.tree) return;
    const rows: HTMLElement[] = [];
    this.build(this.tree.children, 0, rows);

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "ink-tree-empty";
      empty.textContent = "Markdown ファイルが見つかりません";
      this.root.replaceChildren(empty);
      return;
    }
    if (this.tree.truncated) {
      const note = document.createElement("p");
      note.className = "ink-tree-note";
      note.textContent = `${this.tree.files} 件で打ち切りました。自動更新はしません`;
      this.root.replaceChildren(note, ...rows);
    } else {
      this.root.replaceChildren(...rows);
    }
    this.paintMarks();
    this.paintCursor();
  }

  private build(nodes: TreeNode[], depth: number, out: HTMLElement[]) {
    for (const n of nodes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = n.dir ? "ink-tree-row is-dir" : "ink-tree-row";
      row.dataset.path = n.path;
      row.dataset.dir = n.dir ? "1" : "0";
      row.setAttribute("role", "treeitem");
      row.tabIndex = -1;
      row.style.setProperty("--depth", String(depth));

      const twisty = document.createElement("span");
      twisty.className = "ink-tree-twisty";
      // textContent なのでエスケープ不要
      twisty.textContent = n.dir ? (this.expanded.has(n.path) ? "▾" : "▸") : "";

      const label = document.createElement("span");
      label.className = "ink-tree-label";
      label.textContent = n.name;

      const dot = document.createElement("span");
      dot.className = "ink-tree-dot";

      if (n.dir) {
        const icon = document.createElement("span");
        icon.className = "ink-tree-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = FOLDER_ICON;
        row.append(twisty, icon, label, dot);
      } else {
        row.append(twisty, label, dot);
      }
      if (n.dir) row.setAttribute("aria-expanded", String(this.expanded.has(n.path)));
      out.push(row);

      if (n.dir && this.expanded.has(n.path)) this.build(n.children, depth + 1, out);
    }
  }

  private get rows() {
    return Array.from(this.root.querySelectorAll<HTMLElement>(".ink-tree-row"));
  }

  private paintMarks() {
    for (const row of this.rows) {
      const path = row.dataset.path!;
      row.classList.toggle("is-open", this.openPaths.has(path));
      row.classList.toggle("is-active", path === this.activePath);
    }
  }

  private paintCursor() {
    const rows = this.rows;
    if (this.cursor >= rows.length) this.cursor = rows.length - 1;
    rows.forEach((r, i) => {
      r.classList.toggle("is-cursor", i === this.cursor);
      r.tabIndex = i === this.cursor ? 0 : -1;
    });
  }

  /// ↑↓ で移動、→ で展開、← で畳む、Enter で開く。
  private handleKey(e: KeyboardEvent) {
    const rows = this.rows;
    if (!rows.length) return;
    const move = (delta: number) => {
      this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + delta));
      this.paintCursor();
      rows[this.cursor].focus();
      rows[this.cursor].scrollIntoView({ block: "nearest" });
    };
    const current = rows[this.cursor];
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(this.cursor < 0 ? 1 : 1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "ArrowRight":
        if (current?.dataset.dir === "1" && current.getAttribute("aria-expanded") === "false") {
          e.preventDefault();
          this.toggle(current.dataset.path!);
        }
        break;
      case "ArrowLeft":
        if (current?.dataset.dir === "1" && current.getAttribute("aria-expanded") === "true") {
          e.preventDefault();
          this.toggle(current.dataset.path!);
        }
        break;
      case "Enter":
      case " ":
        if (!current) return;
        e.preventDefault();
        if (current.dataset.dir === "1") this.toggle(current.dataset.path!);
        else this.opts.onOpen(current.dataset.path!);
        break;
    }
  }
}
