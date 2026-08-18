# Inkfish 🦑

シンプルで軽量な Markdown ビューアー。Tauri v2 製。

エディタは付属していません。お好きなものをお使いください。

対応フォーマット:

- GitHub Flavored Markdown(テーブル / タスクリスト / 脚注 / シンタックスハイライト)
- YAML フロントマター(本文冒頭のメタ情報カードとして描画)
- Mermaid(既定の dagre に加えて ELK レイアウトも利用可)
- Marp スライド(フロントマターに `marp: true`)

## フロントマター

先頭の `---` … `---` は YAML として読み、本文冒頭のカードにまとめて表示します。
`title` はカードの見出しに加えて、ツールバーとウィンドウタイトルにも使われます
(ファイル名は tooltip に残ります)。

`title` / `description`・`intro`・`subtitle`・`summary` / `date`・`updated`・`author` /
`tags`・`categories`・`keywords`・`topics` は決まった位置と見せ方で描き、
それ以外のキーは書かれた順のまま `key: value` の行として並べます。
特定のスキーマに縛らないので、どんなキーでも情報が消えません。

YAML として読めなかったときは、隠さずソースのまま描いて通知します。
先頭が水平線の `---` や setext 見出しをフロントマターと読み違えることはありません。

Mermaid で ELK レイアウトを使うには、図のフロントマターで指定します:

````md
```mermaid
---
config:
  layout: elk
---
flowchart LR
  A --> B --> C
```
````

`layout` には `elk`(階層レイアウト)/ `elk.stress` / `elk.force` / `elk.mrtree` / `elk.sporeOverlap` が指定できます。

## 開発

```sh
npm install
npm run tauri dev
```

## ビルド

```sh
# 実行中のマシン向け
npm run tauri build

# macOS ユニバーサルバイナリ (Intel + Apple Silicon)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac
```

生成物は `src-tauri/target/<target>/release/bundle/` に出力されます。WebView は OS 標準のもの(WKWebView / WebView2 / WebKitGTK)を使うため、配布物は数 MB に収まります。

`v*` タグを push すると、GitHub Actions が macOS / Windows / Linux のバイナリを添付した Release を作成します。

## アーキテクチャ

描画はすべて WebView(`src/main.ts`)側、Rust(`src-tauri/src/lib.rs`)側はファイル I/O・監視・ウィンドウ管理のみを担い、Tauri の IPC で連携します。

## ライセンス

[MIT](LICENSE)
