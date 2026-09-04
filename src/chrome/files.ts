import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export const MD_EXTS = ["md", "markdown", "mdown", "mdx", "txt"];
/// このビューアーで開く拡張子 (相対リンクをたどるときの判定)
export const isMarkdownPath = (p: string) => /\.(md|markdown|mdown|mdx)$/i.test(p);

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
