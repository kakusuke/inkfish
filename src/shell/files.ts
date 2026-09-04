import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export const MD_EXTS = ["md", "markdown", "mdown", "mdx", "txt"];
/// このビューアーで開く拡張子 (相対リンクをたどるときの判定)
export const isMarkdownPath = (p: string) => /\.(md|markdown|mdown|mdx)$/i.test(p);

export const readMdFile = (path: string) => invoke<string>("read_md_file", { path });
export const watchFile = (path: string) => invoke("watch_file", { path });
export const registerShownFile = (path: string) => invoke("register_shown_file", { path });

/// ファイルを開くときのウィンドウ振り分けは Rust 側 (open_path) が決める:
/// 既に表示中のウィンドウがあれば前面化、この窓が空ならここで表示、
/// それ以外は新しいウィンドウで開く。
export const requestOpen = (path: string) => invoke<string>("open_path", { path });

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
