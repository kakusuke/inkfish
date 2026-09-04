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

/// ウィンドウ 1 つぶんの監視。
///
/// notify の watcher は 1 つで複数のパスを監視できるので、そのウィンドウが
/// 開いているタブの親ディレクトリをまとめて 1 つの watcher に載せる。
/// (ファイル自体ではなく親を見るのは、エディタの atomic save が rename で
/// 差し替えるため。対象パスの絞り込みは通知側で行う)
struct WindowWatch {
    watcher: RecommendedWatcher,
    /// 今 watch しているディレクトリ。タブが変わったときの差分更新に使う。
    dirs: HashSet<PathBuf>,
    /// 変更を通知したい対象ファイル。watcher のクロージャが読むので Arc。
    files: Arc<Mutex<HashSet<PathBuf>>>,
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

/// ウィンドウが起動時に開くべきファイル (label -> path)。
/// WebView の JS が立ち上がる前に届いた分をここに保持し、
/// フロントエンドが get_startup_file で取り出す。
#[derive(Default)]
struct PendingOpen(Mutex<HashMap<String, String>>);

/// 追加ウィンドウのラベル採番用
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

/// 追加ウィンドウをずらす量 (論理ピクセル)
const CASCADE_STEP: f64 = 28.0;

#[tauri::command]
fn read_md_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
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
    let targets: Vec<PathBuf> = paths.iter().filter_map(|p| canonicalize(p).ok()).collect();
    let dirs: HashSet<PathBuf> = targets
        .iter()
        .filter_map(|p| p.parent().map(|d| d.to_path_buf()))
        .collect();
    let files: HashSet<PathBuf> = targets.into_iter().collect();

    let label = window.label().to_string();
    let mut map = state.0.lock().unwrap();

    let entry = match map.entry(label.clone()) {
        Entry::Occupied(e) => e.into_mut(),
        Entry::Vacant(v) => {
            let shared: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
            let watched = Arc::clone(&shared);
            let emit_label = label.clone();
            let watcher = notify::recommended_watcher(
                move |res: notify::Result<notify::Event>| {
                    let Ok(event) = res else { return };
                    use notify::EventKind::*;
                    if !matches!(event.kind, Create(_) | Modify(_) | Remove(_)) {
                        return;
                    }
                    let set = watched.lock().unwrap();
                    for path in event.paths.iter().filter(|p| set.contains(*p)) {
                        let _ = app.emit_to(
                            emit_label.as_str(),
                            "md:changed",
                            path.to_string_lossy().into_owned(),
                        );
                    }
                },
            )
            .map_err(|e| e.to_string())?;
            v.insert(WindowWatch {
                watcher,
                dirs: HashSet::new(),
                files: shared,
            })
        }
    };

    // 監視ディレクトリを差分更新する (先に集めてから触るのは、
    // dirs を読みながら watcher と dirs を書き換えられないため)
    let gone: Vec<PathBuf> = entry.dirs.difference(&dirs).cloned().collect();
    for dir in gone {
        let _ = entry.watcher.unwatch(&dir);
        entry.dirs.remove(&dir);
    }
    let added: Vec<PathBuf> = dirs.difference(&entry.dirs).cloned().collect();
    for dir in added {
        entry
            .watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        entry.dirs.insert(dir);
    }
    *entry.files.lock().unwrap() = files;
    Ok(())
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
    let canon = canonicalize(&path).map_err(|e| format!("ファイルが見つかりません: {e}"))?;
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

/// 起動時に開くべきファイルを返す。
/// Finder 経由・CLI 引数・新規ウィンドウの割り当てはいずれも PendingOpen に
/// 積まれているので、ここは取り出すだけ。振り分けは setup と
/// open_from_system に集めてある。
#[tauri::command]
fn get_startup_file(
    window: tauri::WebviewWindow,
    pending: State<'_, PendingOpen>,
) -> Option<String> {
    pending.0.lock().unwrap().remove(window.label())
}

/// コマンド引数から開くべき md ファイルを集める。
///
/// - `-` 始まりは読み飛ばす。macOS が LaunchServices 経由で付ける
///   `-psn_0_12345` もこれで落ちる
/// - `--` 以降はフラグ判定をやめて全部パスとして扱う
///   (`inkfish -- -weird-name.md` が開ける)
/// - 開けないものやディレクトリは黙って捨てる。GUI アプリなので
///   argv のエラーを出す先がない (release の Windows はコンソールを持たない)
/// - 同じファイルの重複は落とす。`inkfish a.md a.md` で 2 窓に同じ文書が
///   出ると「同じファイルは同じウィンドウ」(OpenTabs) が崩れる
fn cli_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
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
        let Ok(p) = canonicalize(&arg) else { continue };
        if p.is_file() && !files.contains(&p) {
            files.push(p);
        }
    }
    files
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
    let export_pdf = MenuItemBuilder::with_id("export_pdf", "PDF で書き出す…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "ファイル")
        .item(&open)
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
        .inner_size(1100.0, 840.0)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .manage(OpenTabs::default())
        .manage(PendingOpen::default())
        .manage(ProjectRoots::default())
        .setup(|app| {
            // CLI 引数のファイルを振り分ける。config 宣言の main ウィンドウは
            // build 中に作られているので、この時点で存在する。
            // WebView の JS が動き出す前なので、PendingOpen に積めば
            // get_startup_file が拾ってくれる。
            let files = cli_files();
            let Some((first, rest)) = files.split_first() else {
                return Ok(());
            };
            let handle = app.handle();

            // Finder からのオープン (RunEvent::Opened) が先に main へ積んでいる
            // 可能性があるので、空いているときだけ入れる。
            handle
                .state::<PendingOpen>()
                .0
                .lock()
                .unwrap()
                .entry("main".to_string())
                .or_insert_with(|| first.to_string_lossy().into_owned());

            // 2 つ目以降は main の位置を基準にカスケードで並べる
            let base = handle.get_webview_window("main").as_ref().and_then(window_origin);
            for (i, path) in rest.iter().enumerate() {
                let step = CASCADE_STEP * (i + 1) as f64;
                let origin = base.map(|(x, y)| (x + step, y + step));
                spawn_viewer_window_at(handle, path.to_string_lossy().into_owned(), origin)?;
            }
            Ok(())
        })
        .menu(|handle| build_menu(handle))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => emit_to_focused(app, "menu:open"),
            "export_pdf" => emit_to_focused(app, "menu:export-pdf"),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            read_md_file,
            watch_files,
            open_in_editor,
            open_path,
            get_startup_file,
            set_window_tabs,
            list_open_windows,
            focus_window_by_label,
            export_pdf
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
                .filter(|p| p.is_file())
            {
                open_from_system(app_handle, path);
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
        }
        _ => {}
    });
}
