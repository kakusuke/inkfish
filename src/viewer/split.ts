// 2 つの版を左右に並べて見せるための下ごしらえ。
//
// プロジェクトウィンドウのタブと、そこから切り離した単一文書ウィンドウの
// 両方が同じ形を使う。差分そのものに ID (diff:/…) を与えたので、どちらの
// ガワでも「その ID を開いているだけ」になり、置き場所が違うだけで済む。

import { invoke } from "@tauri-apps/api/core";
import type { DocumentViewer } from "./viewer";
import { dirname } from "../shared/paths";
import { readMdFile } from "../chrome/files";

/// 変わったまとまり。行番号は 0 始まりで終端を含まない (Rust 側と対)。
export type Hunk = {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
};

const gitHunks = (before: string, after: string) =>
  invoke<Hunk[]>("git_hunks", { before, after });

/// 変わった行 → その変わり方。印の色を分けるのに使う。
export type ChangeKind = "add" | "del" | "mod";

/// hunk を「変わった行」に直す。
///
/// 片側が空のまとまりは純粋な追加 / 削除で、その側には行が無いので印も付かない
/// (追加は終点側にだけ緑、削除は起点側にだけ赤が出る)。両側にあるものは変更。
function linesOf(hunks: Hunk[], side: "before" | "after"): Map<number, ChangeKind> {
  const out = new Map<number, ChangeKind>();
  for (const h of hunks) {
    const kind: ChangeKind =
      h.beforeStart === h.beforeEnd ? "add" : h.afterStart === h.afterEnd ? "del" : "mod";
    const start = side === "before" ? h.beforeStart : h.afterStart;
    const end = side === "before" ? h.beforeEnd : h.afterEnd;
    for (let i = start; i < end; i++) out.set(i, kind);
  }
  return out;
}

/// 器を左右に割る。DocumentViewer は渡された器の中に自分の DOM を組むので、
/// 側を 2 つ用意してそれぞれに載せればよい。
export function makeSides(host: HTMLElement) {
  host.classList.add("is-diff");
  const side = (which: string) => {
    const el = document.createElement("div");
    el.className = "ink-diff-side";
    el.dataset.side = which;
    host.appendChild(el);
    return el;
  };
  // 左が起点、右が終点
  return { beforeHost: side("before"), afterHost: side("after") };
}

/// 片側を読んで描く。その版に無ければ false を返し、器に断りを出す。
///
/// 追加されたファイルには起点が無く、削除されたファイルには終点が無い。
/// どちらも差分としてはふつうのことなので、失敗ではなく「無い」と示す。
export async function loadSide(
  viewer: DocumentViewer,
  id: string,
  host: HTMLElement,
  absentLabel: string,
  name: string,
  changedLines?: Map<number, ChangeKind>
): Promise<boolean> {
  let src: string;
  try {
    src = await readMdFile(id);
  } catch {
    host.dataset.absent = absentLabel;
    host.classList.add("is-absent");
    return false;
  }
  host.classList.remove("is-absent");
  await viewer.setSource(src, { baseDir: dirname(id), name, changedLines });
  viewer.scrollToTop();
  return true;
}

/// 左右をまとめて読む。行差分も取って、変わったブロックに印が出るようにする。
///
/// 差分が取れなくても中身は見せられるので、失敗したら印なしで進む。
export async function loadPair(
  before: { viewer: DocumentViewer; id: string; host: HTMLElement },
  after: { viewer: DocumentViewer; id: string; host: HTMLElement },
  name: string
): Promise<{ before: boolean; after: boolean }> {
  const hunks = await gitHunks(before.id, after.id).catch(() => [] as Hunk[]);
  const [a, b] = await Promise.all([
    loadSide(
      after.viewer,
      after.id,
      after.host,
      "変更後にはありません",
      name,
      linesOf(hunks, "after")
    ),
    loadSide(
      before.viewer,
      before.id,
      before.host,
      "変更前にはありません",
      name,
      linesOf(hunks, "before")
    ),
  ]);
  return { after: a, before: b };
}
