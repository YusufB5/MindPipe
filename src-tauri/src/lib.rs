use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

mod bundle;
mod dropfile;

const CAPTURE_SHORTCUT: &str = "Ctrl+Shift+N";
const EMBEDDED_MCP_SERVER: &str = include_str!("../../mcp-server.cjs");

/// Tray menu entries, kept so their text can follow the UI language.
struct TrayItems {
    open: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}

#[tauri::command]
fn set_tray_language(app: AppHandle, lang: String) -> Result<(), String> {
    let (open, quit) = if lang == "en" {
        ("Open MindPipe", "Quit")
    } else {
        ("MindPipe'ı Aç", "Çıkış")
    };
    if let Some(items) = app.try_state::<TrayItems>() {
        items.open.set_text(open).map_err(|e| e.to_string())?;
        items.quit.set_text(quit).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_mcp_server(app_dir: &std::path::Path) {
    let target = app_dir.join("mcp-server.cjs");
    let needs_write = match fs::read_to_string(&target) {
        Ok(existing) => existing != EMBEDDED_MCP_SERVER,
        Err(_) => true,
    };
    if needs_write {
        let _ = fs::write(target, EMBEDDED_MCP_SERVER);
    }
}

fn get_saved_capture_shortcut(app_dir: &std::path::Path) -> String {
    let settings_path = app_dir.join("shortcuts.json");
    if let Ok(content) = fs::read_to_string(&settings_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(s) = val.get("captureShortcut").and_then(|v| v.as_str()) {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    CAPTURE_SHORTCUT.to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EntryMeta {
    id: String,
    name: String,
    path: String,
    image_paths: Vec<String>,
    kind: String, // "note" | "image" | "mixed"
    modified: u128,
    preview: Option<String>,
    pinned: bool,
    is_ai: bool,
    tags: Vec<String>,
    /// Id of the parent note when this note is nested one level below another.
    parent_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TodoItem {
    id: String,
    text: String,
    done: bool,
    is_ai: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultItem {
    project: String,
    entry: EntryMeta,
    matched_snippet: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct McpLogEntry {
    id: String,
    timestamp: u64,
    tool: String,
    project: String,
    details: String,
    /// English wording of `details`, when the MCP server provided one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details_en: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct McpSessionInfo {
    client: Option<String>,
    last_active: Option<u64>,
    last_tool: Option<String>,
    last_project: Option<String>,
}

fn default_only_ai() -> String {
    "only_ai".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct McpPermissions {
    #[serde(default)]
    blocked_projects: Vec<String>,
    #[serde(default = "default_only_ai")]
    allow_ai_edit: String,
    #[serde(default = "default_only_ai")]
    allow_ai_delete: String,
    /// Per-project overrides keyed by lowercase project name. A missing field means "follow global".
    #[serde(default)]
    project_overrides: std::collections::BTreeMap<String, ProjectPermOverride>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectPermOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allow_ai_edit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allow_ai_delete: Option<String>,
}

fn load_permissions(perm_path: &PathBuf) -> McpPermissions {
    fs::read_to_string(perm_path)
        .ok()
        .and_then(|c| serde_json::from_str::<McpPermissions>(&c).ok())
        .unwrap_or_else(|| McpPermissions {
            blocked_projects: Vec::new(),
            allow_ai_edit: "only_ai".into(),
            allow_ai_delete: "only_ai".into(),
            project_overrides: Default::default(),
        })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    is_configured: bool,
    allowed_all: bool,
    allowed_projects: Vec<String>,
    is_live_processing: bool,
    detected_client: Option<String>,
    last_active_time: Option<u64>,
    blocked_projects: Vec<String>,
    ai_projects: Vec<String>,
    allow_ai_edit: String,
    allow_ai_delete: String,
    project_overrides: std::collections::BTreeMap<String, ProjectPermOverride>,
    server_script_path: Option<String>,
    logs: Vec<McpLogEntry>,
}

/// Root folder for all projects, e.g. `%APPDATA%/com.mindpipe.app/projects`.
/// Creates itself (and an "inbox" project) on first use.
fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let inbox = dir.join("inbox");
    if !inbox.exists() {
        fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Rejects path-traversal or otherwise unsafe project names -- a project
/// name becomes a literal folder name on disk, nothing fancier.
fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Proje adı boş olamaz".into());
    }
    if trimmed.contains(['/', '\\', '.']) || trimmed == ".." {
        return Err("Proje adı geçersiz karakter içeriyor".into());
    }
    Ok(trimmed.to_string())
}

/// `YYYY-MM-DD_HHMMSS` that no file in `dir` starts with yet (the second is bumped on collision),
/// so notes saved in quick succession, such as a batch of dropped files, never overwrite each other.
fn unique_timestamp_stem(dir: &std::path::Path) -> String {
    let mut t = chrono::Local::now();
    loop {
        let stem = t.format("%Y-%m-%d_%H%M%S").to_string();
        let taken = fs::read_dir(dir)
            .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with(&stem)))
            .unwrap_or(false);
        if !taken {
            return stem;
        }
        t += chrono::Duration::seconds(1);
    }
}

/// Writes `data` to a temp file next to `path` and renames it over the target, so readers
/// (and the MCP server) only ever see the complete old or complete new file.
fn atomic_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let dir = path.parent().ok_or("Geçersiz dosya yolu")?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("Geçersiz dosya adı")?;
    let tmp = dir.join(format!(".{}.{}.tmp", name, std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    let mut last_err = String::new();
    for _ in 0..8 {
        match fs::rename(&tmp, path) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err)
}

/// Cross-process lock for read-modify-write of a project's metadata files.
/// The MCP server uses the same `.lock` file protocol (create-new, stale after 5s).
struct DirLock(Option<PathBuf>);

impl Drop for DirLock {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = fs::remove_file(p);
        }
    }
}

fn lock_dir(dir: &std::path::Path) -> Result<DirLock, String> {
    let lock_path = dir.join(".lock");
    let start = std::time::Instant::now();
    loop {
        match fs::OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(_) => return Ok(DirLock(Some(lock_path))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map_or(false, |d| d.as_secs() >= 5);
                if stale {
                    let _ = fs::remove_file(&lock_path);
                    continue;
                }
                if start.elapsed() > std::time::Duration::from_secs(4) {
                    return Err("Proje şu anda başka bir işlem tarafından kullanılıyor, tekrar deneyin.".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            // Folder does not exist (yet): nothing to protect.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DirLock(None)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Re-reads tag/tree metadata under the project lock and drops records of notes that
/// no longer exist, unused tag definitions and invalid hierarchy links.
fn prune_metadata(dir: &PathBuf, live: &std::collections::HashSet<String>) {
    let _lock = match lock_dir(dir) {
        Ok(l) => l,
        Err(_) => return,
    };
    let mut tags = get_tag_store(dir);
    let before = (tags.entries.len(), tags.definitions.len());
    tags.entries.retain(|id, _| live.contains(id));
    cleanup_unused_tags(&mut tags);
    if (tags.entries.len(), tags.definitions.len()) != before {
        let _ = save_tag_store(dir, &tags);
    }
    let mut tree = get_tree_store(dir);
    let snapshot = tree.parents.clone();
    let tree_before = tree.parents.len();
    tree.parents
        .retain(|c, p| live.contains(c) && live.contains(p) && !snapshot.contains_key(p));
    if tree.parents.len() != tree_before {
        let _ = save_tree_store(dir, &tree);
    }
}

fn file_modified_ms(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_base_key(file_stem: &str) -> String {
    // If the file stem starts with standard YYYY-MM-DD_HHMMSS (17 chars: "2026-08-23_203728")
    if file_stem.len() >= 17 {
        let prefix = &file_stem[..17];
        let chars: Vec<char> = prefix.chars().collect();
        if chars.len() == 17
            && chars[0..4].iter().all(|c| c.is_ascii_digit())
            && chars[4] == '-'
            && chars[5..7].iter().all(|c| c.is_ascii_digit())
            && chars[7] == '-'
            && chars[8..10].iter().all(|c| c.is_ascii_digit())
            && chars[10] == '_'
            && chars[11..17].iter().all(|c| c.is_ascii_digit())
        {
            return prefix.to_string();
        }
    }
    // Fallback: strip _note
    let s = file_stem.trim_end_matches("_note");
    s.to_string()
}

fn get_pinned_ids(project_dir: &PathBuf) -> Vec<String> {
    let pin_file = project_dir.join(".pinned.json");
    if pin_file.exists() {
        if let Ok(content) = fs::read_to_string(&pin_file) {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                return ids;
            }
        }
    }
    Vec::new()
}

fn save_pinned_ids(project_dir: &PathBuf, ids: &[String]) -> Result<(), String> {
    let pin_file = project_dir.join(".pinned.json");
    let json = serde_json::to_string_pretty(ids).map_err(|e| e.to_string())?;
    atomic_write(&pin_file, json.as_bytes())?;
    Ok(())
}

#[tauri::command]
fn toggle_pin_entry(app: AppHandle, project: String, entry_id: String) -> Result<bool, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let _lock = lock_dir(&dir)?;
    let mut ids = get_pinned_ids(&dir);
    let is_pinned = if let Some(pos) = ids.iter().position(|id| id == &entry_id) {
        ids.remove(pos);
        false
    } else {
        ids.push(entry_id);
        true
    };
    save_pinned_ids(&dir, &ids)?;
    let _ = app.emit("notes-updated", ());
    Ok(is_pinned)
}

/// A note the AI moved to `<project>/.trash` (restorable from the app).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    file: String,
    original: String,
    preview: String,
    deleted_at: u64,
    deleted_by: String,
    tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct TrashMeta {
    #[serde(default)]
    original: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    deleted_at: u64,
    #[serde(default)]
    deleted_by: String,
}

fn trash_dir(app: &AppHandle, project: &str) -> Result<(PathBuf, PathBuf), String> {
    let clean = sanitize_name(project)?;
    let dir = projects_root(app)?.join(clean);
    let trash = dir.join(".trash");
    Ok((dir, trash))
}

fn read_trash_meta(trash: &PathBuf) -> HashMap<String, TrashMeta> {
    fs::read_to_string(trash.join(".meta.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn write_trash_meta(trash: &PathBuf, meta: &HashMap<String, TrashMeta>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    atomic_write(&trash.join(".meta.json"), json.as_bytes())
}

/// Rejects anything that is not a plain file name inside `.trash`.
fn safe_trash_file(file: &str) -> Result<(), String> {
    if file.is_empty() || file.starts_with('.') || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("Geçersiz dosya adı".into());
    }
    Ok(())
}

#[tauri::command]
fn list_trash(app: AppHandle, project: String) -> Result<Vec<TrashItem>, String> {
    let (_, trash) = trash_dir(&app, &project)?;
    if !trash.exists() {
        return Ok(vec![]);
    }
    let meta = read_trash_meta(&trash);
    let mut items: Vec<TrashItem> = fs::read_dir(&trash)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            if file.starts_with('.') {
                return None;
            }
            let m = meta.get(&file).cloned().unwrap_or_default();
            let modified = e
                .metadata()
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let preview = if file.ends_with(".md") {
                fs::read_to_string(e.path())
                    .map(|c| c.trim().chars().take(140).collect::<String>())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            Some(TrashItem {
                original: if m.original.is_empty() { file.clone() } else { m.original },
                file,
                preview,
                deleted_at: if m.deleted_at > 0 { m.deleted_at } else { modified },
                deleted_by: if m.deleted_by.is_empty() { "ai".into() } else { m.deleted_by },
                tags: m.tags,
            })
        })
        .collect();
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

#[tauri::command]
fn restore_trash_item(app: AppHandle, project: String, file: String) -> Result<(), String> {
    safe_trash_file(&file)?;
    let (dir, trash) = trash_dir(&app, &project)?;
    let _lock = lock_dir(&dir)?;
    let src = trash.join(&file);
    if !src.is_file() {
        return Err("Çöp kutusunda bulunamadı".into());
    }
    let mut meta = read_trash_meta(&trash);
    let m = meta.remove(&file).unwrap_or_default();

    let original = if m.original.is_empty() { file.clone() } else { m.original.clone() };
    safe_trash_file(&original)?;
    let mut dest = dir.join(&original);
    if dest.exists() {
        let p = PathBuf::from(&original);
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("restored");
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("md");
        dest = dir.join(format!("{}_restored.{}", stem, ext));
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    write_trash_meta(&trash, &meta)?;

    let key = extract_base_key(dest.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
    if !m.tags.is_empty() {
        let mut store = get_tag_store(&dir);
        for t in &m.tags {
            store.definitions.entry(t.clone()).or_insert_with(|| "#3b82f6".to_string());
        }
        store.entries.insert(key.clone(), m.tags.clone());
        save_tag_store(&dir, &store)?;
    }
    if m.pinned {
        let mut ids = get_pinned_ids(&dir);
        if !ids.contains(&key) {
            ids.push(key);
            save_pinned_ids(&dir, &ids)?;
        }
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn purge_trash_item(app: AppHandle, project: String, file: String) -> Result<(), String> {
    safe_trash_file(&file)?;
    let (dir, trash) = trash_dir(&app, &project)?;
    let _lock = lock_dir(&dir)?;
    let target = trash.join(&file);
    if target.is_file() {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    let mut meta = read_trash_meta(&trash);
    if meta.remove(&file).is_some() {
        write_trash_meta(&trash, &meta)?;
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// One-level note hierarchy stored in `.tree.json`: child id -> parent id.
#[derive(Serialize, Deserialize, Default, Clone)]
struct TreeStore {
    #[serde(default)]
    parents: HashMap<String, String>,
}

fn get_tree_store(project_dir: &PathBuf) -> TreeStore {
    fs::read_to_string(project_dir.join(".tree.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<TreeStore>(&c).ok())
        .unwrap_or_default()
}

fn save_tree_store(project_dir: &PathBuf, store: &TreeStore) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    atomic_write(&project_dir.join(".tree.json"), json.as_bytes())
}

/// Sets (or clears, when `parent_id` is None) the parent of a note.
/// The hierarchy is a single level: a parent cannot have a parent, and a
/// note that already has children cannot become a child.
#[tauri::command]
fn set_entry_parent(
    app: AppHandle,
    project: String,
    entry_id: String,
    parent_id: Option<String>,
) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let _lock = lock_dir(&dir)?;
    let mut store = get_tree_store(&dir);
    match parent_id {
        None => {
            store.parents.remove(&entry_id);
        }
        Some(parent) => {
            if parent == entry_id {
                return Err("Bir not kendi alt notu olamaz".into());
            }
            if store.parents.contains_key(&parent) {
                return Err("Hedef not zaten bir alt not (yalnızca tek seviye desteklenir)".into());
            }
            if store.parents.values().any(|p| p == &entry_id) {
                return Err("Alt notları olan bir not başka bir notun altına taşınamaz".into());
            }
            store.parents.insert(entry_id, parent);
        }
    }
    save_tree_store(&dir, &store)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// Startup preferences (`startup-settings.json`). Whether the OS launches the app at login is
/// stored by the OS itself (registry / launch agent / autostart entry), not in this file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StartupSettings {
    /// When launched at login, stay in the tray instead of opening the window.
    #[serde(default = "default_true")]
    start_hidden: bool,
}

fn default_true() -> bool {
    true
}

impl Default for StartupSettings {
    fn default() -> Self {
        StartupSettings { start_hidden: true }
    }
}

fn load_startup_settings(app_dir: &std::path::Path) -> StartupSettings {
    fs::read_to_string(app_dir.join("startup-settings.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<StartupSettings>(&c).ok())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupStatus {
    enabled: bool,
    start_hidden: bool,
    /// False in development builds, where registering the dev executable would be wrong.
    supported: bool,
}

fn startup_status(app: &AppHandle) -> Result<StartupStatus, String> {
    let root = projects_root(app)?;
    let app_dir = root.parent().unwrap_or(&root);
    Ok(StartupStatus {
        enabled: app.autolaunch().is_enabled().unwrap_or(false),
        start_hidden: load_startup_settings(app_dir).start_hidden,
        supported: !cfg!(debug_assertions),
    })
}

#[tauri::command]
fn get_startup_settings(app: AppHandle) -> Result<StartupStatus, String> {
    startup_status(&app)
}

#[tauri::command]
fn set_startup_settings(app: AppHandle, enabled: bool, start_hidden: bool) -> Result<StartupStatus, String> {
    if cfg!(debug_assertions) {
        return Err("Başlangıç ayarı yalnızca kurulu sürümde değiştirilebilir".into());
    }
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root).to_path_buf();
    let json = serde_json::to_string_pretty(&StartupSettings { start_hidden }).map_err(|e| e.to_string())?;
    atomic_write(&app_dir.join("startup-settings.json"), json.as_bytes())?;

    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else if autolaunch.is_enabled().unwrap_or(false) {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    startup_status(&app)
}

/// App-wide automatic trash cleanup policy (`trash-settings.json`). Off by default.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TrashSettings {
    #[serde(default)]
    enabled: bool,
    /// Items deleted more than this many days ago are removed.
    #[serde(default = "default_trash_days")]
    days: u32,
    /// Per project: when more items remain, the oldest ones are removed.
    #[serde(default = "default_trash_max")]
    max_items: u32,
}

fn default_trash_days() -> u32 {
    30
}

fn default_trash_max() -> u32 {
    100
}

impl Default for TrashSettings {
    fn default() -> Self {
        TrashSettings { enabled: false, days: 30, max_items: 100 }
    }
}

fn trash_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = projects_root(app)?;
    Ok(root.parent().unwrap_or(&root).join("trash-settings.json"))
}

fn load_trash_settings(app: &AppHandle) -> TrashSettings {
    trash_settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<TrashSettings>(&c).ok())
        .unwrap_or_default()
}

/// Removes expired / surplus items from every project's `.trash`. Returns how many were removed.
fn run_trash_policy(root: &PathBuf, settings: &TrashSettings) -> usize {
    if !settings.enabled {
        return 0;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let max_age_ms = settings.days as u64 * 24 * 60 * 60 * 1000;
    let mut removed_total = 0usize;

    let Ok(projects) = fs::read_dir(root) else { return 0 };
    for project in projects.flatten() {
        let dir = project.path();
        let trash = dir.join(".trash");
        if !dir.is_dir() || !trash.is_dir() {
            continue;
        }
        let Ok(_lock) = lock_dir(&dir) else { continue };
        let mut meta = read_trash_meta(&trash);

        let mut items: Vec<(String, u64)> = fs::read_dir(&trash)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| {
                let file = e.file_name().to_string_lossy().to_string();
                if file.starts_with('.') {
                    return None;
                }
                let at = meta
                    .get(&file)
                    .map(|m| m.deleted_at)
                    .filter(|t| *t > 0)
                    .unwrap_or_else(|| file_modified_ms(&e.path()));
                Some((file, at))
            })
            .collect();
        items.sort_by(|a, b| b.1.cmp(&a.1)); // newest first

        let mut doomed: Vec<String> = Vec::new();
        for (idx, (file, at)) in items.iter().enumerate() {
            let expired = now_ms.saturating_sub(*at) > max_age_ms;
            let surplus = idx >= settings.max_items as usize;
            if expired || surplus {
                doomed.push(file.clone());
            }
        }
        for file in &doomed {
            if fs::remove_file(trash.join(file)).is_ok() {
                meta.remove(file);
                removed_total += 1;
            }
        }
        if !doomed.is_empty() {
            let _ = write_trash_meta(&trash, &meta);
        }
    }
    removed_total
}

#[tauri::command]
fn get_trash_settings(app: AppHandle) -> TrashSettings {
    load_trash_settings(&app)
}

#[tauri::command]
fn set_trash_settings(
    app: AppHandle,
    enabled: bool,
    days: u32,
    max_items: u32,
) -> Result<TrashSettings, String> {
    let settings = TrashSettings {
        enabled,
        days: days.clamp(1, 3650),
        max_items: max_items.clamp(1, 100_000),
    };
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(&trash_settings_path(&app)?, json.as_bytes())?;
    let root = projects_root(&app)?;
    run_trash_policy(&root, &settings);
    let _ = app.emit("notes-updated", ());
    Ok(settings)
}

/// Permanently removes everything in one project's trash.
#[tauri::command]
fn empty_trash(app: AppHandle, project: String) -> Result<usize, String> {
    let (dir, trash) = trash_dir(&app, &project)?;
    if !trash.exists() {
        return Ok(0);
    }
    let _lock = lock_dir(&dir)?;
    let mut removed = 0usize;
    for entry in fs::read_dir(&trash).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !entry.path().is_file() {
            continue;
        }
        if fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    let _ = fs::remove_file(trash.join(".meta.json"));
    let _ = app.emit("notes-updated", ());
    Ok(removed)
}

/// Per-project tag data stored in `.tags.json`: tag name -> hex color,
/// and note id -> list of tag names.
#[derive(Serialize, Deserialize, Default, Clone)]
struct TagStore {
    #[serde(default)]
    definitions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    entries: HashMap<String, Vec<String>>,
}

fn get_tag_store(project_dir: &PathBuf) -> TagStore {
    fs::read_to_string(project_dir.join(".tags.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<TagStore>(&c).ok())
        .unwrap_or_default()
}

fn save_tag_store(project_dir: &PathBuf, store: &TagStore) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    atomic_write(&project_dir.join(".tags.json"), json.as_bytes())
}

fn cleanup_unused_tags(store: &mut TagStore) -> bool {
    let before_len = store.definitions.len();
    store.definitions.retain(|tag_name, _| {
        store.entries.values().any(|tags| tags.contains(tag_name))
    });
    store.definitions.len() != before_len
}

#[tauri::command]
fn get_project_tags(
    app: AppHandle,
    project: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let mut store = get_tag_store(&dir);
    cleanup_unused_tags(&mut store);
    Ok(store.definitions)
}

/// Replaces the tag list of one note. `definitions` carries any newly
/// created tags (name -> color) so they are persisted alongside.
#[tauri::command]
fn set_entry_tags(
    app: AppHandle,
    project: String,
    entry_id: String,
    tags: Vec<String>,
    definitions: std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let _lock = lock_dir(&dir)?;
    let mut store = get_tag_store(&dir);
    for (name, color) in definitions {
        store.definitions.entry(name).or_insert(color);
    }
    if tags.is_empty() {
        store.entries.remove(&entry_id);
    } else {
        store.entries.insert(entry_id, tags);
    }
    cleanup_unused_tags(&mut store);
    save_tag_store(&dir, &store)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// Removes a tag definition and strips it from every note.
#[tauri::command]
fn delete_project_tag(app: AppHandle, project: String, name: String) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let _lock = lock_dir(&dir)?;
    let mut store = get_tag_store(&dir);
    store.definitions.remove(&name);
    for tags in store.entries.values_mut() {
        tags.retain(|t| t != &name);
    }
    store.entries.retain(|_, tags| !tags.is_empty());
    save_tag_store(&dir, &store)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

fn parse_todos_from_file(file_path: &PathBuf) -> Vec<TodoItem> {
    let mut items = Vec::new();
    let is_project_ai = file_path.parent().map_or(false, |p| p.join(".ai").exists());
    if let Ok(content) = fs::read_to_string(file_path) {
        for (index, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            let (is_todo, done, raw_text) = if trimmed.starts_with("- [ ] ") {
                (true, false, &trimmed[6..])
            } else if trimmed.starts_with("- [x] ") || trimmed.starts_with("- [X] ") {
                (true, true, &trimmed[6..])
            } else {
                (false, false, "")
            };

            if is_todo {
                let has_ai_tag = raw_text.contains("<!--ai-->")
                    || raw_text.ends_with("[AI]")
                    || raw_text.ends_with("[ai]");
                let is_ai = has_ai_tag || is_project_ai;
                let clean_text = raw_text.replace("<!--ai-->", "").trim().to_string();

                items.push(TodoItem {
                    id: format!("todo_{}", index),
                    text: clean_text,
                    done,
                    is_ai,
                });
            }
        }
    }
    items
}

fn write_todos_to_file(file_path: &PathBuf, items: &[TodoItem]) -> Result<(), String> {
    let is_project_ai = file_path.parent().map_or(false, |p| p.join(".ai").exists());
    let mut lines = Vec::new();
    for item in items {
        let prefix = if item.done { "- [x]" } else { "- [ ]" };
        let suffix = if item.is_ai && !is_project_ai { " <!--ai-->" } else { "" };
        lines.push(format!("{} {}{}", prefix, item.text.trim(), suffix));
    }
    let content = lines.join("\n");
    atomic_write(file_path, content.as_bytes())?;
    Ok(())
}

#[tauri::command]
fn list_todos(app: AppHandle, project: String) -> Result<Vec<TodoItem>, String> {
    let clean = sanitize_name(&project)?;
    let file = projects_root(&app)?.join(clean).join("todos.md");
    Ok(parse_todos_from_file(&file))
}

#[tauri::command]
fn add_todo(app: AppHandle, project: String, text: String) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("todos.md");
    let _lock = lock_dir(&dir)?;
    let mut items = parse_todos_from_file(&file);
    items.insert(
        0,
        TodoItem {
            id: format!("todo_{}", chrono::Local::now().timestamp_millis()),
            text: text.trim().to_string(),
            done: false,
            is_ai: false,
        },
    );
    write_todos_to_file(&file, &items)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn toggle_todo(app: AppHandle, project: String, id: String, done: bool) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let file = projects_root(&app)?.join(clean).join("todos.md");
    let _lock = lock_dir(file.parent().unwrap_or(std::path::Path::new(".")))?;
    let mut items = parse_todos_from_file(&file);
    for item in &mut items {
        if item.id == id {
            item.done = done;
            break;
        }
    }
    write_todos_to_file(&file, &items)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_todo(app: AppHandle, project: String, id: String) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let file = projects_root(&app)?.join(clean).join("todos.md");
    let _lock = lock_dir(file.parent().unwrap_or(std::path::Path::new(".")))?;
    let mut items = parse_todos_from_file(&file);
    items.retain(|item| item.id != id);
    write_todos_to_file(&file, &items)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<String>, String> {
    let root = projects_root(&app)?;
    let mut names: Vec<String> = fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    if let Some(pos) = names.iter().position(|n| n == "inbox") {
        let inbox = names.remove(pos);
        names.insert(0, inbox);
    }
    Ok(names)
}

#[tauri::command]
fn create_project(app: AppHandle, name: String) -> Result<(), String> {
    let clean = sanitize_name(&name)?;
    let root = projects_root(&app)?;
    fs::create_dir_all(root.join(clean)).map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_project(app: AppHandle, name: String) -> Result<(), String> {
    let clean = sanitize_name(&name)?;
    if clean == "inbox" {
        return Err("inbox projesi silinemez".into());
    }
    let root = projects_root(&app)?;
    let dir = root.join(clean);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn open_project_folder(app: AppHandle, name: String) -> Result<(), String> {
    let clean = sanitize_name(&name)?;
    let dir = projects_root(&app)?.join(clean);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn get_order_ids(project_dir: &PathBuf) -> Vec<String> {
    let order_file = project_dir.join(".order.json");
    if order_file.exists() {
        if let Ok(content) = fs::read_to_string(&order_file) {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                return ids;
            }
        }
    }
    Vec::new()
}

fn save_order_ids(project_dir: &PathBuf, ids: &[String]) -> Result<(), String> {
    let order_file = project_dir.join(".order.json");
    let json = serde_json::to_string_pretty(ids).map_err(|e| e.to_string())?;
    atomic_write(&order_file, json.as_bytes())?;
    Ok(())
}

#[tauri::command]
fn reorder_entries(app: AppHandle, project: String, ordered_ids: Vec<String>) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    let _lock = lock_dir(&dir)?;
    save_order_ids(&dir, &ordered_ids)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn export_ai_context(app: AppHandle, project: String) -> Result<String, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(&clean);
    if !dir.exists() {
        return Err("Proje bulunamadı".into());
    }

    let entries = list_entries(app.clone(), project.clone())?;
    let todos = list_todos(app.clone(), project.clone())?;

    let mut output = String::new();
    output.push_str(&format!("# Proje Bağlamı: {}\n\n", clean));

    // 1. TODOs
    if !todos.is_empty() {
        output.push_str("## Yapılacaklar (TODO List)\n");
        let pending: Vec<_> = todos.iter().filter(|t| !t.done).collect();
        let completed: Vec<_> = todos.iter().filter(|t| t.done).collect();
        if !pending.is_empty() {
            output.push_str("### Bekleyen Görevler:\n");
            for t in pending {
                output.push_str(&format!("- [ ] {}\n", t.text));
            }
        }
        if !completed.is_empty() {
            output.push_str("\n### Tamamlanan Görevler:\n");
            for t in completed {
                output.push_str(&format!("- [x] {}\n", t.text));
            }
        }
        output.push_str("\n---\n\n");
    }

    // 2. Pinned Notes
    let pinned: Vec<_> = entries.iter().filter(|e| e.pinned).collect();
    if !pinned.is_empty() {
        output.push_str("## 📌 Sabitlenmiş Önemli Notlar & Kurallar\n\n");
        for e in pinned {
            output.push_str(&format!("### Sabit: {}\n", e.name));
            if e.kind != "image" {
                if let Ok(content) = fs::read_to_string(&e.path) {
                    output.push_str(&format!("{}\n\n", content.trim()));
                }
            }
            if !e.image_paths.is_empty() {
                output.push_str(&format!("*Ekli Görseller ({} adet)*\n\n", e.image_paths.len()));
            }
        }
        output.push_str("---\n\n");
    }

    // 3. Chronological / Ordered Notes
    let regular: Vec<_> = entries.iter().filter(|e| !e.pinned).collect();
    if !regular.is_empty() {
        output.push_str("## 📝 Notlar ve Kayıtlar\n\n");
        for e in regular {
            output.push_str(&format!("### Kayıt: {}\n", e.name));
            if e.kind != "image" {
                if let Ok(content) = fs::read_to_string(&e.path) {
                    output.push_str(&format!("{}\n\n", content.trim()));
                }
            }
            if !e.image_paths.is_empty() {
                output.push_str(&format!("*Ekli Görseller ({} adet)*\n\n", e.image_paths.len()));
            }
        }
    }

    Ok(output)
}

#[tauri::command]
fn list_entries(app: AppHandle, project: String) -> Result<Vec<EntryMeta>, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(&clean);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let pinned_ids = get_pinned_ids(&dir);
    let order_ids = get_order_ids(&dir);
    let mut tag_store = get_tag_store(&dir);
    let mut needs_prune = cleanup_unused_tags(&mut tag_store);

    struct GroupItem {
        md_path: Option<PathBuf>,
        png_paths: Vec<PathBuf>,
        modified: u128,
    }

    let mut map: HashMap<String, GroupItem> = HashMap::new();

    if let Ok(read_dir) = fs::read_dir(&dir) {
        for entry in read_dir.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            // Exclude todos.md and hidden/metadata files
            if file_name == "todos.md" || file_name.starts_with('.') {
                continue;
            }

            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext != "md" && ext != "png" {
                continue;
            }

            let file_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let base_key = extract_base_key(&file_stem);

            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);

            let item = map.entry(base_key).or_insert(GroupItem {
                md_path: None,
                png_paths: Vec::new(),
                modified: 0,
            });

            if modified > item.modified {
                item.modified = modified;
            }

            if ext == "md" {
                item.md_path = Some(path);
            } else if ext == "png" {
                item.png_paths.push(path);
            }
        }
    }

    let mut entries: Vec<EntryMeta> = map
        .into_iter()
        .map(|(key, mut item)| {
            item.png_paths.sort();
            let image_paths: Vec<String> = item
                .png_paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            let has_md = item.md_path.is_some();
            let has_png = !image_paths.is_empty();

            let (kind, primary_path, preview) = if has_md && has_png {
                let md = item.md_path.as_ref().unwrap();
                let text = fs::read_to_string(md)
                    .ok()
                    .map(|c| c.trim().chars().take(150).collect::<String>());
                ("mixed".to_string(), md.to_string_lossy().to_string(), text)
            } else if has_md {
                let md = item.md_path.as_ref().unwrap();
                let text = fs::read_to_string(md)
                    .ok()
                    .map(|c| c.trim().chars().take(150).collect::<String>());
                ("note".to_string(), md.to_string_lossy().to_string(), text)
            } else if has_png {
                (
                    "image".to_string(),
                    image_paths[0].clone(),
                    None,
                )
            } else {
                ("note".to_string(), "".to_string(), None)
            };

            let is_pinned = pinned_ids.contains(&key);
            let is_ai = item.md_path.as_ref().map_or(false, |p| {
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                stem.ends_with("_ai") || stem.contains("_ai_") || stem.ends_with("_ai_note")
            });

            let tags = tag_store.entries.get(&key).cloned().unwrap_or_default();

            EntryMeta {
                id: key.clone(),
                name: key,
                path: primary_path,
                image_paths,
                kind,
                modified: item.modified,
                preview,
                pinned: is_pinned,
                is_ai,
                tags,
                parent_id: None,
            }
        })
        .filter(|e| !e.path.is_empty())
        .collect();

    // Drop hierarchy links that point to missing notes or break the single-level rule.
    let mut tree_store = get_tree_store(&dir);
    {
        let ids: std::collections::HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        let before = tree_store.parents.len();
        let parents_snapshot = tree_store.parents.clone();
        tree_store.parents.retain(|child, parent| {
            ids.contains(child.as_str())
                && ids.contains(parent.as_str())
                && !parents_snapshot.contains_key(parent.as_str())
        });
        if tree_store.parents.len() != before {
            needs_prune = true;
        }
    }
    for e in entries.iter_mut() {
        e.parent_id = tree_store.parents.get(&e.id).cloned();
    }

    // Drop tag records of notes that no longer exist (deleted/renamed outside the app).
    let live_ids: std::collections::HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    let before = tag_store.entries.len();
    tag_store.entries.retain(|id, _| live_ids.contains(id.as_str()));
    if tag_store.entries.len() != before {
        cleanup_unused_tags(&mut tag_store);
        needs_prune = true;
    }
    if needs_prune {
        let live: std::collections::HashSet<String> = entries.iter().map(|e| e.id.clone()).collect();
        prune_metadata(&dir, &live);
    }

    entries.sort_by(|a, b| {
        // Priority 1: Pinned status ALWAYS takes precedence.
        // Pinned notes are always sorted before unpinned notes.
        match (b.pinned, a.pinned) {
            (true, false) => return std::cmp::Ordering::Greater,
            (false, true) => return std::cmp::Ordering::Less,
            _ => {}
        }

        // Priority 2: Within the same tier (both pinned OR both unpinned):
        let pos_a = order_ids.iter().position(|id| id == &a.id);
        let pos_b = order_ids.iter().position(|id| id == &b.id);
        match (pos_a, pos_b) {
            // Both items have a saved manual position: preserve that order
            (Some(idx_a), Some(idx_b)) => idx_a.cmp(&idx_b),

            // Item 'a' is newly created (not yet in .order.json):
            // Place it at the top of this tier (before existing ordered items)
            (None, Some(_)) => std::cmp::Ordering::Less,

            // Item 'b' is newly created (not yet in .order.json):
            // It comes before existing ordered item 'a'
            (Some(_), None) => std::cmp::Ordering::Greater,

            // Neither item is in .order.json: sort by newest modified first
            (None, None) => b.modified.cmp(&a.modified),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn save_note(app: AppHandle, project: String, content: String) -> Result<String, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.md", unique_timestamp_stem(&dir)));
    atomic_write(&path, content.as_bytes())?;
    let _ = app.emit("notes-updated", ());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_screenshot(app: AppHandle, project: String, png_base64: String) -> Result<String, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", unique_timestamp_stem(&dir)));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", ());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_capture(
    app: AppHandle,
    project: String,
    text: Option<String>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(&clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let now_ts = unique_timestamp_stem(&dir);
    let imgs = images.unwrap_or_default();
    let has_image = !imgs.is_empty();
    let trimmed_text = text.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    for (idx, b64) in imgs.iter().enumerate() {
        if b64.trim().is_empty() {
            continue;
        }
        let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
        let filename = if imgs.len() == 1 {
            format!("{}.png", now_ts)
        } else {
            format!("{}_{}.png", now_ts, idx + 1)
        };
        let img_path = dir.join(filename);
        fs::write(&img_path, bytes).map_err(|e| e.to_string())?;
    }

    if let Some(content) = trimmed_text {
        let note_filename = if has_image {
            format!("{}_note.md", now_ts)
        } else {
            format!("{}.md", now_ts)
        };
        let note_path = dir.join(note_filename);
        atomic_write(&note_path, content.as_bytes())?;
    }

    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn attach_image_to_entry(
    app: AppHandle,
    entry_path: String,
    png_base64: String,
) -> Result<String, String> {
    let p = PathBuf::from(&entry_path);
    let parent = p.parent().ok_or("Geçersiz dosya yolu")?;
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let base_stem = extract_base_key(stem);

    let bytes = STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    let sub_ts = chrono::Local::now().format("%H%M%S").to_string();
    let new_filename = format!("{}_{}.png", base_stem, sub_ts);
    let img_path = parent.join(new_filename);
    fs::write(&img_path, bytes).map_err(|e| e.to_string())?;

    let _ = app.emit("notes-updated", ());
    Ok(img_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_image_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Last-modified time (ms) of a note file; used as its version for conflict detection.
#[tauri::command]
fn note_modified(path: String) -> u64 {
    file_modified_ms(std::path::Path::new(&path))
}

/// Overwrites a note. When `expected_modified` is given and the file changed since
/// (e.g. an AI agent edited it), nothing is written and a `CONFLICT` error is returned.
#[tauri::command]
fn update_note(
    app: AppHandle,
    path: String,
    content: String,
    expected_modified: Option<u64>,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let _lock = match p.parent() {
        Some(dir) => Some(lock_dir(dir)?),
        None => None,
    };
    if let Some(expected) = expected_modified {
        if file_modified_ms(p) != expected {
            return Err("CONFLICT: not dışarıdan değiştirildi".into());
        }
    }
    atomic_write(p, content.as_bytes())?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_entry(app: AppHandle, path: String, image_paths: Option<Vec<String>>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        let _ = fs::remove_file(p);
    }
    if let Some(imgs) = image_paths {
        for img in imgs {
            let ip = std::path::Path::new(&img);
            if ip.exists() {
                let _ = fs::remove_file(ip);
            }
        }
    }
    if let Some(parent) = p.parent() {
        let parent_buf = parent.to_path_buf();
        let _lock = lock_dir(&parent_buf)?;
        let mut store = get_tag_store(&parent_buf);
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let entry_key = extract_base_key(stem);
        if store.entries.remove(&entry_key).is_some() {
            cleanup_unused_tags(&mut store);
            let _ = save_tag_store(&parent_buf, &store);
        }
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn search_entries(
    app: AppHandle,
    query: String,
    project: Option<String>,
) -> Result<Vec<SearchResultItem>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let root = projects_root(&app)?;
    let projects_to_search: Vec<String> = if let Some(ref p) = project {
        if p.trim().is_empty() {
            fs::read_dir(&root)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        } else {
            let clean = sanitize_name(p)?;
            vec![clean]
        }
    } else {
        fs::read_dir(&root)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect()
    };

    let mut results = Vec::new();

    for proj in projects_to_search {
        if let Ok(entries) = list_entries(app.clone(), proj.clone()) {
            for entry in entries {
                let mut matched = false;
                let mut snippet = String::new();

                // Search in note preview / content
                if let Some(ref text) = entry.preview {
                    if text.to_lowercase().contains(&q) {
                        matched = true;
                        snippet = text.clone();
                    }
                }

                // Search in full note file if preview was truncated
                if !matched && entry.kind != "image" {
                    if let Ok(content) = fs::read_to_string(&entry.path) {
                        if content.to_lowercase().contains(&q) {
                            matched = true;
                            snippet = content.chars().take(150).collect();
                        }
                    }
                }

                // Search in entry name
                if !matched && entry.name.to_lowercase().contains(&q) {
                    matched = true;
                    snippet = entry.name.clone();
                }

                if matched {
                    results.push(SearchResultItem {
                        project: proj.clone(),
                        entry,
                        matched_snippet: snippet,
                    });
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
fn open_entry(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_mcp_status(app: AppHandle) -> Result<McpStatus, String> {
    let mut is_configured = false;
    let mut allowed_all = true;
    let mut allowed_projects = Vec::new();

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from);

    let mut configured_client: Option<String> = None;

    if let Ok(home_path) = home {
        let cfg_path = home_path.join(".gemini").join("config").join("mcp_config.json");
        if cfg_path.exists() {
            if let Ok(content) = fs::read_to_string(&cfg_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(servers) = json.get("mcpServers").and_then(|s| s.as_object()) {
                        if let Some(nb) = servers.get("mindpipe").or_else(|| servers.get("notes-dashboard")) {
                            is_configured = true;
                            configured_client = Some("Antigravity".into());
                            if let Some(args) = nb.get("args").and_then(|a| a.as_array()) {
                                for arg in args {
                                    if let Some(s) = arg.as_str() {
                                        if s.starts_with("--allowed=") {
                                            allowed_all = false;
                                            let list = s.replace("--allowed=", "");
                                            allowed_projects = list
                                                .split(',')
                                                .map(|p| p.trim().to_lowercase())
                                                .filter(|p| !p.is_empty())
                                                .collect();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Check Claude Desktop config (%APPDATA%/Claude/claude_desktop_config.json)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let claude_cfg = PathBuf::from(&appdata).join("Claude").join("claude_desktop_config.json");
        if claude_cfg.exists() {
            if let Ok(content) = fs::read_to_string(&claude_cfg) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(servers) = json.get("mcpServers").and_then(|s| s.as_object()) {
                        if servers.contains_key("mindpipe") || servers.contains_key("notes-dashboard") {
                            is_configured = true;
                            if configured_client.is_none() {
                                configured_client = Some("Claude Desktop".into());
                            }
                        }
                    }
                }
            }
        }
    }

    // Check Cursor (~/.cursor/mcp.json) and Codex CLI (~/.codex/config.toml)
    if let Ok(home_path) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map(PathBuf::from) {
        let cursor_cfg = home_path.join(".cursor").join("mcp.json");
        if let Ok(content) = fs::read_to_string(&cursor_cfg) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(servers) = json.get("mcpServers").and_then(|s| s.as_object()) {
                    if servers.contains_key("mindpipe") || servers.contains_key("notes-dashboard") {
                        is_configured = true;
                        if configured_client.is_none() {
                            configured_client = Some("Cursor".into());
                        }
                    }
                }
            }
        }

        let codex_cfg = home_path.join(".codex").join("config.toml");
        if let Ok(content) = fs::read_to_string(&codex_cfg) {
            if content.contains("[mcp_servers.mindpipe]") || content.contains("[mcp_servers.notes-dashboard]") {
                is_configured = true;
                if configured_client.is_none() {
                    configured_client = Some("Codex".into());
                }
            }
        }
    }

    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);

    // Read session file to detect live connected AI client and active tool processing
    let mut is_live_processing = false;
    let mut detected_client = configured_client;
    let mut last_active_time = None;

    let session_path = app_dir.join("mcp-session.json");
    if session_path.exists() {
        if let Ok(content) = fs::read_to_string(&session_path) {
            if let Ok(session) = serde_json::from_str::<McpSessionInfo>(&content) {
                if let Some(c) = session.client {
                    if !c.trim().is_empty() && c != "AI Client" {
                        is_configured = true;
                        let name_lower = c.to_lowercase();
                        if name_lower.contains("claude") {
                            detected_client = Some("Claude Desktop".into());
                        } else if name_lower.contains("antigravity") {
                            detected_client = Some("Antigravity".into());
                        } else if name_lower.contains("cursor") {
                            detected_client = Some("Cursor".into());
                        } else if name_lower.contains("codex") {
                            detected_client = Some("Codex".into());
                        } else {
                            detected_client = Some(c);
                        }
                    }
                }
                if let Some(act) = session.last_active {
                    last_active_time = Some(act);
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    // If a tool was actively executed within the last 15 seconds
                    if now_ms.saturating_sub(act) < 15_000 {
                        is_live_processing = true;
                    }
                }
            }
        }
    }

    // Read UI permissions file (blocked projects, edit/delete scopes)
    let perm_path = app_dir.join("mcp-permissions.json");
    let perms = load_permissions(&perm_path);
    let (blocked_projects, allow_ai_edit, allow_ai_delete, project_overrides) = (
        perms.blocked_projects,
        perms.allow_ai_edit,
        perms.allow_ai_delete,
        perms.project_overrides,
    );

    // Scan projects for AI-created marker (.ai)
    let mut ai_projects: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() && path.join(".ai").exists() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    ai_projects.push(name.to_string());
                }
            }
        }
    }
    ai_projects.sort();

    let log_path = app_dir.join("mcp-log.json");
    let logs = if log_path.exists() {
        fs::read_to_string(&log_path)
            .ok()
            .and_then(|c| serde_json::from_str::<Vec<McpLogEntry>>(&c).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    ensure_mcp_server(app_dir);

    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(app_dir.join("mcp-server.cjs"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("mcp-server.cjs"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("mcp-server.cjs"));
        }
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        candidates.push(exe_dir.join("mcp-server.cjs"));
    }

    let server_script_path = candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string());

    Ok(McpStatus {
        is_configured,
        allowed_all,
        allowed_projects,
        is_live_processing,
        detected_client,
        last_active_time,
        blocked_projects,
        ai_projects,
        allow_ai_edit,
        allow_ai_delete,
        project_overrides,
        server_script_path,
        logs,
    })
}

#[tauri::command]
fn toggle_project_mcp_access(app: AppHandle, project: String) -> Result<bool, String> {
    let clean = project.trim().to_lowercase();
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let perm_path = app_dir.join("mcp-permissions.json");

    let mut permissions = load_permissions(&perm_path);

    let is_currently_blocked = permissions
        .blocked_projects
        .iter()
        .any(|p| p.to_lowercase() == clean);

    let is_now_allowed = if is_currently_blocked {
        permissions
            .blocked_projects
            .retain(|p| p.to_lowercase() != clean);
        true
    } else {
        permissions.blocked_projects.push(clean);
        false
    };

    let json = serde_json::to_string_pretty(&permissions).map_err(|e| e.to_string())?;
    atomic_write(&perm_path, json.as_bytes())?;

    let _ = app.emit("notes-updated", ());
    Ok(is_now_allowed)
}

#[tauri::command]
fn set_mcp_permission_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let perm_path = app_dir.join("mcp-permissions.json");

    let mut permissions = load_permissions(&perm_path);

    match key.as_str() {
        "allowAiEdit" => permissions.allow_ai_edit = value,
        "allowAiDelete" => permissions.allow_ai_delete = value,
        _ => return Err("Geçersiz ayar anahtarı".into()),
    }

    let json = serde_json::to_string_pretty(&permissions).map_err(|e| e.to_string())?;
    atomic_write(&perm_path, json.as_bytes())?;

    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// Sets (or clears, when `value` is None/"global") one permission override for a project.
#[tauri::command]
fn set_project_permission_override(
    app: AppHandle,
    project: String,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let perm_path = app_dir.join("mcp-permissions.json");
    let mut permissions = load_permissions(&perm_path);

    let name = project.trim().to_lowercase();
    if name.is_empty() {
        return Err("Geçersiz proje adı".into());
    }
    let value = value.filter(|v| matches!(v.as_str(), "only_ai" | "all" | "none"));
    let entry = permissions.project_overrides.entry(name.clone()).or_default();
    match key.as_str() {
        "allowAiEdit" => entry.allow_ai_edit = value,
        "allowAiDelete" => entry.allow_ai_delete = value,
        _ => return Err("Geçersiz ayar anahtarı".into()),
    }
    if entry.allow_ai_edit.is_none() && entry.allow_ai_delete.is_none() {
        permissions.project_overrides.remove(&name);
    }

    let json = serde_json::to_string_pretty(&permissions).map_err(|e| e.to_string())?;
    atomic_write(&perm_path, json.as_bytes())?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// Removes every permission override of a project (it follows the global settings again).
#[tauri::command]
fn clear_project_permission_override(app: AppHandle, project: String) -> Result<(), String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let perm_path = app_dir.join("mcp-permissions.json");
    let mut permissions = load_permissions(&perm_path);
    permissions.project_overrides.remove(&project.trim().to_lowercase());
    let json = serde_json::to_string_pretty(&permissions).map_err(|e| e.to_string())?;
    atomic_write(&perm_path, json.as_bytes())?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn clear_mcp_logs(app: AppHandle) -> Result<(), String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let log_path = app_dir.join("mcp-log.json");
    if log_path.exists() {
        let _ = fs::remove_file(log_path);
    }
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn get_capture_shortcut(app: AppHandle) -> Result<String, String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    Ok(get_saved_capture_shortcut(app_dir))
}

#[tauri::command]
fn update_capture_shortcut(app: AppHandle, new_shortcut: String) -> Result<String, String> {
    let clean = new_shortcut.trim();
    if clean.is_empty() {
        return Err("Kısayol boş bırakılamaz".into());
    }

    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let current = get_saved_capture_shortcut(app_dir);

    if clean.eq_ignore_ascii_case(&current) {
        return Ok(current);
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister(current.as_str());

    if let Err(e) = gs.register(clean) {
        let _ = gs.register(current.as_str());
        return Err(format!("Geçersiz veya sistemle çakışan kısayol: {}", e));
    }

    let settings_path = app_dir.join("shortcuts.json");
    let json = serde_json::json!({
        "captureShortcut": clean
    });
    if let Err(e) = fs::write(settings_path, json.to_string()) {
        return Err(format!("Ayar kaydedilemedi: {}", e));
    }

    Ok(clean.to_string())
}

/// True while the primary mouse button is held down anywhere on screen (Windows only; elsewhere the
/// capture bar keeps hiding as soon as it loses focus).
#[cfg(windows)]
fn left_mouse_button_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }
    // VK_LBUTTON = 0x01; the high bit is set while the button is down.
    unsafe { (GetAsyncKeyState(0x01) as u16) & 0x8000 != 0 }
}

#[cfg(not(windows))]
fn left_mouse_button_down() -> bool {
    false
}

/// Whether the capture bar should hide once the mouse button that was held when it lost focus is
/// released. A file being dragged over the bar (or just dropped on it) keeps it open.
fn should_hide_after_release(now_ms: u64, keep_open_until_ms: u64, window_focused: bool) -> bool {
    !window_focused && now_ms >= keep_open_until_ms
}

fn toggle_capture_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("capture") else {
        return;
    };
    let is_visible = window.is_visible().unwrap_or(false);
    if is_visible {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Release builds only (so a dev run is never blocked by the installed tray app):
    // a second launch focuses the running instance instead of starting another one.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_capture_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();

            let root = projects_root(&handle)?;
            let app_dir = root.parent().unwrap_or(&root);
            ensure_mcp_server(app_dir);

            // The main window starts hidden (tauri.conf.json). Show it, unless the OS started us at
            // login and the user chose to start quietly in the tray.
            let launched_by_autostart = std::env::args().any(|a| a == "--autostart");
            let stay_hidden = launched_by_autostart && load_startup_settings(app_dir).start_hidden;
            if !stay_hidden {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            // Global "capture" shortcut works even when another app is focused.
            let saved_shortcut = get_saved_capture_shortcut(app_dir);
            if let Err(e) = handle.global_shortcut().register(saved_shortcut.as_str()) {
                eprintln!("Failed to register global shortcut {}: {}", saved_shortcut, e);
                if saved_shortcut != CAPTURE_SHORTCUT {
                    let _ = handle.global_shortcut().register(CAPTURE_SHORTCUT);
                }
            }

            // Capture window loses focus (user clicked away) -> dismiss it, same as pressing Escape.
            // Exception: if the mouse button is held when focus is lost the user may be picking up a file
            // elsewhere to drop it onto the bar, so wait for the release and keep the bar open when a
            // drag is over it (or was just dropped on it).
            if let Some(capture) = handle.get_webview_window("capture") {
                let capture_handle = capture.clone();
                let epoch = std::time::Instant::now();
                let keep_open_until = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                capture.on_window_event(move |event| match event {
                    WindowEvent::DragDrop(_) => {
                        // Enter/Over/Drop/Leave all refresh a short keep-alive.
                        let until = epoch.elapsed().as_millis() as u64 + 1500;
                        keep_open_until.store(until, std::sync::atomic::Ordering::SeqCst);
                    }
                    WindowEvent::Focused(false) => {
                        if left_mouse_button_down() {
                            let window = capture_handle.clone();
                            let keep = keep_open_until.clone();
                            std::thread::spawn(move || {
                                let started = std::time::Instant::now();
                                while left_mouse_button_down() && started.elapsed() < std::time::Duration::from_secs(15) {
                                    std::thread::sleep(std::time::Duration::from_millis(25));
                                }
                                // Give the drop event a moment to arrive after the button is released.
                                std::thread::sleep(std::time::Duration::from_millis(120));
                                let now = epoch.elapsed().as_millis() as u64;
                                let until = keep.load(std::sync::atomic::Ordering::SeqCst);
                                if should_hide_after_release(now, until, window.is_focused().unwrap_or(false)) {
                                    let _ = window.hide();
                                }
                            });
                        } else {
                            let _ = capture_handle.hide();
                        }
                    }
                    _ => {}
                });
            }

            // Tray icon: quick access to the dashboard without hunting for
            // a taskbar entry, plus a real quit path since the main window
            // close button only hides the app.
            let dashboard_item =
                MenuItemBuilder::with_id("dashboard", "MindPipe'ı Aç").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Çıkış").build(app)?;
            app.manage(TrayItems {
                open: dashboard_item.clone(),
                quit: quit_item.clone(),
            });
            let menu = MenuBuilder::new(app)
                .items(&[&dashboard_item, &quit_item])
                .build()?;

            TrayIconBuilder::with_id("main-tray")
                .tooltip("MindPipe")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "dashboard" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // Trash cleanup: runs the user's auto-clean policy shortly after start and then hourly.
            let trash_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                loop {
                    let settings = load_trash_settings(&trash_handle);
                    if settings.enabled {
                        if let Ok(root) = projects_root(&trash_handle) {
                            if run_trash_policy(&root, &settings) > 0 {
                                let _ = trash_handle.emit("notes-updated", ());
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(60 * 60));
                }
            });

            // Background Live Watcher: detects external MCP or file changes in real-time
            let sync_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last_session_check = 0u64;
                let mut last_projects_sig = String::new();
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    if let Ok(root) = projects_root(&sync_handle) {
                        let app_dir = root.parent().unwrap_or(&root);
                        let session_path = app_dir.join("mcp-session.json");
                        let session_time = session_path
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);

                        let mut sig = String::new();
                        if let Ok(entries) = fs::read_dir(&root) {
                            for e in entries.flatten() {
                                if let Ok(m) = e.metadata() {
                                    if let Ok(t) = m.modified() {
                                        if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                                            sig.push_str(&format!("{}:{};", e.file_name().to_string_lossy(), d.as_millis()));
                                        }
                                    }
                                }
                            }
                        }

                        if session_time != last_session_check || sig != last_projects_sig {
                            last_session_check = session_time;
                            last_projects_sig = sig;
                            let _ = sync_handle.emit("notes-updated", ());
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the dashboard just hides it -- the app keeps living in
            // the tray so the global shortcut and capture window stay alive.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            delete_project,
            open_project_folder,
            list_entries,
            reorder_entries,
            export_ai_context,
            toggle_pin_entry,
            get_project_tags,
            set_entry_tags,
            delete_project_tag,
            list_todos,
            add_todo,
            toggle_todo,
            delete_todo,
            save_note,
            save_screenshot,
            save_capture,
            attach_image_to_entry,
            delete_image_file,
            read_note,
            update_note,
            delete_entry,
            search_entries,
            open_entry,
            get_mcp_status,
            toggle_project_mcp_access,
            set_mcp_permission_setting,
            set_project_permission_override,
            set_entry_parent,
            note_modified,
            set_tray_language,
            get_startup_settings,
            set_startup_settings,
            dropfile::read_dropped_file,
            bundle::export_project,
            bundle::inspect_bundle,
            bundle::import_bundle,
            bundle::reveal_in_folder,
            list_trash,
            empty_trash,
            get_trash_settings,
            set_trash_settings,
            restore_trash_item,
            purge_trash_item,
            clear_project_permission_override,
            clear_mcp_logs,
            get_capture_shortcut,
            update_capture_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod trash_policy_tests {
    use super::*;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    fn setup(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mindpipe_trash_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("p1").join(".trash")).unwrap();
        root
    }

    fn add(root: &PathBuf, file: &str, age_days: u64, meta: &mut HashMap<String, TrashMeta>) {
        fs::write(root.join("p1").join(".trash").join(file), "x").unwrap();
        meta.insert(
            file.to_string(),
            TrashMeta {
                original: file.to_string(),
                tags: vec![],
                pinned: false,
                deleted_at: now_ms() - age_days * DAY_MS,
                deleted_by: "ai".into(),
            },
        );
    }

    fn remaining(root: &PathBuf) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(root.join("p1").join(".trash"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn disabled_policy_removes_nothing() {
        let root = setup("off");
        let mut meta = HashMap::new();
        add(&root, "old.md", 400, &mut meta);
        write_trash_meta(&root.join("p1").join(".trash"), &meta).unwrap();
        let settings = TrashSettings { enabled: false, days: 30, max_items: 100 };
        assert_eq!(run_trash_policy(&root, &settings), 0);
        assert_eq!(remaining(&root), vec!["old.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removes_expired_and_keeps_recent() {
        let root = setup("age");
        let mut meta = HashMap::new();
        add(&root, "old.md", 45, &mut meta);
        add(&root, "recent.md", 3, &mut meta);
        write_trash_meta(&root.join("p1").join(".trash"), &meta).unwrap();
        let settings = TrashSettings { enabled: true, days: 30, max_items: 100 };
        assert_eq!(run_trash_policy(&root, &settings), 1);
        assert_eq!(remaining(&root), vec!["recent.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trims_to_max_items_dropping_oldest_first() {
        let root = setup("max");
        let mut meta = HashMap::new();
        add(&root, "a_newest.md", 1, &mut meta);
        add(&root, "b_mid.md", 2, &mut meta);
        add(&root, "c_oldest.md", 3, &mut meta);
        write_trash_meta(&root.join("p1").join(".trash"), &meta).unwrap();
        let settings = TrashSettings { enabled: true, days: 30, max_items: 2 };
        assert_eq!(run_trash_policy(&root, &settings), 1);
        assert_eq!(remaining(&root), vec!["a_newest.md", "b_mid.md"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lock_is_released_after_cleanup() {
        let root = setup("lock");
        let settings = TrashSettings { enabled: true, days: 30, max_items: 100 };
        run_trash_policy(&root, &settings);
        assert!(!root.join("p1").join(".lock").exists());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod startup_settings_tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mindpipe_startup_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_to_starting_hidden_when_no_file_exists() {
        let dir = temp_dir("none");
        assert!(load_startup_settings(&dir).start_hidden);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_the_saved_choice_and_survives_garbage() {
        let dir = temp_dir("saved");
        fs::write(dir.join("startup-settings.json"), r#"{"startHidden": false}"#).unwrap();
        assert!(!load_startup_settings(&dir).start_hidden);
        fs::write(dir.join("startup-settings.json"), "not json").unwrap();
        assert_eq!(load_startup_settings(&dir), StartupSettings::default());
        fs::write(dir.join("startup-settings.json"), "{}").unwrap();
        assert!(load_startup_settings(&dir).start_hidden);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod unique_name_tests {
    use super::*;

    #[test]
    fn notes_saved_in_the_same_second_get_different_names() {
        let dir = std::env::temp_dir().join(format!("mindpipe_names_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let mut seen = std::collections::HashSet::new();
        for _ in 0..5 {
            let stem = unique_timestamp_stem(&dir);
            assert!(seen.insert(stem.clone()), "duplicate stem {}", stem);
            fs::write(dir.join(format!("{}.md", stem)), "x").unwrap();
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 5);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod capture_hold_tests {
    use super::*;

    #[test]
    fn hides_after_release_unless_a_drag_is_over_the_bar_or_the_bar_is_focused() {
        // nothing happened over the bar: hide
        assert!(should_hide_after_release(5_000, 0, false));
        // a drag/drop refreshed the keep-alive recently: stay open
        assert!(!should_hide_after_release(5_000, 6_000, false));
        // keep-alive expired: hide again
        assert!(should_hide_after_release(7_000, 6_000, false));
        // the bar regained focus (e.g. after a drop): never hide
        assert!(!should_hide_after_release(5_000, 0, true));
    }
}
