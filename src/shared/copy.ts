// コピーする文字列の組み立て。
//
// 出すのは 2 つ。
//
//   パス   /Users/kakusuke/docs/guide.md
//   引数   diff:/9a1c…-/Users/kakusuke/docs/guide.md
//
// 引数の側は ID をそのまま渡す。inkfish は起点版・差分の ID も引数に取れる
// ので (Rust 側 cli_targets)、コマンドラインに貼ればその差分がそのまま開く。

import { splitDiff, splitRev } from "./rev";

/// ID から実ファイルの絶対パスを取り出す。起点版・差分も指しているファイルは
/// 1 つなので、終点側のパスを返す。
export function pathOf(id: string): string {
  const r = splitRev(id);
  if (r) return r.path;
  const d = splitDiff(id);
  return d ? pathOf(d.after) : id;
}

/// シェルが解釈する文字。これを含まなければ引用符は要らない。日本語などの
/// 非 ASCII は素のまま渡って問題ないので、パスと同じ文字列になり項目が畳まれる。
/// `%` と `^` は POSIX では無害だが cmd.exe が解釈するので入れてある。
const SPECIAL = /[\s"'`$&|;<>(){}[\]*?~!#\\^%]/;

/// コマンドラインの引数として貼れる形にする。上の文字を含むときだけ包む。
export function cliArg(id: string): string {
  if (!SPECIAL.test(id)) return id;
  // Windows は cmd / PowerShell とも二重引用符。中の " は重ねて逃がす
  if (navigator.userAgent.includes("Windows")) return `"${id.replace(/"/g, '""')}"`;
  return `'${id.replace(/'/g, "'\\''")}'`;
}
