import { invoke } from "@tauri-apps/api/core";
import { revId } from "../shared/rev";

/// 比較の端点。Rust 側の Endpoint と対。
/// `merge-base` は「その revision と end との分岐点」で、end が決まらないと
/// 定まらないため、解決は Rust 側で end を見てから行う。
export type Endpoint =
  | { kind: "worktree" }
  | { kind: "index" }
  | { kind: "rev"; spec: string }
  | { kind: "merge-base"; spec: string };

/// "M" 変更 / "A" 追加 / "D" 削除 / "R" 改名 / "U" コンフリクト / "?" 未追跡
export type GitState = "M" | "A" | "D" | "R" | "U" | "?";

export type Change = {
  path: string;
  rel: string;
  state: GitState;
  from: string | null;
  fromPath: string | null;
};

export type GitChanges = {
  entries: Change[];
  others: number;
  /// 解決した起点 / 終点のコミット (40 桁)。作業ツリー・ステージなら空
  startId: string;
  endId: string;
};

export type GitProbe = {
  workdir: string;
  head: string;
  detached: boolean;
  fetchedAt: number | null;
  defaultBase: string | null;
};

export type RefEntry = {
  name: string;
  kind: "branch" | "remote" | "tag";
  id: string;
  diverged: boolean;
  base: string | null;
  baseTime: number | null;
  baseSummary: string | null;
};

export type GitRefs = { entries: RefEntry[]; fetchedAt: number | null };

export const gitProbe = (root: string) => invoke<GitProbe | null>("git_probe", { root });
export const gitRefs = (root: string, end: Endpoint) => invoke<GitRefs>("git_refs", { root, end });
export const gitChanges = (root: string, start: Endpoint, end: Endpoint) =>
  invoke<GitChanges>("git_changes", { root, start, end });

/// 「12 分前」。日をまたぐと相対表記は意味が薄れるので、1 週間で日付に切り替える。
export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "たった今";
  if (diff < 60_000) return "たった今";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 時間前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 日前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/// 端点の表示名。範囲のラベルと選択の見出しに使う。
export function endpointLabel(e: Endpoint): string {
  switch (e.kind) {
    case "worktree":
      return "作業ツリー";
    case "index":
      return "ステージ済み";
    case "rev":
      return e.spec;
    case "merge-base":
      return `${e.spec} の分岐点`;
  }
}

export type Range = { start: Endpoint; end: Endpoint };

/// 比較する範囲はフォルダごとに覚える。ツリーの展開状態と同じ流儀。
const rangeKey = (root: string) => `ink.git.range:${root}`;

export function loadRange(root: string): Range | null {
  try {
    const raw = localStorage.getItem(rangeKey(root));
    return raw ? (JSON.parse(raw) as Range) : null;
  } catch {
    return null;
  }
}

export function saveRange(root: string, range: Range) {
  try {
    localStorage.setItem(rangeKey(root), JSON.stringify(range));
  } catch {
    /* 保存できないだけ。動作には影響しない */
  }
}

/// 既定は「分岐元から今の作業まで」。分岐元が当てられなければ HEAD からにする。
export function defaultRange(probe: GitProbe): Range {
  return {
    start: probe.defaultBase
      ? { kind: "merge-base", spec: probe.defaultBase }
      : { kind: "rev", spec: "HEAD" },
    end: { kind: "worktree" },
  };
}

/// git の変更ペイン。
///
/// ツリー (TreePane) とは別に持つ。木の構造が変わるのは md が増減したときだけで、
/// git の状態は保存やコミットのたびに変わるため、更新の契機が違う。
/// 状態だけの更新ではツリーの DOM を作り直さずに済む。
export class GitPane {
  private root: string | null = null;
  private probe: GitProbe | null = null;
  private range: Range | null = null;
  private changes: Change[] = [];
  /// ツリーの色用。範囲とは切り離して常に HEAD → 作業ツリーで取る
  private headChanges: Change[] = [];
  private others = 0;
  private startId = "";
  private endId = "";
  /// 右クリックメニューが対象にしている行
  private menuPath: string | null = null;
  private openPaths = new Set<string>();
  private activePath: string | null = null;

  constructor(
    private section: HTMLElement,
    private splitter: HTMLElement,
    private listEl: HTMLElement,
    private rangeBtn: HTMLElement,
    private menuEl: HTMLElement,
    private opts: { onOpen: (path: string) => void; onNotice: (msg: string) => void }
  ) {
    this.listEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!row || row.hasAttribute("disabled")) return;
      this.opts.onOpen(row.dataset.path!);
    });

    this.listEl.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!row) return;
      e.preventDefault();
      this.openMenu(row.dataset.path!, e.clientX, e.clientY);
    });

    this.menuEl.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLButtonElement>(".ink-git-mi");
      if (!item || item.disabled) return;
      const path = this.menuPath;
      this.closeMenu();
      if (path) this.runMenu(item.dataset.act!, path);
    });

    // メニューの外を押すか Esc で閉じる (ポップオーバーとは開き方が違うので自前)
    document.addEventListener("mousedown", (e) => {
      if (!this.menuEl.contains(e.target as Node)) this.closeMenu();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  private openMenu(path: string, x: number, y: number) {
    const change = this.changes.find((c) => c.path === path);
    if (!change || !this.range) return;
    this.menuPath = path;

    const item = (act: string) =>
      this.menuEl.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
    const before = item("before");
    const after = item("after");
    // 起点に無いもの (追加・未追跡) には変更前が無い。終点に無いもの (削除) は逆
    before.disabled = !this.startId || change.state === "A" || change.state === "?";
    after.disabled = change.state === "D";
    before.querySelector(".ink-git-mi-note")!.textContent = endpointLabel(this.range.start);
    after.querySelector(".ink-git-mi-note")!.textContent = endpointLabel(this.range.end);

    this.menuEl.classList.remove("hidden");
    const r = this.menuEl.getBoundingClientRect();
    this.menuEl.style.left = `${Math.round(Math.min(x, window.innerWidth - r.width - 8))}px`;
    this.menuEl.style.top = `${Math.round(Math.min(y, window.innerHeight - r.height - 8))}px`;
  }

  private closeMenu() {
    this.menuEl.classList.add("hidden");
    this.menuPath = null;
  }

  private runMenu(act: string, path: string) {
    const change = this.changes.find((c) => c.path === path);
    if (!change) return;
    if (act === "before") {
      // 改名なら起点側のパスは改名前のもの
      this.opts.onOpen(revId(this.startId, change.fromPath ?? path));
    } else {
      // 終点が作業ツリー / ステージなら実ファイルをそのまま開く
      this.opts.onOpen(this.endId ? revId(this.endId, path) : path);
    }
  }

  /// git 管理下かどうかで、ペインごと出す / 出さないを決める。
  async load(rootPath: string) {
    this.root = rootPath;
    this.probe = await gitProbe(rootPath).catch(() => null);
    const on = !!this.probe;
    this.section.classList.toggle("hidden", !on);
    this.splitter.classList.toggle("hidden", !on);
    if (!this.probe) {
      this.changes = [];
      return;
    }
    this.range = loadRange(rootPath) ?? defaultRange(this.probe);
    await this.refresh();
  }

  /// 変更を取り直す。
  ///
  /// 変更ペインは選んだ範囲、ツリーの色は HEAD からの差分と、基準が違うので
  /// 2 つ取る。範囲が HEAD → 作業ツリーのときは同じものなので 1 回で済ませる。
  async refresh() {
    if (!this.root || !this.probe || !this.range) return;
    const isHead =
      this.range.start.kind === "rev" &&
      this.range.start.spec === "HEAD" &&
      this.range.end.kind === "worktree";
    try {
      const res = await gitChanges(this.root, this.range.start, this.range.end);
      this.changes = res.entries;
      this.others = res.others;
      this.startId = res.startId;
      this.endId = res.endId;
      this.headChanges = isHead
        ? res.entries
        : (await gitChanges(this.root, { kind: "rev", spec: "HEAD" }, { kind: "worktree" }))
            .entries;
    } catch (e) {
      // 範囲の指定が解決できないことがある (ブランチを消した後など)
      this.changes = [];
      this.headChanges = [];
      this.others = 0;
      this.opts.onNotice(`変更を取れませんでした: ${e}`);
    }
    this.render();
  }

  /// ツリーに色を塗るための「パス → 状態」。基準は常に HEAD。
  get headStates(): Map<string, GitState> {
    return new Map(this.headChanges.map((c) => [c.path, c.state]));
  }

  async setRange(range: Range) {
    if (!this.root) return;
    this.range = range;
    saveRange(this.root, range);
    await this.refresh();
  }

  get currentRange(): Range | null {
    return this.range;
  }

  get enabled() {
    return !!this.probe;
  }

  /// 開いているタブに印を付ける (ツリーと同じ)。
  markOpen(paths: string[], active: string | null) {
    this.openPaths = new Set(paths);
    this.activePath = active;
    this.paintMarks();
  }

  // ---------- 内部 ----------

  private render() {
    if (!this.probe) return;
    this.rangeBtn.querySelector(".ink-git-range-label")!.textContent = this.range
      ? `${endpointLabel(this.range.start)} → ${endpointLabel(this.range.end)}`
      : "";

    const rows: HTMLElement[] = [];
    for (const c of this.changes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ink-git-row";
      row.dataset.path = c.path;
      row.setAttribute("role", "listitem");
      // 削除されたファイルは開けない (フェーズ 1 では起点の中身を出さないため)
      if (c.state === "D") {
        row.classList.add("is-gone");
        row.setAttribute("disabled", "");
      }

      const badge = document.createElement("span");
      badge.className = "ink-git-badge";
      // 未追跡も、起点から見れば「追加」なので同じ見た目にする
      const shown = c.state === "?" ? "A" : c.state;
      badge.dataset.state = shown;
      badge.textContent = shown;

      const slash = c.rel.lastIndexOf("/");
      const name = document.createElement("span");
      name.className = "ink-git-name";
      name.textContent = slash < 0 ? c.rel : c.rel.slice(slash + 1);

      const dir = document.createElement("span");
      dir.className = "ink-git-dir";
      dir.textContent = slash < 0 ? "" : c.rel.slice(0, slash);

      row.title = c.from ? `${c.rel}  ← ${c.from}` : c.rel;
      row.append(badge, name, dir);
      rows.push(row);
    }

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "ink-git-empty";
      empty.textContent = "変更はありません";
      this.listEl.replaceChildren(empty);
      return;
    }

    if (this.others > 0) {
      const note = document.createElement("p");
      note.className = "ink-git-others";
      note.textContent = `ほか ${this.others} ファイル (Markdown 以外)`;
      this.listEl.replaceChildren(...rows, note);
    } else {
      this.listEl.replaceChildren(...rows);
    }
    this.paintMarks();
  }

  private paintMarks() {
    for (const row of Array.from(this.listEl.querySelectorAll<HTMLElement>(".ink-git-row"))) {
      const path = row.dataset.path!;
      row.classList.toggle("is-open", this.openPaths.has(path));
      row.classList.toggle("is-active", path === this.activePath);
    }
  }
}

/// 比較する範囲を選ぶポップオーバー。
///
/// 「どこから」と「どこまで」で候補の作り方が違う。分岐点 (merge-base) は
/// end が決まらないと定まらないので、候補は現在の end に対して Rust 側が
/// 計算したものを使う (end に取り込み済みのブランチは分岐点がそのブランチ
/// 自身になり、そのまま指定したときと同じ結果になるので出さない)。
export class RangeMenu {
  private side: "start" | "end" = "start";
  /// 開くときに位置を合わせる相手 (範囲ボタン)
  private anchor: HTMLElement | null = null;
  /// 上に開くか。開いた時点で決めて、あとで候補が増えても変えない
  private openUp = false;
  private refs: RefEntry[] = [];
  private fetchedAt: number | null = null;
  private cursor = -1;

  constructor(
    private panel: HTMLElement,
    private opts: {
      getRoot: () => string | null;
      getRange: () => Range | null;
      onPick: (range: Range) => void;
      onNotice: (msg: string) => void;
    }
  ) {
    this.endsEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".ink-grm-end");
      if (!btn) return;
      if (btn.dataset.ep) {
        void this.pickEnd(JSON.parse(btn.dataset.ep) as Endpoint);
      } else {
        // 「他…」— ブランチやタグを end にする。リストを end 用に切り替える
        this.side = "end";
        this.filterEl.value = "";
        this.cursor = -1;
        this.render();
        this.filterEl.focus();
      }
    });
    this.filterEl.addEventListener("input", () => {
      this.cursor = -1;
      this.render();
    });
    this.filterEl.addEventListener("keydown", (e) => this.handleKey(e));
    this.listEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ink-grm-row");
      if (row) this.pick(row);
    });
  }

  private get endsEl() {
    return this.panel.querySelector<HTMLElement>(".ink-grm-ends")!;
  }

  private get fromHeadEl() {
    return this.panel.querySelector<HTMLElement>(".ink-grm-fromhead")!;
  }

  private get filterEl() {
    return this.panel.querySelector<HTMLInputElement>(".ink-grm-filter")!;
  }

  private get listEl() {
    return this.panel.querySelector<HTMLElement>(".ink-grm-list")!;
  }

  /// ボタンの位置に合わせて開く。候補は開くたびに取り直す
  /// (ブランチは外で動くし、end が変われば分岐点も変わるため)。
  async opened(anchor: HTMLElement) {
    this.anchor = anchor;
    // 開く向きはここで決めてしまう。候補が届いて高さが変わるたびに
    // 向きが変わると、ポップオーバーが上下に飛んで見えるため
    const r = anchor.getBoundingClientRect();
    this.openUp = window.innerHeight - r.bottom < r.top;
    this.side = "start";
    this.filterEl.value = "";
    this.cursor = -1;
    this.render();
    this.filterEl.focus();

    const root = this.opts.getRoot();
    const range = this.opts.getRange();
    if (!root || !range) return;
    try {
      const res = await gitRefs(root, range.end);
      this.refs = res.entries;
      this.fetchedAt = res.fetchedAt;
    } catch (e) {
      this.opts.onNotice(`ブランチの一覧を取れませんでした: ${e}`);
    }
    this.render();
  }

  // ---------- 内部 ----------

  /// 表示する候補を組み立てる。1 行 = 1 つの端点。
  private candidates(): { head: string; items: { label: string; ep: Endpoint; id?: string; note?: string }[] }[] {
    const q = this.filterEl.value.trim();
    const hit = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const out: { head: string; items: { label: string; ep: Endpoint; id?: string; note?: string }[] }[] = [];

    if (this.side === "start") {
      // 分岐点。end に取り込まれていないものだけが意味を持つ
      const diverged = this.refs.filter((r) => r.diverged && hit(r.name));
      if (diverged.length) {
        out.push({
          head: "分岐点",
          items: diverged.map((r) => ({
            label: r.name,
            ep: { kind: "merge-base", spec: r.name } as Endpoint,
            id: r.base ?? undefined,
            note: [r.baseTime ? relTime(r.baseTime) : "", r.baseSummary ?? ""]
              .filter(Boolean)
              .join(" · "),
          })),
        });
      }
    }

    // そのまま指定する側。作業ツリー / ステージ済み / HEAD は「どこまで」では
    // ボタンに出ているので、ここに重ねて出すのは「どこから」のときだけ
    const plain: { label: string; ep: Endpoint; id?: string; note?: string }[] = [];
    if (this.side === "start") {
      if (hit("ステージ済み")) plain.push({ label: "ステージ済み", ep: { kind: "index" } });
      if (hit("HEAD")) plain.push({ label: "HEAD", ep: { kind: "rev", spec: "HEAD" } });
    }
    if (plain.length) out.push({ head: "そのまま", items: plain });

    for (const [kind, head] of [
      ["branch", "ブランチ"],
      ["remote", this.fetchedAt ? `リモート (${relTime(this.fetchedAt)}に取得)` : "リモート (取得記録なし)"],
      ["tag", "タグ"],
    ] as const) {
      const items = this.refs
        .filter((r) => r.kind === kind && hit(r.name))
        .map((r) => ({ label: r.name, ep: { kind: "rev", spec: r.name } as Endpoint, id: r.id }));
      if (items.length) out.push({ head, items });
    }

    // 入力がどれにも当たらなければ、revspec としてそのまま使わせる
    if (q && !out.some((g) => g.items.some((i) => i.label === q))) {
      out.unshift({
        head: "直接指定",
        items: [{ label: q, ep: { kind: "rev", spec: q }, note: "この指定で比べる" }],
      });
    }
    return out;
  }

  /// 「どこまで」の 3 択 + その他。今の end が 3 択に無ければ 4 つ目にその名前で出す。
  private renderEnds() {
    const cur = this.opts.getRange()?.end;
    const key = cur ? JSON.stringify(cur) : "";
    const fixed: { label: string; ep: Endpoint }[] = [
      { label: "作業ツリー", ep: { kind: "worktree" } },
      { label: "ステージ済み", ep: { kind: "index" } },
      { label: "HEAD", ep: { kind: "rev", spec: "HEAD" } },
    ];
    const nodes: HTMLElement[] = [];
    for (const f of fixed) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ink-grm-end";
      b.dataset.ep = JSON.stringify(f.ep);
      b.textContent = f.label;
      if (JSON.stringify(f.ep) === key) b.classList.add("is-on");
      nodes.push(b);
    }
    const other = !fixed.some((f) => JSON.stringify(f.ep) === key);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ink-grm-end";
    b.textContent = other && cur ? endpointLabel(cur) : "他…";
    if (other) b.classList.add("is-on");
    if (this.side === "end") b.classList.add("is-on");
    nodes.push(b);
    this.endsEl.replaceChildren(...nodes);
  }

  /// end を決めたら分岐点も変わるので、候補を取り直して「どこから」に戻る。
  private async pickEnd(ep: Endpoint) {
    const range = this.opts.getRange();
    if (!range) return;
    this.opts.onPick({ ...range, end: ep });
    this.side = "start";
    this.filterEl.value = "";
    this.cursor = -1;
    await this.reload();
    this.filterEl.focus();
  }

  private render() {
    this.renderEnds();
    this.fromHeadEl.textContent = this.side === "end" ? "どこまで を選ぶ" : "どこから";

    const range = this.opts.getRange();
    const current = range ? (this.side === "start" ? range.start : range.end) : null;
    const currentKey = current ? JSON.stringify(current) : "";

    const nodes: HTMLElement[] = [];
    for (const group of this.candidates()) {
      const head = document.createElement("p");
      head.className = "ink-grm-head";
      head.textContent = group.head;
      nodes.push(head);

      for (const item of group.items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ink-grm-row";
        row.dataset.ep = JSON.stringify(item.ep);
        row.setAttribute("role", "option");
        if (JSON.stringify(item.ep) === currentKey) row.classList.add("is-on");

        const name = document.createElement("span");
        name.className = "ink-grm-name";
        name.textContent = item.label;
        row.append(name);

        if (item.id) {
          const id = document.createElement("span");
          id.className = "ink-grm-id";
          id.textContent = item.id;
          row.append(id);
        }
        if (item.note) {
          const note = document.createElement("span");
          note.className = "ink-grm-note";
          note.textContent = item.note;
          row.append(note);
        }
        nodes.push(row);
      }
    }

    if (!nodes.length) {
      const empty = document.createElement("p");
      empty.className = "ink-grm-head";
      empty.textContent = "候補がありません";
      nodes.push(empty);
    }
    this.listEl.replaceChildren(...nodes);
    this.paintCursor();
    this.place();
  }

  /// 画面からはみ出さない位置に置く。
  ///
  /// このボタンはペインの下の方にあるので、素直に下へ開くと画面外に出る。
  /// 空いている側へ開き、それでも入らなければ高さを詰める。
  private place() {
    if (!this.anchor) return;
    const p = this.panel;
    // 前回詰めた高さが残らないよう、測る前に CSS の値 (60vh) へ戻す
    p.style.maxHeight = "";
    const r = this.anchor.getBoundingClientRect();
    const gap = 4;
    const margin = 8;

    const space = this.openUp
      ? r.top - gap - margin
      : window.innerHeight - r.bottom - gap - margin;
    if (p.offsetHeight > space) p.style.maxHeight = `${Math.round(space)}px`;

    // 高さを詰めたあとに測り直す (上に開くときは下端をボタンに合わせるため)
    p.style.top = this.openUp
      ? `${Math.round(r.top - gap - p.offsetHeight)}px`
      : `${Math.round(r.bottom + gap)}px`;

    const w = p.offsetWidth;
    const left = Math.min(window.innerWidth - margin - w, Math.max(margin, r.left));
    p.style.left = `${Math.round(left)}px`;
  }

  private get rows() {
    return Array.from(this.listEl.querySelectorAll<HTMLElement>(".ink-grm-row"));
  }

  private paintCursor() {
    const rows = this.rows;
    if (this.cursor >= rows.length) this.cursor = rows.length - 1;
    rows.forEach((r, i) => r.classList.toggle("is-cursor", i === this.cursor));
    if (this.cursor >= 0) rows[this.cursor]?.scrollIntoView({ block: "nearest" });
  }

  private handleKey(e: KeyboardEvent) {
    const rows = this.rows;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + d));
      this.paintCursor();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[this.cursor] ?? rows[0];
      if (row) this.pick(row);
    }
  }

  private pick(row: HTMLElement) {
    const range = this.opts.getRange();
    if (!range) return;
    const ep = JSON.parse(row.dataset.ep!) as Endpoint;
    if (this.side === "end") {
      void this.pickEnd(ep);
      return;
    }
    this.opts.onPick({ ...range, start: ep });
    this.render();
  }

  private async reload() {
    const root = this.opts.getRoot();
    const range = this.opts.getRange();
    if (!root || !range) return;
    try {
      const res = await gitRefs(root, range.end);
      this.refs = res.entries;
      this.fetchedAt = res.fetchedAt;
    } catch {
      /* 取れなければ前の候補のまま */
    }
    this.render();
  }
}
