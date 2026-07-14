use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// ウィンドウごとのアクティブな watcher (label -> watcher)。
/// 同じウィンドウが別ファイルを監視すると古い watcher は drop され解除される。
#[derive(Default)]
struct WatchState(Mutex<HashMap<String, RecommendedWatcher>>);

/// 各ウィンドウが現在表示しているファイル (label -> canonical path)。
/// 「同じファイルは同じウィンドウ」を保証するための台帳。
#[derive(Default)]
struct ShownFiles(Mutex<HashMap<String, PathBuf>>);

/// ウィンドウが起動時に開くべきファイル (label -> path)。
/// WebView の JS が立ち上がる前に届いた分をここに保持し、
/// フロントエンドが get_startup_file で取り出す。
#[derive(Default)]
struct PendingOpen(Mutex<HashMap<String, String>>);

/// 追加ウィンドウのラベル採番用
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

#[tauri::command]
fn read_md_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// エディタの atomic save (rename で差し替え) を拾うため、
/// ファイル自体ではなく親ディレクトリを監視して対象パスだけ通知する。
/// 通知は監視を要求したウィンドウにだけ届く。
#[tauri::command]
fn watch_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, WatchState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let dir = target
        .parent()
        .ok_or("親ディレクトリが見つかりません")?
        .to_path_buf();

    let label = window.label().to_string();
    let emit_label = label.clone();
    let watched = target.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                use notify::EventKind::*;
                if matches!(event.kind, Create(_) | Modify(_) | Remove(_))
                    && event.paths.iter().any(|p| p == &watched)
                {
                    let _ = app.emit_to(emit_label.as_str(), "md:changed", ());
                }
            }
        })
        .map_err(|e| e.to_string())?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    state.0.lock().unwrap().insert(label, watcher);
    Ok(())
}

/// ファイルの表示に成功したウィンドウが自分の表示中ファイルを登録する。
#[tauri::command]
fn register_shown_file(window: tauri::WebviewWindow, path: String) {
    let app = window.app_handle();
    let canon = PathBuf::from(&path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&path));
    app.state::<ShownFiles>()
        .0
        .lock()
        .unwrap()
        .insert(window.label().to_string(), canon);
    app.state::<PendingOpen>()
        .0
        .lock()
        .unwrap()
        .remove(window.label());
}

/// ファイルを開くときの共通ルール:
/// - どこかのウィンドウが表示中 → そのウィンドウを前面化 ("focused")
/// - 呼び出し元がまだ何も表示していない → その場で表示させる ("load-here")
/// - それ以外 → 新しいウィンドウで開く ("new-window")
///
/// ウィンドウ生成はメインスレッドへのディスパッチを伴うため、
/// デッドロックを避けて async コマンドにしている。
#[tauri::command]
async fn open_path(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<String, String> {
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("ファイルが見つかりません: {e}"))?;

    let existing = {
        let shown = app.state::<ShownFiles>();
        let map = shown.0.lock().unwrap();
        map.iter()
            .find(|(_, p)| **p == canon)
            .map(|(l, _)| l.clone())
    };
    if let Some(label) = existing {
        if label != window.label() {
            focus_window(&app, &label);
        }
        return Ok("focused".into());
    }

    let caller_is_empty = !app
        .state::<ShownFiles>()
        .0
        .lock()
        .unwrap()
        .contains_key(window.label());
    if caller_is_empty {
        return Ok("load-here".into());
    }

    spawn_viewer_window(&app, canon.to_string_lossy().into_owned())?;
    Ok("new-window".into())
}

/// 起動時に開くべきファイルを返す。
/// PendingOpen (Finder 経由 / 新規ウィンドウの割り当て) を優先し、
/// main ウィンドウのみ CLI 引数 (argv[1]) にフォールバックする。
#[tauri::command]
fn get_startup_file(
    window: tauri::WebviewWindow,
    pending: State<'_, PendingOpen>,
) -> Option<String> {
    if let Some(p) = pending.0.lock().unwrap().remove(window.label()) {
        return Some(p);
    }
    if window.label() == "main" {
        let arg = std::env::args().nth(1)?;
        let p = PathBuf::from(arg).canonicalize().ok()?;
        return p.is_file().then(|| p.to_string_lossy().into_owned());
    }
    None
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
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            // このクロージャは UI (メイン) スレッドで実行される。
            let issue = (|| -> windows::core::Result<()> {
                let controller = platform.controller();
                let webview = unsafe { controller.CoreWebView2()? };
                let webview7: ICoreWebView2_7 = webview.cast()?;
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
                // 設定 None で既定の用紙設定で書き出す
                unsafe { webview7.PrintToPdf(&HSTRING::from(dest.as_str()), None, &handler)? };
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

/// 指定ファイルを開く新しいビューアウィンドウを作る。
/// パスは PendingOpen に積み、フロントエンドが起動時に取り出す。
fn spawn_viewer_window(app: &AppHandle, path: String) -> Result<(), String> {
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

    // 既存の前面ウィンドウと完全に重ならないよう、少しずらして出す (カスケード)
    if let Some(origin) = app.webview_windows().values().find_map(|w| {
        if !w.is_focused().unwrap_or(false) {
            return None;
        }
        let pos = w.outer_position().ok()?;
        let scale = w.scale_factor().ok()?;
        Some((pos.x as f64 / scale, pos.y as f64 / scale))
    }) {
        builder = builder.position(origin.0 + 28.0, origin.1 + 28.0);
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
    let shown_map: HashMap<String, PathBuf> =
        app.state::<ShownFiles>().0.lock().unwrap().clone();

    // 既に表示しているウィンドウがあれば前面化するだけ
    if let Some((label, _)) = shown_map.iter().find(|(_, p)| **p == path) {
        focus_window(app, label);
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

    // まだ何も表示していないウィンドウ(起動直後など)があればそこで開く
    let empty = windows
        .keys()
        .find(|l| !shown_map.contains_key(*l))
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
        .manage(ShownFiles::default())
        .manage(PendingOpen::default())
        .menu(|handle| build_menu(handle))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => emit_to_focused(app, "menu:open"),
            "export_pdf" => emit_to_focused(app, "menu:export-pdf"),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            read_md_file,
            watch_file,
            open_in_editor,
            open_path,
            register_shown_file,
            get_startup_file,
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
                .filter_map(|p| p.canonicalize().ok())
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
                .state::<ShownFiles>()
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
        }
        _ => {}
    });
}
