import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";
import hljs from "highlight.js/lib/common";

// ---------- Markdown (GFM) ----------
// markdown-it は状態を持たないレンダラなので、インスタンスはモジュールで共有する。
export const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        /* fall through */
      }
    }
    return "";
  },
})
  .use(anchor, { tabIndex: false })
  .use(taskLists, { label: true })
  .use(footnote);

// 生テキストの `hoge.md` などが ccTLD 衝突で http:// を補完されるのを防ぐ。
// スキームなしはローカルファイルアクセスとして扱いたいため、裸テキストの
// 自動リンク化(fuzzyLink)は無効化する(https:// 等の明示 URL は従来どおり)。
md.linkify.set({ fuzzyLink: false });

// ```mermaid ブロックはハイライトせず mermaid 用のコンテナにする
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0];
  if (lang === "mermaid") {
    // 差分の目印はブロックの器に付ける (既定の fence は <code> に出してしまう)
    const at = token.attrGet("data-at");
    const kind = token.attrGet("data-kind") ?? "mod";
    const mark = at ? `" data-at="${at}" data-kind="${kind}` : "";
    return `<div class="mermaid-block${mark}">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// 差分の位置を、レンダリング後に測れる形で本文に埋め込む。
//
// 差分は行で取れるが、見せるのはレンダリングした後の画面なので、その 2 つを
// 結ぶ物差しが要る。以前はブロックの行範囲 (token.map) と重ねて「このブロックが
// 変わった」と印を付けていたが、それだと片側にしか無い差分 (追加・削除) の
// 行き先を行番号から推し量ることになり、画像や表のように行数と高さが対応
// しないブロックで位置が破綻していた。
//
// そこで、変わった行そのものに幅ゼロの目印を挿す。折り返しがあっても目印は
// 文字に付いていくので、位置は実測できる。差分と DOM 要素を結びつけるのは
// やめて、DOM は「行がどこに描かれたか」を答えるだけの役に徹する。
//
//   <span class="ink-at ink-at-head" data-at="3" data-kind="mod" data-line="12">
//   <span class="ink-at ink-at-tail" …>
//     … 変わった行の頭と尻。頭は行の上端、尻は行の下端に揃うので、
//       2 つ合わせるとその行が画面で占める高さになる
//   <span class="ink-at ink-at-gap" … data-point="1">
//     … 相手側だけが増えた位置。高さを持たない点として、境目に刺さる
//
// コードブロックのように行の中へ目印を置けないものは、ブロック自身に同じ
// 属性を持たせて目印を兼ねさせる。
type At = { kind: string; hunk: number };

/// 中に inline を持たないブロック。行の間に目印を挿せない
const OPAQUE = new Set(["fence", "code_block", "hr", "html_block"]);

md.core.ruler.push("ink-changed", (state) => {
  const env = state.env as
    | {
        changedLines?: Map<number, At>;
        insertedAt?: Map<number, At>;
        lineOffset?: number;
      }
    | undefined;
  const lines = env?.changedLines;
  const inserts = env?.insertedAt;
  if (!lines?.size && !inserts?.size) return;
  // 目印に書く行番号は元テキストのものに戻す (front matter を剥がしたぶん)
  const offset = env?.lineOffset ?? 0;

  // head は行の上端、tail は行の下端に揃う (viewer.css)。両方あれば、その行が
  // 画面で占める高さがそのまま出る — 画像や大きな文字が混ざっていても合う。
  const span = (at: At, line: number, where: "head" | "tail" | "gap", point = false) =>
    `<span class="ink-at ink-at-${where}" data-at="${at.hunk}" data-kind="${at.kind}"` +
    ` data-line="${line + offset}"${point ? ' data-point="1"' : ""}></span>`;

  const inlineMark = (at: At, line: number, where: "head" | "tail", point = false) => {
    const t = new state.Token("html_inline", "", 0);
    t.content = span(at, line, where, point);
    return t;
  };

  // 行の中に置けないところ (コードブロックの手前、文書の終わり) 用。
  // 行を作ってしまわないよう、CSS で流れから外す
  const blockMark = (at: At, line: number) => {
    const t = new state.Token("html_block", "", 0);
    t.content = `${span(at, line, "gap", true)}\n`;
    return t;
  };

  // 相手側だけが増えた位置は、行が無いので目印を置く先も無い。文書の順に
  // 見ていって、その位置を追い越す直前に置く — つまりブロックの境目に落ちる。
  const pending = Array.from(inserts ?? []).sort((a, b) => a[0] - b[0]);
  let pi = 0;

  // 表のセルの inline は行範囲を持たない (markdown-it は tr にだけ付ける)。
  // 直近に見た行範囲で代わりにする — 表の 1 行は原文の 1 行なので、これで合う。
  let near: [number, number] | null = null;

  /// コードブロックは中の行が画面の行と 1:1 なので、行の高さから位置を出せる。
  /// mermaid は図になってしまうので、ふつうのブロックと同じ扱いにする。
  const isCode = (token: { type: string; info?: string }) =>
    token.type === "code_block" ||
    (token.type === "fence" && token.info?.trim().split(/\s+/)[0] !== "mermaid");

  const out: (typeof state.tokens)[number][] = [];
  for (const token of state.tokens) {
    if (token.map) near = token.map;
    // 相手側だけが増えた位置のうち、このブロックの中に入るもの。
    // コードブロックでは何行目かを添えて持たせる (手前に出すと、下のほうに
    // 足された行でもブロックの頭を指してしまう)。
    const inserts: string[] = [];

    // 中に目印を置けるブロック (段落・リスト・表・引用) は、行の頭に挿す
    // inline の目印に任せる。ブロックの手前に独立して置くと、流れから外して
    // ある関係で位置が思ったところに出ない。ここで片づけるのは、中に置けない
    // ブロックだけ。
    if (token.level === 0 && token.map && OPAQUE.has(token.type)) {
      const code = isCode(token);
      const head = token.map[0] + (token.type === "fence" ? 1 : 0);
      while (pi < pending.length && pending[pi][0] < token.map[1]) {
        const [line, at] = pending[pi];
        // コードブロックの中は何行目かで指せる。それ以外は手前に置くしかない
        if (code && line > token.map[0]) {
          inserts.push(`${at.hunk}:${Math.max(0, line - head)}:${at.kind}`);
        } else {
          out.push(blockMark(at, line));
        }
        pi++;
      }
    }

    const at = token.type === "inline" ? (token.map ?? near) : null;
    if (at) {
      const kids = token.children ?? [];
      const marked: typeof kids = [];
      let line = at[0];
      const open = () => {
        while (pi < pending.length && pending[pi][0] <= line) {
          marked.push(inlineMark(pending[pi][1], pending[pi][0], "head", true));
          pi++;
        }
        const here = lines?.get(line);
        if (here) marked.push(inlineMark(here, line, "head"));
      };
      const close = () => {
        const here = lines?.get(line);
        if (here) marked.push(inlineMark(here, line, "tail"));
      };
      open();
      for (const kid of kids) {
        if (kid.type === "softbreak" || kid.type === "hardbreak") {
          close();
          marked.push(kid);
          line++;
          open();
          continue;
        }
        marked.push(kid);
      }
      close();
      token.children = marked;
    } else if (OPAQUE.has(token.type) && token.map) {
      // 中に目印を置けないので、ブロック自身が兼ねる。コードブロックだけは
      // 原文の 1 行が画面の 1 行にそのまま出るので、何行目かも添えておく
      // (行の高さが一定なので、それだけで位置を出せる)。
      const code = isCode(token);
      const head = token.map[0] + (token.type === "fence" ? 1 : 0);
      const rows = new Map<number, { from: number; to: number }>();
      let kind: string | undefined;
      for (let i = token.map[0]; i < token.map[1]; i++) {
        const at = lines?.get(i);
        if (!at) continue;
        kind = kind && kind !== at.kind ? "mod" : at.kind;
        const row = Math.max(0, i - head);
        const cur = rows.get(at.hunk);
        if (cur) {
          cur.from = Math.min(cur.from, row);
          cur.to = Math.max(cur.to, row + 1);
        } else {
          rows.set(at.hunk, { from: row, to: row + 1 });
        }
      }
      if (rows.size) {
        token.attrSet("data-at", [...rows.keys()].join(","));
        token.attrSet("data-kind", kind ?? "mod");
        if (code) {
          const spans = [...rows.values()].map((r) => `${r.from}-${r.to}`);
          token.attrSet("data-rows", spans.join(","));
        }
      }
    }

    if (inserts.length) token.attrSet("data-ins", inserts.join(","));

    out.push(token);
  }
  while (pi < pending.length) {
    out.push(blockMark(pending[pi][1], pending[pi][0]));
    pi++;
  }
  state.tokens = out;
});

export const escapeHtml = (s: string) => md.utils.escapeHtml(s);

// コードブロックをラッパーで包み、言語ラベルとコピーボタンを付ける。
// サニタイズ後に自前で生成する要素なので innerHTML 由来の危険はない。
export function enhanceCodeBlocks(root: HTMLElement, onError: (msg: string) => void) {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = Array.from(code?.classList ?? [])
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);

    const wrap = document.createElement("div");
    wrap.className = "code-block";
    if (lang) wrap.dataset.lang = lang;
    // 差分の目印は <code> に付いてくる (markdown-it の fence が属性をそこへ出す)。
    // 位置はいちばん外の器で測りたいので、そちらへ移す。
    for (const name of ["data-at", "data-kind", "data-rows", "data-ins"]) {
      const value = code?.getAttribute(name);
      if (value === null || value === undefined) continue;
      wrap.setAttribute(name, value);
      code!.removeAttribute(name);
    }
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    // 行の位置は中に挿した目印で測る。挿せたら器の印は要らない
    markCodeLines(wrap);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.title = "コードをコピー";
    btn.textContent = "コピー";
    btn.addEventListener("click", async () => {
      try {
        await copyText(code?.innerText ?? pre.innerText);
        btn.textContent = "コピーしました";
        btn.classList.add("done");
        setTimeout(() => {
          btn.textContent = "コピー";
          btn.classList.remove("done");
        }, 1400);
      } catch {
        onError("コピーできませんでした");
      }
    });
    wrap.appendChild(btn);
  }
}

/// コードブロックの中に、行の位置を測るための目印を挿す。
///
/// ハイライト済みの HTML は行をまたぐタグを持つので、markdown-it の段階では
/// 行の境目に入れられない。描いたあとの DOM なら、テキストノードを改行で
/// 割って間に挿むだけでよい。こうすると他のブロックと同じく実測になり、
/// 行の高さを見積もる必要がなくなる。
///
/// 何行目が変わったかは data-rows (hunk と同じ並び)、相手側だけが増えた位置は
/// data-ins が持っている (markdown.ts の core ruler が付ける)。
function markCodeLines(wrap: HTMLElement): boolean {
  const code = wrap.querySelector("code");
  if (!code) return false;

  const hunks = (wrap.dataset.at ?? "").split(",").filter(Boolean);
  const spans = (wrap.dataset.rows ?? "").split(",").filter(Boolean);
  const inserts = (wrap.dataset.ins ?? "").split(",").filter(Boolean);
  if (!spans.length && !inserts.length) return false;
  const kind = wrap.dataset.kind ?? "mod";

  type Mark = { where: "head" | "tail"; hunk: string; kind: string; point: boolean };
  const plan = new Map<number, Mark[]>();
  const add = (row: number, mark: Mark) => {
    const list = plan.get(row);
    if (list) list.push(mark);
    else plan.set(row, [mark]);
  };
  spans.forEach((span, i) => {
    const [from, to] = span.split("-").map(Number);
    const hunk = hunks[i] ?? "0";
    for (let row = from; row < to; row++) {
      add(row, { where: "head", hunk, kind, point: false });
      add(row, { where: "tail", hunk, kind, point: false });
    }
  });
  for (const part of inserts) {
    const [hunk, row, k] = part.split(":");
    add(Number(row), { where: "head", hunk, kind: k || "mod", point: true });
  }

  const el = (mark: Mark) => {
    const span = document.createElement("span");
    span.className = `ink-at ink-at-${mark.where}`;
    span.dataset.at = mark.hunk;
    span.dataset.kind = mark.kind;
    if (mark.point) span.dataset.point = "1";
    return span;
  };
  const marksAt = (row: number, where: "head" | "tail") =>
    (plan.get(row) ?? []).filter((m) => m.where === where).map(el);

  // 改行の位置をすべて拾う。i 番目が「行 i の終わり」になる
  const texts: Text[] = [];
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    texts.push(node as Text);
  }
  const breaks: { node: Text; offset: number }[] = [];
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    for (let i = value.indexOf("\n"); i >= 0; i = value.indexOf("\n", i + 1)) {
      breaks.push({ node, offset: i });
    }
  }

  // 後ろから挿す。前を先に割ると、後ろの位置がずれる
  for (let row = breaks.length - 1; row >= 0; row--) {
    const { node, offset } = breaks[row];
    const parent = node.parentNode;
    if (!parent) continue;
    const nl = node.splitText(offset);
    const rest = nl.splitText(1);
    for (const mark of marksAt(row + 1, "head")) parent.insertBefore(mark, rest);
    for (const mark of marksAt(row, "tail")) parent.insertBefore(mark, nl);
  }
  for (const mark of marksAt(0, "head")) code.insertBefore(mark, code.firstChild);

  for (const name of ["at", "kind", "rows", "ins"]) delete wrap.dataset[name];
  return true;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WKWebView で Async Clipboard API が使えない場合のフォールバック
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }
}
