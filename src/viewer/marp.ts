import type { Marp } from "@marp-team/marp-core";
import type { MarpCoreBrowser } from "@marp-team/marp-core/browser";
import { FM_RE, type FrontMatter } from "./frontmatter";

// ---------- Marp ----------
// marp-core も browser() のカスタム要素登録もグローバルな作用なので、
// ハンドルはモジュールレベルで共有する。
let marp: Marp | null = null;
let marpBrowser: MarpCoreBrowser | null = null;

async function getMarp(): Promise<Marp> {
  if (!marp) {
    const { Marp: MarpCore } = await import("@marp-team/marp-core");
    // html はデフォルトの安全なタグのみ許可(スクリプト注入を防ぐ)。
    // script は innerHTML 挿入では実行されないので同梱させず、
    // 代わりに render 後に browser() を明示的に呼ぶ。
    marp = new MarpCore({ inlineSVG: true, script: false });
  }
  return marp;
}

export function isMarpDocument(fm: FrontMatter, src: string): boolean {
  if (fm.data) return fm.data.marp === true;
  // YAML として読めなかったときは行単位の判定に落として、Marp 側の
  // ゆるいパーサに任せる (Marp は壊れた YAML でも描けることがある)
  const m = FM_RE.exec(src);
  return !!m && /^\s*marp\s*:\s*true\s*$/m.test(m[1]);
}

/// スライドを描いて container に入れる。図の器への差し替えより後に
/// browser() を呼ぶと auto-scaling が図を測ろうとするので、順番は
/// 呼び出し側 (viewer) が握る。ここでは render までを担う。
export async function renderMarp(container: HTMLElement, src: string) {
  const core = await getMarp();
  const { html, css } = core.render(src);
  container.innerHTML = `<style>${css}</style><div class="deck">${html}</div>`;
}

/// Marp のカスタム要素 (auto-scaling) 登録と、WebKit の
/// foreignObject スケーリング不具合へのポリフィルを適用する。
/// これがないと WKWebView ではスライド内容が原寸のままずれて描画される。
export async function applyMarpBrowser(container: HTMLElement) {
  const { browser } = await import("@marp-team/marp-core/browser");
  marpBrowser = marpBrowser ? marpBrowser.update() : browser(container);
}

/// WKWebView は viewBox だけだと高さを正しく取れないことがあるため、
/// 各スライドの実寸比を viewBox から aspect-ratio として明示する。
export function fixSlideAspectRatio(container: HTMLElement) {
  for (const svg of Array.from(container.querySelectorAll<SVGSVGElement>("svg[data-marpit-svg]"))) {
    const vb = svg.viewBox.baseVal;
    if (vb.width && vb.height) svg.style.aspectRatio = `${vb.width} / ${vb.height}`;
  }
}
