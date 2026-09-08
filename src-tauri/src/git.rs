//! git 連携。gitoxide (gix) で完結し、外部の `git` コマンドには依存しない。
//!
//! プロジェクトウィンドウの「変更」ペインが使う。ツリー (read_md_tree) とは
//! 別のコマンドに分けてある。木の構造が変わるのは md が増減したときだけだが、
//! git の状態は保存やコミットのたびに変わる — 更新の契機が違うため。

use crate::is_markdown_path;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 比較の端点。フロントから JSON で来る。
///
/// `merge-base` は「その revision と end との分岐点」を指す。end が決まらないと
/// 定まらないので、解決は changes() の中で end を見てから行う。
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Endpoint {
    /// ディスク上の状態
    Worktree,
    /// ステージ (index)
    Index,
    /// revspec (HEAD / main / origin/main / HEAD~3 / SHA)
    Rev { spec: String },
    /// end との分岐点
    MergeBase { spec: String },
}

/// 1 ファイルの変化。path はフロントがそのまま open_path へ渡せる絶対パス。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    /// リポジトリ相対 (表示用)
    rel: String,
    /// "M" 変更 / "A" 追加 / "D" 削除 / "R" 改名 / "U" コンフリクト / "?" 未追跡
    state: &'static str,
    /// 改名元。表示用のリポジトリ相対パス (state が "R" のときだけ)
    from: Option<String>,
    /// 同じく改名元の絶対パス。起点版を開く ID を組むのに使う
    from_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    entries: Vec<Change>,
    /// md 以外で変わったファイルの数 (脚注に出す)
    others: usize,
    /// 解決された起点のコミット (40 桁)。作業ツリー / ステージが起点なら空。
    /// フロントは起点版を開く ID (rev:/<sha>/…) に使うので、短縮しない。
    start_id: String,
    /// 同じく終点。作業ツリー / ステージなら空 (実ファイルを開けばよい)
    end_id: String,
}

/// ウィンドウを開いたときに 1 度だけ聞く、リポジトリの素性。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    /// リポジトリのトップ。root がその配下にある
    workdir: String,
    /// ブランチ名。detached なら短縮 SHA
    head: String,
    detached: bool,
    /// 最後に fetch した時刻 (epoch ミリ秒)。fetch した記録が無ければ None
    fetched_at: Option<u64>,
    /// 既定の比較相手。上から順に解決できたものを使う
    default_base: Option<String>,
}

/// 既定の比較相手を当てる。git は分岐元を記録しないので推定するしかない。
/// 外したときは範囲の選択で直せるので、当たりやすい順に試すだけにする。
fn default_base(repo: &gix::Repository) -> Option<String> {
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|spec| repo.rev_parse_single(*spec).is_ok())
        .map(|s| s.to_string())
}

fn open(root: &str) -> Result<gix::Repository, String> {
    gix::discover(root).map_err(|e| e.to_string())
}

/// `.git/FETCH_HEAD` の更新時刻。fetch のたびに必ず書かれるので、これが
/// 最終取得時刻になる。clone 以来 fetch していないリポジトリには存在しない。
fn fetched_at(repo: &gix::Repository) -> Option<u64> {
    let meta = std::fs::metadata(repo.git_dir().join("FETCH_HEAD")).ok()?;
    let t = meta.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}

/// git 管理下かどうかを調べる。管理外なら Ok(None) — フロントは変更ペインを出さない。
#[tauri::command]
pub async fn git_probe(root: String) -> Result<Option<GitProbe>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(repo) = open(&root) else { return Ok(None) };
        let Some(workdir) = repo.workdir().map(|p| p.to_string_lossy().into_owned()) else {
            // bare リポジトリには作業ツリーが無いので対象外
            return Ok(None);
        };
        let name = repo.head_name().map_err(|e| e.to_string())?;
        let (head, detached) = match name {
            Some(n) => (n.shorten().to_string(), false),
            None => {
                let id = repo.head_id().map_err(|e| e.to_string())?;
                (id.shorten_or_id().to_string(), true)
            }
        };
        Ok(Some(GitProbe {
            workdir,
            head,
            detached,
            fetched_at: fetched_at(&repo),
            default_base: default_base(&repo),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- 変更の一覧 ----------

fn rev(repo: &gix::Repository, spec: &str) -> Result<gix::ObjectId, String> {
    repo.rev_parse_single(spec)
        .map(|id| id.detach())
        .map_err(|_| format!("解決できません: {spec}"))
}

fn tree_of(repo: &gix::Repository, id: gix::ObjectId) -> Result<gix::ObjectId, String> {
    repo.find_commit(id)
        .map_err(|e| e.to_string())?
        .tree_id()
        .map(|t| t.detach())
        .map_err(|e| e.to_string())
}

/// 1 ファイルぶんの途中集計。gix は「起点→index」と「index→作業ツリー」を
/// 別々に返すので、同じパスの 2 つを畳んで正味の差分にする。
#[derive(Default)]
struct Acc {
    staged: Option<&'static str>,
    unstaged: Option<&'static str>,
    from: Option<String>,
}

/// 起点から見た正味の状態。`git diff` が 1 行で見せるものに合わせる。
fn merge_states(staged: Option<&'static str>, unstaged: Option<&'static str>) -> Option<&'static str> {
    match (staged, unstaged) {
        (Some("U"), _) | (_, Some("U")) => Some("U"),
        (None, u) => u,
        (s, None) => s,
        // 足してから消したものは、起点から見れば何も変わっていない
        (Some("A"), Some("D")) => None,
        (Some("A"), _) => Some("A"),
        (Some("R"), Some("D")) => Some("D"),
        (Some("R"), _) => Some("R"),
        (_, Some("D")) => Some("D"),
        (s, _) => s,
    }
}

/// status を 1 度回して集計に足す。
///
/// `head_tree()` で基準の tree を差し替えられるので、任意の地点を起点にした
/// 「起点 → 作業ツリー」がこれ 1 回で取れる (git だと diff と ls-files の 2 回)。
/// untracked を `Files` にするのは、既定の `Collapsed` だと新しいディレクトリが
/// 畳まれて中の md が見えなくなるため。
fn collect_status(
    repo: &gix::Repository,
    start_tree: gix::ObjectId,
    use_tree_index: bool,
    use_index_worktree: bool,
    acc: &mut HashMap<String, Acc>,
) -> Result<(), String> {
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(|e| e.to_string())?
        .head_tree(start_tree)
        .untracked_files(gix::status::UntrackedFiles::Files)
        .into_iter(None)
        .map_err(|e| e.to_string())?;

    for item in iter {
        match item.map_err(|e| e.to_string())? {
            gix::status::Item::TreeIndex(c) if use_tree_index => {
                use gix::diff::index::ChangeRef as C;
                let (state, rel, from) = match c {
                    C::Addition { location, .. } => ("A", location.to_string(), None),
                    C::Deletion { location, .. } => ("D", location.to_string(), None),
                    C::Modification { location, .. } => ("M", location.to_string(), None),
                    C::Rewrite {
                        source_location,
                        location,
                        ..
                    } => ("R", location.to_string(), Some(source_location.to_string())),
                };
                let e = acc.entry(rel).or_default();
                e.staged = Some(state);
                if from.is_some() {
                    e.from = from;
                }
            }
            gix::status::Item::IndexWorktree(c) if use_index_worktree => {
                use gix::status::index_worktree::Item as I;
                use gix::status::plumbing::index_as_worktree::{Change as WC, EntryStatus};
                match c {
                    I::Modification {
                        rela_path, status, ..
                    } => {
                        let state = match status {
                            EntryStatus::Conflict { .. } => "U",
                            EntryStatus::Change(WC::Removed) => "D",
                            EntryStatus::Change(_) => "M",
                            // NeedsUpdate は stat 情報が古いだけで中身は同じ
                            _ => continue,
                        };
                        acc.entry(rela_path.to_string()).or_default().unstaged = Some(state);
                    }
                    I::DirectoryContents { entry, .. } => {
                        acc.entry(entry.rela_path.to_string()).or_default().unstaged = Some("?");
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// コミット同士の比較。作業ツリーも index も関わらない。
fn collect_tree_diff(
    repo: &gix::Repository,
    a: gix::ObjectId,
    b: gix::ObjectId,
    acc: &mut HashMap<String, Acc>,
) -> Result<(), String> {
    let old = repo.find_tree(a).map_err(|e| e.to_string())?;
    let new = repo.find_tree(b).map_err(|e| e.to_string())?;
    let changes = repo
        .diff_tree_to_tree(Some(&old), Some(&new), None)
        .map_err(|e| e.to_string())?;

    for c in changes {
        use gix::diff::tree_with_rewrites::Change as C;
        let (state, rel, from) = match c {
            C::Addition { location, .. } => ("A", location.to_string(), None),
            C::Deletion { location, .. } => ("D", location.to_string(), None),
            C::Modification { location, .. } => ("M", location.to_string(), None),
            C::Rewrite {
                source_location,
                location,
                ..
            } => ("R", location.to_string(), Some(source_location.to_string())),
        };
        let e = acc.entry(rel).or_default();
        e.staged = Some(state);
        if from.is_some() {
            e.from = from;
        }
    }
    Ok(())
}

/// start から end までの間に変わった md を返す。
#[tauri::command]
pub async fn git_changes(
    root: String,
    start: Endpoint,
    end: Endpoint,
) -> Result<GitChanges, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let workdir: PathBuf = repo
            .workdir()
            .ok_or_else(|| "作業ツリーがありません".to_string())?
            .to_path_buf();
        let head = || repo.head_id().map(|i| i.detach()).map_err(|e| e.to_string());

        // end 側のコミット。start に分岐点を指定されたときの相手にもなる
        let end_commit = match &end {
            Endpoint::Worktree | Endpoint::Index => head()?,
            Endpoint::Rev { spec } => rev(&repo, spec)?,
            Endpoint::MergeBase { spec } => {
                let x = rev(&repo, spec)?;
                repo.merge_base(x, head()?)
                    .map_err(|e| e.to_string())?
                    .detach()
            }
        };

        let mut acc: HashMap<String, Acc> = HashMap::new();
        let mut start_id = String::new();

        match (&start, &end) {
            // ステージ済み → 作業ツリー。まだステージしていないぶんだけ
            (Endpoint::Index, Endpoint::Worktree) => {
                collect_status(&repo, tree_of(&repo, head()?)?, false, true, &mut acc)?;
            }
            (Endpoint::Index, _) | (Endpoint::Worktree, _) => {
                return Err("その向きの比較には対応していません".into());
            }
            (s, e) => {
                let start_commit = match s {
                    Endpoint::Rev { spec } => rev(&repo, spec)?,
                    Endpoint::MergeBase { spec } => {
                        let x = rev(&repo, spec)?;
                        repo.merge_base(x, end_commit)
                            .map_err(|e| e.to_string())?
                            .detach()
                    }
                    _ => unreachable!("上で弾いている"),
                };
                start_id = start_commit.to_hex().to_string();
                let start_tree = tree_of(&repo, start_commit)?;
                match e {
                    Endpoint::Worktree => collect_status(&repo, start_tree, true, true, &mut acc)?,
                    Endpoint::Index => collect_status(&repo, start_tree, true, false, &mut acc)?,
                    _ => {
                        let end_tree = tree_of(&repo, end_commit)?;
                        collect_tree_diff(&repo, start_tree, end_tree, &mut acc)?;
                    }
                }
            }
        }

        // 畳んで md だけにする。md 以外は数だけ添える
        let mut entries = Vec::new();
        let mut others = 0usize;
        for (rel, a) in acc {
            let Some(state) = merge_states(a.staged, a.unstaged) else {
                continue;
            };
            let path = workdir.join(&rel);
            if !is_markdown_path(&path) {
                others += 1;
                continue;
            }
            let from_path = a
                .from
                .as_ref()
                .map(|f| workdir.join(f).to_string_lossy().into_owned());
            entries.push(Change {
                path: path.to_string_lossy().into_owned(),
                rel,
                state,
                from: a.from,
                from_path,
            });
        }
        entries.sort_by(|a, b| a.rel.cmp(&b.rel));

        let end_id = match &end {
            Endpoint::Worktree | Endpoint::Index => String::new(),
            _ => end_commit.to_hex().to_string(),
        };

        Ok(GitChanges {
            entries,
            others,
            start_id,
            end_id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- 比較の相手の候補 ----------

/// 候補 1 つ。分岐点として使えるかどうかまで決めて返す。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    /// 表示名 ("main" / "origin/main" / "v0.1.3")
    name: String,
    /// "branch" | "remote" | "tag"
    kind: &'static str,
    /// その ref が指す短縮 SHA
    id: String,
    /// end と分かれているか。true のものだけ「分岐点」として意味を持つ
    /// (end に取り込み済みのブランチは分岐点 = そのブランチ自身になるため)
    diverged: bool,
    /// 分岐点の短縮 SHA / 日時 (epoch ミリ秒) / 件名。diverged のときだけ入る
    base: Option<String>,
    base_time: Option<i64>,
    base_summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    entries: Vec<RefEntry>,
    /// 最後に fetch した時刻。リモートの見出しに出す
    fetched_at: Option<u64>,
}

/// end に対する候補の一覧。end が決まらないと分岐点が定まらないので end を受け取る。
#[tauri::command]
pub async fn git_refs(root: String, end: Endpoint) -> Result<GitRefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let head = || repo.head_id().map(|i| i.detach()).map_err(|e| e.to_string());
        let end_commit = match &end {
            Endpoint::Worktree | Endpoint::Index => head()?,
            Endpoint::Rev { spec } => rev(&repo, spec)?,
            Endpoint::MergeBase { spec } => {
                let x = rev(&repo, spec)?;
                repo.merge_base(x, head()?)
                    .map_err(|e| e.to_string())?
                    .detach()
            }
        };

        let mut entries = Vec::new();
        // loose と packed の両方が返るので、名前で重複を落とす
        let mut seen = std::collections::HashSet::new();

        for r in repo
            .references()
            .map_err(|e| e.to_string())?
            .all()
            .map_err(|e| e.to_string())?
        {
            let Ok(mut r) = r else { continue };
            let full = r.name().as_bstr().to_string();
            let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
                ("branch", n.to_string())
            } else if let Some(n) = full.strip_prefix("refs/remotes/") {
                ("remote", n.to_string())
            } else if let Some(n) = full.strip_prefix("refs/tags/") {
                ("tag", n.to_string())
            } else {
                continue;
            };
            if !seen.insert(full) {
                continue;
            }
            let Ok(id) = r.peel_to_id() else { continue };
            let id = id.detach();

            // 分岐点が意味を持つのは、end に取り込まれていないものだけ。
            // 取り込み済みなら merge-base はその ref 自身になり、そのまま
            // 指定したときと同じ結果になる。
            let mut diverged = false;
            let (mut base, mut base_time, mut base_summary) = (None, None, None);
            if id != end_commit {
                if let Ok(mb) = repo.merge_base(id, end_commit) {
                    let mb = mb.detach();
                    if mb != id && mb != end_commit {
                        diverged = true;
                        base = Some(mb.to_hex_with_len(7).to_string());
                        if let Ok(c) = repo.find_commit(mb) {
                            base_time = c.time().ok().map(|t| t.seconds * 1000);
                            base_summary = c.message().ok().map(|m| m.summary().to_string());
                        }
                    }
                }
            }

            entries.push(RefEntry {
                name,
                kind,
                id: id.to_hex_with_len(7).to_string(),
                diverged,
                base,
                base_time,
                base_summary,
            });
        }

        entries.sort_by(|a, b| a.kind.cmp(b.kind).then(a.name.cmp(&b.name)));
        Ok(GitRefs {
            entries,
            fetched_at: fetched_at(&repo),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- 起点版のファイル ----------

/// その地点でのファイルの中身。path は絶対パスで、そこからリポジトリを探す。
/// 画像も読むのでバイト列で返す (テキストに限らない)。
pub(crate) fn blob_at(rev: &str, path: &Path) -> Result<Vec<u8>, String> {
    let dir = path.parent().ok_or_else(|| "パスが不正です".to_string())?;
    let repo = gix::discover(dir).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "作業ツリーがありません".to_string())?;
    let rel = path
        .strip_prefix(workdir)
        .map_err(|_| "リポジトリの外です".to_string())?;
    let id = repo
        .rev_parse_single(rev)
        .map_err(|_| format!("解決できません: {rev}"))?;
    let mut tree = repo
        .find_commit(id)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let entry = tree
        .peel_to_entry_by_path(rel)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "その地点には存在しません".to_string())?;
    // repo より長生きしないよう、いったん束縛してから複製する
    let object = entry.object().map_err(|e| e.to_string())?;
    let data = object.data.clone();
    Ok(data)
}

/// 起点版の本文。Markdown を読むのに使う (画像は rev: のプロトコルが返す)。
#[tauri::command]
pub async fn git_blob(rev: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = blob_at(&rev, Path::new(&path))?;
        String::from_utf8(data).map_err(|_| "テキストとして読めません".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `/<sha>/<絶対パス>` を割る。POSIX は先頭のスラッシュを戻し、
/// Windows の `C:/…` はそのまま扱う。
pub(crate) fn split_rev_path(p: &str) -> Option<(String, PathBuf)> {
    let (sha, rest) = p.trim_start_matches('/').split_once('/')?;
    if sha.is_empty() || rest.is_empty() {
        return None;
    }
    let win = rest.as_bytes().get(1) == Some(&b':')
        && rest.as_bytes()[0].is_ascii_alphabetic();
    let abs = if win { rest.to_string() } else { format!("/{rest}") };
    Some((sha.to_string(), PathBuf::from(abs)))
}

/// 拡張子から Content-Type を当てる。ここに無いものは octet-stream にして
/// WebView の判断に任せる (画像として貼られていれば大抵は表示される)。
pub(crate) fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("pdf") => "application/pdf",
        Some("md" | "markdown" | "mdown" | "mkd") => "text/markdown; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// パーセントデコード。日本語のファイル名が URL で届くため必要になる。
/// これだけのために依存を増やしたくないので自前で持つ。
pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- 行の差分 ----------

/// 変わったまとまり。行番号は 0 始まりで、終端は含まない。
/// 片側が空 (start == end) なら、もう片方だけの追加 / 削除を意味する。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    before_start: u32,
    before_end: u32,
    after_start: u32,
    after_end: u32,
}

/// タブの ID から中身を読む。実ファイルのパスと起点版の ID のどちらも受ける。
pub(crate) fn read_target(id: &str) -> Result<Vec<u8>, String> {
    match id.strip_prefix("rev:") {
        Some(rest) => {
            let (sha, path) =
                split_rev_path(rest).ok_or_else(|| "ID の形が違います".to_string())?;
            blob_at(&sha, &path)
        }
        None => std::fs::read(id).map_err(|e| e.to_string()),
    }
}

/// 2 つの版の行差分。左右に並べたときの目印と、変更箇所への移動に使う。
///
/// 差分そのものは gix (imara-diff) が計算する。フロントは行番号を
/// markdown-it のトークンが持つ行範囲と突き合わせて、変わったブロックに
/// 印を付ける。
#[tauri::command]
pub async fn git_hunks(before: String, after: String) -> Result<Vec<Hunk>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let a = String::from_utf8(read_target(&before)?)
            .map_err(|_| "テキストとして読めません".to_string())?;
        let b = String::from_utf8(read_target(&after)?)
            .map_err(|_| "テキストとして読めません".to_string())?;

        use gix::diff::blob::{Algorithm, Diff, InternedInput};
        let input = InternedInput::new(a.as_str(), b.as_str());
        let diff = Diff::compute(Algorithm::Histogram, &input);
        Ok(diff
            .hunks()
            .map(|h| Hunk {
                before_start: h.before.start,
                before_end: h.before.end,
                after_start: h.after.start,
                after_end: h.after.end,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
