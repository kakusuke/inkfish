import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath as openExternal } from "@tauri-apps/plugin-opener";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import type { Marp } from "@marp-team/marp-core";
import type { MarpCoreBrowser } from "@marp-team/marp-core/browser";
import type { Mermaid } from "mermaid";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $<HTMLElement>("viewport");
const docEl = $<HTMLElement>("doc");
const slidesEl = $<HTMLElement>("slides");
const emptyEl = $<HTMLElement>("empty");
const capsule = $<HTMLElement>("capsule");
const fileNameEl = $<HTMLElement>("file-name");
const liveDot = $<HTMLElement>("live-dot");
const modeBadge = $<HTMLElement>("mode-badge");
const btnEdit = $<HTMLButtonElement>("btn-edit");
const settingsPop = $<HTMLElement>("settings-pop");
const editorCmdInput = $<HTMLInputElement>("editor-cmd");
const toast = $<HTMLElement>("toast");
const linkStatus = $<HTMLElement>("link-status");
const findBar = $<HTMLElement>("find-bar");
const findInput = $<HTMLInputElement>("find-input");
const findCount = $<HTMLElement>("find-count");
const lightbox = $<HTMLElement>("mermaid-lightbox");
const mlbStage = $<HTMLElement>("mlb-stage");
const mlbContent = $<HTMLElement>("mlb-content");
const mlbLevel = $<HTMLElement>("mlb-level");

// ---------- 状態 ----------
let currentPath: string | null = null;
let currentSource = "";
let fontScale = 1;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

// ---------- Markdown (GFM) ----------
const md: MarkdownIt = new MarkdownIt({
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
    return `<div class="mermaid-block">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// mermaid / marp-core は重いので必要になるまでロードしない
let mermaid: Mermaid | null = null;
async function getMermaid(): Promise<Mermaid> {
  if (!mermaid) {
    mermaid = (await import("mermaid")).default;
    initMermaid();
  }
  return mermaid;
}

function initMermaid() {
  mermaid?.initialize({
    startOnLoad: false,
    securityLevel: "antiscript",
    theme: isDark() ? "dark" : "neutral",
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
  });
}

// ---------- Marp ----------
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

function isMarpDocument(src: string): boolean {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!fm && /^\s*marp\s*:\s*true\s*$/m.test(fm[1]);
}

// ---------- レンダリング ----------
async function render() {
  const scrollTop = viewport.scrollTop;
  const marpMode = isMarpDocument(currentSource);

  emptyEl.classList.add("hidden");
  modeBadge.classList.toggle("hidden", !marpMode);
  docEl.classList.toggle("hidden", marpMode);
  slidesEl.classList.toggle("hidden", !marpMode);

  if (marpMode) {
    const { html, css } = (await getMarp()).render(currentSource);
    slidesEl.innerHTML = `<style>${css}</style><div class="deck">${html}</div>`;
    // Marp のカスタム要素 (auto-scaling) 登録と、WebKit の
    // foreignObject スケーリング不具合へのポリフィルを適用する。
    // これがないと WKWebView ではスライド内容が原寸のままずれて描画される。
    const { browser } = await import("@marp-team/marp-core/browser");
    marpBrowser = marpBrowser ? marpBrowser.update() : browser(slidesEl);
    // WKWebView は viewBox だけだと高さを正しく取れないことがあるため、
    // 各スライドの実寸比を viewBox から aspect-ratio として明示する。
    for (const svg of Array.from(slidesEl.querySelectorAll<SVGSVGElement>("svg[data-marpit-svg]"))) {
      const vb = svg.viewBox.baseVal;
      if (vb.width && vb.height) svg.style.aspectRatio = `${vb.width} / ${vb.height}`;
    }
  } else {
    // md ファイル内の生 HTML 経由の XSS (IPC 到達) を防ぐためサニタイズする
    docEl.innerHTML = DOMPurify.sanitize(md.render(currentSource));
    rewriteLocalImages(docEl);
    enhanceCodeBlocks(docEl);
    const blocks = Array.from(docEl.querySelectorAll<HTMLElement>(".mermaid-block"));
    if (blocks.length) {
      try {
        await (await getMermaid()).run({ nodes: blocks });
      } catch {
        // 構文エラーのブロックは mermaid がエラー表示に差し替える
      }
      // 各図をクリックでライトボックス拡大表示にする
      for (const block of blocks) {
        const svg = block.querySelector<SVGSVGElement>("svg");
        // 構文エラーの差し替え表示 (.error-icon を含む) は拡大対象外
        if (!svg || svg.querySelector(".error-icon")) continue;
        block.addEventListener("click", () => openLightbox(svg));
      }
    }
  }

  viewport.scrollTop = scrollTop;
  updateProgress();
  refreshFind();
  viewport.classList.remove("refresh");
  requestAnimationFrame(() => viewport.classList.add("refresh"));
}

// コードブロックをラッパーで包み、言語ラベルとコピーボタンを付ける。
// サニタイズ後に自前で生成する要素なので innerHTML 由来の危険はない。
function enhanceCodeBlocks(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = Array.from(code?.classList ?? [])
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);

    const wrap = document.createElement("div");
    wrap.className = "code-block";
    if (lang) wrap.dataset.lang = lang;
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
        showToast("コピーできませんでした");
      }
    });
    wrap.appendChild(btn);
  }
}

async function copyText(text: string) {
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

// md ファイルからの相対パス画像を asset プロトコル URL に変換する
function rewriteLocalImages(root: HTMLElement) {
  if (!currentPath) return;
  const dir = currentPath.replace(/\/[^/]*$/, "");
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    img.src = convertFileSrc(resolvePath(dir, decodeURIComponent(src)));
  }
}

function resolvePath(dir: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const stack = dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

// ---------- ファイルの読み込みと監視 ----------
// ファイルを開くときは Rust 側 (open_path) がウィンドウを振り分ける:
// 既に表示中のウィンドウがあれば前面化、この窓が空ならここで表示、
// それ以外は新しいウィンドウで開く。
async function openPath(path: string) {
  try {
    const outcome = await invoke<string>("open_path", { path });
    if (outcome === "load-here") await loadFile(path);
  } catch (e) {
    showToast(String(e));
  }
}

async function loadFile(path: string) {
  try {
    currentSource = await invoke<string>("read_md_file", { path });
  } catch (e) {
    showToast(`読み込めませんでした: ${e}`);
    return;
  }
  currentPath = path;
  const name = path.split("/").pop() ?? path;

  capsule.classList.remove("hidden");
  btnEdit.classList.remove("hidden");
  fileNameEl.textContent = name;
  getCurrentWindow().setTitle(`${name} — Inkfish`);
  pushRecent(path, name);
  // 「同じファイルは同じウィンドウ」の台帳に自分を登録する
  invoke("register_shown_file", { path }).catch(() => {});

  await render();
  viewport.scrollTop = 0;

  try {
    await invoke("watch_file", { path });
    liveDot.dataset.state = "watching";
  } catch (e) {
    liveDot.dataset.state = "error";
    showToast(`変更監視を開始できませんでした: ${e}`);
  }
}

async function reload(retry = true) {
  if (!currentPath) return;
  try {
    const src = await invoke<string>("read_md_file", { path: currentPath });
    // atomic save の途中で空ファイルを読むことがあるため一度だけリトライ
    if (src === "" && currentSource !== "" && retry) {
      setTimeout(() => reload(false), 150);
      return;
    }
    if (src === currentSource) return;
    currentSource = src;
    liveDot.dataset.state = "watching";
    await render();
  } catch {
    if (retry) setTimeout(() => reload(false), 150);
    else liveDot.dataset.state = "error";
  }
}

// これらの Rust 側イベントは emit_to(label, …) で特定ウィンドウ宛に発行される。
// グローバルの listen() は EventTarget::Any として登録されターゲット指定を無視し
// 全ウィンドウで受信してしまうため、必ず現在の Webview にスコープして受け取る。
// (そうしないと複数ウィンドウ時に全ウィンドウが PDF 書き出しや再読込を実行する)
const webview = getCurrentWebview();

webview.listen("md:changed", () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload(), 60);
});

// Finder の「このアプリケーションで開く」など、起動後に届いたオープン要求
webview.listen<string>("md:open", (ev) => {
  if (ev.payload && ev.payload !== currentPath) loadFile(ev.payload);
});

// ネイティブメニュー (File) からの操作
webview.listen("menu:open", () => openFileDialog());
webview.listen("menu:export-pdf", () => exportPdf());

// ---------- ファイルを開く ----------
const MD_EXTS = ["md", "markdown", "mdown", "mdx", "txt"];

async function openFileDialog() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: MD_EXTS }],
  });
  if (typeof path === "string") openPath(path);
}

// ---------- PDF 書き出し ----------
// 保存先を選ばせて、Rust 側 (各 OS のネイティブ WebView の PDF 機能) で
// 直接 PDF を書き出す。macOS は画面メディアで描画するため、書き出しの間だけ
// body.exporting でクロームを隠し本文を全高でレイアウトする(下記参照)。
async function exportPdf() {
  if (!currentPath) {
    showToast("先に Markdown ファイルを開いてください");
    return;
  }
  const base = (currentPath.split("/").pop() ?? "document").replace(/\.[^.]+$/, "");
  const dest = await saveDialog({
    defaultPath: `${base}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;
  closeFind();
  // createPDF は画面メディアで描画するので、書き出しの間だけツールバー等の
  // クロームを隠し、本文が全高でレイアウトされるようにする。
  document.body.classList.add("exporting");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    await invoke("export_pdf", { dest });
    showToast("PDF を書き出しました");
  } catch (e) {
    showToast(`PDF の書き出しに失敗しました: ${e}`);
  } finally {
    document.body.classList.remove("exporting");
  }
}

getCurrentWebview().onDragDropEvent((ev) => {
  if (ev.payload.type === "over") return;
  document.body.classList.toggle("dropping", ev.payload.type === "enter");
  if (ev.payload.type === "drop") {
    const p = ev.payload.paths.find((p) =>
      MD_EXTS.includes(p.split(".").pop()?.toLowerCase() ?? "")
    );
    if (p) openPath(p);
    else showToast("Markdown ファイルをドロップしてください");
  }
});

// ---------- リンクのホバー表示(左下ステータスバー) ----------
document.addEventListener("mouseover", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (!href) {
    linkStatus.classList.add("hidden");
    return;
  }
  // 表示は読みやすいようデコード(不正な % 列は生のまま)
  let text = href;
  try {
    text = decodeURIComponent(href);
  } catch {
    /* keep raw */
  }
  linkStatus.textContent = text;
  linkStatus.classList.remove("hidden");
});

// ---------- リンク処理 ----------
document.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (!href) return;
  e.preventDefault();

  // ページ内アンカー
  if (href.startsWith("#")) {
    // markdown-it-anchor の id は encodeURIComponent 済み文字列そのもの。
    // まず生の値で引き、無ければデコードした値でも引く(手書き id 対策)。
    const rawId = href.slice(1);
    let target = document.getElementById(rawId);
    if (!target) {
      try {
        target = document.getElementById(decodeURIComponent(rawId));
      } catch {
        /* 不正な % シーケンスは無視 */
      }
    }
    target?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  // スキームがあるもの (http(s):// / mailto: / tel: など) は外部で開く
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    openUrl(href);
    return;
  }

  // ここから下はスキームなし = ローカルファイルアクセスとして扱う
  if (!currentPath) return;
  const dir = currentPath.replace(/\/[^/]*$/, "");
  const path = resolvePath(dir, decodeURIComponent(href));

  if (/\.(md|markdown|mdown|mdx)$/i.test(path)) {
    // 相対リンクの md ファイルはこのビューアーで開く
    openPath(path);
    return;
  }

  // md 以外のローカルファイルは OS 既定アプリで開く (毎回確認)
  const ok = await confirm(`外部アプリで開きます:\n${path}`, {
    title: "外部アプリで開く",
    kind: "warning",
    okLabel: "開く",
    cancelLabel: "キャンセル",
  });
  if (!ok) return;
  try {
    await openExternal(path);
  } catch (err) {
    showToast(`開けませんでした: ${err}`);
  }
});

// ---------- 外部エディタ ----------
const DEFAULT_EDITOR_CMD = "open -t {path}";
const editorCmd = () => localStorage.getItem("editorCmd") || DEFAULT_EDITOR_CMD;

async function openInEditor() {
  if (!currentPath) return;
  try {
    await invoke("open_in_editor", { path: currentPath, command: editorCmd() });
  } catch (e) {
    showToast(String(e));
    toggleSettings(true);
  }
}

// ---------- 設定 ----------
function toggleSettings(show?: boolean) {
  const willShow = show ?? settingsPop.classList.contains("hidden");
  settingsPop.classList.toggle("hidden", !willShow);
  if (willShow) {
    editorCmdInput.value = editorCmd();
    editorCmdInput.focus();
  }
}

$("settings-save").addEventListener("click", () => {
  localStorage.setItem("editorCmd", editorCmdInput.value.trim());
  toggleSettings(false);
  showToast("エディタ設定を保存しました");
});

document.addEventListener("mousedown", (e) => {
  if (
    !settingsPop.classList.contains("hidden") &&
    !settingsPop.contains(e.target as Node) &&
    !(e.target as HTMLElement).closest("#btn-settings")
  ) {
    toggleSettings(false);
  }
});

// ---------- 最近のファイル ----------
type Recent = { path: string; name: string };

function recents(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("recents") ?? "[]");
  } catch {
    return [];
  }
}

function pushRecent(path: string, name: string) {
  const list = [{ path, name }, ...recents().filter((r) => r.path !== path)].slice(0, 8);
  localStorage.setItem("recents", JSON.stringify(list));
}

function renderRecents() {
  const list = recents();
  $("recents").classList.toggle("hidden", list.length === 0);
  $("recent-list").innerHTML = list
    .map(
      (r) =>
        `<li><button data-path="${md.utils.escapeHtml(r.path)}">
          <span class="r-name">${md.utils.escapeHtml(r.name)}</span>
          <span class="r-path">${md.utils.escapeHtml(r.path)}</span>
        </button></li>`
    )
    .join("");
  $("recent-list")
    .querySelectorAll<HTMLButtonElement>("button[data-path]")
    .forEach((b) => b.addEventListener("click", () => openPath(b.dataset.path!)));
}

// ---------- トースト ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

// ---------- ページ内検索 ----------
// DOM を書き換えず CSS Custom Highlight API でマッチを塗る。テキストランを
// 分割しないので、折り返し(改行)位置が検索によって変わらない。
// WebKit は highlights を消し替えても旧領域を再描画しないことがあるため、
// 変更後に対象コンテンツを一度だけ同期的に再描画してゴーストを消す。
const btnFindPrev = $<HTMLButtonElement>("find-prev");
const btnFindNext = $<HTMLButtonElement>("find-next");
const HL_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

let findMatches: Range[] = [];
let findIndex = -1;

// 表示中のコンテンツ(本文 or スライド)を検索対象にする
const findRoot = () => (slidesEl.classList.contains("hidden") ? docEl : slidesEl);

// highlights を消し替えても WebKit が旧領域を再描画しないので、描画だけを強制して
// ゴーストを消す。filter の有無をトグルすると中身がバッファへ再ラスタライズされる。
// brightness(1) は恒等フィルタなのでピクセルは完全に不変(透明化もなし)。
// レイアウト・スクロール・見た目はいずれも動かない。
let repaintNudge = false;
function forceRepaint() {
  repaintNudge = !repaintNudge;
  findRoot().style.filter = repaintNudge ? "brightness(1)" : "";
}

function clearHighlights() {
  if (!HL_SUPPORTED) return;
  CSS.highlights.delete("find-match");
  CSS.highlights.delete("find-current");
}

function runFind(query: string, autoScroll = true) {
  if (!HL_SUPPORTED) return;
  findMatches = [];
  findIndex = -1;

  const q = query.toLowerCase();
  if (q) {
    const walker = document.createTreeWalker(findRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const tag = n.parentElement?.tagName;
        if (tag === "STYLE" || tag === "SCRIPT") return NodeFilter.FILTER_REJECT;
        return (n.nodeValue ?? "").toLowerCase().includes(q)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const hay = (node.nodeValue ?? "").toLowerCase();
      for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + q.length);
        findMatches.push(range);
      }
    }
  }

  if (findMatches.length) {
    // 現在のスクロール位置以降の最初のマッチを選ぶ
    findIndex = findMatches.findIndex((r) => r.getBoundingClientRect().top >= 0);
    if (findIndex === -1) findIndex = 0;
  }
  applyHighlights(autoScroll);
  updateFindUI();
}

function applyHighlights(scroll: boolean) {
  if (!HL_SUPPORTED) return;
  if (findMatches.length) {
    CSS.highlights.set("find-match", new Highlight(...findMatches));
    CSS.highlights.set("find-current", new Highlight(findMatches[findIndex]));
  } else {
    clearHighlights();
  }
  forceRepaint();
  if (scroll && findMatches.length) {
    const rect = findMatches[findIndex].getBoundingClientRect();
    const target = viewport.scrollTop + rect.top - viewport.clientHeight / 2;
    viewport.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

function moveFind(delta: number) {
  if (!findMatches.length) return;
  findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
  applyHighlights(true);
  updateFindUI();
}

function updateFindUI() {
  const q = findInput.value;
  const total = findMatches.length;
  findCount.textContent = q ? `${total ? findIndex + 1 : 0}/${total}` : "";
  findCount.classList.toggle("empty", !!q && total === 0);
  btnFindPrev.disabled = total === 0;
  btnFindNext.disabled = total === 0;
}

function openFind() {
  findBar.classList.remove("hidden");
  const sel = getSelection()?.toString().trim();
  if (sel && sel.length <= 100) findInput.value = sel;
  findInput.focus();
  findInput.select();
  runFind(findInput.value);
}

function closeFind() {
  findBar.classList.add("hidden");
  clearHighlights();
  forceRepaint();
  findMatches = [];
  findIndex = -1;
  viewport.focus();
}

// 再描画でマッチ範囲が無効になるので、開いていれば張り直す(スクロールはしない)
function refreshFind() {
  if (!findBar.classList.contains("hidden")) runFind(findInput.value, false);
}

findInput.addEventListener("input", () => runFind(findInput.value));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    moveFind(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
btnFindPrev.addEventListener("click", () => moveFind(-1));
btnFindNext.addEventListener("click", () => moveFind(1));
$("find-close").addEventListener("click", closeFind);

// ---------- キーボード / ズーム ----------
function setScale(v: number) {
  fontScale = Math.min(1.6, Math.max(0.7, v));
  document.documentElement.style.setProperty("--scale", String(fontScale));
}

window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  switch (e.key) {
    case "o": e.preventDefault(); openFileDialog(); break;
    case "e": e.preventDefault(); openInEditor(); break;
    case "f": e.preventDefault(); openFind(); break;
    case "=": case "+": e.preventDefault(); setScale(fontScale + 0.1); break;
    case "-": e.preventDefault(); setScale(fontScale - 0.1); break;
    case "0": e.preventDefault(); setScale(1); break;
  }
});

// ---------- 読書プログレスバー ----------
function updateProgress() {
  const max = viewport.scrollHeight - viewport.clientHeight;
  document.documentElement.style.setProperty(
    "--progress",
    max > 0 ? String(Math.min(1, viewport.scrollTop / max)) : "0"
  );
}
viewport.addEventListener("scroll", updateProgress, { passive: true });
window.addEventListener("resize", updateProgress);

// ---------- テーマ変更で Mermaid を再描画 ----------
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  initMermaid();
  if (currentPath) render();
});

// ---------- Mermaid ライトボックス ----------
// 図をクリックすると全画面オーバーレイで開き、ホイール拡大縮小 /
// ドラッグ(グラブ)移動 / Shift+ホイールで横移動ができる。
let mlbScale = 1;
let mlbTx = 0;
let mlbTy = 0;
let mlbMinScale = 0.1;
let mlbMaxScale = 16;
let mlbNatW = 0;
let mlbNatH = 0;

function mlbApply() {
  mlbContent.style.transform = `translate(${mlbTx}px, ${mlbTy}px) scale(${mlbScale})`;
  // 表示倍率は原寸(SVG の viewBox)を 100% とした値
  mlbLevel.textContent = `${Math.round(mlbScale * 100)}%`;
}

// stage 上の点 (cx, cy) を固定したまま倍率を factor 倍する
function mlbZoomAt(factor: number, cx: number, cy: number) {
  const next = Math.min(mlbMaxScale, Math.max(mlbMinScale, mlbScale * factor));
  if (next === mlbScale) return;
  const localX = (cx - mlbTx) / mlbScale;
  const localY = (cy - mlbTy) / mlbScale;
  mlbTx = cx - localX * next;
  mlbTy = cy - localY * next;
  mlbScale = next;
  mlbApply();
}

function mlbZoomCenter(factor: number) {
  const r = mlbStage.getBoundingClientRect();
  mlbZoomAt(factor, r.width / 2, r.height / 2);
}

// 図全体が収まる倍率で中央に配置(小さい図は拡大、大きい図は縮小される)
function mlbFit() {
  const r = mlbStage.getBoundingClientRect();
  const margin = 0.92;
  const fit = Math.min((r.width * margin) / mlbNatW, (r.height * margin) / mlbNatH);
  mlbScale = fit || 1;
  mlbMinScale = mlbScale / 4;
  mlbMaxScale = mlbScale * 16;
  mlbTx = (r.width - mlbNatW * mlbScale) / 2;
  mlbTy = (r.height - mlbNatH * mlbScale) / 2;
  mlbApply();
}

function openLightbox(svg: SVGSVGElement) {
  const vb = svg.viewBox.baseVal;
  const rect = svg.getBoundingClientRect();
  mlbNatW = vb.width || rect.width || 100;
  mlbNatH = vb.height || rect.height || 100;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.style.width = `${mlbNatW}px`;
  clone.style.height = `${mlbNatH}px`;
  mlbContent.replaceChildren(clone);

  lightbox.classList.remove("hidden");
  lightbox.setAttribute("aria-hidden", "false");
  mlbFit();
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightbox.setAttribute("aria-hidden", "true");
  mlbContent.replaceChildren();
}

const isLightboxOpen = () => !lightbox.classList.contains("hidden");

// ホイール操作(Win/Mac 共通の慣習):
//  - Ctrl/⌘ 併用 or トラックパッドのピンチ(ctrlKey で届く) → カーソル中心にズーム
//  - Shift 併用 → 横パン
//  - 修飾なし → パン(トラックパッドの deltaX で横、deltaY で縦)
mlbStage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = mlbStage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY / 100);
      mlbZoomAt(factor, e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (e.shiftKey) {
      // 縦ホイールしか出ないマウス向けに deltaY も横移動へ回す
      mlbTx -= e.deltaX || e.deltaY;
      mlbApply();
      return;
    }
    mlbTx -= e.deltaX;
    mlbTy -= e.deltaY;
    mlbApply();
  },
  { passive: false }
);

// ドラッグ(グラブ)で移動。動かさずに背景をクリックしたら閉じる。
let mlbDragging = false;
let mlbMoved = false;
let mlbStartX = 0;
let mlbStartY = 0;
let mlbStartTx = 0;
let mlbStartTy = 0;

mlbStage.addEventListener("pointerdown", (e) => {
  mlbDragging = true;
  mlbMoved = false;
  mlbStartX = e.clientX;
  mlbStartY = e.clientY;
  mlbStartTx = mlbTx;
  mlbStartTy = mlbTy;
  mlbStage.setPointerCapture(e.pointerId);
  mlbStage.classList.add("grabbing");
});

mlbStage.addEventListener("pointermove", (e) => {
  if (!mlbDragging) return;
  const dx = e.clientX - mlbStartX;
  const dy = e.clientY - mlbStartY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) mlbMoved = true;
  mlbTx = mlbStartTx + dx;
  mlbTy = mlbStartTy + dy;
  mlbApply();
});

mlbStage.addEventListener("pointerup", (e) => {
  mlbDragging = false;
  mlbStage.classList.remove("grabbing");
  // 背景(図の外)をドラッグせずクリックしたら閉じる
  if (!mlbMoved && e.target === mlbStage) closeLightbox();
});

$("mlb-zoom-in").addEventListener("click", () => mlbZoomCenter(1.25));
$("mlb-zoom-out").addEventListener("click", () => mlbZoomCenter(1 / 1.25));
$("mlb-reset").addEventListener("click", mlbFit);
$("mlb-close").addEventListener("click", closeLightbox);

// ライトボックス表示中はキー操作を専有する(本文ズームより優先)
window.addEventListener(
  "keydown",
  (e) => {
    if (!isLightboxOpen()) return;
    switch (e.key) {
      case "Escape": e.preventDefault(); closeLightbox(); break;
      case "+": case "=": e.preventDefault(); e.stopPropagation(); mlbZoomCenter(1.25); break;
      case "-": e.preventDefault(); e.stopPropagation(); mlbZoomCenter(1 / 1.25); break;
      case "0": e.preventDefault(); e.stopPropagation(); mlbFit(); break;
    }
  },
  true
);

// ---------- イベント配線と起動 ----------
$("btn-open").addEventListener("click", openFileDialog);
$("empty-open").addEventListener("click", openFileDialog);
$("btn-edit").addEventListener("click", openInEditor);
$("btn-settings").addEventListener("click", () => toggleSettings());

(async () => {
  renderRecents();
  const startupFile = await invoke<string | null>("get_startup_file");
  if (startupFile) loadFile(startupFile);
})();
