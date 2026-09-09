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

/// 変わった行 → その変わり方と、何番目のまとまりか。
/// 種類は印の色に、番号は左右の位置を合わせるのに使う。
export type ChangeKind = "add" | "del" | "mod";
export type ChangeAt = { kind: ChangeKind; hunk: number };

/// hunk を「変わった行」に直す。
///
/// 片側が空のまとまりは純粋な追加 / 削除で、その側には行が無いので印も付かない
/// (追加は終点側にだけ緑、削除は起点側にだけ赤が出る)。両側にあるものは変更。
function linesOf(hunks: Hunk[], side: "before" | "after"): Map<number, ChangeAt> {
  const out = new Map<number, ChangeAt>();
  hunks.forEach((h, hunk) => {
    const kind: ChangeKind =
      h.beforeStart === h.beforeEnd ? "add" : h.afterStart === h.afterEnd ? "del" : "mod";
    const start = side === "before" ? h.beforeStart : h.afterStart;
    const end = side === "before" ? h.beforeEnd : h.afterEnd;
    for (let i = start; i < end; i++) out.set(i, { kind, hunk });
  });
  return out;
}

/// まるごと足された / 消された文書。全部の行を同じ扱いにする。
function allLines(src: string, kind: ChangeKind): Map<number, ChangeAt> {
  const out = new Map<number, ChangeAt>();
  const n = src.split("\n").length;
  for (let i = 0; i < n; i++) out.set(i, { kind, hunk: 0 });
  return out;
}

/// 器を組む。
///
///   host (.is-diff)          ← ここがスクロールする
///     track                  ← 高さだけを持つ。長い側に合わせて伸ばす
///       viewport (sticky)    ← 画面に貼り付いて動かない
///         side × 2           ← それぞれに DocumentViewer が載る
///
/// 中身は viewport の中で transform でずらす。スクロールそのものは外枠に
/// 任せるので、慣性もゴムも OS の作法のまま効く (keepSynced 参照)。
export function makeSides(host: HTMLElement) {
  host.classList.add("is-diff");

  const track = document.createElement("div");
  track.className = "ink-diff-track";
  const viewport = document.createElement("div");
  viewport.className = "ink-diff-viewport";
  track.appendChild(viewport);
  host.appendChild(track);

  const side = (which: string) => {
    const el = document.createElement("div");
    el.className = "ink-diff-side";
    el.dataset.side = which;
    viewport.appendChild(el);
    return el;
  };
  // 左が起点、右が終点
  return { beforeHost: side("before"), afterHost: side("after"), track, viewport };
}

/// 片側を描く。その版に無ければ (src が null) 器に断りを出す。
async function showSide(
  viewer: DocumentViewer,
  id: string,
  host: HTMLElement,
  src: string | null,
  absentLabel: string,
  name: string,
  changedLines: Map<number, ChangeAt>
): Promise<boolean> {
  if (src === null) {
    host.dataset.absent = absentLabel;
    host.classList.add("is-absent");
    return false;
  }
  host.classList.remove("is-absent");
  await viewer.setSource(src, { baseDir: dirname(id), name, changedLines });
  return true;
}

/// 左右をまとめて読む。変わったところに印が出るようにする。
///
/// 追加されたファイルには起点が無く、削除されたファイルには終点が無い。
/// そのときは行差分を取りようがないので、残っている側をまるごと「追加」
/// あるいは「削除」として扱う (全体が緑、あるいは全体が赤になる)。
export async function loadPair(
  before: { viewer: DocumentViewer; id: string; host: HTMLElement },
  after: { viewer: DocumentViewer; id: string; host: HTMLElement },
  name: string
): Promise<{ before: boolean; after: boolean; hunks: Hunk[] }> {
  const [beforeSrc, afterSrc] = await Promise.all([
    readMdFile(before.id).catch(() => null),
    readMdFile(after.id).catch(() => null),
  ]);

  let beforeLines = new Map<number, ChangeAt>();
  let afterLines = new Map<number, ChangeAt>();
  let hunks: Hunk[] = [];
  if (beforeSrc !== null && afterSrc !== null) {
    // 差分が取れなくても中身は見せられるので、失敗したら印なしで進む
    hunks = await gitHunks(before.id, after.id).catch(() => [] as Hunk[]);
    beforeLines = linesOf(hunks, "before");
    afterLines = linesOf(hunks, "after");
  } else if (afterSrc !== null) {
    afterLines = allLines(afterSrc, "add");
  } else if (beforeSrc !== null) {
    beforeLines = allLines(beforeSrc, "del");
  }

  const [a, b] = await Promise.all([
    showSide(
      after.viewer,
      after.id,
      after.host,
      afterSrc,
      "変更後にはありません",
      name,
      afterLines
    ),
    showSide(
      before.viewer,
      before.id,
      before.host,
      beforeSrc,
      "変更前にはありません",
      name,
      beforeLines
    ),
  ]);
  return { after: a, before: b, hunks };
}

// ---------- 左右の連動 ----------

/// 外枠の位置を、片側の位置に写す。
///
/// 区間の長さは外枠が「左右の長い方」を持っているので、短い側は自分の長さまで
/// 進んだところで止まり、長い側が追いつくのを待つ。比例で配分すると、追加が
/// あるところで両方がじりじり動いてしまい、どこが対応しているのか分からなく
/// なる。止めてしまう方が、変わっていない行が動かないぶん読みやすい。
///
/// 揃える端は区間の頭に固定する。向きで変えると (下りは頭、上りは尻) 読む側の
/// 都合には合うが、区間の途中で向きを変えたときに位置が飛ぶ。位置はスクロール量
/// だけで決まる必要がある。
function mapPos(y: number, from: number[], to: number[]): number {
  if (from.length < 2) return 0;
  let i = 0;
  while (i < from.length - 2 && from[i + 1] <= y) i++;
  const local = Math.max(0, y - from[i]);
  const span = to[i + 1] - to[i];
  return to[i] + Math.min(local, span);
}

/// ブロックの「元テキストの開始行」と、その面での上端・下端。
/// transform でずらしていても動かないよう、レイアウト上の値で測る。
type LineSpan = { line: number; top: number; bottom: number };

function lineSpans(viewer: DocumentViewer): LineSpan[] {
  const doc = viewer.contentEl;
  const base = doc.offsetTop;
  return Array.from(doc.querySelectorAll<HTMLElement>("[data-line]"))
    .map((el) => ({
      line: Number(el.dataset.line),
      top: base + el.offsetTop,
      bottom: base + el.offsetTop + el.offsetHeight,
    }))
    .sort((x, y) => x.line - y.line);
}

/// 元テキストの行が、その面のどのあたりに来るか。
///
/// ブロックの上端だけを見ていると、リストや表の「中ほどの行が変わった」を
/// 指せない (まるごと 1 つの位置になってしまい、隣と揃えようがない)。
/// ブロックが受け持つ行数で按分して、中の位置も出せるようにする。
function lineToY(spans: LineSpan[], line: number): number {
  if (!spans.length) return 0;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (line <= s.line) return s.top;
    const next = spans[i + 1];
    if (!next) break;
    if (line < next.line) {
      const rows = Math.max(1, next.line - s.line);
      const ratio = Math.min(1, (line - s.line) / rows);
      return s.top + ratio * (s.bottom - s.top);
    }
  }
  return spans[spans.length - 1].bottom;
}

export type DiffSync = {
  /// 変わったところへ順に移動する
  jump(dir: 1 | -1): void;
  /// 先頭へ戻す
  toTop(): void;
  /// 測り直す (中身を入れ替えたあとに呼ぶ)
  refresh(): void;
  /// 連動をやめる
  stop(): void;
};

/// 左右の動きを合わせる。
///
/// 中身の長さは左右で違う。割合で合わせると下へ行くほどずれるし、短い側に
/// 余白を足して揃えるとその分だけ間延びする。スクロールを横取りして待たせる
/// 手もあるが、慣性スクロールは OS が進めるので、押し戻すと引っかかる。
///
/// そこで、スクロールするのは外枠だけにして、中の左右は transform でずらす。
/// 外枠の高さは「区間ごとに長い方」を積み上げた値にするので、どちらの中身も
/// 最後まで読み切れる。外枠の位置から左右それぞれの位置を対応表で求めるため、
/// 変更のまとまりの頭では必ず揃い、余白も入らない。
export function keepSynced(
  scroller: HTMLElement,
  track: HTMLElement,
  viewport: HTMLElement,
  before: DocumentViewer,
  after: DocumentViewer,
  hunks: () => Hunk[]
): DiffSync {
  // 外枠 / 起点側 / 終点側 それぞれの対応点
  let tPts: number[] = [0, 0];
  let bPts: number[] = [0, 0];
  let aPts: number[] = [0, 0];

  let bMax = 0;
  let aMax = 0;

  /// 画面のどこを対応点として揃えるか。
  ///
  /// 上端で揃えると、片側が止まっている間ずっと画面の上が動かない。真ん中で
  /// 揃えれば、上下どちらへ動いても半分は新しいものが出てくる。向きで変えると
  /// 区間の途中で飛ぶので、位置に依らず真ん中に固定する。
  const ANCHOR = 0.5;

  const apply = () => {
    const y = scroller.scrollTop;
    const anchor = ANCHOR * scroller.clientHeight;
    // 基準の位置で対応を取り、そのぶん戻して画面の上端に直す
    const b = Math.max(0, Math.min(bMax, mapPos(y + anchor, tPts, bPts) - anchor));
    const a = Math.max(0, Math.min(aMax, mapPos(y + anchor, tPts, aPts) - anchor));
    before.contentEl.style.transform = `translateY(${-Math.round(b)}px)`;
    after.contentEl.style.transform = `translateY(${-Math.round(a)}px)`;
  };

  const rebuild = () => {
    const h = scroller.clientHeight;
    if (h <= 0) return;
    viewport.style.height = `${h}px`;

    // 対応表の末尾は「内容の総高さ」にする。スクロールできる量 (総高さ − 画面)
    // で止めると、基準点を画面の中ほどに置いたぶんだけ手前で頭打ちになる。
    const bEnd = before.scrollEl.scrollHeight;
    const aEnd = after.scrollEl.scrollHeight;
    bMax = Math.max(0, bEnd - h);
    aMax = Math.max(0, aEnd - h);

    const bSpans = lineSpans(before);
    const aSpans = lineSpans(after);

    // 対応点は「変わったまとまりの頭と尻」。片側にしか無いまとまり
    // (まるごとの追加・削除) でも、もう片方はその場に留まる点として置ける。
    // これを外すと、追加のところで片方だけ進んでしまいずれる。
    bPts = [0];
    aPts = [0];
    const push = (bv: number, av: number) => {
      // 補間できるよう、どちらも前の点より後ろに進むものだけを採る
      if (bv < bPts[bPts.length - 1] || av < aPts[aPts.length - 1]) return;
      if (bv > bEnd || av > aEnd) return;
      // 同じ位置が続いても意味が無い
      if (bv === bPts[bPts.length - 1] && av === aPts[aPts.length - 1]) return;
      bPts.push(bv);
      aPts.push(av);
    };
    for (const h of hunks()) {
      push(lineToY(bSpans, h.beforeStart), lineToY(aSpans, h.afterStart));
      push(lineToY(bSpans, h.beforeEnd), lineToY(aSpans, h.afterEnd));
    }
    push(bEnd, aEnd);
    if (bPts.length < 2) {
      bPts = [0, bEnd];
      aPts = [0, aEnd];
    }

    // 外枠は「区間ごとに長い方」の積み上げ。こうするとどちらの中身も
    // 飛ばさずに読み切れる
    tPts = [0];
    for (let i = 1; i < bPts.length; i++) {
      const span = Math.max(bPts[i] - bPts[i - 1], aPts[i] - aPts[i - 1]);
      tPts.push(tPts[i - 1] + span);
    }
    track.style.height = `${tPts[tPts.length - 1]}px`;
    apply();
  };

  const onScroll = () => apply();
  scroller.addEventListener("scroll", onScroll, { passive: true });

  // 図の読み込みや幅の変化で高さが動くので測り直す
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      rebuild();
    });
  };
  const ro = new ResizeObserver(queue);
  ro.observe(before.contentEl);
  ro.observe(after.contentEl);
  ro.observe(scroller);
  rebuild();

  return {
    jump(dir) {
      // 行き先は変わったまとまりの頭。両端 (先頭と末尾) は外す
      const stops = tPts.slice(1, -1);
      const cur = scroller.scrollTop;
      const next =
        dir > 0 ? stops.find((t) => t > cur + 4) : [...stops].reverse().find((t) => t < cur - 4);
      if (next === undefined) return;
      scroller.scrollTo({ top: Math.round(next), behavior: "smooth" });
    },
    toTop() {
      scroller.scrollTop = 0;
      apply();
    },
    refresh: queue,
    stop() {
      ro.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      before.contentEl.style.transform = "";
      after.contentEl.style.transform = "";
    },
  };
}
