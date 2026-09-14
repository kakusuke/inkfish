# 開発メモ

## README の書き方

README は**使う人が読むもの**。ユーザーから見てできることだけを書く。

- 機能は「できること」の節に、**構造化した箇条書き**でまとめる。
  「ファイルを開く」「フォルダを開く」のような入口を親にして、その下へぶら下げる
- 文章にしない。体言止めで端的に
- できて当然の機能 (検索・拡大・スクロールなど) や、細かい振る舞いは書かない。
  機能を足したからといって README に足さない。載せるのは「それがあるから使う」と
  言える水準のものだけ (パスのコピーのような補助は書かない)
- ショートカットの一覧は載せない
- 実装の話 (使っているライブラリ、内部の構造、なぜそうしたか) は書かない。
  そういうものはコードのコメントに置く

## このファイルの書き方

**前提と規則だけを置く。実装の記録は書かない。** なぜそう実装したか、何を実測
したか、どんな罠があるかは、その場所のコードのコメントに書く。ここへ写すと
二重管理になり、片方だけ直してずれる。

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

描画はすべて WebView 側。Rust (`src-tauri/`) はファイル I/O・監視・ウィンドウ
管理だけを担い、Tauri の IPC で繋ぐ。

WebView 側は「中身」と「ガワ」に分かれる。ガワは窓の形式ごとに別のページで
(`vite.config.ts` の 2 エントリ)、中身はどちらにも同じものが載る。

| | |
|---|---|
| `src/viewer/` | 中身。`DocumentViewer` が container を受け取って DOM を組む |
| `src/chrome/` | ガワの共通部品 (ウィンドウ 1 つに 1 つあるもの) |
| `src/shell/` | 単一文書ウィンドウのガワ |
| `src/project/` | プロジェクトウィンドウのガワ。タブごとに `DocumentViewer` を 1 つ持つ |
| `src/styles/` | `tokens.css` / `viewer.css` (中身) / `chrome.css` (共通部品) / ガワごと |

**依存は「ガワ → 中身」の一方通行。** 中身はガワも Tauri も知らない。必要な通知は
コールバックで返し、Tauri に触る部分は注入して受け取る。この向きが保たれている
限り、中身はそのまま別の形式の窓に載る。

新しい形式の窓を足すときは、自分の HTML に自分のガワを書いて `DocumentViewer` を
マウントする。`capabilities/default.json` の `windows` に新しいラベルのパターンを
足すのを忘れないこと (忘れると `invoke` も `listen` も全部拒否される)。

## 気をつけるところ

守ること と どこを見るか だけ。理由と実測はコード側にある。

- **タブごとに `DocumentViewer` を持つ**ので、共有ライブラリのシングルトンが
  衝突する。Mermaid の図の id・ページ内検索のハイライト名・Marp のハンドル・
  見出しや脚注の id は、インスタンスごとに分けること
  (`viewer/mermaid.ts` `viewer/find.ts` `viewer/marp.ts` の冒頭に事情がある)
- **ウィンドウのドラッグは自前** (`chrome/windowdrag.ts`)。OS 側にドラッグ終了を
  知る手段が無いため。生成・移動・破棄は Rust コマンド経由なので、`capabilities`
  に `allow-create` などは要らない
- **差分と DOM 要素は結びつけない。** 変わった行を幅ゼロの目印で挟み、DOM は
  「行がどこに描かれたか」を答えるだけにする (`viewer/markdown.ts` の冒頭)
- **線・左右を結ぶ帯・スクロールの対応点は、すべて `changeSpans()` から出す。**
  別々に組み立てると、出し方の違いがそのままズレになって出る。近い差分はつながず、
  ハンク 1 つが線 1 本
