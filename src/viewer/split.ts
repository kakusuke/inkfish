// 2 つの版を左右に並べて見せるための下ごしらえ。
//
// プロジェクトウィンドウのタブと、そこから切り離した単一文書ウィンドウの
// 両方が同じ形を使う。差分そのものに ID (diff:/…) を与えたので、どちらの
// ガワでも「その ID を開いているだけ」になり、置き場所が違うだけで済む。

import { invoke } from "@tauri-apps/api/core";
import type { ChangeSpan, DocumentViewer } from "./viewer";
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

/// 相手側だけが増えた (あるいは減った) 位置。
///
/// その側には行が無いので線も引けないが、「ここに入った」ことは示したい。
/// markdown.ts がこの位置に点の目印を埋めるので、左右を結ぶ帯の頂点が
/// ブロックの境目に落ちる。
function insertPoints(hunks: Hunk[], side: "before" | "after"): Map<number, ChangeAt> {
  const out = new Map<number, ChangeAt>();
  hunks.forEach((h, hunk) => {
    const start = side === "before" ? h.beforeStart : h.afterStart;
    const end = side === "before" ? h.beforeEnd : h.afterEnd;
    // その側に行が無い = 相手側だけが増えた (起点側なら追加、終点側なら削除)
    if (start === end) out.set(start, { kind: side === "before" ? "add" : "del", hunk });
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

  const beforeHost = side("before");
  const afterHost = side("after");

  // 左右の線を結ぶ帯。左右にまたがるので、面を分けずに viewport 全体へ重ねる
  const ribbon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ribbon.setAttribute("class", "ink-diff-ribbon");
  ribbon.setAttribute("aria-hidden", "true");
  ribbon.setAttribute("preserveAspectRatio", "none");
  viewport.appendChild(ribbon);

  return { beforeHost, afterHost, track, viewport, ribbon };
}

/// 片側を描く。その版に無ければ (src が null) 器に断りを出す。
async function showSide(
  viewer: DocumentViewer,
  id: string,
  host: HTMLElement,
  src: string | null,
  absentLabel: string,
  name: string,
  changedLines: Map<number, ChangeAt>,
  insertedAt: Map<number, ChangeAt>
): Promise<boolean> {
  if (src === null) {
    host.dataset.absent = absentLabel;
    host.classList.add("is-absent");
    return false;
  }
  host.classList.remove("is-absent");
  await viewer.setSource(src, { baseDir: dirname(id), name, changedLines, insertedAt });
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
): Promise<{ before: boolean; after: boolean }> {
  const [beforeSrc, afterSrc] = await Promise.all([
    readMdFile(before.id).catch(() => null),
    readMdFile(after.id).catch(() => null),
  ]);

  let beforeLines = new Map<number, ChangeAt>();
  let afterLines = new Map<number, ChangeAt>();
  let beforeInserts = new Map<number, ChangeAt>();
  let afterInserts = new Map<number, ChangeAt>();
  let hunks: Hunk[] = [];
  if (beforeSrc !== null && afterSrc !== null) {
    // 差分が取れなくても中身は見せられるので、失敗したら印なしで進む
    hunks = await gitHunks(before.id, after.id).catch(() => [] as Hunk[]);
    beforeLines = linesOf(hunks, "before");
    afterLines = linesOf(hunks, "after");
    beforeInserts = insertPoints(hunks, "before");
    afterInserts = insertPoints(hunks, "after");
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
      afterLines,
      afterInserts
    ),
    showSide(
      before.viewer,
      before.id,
      before.host,
      beforeSrc,
      "変更前にはありません",
      name,
      beforeLines,
      beforeInserts
    ),
  ]);
  return { after: a, before: b };
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

/// 要素が root の中のどこにあるか。transform は効いていない値 (レイアウト上の位置)。
function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== root) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/// 左右を結ぶ 1 本の帯。まとまりごとに、起点側と終点側の受け持つ範囲を持つ。
/// 片側だけの差分 (追加・削除) は、その側が高さゼロの点になる。
type Band = {
  bTop: number;
  bBottom: number;
  aTop: number;
  aBottom: number;
  kind: string;
};

/// 左右の線を結ぶ帯を描く。
///
/// 線だけだと「左のこれが右のこれになった」が目で追えない。上端どうし・
/// 下端どうしをなだらかに結んで中を薄く塗ると、対応が一目で分かる。片側が
/// 点のときは三角になり、その頂点はブロックの境目を指す。
///
/// 相手が画面の外にあるものは描かない。伸びきった帯は対応を示さないうえ、
/// 斜めの筋が本文に重なって読みにくいだけになる。
function drawRibbon(
  ribbon: SVGElement,
  bands: Band[],
  x0: number,
  x1: number,
  bShift: number,
  aShift: number,
  width: number,
  height: number
) {
  const c = (x0 + x1) / 2;
  const out = (top: number, bottom: number) => bottom < -40 || top > height + 40;
  const paths: string[] = [];
  for (const band of bands) {
    const bTop = band.bTop - bShift;
    const bBottom = band.bBottom - bShift;
    const aTop = band.aTop - aShift;
    const aBottom = band.aBottom - aShift;
    if (out(bTop, bBottom) || out(aTop, aBottom)) continue;
    paths.push(
      `<path d="M${x0},${bTop} C${c},${bTop} ${c},${aTop} ${x1},${aTop}` +
        ` L${x1},${aBottom} C${c},${aBottom} ${c},${bBottom} ${x0},${bBottom} Z"` +
        ` class="ink-ribbon-${band.kind}"/>`
    );
  }
  ribbon.setAttribute("viewBox", `0 0 ${width} ${height}`);
  ribbon.innerHTML = paths.join("");
}

/// 左右の線を突き合わせて帯にする。
///
/// 突き合わせるのは線そのもの (changeSpans)。線と別に範囲を組み立てると、
/// 出し方の違いがそのまま帯のズレになって出る。
///
/// 線はハンク 1 つにつき 1 本なので、突き合わせもハンク番号で引くだけ。
/// つないでいたときは「左で 1 本・右で 2 本」が起きて、どちらに合わせても
/// 帯か線のどちらかが食い違った。相手に線が無いもの (まるごとの追加・削除)
/// は、相手側の点を頂点にする。
function bandsOf(before: DocumentViewer, after: DocumentViewer): Band[] {
  const solid = (v: DocumentViewer) => v.changeSpans().filter((s) => !s.point);
  const bSpans = solid(before);
  const aSpans = solid(after);
  const bPoints = before.changePoints();
  const aPoints = after.changePoints();

  const band = (b: ChangeSpan | number, a: ChangeSpan | number, kind: string): Band => ({
    bTop: typeof b === "number" ? b : b.top,
    bBottom: typeof b === "number" ? b : b.bottom,
    aTop: typeof a === "number" ? a : a.top,
    aBottom: typeof a === "number" ? a : a.bottom,
    kind,
  });

  const bands: Band[] = [];
  for (const b of bSpans) {
    const a = aSpans.find((s) => s.hunk === b.hunk);
    if (a) {
      bands.push(band(b, a, b.kind));
      continue;
    }
    const y = aPoints.get(b.hunk);
    if (y !== undefined) bands.push(band(b, y, b.kind));
  }
  for (const a of aSpans) {
    // 上で組にしたものは済み
    if (bSpans.some((s) => s.hunk === a.hunk)) continue;
    const y = bPoints.get(a.hunk);
    if (y !== undefined) bands.push(band(y, a, a.kind));
  }

  return bands.sort((x, y) => x.bTop - y.bTop || x.aTop - y.aTop);
}

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
  ribbon: SVGElement,
  before: DocumentViewer,
  after: DocumentViewer
): DiffSync {
  // 短いほうに足す逃げ。本文の外 (紙の下) に置くので、紙の丈は変わらない
  const spacer = (viewer: DocumentViewer) => {
    const el = document.createElement("div");
    el.className = "ink-diff-pad";
    el.setAttribute("aria-hidden", "true");
    viewer.scrollEl.appendChild(el);
    return el;
  };
  const bPad = spacer(before);
  const aPad = spacer(after);

  // 外枠 / 起点側 / 終点側 それぞれの対応点
  let tPts: number[] = [0, 0];
  let bPts: number[] = [0, 0];
  let aPts: number[] = [0, 0];
  /// 変わったところの頭にあたる対応点 (外枠の位置)。↓↑ の行き先はここだけ。
  /// 尻にも対応点はあるが、そこにも止まると 1 つの差分に 2 回ぶつかる。
  let stops: number[] = [];

  let bMax = 0;
  let aMax = 0;

  // 左右を結ぶ帯。中身が変わるたびに測り直す (apply では読むだけ)
  let bands: Band[] = [];
  // 帯の左右の端。線が本文の縁に出るので、そこへ合わせる
  let x0 = 0;
  let x1 = 0;
  // 帯は viewport の中に描くが、範囲は本文の中の座標。本文が枠のどこから
  // 始まるかを足さないと、そのぶん上にずれる
  let bY = 0;
  let aY = 0;

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
    const b = Math.round(Math.max(0, Math.min(bMax, mapPos(y + anchor, tPts, bPts) - anchor)));
    const a = Math.round(Math.max(0, Math.min(aMax, mapPos(y + anchor, tPts, aPts) - anchor)));
    before.contentEl.style.transform = `translateY(${-b}px)`;
    after.contentEl.style.transform = `translateY(${-a}px)`;
    drawRibbon(ribbon, bands, x0, x1, b - bY, a - aY, viewport.clientWidth, scroller.clientHeight);
  };

  const rebuild = () => {
    const h = scroller.clientHeight;
    if (h <= 0) return;
    // 外枠の高さはこのあと組み直す。中身が伸び縮みするとブラウザが見た目の
    // 位置を保とうとして勝手にスクロールするので、元の位置に戻す
    // (開いた直後に先頭ではないところが出てしまう)。
    const keep = scroller.scrollTop;
    viewport.style.height = `${h}px`;

    // 対応表の末尾は「内容の総高さ」にする。スクロールできる量 (総高さ − 画面)
    // で止めると、基準点を画面の中ほどに置いたぶんだけ手前で頭打ちになる。
    const bEnd = before.scrollEl.scrollHeight;
    const aEnd = after.scrollEl.scrollHeight;

    bands = bandsOf(before, after);

    // 逃げ (bPad / aPad) は自分で足したものなので、中身の丈から外して測る
    const bBody = bEnd - bPad.offsetHeight;
    const aBody = aEnd - aPad.offsetHeight;

    // 末尾に「片側にしか無い差分」が続いているところは、下を左右で揃えない。
    //
    // 揃えてしまうと、短いほうは中身の終わりで行き止まりになり、最後まで
    // 送ったとき左右の下端がぴたりと合う。足された (消された) ぶんがどちらの
    // 文書のものか見えなくなるので、そこは揃えたくない。短いほうに逃げを
    // 持たせておけば、最後は片方が中身が尽きて空白、もう片方は続きの中身になる。
    //
    // 続いているぶんをまとめて見るのが肝。いちばん後ろの 1 つだけを見ると、
    // その手前で止まっていたぶんが数に入らず、逃げが足りない。
    let openFrom = bands.length;
    while (openFrom > 0) {
      const b = bands[openFrom - 1];
      if (b.bTop !== b.bBottom && b.aTop !== b.aBottom) break;
      openFrom--;
    }

    // 帯の端は本文の縁 — 差分の線が出ているところ。線は紙の枠に重ねて置いて
    // あるので (viewer.css の left/right: -1px)、外の端は紙の外枠にぴたりと
    // 揃う。そこから出せば線から素直に伸びる。
    //
    // 縦は逆に内枠が起点。線は紙の中に置く要素なので、その位置は内枠から
    // 数えた値になる (changeSpans も同じ)。offsetIn が返すのは外枠なので、
    // 枠の太さ (clientTop) を足さないと帯だけ 1px 上にずれる。
    //
    // 横だけは矩形で測る。offsetLeft / offsetWidth は整数に丸めた値なので、
    // 紙の幅が半端なところに来ると 0.5px ずれて髪の毛ほどの隙間が残る。
    // ずらしているのは縦だけなので、横は矩形で測っても transform の影響を
    // 受けない (縦は受けるので offsetIn のまま)。
    const bo = offsetIn(before.contentEl, viewport);
    const ao = offsetIn(after.contentEl, viewport);
    const vx = viewport.getBoundingClientRect().left;
    x0 = before.contentEl.getBoundingClientRect().right - vx;
    x1 = after.contentEl.getBoundingClientRect().left - vx;
    bY = bo.y + before.contentEl.clientTop;
    aY = ao.y + after.contentEl.clientTop;

    bPts = [0];
    aPts = [0];
    // 積んだ対応点が「変わったところの頭」かどうか。tPts と添字を揃える
    const isTop: boolean[] = [false];
    const push = (bv: number, av: number, top: boolean) => {
      // 補間できるよう、どちらも前の点より後ろに進むものだけを採る
      if (bv < bPts[bPts.length - 1] || av < aPts[aPts.length - 1]) return;
      if (bv > bBody || av > aBody) return;
      // 同じ位置が続いても意味が無い
      if (bv === bPts[bPts.length - 1] && av === aPts[aPts.length - 1]) return;
      bPts.push(bv);
      aPts.push(av);
      isTop.push(top);
    };

    // 対応点は帯の頭と尻。片側が点の帯 (まるごとの追加・削除) では、その側の
    // 頭と尻が同じ値になるので、そこで片方が止まって相手が流れる。
    // 末尾に続く片側だけの帯は尻を積まない — そこから下は逃げで丈を合わせるので、
    // 左右が同じだけ進み、短いほうは中身が尽きて空白になる。
    const points = bands.flatMap((b, i) =>
      i >= openFrom
        ? [{ b: b.bTop, a: b.aTop, top: true }]
        : [
            { b: b.bTop, a: b.aTop, top: true },
            { b: b.bBottom, a: b.aBottom, top: false },
          ]
    );

    // 左右それぞれで前へ進む順に並べてから積む (両側を別々に回しているので、
    // そのままでは順序が入れ替わり、補間が壊れる)
    points.sort((x, y) => x.b - y.b || x.a - y.a);
    for (const p of points) push(p.b, p.a, p.top);

    // 最後の対応点から下に残っている量を、左右で揃える。短いほうに足した
    // 逃げは本文の外に置くので、紙の丈は中身なりのまま。
    const bLast = bPts[bPts.length - 1];
    const aLast = aPts[aPts.length - 1];
    const slack = aBody - aLast - (bBody - bLast);
    bPad.style.height = `${Math.max(0, slack)}px`;
    aPad.style.height = `${Math.max(0, -slack)}px`;
    const bTotal = bBody + Math.max(0, slack);
    const aTotal = aBody + Math.max(0, -slack);
    bMax = Math.max(0, bTotal - h);
    aMax = Math.max(0, aTotal - h);

    bPts.push(bTotal);
    aPts.push(aTotal);
    isTop.push(false);
    if (bPts.length < 3) {
      bPts = [0, bTotal];
      aPts = [0, aTotal];
      isTop.length = 0;
      isTop.push(false, false);
    }

    // 外枠は「区間ごとに長い方」の積み上げ。こうするとどちらの中身も
    // 飛ばさずに読み切れる
    tPts = [0];
    for (let i = 1; i < bPts.length; i++) {
      const span = Math.max(bPts[i] - bPts[i - 1], aPts[i] - aPts[i - 1]);
      tPts.push(tPts[i - 1] + span);
    }
    track.style.height = `${tPts[tPts.length - 1]}px`;
    stops = tPts.filter((_, i) => isTop[i]);

    if (scroller.scrollTop !== keep) scroller.scrollTop = keep;
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
      // 行き先は変わったまとまりの頭 (rebuild で選り分けてある)
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
      bPad.remove();
      aPad.remove();
    },
  };
}
