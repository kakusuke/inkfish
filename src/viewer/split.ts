// 2 つの版を左右に並べて見せるための下ごしらえ。
//
// プロジェクトウィンドウのタブと、そこから切り離した単一文書ウィンドウの
// 両方が同じ形を使う。差分そのものに ID (diff:/…) を与えたので、どちらの
// ガワでも「その ID を開いているだけ」になり、置き場所が違うだけで済む。

import type { DocumentViewer } from "./viewer";
import { dirname } from "../shared/paths";
import { readMdFile } from "../chrome/files";

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
  name: string
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
  await viewer.setSource(src, { baseDir: dirname(id), name });
  viewer.scrollToTop();
  return true;
}
