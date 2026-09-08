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
