# Inkfish 🦑

GFM(Mermaid 込み)と Marp に対応した、軽量な Markdown ビューアー。Tauri v2 製。

「イカ(inkfish)が墨で書いたものを読む」ための道具です。エディタは内包しません — 好きなエディタで書いて、保存すれば即座に再描画されます。

## 機能

- **GitHub Flavored Markdown** — テーブル、タスクリスト、脚注、シンタックスハイライト(highlight.js)
- **Mermaid** — ` ```mermaid ` ブロックを図として描画(ライト/ダークテーマ自動追従)
- **Marp** — フロントマターに `marp: true` があるファイルは自動でスライド表示に切り替え
- **自動再描画** — ファイルの変更を監視し、保存すると即座に再レンダリング(スクロール位置は維持)
- **外部エディタ連携** — エディタは内包せず、好きなエディタを起動(⌘E)。コマンドは設定でカスタマイズ可能
- ドラッグ&ドロップ / ⌘O / CLI 引数 / Finder の「このアプリケーションで開く」でファイルを開く(.md / .markdown / .mdown / .mkd / .mdx に関連付け)
- 相対パスの画像、md ファイル間の相対リンクにも対応
- ライト/ダークテーマ自動切替、⌘+/− で文字サイズ変更

## 開発

```sh
npm install
npm run tauri dev
```

CLI 引数付きで起動する場合:

```sh
npm run tauri dev -- -- -- /path/to/file.md
```

## ビルド

```sh
# 実行中のマシン向け
npm run tauri build

# macOS ユニバーサルバイナリ (Intel + Apple Silicon)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac

# アーキテクチャ個別
npm run build:mac-arm    # Apple Silicon
npm run build:mac-intel  # Intel
```

`src-tauri/target/<target>/release/bundle/` に .app / .dmg が生成されます。

### クロスプラットフォームビルド (CI)

`.github/workflows/build.yml` で macOS(ユニバーサル)/ Windows / Linux を GitHub Actions 上でビルドします。

- `v*` タグを push → 3 プラットフォームのバイナリ付きで GitHub Release を作成
- 手動実行(workflow_dispatch)→ ビルドのみ

WebView はランタイム同梱ではなく OS のもの(WKWebView / WebView2 / WebKitGTK)を使うため、配布物は数 MB に収まります。

## エディタ設定

ツールバーの歯車アイコンから外部エディタのコマンドを設定できます。`{path}` がファイルパスに置き換わります(省略時は末尾に付加)。

| エディタ | コマンド例 |
| --- | --- |
| VS Code | `code {path}` |
| Sublime Text | `subl {path}` |
| macOS デフォルト | `open -t {path}`(初期値) |
| GUI 版 Vim | `mvim {path}` |

## アイコン

`src-tauri/icons/icon.svg` が原本です。変更したら以下で全サイズを再生成します:

```sh
rsvg-convert -w 1024 -h 1024 src-tauri/icons/icon.svg -o /tmp/icon.png
npm run tauri icon /tmp/icon.png
```

## アーキテクチャ

```
Rust (src-tauri)             WebView (src)
├─ read_md_file    ← IPC →   ├─ markdown-it + plugins (GFM)
├─ watch_file (notify)       ├─ mermaid(遅延ロード)
│    └─ "md:changed" emit →  ├─ @marp-team/marp-core(遅延ロード)
├─ open_in_editor            ├─ highlight.js + DOMPurify
└─ get_cli_file              └─ ファイル監視イベントで再描画
```

描画はすべて WebView 側、Rust 側はファイル I/O・監視・プロセス起動のみの薄い構成です。
