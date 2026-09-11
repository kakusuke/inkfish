# 開発メモ

## README の書き方

README は**使う人が読むもの**。ユーザーから見てできることだけを書く。

- 機能は「できること」の節に、**構造化した箇条書き**でまとめる。
  「ファイルを開く」「フォルダを開く」のような入口を親にして、その下へぶら下げる
- 文章にしない。体言止めで端的に
- できて当然の機能 (検索・拡大・スクロールなど) や、細かい振る舞いは書かない
- ショートカットの一覧は載せない
- 実装の話 (使っているライブラリ、内部の構造、なぜそうしたか) は書かない。
  そういうものはこのファイルか、コードのコメントに置く

## 道具

版は `mise.toml` が持つ (node / rust)。手元と CI で同じものを使う。

```sh
mise install
npm install
```

## 動かす

```sh
npm run tauri dev
npm run tauri dev -- -- docs/spec.md   # 引数付きで起動する
```

## 確かめる

```sh
npx tsc --noEmit     # 型
npm run build        # tsc + vite build
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## ビルド

```sh
npm run tauri build          # 実行中のマシン向け
npm run build:mac            # macOS ユニバーサル (Intel + Apple Silicon)
```

生成物は `src-tauri/target/<target>/release/bundle/`。WebView は OS 標準のもの
(WKWebView / WebView2 / WebKitGTK) を使うので、配布物は数 MB に収まる。

`v*` タグを push すると、GitHub Actions が macOS / Windows / Linux のバイナリを
添付した Release を作る。

## 組み立て

描画はすべて WebView 側。Rust (`src-tauri/src/lib.rs`) はファイル I/O・監視・
ウィンドウ管理だけを担い、Tauri の IPC で繋ぐ。git の読み取りは
`src-tauri/src/git.rs` に分けてある。

WebView 側は「中身」と「ガワ」に分かれる。ガワはウィンドウの形式ごとに別の
ページで、中身はどちらにも同じものが載る。

| | |
|---|---|
| `src/viewer/` | 中身。`DocumentViewer` が container を受け取り、本文・スライド・図の拡大表示の DOM を自分で組む。Markdown 描画・Mermaid・Marp・front matter・差分・ページ内検索を持つ |
| `src/chrome/` | ガワの共通部品。ウィンドウ 1 つに 1 つあるもの (検索バー・設定・トースト・ウィンドウ切替・右クリックメニュー・PDF 書き出し・ファイル I/O・ウィンドウのドラッグ) |
| `src/shell/` | 単一文書ウィンドウのガワ (`index.html` + `AppShell`) |
| `src/project/` | プロジェクトウィンドウのガワ (`project.html` + `ProjectShell` + ツリー + タブ + git の変更)。タブごとに `DocumentViewer` を 1 つ持つ |
| `src/styles/` | `tokens.css` (トークン) / `viewer.css` (中身) / `chrome.css` (共通部品) / `shell.css`・`project.css` (ガワごと) |

依存は「ガワ → 中身」の一方通行。中身はガワを知らず、必要な通知はコールバック
(`onCaption` / `onNotice` / `onProgress` / `onFindUpdate` / `onLinkActivate`) で返す。
Tauri にも依存せず、相対パス画像の URL 変換は `resolveAsset` として注入する。

そのため中身だけを別の形式のウィンドウに載せられる。ガワは「窓の形式ごとに
変わる部分」なので、実行時に切り替えるのではなくページを分けてある
(`vite.config.ts` の 2 エントリ)。新しい形式を足すときは、自分の HTML に自分の
ガワを書いて `DocumentViewer` をマウントし、`tokens.css` + `viewer.css` を読む。
ツールバー分の上端の逃げは `--ink-chrome-top` で受け渡すので、ガワの無い窓では 0。
Rust 側の `capabilities/default.json` の `windows` に新しいラベルのパターンを
足すのを忘れないこと (忘れると `invoke` も `listen` も全部拒否される)。

## ひとつの document に中身を複数載せるとき

タブごとに `DocumentViewer` を持つため、共有ライブラリのシングルトンが衝突
しないようにしてある。

- **Mermaid** — 図の id は自分で振り、`mermaid.run()` ではなく
  `mermaid.render(id, …)` を 1 図ずつ呼ぶ。`run()` は呼び出しごとに id の採番器を
  作り直すため何度呼んでも同じ id が出てきて、描画の実処理は id を document
  全体から引き当てるので、**別のタブに残っている同じ id の SVG へ描き込んで
  しまう** (例外も出ないまま、こちらは空の箱になる)。加えて `initialize()` の
  テーマ設定はライブラリ全体で 1 本なので、描画はモジュールレベルのキューで
  直列化している
- **ページ内検索** — `CSS.highlights` のハイライト名はインスタンスごとの連番で、
  対応する `::highlight()` 規則は実行時に生成する
- **Marp** — `browser()` の戻り値は最初の container に束縛されるので、ハンドルは
  インスタンスごとに持つ
- **見出し・脚注の id** — `idPrefix` オプションで名前空間を分ける (既定は前置き
  なしなので、単一文書ウィンドウの id は素のまま)
- **非アクティブなタブ** — `setFrozen()` で凍結し、テーマ切替でタブの数だけ
  再描画が走らないようにしている

## ウィンドウをまたぐタブの受け渡し

macOS の `performWindowDragWithEvent:` は投げっぱなしで、どこで離したかを
アプリに知らせる手段がない (Tauri / tao / NSWindow デリゲートのどこにもドラッグ
終了イベントが無く、ドラッグ中の NSWindow はドラッグペーストボードにも何も
載せないので受け側にも届かない)。そのためドラッグは自前で持っている
(`src/chrome/windowdrag.ts`)。

前提として実測したこと:

- `pointermove` / `pointerup` はウィンドウの矩形外でも届き、client 座標は窓の
  サイズを超えて伸びる
- `event.screenX` / `screenY` はデスクトップ座標として正しい。一方
  `window.screenX` は当てにならないので、窓の原点は `screenX - clientX` で求める
- `<button>` や `role="tab"` の上では、Tauri のドラッグ領域も AppKit の
  タイトルバードラッグも発生しない (ウィンドウ上端でも効く)

ウィンドウの生成・移動・破棄はすべて Rust コマンド経由なので、`capabilities` に
`allow-create` / `allow-close` / `allow-set-position` は要らない。

## 差分の見せ方

差分は行で取れるが、見せるのはレンダリングした後の画面なので、その 2 つを結ぶ
物差しが要る。**差分と DOM 要素は結びつけない**。変わった行そのものを幅ゼロの
目印 (`.ink-at`) で挟み、行頭で上端・行末で下端を出す。2 つ合わせればその行が
画面で占める高さがそのまま出る。折り返しても画像が混ざっても合う。

ただし**測るのは目印そのものではなく、目印が挟んでいる中身** (`lineEdgeIn`)。
幅ゼロでも行の中では 1 つの箱なので、折り返しがちょうど行の頭に重なると、目印と
後ろの文字との間で折り返されて、目印だけが前の行の末尾に取り残される (和文は
どの文字の間でも折り返せる)。そのまま測ると線が 1 行手前から始まり、変わって
いない行を巻き込む。中身が無い空行だけは測りようがないので、そこは目印自身の
位置に戻す (`vertical-align`)。

コードブロックはハイライト済みの HTML が行をまたぐタグを持つため markdown-it の
段階では挿せないので、描画したあとにテキストノードを改行で割って挿む
(`markCodeLines`)。front matter は本文から剥がしてカードに組み直すので、変わった
行からキー名を拾って項目ごとに印を付ける (`frontMatterMarks`)。Marp は自前の
レンダラを通るので、差分ではスライドに組み替えずふつうの markdown として描く。

線・左右を結ぶ帯・スクロールの対応点は、すべて `changeSpans()` から出す。別々に
組み立てると、出し方の違いがそのままズレになって出る。

**近い差分をつなぐことはしない。ハンク 1 つが線 1 本。** つなぐと「どこまでを
1 本と見るか」の判断が要るが、画面の隙間で決めると折り返しが幅で変わるぶん
左右で答えが食い違い (左で 1 本・右で 2 本)、行で決めると画面の見た目と合わない。
そして食い違ったまま帯を作ると、範囲を丸ごと使えば重ねて塗って濃くなり、
細かく割れば線から端が外れる。つながなければ迷いが消えて、左右も必ず 1 対 1。
