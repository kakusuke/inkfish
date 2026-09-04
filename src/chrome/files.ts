import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/// ファイル選択ダイアログに出す拡張子。txt は「開ける」が Markdown 扱いは
/// しない (相対リンクからは開かない) ので、ここだけに入れてある。
export const MD_EXTS = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];
/// このビューアーで開く拡張子 (相対リンクをたどるとき・ツリーに出すときの判定)。
/// Rust 側の MD_EXTS と bundle の fileAssociations と揃えること。
export const isMarkdownPath = (p: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p);

export const readMdFile = (path: string) => invoke<string>("read_md_file", { path });

/// このウィンドウが開いているファイルの変更監視を張り直す。
/// 通知 (`md:changed`) は変更されたパスを添えて届く。
export const watchFiles = (paths: string[]) => invoke("watch_files", { paths });

/// このウィンドウのタブ 1 つ。caption は front matter の title かファイル名。
export type TabInfo = { path: string; caption: string };

/// 自分のタブ構成を Rust 側の台帳に丸ごと申告する。
/// 「同じファイルは同じウィンドウ」の判定とウィンドウ切替の一覧がこれを見る。
/// 追加・削除・並べ替え・選択の移動・キャプション更新はすべてこれ 1 つで済む。
export const setWindowTabs = (tabs: TabInfo[], active: number) =>
  invoke("set_window_tabs", { tabs, active });

/// ファイルを開くときのウィンドウ振り分けは Rust 側 (open_path) が決める:
/// - "focused"    … どこかの窓が開いていたので前面化した (md:activate が飛ぶ)
/// - "load-here"  … この窓で開く (プロジェクト窓ならタブとして)
/// - "new-window" … 新しい単一文書ウィンドウで開いた
///
/// path は正規化済みの絶対パス。フロントはこれを保持して md:changed の
/// ペイロードと突き合わせるので、渡した文字列ではなく返り値を使う。
export type OpenOutcome = {
  action: "focused" | "load-here" | "new-window";
  path: string;
};
export const requestOpen = (path: string) => invoke<OpenOutcome>("open_path", { path });

/// ディレクトリをプロジェクトウィンドウで開く。同じルートの窓があれば前面化する。
/// ディレクトリでなければ Rust 側が失敗を返す (ドロップの判別に使える)。
export const openDirWindow = (path: string) => invoke<string>("open_dir_window", { path });

export async function openDirDialog(): Promise<string | null> {
  const path = await openDialog({ directory: true, multiple: false });
  return typeof path === "string" ? path : null;
}

export async function openFileDialog(): Promise<string | null> {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: MD_EXTS }],
  });
  return typeof path === "string" ? path : null;
}

/// ドロップされたパスから Markdown を 1 つ選ぶ
export const pickDroppedMarkdown = (paths: string[]) =>
  paths.find((p) => MD_EXTS.includes(p.split(".").pop()?.toLowerCase() ?? ""));

/// ドロップされたものを開く。Markdown があればそれを、無ければ
/// 先頭をディレクトリとして試す (フロントからはファイルかどうか判別できない
/// ので、判定は Rust の open_dir_window に任せる)。
export async function openDropped(
  paths: string[],
  openFile: (p: string) => void,
  onError: (msg: string) => void
) {
  const md = pickDroppedMarkdown(paths);
  if (md) {
    openFile(md);
    return;
  }
  const first = paths[0];
  if (!first) return;
  try {
    await openDirWindow(first);
  } catch {
    onError("Markdown ファイルかフォルダをドロップしてください");
  }
}

// ---------- ウィンドウをまたぐタブの受け渡し ----------

/// ドラッグ中の当たり判定に使うウィンドウの矩形 (論理ピクセル)。
/// pointer イベントの screenX / screenY と同じ空間。
export type WindowRect = {
  label: string;
  kind: "file" | "project";
  x: number;
  y: number;
  w: number;
  h: number;
};

export const windowRects = () => invoke<WindowRect[]>("window_rects");

/// 点を含むウィンドウを返す。重なっているときは前面が分からないので、
/// タブを持てるプロジェクトウィンドウを優先する。
export function windowAt(rects: WindowRect[], x: number, y: number): WindowRect | null {
  const hits = rects.filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  return hits.find((r) => r.kind === "project") ?? hits[0] ?? null;
}

/// タブを窓の外へ落として単一文書ウィンドウにする (座標は離した位置)。
export const tearOutTab = (path: string, x: number, y: number) =>
  invoke("tear_out_tab", { path, x, y });

/// タブを別のウィンドウに渡す。相手が tab:adopt を受けて開く。
export const adoptTab = (label: string, path: string) =>
  invoke("adopt_tab", { label, path });

/// 自分のウィンドウを論理座標へ動かす (自前のウィンドウドラッグ用)。
export const setWindowOrigin = (x: number, y: number) =>
  invoke("set_window_origin", { x, y });

/// 受け入れ先の候補に「今カーソルが上にいる」ことを伝える (タブ列が光る)。
export const dockHover = (label: string, active: boolean) =>
  invoke("dock_hover", { label, active });

/// 自分のウィンドウを閉じる。
export const closeSelf = () => invoke("close_self");
