import { invoke } from "@tauri-apps/api/core";

// ---------- 外部エディタの設定 ----------
const DEFAULT_EDITOR_CMD = "open -t {path}";
export const editorCmd = () => localStorage.getItem("editorCmd") || DEFAULT_EDITOR_CMD;

export async function openInEditor(path: string) {
  await invoke("open_in_editor", { path, command: editorCmd() });
}

/// 設定ポップオーバーの中身を配線する。開閉は PopoverGroup が持つ。
export function wireSettings(
  input: HTMLInputElement,
  saveBtn: HTMLElement,
  onSaved: (msg: string) => void,
  close: () => void
) {
  saveBtn.addEventListener("click", () => {
    localStorage.setItem("editorCmd", input.value.trim());
    close();
    onSaved("エディタ設定を保存しました");
  });
}

/// ポップオーバーを開くたびに現在値を入れ直す
export function fillSettings(input: HTMLInputElement) {
  input.value = editorCmd();
  input.focus();
}
