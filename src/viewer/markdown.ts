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
    const mark = kind ? ` ink-changed" data-change="${kind}` : "";
    return `<div class="mermaid-block${mark}">${md.utils.escapeHtml(token.content)}</div>`;
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
  const lines = (state.env as { changedLines?: Map<number, string> } | undefined)?.changedLines;
  if (!lines?.size) return;
  for (const token of state.tokens) {
    if (token.level !== 0 || !token.map) continue;
    let kind: string | undefined;
    for (let i = token.map[0]; i < token.map[1]; i++) {
      const k = lines.get(i);
      if (!k) continue;
      // 追加と削除が混ざるまとまりは「変更」として扱う
      kind = kind && kind !== k ? "mod" : k;
    }
    if (!kind) continue;
    token.attrJoin("class", "ink-changed");
    token.attrSet("data-change", kind);
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
