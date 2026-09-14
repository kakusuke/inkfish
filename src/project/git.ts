import { invoke } from "@tauri-apps/api/core";
import { copyItems, type ContextMenu } from "../chrome/ctxmenu";
import { diffId, revId } from "../shared/rev";

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
  /// その ref が指すコミットの日時。新しい順に並べるのに使う
  time: number | null;
};

export type GitRefs = {
  entries: RefEntry[];
  fetchedAt: number | null;
  /// 「どこまで」が解決できなかった (消えたブランチを指しているなど)。
  /// そのときも候補は返ってくるので、選び直して直せる。
  endMissing: boolean;
};

export const gitProbe = (root: string) => invoke<GitProbe | null>("git_probe", { root });
export const gitRefs = (root: string, end: Endpoint) => invoke<GitRefs>("git_refs", { root, end });
export const gitChanges = (root: string, start: Endpoint, end: Endpoint) =>
  invoke<GitChanges>("git_changes", { root, start, end });

/// リモートから取り込む。remote が空なら既定のリモート。
/// 扱えるのは https / http / git の URL だけ (ssh は弾かれる)。
export const gitFetch = (root: string, remote = "") =>
  invoke<string>("git_fetch", { root, remote });

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

export const gitCounts = (root: string, ranges: Range[]) =>
  invoke<(number | null)[]>("git_counts", { root, ranges });

/// 何を比べているか。
///
/// 端点 2 つではなく「何を見たいか」で持つ。やりたいのは「この PR が持ち込む
/// 変更を見る」のような 1 つのことで、端点 2 つはその翻訳結果でしかない。翻訳した
/// 結果のほうを覚えると、枝が消えたときに意図ごと失われる (実際、取り込み済みで
/// 消えた枝を指したまま固まっていた)。意図で持てば、枝が無くなっても
/// 「その枝はもうありません」と言って選び直させられる。
export type Comparison =
  | { kind: "uncommitted" }
  | { kind: "staged" }
  | { kind: "last" }
  /// 既定ブランチとの分岐点から、そのブランチまで
  | { kind: "branch"; name: string }
  /// 端点を自分で指定したもの
  | { kind: "manual"; start: Endpoint; end: Endpoint };

/// 意図を実際の 2 点に落とす。これより下 (変更の一覧・差分の ID) は今までどおり。
export function toRange(c: Comparison, base: string | null): Range {
  const head: Endpoint = { kind: "rev", spec: "HEAD" };
  switch (c.kind) {
    case "uncommitted":
      return { start: head, end: { kind: "worktree" } };
    case "staged":
      return { start: head, end: { kind: "index" } };
    case "last":
      return { start: { kind: "rev", spec: "HEAD~1" }, end: head };
    case "branch":
      // 分岐点が当てられなければ HEAD から。枝そのものは指せるので、
      // 何も見せられないよりはよい
      return {
        start: base ? { kind: "merge-base", spec: base } : head,
        end: { kind: "rev", spec: c.name },
      };
    case "manual":
      return { start: c.start, end: c.end };
  }
}

/// 比較の名前。ペインのボタンに出る。
export function comparisonLabel(c: Comparison): string {
  switch (c.kind) {
    case "uncommitted":
      return "未コミットの変更";
    case "staged":
      return "ステージ済み";
    case "last":
      return "直前のコミット";
    case "branch":
      return `${c.name} の変更`;
    case "manual":
      return `${endpointLabel(c.start)} → ${endpointLabel(c.end)}`;
  }
}

const newerFetch = (a: number | null, b: number | null) =>
  a && b ? Math.max(a, b) : (a ?? b);

/// 比較する範囲はフォルダごとに覚える。ツリーの展開状態と同じ流儀。
const rangeKey = (root: string) => `ink.git.range:${root}`;

/// この窓から取り込んだ時刻。
///
/// gix は取り込んでも .git/FETCH_HEAD を書かない (git はそこに記録を残す)
/// ので、Rust 側が見ている「最終取得」は動かない。かといって .git に独自の
/// ファイルを置きたくないので、こちら側で覚えておく。ターミナルで git fetch
/// したぶんは FETCH_HEAD に出るので、新しい方を採る。
const fetchedKey = (root: string) => `ink.git.fetched:${root}`;

function loadFetchedAt(root: string): number | null {
  try {
    const raw = localStorage.getItem(fetchedKey(root));
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function saveFetchedAt(root: string, at: number) {
  try {
    localStorage.setItem(fetchedKey(root), String(at));
  } catch {
    /* 保存できないだけ */
  }
}

/// 覚えているものを読む。
///
/// 端点 2 つで覚えていた頃のものが残っているので、形を見て意図へ引き上げる。
/// よくある 2 つ (既定ブランチとの分岐点 → 枝 / HEAD → 作業ツリー) は意味が
/// 決まっているので拾い、それ以外は指定そのものとして抱える。
export function loadComparison(root: string, base: string | null): Comparison | null {
  let v: unknown;
  try {
    const raw = localStorage.getItem(rangeKey(root));
    if (!raw) return null;
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if ("kind" in v) return v as Comparison;

  const { start, end } = v as Range;
  if (!start || !end) return null;
  if (start.kind === "rev" && start.spec === "HEAD") {
    if (end.kind === "worktree") return { kind: "uncommitted" };
    if (end.kind === "index") return { kind: "staged" };
  }
  if (start.kind === "merge-base" && start.spec === base && end.kind === "rev") {
    return { kind: "branch", name: end.spec };
  }
  return { kind: "manual", start, end };
}

export function saveComparison(root: string, c: Comparison) {
  try {
    localStorage.setItem(rangeKey(root), JSON.stringify(c));
  } catch {
    /* 保存できないだけ。動作には影響しない */
  }
}

/// 既定は「未コミットの変更」。開いてすぐ見たいのはたいていこれで、
/// 分岐点からの差分を既定にするとフォルダを開くたびに大きな差分を計算することになる。
export const defaultComparison = (): Comparison => ({ kind: "uncommitted" });

/// git の変更ペイン。
///
/// ツリー (TreePane) とは別に持つ。木の構造が変わるのは md が増減したときだけで、
/// git の状態は保存やコミットのたびに変わるため、更新の契機が違う。
/// 状態だけの更新ではツリーの DOM を作り直さずに済む。
export class GitPane {
  private root: string | null = null;
  private probe: GitProbe | null = null;
  /// 何を比べているか。実際の 2 点は toRange で作る
  private cmp: Comparison | null = null;
  private changes: Change[] = [];
  /// ツリーの色用。範囲とは切り離して常に HEAD → 作業ツリーで取る
  private headChanges: Change[] = [];
  private others = 0;
  /// 変更を取れなかった理由。範囲が解決できないときに出す (空の一覧と区別する)
  private failure: string | null = null;
  private startId = "";
  private endId = "";
  private openPaths = new Set<string>();
  private activePath: string | null = null;

  constructor(
    private section: HTMLElement,
    private splitter: HTMLElement,
    private listEl: HTMLElement,
    private rangeBtn: HTMLElement,
    private menu: ContextMenu,
    private opts: {
      onOpen: (path: string) => void;
      onNotice: (msg: string) => void;
      /// 比較を選び直す。ツリーの色も塗り直したいのでガワに任せる
      onPick: (c: Comparison) => void;
    }
  ) {
    this.listEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!row) return;
      this.openChange(row.dataset.path!, "diff");
    });

    this.listEl.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (!row) return;
      e.preventDefault();
      this.openMenu(row.dataset.path!, e.clientX, e.clientY);
    });
  }

  private openMenu(path: string, x: number, y: number) {
    const change = this.changes.find((c) => c.path === path);
    const range = this.cmp && this.probe ? toRange(this.cmp, this.probe.defaultBase) : null;
    if (!change || !range) return;
    this.menu.open(
      [
        {
          label: "差分を並べて開く",
          disabled: !this.startId,
          run: () => this.openChange(path, "diff"),
        },
        {
          label: "変更前を開く",
          note: endpointLabel(range.start),
          // 起点に無いもの (追加・未追跡) には変更前が無い
          disabled: !this.startId || change.state === "A" || change.state === "?",
          run: () => this.openChange(path, "before"),
        },
        {
          label: "変更後を開く",
          note: endpointLabel(range.end),
          // 終点に無いもの (削除) には変更後が無い
          disabled: change.state === "D",
          run: () => this.openChange(path, "after"),
        },
        "sep",
        // コピーは行を開いたときと同じ ID で取る。コマンドラインに貼れば
        // 同じ差分がそのまま開く
        ...copyItems(this.idOf(change), (m) => this.opts.onNotice(m)),
      ],
      x,
      y
    );
  }

  /// 変更の行が指すもの。差分そのものを 1 つの ID にして、片側にしか無い
  /// ファイルも並べる (無い側はその旨を出す)。改名は終点側のパスで指す。
  /// 起点が無ければ終点側の実体を指す。
  private idOf(change: Change): string {
    if (this.startId) return diffId(this.startId, this.endId, change.path);
    return this.endId ? revId(this.endId, change.path) : change.path;
  }

  /// 変更の行を開く。片側にしか無いもの (追加・削除) は、並べても仕方がないので
  /// 存在する側だけを開く。
  private openChange(path: string, mode: "diff" | "before" | "after") {
    const change = this.changes.find((c) => c.path === path);
    if (!change) return;
    // 改名なら起点側のパスは改名前のもの
    const before = this.startId ? revId(this.startId, change.fromPath ?? path) : null;
    // 終点が作業ツリー / ステージなら実ファイルをそのまま開く
    const after = this.endId ? revId(this.endId, path) : path;
    if (mode === "before") {
      if (before) this.opts.onOpen(before);
      return;
    }
    if (mode === "after") {
      if (change.state !== "D") this.opts.onOpen(after);
      return;
    }
    this.opts.onOpen(this.idOf(change));
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
    this.cmp = loadComparison(rootPath, this.probe.defaultBase) ?? defaultComparison();
    await this.refresh();
  }

  /// 変更を取り直す。
  ///
  /// 変更ペインは選んだ範囲、ツリーの色は HEAD からの差分と、基準が違うので
  /// 2 つ取る。範囲が HEAD → 作業ツリーのときは同じものなので 1 回で済ませる。
  async refresh() {
    if (!this.root || !this.probe || !this.cmp) return;
    const range = toRange(this.cmp, this.probe.defaultBase);
    const isHead = this.cmp.kind === "uncommitted";
    try {
      const res = await gitChanges(this.root, range.start, range.end);
      this.failure = null;
      this.changes = res.entries;
      this.others = res.others;
      this.startId = res.startId;
      this.endId = res.endId;
      this.headChanges = isHead
        ? res.entries
        : (await gitChanges(this.root, { kind: "rev", spec: "HEAD" }, { kind: "worktree" }))
            .entries;
    } catch (e) {
      // 範囲の指定が解決できないことがある (取り込み済みの枝を消した後など)。
      // トーストは消えてしまうので、理由はペインにも残す。
      this.failure = String(e);
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

  async setComparison(c: Comparison) {
    if (!this.root) return;
    this.cmp = c;
    saveComparison(this.root, c);
    await this.refresh();
  }

  get comparison(): Comparison | null {
    return this.cmp;
  }

  /// 分岐点を計算する相手 (既定ブランチ)。比較を選ぶ側が要る
  get base(): string | null {
    return this.probe?.defaultBase ?? null;
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
    this.rangeBtn.querySelector(".ink-git-range-label")!.textContent = this.cmp
      ? comparisonLabel(this.cmp)
      : "";

    const rows: HTMLElement[] = [];
    for (const c of this.changes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ink-git-row";
      row.dataset.path = c.path;
      row.setAttribute("role", "listitem");
      // 削除されたファイルも、起点版と並べる形でなら開ける
      if (c.state === "D") row.classList.add("is-gone");

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

    // 範囲が解決できないときは「変更はありません」ではなく理由を出す。
    // 消えたブランチを指していると、選び直すまで何をしても変わらないため。
    if (this.failure) {
      const why = document.createElement("p");
      why.className = "ink-git-broken";
      why.textContent = this.failure;
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "ink-git-fix";
      fix.textContent = "未コミットの変更に切り替える";
      fix.addEventListener("click", () => this.opts.onPick(defaultComparison()));
      this.listEl.replaceChildren(why, fix);
      return;
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

/// 候補の 1 行。
type Choice = { label: string; ep: Endpoint; id?: string; note?: string };

/// 候補のまとまり。key は開閉の記憶に使う。
type Choices = {
  key: string;
  head: string;
  items: Choice[];
  /// 畳めるか。数の多いものだけ畳む
  fold: boolean;
  /// 見出しに置く取得ボタンの相手 (オリジン名)。空文字は既定のリモート
  remote?: string;
  /// 見出しに添える一言 (取得した時刻)
  note?: string;
};

/// 画面からはみ出さない位置に置く。
///
/// 範囲ボタンはペインの下の方にあるので、素直に下へ開くと画面外に出る。
/// 空いている側へ開き、それでも入らなければ高さを詰める。
function place(panel: HTMLElement, anchor: HTMLElement, up: boolean) {
  // 前回詰めた高さが残らないよう、測る前に CSS の値へ戻す
  panel.style.maxHeight = "";
  const r = anchor.getBoundingClientRect();
  const gap = 4;
  const margin = 8;

  const space = up ? r.top - gap - margin : window.innerHeight - r.bottom - gap - margin;
  if (panel.offsetHeight > space) panel.style.maxHeight = `${Math.round(space)}px`;

  // 高さを詰めたあとに測り直す (上に開くときは下端をボタンに合わせるため)
  panel.style.top = up
    ? `${Math.round(r.top - gap - panel.offsetHeight)}px`
    : `${Math.round(r.bottom + gap)}px`;

  const w = panel.offsetWidth;
  const left = Math.min(window.innerWidth - margin - w, Math.max(margin, r.left));
  panel.style.left = `${Math.round(left)}px`;
}

/// 上に開くか。空いている側へ。
const opensUp = (anchor: HTMLElement) => {
  const r = anchor.getBoundingClientRect();
  return window.innerHeight - r.bottom < r.top;
};

/// 一覧に出すブランチの数。これを超えるぶんは畳んでおく
const BRANCHES_SHOWN = 6;
/// 絞り込みを出す本数。これ以下なら目で足りる
const FILTER_FROM = 8;

/// 比較を選ぶポップオーバー。
///
/// 選ばせるのは端点 2 つではなく「何を見たいか」。PR のレビューが主なので、
/// ブランチを 1 つ選べば「そのブランチの変更」(既定ブランチとの分岐点から
/// その枝まで) が決まる。端点を自分で指したい人だけが「2 つの地点を選ぶ…」の
/// 奥へ行く — 端点 2 つは意図の翻訳結果でしかなく、覚えておくと枝が消えたときに
/// 意図ごと壊れる (Comparison のコメント参照)。
///
/// ブランチはリモートを先に、コミットの新しい順。名前順だと今レビューしている枝が
/// 埋もれる。右の数はその比較で変わる md の件数で、選ぶ前にどれを見ればよいかが
/// 分かるように出す (git_counts。遅れて届く)。
export class RangeMenu {
  /// どちらの面を出しているか
  private face: "list" | "ends" = "list";
  /// 開くときに位置を合わせる相手 (範囲ボタン) と、開く向き
  private anchor: HTMLElement | null = null;
  private openUp = false;
  private cursor = -1;
  private refs: RefEntry[] = [];
  private fetchedAt: number | null = null;
  /// 取得の実行中のオリジン。ボタンの見た目と二重起動の防止に使う
  private fetching: string | null = null;

  // ---------- 比較の一覧 ----------
  /// 比較 → 変わる md の件数。null は数えられなかったもの (消えた枝など)
  private counts = new Map<string, number | null>();
  /// 数は遅れて届くので、古い返事で上書きしないよう世代を見る
  private countSeq = 0;
  private branchFilter = "";
  /// ほかのブランチまで開いているか
  private allBranches = false;

  // ---------- 2 つの地点の面 ----------
  /// 候補の一覧がどちらの側に効くか。「他…」を押した側
  private side: "start" | "end" = "start";
  private picking = false;
  private pickerUp = false;
  /// 「どこまで」が解決できない (消えたブランチを指している)
  private endMissing = false;
  /// 開いているまとまり。開き直せば畳んだ状態から始める
  private unfolded = new Set<string>();

  constructor(
    private panel: HTMLElement,
    private opts: {
      getRoot: () => string | null;
      getComparison: () => Comparison | null;
      getBase: () => string | null;
      onPick: (c: Comparison) => void;
      /// 選び終わったので閉じてほしい。閉じるのはガワの持ち物 (PopoverGroup)
      onDone: () => void;
      onFetched: () => void;
      onNotice: (msg: string) => void;
    }
  ) {
    this.panel.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      if (target.closest(".ink-cmp-manual")) return this.showFace("ends");
      if (target.closest(".ink-cmp-back")) return this.showFace("list");

      const fetch = target.closest<HTMLElement>(".ink-cmp-fetch, .ink-grm-fetch");
      if (fetch) return void this.runFetch(fetch.dataset.remote ?? "");

      const more = target.closest<HTMLElement>(".ink-cmp-more");
      if (more) {
        this.allBranches = !this.allBranches;
        this.cursor = -1;
        return this.render();
      }

      const row = target.closest<HTMLElement>(".ink-cmp-row");
      if (row) return this.take(JSON.parse(row.dataset.cmp!) as Comparison);

      const end = target.closest<HTMLElement>(".ink-grm-end");
      if (end) return this.clickEnd(end);
    });

    this.panel.addEventListener("keydown", (e) => this.handleKey(e));
    this.filterEl.addEventListener("input", () => {
      this.cursor = -1;
      this.render();
    });
    this.branchFilterEl.addEventListener("input", () => {
      this.branchFilter = this.branchFilterEl.value;
      this.cursor = -1;
      this.render();
    });

    this.listEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const fold = target.closest<HTMLElement>(".ink-grm-fold");
      if (fold) {
        const key = fold.dataset.key!;
        if (this.unfolded.has(key)) this.unfolded.delete(key);
        else this.unfolded.add(key);
        this.cursor = -1;
        this.render();
        return;
      }
      const row = target.closest<HTMLElement>(".ink-grm-row");
      if (row) this.pick(row);
    });
  }

  /// ボタンの位置に合わせて開く。候補は開くたびに取り直す
  /// (ブランチは外で動くし、end が変われば分岐点も変わるため)。
  async opened(anchor: HTMLElement) {
    this.anchor = anchor;
    this.openUp = opensUp(anchor);
    this.face = "list";
    this.side = "start";
    this.picking = false;
    this.allBranches = false;
    this.branchFilter = "";
    this.branchFilterEl.value = "";
    this.pickerEl.classList.add("hidden");
    this.filterEl.value = "";
    this.cursor = -1;
    this.unfolded.clear();
    this.render();
    await this.reload();
  }

  // ---------- 内部 ----------

  private get cmpFaceEl() {
    return this.panel.querySelector<HTMLElement>(".ink-cmp-face:not(.ink-cmp-ends)")!;
  }

  private get endsFaceEl() {
    return this.panel.querySelector<HTMLElement>(".ink-cmp-ends")!;
  }

  private get cmpListEl() {
    return this.panel.querySelector<HTMLElement>(".ink-cmp-list")!;
  }

  private get branchFilterEl() {
    return this.panel.querySelector<HTMLInputElement>(".ink-cmp-filter")!;
  }

  private get branchesEl() {
    return this.panel.querySelector<HTMLElement>(".ink-cmp-branches")!;
  }

  private get pickerEl() {
    return this.panel.querySelector<HTMLElement>(".ink-grm-picker")!;
  }

  private get filterEl() {
    return this.panel.querySelector<HTMLInputElement>(".ink-grm-filter")!;
  }

  private get listEl() {
    return this.panel.querySelector<HTMLElement>(".ink-grm-list")!;
  }

  private showFace(face: "list" | "ends") {
    this.closePicker();
    this.face = face;
    this.cursor = -1;
    this.render();
  }

  /// 比較を決める。1 行 = 1 つの意図なので、選んだ時点で用は済んでいる。
  /// 端点を 1 つずつ指す面 (put) とは違い、ここは選んだら閉じる。
  private take(c: Comparison) {
    this.opts.onPick(c);
    this.opts.onDone();
  }

  /// 一覧に出す比較。上から順にそのまま並ぶ。
  private rowsOf(): { cmp: Comparison; label: string; note?: string; tag?: string }[] {
    const out: { cmp: Comparison; label: string; note?: string; tag?: string }[] = [];
    out.push({ cmp: { kind: "uncommitted" }, label: "未コミットの変更" });
    out.push({ cmp: { kind: "staged" }, label: "ステージ済み" });
    out.push({ cmp: { kind: "last" }, label: "直前のコミット" });
    return out;
  }

  /// ブランチの行。リモートを先に、コミットの新しい順。
  ///
  /// 名前順だと、いまレビューしている枝が下のほうに埋もれる。新しい順なら
  /// たいてい先頭付近に出る。
  private branchRows() {
    const q = this.branchFilter.trim().toLowerCase();
    const rank = (r: RefEntry) => (r.kind === "remote" ? 0 : 1);
    return this.refs
      .filter((r) => r.kind === "branch" || r.kind === "remote")
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || (b.time ?? 0) - (a.time ?? 0))
      .map((r) => ({
        cmp: { kind: "branch", name: r.name } as Comparison,
        label: r.name,
        note: r.time ? relTime(r.time) : "",
        tag: r.kind === "branch" ? "ローカル" : "",
      }));
  }

  /// リモートの名前 (取得の単位)。参照が無くても既定のリモート向けに出す。
  private remotes(): string[] {
    const out = new Set<string>();
    for (const r of this.refs) {
      if (r.kind !== "remote") continue;
      out.add(r.name.slice(0, Math.max(0, r.name.indexOf("/"))));
    }
    return out.size ? [...out].sort() : [""];
  }

  private renderList() {
    const cur = this.opts.getComparison();
    const curKey = cur ? JSON.stringify(cur) : "";
    const nodes: HTMLElement[] = [];

    const row = (r: { cmp: Comparison; label: string; note?: string; tag?: string }) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ink-cmp-row";
      el.dataset.cmp = JSON.stringify(r.cmp);
      el.setAttribute("role", "option");
      if (JSON.stringify(r.cmp) === curKey) el.classList.add("is-on");

      const name = document.createElement("span");
      name.className = "ink-cmp-name";
      name.textContent = r.label;
      el.append(name);

      if (r.tag) {
        const tag = document.createElement("span");
        tag.className = "ink-cmp-tag";
        tag.textContent = r.tag;
        el.append(tag);
      }

      // 数は遅れて届く。届くまでは何も出さない (0 と紛らわしいので)
      const n = this.counts.get(JSON.stringify(r.cmp));
      const count = document.createElement("span");
      count.className = "ink-cmp-count";
      if (n !== undefined && n !== null) {
        count.textContent = String(n);
        if (n === 0) count.classList.add("is-zero");
      }
      el.append(count);

      if (r.note) {
        const note = document.createElement("span");
        note.className = "ink-cmp-when";
        note.textContent = r.note;
        el.append(note);
      }
      return el;
    };

    for (const r of this.rowsOf()) nodes.push(row(r));

    // ブランチ
    const head = document.createElement("p");
    head.className = "ink-grm-head";
    const label = document.createElement("span");
    label.textContent = "ブランチの変更";
    head.append(label);
    if (this.fetchedAt) {
      const when = document.createElement("span");
      when.className = "ink-grm-when";
      when.textContent = `${relTime(this.fetchedAt)}に取得`;
      head.append(when);
    }
    for (const remote of this.remotes()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ink-cmp-fetch";
      btn.dataset.remote = remote;
      btn.textContent = this.fetching === remote ? "取得中…" : remote ? `取得 ${remote}` : "取得";
      btn.disabled = this.fetching !== null;
      head.append(btn);
    }
    nodes.push(head);

    this.cmpListEl.replaceChildren(...nodes);

    // ブランチは別の器へ。ここだけがスクロールする (よく使う比較は常に見える)
    const branches = this.branchRows();
    const many = branches.length > FILTER_FROM;
    this.branchFilterEl.classList.toggle("hidden", !many && !this.branchFilter);
    const shown = this.allBranches || this.branchFilter ? branches : branches.slice(0, BRANCHES_SHOWN);
    const below: HTMLElement[] = shown.map(row);

    const rest = branches.length - shown.length;
    if (rest > 0 || this.allBranches) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ink-cmp-more";
      more.textContent = this.allBranches ? "▾ 少なく" : `▸ ほかのブランチ ${rest}`;
      below.push(more);
    }
    if (!branches.length) {
      const empty = document.createElement("p");
      empty.className = "ink-git-empty";
      empty.textContent = this.branchFilter ? "見つかりません" : "ブランチがありません";
      below.push(empty);
    }
    this.branchesEl.replaceChildren(...below);

    void this.fillCounts([...this.rowsOf(), ...shown].map((r) => r.cmp));
  }

  /// 一覧に出ているぶんの件数を数えて埋める。
  ///
  /// 1 つずつ問い合わせると往復が増えるので、見えている行をまとめて 1 回。
  /// 遅れて届くので、その間に一覧が変わっていたら捨てる。
  private async fillCounts(cmps: Comparison[]) {
    const root = this.opts.getRoot();
    const base = this.opts.getBase();
    if (!root) return;
    const want = cmps.filter((c) => !this.counts.has(JSON.stringify(c)));
    if (!want.length) return;
    const seq = ++this.countSeq;
    try {
      const got = await gitCounts(root, want.map((c) => toRange(c, base)));
      if (seq !== this.countSeq) return;
      want.forEach((c, i) => this.counts.set(JSON.stringify(c), got[i] ?? null));
      if (this.face === "list") this.renderList();
    } catch {
      /* 数が出ないだけ。選ぶのに支障はない */
    }
  }

  // ---------- 2 つの地点の面 ----------

  /// いま効いている 2 点。意図で選んでいても、端点の面ではその翻訳結果を見せる。
  private effective(): Range | null {
    const c = this.opts.getComparison();
    return c ? toRange(c, this.opts.getBase()) : null;
  }

  private clickEnd(btn: HTMLElement) {
    const side = btn.closest<HTMLElement>("[data-side]")?.dataset.side === "end" ? "end" : "start";
    if (btn.dataset.ep) {
      // よく使う 3 つはその場で決まる。一覧を出す用は無い
      this.closePicker();
      void this.put(side, JSON.parse(btn.dataset.ep) as Endpoint);
      return;
    }
    // 「他…」— そのボタンの位置に候補を開く。開いている側をもう一度押したら閉じる
    if (this.picking && this.side === side) this.closePicker();
    else this.openPicker(side);
  }

  /// 「他…」のボタン。一覧はここに合わせて開く
  private otherBtn(side: "start" | "end") {
    return this.panel.querySelector<HTMLElement>(
      `.ink-grm-ends[data-side="${side}"] .ink-grm-end:last-child`
    );
  }

  private openPicker(side: "start" | "end") {
    this.side = side;
    this.picking = true;
    this.filterEl.value = "";
    this.cursor = -1;
    this.unfolded.clear();
    this.pickerEl.classList.remove("hidden");
    const btn = this.otherBtn(side);
    if (btn) this.pickerUp = opensUp(btn);
    this.render();
    this.filterEl.focus();
  }

  private closePicker() {
    if (!this.picking) return;
    this.picking = false;
    this.pickerEl.classList.add("hidden");
    // 閉じたら中身も捨てる。次に開くときは組み直すので、古い一覧を
    // 抱えたままにしておく意味がない
    this.listEl.replaceChildren();
    this.render();
  }

  /// 端点を 1 つ差し替える。端点をいじった時点で「自分で指した比較」になる。
  private async put(side: "start" | "end", ep: Endpoint) {
    const cur = this.effective();
    if (!cur) return;
    const next = side === "start" ? { ...cur, start: ep } : { ...cur, end: ep };
    this.opts.onPick({ kind: "manual", start: next.start, end: next.end });
    if (side === "end") await this.reload();
    else this.render();
  }

  /// 候補のまとまり。
  private groups(): Choices[] {
    const q = this.filterEl.value.trim();
    const hit = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const out: Choices[] = [];

    // 入力がどれにも当たらなければ、revspec としてそのまま使わせる
    const typed: Choice[] =
      q && !this.refs.some((r) => r.name === q)
        ? [{ label: q, ep: { kind: "rev", spec: q }, note: "この指定で比べる" }]
        : [];
    if (typed.length) out.push({ key: "typed", head: "直接指定", items: typed, fold: false });

    // 分岐点。end に取り込まれていないものだけが意味を持つ。いちばん使うので畳まない
    if (this.side === "start") {
      const items = this.refs
        .filter((r) => r.diverged && hit(r.name))
        .map((r) => ({
          label: r.name,
          ep: { kind: "merge-base", spec: r.name } as Endpoint,
          id: r.base ?? undefined,
          note: [r.baseTime ? relTime(r.baseTime) : "", r.baseSummary ?? ""]
            .filter(Boolean)
            .join(" · "),
        }));
      if (items.length) out.push({ key: "base", head: "分岐点", items, fold: false });
    }

    const plain = (r: RefEntry): Choice => ({
      label: r.name,
      ep: { kind: "rev", spec: r.name } as Endpoint,
      id: r.id,
    });

    const local = this.refs.filter((r) => r.kind === "branch" && hit(r.name)).map(plain);
    if (local.length) out.push({ key: "branch", head: "ローカル", items: local, fold: true });

    // リモートはオリジンごとに分ける。取得もオリジン単位なので、見出しがそのまま
    // 取得の単位になる (origin/main の origin)
    const remotes = new Map<string, Choice[]>();
    for (const r of this.refs) {
      if (r.kind !== "remote") continue;
      const name = r.name.slice(0, Math.max(0, r.name.indexOf("/")));
      if (!remotes.has(name)) remotes.set(name, []);
      if (hit(r.name)) remotes.get(name)!.push(plain(r));
    }
    if (!remotes.size) remotes.set("", []);
    for (const [name, items] of [...remotes].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (q && !items.length) continue;
      out.push({
        key: `remote:${name}`,
        head: name ? `リモート ${name}` : "リモート",
        items,
        fold: items.length > 0,
        remote: name,
        note: this.fetchedAt ? `${relTime(this.fetchedAt)}に取得` : "取得記録なし",
      });
    }

    const tags = this.refs.filter((r) => r.kind === "tag" && hit(r.name)).map(plain);
    if (tags.length) out.push({ key: "tag", head: "タグ", items: tags, fold: true });

    return out;
  }

  /// 片側ぶんのボタン列。3 択に無い値は「他…」の側に名前で出す。
  private renderEnds(side: "start" | "end") {
    const host = this.panel.querySelector<HTMLElement>(`.ink-grm-ends[data-side="${side}"]`);
    if (!host) return;
    const range = this.effective();
    const cur = range ? (side === "start" ? range.start : range.end) : null;
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
    // 解決できない指定はそう見えるようにする。直すまで変更は取れない
    if (other && side === "end" && this.endMissing) b.classList.add("is-missing");
    // 候補を開いている側
    if (this.picking && this.side === side) b.classList.add("is-open");
    nodes.push(b);
    host.replaceChildren(...nodes);
  }

  private renderPicker() {
    this.filterEl.placeholder =
      this.side === "end" ? "どこまで を絞り込み / HEAD~3 など" : "どこから を絞り込み / HEAD~3 など";

    const range = this.effective();
    const current = range ? (this.side === "start" ? range.start : range.end) : null;
    const currentKey = current ? JSON.stringify(current) : "";
    const filtering = !!this.filterEl.value.trim();

    const nodes: HTMLElement[] = [];
    for (const group of this.groups()) {
      // 絞り込み中は、当たりのあるまとまりを開いて見せる
      const open = !group.fold || filtering || this.unfolded.has(group.key);

      const head = document.createElement("p");
      head.className = "ink-grm-head";

      if (group.fold) {
        const label = document.createElement("button");
        label.type = "button";
        label.className = "ink-grm-fold";
        label.dataset.key = group.key;
        label.textContent = `${open ? "▾" : "▸"} ${group.head}`;
        // 件数は畳んだまま中身の多寡が分かるように。名前と地続きに見えないよう薄く
        const n = document.createElement("span");
        n.className = "ink-grm-count";
        n.textContent = String(group.items.length);
        label.append(n);
        head.append(label);
      } else {
        const label = document.createElement("span");
        label.textContent = group.head;
        head.append(label);
      }

      if (group.note) {
        const note = document.createElement("span");
        note.className = "ink-grm-when";
        note.textContent = group.note;
        head.append(note);
      }
      if (group.remote !== undefined) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ink-grm-fetch";
        btn.dataset.remote = group.remote;
        btn.textContent = this.fetching === group.remote ? "取得中…" : "取得";
        btn.disabled = this.fetching !== null;
        head.append(btn);
      }
      nodes.push(head);
      if (!open) continue;

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
  }

  // ---------- 描く・動かす ----------

  private render() {
    this.cmpFaceEl.classList.toggle("hidden", this.face !== "list");
    this.endsFaceEl.classList.toggle("hidden", this.face !== "ends");
    if (this.face === "list") this.renderList();
    else {
      this.renderEnds("end");
      this.renderEnds("start");
    }
    if (this.picking) this.renderPicker();
    this.paintCursor();
    if (this.anchor) place(this.panel, this.anchor, this.openUp);
    // 一覧は「他…」に合わせる。ボタンは組み直したばかりなので取り直す
    const btn = this.picking ? this.otherBtn(this.side) : null;
    if (btn) place(this.pickerEl, btn, this.pickerUp);
  }

  /// ↑↓ の対象。開いている面のものだけ
  private get rows() {
    const sel = this.picking ? ".ink-grm-row" : this.face === "list" ? ".ink-cmp-row" : "";
    if (!sel) return [];
    return Array.from(this.panel.querySelectorAll<HTMLElement>(sel));
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
      if (!rows.length) return;
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      this.cursor = Math.max(0, Math.min(rows.length - 1, this.cursor + d));
      this.paintCursor();
    } else if (e.key === "Enter") {
      const row = rows[this.cursor] ?? rows[0];
      if (!row) return;
      e.preventDefault();
      if (this.picking) this.pick(row);
      else this.take(JSON.parse(row.dataset.cmp!) as Comparison);
    } else if (e.key === "Escape" && this.picking) {
      // 閉じるのは候補だけ。ここで止めないと比較のメニューごと閉じる
      e.stopPropagation();
      e.preventDefault();
      this.closePicker();
    }
  }

  private pick(row: HTMLElement) {
    const side = this.side;
    this.closePicker();
    void this.put(side, JSON.parse(row.dataset.ep!) as Endpoint);
  }

  /// リモートから取り込んで、候補と変更を取り直す。
  private async runFetch(remote: string) {
    const root = this.opts.getRoot();
    if (!root || this.fetching !== null) return;
    this.fetching = remote;
    this.render();
    try {
      await gitFetch(root, remote);
      saveFetchedAt(root, Date.now());
      this.fetching = null;
      // 取り込むと枝が動くので、数えたものは当てにならない
      this.counts.clear();
      await this.reload();
      // 取り込みで分岐点が動くことがあるので、変更ペインも取り直す
      this.opts.onFetched();
    } catch (e) {
      this.opts.onNotice(`取得できませんでした: ${e}`);
      this.fetching = null;
      this.render();
    }
  }

  private async reload() {
    const root = this.opts.getRoot();
    const range = this.effective();
    if (!root || !range) return;
    try {
      const res = await gitRefs(root, range.end);
      this.refs = res.entries;
      this.endMissing = res.endMissing;
      this.fetchedAt = newerFetch(res.fetchedAt, loadFetchedAt(root));
    } catch (e) {
      this.opts.onNotice(`ブランチの一覧を取れませんでした: ${e}`);
    }
    this.render();
  }
}
