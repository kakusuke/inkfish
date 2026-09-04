import { invoke } from "@tauri-apps/api/core";

// プロジェクトウィンドウの入口。ルートは Rust 側が起動前に決めている。
async function boot() {
  const root = await invoke<string | null>("get_project_root");
  const el = document.querySelector<HTMLElement>(".ink-project-boot")!;
  el.textContent = root ?? "(ルートが渡されていません)";
}

void boot();
