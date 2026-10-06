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
use tauri_plugin_opener::OpenerExt;

const CAPTURE_SHORTCUT: &str = "Ctrl+Shift+N";
const EMBEDDED_MCP_SERVER: &str = include_str!("../../mcp-server.cjs");

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
    server_script_path: Option<String>,
    logs: Vec<McpLogEntry>,
}

/// Root folder for all projects, e.g. `%APPDATA%/com.notesdashboard.app/projects`.
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

fn timestamped_filename(ext: &str) -> String {
    format!("{}.{}", chrono::Local::now().format("%Y-%m-%d_%H%M%S"), ext)
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
    fs::write(pin_file, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_pin_entry(app: AppHandle, project: String, entry_id: String) -> Result<bool, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
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
    fs::write(file_path, content).map_err(|e| e.to_string())?;
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
    fs::write(order_file, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_entries(app: AppHandle, project: String, ordered_ids: Vec<String>) -> Result<(), String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
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
            }
        })
        .filter(|e| !e.path.is_empty())
        .collect();

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
    let path = dir.join(timestamped_filename("md"));
    fs::write(&path, content).map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", ());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_screenshot(app: AppHandle, project: String, png_base64: String) -> Result<String, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    let path = dir.join(timestamped_filename("png"));
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

    let now_ts = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
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
        fs::write(&note_path, content).map_err(|e| e.to_string())?;
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

#[tauri::command]
fn update_note(app: AppHandle, path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())?;
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
    let (blocked_projects, allow_ai_edit, allow_ai_delete) = if perm_path.exists() {
        fs::read_to_string(&perm_path)
            .ok()
            .and_then(|c| serde_json::from_str::<McpPermissions>(&c).ok())
            .map(|p| (p.blocked_projects, p.allow_ai_edit, p.allow_ai_delete))
            .unwrap_or_else(|| (Vec::new(), "only_ai".into(), "only_ai".into()))
    } else {
        (Vec::new(), "only_ai".into(), "only_ai".into())
    };

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

    let mut permissions = if perm_path.exists() {
        fs::read_to_string(&perm_path)
            .ok()
            .and_then(|c| serde_json::from_str::<McpPermissions>(&c).ok())
            .unwrap_or_else(|| McpPermissions {
                blocked_projects: Vec::new(),
                allow_ai_edit: "only_ai".into(),
                allow_ai_delete: "only_ai".into(),
            })
    } else {
        McpPermissions {
            blocked_projects: Vec::new(),
            allow_ai_edit: "only_ai".into(),
            allow_ai_delete: "only_ai".into(),
        }
    };

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
    fs::write(&perm_path, json).map_err(|e| e.to_string())?;

    let _ = app.emit("notes-updated", ());
    Ok(is_now_allowed)
}

#[tauri::command]
fn set_mcp_permission_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let root = projects_root(&app)?;
    let app_dir = root.parent().unwrap_or(&root);
    let perm_path = app_dir.join("mcp-permissions.json");

    let mut permissions = if perm_path.exists() {
        fs::read_to_string(&perm_path)
            .ok()
            .and_then(|c| serde_json::from_str::<McpPermissions>(&c).ok())
            .unwrap_or_else(|| McpPermissions {
                blocked_projects: Vec::new(),
                allow_ai_edit: "only_ai".into(),
                allow_ai_delete: "only_ai".into(),
            })
    } else {
        McpPermissions {
            blocked_projects: Vec::new(),
            allow_ai_edit: "only_ai".into(),
            allow_ai_delete: "only_ai".into(),
        }
    };

    match key.as_str() {
        "allowAiEdit" => permissions.allow_ai_edit = value,
        "allowAiDelete" => permissions.allow_ai_delete = value,
        _ => return Err("Geçersiz ayar anahtarı".into()),
    }

    let json = serde_json::to_string_pretty(&permissions).map_err(|e| e.to_string())?;
    fs::write(&perm_path, json).map_err(|e| e.to_string())?;

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
    tauri::Builder::default()
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

            // Global "capture" shortcut works even when another app is focused.
            let saved_shortcut = get_saved_capture_shortcut(app_dir);
            if let Err(e) = handle.global_shortcut().register(saved_shortcut.as_str()) {
                eprintln!("Failed to register global shortcut {}: {}", saved_shortcut, e);
                if saved_shortcut != CAPTURE_SHORTCUT {
                    let _ = handle.global_shortcut().register(CAPTURE_SHORTCUT);
                }
            }

            // Capture window loses focus (user clicked away) -> dismiss it,
            // same as pressing Escape.
            if let Some(capture) = handle.get_webview_window("capture") {
                let capture_handle = capture.clone();
                capture.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let _ = capture_handle.hide();
                    }
                });
            }

            // Tray icon: quick access to the dashboard without hunting for
            // a taskbar entry, plus a real quit path since the main window
            // close button only hides the app.
            let dashboard_item =
                MenuItemBuilder::with_id("dashboard", "MindPipe'ı Aç").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Çıkış").build(app)?;
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
            clear_mcp_logs,
            get_capture_shortcut,
            update_capture_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

