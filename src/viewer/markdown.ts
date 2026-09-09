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
    // 差分の印はブロックの器に付ける (既定の fence は <code> に出してしまう)
    const kind = token.attrGet("data-change");
    const hunk = token.attrGet("data-hunk") ?? "0";
    const line = token.attrGet("data-line");
    const mark = kind ? ` ink-changed" data-change="${kind}" data-hunk="${hunk}` : "";
    const at = line ? `" data-line="${line}` : "";
    return `<div class="mermaid-block${mark}${at}">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// 差分で変わった行を含むブロックに印を付ける。
//
// markdown-it のトークンは元テキストの行範囲 (token.map) を持っているので、
// 変わった行の集合と重ねるだけでよい。レンダリング自体には手を触れないので、
// 図もスライドも表も、ふつうに描いたものがそのまま印つきになる。
// 入れ子の内側にも付くと縦線が二重に出るので、いちばん外の段だけを見る。
md.core.ruler.push("ink-changed", (state) => {
  type At = { kind: string; hunk: number };
  const env = state.env as
    | { changedLines?: Map<number, At>; lineOffset?: number }
    | undefined;
  const lines = env?.changedLines;
  if (!lines?.size) return;

  // 左右の位置を合わせるのに、ブロックが元テキストの何行目から始まるかも要る
  // (行と画面上の位置を突き合わせる: viewer/split.ts)
  const offset = env?.lineOffset ?? 0;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map) {
      token.attrSet("data-line", String(token.map[0] + offset));
    }
  }

  for (const token of state.tokens) {
    if (token.level !== 0 || !token.map) continue;
    let kind: string | undefined;
    let hunk: number | undefined;
    for (let i = token.map[0]; i < token.map[1]; i++) {
      const at = lines.get(i);
      if (!at) continue;
      // 追加と削除が混ざるまとまりは「変更」として扱う
      kind = kind && kind !== at.kind ? "mod" : at.kind;
      // 番号は最初のものを持つ (左右を突き合わせて位置を揃えるのに使う)
      hunk ??= at.hunk;
    }
    if (!kind) continue;
    token.attrJoin("class", "ink-changed");
    token.attrSet("data-change", kind);
    token.attrSet("data-hunk", String(hunk ?? 0));
  }
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
    // 行の目印も器へ移す (pre の中に埋もれると位置合わせで拾えない)
    const line = code?.getAttribute("data-line");
    if (line) {
      wrap.dataset.line = line;
      code!.removeAttribute("data-line");
    }
    // 差分の印は <code> に付いてくる (markdown-it の fence が属性をそこへ出す)。
    // 線は他のブロックと同じ左端に出したいので、いちばん外の器へ移す。
    if (code?.classList.contains("ink-changed")) {
      code.classList.remove("ink-changed");
      wrap.classList.add("ink-changed");
      const kind = code.getAttribute("data-change");
      if (kind) {
        wrap.dataset.change = kind;
        code.removeAttribute("data-change");
      }
      const hunk = code.getAttribute("data-hunk");
      if (hunk) {
        wrap.dataset.hunk = hunk;
        code.removeAttribute("data-hunk");
      }
    }
    pre.replaceWith(wrap);
    wrap.appendChild(pre);

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
