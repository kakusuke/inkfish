// 起点版 (git のある地点でのファイル) を指す ID。
//
// タブではファイルパスと同じ位置に入る。そのおかげで「同じものは同じタブ」の
// 判定・ウィンドウ切替の一覧・タブの切り離しが、パスのときと同じ仕組みで動く。
// Rust 側の台帳も canonicalize に失敗した文字列はそのまま持つので手当ては要らない。
//
//   rev:/<sha>/Users/kakusuke/docs/keep.md     (POSIX)
//   rev:/<sha>/C:/Users/kakusuke/docs/keep.md  (Windows)
//
// スラッシュ区切りのパスと同じ形にしてあるので、shared/paths.ts の
// basename / dirname / resolvePath がそのまま通る (相対画像や相対リンクの
// 解決も、起点版の中で閉じたまま動く)。
//
// ref 名ではなく解決済みの SHA を焼くのは、`main` のような名前だと後で
// 別の中身を指してしまい、同じ ID が同じ内容を指す保証が崩れるため。

const PREFIX = "rev:/";

export const isRev = (id: string) => id.startsWith(PREFIX);

export const revId = (sha: string, abs: string) => `${PREFIX}${sha}/${abs.replace(/^\//, "")}`;

export function splitRev(id: string): { sha: string; path: string } | null {
  if (!isRev(id)) return null;
  const rest = id.slice(PREFIX.length);
  const i = rest.indexOf("/");
  if (i <= 0) return null;
  const sha = rest.slice(0, i);
  const tail = rest.slice(i + 1);
  if (!tail) return null;
  // POSIX は先頭のスラッシュを戻す (Windows の "C:/…" はそのまま)
  return { sha, path: /^[a-z]:/i.test(tail) ? tail : `/${tail}` };
}

/// WebView が読める URL に直す。
///
/// Tauri はカスタムスキームを Windows で `http://<scheme>.localhost/…` に
/// 読み替えるので、こちらも同じ形に合わせる (asset プロトコルと同じ事情)。
/// ID の側に localhost を入れたくないので、変換はここ 1 箇所に閉じてある。
export function revAssetUrl(sha: string, path: string): string {
  const rest = encodeURI(path.replace(/^\//, ""));
  return navigator.userAgent.includes("Windows")
    ? `http://rev.localhost/${sha}/${rest}`
    : `rev://localhost/${sha}/${rest}`;
}

/// 絶対パスと ID のどちらでも、WebView に貼れる URL にする。
/// ガワが `resolveAsset` として注入するための下ごしらえ。
export function assetUrl(idOrPath: string, convertFileSrc: (p: string) => string): string {
  const r = splitRev(idOrPath);
  return r ? revAssetUrl(r.sha, r.path) : convertFileSrc(idOrPath);
}

// ---------- 2 つの版を並べて見る ----------
//
// 起点版と同じ考えで、差分そのものにも ID を与える。こうすると差分タブも
// 「1 つの ID を開いているタブ」になり、切り離しても取り込んでも、ふつうの
// ファイルと同じ道を通る (単一文書ウィンドウでも左右に並ぶ)。
//
//   diff:/<起点 sha>-<終点 sha>/Users/…/docs/guide.md
//   diff:/<起点 sha>-/Users/…/docs/guide.md   ← 終点が作業ツリーなら後ろは空
//
// sha は 40 桁の 16 進なのでハイフンを含まず、1 つ目の区切りで割れる。

const DIFF_PREFIX = "diff:/";

export const isDiff = (id: string) => id.startsWith(DIFF_PREFIX);

export const diffId = (beforeSha: string, afterSha: string, abs: string) =>
  `${DIFF_PREFIX}${beforeSha}-${afterSha}/${abs.replace(/^\//, "")}`;

/// 差分の ID を、左右それぞれの ID に割る。
/// 終点の sha が空なら、右は実ファイルのパスになる。
export function splitDiff(id: string): { before: string; after: string } | null {
  if (!isDiff(id)) return null;
  const rest = id.slice(DIFF_PREFIX.length);
  const i = rest.indexOf("/");
  if (i <= 0) return null;
  const [beforeSha, afterSha = ""] = rest.slice(0, i).split("-");
  if (!beforeSha) return null;
  const tail = rest.slice(i + 1);
  if (!tail) return null;
  // POSIX は先頭のスラッシュを戻す (Windows の "C:/…" はそのまま)
  const abs = /^[a-z]:/i.test(tail) ? tail : `/${tail}`;
  return { before: revId(beforeSha, abs), after: afterSha ? revId(afterSha, abs) : abs };
}

/// 実体がディスクに無い ID (起点版・差分)。監視や正規化の対象から外す。
export const isVirtual = (id: string) => isRev(id) || isDiff(id);
