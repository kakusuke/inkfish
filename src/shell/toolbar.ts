/// ツールバーの表示要素 (ライブカプセル・ライブドット・モードバッジ)。
/// ボタンのクリックは shell が配線する。
export class Toolbar {
  readonly capsule: HTMLElement;
  readonly fileName: HTMLElement;
  private liveDot: HTMLElement;
  private modeBadge: HTMLElement;
  private progress: HTMLElement;

  constructor(root: HTMLElement, progress: HTMLElement) {
    this.capsule = root.querySelector<HTMLElement>(".ink-capsule")!;
    this.fileName = root.querySelector<HTMLElement>(".ink-filename")!;
    this.liveDot = root.querySelector<HTMLElement>(".ink-live-dot")!;
    this.modeBadge = root.querySelector<HTMLElement>(".ink-mode-badge")!;
    this.progress = progress;
  }

  /// ファイルを開いたらカプセルを出す
  showCapsule() {
    this.capsule.classList.remove("hidden");
  }

  /// front matter の title があればそれを見出しにし、ファイル名は tooltip に残す
  setCaption(caption: string, fileName: string) {
    this.fileName.textContent = caption;
    this.fileName.title = fileName;
  }

  setMarpMode(isMarp: boolean) {
    this.modeBadge.classList.toggle("hidden", !isMarp);
  }

  setWatchState(state: "watching" | "error") {
    this.liveDot.dataset.state = state;
  }

  setProgress(ratio: number) {
    this.progress.style.setProperty("--progress", String(ratio));
  }
}
