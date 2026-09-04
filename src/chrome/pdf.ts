import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { basename } from "../shared/paths";
import type { DocumentViewer } from "../viewer/viewer";

/// 保存先を選ばせて、Rust 側 (各 OS のネイティブ WebView の PDF 機能) で
/// 直接 PDF を書き出す。macOS の createPDF は画面メディアで描画するため、
/// 書き出しの間だけ body.is-exporting でクロームを隠し、ビューアには
/// beginExport() で本文を全高レイアウト + 描き切りをさせる。
export async function exportPdf(
  viewer: DocumentViewer,
  currentPath: string,
  hooks: { closeFind: () => void; notify: (msg: string) => void }
) {
  const base = basename(currentPath).replace(/\.[^.]+$/, "") || "document";
  const dest = await saveDialog({
    defaultPath: `${base}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;

  hooks.closeFind();
  document.body.classList.add("is-exporting");
  await viewer.beginExport();
  try {
    await invoke("export_pdf", { dest });
    hooks.notify("PDF を書き出しました");
  } catch (e) {
    hooks.notify(`PDF の書き出しに失敗しました: ${e}`);
  } finally {
    document.body.classList.remove("is-exporting");
    await viewer.endExport();
  }
}
