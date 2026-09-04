import { basename, dirname } from "../shared/paths";
import { DocumentViewer, type LinkTarget } from "../viewer/viewer";
import { readMdFile } from "../chrome/files";
import type { FindState } from "../viewer/find";

let SEQ = 0;

export type TabHooks = {
  resolveAsset: (absPath: string) => string;
  /// キャプションが決まった (front matter の title かファイル名)
  onCaption: (tab: DocTab) => void;
  onNotice: (message: string) => void;
  onProgress: (tab: DocTab, ratio: number) => void;
  onFindUpdate: (tab: DocTab, state: FindState) => void;
  onLinkActivate: (target: LinkTarget) => void;
};

/// プロジェクトウィンドウのタブ 1 つ。文書とその中身 (DocumentViewer) を持つ。
///
/// 単一文書ウィンドウでは AppShell が持っていた「開いているパス・読み込んだ
/// ソースの控え・再読込のタイマー」を、タブごとに持つ形にしたもの。
export class DocTab {
  readonly id: string;
  readonly pane: HTMLElement;
  readonly viewer: DocumentViewer;

  name: string;
  /// front matter の title があればそれ、なければファイル名
  caption: string;
  /// 読み込んだソースの控え。監視は親ディレクトリ単位なので中身が変わって
  /// いない通知も届く。無駄な再描画を避けるために突き合わせる。
  private source = "";
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly path: string,
    panes: HTMLElement,
    hooks: TabHooks
  ) {
    this.id = `t${++SEQ}`;
    this.name = basename(path) || path;
    this.caption = this.name;

    this.pane = document.createElement("div");
    // display:none ではなく visibility で隠す (project.css の注記参照)。
    // レイアウトを残さないと図とスライドの採寸が壊れる。
    this.pane.className = "ink-tabpane is-inactive";
    this.pane.dataset.tab = this.id;
    panes.appendChild(this.pane);

    this.viewer = new DocumentViewer(this.pane, {
      resolveAsset: hooks.resolveAsset,
      // 見出しと脚注の id はタブごとの名前空間に分ける。ひとつの document に
      // 複数の文書が載るため、前置きしないと id が衝突する。
      idPrefix: `${this.id}-`,
      onCaption: ({ title, name }) => {
        this.caption = title || name;
        hooks.onCaption(this);
      },
      onNotice: (m) => hooks.onNotice(m),
      onProgress: (r) => hooks.onProgress(this, r),
      onFindUpdate: (s) => hooks.onFindUpdate(this, s),
      onLinkActivate: (t) => hooks.onLinkActivate(t),
    });
    // 表に出るまで再描画を溜める
    void this.viewer.setFrozen(true);
  }

  get isMarp() {
    return this.viewer.isMarp;
  }

  /// 読み込んで描く。失敗したら理由を投げる (呼び出し側がタブを捨てる)。
  async load() {
    this.source = await readMdFile(this.path);
    await this.viewer.setSource(this.source, {
      baseDir: dirname(this.path),
      name: this.name,
    });
    this.viewer.scrollToTop();
  }

  /// ファイルが変わったときの再読込。連続した通知はまとめる。
  scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 60);
  }

  private async reload(retry = true) {
    try {
      const src = await readMdFile(this.path);
      // atomic save の途中で空ファイルを読むことがあるため一度だけリトライ
      if (src === "" && this.source !== "" && retry) {
        setTimeout(() => void this.reload(false), 150);
        return;
      }
      if (src === this.source) return;
      this.source = src;
      await this.viewer.setSource(src, {
        baseDir: dirname(this.path),
        name: this.name,
      });
    } catch {
      if (retry) setTimeout(() => void this.reload(false), 150);
    }
  }

  setActive(active: boolean) {
    this.pane.classList.toggle("is-inactive", !active);
    // 隠れている間の再描画は溜めておく (テーマ切替でタブの数だけ走らせない)
    void this.viewer.setFrozen(!active);
    if (active) this.viewer.focus();
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    this.viewer.dispose();
    this.pane.remove();
  }
}
