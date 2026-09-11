mod git;

use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// パスの正規化。`std::fs::canonicalize` の代わりに必ずこちらを使う。
///
/// Windows の `std::fs::canonicalize` は `\\?\C:\dir\doc.md` (verbatim prefix 付き)
/// を返す。この形式は Win32 のパス正規化が働かず `/` を区切りとして扱えないため、
/// この文字列をフロントへ渡すと JS 側でディレクトリを切り出して相対パスを結合する
/// 処理 (md 内の画像・相対リンク) が成立しなくなる。dunce は安全に戻せる場合だけ
/// 通常形式 (`C:\dir\doc.md`) に変換する (260 文字超や予約名は verbatim のまま)。
/// 非 Windows では `std::fs::canonicalize` と同じ。
///
/// 台帳 (OpenTabs) の突き合わせのため、正規化は全箇所でこの関数に揃える。
fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// 実体がディスクに無い ID の接頭辞。起点版 (rev:/<sha>/…) と、2 つの版を
/// 並べて見る差分 (diff:/<sha>-<sha>/…)。どちらもフロントではタブのパスと
/// 同じ位置に入るので、ファイルを触る手前で見分けて、正規化も監視もしない。
const VIRTUAL_PREFIXES: [&str; 2] = ["rev:/", "diff:/"];

fn is_virtual_id(path: &str) -> bool {
    VIRTUAL_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// タブが指すものを PathBuf にする。実体の無い ID はそのまま持つ。
fn tab_target(path: &str) -> std::io::Result<PathBuf> {
    if is_virtual_id(path) {
        return Ok(PathBuf::from(path));
    }
    canonicalize(path)
}

/// ウィンドウ 1 つぶんの監視。
///
/// notify の watcher は 1 つで複数のパスを監視できるので、そのウィンドウが
/// 開いているタブの親ディレクトリをまとめて 1 つの watcher に載せる。
/// (ファイル自体ではなく親を見るのは、エディタの atomic save が rename で
/// 差し替えるため。対象パスの絞り込みは通知側で行う)
struct WindowWatch {
    watcher: RecommendedWatcher,
    /// 今 watch しているディレクトリ。タブが変わったときの差分更新に使う。
    /// (プロジェクトのルートは再帰監視なので別に持つ)
    dirs: HashSet<PathBuf>,
    /// 今 watch しているプロジェクトのルート
    root: Option<PathBuf>,
    /// watcher のクロージャが読む対象。差し替えるので Arc + Mutex。
    targets: Arc<Mutex<WatchTargets>>,
}

/// watcher のクロージャが「何を通知すべきか」を決めるための情報。
#[derive(Default)]
struct WatchTargets {
    /// 中身が変わったら md:changed を出すファイル (開いているタブ)
    files: HashSet<PathBuf>,
    /// 配下の md / ディレクトリが増減したら tree:changed を出すルート
    root: Option<PathBuf>,
}

/// ウィンドウごとの監視 (label -> WindowWatch)。
/// エントリを落とすと watcher が drop され、OS 側の監視も解除される。
#[derive(Default)]
struct WatchState(Mutex<HashMap<String, WindowWatch>>);

/// ウィンドウが開いているタブ 1 つ。
#[derive(Clone)]
struct Tab {
    /// 正規化済みの絶対パス
    path: PathBuf,
    /// front matter の title かファイル名。ウィンドウ切替の一覧に出す。
    caption: String,
}

/// ウィンドウが開いているタブの列と、そのうちどれを選んでいるか。
#[derive(Clone, Default)]
struct WindowTabs {
    tabs: Vec<Tab>,
    active: usize,
}

/// 各ウィンドウが開いているタブ (label -> タブ列)。
/// 「同じファイルは同じウィンドウ」を保証するための台帳。
/// 単一文書のウィンドウはタブ 1 つ、プロジェクトウィンドウは 0 個以上。
#[derive(Default)]
struct OpenTabs(Mutex<HashMap<String, WindowTabs>>);

/// プロジェクトウィンドウが開いているルートディレクトリ (label -> root)。
/// ここに載っている label が「プロジェクトウィンドウ」の定義でもある。
#[derive(Default)]
struct ProjectRoots(Mutex<HashMap<String, PathBuf>>);

/// プロジェクトウィンドウが起動時に開くルート (label -> root)。
/// PendingOpen と同じく、JS が立ち上がる前に決まった分をここで受け渡す。
#[derive(Default)]
struct PendingProject(Mutex<HashMap<String, String>>);

/// ウィンドウが起動時に開くべきファイル (label -> path)。
/// WebView の JS が立ち上がる前に届いた分をここに保持し、
/// フロントエンドが get_startup_file で取り出す。
#[derive(Default)]
struct PendingOpen(Mutex<HashMap<String, String>>);

/// 追加ウィンドウのラベル採番用
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

/// 追加ウィンドウをずらす量 (論理ピクセル)
const CASCADE_STEP: f64 = 28.0;

/// 単一文書ウィンドウの既定サイズ (論理ピクセル)。
/// 切り離しの位置をモニタ内へ収める計算にも使う。
const VIEWER_W: f64 = 1100.0;
const VIEWER_H: f64 = 840.0;

/// このビューアーで開く拡張子。フロントの isMarkdownPath と揃える。
/// (bundle の fileAssociations もこの一覧に合わせてある)
const MD_EXTS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mdx"];

pub(crate) fn is_markdown_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.iter().any(|m| e.eq_ignore_ascii_case(m)))
        .unwrap_or(false)
}

/// ツリー走査の上限。巨大なディレクトリを指定されたときに固まらないようにする。
/// 超えたら打ち切って truncated を返し、フロントは自動更新をやめて手動に落とす。
const TREE_MAX_DEPTH: usize = 12;
const TREE_MAX_FILES: usize = 5000;

#[tauri::command]
fn read_md_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// このウィンドウの watcher を用意する (無ければ作る)。
///
/// 1 ウィンドウ = watcher 1 つ。開いているタブの親ディレクトリと
/// プロジェクトのルートを、同じ watcher に載せる。
fn ensure_watch<'a>(
    app: &AppHandle,
    map: &'a mut HashMap<String, WindowWatch>,
    label: &str,
) -> Result<&'a mut WindowWatch, String> {
    match map.entry(label.to_string()) {
        Entry::Occupied(e) => Ok(e.into_mut()),
        Entry::Vacant(v) => {
            let targets: Arc<Mutex<WatchTargets>> = Arc::new(Mutex::new(WatchTargets::default()));
            let watched = Arc::clone(&targets);
            let emit_label = label.to_string();
            let app = app.clone();
            let watcher = notify::recommended_watcher(
                move |res: notify::Result<notify::Event>| {
                    let Ok(event) = res else { return };
                    use notify::EventKind::*;
                    if !matches!(event.kind, Create(_) | Modify(_) | Remove(_)) {
                        return;
                    }
                    let t = watched.lock().unwrap();

                    // 開いているファイルの中身が変わった
                    for path in event.paths.iter().filter(|p| t.files.contains(*p)) {
                        let _ = app.emit_to(
                            emit_label.as_str(),
                            "md:changed",
                            path.to_string_lossy().into_owned(),
                        );
                    }

                    let Some(root) = t.root.as_ref() else { return };

                    // .git の中身は git の状態にだけ関わり、ツリーの構造とは無関係。
                    // 以前はここを分けておらず、拡張子の無いファイル (.git/index など) を
                    // ディレクトリ操作と見なして tree:changed を出していた
                    // — コミットのたびにツリーを作り直していたことになる。
                    // objects/** と *.lock は fetch や gc で大量に動くだけなので捨てる。
                    // worktree や submodule では .git がファイルで実体は別の場所にあるため
                    // 届かない。そのときは変更ペインの手動更新に頼る。
                    let git_dir = root.join(".git");
                    if event.paths.iter().any(|p| p.starts_with(&git_dir)) {
                        let objects = git_dir.join("objects");
                        let meaningful = event.paths.iter().any(|p| {
                            p.starts_with(&git_dir)
                                && !p.starts_with(&objects)
                                && p.extension().map_or(true, |e| e != "lock")
                        });
                        if meaningful {
                            let _ = app.emit_to(emit_label.as_str(), "git:changed", ());
                        }
                        return;
                    }

                    // md の中身が変われば、木は変わらなくても git の状態は変わる
                    if event
                        .paths
                        .iter()
                        .any(|p| p.starts_with(root) && is_markdown_path(p))
                    {
                        let _ = app.emit_to(emit_label.as_str(), "git:changed", ());
                    }

                    // ツリーの見た目が変わりうるのは md / ディレクトリの増減だけ。
                    // 中身の変更 (Modify(Data)) では木は変わらないので出さない。
                    // 拡張子つきで md でないものは、エディタの一時ファイル
                    // (`.swp` / `~`) を弾くために除く。
                    let structural = matches!(
                        event.kind,
                        Create(_) | Remove(_) | Modify(notify::event::ModifyKind::Name(_))
                    );
                    if !structural {
                        return;
                    }
                    let relevant = event.paths.iter().any(|p| {
                        p.starts_with(root)
                            && (is_markdown_path(p) || p.extension().is_none())
                    });
                    if relevant {
                        let _ = app.emit_to(emit_label.as_str(), "tree:changed", ());
                    }
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(v.insert(WindowWatch {
                watcher,
                dirs: HashSet::new(),
                root: None,
                targets,
            }))
        }
    }
}

/// このウィンドウが開いているファイルの変更監視を張り直す。
///
/// エディタの atomic save (rename で差し替え) を拾うため、ファイル自体ではなく
/// 親ディレクトリを監視し、通知は対象パスだけに絞る。タブが増減するたびに
/// 呼ばれるので、watcher は作り直さずディレクトリを差分で足し引きする。
///
/// 通知 (`md:changed`) は監視を要求したウィンドウにだけ、変更されたパスを
/// 添えて届く。1 ウィンドウが複数のファイルを開くため、どれが変わったかを
/// 受け側が判別できる必要がある。
#[tauri::command]
fn watch_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.iter().filter_map(|p| canonicalize(p).ok()).collect();
    let dirs: HashSet<PathBuf> = files
        .iter()
        .filter_map(|p| p.parent().map(|d| d.to_path_buf()))
        .collect();

    let mut map = state.0.lock().unwrap();
    let entry = ensure_watch(&app, &mut map, window.label())?;

    // 監視ディレクトリを差分更新する (先に集めてから触るのは、
    // dirs を読みながら watcher と dirs を書き換えられないため)。
    // プロジェクトのルート配下は再帰監視で既に見ているので重ねない。
    let root = entry.root.clone();
    let covered = |d: &PathBuf| root.as_ref().is_some_and(|r| d.starts_with(r));
    let wanted: HashSet<PathBuf> = dirs.into_iter().filter(|d| !covered(d)).collect();

    let gone: Vec<PathBuf> = entry.dirs.difference(&wanted).cloned().collect();
    for dir in gone {
        let _ = entry.watcher.unwatch(&dir);
        entry.dirs.remove(&dir);
    }
    let added: Vec<PathBuf> = wanted.difference(&entry.dirs).cloned().collect();
    for dir in added {
        entry
            .watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        entry.dirs.insert(dir);
    }
    entry.targets.lock().unwrap().files = files.into_iter().collect();
    Ok(())
}

/// プロジェクトのルートを再帰監視して、配下の md / ディレクトリの増減を
/// `tree:changed` で知らせる。ルートを開いたときに 1 度だけ呼ぶ。
///
/// ツリーが上限に当たった (truncated) ときはフロントがこれを呼ばず、
/// 手動更新に落とす。巨大なツリーの再帰監視は費用が読めないため。
#[tauri::command]
fn watch_tree(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, WatchState>,
    root: String,
) -> Result<(), String> {
    let root = canonicalize(&root).map_err(|e| e.to_string())?;
    let mut map = state.0.lock().unwrap();
    let entry = ensure_watch(&app, &mut map, window.label())?;

    if entry.root.as_ref() == Some(&root) {
        return Ok(());
    }
    if let Some(old) = entry.root.take() {
        let _ = entry.watcher.unwatch(&old);
    }
    entry
        .watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // ルート配下を再帰で見るようになったので、重複する個別のディレクトリ監視を外す
    let dup: Vec<PathBuf> = entry
        .dirs
        .iter()
        .filter(|d| d.starts_with(&root))
        .cloned()
        .collect();
    for dir in dup {
        let _ = entry.watcher.unwatch(&dir);
        entry.dirs.remove(&dir);
    }

    entry.root = Some(root.clone());
    entry.targets.lock().unwrap().root = Some(root);
    Ok(())
}


// ---------- プロジェクトペインのツリー ----------

/// ツリーの節。ディレクトリなら children を持つ。
#[derive(serde::Serialize)]
struct TreeNode {
    name: String,
    /// 絶対パス。フロントはこれをそのまま open_path へ渡す。
    path: String,
    /// ディレクトリか
    dir: bool,
    children: Vec<TreeNode>,
}

#[derive(serde::Serialize)]
struct MdTree {
    root: String,
    children: Vec<TreeNode>,
    /// 見つかった md の件数
    files: usize,
    /// 上限に当たって打ち切ったか。フロントは監視をやめて手動更新に落とす。
    truncated: bool,
}

/// 中間表現。相対パスを積んでから木に組み直す。
#[derive(Default)]
struct TreeBuilder {
    dirs: HashMap<String, TreeBuilder>,
    files: Vec<String>,
}

impl TreeBuilder {
    fn insert(&mut self, segments: &[String]) {
        match segments {
            [] => {}
            [name] => self.files.push(name.clone()),
            [head, rest @ ..] => self.dirs.entry(head.clone()).or_default().insert(rest),
        }
    }

    /// ディレクトリを先に、それぞれ名前順 (大文字小文字を無視) で並べる。
    fn into_nodes(self, base: &Path) -> Vec<TreeNode> {
        let mut dirs: Vec<(String, TreeBuilder)> = self.dirs.into_iter().collect();
        dirs.sort_by_key(|(n, _)| n.to_lowercase());
        let mut files = self.files;
        files.sort_by_key(|n| n.to_lowercase());

        let mut out = Vec::with_capacity(dirs.len() + files.len());
        for (name, sub) in dirs {
            let path = base.join(&name);
            let children = sub.into_nodes(&path);
            out.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                dir: true,
                children,
            });
        }
        for name in files {
            let path = base.join(&name);
            out.push(TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                dir: false,
                children: Vec::new(),
            });
        }
        out
    }
}

/// ルート配下の md ファイルと、それを子孫に持つディレクトリだけの木を返す。
///
/// 走査は ignore クレート (ripgrep と同じもの) に任せる。既定で
/// ドット始まりを除外し `.gitignore` / `.git/info/exclude` / グローバル
/// 無視設定を尊重するので、node_modules や dist は自然に消える。
/// シンボリックリンクは辿らない (リンクのループで無限走査になるため)。
///
/// md を子孫に持たないディレクトリは、md ファイルのパスだけを積んで
/// 木に組み直すので結果として現れない。
#[tauri::command]
fn read_md_tree(path: String) -> Result<MdTree, String> {
    let root = canonicalize(&path).map_err(|e| format!("開けません: {e}"))?;
    if !root.is_dir() {
        return Err("ディレクトリではありません".into());
    }

    let mut builder = TreeBuilder::default();
    let mut files = 0usize;
    let mut truncated = false;

    for entry in WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(TREE_MAX_DEPTH))
        .build()
    {
        // 読めないディレクトリは黙って飛ばす (権限が無いだけのことが多い)
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if !is_markdown_path(entry.path()) {
            continue;
        }
        if files >= TREE_MAX_FILES {
            truncated = true;
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let segments: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        builder.insert(&segments);
        files += 1;
    }

    Ok(MdTree {
        children: builder.into_nodes(&root),
        root: root.to_string_lossy().into_owned(),
        files,
        truncated,
    })
}

/// フロントが自分のタブ構成を丸ごと申告する。
///
/// タブの追加・削除・並べ替え・選択の移動・キャプションの更新をこれ 1 つで扱う。
/// 差分ではなく全体を渡させるのは、そのほうが冪等で取りこぼしが無いため。
/// 単一文書のウィンドウはタブ 1 つとして申告する。
#[tauri::command]
fn set_window_tabs(window: tauri::WebviewWindow, tabs: Vec<TabInput>, active: usize) {
    let app = window.app_handle();
    let tabs: Vec<Tab> = tabs
        .into_iter()
        .map(|t| Tab {
            // 台帳の突き合わせのため必ず正規化する。解決できないパス
            // (削除された等) はそのまま入れて、少なくとも一覧には出す。
            path: canonicalize(&t.path).unwrap_or_else(|_| PathBuf::from(&t.path)),
            caption: t.caption,
        })
        .collect();
    let empty = tabs.is_empty();

    app.state::<OpenTabs>().0.lock().unwrap().insert(
        window.label().to_string(),
        WindowTabs { tabs, active },
    );
    // 起動時のパスを受け取り終えたら PendingOpen から外す
    // (残っていると再読み込みで二重に開く)
    if !empty {
        app.state::<PendingOpen>()
            .0
            .lock()
            .unwrap()
            .remove(window.label());
    }
}

#[derive(serde::Deserialize)]
struct TabInput {
    path: String,
    caption: String,
}

/// ウィンドウ切替の一覧に出す 1 行。タブはこの下にネストして並ぶ。
#[derive(serde::Serialize)]
struct WindowEntry {
    label: String,
    /// "file" (単一文書) か "project" (ツリーペイン + タブ)
    kind: &'static str,
    /// 見出し。単一文書なら文書のキャプション、プロジェクトならルートのパス
    caption: String,
    /// 2 行目に出す補助表示 (単一文書ならファイル名、プロジェクトなら空)
    name: String,
    /// 2 行目に出すディレクトリ
    dir: String,
    /// 呼び出し元のウィンドウ自身か
    current: bool,
    tabs: Vec<TabEntry>,
}

/// 一覧のタブ 1 行。
#[derive(serde::Serialize)]
struct TabEntry {
    path: String,
    caption: String,
    name: String,
    dir: String,
    /// そのウィンドウで今選ばれているタブか
    current: bool,
}

/// 開いているウィンドウの一覧を、それぞれのタブつきで返す。
///
/// 単一文書のウィンドウは何か開いているものだけ (台帳が根拠)、
/// プロジェクトウィンドウはタブが 0 でも出す (ルートを開いているため)。
/// 並びは main → viewer-N → project-N の採番順 = 開いた順。
#[tauri::command]
fn list_open_windows(app: AppHandle, window: tauri::WebviewWindow) -> Vec<WindowEntry> {
    let open = app.state::<OpenTabs>().0.lock().unwrap().clone();
    let roots = app.state::<ProjectRoots>().0.lock().unwrap().clone();
    let live = app.webview_windows();

    let mut entries: Vec<WindowEntry> = live
        .keys()
        .filter_map(|label| {
            let root = roots.get(label);
            let wt = open.get(label).cloned().unwrap_or_default();
            // 何も開いていない単一文書ウィンドウは一覧に出さない
            if root.is_none() && wt.tabs.is_empty() {
                return None;
            }
            let tabs: Vec<TabEntry> = wt
                .tabs
                .iter()
                .enumerate()
                .map(|(i, t)| TabEntry {
                    path: t.path.to_string_lossy().into_owned(),
                    caption: t.caption.clone(),
                    name: file_name_of(&t.path),
                    dir: parent_of(&t.path),
                    current: i == wt.active,
                })
                .collect();

            let (kind, caption, name, dir) = match root {
                Some(root) => (
                    "project",
                    root.to_string_lossy().into_owned(),
                    String::new(),
                    root.to_string_lossy().into_owned(),
                ),
                None => {
                    let t = &wt.tabs[wt.active.min(wt.tabs.len() - 1)];
                    let name = file_name_of(&t.path);
                    let caption = if t.caption.is_empty() {
                        name.clone()
                    } else {
                        t.caption.clone()
                    };
                    ("file", caption, name, parent_of(&t.path))
                }
            };

            Some(WindowEntry {
                current: *label == window.label(),
                label: label.clone(),
                kind,
                caption,
                name,
                dir,
                tabs,
            })
        })
        .collect();

    entries.sort_by_key(|e| window_order(&e.label));
    entries
}

fn file_name_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn parent_of(p: &Path) -> String {
    p.parent()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// ラベルから開いた順を求める。main は必ず先頭、以降は採番順。
fn window_order(label: &str) -> (u8, usize) {
    if let Some(n) = label.strip_prefix("viewer-") {
        return (1, n.parse().unwrap_or(usize::MAX));
    }
    if let Some(n) = label.strip_prefix("project-") {
        return (2, n.parse().unwrap_or(usize::MAX));
    }
    (0, 0)
}

/// 一覧から選ばれたウィンドウを前面化する。
#[tauri::command]
fn focus_window_by_label(app: AppHandle, label: String) {
    focus_window(&app, &label);
}

/// ファイルを開くときの共通ルール:
/// - どこかのウィンドウがタブで開いている → その窓を前面化してタブを選ばせる ("focused")
/// - 呼び出し元がプロジェクトウィンドウ → その場でタブとして開かせる ("load-here")
/// - 呼び出し元がまだ何も開いていない → その場で開かせる ("load-here")
/// - それ以外 → 新しい単一文書ウィンドウで開く ("new-window")
///
/// プロジェクトウィンドウの場合にルート配下かどうかを問わないのは、
/// 「本文のリンクはその窓のタブで開く」という約束を素直に守るため。
///
/// 正規化したパスを返すのは、フロントが持つ「今開いているパス」を
/// 台帳と同じ表記に揃えるため (md:changed の突き合わせに使う)。
///
/// ウィンドウ生成はメインスレッドへのディスパッチを伴うため、
/// デッドロックを避けて async コマンドにしている。
#[derive(serde::Serialize)]
struct OpenOutcome {
    /// "focused" | "load-here" | "new-window"
    action: &'static str,
    /// 正規化済みの絶対パス
    path: String,
}

#[tauri::command]
async fn open_path(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<OpenOutcome, String> {
    let canon = tab_target(&path).map_err(|e| format!("ファイルが見つかりません: {e}"))?;
    let canon_str = canon.to_string_lossy().into_owned();

    let existing = {
        let open = app.state::<OpenTabs>();
        let map = open.0.lock().unwrap();
        map.iter()
            .find(|(_, wt)| wt.tabs.iter().any(|t| t.path == canon))
            .map(|(l, _)| l.clone())
    };
    if let Some(label) = existing {
        if label != window.label() {
            focus_window(&app, &label);
        }
        // 相手の窓に「このタブを選べ」と伝える (自分の窓でも同じ)
        let _ = app.emit_to(label.as_str(), "md:activate", canon_str.clone());
        return Ok(OpenOutcome {
            action: "focused",
            path: canon_str,
        });
    }

    let is_project = app
        .state::<ProjectRoots>()
        .0
        .lock()
        .unwrap()
        .contains_key(window.label());
    let caller_is_empty = app
        .state::<OpenTabs>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_none_or(|wt| wt.tabs.is_empty());
    if is_project || caller_is_empty {
        return Ok(OpenOutcome {
            action: "load-here",
            path: canon_str,
        });
    }

    spawn_viewer_window(&app, canon_str.clone())?;
    Ok(OpenOutcome {
        action: "new-window",
        path: canon_str,
    })
}

/// ディレクトリを開く。プロジェクトウィンドウの振り分けは Rust 側が決める。
/// 同じルートを開いている窓があれば前面化するだけ ("focused")。
///
/// ウィンドウ生成はメインスレッドへのディスパッチを伴うため async。
#[tauri::command]
async fn open_dir_window(app: AppHandle, path: String) -> Result<String, String> {
    let root = canonicalize(&path).map_err(|e| format!("開けません: {e}"))?;
    if !root.is_dir() {
        return Err("ディレクトリではありません".into());
    }
    if let Some(label) = project_window_for(&app, &root) {
        focus_window(&app, &label);
        return Ok("focused".into());
    }
    spawn_project_window(&app, root)?;
    Ok("new-window".into())
}

/// そのルートを開いているプロジェクトウィンドウの label。
fn project_window_for(app: &AppHandle, root: &Path) -> Option<String> {
    let live = app.webview_windows();
    app.state::<ProjectRoots>()
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(label, r)| r.as_path() == root && live.contains_key(*label))
        .map(|(label, _)| label.clone())
}

/// プロジェクトウィンドウを作る。既存の前面ウィンドウからカスケードで並べる。
fn spawn_project_window(app: &AppHandle, root: PathBuf) -> Result<(), String> {
    let origin = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(window_origin)
        .map(|(x, y)| (x + CASCADE_STEP, y + CASCADE_STEP));
    spawn_project_window_at(app, root, origin)
}

/// 位置を明示してプロジェクトウィンドウを作る。
///
/// 単一文書のウィンドウ (index.html) とは別のページを読む。ガワが違うので
/// 実行時に切り替えるのではなくページを分けてある。ルートは JS が起動する前に
/// 決まっているので PendingProject に積み、get_project_root で取り出させる。
///
/// ProjectRoots への登録は Rust 側で行う。フロントの登録待ちにすると、
/// その隙に届いた Finder のオープンが「空のウィンドウ」と誤認して
/// この窓に吸い込まれてしまう。
fn spawn_project_window_at(
    app: &AppHandle,
    root: PathBuf,
    origin: Option<(f64, f64)>,
) -> Result<(), String> {
    let label = format!("project-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let root_str = root.to_string_lossy().into_owned();

    app.state::<PendingProject>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), root_str);
    app.state::<ProjectRoots>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), root);

    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("project.html".into()))
            .title("Inkfish")
            // ツリーペインとタブを載せるので単一文書の窓より広くする
            .inner_size(1360.0, 880.0)
            .min_inner_size(720.0, 420.0);

    if let Some((x, y)) = origin {
        builder = builder.position(x, y);
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    if let Err(e) = builder.build() {
        // 作れなかった label を台帳に残さない
        app.state::<PendingProject>().0.lock().unwrap().remove(&label);
        app.state::<ProjectRoots>().0.lock().unwrap().remove(&label);
        return Err(e.to_string());
    }
    Ok(())
}

// ---------- タブの切り離しと取り込み ----------

/// ドラッグ中の当たり判定に使うウィンドウの矩形 (論理ピクセル)。
#[derive(serde::Serialize)]
struct WindowRect {
    label: String,
    /// "file" (単一文書) か "project" (ツリーペイン + タブ)
    kind: &'static str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 開いているすべてのウィンドウの矩形を返す。
///
/// フロントから 1 窓ずつ outerPosition / outerSize / scaleFactor を
/// 問い合わせると 3N 往復になるので、まとめて 1 回で返す。
/// 単位は論理ピクセル。pointer イベントの screenX / screenY と同じ空間なので
/// そのまま点の内外判定に使える。
#[tauri::command]
fn window_rects(app: AppHandle) -> Vec<WindowRect> {
    let roots: HashSet<String> = app
        .state::<ProjectRoots>()
        .0
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();

    app.webview_windows()
        .iter()
        .filter_map(|(label, w)| {
            let (x, y) = window_origin(w)?;
            let size = w.outer_size().ok()?;
            let scale = w.scale_factor().ok()?;
            Some(WindowRect {
                kind: if roots.contains(label) { "project" } else { "file" },
                label: label.clone(),
                x,
                y,
                w: size.width as f64 / scale,
                h: size.height as f64 / scale,
            })
        })
        .collect()
}

/// タブを窓の外へ落としたときに、そこへ単一文書ウィンドウを作る。
///
/// 座標は離した位置 (論理ピクセル)。掴んでいたタブのあたりにカーソルが
/// 来るよう少し左上へずらして置く。
///
/// 呼び出し側は台帳から自分のタブを外すが、順番は問わない
/// (台帳は label ごとに分かれているので取り違えない)。
#[tauri::command]
async fn tear_out_tab(app: AppHandle, path: String, x: f64, y: f64) -> Result<(), String> {
    let canon = tab_target(&path).map_err(|e| format!("ファイルが見つかりません: {e}"))?;
    // カーソルの少し右下にタブが来る位置に置き、落とした先のモニタへ収める
    let origin = clamp_to_monitor(&app, x - 90.0, y - 16.0);
    spawn_viewer_window_at(&app, canon.to_string_lossy().into_owned(), Some(origin))
}

/// 新しいウィンドウの左上座標を、その点を含むモニタの中へ収める。
/// 画面の端で離したときに窓の大半が画面外へ出て掴み直せなくなるのを防ぐ。
/// どのモニタにも当たらない座標のときはそのまま返す。
fn clamp_to_monitor(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    let Ok(monitors) = app.available_monitors() else {
        return (x, y);
    };
    for m in monitors {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (mx, my) = (pos.x as f64 / s, pos.y as f64 / s);
        let (mw, mh) = (size.width as f64 / s, size.height as f64 / s);
        if x < mx || x > mx + mw || y < my || y > my + mh {
            continue;
        }
        return (
            x.clamp(mx, (mx + mw - VIEWER_W).max(mx)),
            y.clamp(my, (my + mh - VIEWER_H).max(my)),
        );
    }
    (x, y)
}

/// タブを別のウィンドウに渡す。相手に開かせて前面化する。
/// 自分のタブを閉じるのは呼び出し側の仕事。
#[tauri::command]
fn adopt_tab(app: AppHandle, label: String, path: String) -> Result<(), String> {
    let canon = tab_target(&path).map_err(|e| format!("ファイルが見つかりません: {e}"))?;
    app.emit_to(
        label.as_str(),
        "tab:adopt",
        canon.to_string_lossy().into_owned(),
    )
    .map_err(|e| e.to_string())?;
    focus_window(&app, &label);
    Ok(())
}

/// 呼び出し元のウィンドウを論理座標へ動かす。
///
/// ウィンドウのドラッグを自前で持つために使う (macOS の OS ドラッグは
/// 開始しか通知されず、どこで離したかを知る手段が無い)。JS の setPosition
/// ではなくコマンドにしてあるのは、window の変更操作をすべて Rust 側に
/// 集めて capabilities を増やさないため。
#[tauri::command]
fn set_window_origin(window: tauri::WebviewWindow, x: f64, y: f64) {
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// ドラッグ中の窓が、受け入れ先の候補に「今カーソルが上にいる」ことを伝える。
/// 相手はタブ列を光らせて受け入れ可能なことを示す。
#[tauri::command]
fn dock_hover(app: AppHandle, label: String, active: bool) {
    let _ = app.emit_to(label.as_str(), "dock:hover", active);
}

/// 呼び出し元のウィンドウを閉じる。取り込まれた側が自分を畳むのに使う。
#[tauri::command]
fn close_self(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/// 起動時に開くべきファイルを返す。
/// Finder 経由・CLI 引数・新規ウィンドウの割り当てはいずれも PendingOpen に
/// 積まれているので、ここは覗くだけ。振り分けは setup と open_from_system に
/// 集めてある。
///
/// **取り出して消さない**のが要点。消すのは set_window_tabs (= 実際に開けた
/// とき)。ここで消してしまうと、「読み込み中でまだタブが無い」窓が
/// close_empty_windows から見て空に見え、閉じられてしまう。
#[tauri::command]
fn get_startup_file(
    window: tauri::WebviewWindow,
    pending: State<'_, PendingOpen>,
) -> Option<String> {
    pending.0.lock().unwrap().get(window.label()).cloned()
}

/// プロジェクトウィンドウが起動時に開くルートを返す。
///
/// PendingProject は JS が起動する前にルートを積んでおくための箱で、取り出したら
/// 消える。webview が読み込み直されると 2 回目は空になり、ツリーもタブも出せなく
/// なってしまうので、ウィンドウが閉じるまで残る ProjectRoots に落とす
/// (dev の HMR で毎回そうなるほか、webview が再読み込みされたときの備えでもある)。
///
/// あわせて空のウィンドウを片付ける。ディレクトリを開くとプロジェクト
/// ウィンドウが新しく出るので、それを頼んだ空の窓 (起動直後の main など) が
/// 使われないまま残ってしまう。ここでやるのは、この時点なら他の窓が
/// すべて作られていて「本当に空か」を判定できるため
/// (CLI / Finder / メニュー / D&D のどの経路でも同じ後始末になる)。
/// 2 度目に呼ばれても、この窓は ProjectRoots にあるので空とは見なされない。
#[tauri::command]
fn get_project_root(app: AppHandle, window: tauri::WebviewWindow) -> Option<String> {
    let root = app
        .state::<PendingProject>()
        .0
        .lock()
        .unwrap()
        .remove(window.label())
        .or_else(|| {
            app.state::<ProjectRoots>()
                .0
                .lock()
                .unwrap()
                .get(window.label())
                .map(|p| p.to_string_lossy().into_owned())
        });
    close_empty_windows(&app, window.label());
    root
}

/// タブもプロジェクトのルートも持たないウィンドウを閉じる。
/// 起動時のファイルを待っている窓 (PendingOpen にある) は空でも残す。
fn close_empty_windows(app: &AppHandle, except: &str) {
    let open = app.state::<OpenTabs>().0.lock().unwrap().clone();
    let roots: HashSet<String> = app
        .state::<ProjectRoots>()
        .0
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let pending: HashSet<String> = app
        .state::<PendingOpen>()
        .0
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();

    for (label, w) in app.webview_windows() {
        if label == except || roots.contains(&label) || pending.contains(&label) {
            continue;
        }
        if open.get(&label).is_none_or(|wt| wt.tabs.is_empty()) {
            let _ = w.close();
        }
    }
}

/// コマンド引数から開くべきものを集める。返り値は (ファイル, ディレクトリ)。
/// ファイルは単一文書ウィンドウ、ディレクトリはプロジェクトウィンドウで開く。
///
/// - `-` 始まりは読み飛ばす。macOS が LaunchServices 経由で付ける
///   `-psn_0_12345` もこれで落ちる
/// - `--` 以降はフラグ判定をやめて全部パスとして扱う
///   (`inkfish -- -weird-name.md` が開ける)
/// - 開けないものは黙って捨てる。GUI アプリなので argv のエラーを
///   出す先がない (release の Windows はコンソールを持たない)
/// - 同じパスの重複は落とす。`inkfish a.md a.md` で 2 窓に同じ文書が
///   出ると「同じファイルは同じウィンドウ」(OpenTabs) が崩れる
fn cli_targets() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut only_paths = false;
    for arg in std::env::args().skip(1) {
        if !only_paths {
            if arg == "--" {
                only_paths = true;
                continue;
            }
            if arg.starts_with('-') {
                continue;
            }
        }
        // 実体の無い ID (起点版・差分) はそのまま渡す。ファイルではないので
        // 正規化できないが、ウィンドウはこれを開ける
        if is_virtual_id(&arg) {
            let p = PathBuf::from(&arg);
            if !files.contains(&p) {
                files.push(p);
            }
            continue;
        }
        let Ok(p) = canonicalize(&arg) else { continue };
        if p.is_dir() {
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        } else if p.is_file() && !files.contains(&p) {
            files.push(p);
        }
    }
    (files, dirs)
}

/// ログインシェルの PATH を取得する。
/// Dock/Finder から起動した .app の PATH は最小限 (`/usr/bin:/bin` 程度) で、
/// Homebrew などの `/opt/homebrew/bin`・`/usr/local/bin` が含まれない。
/// ターミナルと同じ解決をするため、ログインシェルに PATH を問い合わせる。
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// 設定されたコマンドで外部エディタを起動する。
/// コマンド中の {path} を置換、なければ末尾に引数として渡す。
#[tauri::command]
fn open_in_editor(path: String, command: String) -> Result<(), String> {
    let parts = shell_words::split(command.trim()).map_err(|e| e.to_string())?;
    let Some((program, rest)) = parts.split_first() else {
        return Err("エディタコマンドが設定されていません".into());
    };

    let mut args: Vec<String> = rest.to_vec();
    let mut replaced = false;
    for a in args.iter_mut() {
        if a.contains("{path}") {
            *a = a.replace("{path}", &path);
            replaced = true;
        }
    }
    if !replaced {
        args.push(path);
    }

    // GUI 起動時 (Dock/Finder) の PATH は最小限で vimr/code などが見つからない。
    // ログインシェルの PATH を取得し、エディタ本体を絶対パスに解決してから起動する。
    let mut cmd = std::process::Command::new(program);
    #[cfg(unix)]
    if let Some(path_env) = login_shell_path() {
        if let Some(resolved) = resolve_program(program, &path_env) {
            cmd = std::process::Command::new(resolved);
        }
        cmd.env("PATH", path_env);
    }
    cmd.args(&args)
        .spawn()
        .map_err(|e| format!("エディタの起動に失敗しました: {e}"))?;
    Ok(())
}

/// そのフォルダで効いている環境変数を、ログインシェルから 1 つ取る。
///
/// GUI から起動した .app はシェルの設定を持たないので、mise や direnv のような
/// 「ディレクトリごとに環境を変える」仕掛けが効かない。ログインシェルをその
/// フォルダで起こせば、ターミナルで作業しているときと同じ環境が再現できる。
/// (login_shell_path と同じ事情。あちらは PATH だけを見ている)
#[cfg(unix)]
pub(crate) fn shell_env_at(dir: &Path, key: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // 値は制御文字 (RS) で囲んで取り出す。対話シェルは初期化のついでに何かを
    // 出力することがあるので、目印が無いと混ざる。
    let script = format!("printf '\\036%s\\036' \"${key}\"");
    // ディレクトリごとに環境を変える仕掛け (mise / direnv) は、対話シェルの
    // hook で動くものが多い。ログインシェルで拾えなければ対話シェルでも尋ねる
    // (対話シェルは初期化が重いので、必要なときだけ)。
    for flag in ["-lc", "-ic"] {
        let Ok(out) = std::process::Command::new(&shell)
            .current_dir(dir)
            // こちらが持っている値は落とす。残したままだと、シェルが何も
            // 設定しなくても親の値がそのまま見えてしまい、「そのフォルダの
            // 設定」を取ったつもりで別の値を掴む。
            .env_remove(key)
            .args([flag, script.as_str()])
            .output()
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(value) = text.split('\u{1e}').nth(1) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Windows 版。mise / direnv の hook は PowerShell の profile に入るので、
/// profile を読ませる (-NoProfile を付けない)。
#[cfg(windows)]
pub(crate) fn shell_env_at(dir: &Path, key: &str) -> Option<String> {
    // 値は制御文字 (RS) で囲んで取り出す。profile は何かを出力することがある。
    let script = format!("[Console]::Out.Write([char]30 + $env:{key} + [char]30)");
    for exe in ["pwsh", "powershell"] {
        let Ok(out) = std::process::Command::new(exe)
            .current_dir(dir)
            // こちらが持っている値は落とす (unix 版と同じ理由)
            .env_remove(key)
            .args(["-Command", script.as_str()])
            .output()
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(value) = text.split('\u{1e}').nth(1) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn shell_env_at(_dir: &Path, _key: &str) -> Option<String> {
    None
}

/// プログラム名を PATH 上で絶対パスに解決する。
/// スラッシュを含む (絶対/相対パス指定) 場合や、見つからない場合は None を返し、
/// 呼び出し側の既定の解決に委ねる。
#[cfg(unix)]
fn resolve_program(program: &str, path_env: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return None;
    }
    path_env
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|dir| PathBuf::from(dir).join(program))
        .find(|candidate| candidate.is_file())
}

/// アプリのメニューバーを組み立てる。
/// File メニューに「開く」「PDF で書き出す」を追加し、
/// 選択時はフロントエンドにイベントを送って処理させる。
fn build_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::menu::Menu<R>, tauri::Error> {
    let open = MenuItemBuilder::with_id("open", "開く…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_dir = MenuItemBuilder::with_id("open_dir", "フォルダを開く…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let export_pdf = MenuItemBuilder::with_id("export_pdf", "PDF で書き出す…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "ファイル")
        .item(&open)
        .item(&open_dir)
        .item(&export_pdf)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "編集")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "ウインドウ")
        .minimize()
        .separator()
        .fullscreen()
        .build()?;

    // menu の再代入は macOS のアプリメニュー追加時のみ(他 OS では mut 不要)
    #[allow(unused_mut)]
    let mut menu = MenuBuilder::new(app);

    // macOS のアプリメニュー(Inkfish について / 隠す / 終了 など)
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Inkfish")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    menu.item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()
}

/// メニュー操作を、現在前面にあるウィンドウのフロントエンドへ届ける。
fn emit_to_focused(app: &AppHandle, event: &str) {
    let target = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    if let Some(label) = target {
        let _ = app.emit_to(label.as_str(), event, ());
    }
}

/// 表示中のドキュメントを PDF として書き出す (macOS)。
/// WKWebView.createPDF でページ全体を PDF 化し、指定パスへ書き込む。
/// createPDF は非同期(完了ブロック)なので、メインスレッドで発行だけ行い、
/// 結果はチャネル経由で受け取る(コマンド自体は別スレッドで待機する)。
#[cfg(target_os = "macos")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, dest: String) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_foundation::{NSData, NSError, NSString};
    use objc2_web_kit::WKWebView;

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            // このクロージャはメインスレッドで実行される。
            let webview = platform.inner() as *mut WKWebView;
            let handler = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                let result = unsafe {
                    if !err.is_null() {
                        Err(format!("PDF の生成に失敗しました: {}", (*err).localizedDescription()))
                    } else if data.is_null() {
                        Err("PDF データを取得できませんでした".into())
                    } else if (*data).writeToFile_atomically(&NSString::from_str(&dest), true) {
                        Ok(())
                    } else {
                        Err("PDF を書き込めませんでした".into())
                    }
                };
                let _ = tx.send(result);
            });
            // 設定 nil でページ全体をキャプチャする
            unsafe { (*webview).createPDFWithConfiguration_completionHandler(None, &handler) };
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

/// 表示中のドキュメントを PDF として書き出す (Windows)。
/// WebView2 の ICoreWebView2_7::PrintToPdf でファイルへ直接書き出す。
/// 完了ハンドラは UI スレッドで呼ばれるので、結果はチャネルで受け取る。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, dest: String) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_2, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    /// 印刷設定を作る。既定 (設定 None) では ShouldPrintBackgrounds が FALSE で、
    /// CSS の背景 (コードブロックの地色・表のヘッダ・Marp の `![bg]()` 背景画像) が
    /// PDF から落ちてしまうため、明示的に有効にする。
    /// CreatePrintSettings は比較的新しい WebView2 ランタイムの API なので、
    /// 取得できないときは None を返して既定設定で書き出す (背景なしにはなる)。
    fn print_settings(webview: &ICoreWebView2_7) -> Option<ICoreWebView2PrintSettings> {
        let webview2 = webview.cast::<ICoreWebView2_2>().ok()?;
        let env = unsafe { webview2.Environment() }.ok()?;
        let env6 = env.cast::<ICoreWebView2Environment6>().ok()?;
        let settings = unsafe { env6.CreatePrintSettings() }.ok()?;
        unsafe { settings.SetShouldPrintBackgrounds(true) }.ok()?;
        Some(settings)
    }

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            // このクロージャは UI (メイン) スレッドで実行される。
            let issue = (|| -> windows::core::Result<()> {
                let controller = platform.controller();
                let webview = unsafe { controller.CoreWebView2()? };
                let webview7: ICoreWebView2_7 = webview.cast()?;
                let settings = print_settings(&webview7);
                let handler_tx = tx.clone();
                // webview2-com は HRESULT/BOOL を Result<(), Error> と bool に変換して渡す
                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |errcode: windows::core::Result<()>, is_successful| {
                        let result = match errcode {
                            Ok(()) if is_successful => Ok(()),
                            Ok(()) => Err("PDF を書き込めませんでした".to_string()),
                            Err(e) => Err(format!("PDF の生成に失敗しました: {}", e.message())),
                        };
                        let _ = handler_tx.send(result);
                        Ok(())
                    },
                ));
                // 用紙サイズ・余白は既定のまま、背景描画だけ有効にした設定で書き出す
                unsafe {
                    webview7.PrintToPdf(
                        &HSTRING::from(dest.as_str()),
                        settings.as_ref(),
                        &handler,
                    )?
                };
                Ok(())
            })();
            // 発行前に失敗したらここで結果を返す(完了ハンドラは呼ばれない)
            if let Err(e) = issue {
                let _ = tx.send(Err(e.message()));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

/// 表示中のドキュメントを PDF として書き出す (Linux)。
/// WebKitGTK の PrintOperation を「ファイルへ出力」設定で走らせ、
/// PDF として書き込む。完了/失敗はシグナルで届くのでチャネルで受け取る。
#[cfg(target_os = "linux")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, dest: String) -> Result<(), String> {
    use gtk::prelude::*;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            // このクロージャは GTK メインスレッドで実行される。
            let webview = platform.inner();
            let op = PrintOperation::new(&webview);

            // output-uri を指定すると GTK が「ファイルへ出力」バックエンドを選ぶ。
            // 既定の出力フォーマットは PDF。
            let settings = gtk::PrintSettings::new();
            settings.set("output-uri", Some(format!("file://{}", dest).as_str()));
            settings.set("output-file-format", Some("pdf"));
            op.set_print_settings(&settings);

            let tx_fail = tx.clone();
            op.connect_finished(move |_| {
                let _ = tx.send(Ok(()));
            });
            op.connect_failed(move |_, err| {
                let _ = tx_fail.send(Err(format!("PDF の生成に失敗しました: {}", err)));
            });
            op.print();
            // print() は非同期。スコープを抜けても操作が生き続けるよう保持する。
            std::mem::forget(op);
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
#[tauri::command]
async fn export_pdf(_window: tauri::WebviewWindow, _dest: String) -> Result<(), String> {
    Err("PDF 書き出しはこの OS では未対応です".into())
}

fn focus_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.webview_windows().get(label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// ウィンドウの左上座標を論理ピクセルで返す。カスケードの基準に使う。
fn window_origin(w: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let pos = w.outer_position().ok()?;
    let scale = w.scale_factor().ok()?;
    Some((pos.x as f64 / scale, pos.y as f64 / scale))
}

/// 指定ファイルを開く新しいビューアウィンドウを作る。
/// 既存の前面ウィンドウと完全に重ならないよう、少しずらして出す (カスケード)。
fn spawn_viewer_window(app: &AppHandle, path: String) -> Result<(), String> {
    let origin = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(window_origin)
        .map(|(x, y)| (x + CASCADE_STEP, y + CASCADE_STEP));
    spawn_viewer_window_at(app, path, origin)
}

/// 位置を明示してビューアウィンドウを作る。
/// パスは PendingOpen に積み、フロントエンドが起動時に取り出す。
///
/// 起動直後 (setup) はまだどのウィンドウもフォーカスを持たないため、
/// spawn_viewer_window のフォーカス探索が空振りして全窓が同座標に重なる。
/// CLI 引数から複数開くときは呼び出し側が基準座標を渡す。
fn spawn_viewer_window_at(
    app: &AppHandle,
    path: String,
    origin: Option<(f64, f64)>,
) -> Result<(), String> {
    let label = format!("viewer-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    app.state::<PendingOpen>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), path);

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Inkfish")
        .inner_size(VIEWER_W, VIEWER_H)
        .min_inner_size(520.0, 400.0);

    if let Some((x, y)) = origin {
        builder = builder.position(x, y);
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Finder / Dock 経由で届いたオープン要求を適切なウィンドウに振り分ける。
fn open_from_system(app: &AppHandle, path: PathBuf) {
    let open_map: HashMap<String, WindowTabs> =
        app.state::<OpenTabs>().0.lock().unwrap().clone();

    // 既に表示しているウィンドウがあれば前面化するだけ
    if let Some((label, _)) = open_map
        .iter()
        .find(|(_, wt)| wt.tabs.iter().any(|t| t.path == path))
    {
        focus_window(app, label);
        let _ = app.emit_to(label.as_str(), "md:activate", path.to_string_lossy().into_owned());
        return;
    }

    let path_str = path.to_string_lossy().into_owned();

    // 起動直後は main ウィンドウ生成前に Apple Event が届くことがある。
    // その場合はこれから作られる main 用に積んでおく。
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.state::<PendingOpen>()
            .0
            .lock()
            .unwrap()
            .insert("main".into(), path_str);
        return;
    }

    // まだ何も表示していないウィンドウ(起動直後など)があればそこで開く。
    // プロジェクトウィンドウは「タブ 0 でもルートを開いている窓」なので
    // 空とは見なさない (でないと Finder のオープンを永久に吸い込んでしまう)。
    let project_labels: HashSet<String> =
        app.state::<ProjectRoots>().0.lock().unwrap().keys().cloned().collect();
    let empty = windows
        .keys()
        .find(|l| {
            !project_labels.contains(*l)
                && open_map.get(*l).is_none_or(|wt| wt.tabs.is_empty())
        })
        .cloned();
    if let Some(label) = empty {
        // JS 起動前なら get_startup_file、起動後なら md:open のどちらかで拾われる
        app.state::<PendingOpen>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone(), path_str.clone());
        let _ = app.emit_to(label.as_str(), "md:open", path_str);
        focus_window(app, &label);
    } else {
        let _ = spawn_viewer_window(app, path_str);
    }
}

/// Finder から渡されたディレクトリを開く。
/// 同じルートの窓があれば前面化、無ければプロジェクトウィンドウを作る。
fn open_dir_from_system(app: &AppHandle, root: PathBuf) {
    if let Some(label) = project_window_for(app, &root) {
        focus_window(app, &label);
        return;
    }
    let _ = spawn_project_window(app, root);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 起点版のファイルを返す。画像や PDF をそのまま <img> / <embed> に
        // 渡せるようにするためのもので、本文は git_blob が返す。
        //
        // URL は rev://localhost/<sha>/<絶対パス>。Windows では Tauri が
        // http://rev.localhost/… に読み替えるが、パスの形は同じなので
        // ここは共通で扱える。フロントは resolveAsset でこの形に組み替える。
        .register_uri_scheme_protocol("rev", |_ctx, request| {
            let decoded = git::percent_decode(request.uri().path());
            let served = git::split_rev_path(&decoded)
                .ok_or_else(|| "URL の形が違います".to_string())
                .and_then(|(sha, path)| {
                    git::blob_at(&sha, &path).map(|data| (git::mime_of(&path), data))
                });
            match served {
                Ok((mime, data)) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .body(data)
                    .unwrap_or_default(),
                Err(_) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap_or_default(),
            }
        })
        .manage(WatchState::default())
        .manage(OpenTabs::default())
        .manage(PendingOpen::default())
        .manage(ProjectRoots::default())
        .manage(PendingProject::default())
        .setup(|app| {
            // CLI 引数を振り分ける。config 宣言の main ウィンドウは build 中に
            // 作られているので、この時点で存在する。WebView の JS が動き出す
            // 前なので、PendingOpen / PendingProject に積めば起動時に拾われる。
            let (files, dirs) = cli_targets();
            if files.is_empty() && dirs.is_empty() {
                return Ok(());
            }
            let handle = app.handle();

            // 追加の窓は main の位置を基準にカスケードで並べる
            let base = handle
                .get_webview_window("main")
                .as_ref()
                .and_then(window_origin);
            let mut nth = 0usize;
            let mut next_origin = |base: Option<(f64, f64)>| {
                nth += 1;
                let step = CASCADE_STEP * nth as f64;
                base.map(|(x, y)| (x + step, y + step))
            };

            if let Some((first, rest)) = files.split_first() {
                // Finder からのオープン (RunEvent::Opened) が先に main へ積んで
                // いる可能性があるので、空いているときだけ入れる。
                handle
                    .state::<PendingOpen>()
                    .0
                    .lock()
                    .unwrap()
                    .entry("main".to_string())
                    .or_insert_with(|| first.to_string_lossy().into_owned());

                for path in rest {
                    let origin = next_origin(base);
                    spawn_viewer_window_at(handle, path.to_string_lossy().into_owned(), origin)?;
                }
            }

            for root in &dirs {
                let origin = next_origin(base);
                spawn_project_window_at(handle, root.clone(), origin)?;
            }

            // 引数がディレクトリだけのときに残る空の main は、プロジェクト
            // ウィンドウが起動して get_project_root を呼ぶときに片付けられる。
            Ok(())
        })
        .menu(|handle| build_menu(handle))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => emit_to_focused(app, "menu:open"),
            "open_dir" => emit_to_focused(app, "menu:open-dir"),
            "export_pdf" => emit_to_focused(app, "menu:export-pdf"),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            read_md_file,
            read_md_tree,
            watch_files,
            watch_tree,
            open_in_editor,
            open_path,
            get_startup_file,
            get_project_root,
            open_dir_window,
            set_window_tabs,
            list_open_windows,
            focus_window_by_label,
            window_rects,
            tear_out_tab,
            adopt_tab,
            set_window_origin,
            dock_hover,
            close_self,
            export_pdf,
            git::git_probe,
            git::git_changes,
            git::git_counts,
            git::git_refs,
            git::git_blob,
            git::git_hunks,
            git::git_fetch
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // macOS では Finder からのオープンは argv ではなく Apple Event で届く。
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            for path in urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter_map(|p| canonicalize(p).ok())
            {
                if path.is_dir() {
                    open_dir_from_system(app_handle, path);
                } else if path.is_file() {
                    open_from_system(app_handle, path);
                }
            }
        }
        // 閉じたウィンドウの台帳と watcher を掃除する
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            app_handle
                .state::<OpenTabs>()
                .0
                .lock()
                .unwrap()
                .remove(&label);
            app_handle
                .state::<WatchState>()
                .0
                .lock()
                .unwrap()
                .remove(&label);
            app_handle
                .state::<PendingOpen>()
                .0
                .lock()
                .unwrap()
                .remove(&label);
            app_handle
                .state::<ProjectRoots>()
                .0
                .lock()
                .unwrap()
                .remove(&label);
            app_handle
                .state::<PendingProject>()
                .0
                .lock()
                .unwrap()
                .remove(&label);
        }
        _ => {}
    });
}
