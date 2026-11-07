//! PDF entries: a PDF copied into the project (`<timestamp>.pdf`) plus a pen-stroke sidecar
//! (`<timestamp>.ink.json`). The PDF itself is never modified; strokes live in the sidecar and can be
//! baked into a copy with `export_annotated_pdf`.

use super::*;
use std::io::Read;
use std::path::Path;

const MAX_PDF_BYTES: u64 = 150 * 1024 * 1024;
const MAX_INK_BYTES: usize = 40 * 1024 * 1024;

/// `<stem>.pdf` -> `<stem>.ink.json`
pub fn ink_path(pdf: &Path) -> PathBuf {
    let stem = pdf.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    pdf.with_file_name(format!("{}.ink.json", stem))
}

/// The name the PDF had when it was imported (kept in the sidecar), falling back to the file stem.
pub fn display_name(pdf: &Path) -> String {
    fs::read_to_string(ink_path(pdf))
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| pdf.file_stem().and_then(|s| s.to_str()).unwrap_or("PDF").to_string())
}

fn clean_display_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let base = base.strip_suffix(".pdf").or_else(|| base.strip_suffix(".PDF")).unwrap_or(base);
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(120).collect();
    if cleaned.trim().is_empty() {
        "PDF".to_string()
    } else {
        cleaned.trim().to_string()
    }
}

/// Stores a validated PDF in the project and returns its path.
fn store_pdf(app: &AppHandle, project: &str, display: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("PDF çok büyük (en fazla 150 MB)".into());
    }
    // Real PDFs start with %PDF- (some have a few junk bytes before it).
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("Geçerli bir PDF dosyası değil".into());
    }
    let clean = sanitize_name(project)?;
    let dir = projects_root(app)?.join(&clean);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _lock = lock_dir(&dir)?;
    let stem = unique_timestamp_stem(&dir);
    let pdf_path = dir.join(format!("{}.pdf", stem));
    atomic_write(&pdf_path, bytes)?;
    let meta = serde_json::json!({ "version": 1, "name": clean_display_name(display), "pages": {} });
    atomic_write(&ink_path(&pdf_path), meta.to_string().as_bytes())?;
    let _ = app.emit("notes-updated", ());
    Ok(pdf_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_pdf_from_path(app: AppHandle, project: String, path: String) -> Result<String, String> {
    let src = Path::new(&path);
    let is_pdf = src
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("Yalnızca .pdf dosyaları desteklenir".into());
    }
    let meta = fs::metadata(src).map_err(|_| "Dosya okunamadı".to_string())?;
    if !meta.is_file() {
        return Err("Klasörler desteklenmiyor".into());
    }
    if meta.len() > MAX_PDF_BYTES {
        return Err("PDF çok büyük (en fazla 150 MB)".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(src)
        .map_err(|_| "Dosya okunamadı".to_string())?
        .take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Dosya okunamadı".to_string())?;
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("PDF");
    store_pdf(&app, &project, name, &bytes)
}

#[tauri::command]
pub fn import_pdf_bytes(app: AppHandle, project: String, name: String, data_b64: String) -> Result<String, String> {
    let bytes = STANDARD.decode(data_b64.trim()).map_err(|_| "Geçersiz PDF verisi".to_string())?;
    store_pdf(&app, &project, &name, &bytes)
}

/// Only PDFs that live inside a project folder may be touched through these commands.
fn project_pdf(app: &AppHandle, pdf_path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(pdf_path);
    let is_pdf = p
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("Geçersiz PDF yolu".into());
    }
    let root = projects_root(app)?.canonicalize().map_err(|e| e.to_string())?;
    let real = p.canonicalize().map_err(|_| "PDF bulunamadı".to_string())?;
    if !real.starts_with(&root) {
        return Err("PDF proje klasörünün dışında".into());
    }
    Ok(real)
}

#[tauri::command]
pub fn read_pdf_ink(app: AppHandle, pdf_path: String) -> Result<String, String> {
    let pdf = project_pdf(&app, &pdf_path)?;
    Ok(fs::read_to_string(ink_path(&pdf)).unwrap_or_default())
}

#[tauri::command]
pub fn save_pdf_ink(app: AppHandle, pdf_path: String, json: String) -> Result<(), String> {
    if json.len() > MAX_INK_BYTES {
        return Err("Çizim verisi çok büyük".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Geçersiz çizim verisi".to_string())?;
    let pdf = project_pdf(&app, &pdf_path)?;
    atomic_write(&ink_path(&pdf), json.as_bytes())
}

/// Writes the annotated copy to the user's Downloads folder and returns its path.
#[tauri::command]
pub fn export_annotated_pdf(app: AppHandle, name: String, data_b64: String) -> Result<String, String> {
    let bytes = STANDARD.decode(data_b64.trim()).map_err(|_| "Geçersiz PDF verisi".to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("Geçerli bir PDF dosyası değil".into());
    }
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = format!("{} (notlu)", clean_display_name(&name))
        .replace(['<', '>', ':', '"', '|', '?', '*'], "_");
    let mut target = dir.join(format!("{}.pdf", base));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{} ({}).pdf", base, n));
        n += 1;
    }
    fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ink_path_sits_next_to_the_pdf() {
        let p = Path::new("/x/2026-11-07_120000.pdf");
        assert_eq!(ink_path(p), Path::new("/x/2026-11-07_120000.ink.json"));
    }

    #[test]
    fn display_names_are_cleaned() {
        assert_eq!(clean_display_name("C:\\docs\\Ders Notu.pdf"), "Ders Notu");
        assert_eq!(clean_display_name("a/b/c.PDF"), "c");
        assert_eq!(clean_display_name("   "), "PDF");
    }

    #[test]
    fn ink_files_share_the_entry_key_of_their_pdf() {
        assert_eq!(extract_base_key("2026-11-07_120000.ink"), extract_base_key("2026-11-07_120000"));
    }
}
