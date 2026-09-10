import { convertFileSrc } from "@tauri-apps/api/core";
import { AppShell } from "./shell/shell";
import { assetUrl } from "./shared/rev";

// ガワ (AppShell) が中身 (DocumentViewer) を内部で生成して配線する。
// convertFileSrc は関数として渡す。ビューア自体は Tauri に依存しない。
new AppShell({ resolveAsset: (p) => assetUrl(p, convertFileSrc) }).start();
