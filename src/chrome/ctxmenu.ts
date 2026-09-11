// 右クリックのメニュー。ウィンドウに 1 つ。
//
// ポップオーバー (chrome/popover.ts) とは開き方が違う。開くきっかけがボタン
// ではなくカーソルの位置なので、開閉と外側クリックの処理を別に持っている。
// 中身は開くたびに組む — 項目の有効・無効や副題が対象の行ごとに変わるため。

import { cliArg, pathOf } from "../shared/copy";

export type MenuItem =
  | "sep"
  | {
      label: string;
      /// 右端に小さく出す副題 (端点の名前など)
      note?: string;
      disabled?: boolean;
      run: () => void;
    };

export class ContextMenu {
  private el: HTMLElement;
  private items: MenuItem[] = [];

  constructor(host: HTMLElement = document.body) {
    this.el = document.createElement("div");
    this.el.className = "ink-menu hidden";
    this.el.setAttribute("role", "menu");
    host.append(this.el);

    this.el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".ink-mi");
      if (!btn || btn.disabled) return;
      const item = this.items[Number(btn.dataset.i)];
      // 閉じてから走らせる。開く側 (別のタブなど) がメニューより後に来る
      this.close();
      if (item && item !== "sep") item.run();
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.el.contains(e.target as Node)) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    // 位置決めが崩れるのでリサイズでは閉じる
    window.addEventListener("resize", () => this.close());
  }

  /// カーソルの位置に開く。座標は client。
  open(items: MenuItem[], x: number, y: number) {
    if (!items.length) return;
    this.items = items;
    this.el.replaceChildren(...items.map((it, i) => this.row(it, i)));
    this.el.classList.remove("hidden");
    // 画面の外へ出ないよう、出してから実寸を測って位置を決める
    const r = this.el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    this.el.style.left = `${Math.round(Math.max(4, left))}px`;
    this.el.style.top = `${Math.round(Math.max(4, top))}px`;
  }

  close() {
    if (this.el.classList.contains("hidden")) return;
    this.el.classList.add("hidden");
    this.items = [];
  }

  private row(it: MenuItem, i: number): HTMLElement {
    if (it === "sep") {
      const sep = document.createElement("div");
      sep.className = "ink-mi-sep";
      sep.setAttribute("role", "separator");
      return sep;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ink-mi";
    btn.setAttribute("role", "menuitem");
    btn.dataset.i = String(i);
    btn.disabled = !!it.disabled;
    const label = document.createElement("span");
    label.className = "ink-mi-label";
    label.textContent = it.label;
    btn.append(label);
    if (it.note) {
      const note = document.createElement("span");
      note.className = "ink-mi-note";
      note.textContent = it.note;
      btn.append(note);
    }
    return btn;
  }
}

/// パスと、コマンドラインに貼れる引数。ヘッダー・タブ・ツリーの行・変更の行で
/// 同じ 2 つを出す。ふつうのファイルでは 2 つが同じ文字列になるので、
/// そのときは 1 つに畳む (差が出るのは起点版と差分)。
export function copyItems(id: string, notify: (msg: string) => void): MenuItem[] {
  const path = pathOf(id);
  const arg = cliArg(id);
  const items: MenuItem[] = [
    { label: "パスをコピー", run: () => void copyText(path, "パス", notify) },
  ];
  if (arg !== path) {
    items.push({ label: "inkfish の引数をコピー", run: () => void copyText(arg, "引数", notify) });
  }
  return items;
}

async function copyText(text: string, what: string, notify: (msg: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what}をコピーしました`);
  } catch (e) {
    notify(`コピーできませんでした: ${e}`);
  }
}
