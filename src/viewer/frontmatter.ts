// ---------- front matter ----------
// 先頭の `---` … `---` を YAML として切り出す。Jekyll 由来の慣習で、Marp も
// この位置のブロックを設定として読む。終端に `...` を使う YAML も通し、
// Windows のエディタが付ける BOM も先頭に許す (read_md_file は落とさない)。
export const FM_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export type FrontMatter = {
  // YAML がマップとして読めたときだけ入る
  data: Record<string, unknown> | null;
  // front matter を取り除いた本文。切り出せなかったときはソースそのまま
  body: string;
  // body がソースの何行目から始まるか (0 始まり)。差分の行番号を本文側の
  // 行番号に直すのに使う
  offset: number;
  // front matter らしいブロックはあったが YAML として読めなかった
  broken: boolean;
};

const NO_FM = (src: string): FrontMatter => ({ data: null, body: src, broken: false, offset: 0 });

// js-yaml は front matter 付きの文書に当たるまで読み込まない。
// ライブラリのハンドルなのでモジュールレベルで共有してよい。
let yamlLoad: ((src: string) => unknown) | null = null;
async function getYamlLoad() {
  if (!yamlLoad) yamlLoad = (await import("js-yaml")).load;
  return yamlLoad;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function parseFrontMatter(src: string): Promise<FrontMatter> {
  const m = FM_RE.exec(src);
  if (!m) return NO_FM(src);
  let data: unknown;
  try {
    data = (await getYamlLoad())(m[1]);
  } catch {
    // 読めなかったものを黙って隠すと原因が追えないので、本文はそのまま出す
    return { data: null, body: src, broken: true, offset: 0 };
  }
  // マップ以外 (`---` 区切りの水平線や setext 見出しを拾ってしまった場合など) は
  // front matter と見なさず、これまで通り Markdown として描く
  if (!isPlainObject(data)) return NO_FM(src);
  const offset = (m[0].match(/\n/g) ?? []).length;
  return { data, body: src.slice(m[0].length), broken: false, offset };
}

// 慣習的に意味の決まっているキーだけ位置と見せ方を決め打ちする。GitHub Docs /
// Jekyll / Hugo / Obsidian / Pandoc で共通して使われる範囲に絞り、それ以外は
// 書かれた順のまま key: value の行として全部出す (未知のキーでも情報を落とさない)。
const FM_LEAD_KEYS = new Set(["subtitle", "description", "intro", "summary", "excerpt"]);
const FM_META_KEYS = new Set(["date", "published", "updated", "lastmod", "author", "authors"]);
const FM_TAG_KEYS = new Set(["tags", "categories", "keywords", "topics"]);

// js-yaml は `2026-08-18` を UTC 0 時の Date として読む。日付だけの指定を
// ローカル時刻へ寄せると 1 日ずれるので、表示も UTC 側で組む。
function fmDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// 値を 1 行のテキストにする。ネストは `key: value` を並べた形に潰す。
function fmText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return fmDate(v);
  if (Array.isArray(v)) return v.map(fmText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${fmText(x)}`)
      .join(", ");
  }
  return String(v);
}

// tags 系の値。配列でもカンマ区切りの文字列でも受ける。
function fmList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(fmText).filter(Boolean);
  return fmText(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const fmTitle = (data: Record<string, unknown> | null): string => {
  const t = data?.title;
  return typeof t === "string" ? t.trim() : "";
};

// front matter を本文冒頭のメタ情報カードにする。textContent だけで組むので
// サニタイズ済みの本文へそのまま prepend してよい。
export function buildFrontMatterCard(data: Record<string, unknown>): HTMLElement | null {
  const leads: string[] = [];
  const metas: string[] = [];
  const tags: string[] = [];
  const rest: [string, string][] = [];

  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    // marp / title は他の場所で使い終えているのでカードには出さない
    if (k === "title" || k === "marp") continue;
    if (FM_LEAD_KEYS.has(k)) leads.push(fmText(value));
    else if (FM_META_KEYS.has(k)) metas.push(fmText(value));
    else if (FM_TAG_KEYS.has(k)) tags.push(...fmList(value));
    // 空値も「キーはある」ことが分かるように残す
    else rest.push([key, fmText(value) || "—"]);
  }

  const card = document.createElement("header");
  card.className = "front-matter";
  const add = (tag: string, cls: string, text: string) => {
    const el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    card.appendChild(el);
    return el;
  };

  const title = fmTitle(data);
  if (title) add("h1", "fm-title", title);
  for (const lead of leads.filter(Boolean)) add("p", "fm-lead", lead);

  const shown = metas.filter(Boolean);
  if (shown.length) {
    const line = add("p", "fm-meta", "");
    for (const text of shown) {
      const span = document.createElement("span");
      span.textContent = text;
      line.appendChild(span);
    }
  }

  if (tags.length) {
    const list = add("ul", "fm-tags", "");
    for (const tag of tags) {
      const li = document.createElement("li");
      li.textContent = `#${tag}`;
      list.appendChild(li);
    }
  }

  if (rest.length) {
    // dt / dd を直接並べ、2 列グリッド (CSS 側) の自動配置に任せる
    const dl = add("dl", "fm-rest", "");
    for (const [key, value] of rest) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  return card.childElementCount ? card : null;
}
