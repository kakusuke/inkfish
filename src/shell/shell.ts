import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath as openExternal } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { basename, dirname } from "../shared/paths";
import { DocumentViewer, type LinkTarget } from "../viewer/viewer";
import { Toolbar } from "./toolbar";
import { Toast, wireLinkStatus } from "../chrome/toast";
import { PopoverGroup } from "../chrome/popover";
import { FindBar } from "../chrome/findbar";
import { fillSettings, openInEditor, wireSettings } from "../chrome/settings";
import { pushRecent, renderRecents } from "./recents";
import { exportPdf } from "../chrome/pdf";
import { WindowMenu } from "../chrome/windowmenu";
import { makeWindowDraggable } from "../chrome/windowdrag";
import {
  adoptTab,
  closeSelf,
  isMarkdownPath,
  openDirDialog,
  openDirWindow,
  openDropped,
  openFileDialog,
  readMdFile,
  requestOpen,
  setWindowTabs,
  watchFiles,
} from "../chrome/files";
import { isRev } from "../shared/rev";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
/// 同じ data-act を持つ要素が複数ある (ツールバーと空の状態の「フォルダを開く」)
/// ので、まとめて配線する。
const onAct = (act: string, fn: () => void) => {
  for (const el of Array.from(document.querySelectorAll(`[data-act="${act}"]`))) {
    el.addEventListener("click", fn);
  }
};

/// ウィンドウのガワ。ツールバー・空の状態・検索バー・設定・トーストを持ち、
/// 中身 (DocumentViewer) を内部で生成して配線する。
///
/// 別の形式のウィンドウ (ツールバーなしの集中モードなど) を作るときは、
/// このクラスの代わりに独自のガワを書き、DocumentViewer だけを載せる。
export class AppShell {
  private viewer: DocumentViewer;
  private toolbar: Toolbar;
  private toast: Toast;
  private popovers = new PopoverGroup();
  private findBar: FindBar;
  private emptyEl: HTMLElement;

  private currentPath: string | null = null;
  private currentName = "";
  // 読み込んだソースの控え。ファイル監視は親ディレクトリを見ているので
  // 中身が変わっていない通知も届く。無駄な再描画を避けるために突き合わせる。
  private currentSource = "";
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private settingsPopover!: ReturnType<PopoverGroup["register"]>;
  private windowMenu!: WindowMenu;

  constructor(opts: { resolveAsset: (absPath: string) => string }) {
    this.emptyEl = $(".ink-empty");
    this.toast = new Toast($(".ink-toast"));
    this.toolbar = new Toolbar($(".ink-toolbar"), $(".ink-progress"));

    this.viewer = new DocumentViewer($(".ink-content"), {
      resolveAsset: opts.resolveAsset,
      onCaption: ({ title, name }) => this.applyCaption(title, name),
      onNotice: (msg) => this.toast.show(msg),
      onProgress: (ratio) => this.toolbar.setProgress(ratio),
      onFindUpdate: (s) => this.findBar.update(s),
      onLinkActivate: (t) => this.handleLink(t),
    });

    this.findBar = new FindBar($(".ink-findbar"), {
      find: (q, autoScroll) => this.viewer.find(q, autoScroll),
      findNext: () => this.viewer.findNext(),
      findPrev: () => this.viewer.findPrev(),
      clear: () => this.viewer.clearFind(),
      onClosed: () => this.viewer.focus(),
    });

    this.wireChrome();
    this.wireBackend();
    this.wireKeys();
    this.wireDragDrop();
    wireLinkStatus($(".ink-linkstatus"));
  }

  async start() {
    renderRecents($(".ink-recents"), $(".ink-recent-list"), (p) => this.openPath(p));
    const startupFile = await invoke<string | null>("get_startup_file");
    if (startupFile) await this.loadFile(startupFile);
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

    // ウィンドウ切替のキャレット。一覧は開くたびに取り直す。
    this.windowMenu = new WindowMenu($(".ink-window-menu"), this.toolbar.capsule, (msg) =>
      this.toast.show(msg)
    );
    const windowPopover = this.popovers.register({
      panel: $(".ink-window-menu"),
      toggle: this.toolbar.capsule,
      onOpen: () => this.windowMenu.refresh(),
    });
    this.windowMenu.close = () => this.popovers.close(windowPopover);
    this.toolbar.capsule.addEventListener("click", () => this.popovers.toggle(windowPopover));
    // ↑↓ / Enter は一覧が開いているときだけ専有する
    window.addEventListener("keydown", (e) => {
      if (!this.popovers.isOpen(windowPopover)) return;
      if (this.windowMenu.handleKey(e.key)) e.preventDefault();
    });

    // カプセルを掴むとウィンドウ自体が動き、プロジェクトウィンドウの上で
    // 離すとそのタブとして取り込まれる。
    makeWindowDraggable(this.toolbar.capsule, {
      onDrop: (label) => void this.dockInto(label),
    });

    onAct("open", () => void this.pickFile());
    onAct("empty-open", () => void this.pickFile());
    onAct("open-dir", () => void this.pickDir());
    onAct("edit", () => void this.editCurrent());
  }

  private wireBackend() {
    // これらの Rust 側イベントは emit_to(label, …) で特定ウィンドウ宛に発行される。
    // グローバルの listen() は EventTarget::Any として登録されターゲット指定を無視し
    // 全ウィンドウで受信してしまうため、必ず現在の Webview にスコープして受け取る。
    // (そうしないと複数ウィンドウ時に全ウィンドウが PDF 書き出しや再読込を実行する)
    const webview = getCurrentWebview();

    // ペイロードは変更されたファイルの正規化済みパス。この窓は 1 ファイルしか
    // 持たないが、監視は親ディレクトリ単位なので他のファイルの通知も届く。
    webview.listen<string>("md:changed", (ev) => {
      if (ev.payload !== this.currentPath) return;
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 60);
    });

    // Finder の「このアプリケーションで開く」など、起動後に届いたオープン要求
    webview.listen<string>("md:open", (ev) => {
      if (ev.payload && ev.payload !== this.currentPath) this.loadFile(ev.payload);
    });

    // ネイティブメニュー (ファイル) からの操作
    webview.listen("menu:open", () => this.pickFile());
    webview.listen("menu:open-dir", () => this.pickDir());
    webview.listen("menu:export-pdf", () => this.exportPdf());
  }

  private wireKeys() {
    // ライトボックス表示中はキー操作を専有する(本文ズームより優先)
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.viewer.handleLightboxKey(e.key)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key) {
        case "o": e.preventDefault(); this.pickFile(); break;
        case "e": e.preventDefault(); this.editCurrent(); break;
        case "f": e.preventDefault(); this.findBar.open(); break;
        case "=": case "+": e.preventDefault(); this.viewer.nudgeScale(0.1); break;
        case "-": e.preventDefault(); this.viewer.nudgeScale(-0.1); break;
        case "0": e.preventDefault(); this.viewer.setScale(1); break;
      }
    });
  }

  private wireDragDrop() {
    getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") return;
      document.body.classList.toggle("is-dropping", ev.payload.type === "enter");
      if (ev.payload.type !== "drop") return;
      // フォルダなら Rust がプロジェクトウィンドウを開く
      void openDropped(
        ev.payload.paths,
        (p) => this.openPath(p),
        (msg) => this.toast.show(msg)
      );
    });
  }

  // ---------- ファイル ----------

  private async pickFile() {
    const path = await openFileDialog();
    if (path) this.openPath(path);
  }

  /// フォルダを選んでプロジェクトウィンドウで開く
  private async pickDir() {
    const path = await openDirDialog();
    if (!path) return;
    try {
      await openDirWindow(path);
    } catch (e) {
      this.toast.show(String(e));
    }
  }

  /// ファイルを開く。ウィンドウの振り分けは Rust 側が決める。
  private async openPath(path: string) {
    try {
      const outcome = await requestOpen(path);
      // 正規化済みのパスで読む (台帳と表記を揃えて md:changed と突き合わせる)
      if (outcome.action === "load-here") await this.loadFile(outcome.path);
    } catch (e) {
      this.toast.show(String(e));
    }
  }

  private async loadFile(path: string) {
    let source: string;
    try {
      source = await readMdFile(path);
    } catch (e) {
      this.toast.show(`読み込めませんでした: ${e}`);
      return;
    }
    this.currentPath = path;
    this.currentName = basename(path) || path;
    this.currentSource = source;

    this.emptyEl.classList.add("hidden");
    this.toolbar.showCapsule();
    // 起点版 (rev:/…) は実ファイルが無いのでエディタでは開けない
    $('[data-act="edit"]').classList.toggle("hidden", isRev(path));
    // 起点版は「最近開いたファイル」には積まない (実体が無く、開き直せないため)
    if (!isRev(path)) pushRecent(path, this.currentName);
    // 「同じファイルは同じウィンドウ」の台帳に先に載せる。front matter の
    // title があれば applyCaption が描画中に上書きするが、描画で何かあっても
    // 台帳が空にならないよう、ここでファイル名で登録しておく。
    setWindowTabs([{ path, caption: this.currentName }], 0).catch(() => {});

    await this.viewer.setSource(source, {
      baseDir: dirname(path),
      name: this.currentName,
    });
    this.toolbar.setMarpMode(this.viewer.isMarp);
    this.viewer.scrollToTop();

    try {
      await watchFiles([path]);
      this.toolbar.setWatchState("watching");
    } catch (e) {
      this.toolbar.setWatchState("error");
      this.toast.show(`変更監視を開始できませんでした: ${e}`);
    }
  }

  private async reload(retry = true) {
    if (!this.currentPath) return;
    try {
      const src = await readMdFile(this.currentPath);
      // atomic save の途中で空ファイルを読むことがあるため一度だけリトライ
      if (src === "" && this.currentSource !== "" && retry) {
        setTimeout(() => this.reload(false), 150);
        return;
      }
      if (src === this.currentSource) return;
      this.currentSource = src;
      this.toolbar.setWatchState("watching");
      await this.viewer.setSource(src, {
        baseDir: dirname(this.currentPath),
        name: this.currentName,
      });
      this.toolbar.setMarpMode(this.viewer.isMarp);
    } catch {
      if (retry) setTimeout(() => this.reload(false), 150);
      else this.toolbar.setWatchState("error");
    }
  }

  // ---------- その他の操作 ----------

  /// front matter の title があればツールバーとウィンドウタイトルをそれに差し替え、
  /// ファイル名は tooltip に残す。ウィンドウ切替の一覧にも同じ文字列を使う。
  private applyCaption(title: string, name: string) {
    const caption = title || name;
    this.toolbar.setCaption(caption, name);
    getCurrentWindow().setTitle(`${caption} — Inkfish`);
    // 「同じファイルは同じウィンドウ」の台帳とウィンドウ切替の一覧へ、
    // タブ 1 つぶんとして申告する
    if (this.currentPath) {
      setWindowTabs([{ path: this.currentPath, caption }], 0).catch(() => {});
    }
  }

  /// 今開いている文書をプロジェクトウィンドウのタブとして渡し、この窓を畳む。
  private async dockInto(label: string) {
    if (!this.currentPath) return;
    try {
      await adoptTab(label, this.currentPath);
      await closeSelf();
    } catch (e) {
      this.toast.show(`渡せませんでした: ${e}`);
    }
  }

  private async editCurrent() {
    if (!this.currentPath) return;
    try {
      await openInEditor(this.currentPath);
    } catch (e) {
      this.toast.show(String(e));
      // エディタが起動できないのは設定が原因なので、その場で開いて直させる
      this.popovers.open(this.settingsPopover);
    }
  }

  private async exportPdf() {
    if (!this.currentPath) {
      this.toast.show("先に Markdown ファイルを開いてください");
      return;
    }
    await exportPdf(this.viewer, this.currentPath, {
      closeFind: () => this.findBar.close(),
      notify: (msg) => this.toast.show(msg),
    });
  }

  private async handleLink(t: LinkTarget) {
    if (t.kind === "external") {
      openUrl(t.href);
      return;
    }
    // 相対リンクの md ファイルはこのビューアーで開く
    if (isMarkdownPath(t.path)) {
      this.openPath(t.path);
      return;
    }
    // md 以外のローカルファイルは OS 既定アプリで開く (毎回確認)
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
