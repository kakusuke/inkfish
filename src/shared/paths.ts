// パス操作。ビューア (画像・相対リンクの解決) とガワ (ファイル名の切り出し) の
// 両方が使うため共有に置く。
//
// Windows のパスは `\` 区切り (`C:\dir\doc.md`) で `/` も区切りとして通るが、
// POSIX ではファイル名に `\` を含められる。どちらの形式かを先頭
// (ドライブレター / UNC) で判定してから区切り文字を決める必要がある。
export const isWinPath = (p: string) => /^([a-z]:|\\\\)/i.test(p);
// 分割用の区切り。Windows は `\` と `/` の両方を区切りとして扱う
const sepRe = (p: string) => (isWinPath(p) ? /[\\/]/ : /\//);
// 結合用の区切り。Windows でも元が `/` だけなら `/` のまま揃える
const joinSep = (p: string) => (isWinPath(p) && p.includes("\\") ? "\\" : "/");
// 絶対パスか (Windows: `C:\…` `\…` `\\host\…` / POSIX: `/…`)
const isAbsPath = (p: string, win: boolean) =>
  win ? /^([\\/]|[a-z]:[\\/])/i.test(p) : p.startsWith("/");
// URL のスキーム。1 文字のものは Windows のドライブレターなので除く
export const SCHEME = /^([a-z][a-z0-9+.-]+:|\/\/)/i;

function lastSepIndex(p: string): number {
  return isWinPath(p) ? Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) : p.lastIndexOf("/");
}

export function dirname(p: string): string {
  const i = lastSepIndex(p);
  return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(lastSepIndex(p) + 1);
}

// dir (md ファイルのあるディレクトリ) を起点に rel を解決する。
// 区切り文字の扱いは dir の形式 (Windows / POSIX) に合わせる。
export function resolvePath(dir: string, rel: string): string {
  const win = isWinPath(dir);
  if (isAbsPath(rel, win)) return rel;
  const re = sepRe(dir);
  const stack = dir.split(re);
  for (const seg of rel.split(re)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join(joinSep(dir));
}
