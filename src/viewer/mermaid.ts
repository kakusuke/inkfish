import type { Mermaid } from "mermaid";

// ---------- Mermaid ----------
// mermaid はライブラリ自体がシングルトン(グローバルな設定と連番 id を持つ)なので、
// ハンドルと適用済み設定はモジュールレベルで共有する。
//
// 将来ひとつの document に DocumentViewer を 2 つ以上並べるなら、ここが最初に
// 問題になる。deterministicIds の連番はライブラリ全体で 1 本なので、同時に描く
// 2 つのビューアが同じ id を持ち、mermaid が id セレクタで掴む描画先を取り違える。
// そのときは図ごとに id を前置きする形へ変える必要がある。
let mermaid: Mermaid | null = null;

/// 図の見せ方を決める文脈。ビューアのインスタンスが渡す。
export type MermaidContext = {
  /// PDF 書き出し中か。書き出し中はライト色に寄せる。
  exporting: boolean;
  /// Marp スライドとして描いているか。
  marp: boolean;
};

// 図のテーマ。ダークにするのは画面で本文を読んでいるときだけ。
// 書き出し中はトークンをライトへ固定するし、Marp スライドは
// テーマ側の地色 (既定は白) の上に載るので、いずれも明色側へ揃える。
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const themeFor = (ctx: MermaidContext) =>
  !ctx.exporting && !ctx.marp && isDark() ? "dark" : "neutral";

// ラベルを HTML (foreignObject) で描くか、SVG のテキストで描くか。
// Marp スライドは全体が縮小スケールされた中に載るが、WebKit は
// foreignObject の中身をそのスケールに追従させずに描く一方、クリップだけは
// スケール後の矩形で行うため、ラベルの後ろが切れる (「front matter」が
// 「front mat」になる)。スライドでは SVG のテキストに切り替えて回避する。
// 本文では等倍なので症状が出ず、HTML ラベル (装飾やリンク) の利点を残す。
const htmlLabelsFor = (ctx: MermaidContext) => !ctx.marp;

// 直近 initialize() に渡した設定。描き直しが要るかの判定に使う。
const configKey = (ctx: MermaidContext) => `${themeFor(ctx)}|${htmlLabelsFor(ctx)}`;
let appliedConfig: string | null = null;

function initialize(ctx: MermaidContext) {
  if (!mermaid) return;
  appliedConfig = configKey(ctx);
  const htmlLabels = htmlLabelsFor(ctx);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "antiscript",
    theme: themeFor(ctx),
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
    // 既定の id は Date.now() 由来なので、同一ミリ秒に描画開始した図が
    // 同じ id を持ってしまう。mermaid は内部で id セレクタを使って描画先を
    // 探すため、衝突すると片方が空の SVG になる。連番 id にして防ぐ。
    deterministicIds: true,
    // 図ごとに別のキーを見るため、全体・フローチャート・クラス図の
    // それぞれに渡す (フローチャートはエッジのラベルもこの設定に従う)。
    htmlLabels,
    flowchart: { htmlLabels },
    class: { htmlLabels },
  });
}

async function getMermaid(ctx: MermaidContext): Promise<Mermaid> {
  if (!mermaid) {
    const m = (await import("mermaid")).default;
    // ELK レイアウト (`layout: elk` 系) を登録する。ここで読み込むのは
    // ローダー定義だけなので、実際に elk を指定した図が現れるまで
    // 本体 (elkjs) はダウンロード / 評価されない。
    m.registerLayoutLoaders((await import("@mermaid-js/layout-elk")).default);
    // 設定を当て終えるまで mermaid には代入しない。途中で失敗したときに
    // 「初期化されていないインスタンス」がキャッシュされると、以降ずっと
    // 既定テーマ・既定 id 生成のまま気づかず動いてしまう。
    mermaid = m;
    initialize(ctx);
  }
  return mermaid;
}

/// 図の設定が今の文脈 (ダーク / 書き出し中 / Marp) と食い違っているか。
/// 書き出し後の描き直しが要るかの判定に使う。
export const needsRedraw = (ctx: MermaidContext) =>
  mermaid !== null && appliedConfig !== configKey(ctx);

/// ブロック内の図を描き、クリックで拡大表示できるようにする。
/// stale() は「自分より新しい描画が始まったか」。切り離された DOM へ描いて
/// 出る失敗を本物のエラーと取り違えないよう、要所で確認する。
export async function runMermaid(
  blocks: HTMLElement[],
  ctx: MermaidContext,
  stale: () => boolean,
  onZoom: (svg: SVGSVGElement) => void,
  onError: (msg: string) => void
) {
  try {
    const m = await getMermaid(ctx);
    if (stale()) return;
    // initialize() は次の run() から効くので、描画の直前に当て直す。
    if (needsRedraw(ctx)) initialize(ctx);
    await m.run({ nodes: blocks });
  } catch (e) {
    if (stale()) return;
    // 構文エラーのブロックは mermaid がエラー表示に差し替えたうえで
    // 最初のエラーを投げ直してくるので、ここへ来ること自体は珍しくない。
    // 差し替えすら行われず SVG が入らなかったブロックはソースが生のまま
    // 残り、黙っていると原因がまったく追えないのでそのときだけ知らせる。
    console.error("Mermaid の描画に失敗しました", e);
    const unrendered = blocks.filter((b) => !b.querySelector("svg")).length;
    if (unrendered) onError(`Mermaid を描画できませんでした (${unrendered} 件)`);
  }
  if (stale()) return;
  for (const block of blocks) {
    const svg = block.querySelector<SVGSVGElement>("svg");
    // 構文エラーの差し替え表示 (.error-icon を含む) は拡大対象外
    if (!svg || svg.querySelector(".error-icon")) continue;
    block.addEventListener("click", () => onZoom(svg));
  }
}

/// Marp が出力したコードブロックのうち mermaid のものを図の器へ差し替える。
/// Marp の markdown-it はこちらの fence ルールを通らないため、描画済みの
/// HTML から拾い直す。`<pre is="marp-pre">` ごと外すのは、そのままだと
/// Marp の auto-scaling が図を包んで測ろうとしてしまうため。
export function extractMermaidBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (const code of Array.from(root.querySelectorAll("code.language-mermaid"))) {
    const block = document.createElement("div");
    block.className = "mermaid-block";
    // textContent なので Marp のハイライト用タグは落ち、実体参照も戻る
    block.textContent = code.textContent ?? "";
    (code.closest("pre") ?? code).replaceWith(block);
    blocks.push(block);
  }
  return blocks;
}
