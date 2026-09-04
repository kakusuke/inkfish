import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath as openExternal } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { basename, dirname } from "../shared/paths";
import { DocumentViewer, type LinkTarget } from "../viewer/viewer";
import { Toolbar } from "./toolbar";
import { Toast, wireLinkStatus } from "./toast";
import { PopoverGroup } from "./popover";
import { FindBar } from "./findbar";
import { fillSettings, openInEditor, wireSettings } from "./settings";
import { pushRecent, renderRecents } from "./recents";
import { exportPdf } from "./pdf";
import { WindowMenu } from "./windowmenu";
import {
  isMarkdownPath,
  openFileDialog,
  pickDroppedMarkdown,
  readMdFile,
  registerShownFile,
  requestOpen,
  setWindowCaption,
  watchFile,
} from "./files";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

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

    $('[data-act="open"]').addEventListener("click", () => this.pickFile());
    $('[data-act="empty-open"]').addEventListener("click", () => this.pickFile());
    $('[data-act="edit"]').addEventListener("click", () => this.editCurrent());
  }

  private wireBackend() {
    // これらの Rust 側イベントは emit_to(label, …) で特定ウィンドウ宛に発行される。
    // グローバルの listen() は EventTarget::Any として登録されターゲット指定を無視し
    // 全ウィンドウで受信してしまうため、必ず現在の Webview にスコープして受け取る。
    // (そうしないと複数ウィンドウ時に全ウィンドウが PDF 書き出しや再読込を実行する)
    const webview = getCurrentWebview();

    webview.listen("md:changed", () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 60);
    });

    // Finder の「このアプリケーションで開く」など、起動後に届いたオープン要求
    webview.listen<string>("md:open", (ev) => {
      if (ev.payload && ev.payload !== this.currentPath) this.loadFile(ev.payload);
    });

    // ネイティブメニュー (ファイル) からの操作
    webview.listen("menu:open", () => this.pickFile());
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
      const p = pickDroppedMarkdown(ev.payload.paths);
      if (p) this.openPath(p);
      else this.toast.show("Markdown ファイルをドロップしてください");
    });
  }

  // ---------- ファイル ----------

  private async pickFile() {
    const path = await openFileDialog();
    if (path) this.openPath(path);
  }

  /// ファイルを開く。ウィンドウの振り分けは Rust 側が決める。
  private async openPath(path: string) {
    try {
      const outcome = await requestOpen(path);
      if (outcome === "load-here") await this.loadFile(path);
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
    $('[data-act="edit"]').classList.remove("hidden");
    pushRecent(path, this.currentName);
    // 「同じファイルは同じウィンドウ」の台帳に自分を登録する
    registerShownFile(path).catch(() => {});

    await this.viewer.setSource(source, {
      baseDir: dirname(path),
      name: this.currentName,
    });
    this.toolbar.setMarpMode(this.viewer.isMarp);
    this.viewer.scrollToTop();

    try {
      await watchFile(path);
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
    // ウィンドウ切替の一覧が同じ文字列を出せるように登録する
    setWindowCaption(caption).catch(() => {});
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
