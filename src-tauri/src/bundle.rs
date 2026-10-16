//! Project share bundles (`.mindpipe` files): export a project to one file and merge it into
//! another device's copy without ever overwriting work.
//!
//! Identity: every project gets a stable id (`.project.json`), so an import knows whether the
//! bundle belongs to a project that already exists locally.
//!
//! Merge: per file we remember the hash both sides last agreed on (`.sync.json`, local only).
//! - unchanged locally, changed in the bundle  -> take the bundle's version
//! - changed locally, bundle still has the old version -> keep local
//! - changed on both sides -> keep local and store the bundle's version as a new note tagged
//!   `sync-conflict` (nothing is lost, and re-importing the same bundle adds no duplicate)
//! Tags, hierarchy, pins and order are merged as unions; to-dos are merged line by line.
//! Deletions are not propagated (a note deleted on one side may come back on the next import).

use super::*;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::io::{Cursor, Read, Write as _};

pub const BUNDLE_FORMAT: u32 = 1;
const CONFLICT_TAG: &str = "sync-conflict";
const METADATA_FILES: [&str; 4] = [".tags.json", ".tree.json", ".pinned.json", ".order.json"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub format: u32,
    pub project_id: String,
    pub project_name: String,
    pub exported_at: u64,
    /// File name -> content hash
    pub files: BTreeMap<String, String>,
}

pub struct Bundle {
    pub manifest: BundleManifest,
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeSummary {
    pub added: usize,
    pub updated: usize,
    pub conflicts: usize,
    pub skipped: usize,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct SyncState {
    #[serde(default)]
    base: BTreeMap<String, String>,
}

// ---------------------------------------------------------------- helpers

/// FNV-1a 64-bit: plenty for change detection (not used for security).
fn fnv_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = String::new();
    for i in 0..2u128 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos + i);
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Only plain note/image/todo/metadata files travel in a bundle; no paths, no temp or lock files.
fn is_syncable_name(name: &str) -> bool {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    if name == ".ai" || METADATA_FILES.contains(&name) {
        return true;
    }
    if name.starts_with('.') {
        return false;
    }
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".png")
}

fn read_json_file<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<T>(&c).ok())
        .unwrap_or_default()
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    atomic_write(path, json.as_bytes())
}

#[derive(Serialize, Deserialize, Default)]
struct ProjectIdFile {
    #[serde(default)]
    id: String,
}

pub fn read_project_id(dir: &Path) -> Option<String> {
    let f: ProjectIdFile = read_json_file(&dir.join(".project.json"));
    if f.id.is_empty() {
        None
    } else {
        Some(f.id)
    }
}

fn ensure_project_id(dir: &Path) -> Result<String, String> {
    if let Some(id) = read_project_id(dir) {
        return Ok(id);
    }
    let id = random_id();
    write_json_file(&dir.join(".project.json"), &ProjectIdFile { id: id.clone() })?;
    Ok(id)
}

fn read_sync_state(dir: &Path) -> SyncState {
    read_json_file(&dir.join(".sync.json"))
}

fn save_sync_state(dir: &Path, state: &SyncState) -> Result<(), String> {
    write_json_file(&dir.join(".sync.json"), state)
}

fn syncable_files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file() && is_syncable_name(&name) {
                if let Ok(bytes) = fs::read(e.path()) {
                    out.insert(name, bytes);
                }
            }
        }
    }
    out
}

/// A free `<timestamp><suffix>.<ext>` name that cannot collide with an existing note key.
fn unique_timestamp_name(dir: &Path, original: &str) -> String {
    let path = Path::new(original);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    // Keep markers such as "_ai" / "_note" that follow the 17-char timestamp.
    let suffix = if stem.len() > 17 && stem.is_char_boundary(17) && extract_base_key(stem).len() == 17 {
        &stem[17..]
    } else {
        ""
    };
    let mut t = chrono::Local::now();
    loop {
        let ts = t.format("%Y-%m-%d_%H%M%S").to_string();
        let taken = fs::read_dir(dir)
            .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with(&ts)))
            .unwrap_or(false);
        if !taken {
            return format!("{}{}.{}", ts, suffix, ext);
        }
        t += chrono::Duration::seconds(1);
    }
}

// ---------------------------------------------------------------- build / read

/// Snapshot of a project as a `.mindpipe` zip. Also records what was shared as the new common base.
pub fn build_bundle(dir: &Path, project_name: &str) -> Result<(Vec<u8>, BundleManifest), String> {
    let _lock = lock_dir(dir)?;
    let id = ensure_project_id(dir)?;
    let files = syncable_files(dir);

    let manifest = BundleManifest {
        format: BUNDLE_FORMAT,
        project_id: id,
        project_name: project_name.to_string(),
        exported_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        files: files.iter().map(|(n, b)| (n.clone(), fnv_hex(b))).collect(),
    };

    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    w.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    w.write_all(serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;
    for (name, bytes) in &files {
        w.start_file(format!("files/{}", name), opts).map_err(|e| e.to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let bytes = w.finish().map_err(|e| e.to_string())?.into_inner();

    // What we just shared is now the version both sides can be assumed to know.
    let mut state = read_sync_state(dir);
    for (name, hash) in &manifest.files {
        state.base.insert(name.clone(), hash.clone());
    }
    save_sync_state(dir, &state)?;
    Ok((bytes, manifest))
}

pub fn read_bundle(bytes: &[u8]) -> Result<Bundle, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Geçersiz paket dosyası".to_string())?;
    let manifest: BundleManifest = {
        let mut f = archive
            .by_name("manifest.json")
            .map_err(|_| "Geçersiz paket: manifest bulunamadı".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|_| "Geçersiz paket: manifest okunamadı".to_string())?
    };
    if manifest.format != BUNDLE_FORMAT {
        return Err("Bu paket daha yeni bir MindPipe sürümüyle oluşturulmuş".into());
    }
    if manifest.project_id.is_empty() {
        return Err("Geçersiz paket: proje kimliği yok".into());
    }

    let mut files = BTreeMap::new();
    for (name, hash) in &manifest.files {
        if !is_syncable_name(name) {
            return Err(format!("Geçersiz paket: izin verilmeyen dosya adı ({})", name));
        }
        let mut f = archive
            .by_name(&format!("files/{}", name))
            .map_err(|_| format!("Geçersiz paket: dosya eksik ({})", name))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if &fnv_hex(&buf) != hash {
            return Err(format!("Paket bozuk: içerik uyuşmuyor ({})", name));
        }
        files.insert(name.clone(), buf);
    }
    Ok(Bundle { manifest, files })
}

// ---------------------------------------------------------------- merge

fn parse_todo_line(line: &str) -> Option<(bool, String)> {
    let t = line.trim();
    if let Some(rest) = t.strip_prefix("- [ ] ") {
        Some((false, rest.trim().to_string()))
    } else if let Some(rest) = t.strip_prefix("- [x] ").or_else(|| t.strip_prefix("- [X] ")) {
        Some((true, rest.trim().to_string()))
    } else {
        None
    }
}

fn todo_key(text: &str) -> String {
    text.replace("<!--ai-->", "").trim().to_lowercase()
}

/// Line-wise union: items only the bundle has are added on top, an item done on either side stays done.
fn merge_todos(local: &str, incoming: &str) -> String {
    let mut items: Vec<(bool, String)> = local.lines().filter_map(parse_todo_line).collect();
    let mut index: std::collections::HashMap<String, usize> =
        items.iter().enumerate().map(|(i, (_, t))| (todo_key(t), i)).collect();
    let mut fresh: Vec<(bool, String)> = Vec::new();
    for (done, text) in incoming.lines().filter_map(parse_todo_line) {
        match index.get(&todo_key(&text)) {
            Some(&i) => {
                if done {
                    items[i].0 = true;
                }
            }
            None => {
                index.insert(todo_key(&text), usize::MAX);
                fresh.push((done, text));
            }
        }
    }
    fresh
        .into_iter()
        .chain(items.into_iter())
        .map(|(done, text)| format!("{} {}", if done { "- [x]" } else { "- [ ]" }, text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_metadata(dir: &Path, bundle: &Bundle) -> Result<(), String> {
    if let Some(bytes) = bundle.files.get(".tags.json") {
        if let Ok(incoming) = serde_json::from_slice::<TagStore>(bytes) {
            let mut local = get_tag_store(&dir.to_path_buf());
            for (name, color) in incoming.definitions {
                local.definitions.entry(name).or_insert(color);
            }
            for (id, tags) in incoming.entries {
                let entry = local.entries.entry(id).or_default();
                for t in tags {
                    if !entry.contains(&t) {
                        entry.push(t);
                    }
                }
            }
            save_tag_store(&dir.to_path_buf(), &local)?;
        }
    }
    if let Some(bytes) = bundle.files.get(".tree.json") {
        if let Ok(incoming) = serde_json::from_slice::<TreeStore>(bytes) {
            let mut local = get_tree_store(&dir.to_path_buf());
            for (child, parent) in incoming.parents {
                local.parents.entry(child).or_insert(parent);
            }
            save_tree_store(&dir.to_path_buf(), &local)?;
        }
    }
    if let Some(bytes) = bundle.files.get(".pinned.json") {
        if let Ok(incoming) = serde_json::from_slice::<Vec<String>>(bytes) {
            let mut ids = get_pinned_ids(&dir.to_path_buf());
            for id in incoming {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            save_pinned_ids(&dir.to_path_buf(), &ids)?;
        }
    }
    if let Some(bytes) = bundle.files.get(".order.json") {
        if let Ok(incoming) = serde_json::from_slice::<Vec<String>>(bytes) {
            let mut ids = get_order_ids(&dir.to_path_buf());
            for id in incoming {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            save_order_ids(&dir.to_path_buf(), &ids)?;
        }
    }
    Ok(())
}

/// Merges a bundle into `dir` (created if missing). Never overwrites unsynced local work.
pub fn merge_bundle_into(dir: &Path, bundle: &Bundle) -> Result<MergeSummary, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _lock = lock_dir(dir)?;
    let mut summary = MergeSummary::default();

    // A project without an id adopts the bundle's, so later bundles of it merge automatically.
    if read_project_id(dir).is_none() {
        write_json_file(&dir.join(".project.json"), &ProjectIdFile { id: bundle.manifest.project_id.clone() })?;
    }

    let mut state = read_sync_state(dir);
    let mut local_hashes: HashSet<String> = syncable_files(dir).values().map(|b| fnv_hex(b)).collect();
    // original note key -> conflict copy key, so the copy inherits the original's tags
    let mut conflict_copies: Vec<(String, String)> = Vec::new();

    for (name, data) in &bundle.files {
        if METADATA_FILES.contains(&name.as_str()) {
            continue;
        }
        let path = dir.join(name);
        let incoming_hash = fnv_hex(data);

        if name == ".ai" {
            if !path.exists() {
                atomic_write(&path, data)?;
            }
            continue;
        }

        if !path.exists() {
            atomic_write(&path, data)?;
            state.base.insert(name.clone(), incoming_hash);
            summary.added += 1;
            continue;
        }

        let local = fs::read(&path).map_err(|e| e.to_string())?;
        if &local == data {
            state.base.insert(name.clone(), incoming_hash);
            summary.skipped += 1;
            continue;
        }

        if name == "todos.md" {
            let merged = merge_todos(&String::from_utf8_lossy(&local), &String::from_utf8_lossy(data));
            if merged.as_bytes() != local.as_slice() {
                atomic_write(&path, merged.as_bytes())?;
                summary.updated += 1;
            } else {
                summary.skipped += 1;
            }
            continue;
        }

        let local_hash = fnv_hex(&local);
        let base_hash = state.base.get(name).cloned();
        if Some(&local_hash) == base_hash.as_ref() {
            // Nothing changed here since the last exchange: simply take the newer version.
            atomic_write(&path, data)?;
            state.base.insert(name.clone(), incoming_hash);
            summary.updated += 1;
        } else if Some(&incoming_hash) == base_hash.as_ref() {
            // The bundle still carries the old version: our edit is newer.
            summary.skipped += 1;
        } else if local_hashes.contains(&incoming_hash) {
            // Already stored here as an earlier conflict copy.
            summary.skipped += 1;
        } else {
            let copy_name = unique_timestamp_name(dir, name);
            atomic_write(&dir.join(&copy_name), data)?;
            local_hashes.insert(incoming_hash);
            summary.conflicts += 1;
            if copy_name.to_lowercase().ends_with(".md") {
                let key_of = |n: &str| extract_base_key(Path::new(n).file_stem().and_then(|s| s.to_str()).unwrap_or(""));
                conflict_copies.push((key_of(name), key_of(&copy_name)));
            }
        }
    }

    merge_metadata(dir, bundle)?;

    if !conflict_copies.is_empty() {
        let dir_buf = dir.to_path_buf();
        let mut store = get_tag_store(&dir_buf);
        store
            .definitions
            .entry(CONFLICT_TAG.to_string())
            .or_insert_with(|| "#f59e0b".to_string());
        for (original_key, copy_key) in conflict_copies {
            let mut tags = store.entries.get(&original_key).cloned().unwrap_or_default();
            tags.retain(|t| t != CONFLICT_TAG);
            tags.push(CONFLICT_TAG.to_string());
            store.entries.insert(copy_key, tags);
        }
        save_tag_store(&dir_buf, &store)?;
    }

    save_sync_state(dir, &state)?;
    Ok(summary)
}

// ---------------------------------------------------------------- project lookup / new project

fn project_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn find_project_by_id(root: &Path, id: &str) -> Option<String> {
    project_dirs(root)
        .into_iter()
        .find(|(_, p)| read_project_id(p).as_deref() == Some(id))
        .map(|(n, _)| n)
}

pub fn find_project_by_name(root: &Path, name: &str) -> Option<String> {
    project_dirs(root)
        .into_iter()
        .find(|(n, _)| n.to_lowercase() == name.to_lowercase())
        .map(|(n, _)| n)
}

/// Creates a brand-new project from a bundle ("Name", "Name (2)", ...).
pub fn import_as_new_project(root: &Path, bundle: &Bundle) -> Result<(String, MergeSummary), String> {
    let base_name = sanitize_name(&bundle.manifest.project_name).unwrap_or_else(|_| "Imported".to_string());
    let mut name = base_name.clone();
    let mut n = 2;
    while find_project_by_name(root, &name).is_some() {
        name = format!("{} ({})", base_name, n);
        n += 1;
    }
    let summary = merge_bundle_into(&root.join(&name), bundle)?;
    Ok((name, summary))
}

// ---------------------------------------------------------------- tauri commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub project_name: String,
    pub file_count: usize,
    pub exported_at: u64,
    /// Local project with the same id (the same project, shared earlier)
    pub match_by_id: Option<String>,
    /// Local project with the same name but another id
    pub match_by_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub project: String,
    pub summary: MergeSummary,
}

fn decode_bundle(data_b64: &str) -> Result<Bundle, String> {
    let bytes = STANDARD.decode(data_b64.trim()).map_err(|_| "Geçersiz paket dosyası".to_string())?;
    read_bundle(&bytes)
}

#[tauri::command]
pub fn export_project(app: AppHandle, project: String) -> Result<ExportResult, String> {
    let clean = sanitize_name(&project)?;
    let dir = projects_root(&app)?.join(&clean);
    if !dir.is_dir() {
        return Err("Proje bulunamadı".into());
    }
    let (bytes, manifest) = build_bundle(&dir, &clean)?;
    let out_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let file_name = format!("{}_{}.mindpipe", clean, chrono::Local::now().format("%Y-%m-%d_%H%M"));
    let path = out_dir.join(file_name);
    atomic_write(&path, &bytes)?;
    Ok(ExportResult { path: path.to_string_lossy().to_string(), file_count: manifest.files.len() })
}

#[tauri::command]
pub fn inspect_bundle(app: AppHandle, data_b64: String) -> Result<InspectResult, String> {
    let bundle = decode_bundle(&data_b64)?;
    let root = projects_root(&app)?;
    let match_by_id = find_project_by_id(&root, &bundle.manifest.project_id);
    let match_by_name = if match_by_id.is_some() {
        None
    } else {
        find_project_by_name(&root, &bundle.manifest.project_name)
    };
    Ok(InspectResult {
        project_name: bundle.manifest.project_name.clone(),
        file_count: bundle.files.len(),
        exported_at: bundle.manifest.exported_at,
        match_by_id,
        match_by_name,
    })
}

/// `mode` "merge" merges into the existing project `target`; "new" creates a new project.
#[tauri::command]
pub fn import_bundle(
    app: AppHandle,
    data_b64: String,
    mode: String,
    target: Option<String>,
) -> Result<ImportResult, String> {
    let bundle = decode_bundle(&data_b64)?;
    let root = projects_root(&app)?;
    let result = match mode.as_str() {
        "merge" => {
            let name = sanitize_name(&target.ok_or("Hedef proje belirtilmedi")?)?;
            let dir = root.join(&name);
            if !dir.is_dir() {
                return Err("Hedef proje bulunamadı".into());
            }
            let summary = merge_bundle_into(&dir, &bundle)?;
            ImportResult { project: name, summary }
        }
        "new" => {
            let (name, summary) = import_as_new_project(&root, &bundle)?;
            ImportResult { project: name, summary }
        }
        _ => return Err("Geçersiz içe aktarma modu".into()),
    };
    let _ = app.emit("notes-updated", ());
    Ok(result)
}

#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(std::path::PathBuf::from(path))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    struct Device {
        root: PathBuf,
    }

    impl Device {
        fn new(name: &str) -> Device {
            let root = std::env::temp_dir().join(format!("mindpipe_sync_{}_{}", name, std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Device { root }
        }
        fn project(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
        fn write(&self, project: &str, file: &str, content: &str) {
            let dir = self.project(project);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(file), content).unwrap();
        }
        fn read(&self, project: &str, file: &str) -> String {
            fs::read_to_string(self.project(project).join(file)).unwrap_or_default()
        }
        fn notes(&self, project: &str) -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(self.project(project))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".md") && n != "todos.md")
                .collect();
            v.sort();
            v
        }
        fn export(&self, project: &str) -> Vec<u8> {
            build_bundle(&self.project(project), project).unwrap().0
        }
    }

    impl Drop for Device {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn import_new(dev: &Device, bytes: &[u8]) -> (String, MergeSummary) {
        import_as_new_project(&dev.root, &read_bundle(bytes).unwrap()).unwrap()
    }

    fn import_into(dev: &Device, project: &str, bytes: &[u8]) -> MergeSummary {
        merge_bundle_into(&dev.project(project), &read_bundle(bytes).unwrap()).unwrap()
    }

    #[test]
    fn new_project_import_copies_everything_and_adopts_id() {
        let a = Device::new("a1");
        let b = Device::new("b1");
        a.write("P", "2026-10-01_100000.md", "# one");
        a.write("P", "2026-10-01_100000.png", "PNGDATA");
        a.write("P", ".tags.json", r##"{"definitions":{"bug":"#ef4444"},"entries":{"2026-10-01_100000":["bug"]}}"##);
        let bytes = a.export("P");
        let (name, summary) = import_new(&b, &bytes);
        assert_eq!(name, "P");
        assert_eq!(summary.added, 2 + 0); // md + png (metadata is merged, not counted)
        assert_eq!(b.read("P", "2026-10-01_100000.md"), "# one");
        assert_eq!(read_project_id(&b.project("P")), read_project_id(&a.project("P")));
        let tags = get_tag_store(&b.project("P"));
        assert_eq!(tags.entries["2026-10-01_100000"], vec!["bug".to_string()]);
    }

    #[test]
    fn unchanged_local_takes_newer_incoming_without_conflict() {
        let a = Device::new("a2");
        let b = Device::new("b2");
        a.write("P", "2026-10-01_100000.md", "v1");
        import_new(&b, &a.export("P"));
        a.write("P", "2026-10-01_100000.md", "v2 edited on A");
        let s = import_into(&b, "P", &a.export("P"));
        assert_eq!(s.updated, 1);
        assert_eq!(s.conflicts, 0);
        assert_eq!(b.read("P", "2026-10-01_100000.md"), "v2 edited on A");
        assert_eq!(b.notes("P").len(), 1);
    }

    #[test]
    fn newer_local_edit_survives_an_older_bundle_and_then_flows_back() {
        let a = Device::new("a3");
        let b = Device::new("b3");
        a.write("P", "2026-10-01_100000.md", "v1");
        import_new(&b, &a.export("P"));
        b.write("P", "2026-10-01_100000.md", "v2 edited on B");
        // A re-exports without changes: B must keep its edit.
        let s = import_into(&b, "P", &a.export("P"));
        assert_eq!(s.updated + s.conflicts, 0);
        assert_eq!(b.read("P", "2026-10-01_100000.md"), "v2 edited on B");
        // B shares back: A (unchanged since last exchange) takes it.
        let s2 = import_into(&a, "P", &b.export("P"));
        assert_eq!(s2.updated, 1);
        assert_eq!(a.read("P", "2026-10-01_100000.md"), "v2 edited on B");
    }

    #[test]
    fn edits_on_both_sides_keep_both_and_converge() {
        let a = Device::new("a4");
        let b = Device::new("b4");
        a.write("P", "2026-10-01_100000.md", "v1");
        import_new(&b, &a.export("P"));
        a.write("P", "2026-10-01_100000.md", "A's edit");
        b.write("P", "2026-10-01_100000.md", "B's edit");

        let a_bundle = a.export("P");
        let s = import_into(&b, "P", &a_bundle);
        assert_eq!(s.conflicts, 1);
        assert_eq!(b.read("P", "2026-10-01_100000.md"), "B's edit");
        assert_eq!(b.notes("P").len(), 2);
        let copy = b.notes("P").into_iter().find(|n| n != "2026-10-01_100000.md").unwrap();
        assert_eq!(b.read("P", &copy), "A's edit");
        let tags = get_tag_store(&b.project("P"));
        assert!(tags.entries[&extract_base_key(copy.trim_end_matches(".md"))].contains(&"sync-conflict".to_string()));

        // Importing the very same bundle again must not create another copy.
        let again = import_into(&b, "P", &a_bundle);
        assert_eq!(again.conflicts, 0);
        assert_eq!(b.notes("P").len(), 2);

        // B shares back: A ends up with B's version plus the copy, nothing lost.
        import_into(&a, "P", &b.export("P"));
        assert_eq!(a.read("P", "2026-10-01_100000.md"), "B's edit");
        assert_eq!(a.notes("P").len(), 2);
        let a_contents: HashSet<String> = a.notes("P").iter().map(|n| a.read("P", n)).collect();
        let b_contents: HashSet<String> = b.notes("P").iter().map(|n| b.read("P", n)).collect();
        assert_eq!(a_contents, b_contents);
    }

    #[test]
    fn ping_pong_without_changes_is_a_no_op() {
        let a = Device::new("a5");
        let b = Device::new("b5");
        a.write("P", "2026-10-01_100000.md", "one");
        a.write("P", "2026-10-02_100000.md", "two");
        import_new(&b, &a.export("P"));
        for _ in 0..3 {
            let s1 = import_into(&a, "P", &b.export("P"));
            let s2 = import_into(&b, "P", &a.export("P"));
            for s in [s1, s2] {
                assert_eq!((s.added, s.updated, s.conflicts), (0, 0, 0));
            }
        }
        assert_eq!(a.notes("P"), b.notes("P"));
    }

    #[test]
    fn new_notes_on_both_sides_are_unioned() {
        let a = Device::new("a6");
        let b = Device::new("b6");
        a.write("P", "2026-10-01_100000.md", "shared");
        import_new(&b, &a.export("P"));
        a.write("P", "2026-10-03_100000.md", "only on A");
        b.write("P", "2026-10-04_100000.md", "only on B");
        import_into(&b, "P", &a.export("P"));
        import_into(&a, "P", &b.export("P"));
        assert_eq!(a.notes("P"), b.notes("P"));
        assert_eq!(a.notes("P").len(), 3);
    }

    #[test]
    fn tags_pins_and_todos_are_merged_as_unions() {
        let a = Device::new("a7");
        let b = Device::new("b7");
        a.write("P", "2026-10-01_100000.md", "n");
        a.write("P", ".tags.json", r##"{"definitions":{"x":"#111111"},"entries":{"2026-10-01_100000":["x"]}}"##);
        a.write("P", ".pinned.json", r#"["2026-10-01_100000"]"#);
        a.write("P", "todos.md", "- [ ] write tests\n- [ ] ship");
        import_new(&b, &a.export("P"));
        b.write("P", ".tags.json", r##"{"definitions":{"x":"#111111","y":"#222222"},"entries":{"2026-10-01_100000":["x","y"]}}"##);
        b.write("P", "todos.md", "- [ ] buy milk\n- [x] write tests\n- [ ] ship");
        import_into(&a, "P", &b.export("P"));
        let tags = get_tag_store(&a.project("P"));
        assert_eq!(tags.entries["2026-10-01_100000"], vec!["x".to_string(), "y".to_string()]);
        assert_eq!(get_pinned_ids(&a.project("P")), vec!["2026-10-01_100000".to_string()]);
        let todos = a.read("P", "todos.md");
        assert!(todos.contains("- [ ] buy milk"));
        assert!(todos.contains("- [x] write tests"));
        assert_eq!(todos.matches("ship").count(), 1);
    }

    #[test]
    fn same_name_project_with_another_id_can_be_merged_and_new_import_never_overwrites() {
        let a = Device::new("a8");
        let b = Device::new("b8");
        a.write("P", "2026-10-01_100000.md", "from A");
        b.write("P", "2026-10-02_100000.md", "from B");
        let bytes = a.export("P");
        // "new" keeps the existing project and creates "P (2)"
        let (name, _) = import_new(&b, &bytes);
        assert_eq!(name, "P (2)");
        assert_eq!(b.notes("P"), vec!["2026-10-02_100000.md".to_string()]);
        // explicit merge into the existing one works and adopts the id
        import_into(&b, "P", &bytes);
        assert_eq!(b.notes("P").len(), 2);
        assert_eq!(read_project_id(&b.project("P")), read_project_id(&a.project("P")));
        assert_eq!(find_project_by_id(&b.root, &read_project_id(&a.project("P")).unwrap()).is_some(), true);
    }

    #[test]
    fn unsafe_or_corrupt_bundles_are_rejected() {
        // path traversal in the manifest
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("manifest.json", opts).unwrap();
        let manifest = BundleManifest {
            format: BUNDLE_FORMAT,
            project_id: "id".into(),
            project_name: "P".into(),
            exported_at: 0,
            files: [("../evil.md".to_string(), fnv_hex(b"x"))].into_iter().collect(),
        };
        w.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
        w.start_file("files/../evil.md", opts).unwrap();
        w.write_all(b"x").unwrap();
        let evil = w.finish().unwrap().into_inner();
        assert!(read_bundle(&evil).is_err());

        // not a zip at all
        assert!(read_bundle(b"hello").is_err());

        // tampered content (hash mismatch)
        let a = Device::new("a9");
        a.write("P", "2026-10-01_100000.md", "original");
        let good = a.export("P");
        let mut archive = zip::ZipArchive::new(Cursor::new(&good)).unwrap();
        let mut manifest_text = String::new();
        archive.by_name("manifest.json").unwrap().read_to_string(&mut manifest_text).unwrap();
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("manifest.json", opts).unwrap();
        w.write_all(manifest_text.as_bytes()).unwrap();
        w.start_file("files/2026-10-01_100000.md", opts).unwrap();
        w.write_all(b"tampered").unwrap();
        let tampered = w.finish().unwrap().into_inner();
        assert!(read_bundle(&tampered).is_err());
    }

    #[test]
    fn export_skips_locks_temp_files_trash_and_sync_state() {
        let a = Device::new("a10");
        a.write("P", "2026-10-01_100000.md", "n");
        // A fresh .lock would (correctly) make the export wait, so check the filter directly.
        assert!(!is_syncable_name(".lock"));
        assert!(!is_syncable_name(".tags.json.123.tmp"));
        a.write("P", ".tags.json.123.tmp", "x");
        a.write("P", ".sync.json", "{}");
        fs::create_dir_all(a.project("P").join(".trash")).unwrap();
        a.write("P", ".trash/old.md", "deleted");
        let bundle = read_bundle(&a.export("P")).unwrap();
        let names: Vec<&String> = bundle.files.keys().collect();
        assert_eq!(names, vec!["2026-10-01_100000.md"]);
    }
}
