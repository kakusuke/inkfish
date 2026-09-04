import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath as openExternal } from "@tauri-apps/plugin-opener";
import type { LinkTarget } from "../viewer/viewer";
import { Toast, wireLinkStatus } from "../chrome/toast";
import { PopoverGroup } from "../chrome/popover";
import { FindBar } from "../chrome/findbar";
import { fillSettings, openInEditor, wireSettings } from "../chrome/settings";
import { exportPdf } from "../chrome/pdf";
import { WindowMenu } from "../chrome/windowmenu";
import {
  adoptTab,
  isMarkdownPath,
  openDirDialog,
  openDirWindow,
  openDropped,
  openFileDialog,
  requestOpen,
  setWindowTabs,
  tearOutTab,
  watchFiles,
  windowAt,
  windowRects,
} from "../chrome/files";
import { shortenPath } from "../shared/paths";
import { DocTab } from "./tab";
import { TreePane } from "./tree";
import { TabStrip, type TabView } from "./tabs";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const PANE_W_KEY = "ink.pane.width";
const PANE_COLLAPSED_KEY = "ink.pane.collapsed";

/// プロジェクトウィンドウのガワ。
///
/// 左にツリーペイン、右にタブ。中身 (DocumentViewer) はタブごとに 1 つ持ち、
/// 切り替えは表示の付け替えだけで済ませる (スクロール位置・ズーム・検索・
/// 図の描画結果がそのまま残る)。
///
/// 単一文書のガワ (src/shell) との違いは「文書が複数ある」ことだけなので、
/// クローム部品 (検索バー・設定・トースト・ウィンドウ切替・PDF 書き出し) は
/// src/chrome の同じものを使い、渡す対象をアクティブタブに差し替えている。
export class ProjectShell {
  private root = "";
  private tabs: DocTab[] = [];
  private activeId: string | null = null;

  private toast: Toast;
  private popovers = new PopoverGroup();
  private findBar: FindBar;
  private tree: TreePane;
  private strip: TabStrip;
  private panes: HTMLElement;
  private emptyEl: HTMLElement;
  private progressEl: HTMLElement;
  private capsule: HTMLButtonElement;
  private settingsPopover!: ReturnType<PopoverGroup["register"]>;
  private windowMenu!: WindowMenu;
  private treeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: { resolveAsset: (absPath: string) => string }) {
    this.toast = new Toast($(".ink-toast"));
    this.panes = $(".ink-tabpanes");
    this.emptyEl = $(".ink-empty-tabs");
    this.progressEl = $(".ink-progress");
    this.capsule = $<HTMLButtonElement>(".ink-capsule");

    this.tree = new TreePane($(".ink-tree"), {
      onOpen: (p) => void this.openPath(p),
      onNotice: (m) => this.toast.show(m),
    });

    this.strip = new TabStrip($(".ink-tabstrip"), {
      onSelect: (id) => this.activate(id),
      onClose: (id) => this.closeTab(id),
      onReorder: (ids) => this.reorder(ids),
      onDropOutside: (id, x, y) => void this.dropOutside(id, x, y),
    });

    this.findBar = new FindBar($(".ink-findbar"), {
      find: (q, autoScroll) => this.active?.viewer.find(q, autoScroll),
      findNext: () => this.active?.viewer.findNext(),
      findPrev: () => this.active?.viewer.findPrev(),
      clear: () => this.active?.viewer.clearFind(),
      onClosed: () => this.active?.viewer.focus(),
    });

    this.wireChrome();
    this.wirePane();
    this.wireBackend();
    this.wireKeys();
    this.wireDragDrop();
    wireLinkStatus($(".ink-linkstatus"));
  }

  async start() {
    const root = await invoke<string | null>("get_project_root");
    if (!root) {
      this.toast.show("開くフォルダが渡されませんでした");
      return;
    }
    this.root = root;
    this.applyCaption();
    await this.tree.load(root);
    // 上限に当たったツリーは再帰監視の費用が読めないので、手動更新に落とす
    if (!this.tree.truncated) {
      try {
        await invoke("watch_tree", { root });
      } catch (e) {
        this.toast.show(`ツリーの監視を開始できませんでした: ${e}`);
      }
    }
  }

  private get active(): DocTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  // ---------- 配線 ----------

  private wireChrome() {
    const settingsPanel = $(".ink-settings");
    const settingsToggle = $<HTMLButtonElement>('[data-act="settings"]');
    this.settingsPopover = this.popovers.register({
      panel: settingsPanel,
      toggle: settingsToggle,
      onOpen: () => fillSettings($(".ink-editor-cmd")),
    });
    settingsToggle.addEventListener("click", () => this.popovers.toggle(this.settingsPopover));
    wireSettings(
      $(".ink-editor-cmd"),
      $(".ink-settings-save"),
      (msg) => this.toast.show(msg),
      () => this.popovers.close(this.settingsPopover)
    );

    // ディレクトリのパス部分が、開いているウィンドウとタブの一覧を開くボタン
    this.windowMenu = new WindowMenu($(".ink-window-menu"), this.capsule, (msg) =>
      this.toast.show(msg)
    );
    const windowPopover = this.popovers.register({
      panel: $(".ink-window-menu"),
      toggle: this.capsule,
      onOpen: () => void this.windowMenu.refresh(),
    });
    this.windowMenu.close = () => this.popovers.close(windowPopover);
    this.capsule.addEventListener("click", () => this.popovers.toggle(windowPopover));
    window.addEventListener("keydown", (e) => {
      if (!this.popovers.isOpen(windowPopover)) return;
      if (this.windowMenu.handleKey(e.key)) e.preventDefault();
    });

    $('[data-act="open"]').addEventListener("click", () => void this.pickFile());
    $('[data-act="edit"]').addEventListener("click", () => void this.editActive());
    $('[data-act="refresh-tree"]').addEventListener("click", () => void this.tree.refresh());
  }

  /// ペインの幅と折りたたみ。幅はドラッグで変えて localStorage に覚える。
  private wirePane() {
    const body = $(".ink-body");
    const splitter = $(".ink-splitter");

    const apply = (w: number) => body.style.setProperty("--ink-pane-w", `${w}px`);
    try {
      const saved = Number(localStorage.getItem(PANE_W_KEY));
      if (saved >= 160 && saved <= 640) apply(saved);
      if (localStorage.getItem(PANE_COLLAPSED_KEY) === "1") {
        document.body.classList.add("is-pane-collapsed");
      }
    } catch {
      /* 保存が使えないだけ */
    }

    splitter.addEventListener("pointerdown", (e) => {
      splitter.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = $(".ink-pane").getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const w = Math.max(160, Math.min(640, startW + ev.clientX - startX));
        apply(w);
      };
      const up = () => {
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", up);
        try {
          localStorage.setItem(PANE_W_KEY, String($(".ink-pane").getBoundingClientRect().width));
        } catch {
          /* 保存が使えないだけ */
        }
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });

    $('[data-act="toggle-pane"]').addEventListener("click", () => this.togglePane());
  }

  private togglePane() {
    const collapsed = document.body.classList.toggle("is-pane-collapsed");
    try {
      localStorage.setItem(PANE_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* 保存が使えないだけ */
    }
  }

  private wireBackend() {
    // emit_to(label, …) 宛のイベントはグローバルの listen() では
    // ターゲット指定が無視され全ウィンドウで受信してしまうので、
    // 必ず現在の Webview にスコープして受け取る。
    const webview = getCurrentWebview();

    // ペイロードは変更されたファイルの正規化済みパス
    webview.listen<string>("md:changed", (ev) => {
      for (const tab of this.tabs) if (tab.path === ev.payload) tab.scheduleReload();
    });

    // ルート配下の md / ディレクトリが増減した
    webview.listen("tree:changed", () => {
      clearTimeout(this.treeTimer);
      this.treeTimer = setTimeout(() => void this.tree.refresh(), 200);
    });

    // 起動後に届いたオープン要求 / 既に開いているタブの選択要求
    webview.listen<string>("md:open", (ev) => {
      if (ev.payload) void this.openTab(ev.payload);
    });
    // 別の窓がこの窓の上にドラッグされてきた (受け入れ可能なことを示す)
    webview.listen<boolean>("dock:hover", (ev) => {
      document.body.classList.toggle("is-dock-target", ev.payload);
    });

    // 他のウィンドウから渡されたタブ
    webview.listen<string>("tab:adopt", (ev) => {
      document.body.classList.remove("is-dock-target");
      if (ev.payload) void this.openTab(ev.payload);
    });
    webview.listen<string>("md:activate", (ev) => {
      const tab = this.tabs.find((t) => t.path === ev.payload);
      if (tab) this.activate(tab.id);
    });

    webview.listen("menu:open", () => void this.pickFile());
    webview.listen("menu:open-dir", () => void this.pickDir());
    webview.listen("menu:export-pdf", () => void this.exportPdf());
  }

  private wireKeys() {
    // ライトボックス表示中はキー操作を専有する (本文ズームより優先)
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.active?.viewer.handleLightboxKey(e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const viewer = this.active?.viewer;
      // ⌘⌥← / → でタブを移動
      if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        this.step(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        this.togglePane();
        return;
      }
      // ⌘1..9 で n 番目のタブ
      if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < this.tabs.length) {
          e.preventDefault();
          this.activate(this.tabs[i].id);
        }
        return;
      }
      switch (e.key) {
        case "o": e.preventDefault(); void this.pickFile(); break;
        case "e": e.preventDefault(); void this.editActive(); break;
        case "f": e.preventDefault(); this.findBar.open(); break;
        case "w":
          // タブがあれば閉じる。無ければウィンドウを閉じる既定の動きに任せる
          if (this.activeId) {
            e.preventDefault();
            this.closeTab(this.activeId);
          }
          break;
        case "=": case "+": e.preventDefault(); viewer?.nudgeScale(0.1); break;
        case "-": e.preventDefault(); viewer?.nudgeScale(-0.1); break;
        case "0": e.preventDefault(); viewer?.setScale(1); break;
      }
    });
  }

  private wireDragDrop() {
    getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") return;
      document.body.classList.toggle("is-dropping", ev.payload.type === "enter");
      if (ev.payload.type !== "drop") return;
      void openDropped(
        ev.payload.paths,
        (p) => void this.openPath(p),
        (msg) => this.toast.show(msg)
      );
    });
  }

  // ---------- タブ ----------

  /// ファイルを開く。ウィンドウの振り分けは Rust 側 (open_path) が決める。
  /// プロジェクトウィンドウからの要求は、他の窓が開いていなければ
  /// "load-here" (= この窓のタブ) になる。
  private async openPath(path: string) {
    try {
      const outcome = await requestOpen(path);
      // "focused" のときは md:activate が飛んでくるので何もしない
      if (outcome.action === "load-here") await this.openTab(outcome.path);
    } catch (e) {
      this.toast.show(String(e));
    }
  }

  private async openTab(path: string) {
    const found = this.tabs.find((t) => t.path === path);
    if (found) {
      this.activate(found.id);
      return;
    }
    const tab = new DocTab(path, this.panes, {
      resolveAsset: this.opts.resolveAsset,
      onCaption: () => this.syncTabs(),
      onNotice: (m) => this.toast.show(m),
      onProgress: (t, r) => {
        if (t.id === this.activeId) this.progressEl.style.setProperty("--progress", String(r));
      },
      onFindUpdate: (t, s) => {
        if (t.id === this.activeId) this.findBar.update(s);
      },
      onLinkActivate: (t) => void this.handleLink(t),
    });
    this.tabs.push(tab);
    // 読み込む前に表へ出す。凍結中は描画を溜めるので、先に出さないと
    // 開いたタブが空のまま見えてしまう。
    this.activate(tab.id);
    try {
      await tab.load();
    } catch (e) {
      tab.dispose();
      this.tabs = this.tabs.filter((t) => t.id !== tab.id);
      this.toast.show(`読み込めませんでした: ${e}`);
      // 消したタブを選んだままにしない
      if (this.activeId === tab.id) {
        this.activeId = this.tabs[this.tabs.length - 1]?.id ?? null;
        for (const t of this.tabs) t.setActive(t.id === this.activeId);
      }
      this.syncTabs();
    }
  }

  private activate(id: string) {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activeId = id;
    for (const tab of this.tabs) tab.setActive(tab.id === id);
    this.syncTabs();
  }

  private step(delta: number) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = (i + delta + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  private closeTab(id: string) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tabs[i].dispose();
    this.tabs.splice(i, 1);
    if (this.activeId === id) {
      // 閉じた位置の隣を選ぶ (右優先、無ければ左)
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      for (const tab of this.tabs) tab.setActive(tab.id === this.activeId);
    }
    this.syncTabs();
  }

  /// タブ列の外で離された。落とした先で振る舞いが変わる:
  ///   - 自分のウィンドウの中 → 何もしない (取り消し)
  ///   - 別のウィンドウの中   → 相手に渡してこちらのタブを閉じる
  ///   - どの窓の上でもない   → その場所に単一文書ウィンドウとして切り離す
  private async dropOutside(id: string, x: number, y: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    let target: string | null = null;
    let ownWindow = false;
    try {
      const rects = await windowRects();
      const hit = windowAt(rects, x, y);
      const self = getCurrentWindow().label;
      ownWindow = hit?.label === self;
      // 単一文書ウィンドウはタブを持てないので渡す相手にしない
      if (hit && hit.label !== self && hit.kind === "project") target = hit.label;
    } catch (e) {
      this.toast.show(`ウィンドウの位置を取れませんでした: ${e}`);
      return;
    }

    // 自分の窓の上で離した (列の外) なら取り消し。並びは崩れているので描き直す
    if (ownWindow && !target) {
      this.syncTabs();
      return;
    }

    try {
      if (target) await adoptTab(target, tab.path);
      else await tearOutTab(tab.path, x, y);
    } catch (e) {
      this.toast.show(String(e));
      this.syncTabs();
      return;
    }
    this.closeTab(id);
  }

  private reorder(ids: string[]) {
    const byId = new Map(this.tabs.map((t) => [t.id, t]));
    const next = ids.map((id) => byId.get(id)).filter((t): t is DocTab => !!t);
    // 取りこぼしがあれば元の順序を守って戻す (見た目と状態がずれないように)
    if (next.length !== this.tabs.length) {
      this.syncTabs();
      return;
    }
    this.tabs = next;
    this.syncTabs();
  }

  /// タブ列・ツリーの印・ウィンドウの台帳・監視をまとめて今の状態に合わせる。
  private syncTabs() {
    const views: TabView[] = this.tabs.map((t) => ({
      id: t.id,
      caption: t.caption,
      name: t.name,
      marp: t.isMarp,
    }));
    this.strip.render(views, this.activeId);
    this.emptyEl.classList.toggle("hidden", this.tabs.length > 0);
    $('[data-act="edit"]').classList.toggle("hidden", !this.active);
    this.tree.markOpen(
      this.tabs.map((t) => t.path),
      this.active?.path ?? null
    );
    this.applyCaption();

    const active = this.tabs.findIndex((t) => t.id === this.activeId);
    setWindowTabs(
      this.tabs.map((t) => ({ path: t.path, caption: t.caption })),
      Math.max(0, active)
    ).catch(() => {});
    watchFiles(this.tabs.map((t) => t.path)).catch(() => {});
  }

  /// ヘッダーとウィンドウタイトルはディレクトリのパスを出す。
  /// 今見ているファイル名はタブが持っているので重ねない。
  private applyCaption() {
    const short = shortenPath(this.root);
    $(".ink-filename").textContent = short;
    this.capsule.title = this.root;
    const doc = this.active?.caption;
    getCurrentWindow().setTitle(doc ? `${doc} — ${short}` : `${short} — Inkfish`);
  }

  // ---------- その他の操作 ----------

  private async pickFile() {
    const path = await openFileDialog();
    if (path) await this.openPath(path);
  }

  private async pickDir() {
    const path = await openDirDialog();
    if (!path) return;
    try {
      await openDirWindow(path);
    } catch (e) {
      this.toast.show(String(e));
    }
  }

  private async editActive() {
    const tab = this.active;
    if (!tab) return;
    try {
      await openInEditor(tab.path);
    } catch (e) {
      this.toast.show(String(e));
      // エディタが起動できないのは設定が原因なので、その場で開いて直させる
      this.popovers.open(this.settingsPopover);
    }
  }

  private async exportPdf() {
    const tab = this.active;
    if (!tab) {
      this.toast.show("先にファイルを開いてください");
      return;
    }
    await exportPdf(tab.viewer, tab.path, {
      closeFind: () => this.findBar.close(),
      notify: (msg) => this.toast.show(msg),
    });
  }

  private async handleLink(t: LinkTarget) {
    if (t.kind === "external") {
      void openUrl(t.href);
      return;
    }
    // 相対リンクの md はこのウィンドウのタブで開く
    if (isMarkdownPath(t.path)) {
      await this.openPath(t.path);
      return;
    }
    const ok = await confirm(`外部アプリで開きます:\n${t.path}`, {
      title: "外部アプリで開く",
      kind: "warning",
      okLabel: "開く",
      cancelLabel: "キャンセル",
    });
    if (!ok) return;
    try {
      await openExternal(t.path);
    } catch (err) {
      this.toast.show(`開けませんでした: ${err}`);
    }
  }
}
