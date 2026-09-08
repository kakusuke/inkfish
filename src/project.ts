import { convertFileSrc } from "@tauri-apps/api/core";
import { ProjectShell } from "./project/project";
import { assetUrl } from "./shared/rev";

// ガワ (ProjectShell) が中身 (DocumentViewer) をタブごとに生成して配線する。
// ビューア自体は Tauri に依存しないので、convertFileSrc は関数として渡す。
new ProjectShell({ resolveAsset: (p) => assetUrl(p, convertFileSrc) }).start();
