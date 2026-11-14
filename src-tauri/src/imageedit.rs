//! Drawing on PNG attachments. The edited picture replaces the file; the very first original is kept
//! as a hidden backup (`.<name>.orig.png`) so the drawing can be undone later. Hidden files are never
//! listed, synced or shown to AI agents.

use super::*;
use std::path::Path;

const MAX_PNG_BYTES: usize = 80 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// `<stem>.png` -> `.<stem>.orig.png` next to it.
pub fn backup_path(png: &Path) -> PathBuf {
    let stem = png.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    png.with_file_name(format!(".{}.orig.png", stem))
}

/// Removes the backup of a PNG that is being deleted, so no hidden orphan stays behind.
pub fn remove_backup(png: &Path) {
    let _ = fs::remove_file(backup_path(png));
}

/// Only visible PNG files inside a project folder may be edited through these commands.
fn project_png(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let is_png = p
        .extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case("png"));
    if !is_png || name.starts_with('.') {
        return Err("Geçersiz resim yolu".into());
    }
    let root = projects_root(app)?.canonicalize().map_err(|e| e.to_string())?;
    let real = p.canonicalize().map_err(|_| "Resim bulunamadı".to_string())?;
    if !real.starts_with(&root) {
        return Err("Resim proje klasörünün dışında".into());
    }
    Ok(real)
}

#[tauri::command]
pub fn save_edited_image(app: AppHandle, path: String, png_base64: String) -> Result<(), String> {
    let bytes = STANDARD.decode(png_base64.trim()).map_err(|_| "Geçersiz resim verisi".to_string())?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err("Resim çok büyük".into());
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("Geçerli bir PNG değil".into());
    }
    let png = project_png(&app, &path)?;
    let dir = png.parent().ok_or("Geçersiz dosya yolu")?;
    let _lock = lock_dir(dir)?;
    let backup = backup_path(&png);
    // Only the first edit keeps a backup, so "restore" always goes back to the real original.
    if !backup.exists() {
        fs::copy(&png, &backup).map_err(|e| e.to_string())?;
    }
    atomic_write(&png, &bytes)?;
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
pub fn image_has_original(app: AppHandle, path: String) -> Result<bool, String> {
    let png = project_png(&app, &path)?;
    Ok(backup_path(&png).is_file())
}

#[tauri::command]
pub fn restore_original_image(app: AppHandle, path: String) -> Result<(), String> {
    let png = project_png(&app, &path)?;
    let dir = png.parent().ok_or("Geçersiz dosya yolu")?;
    let _lock = lock_dir(dir)?;
    let backup = backup_path(&png);
    let original = fs::read(&backup).map_err(|_| "Orijinal bulunamadı".to_string())?;
    atomic_write(&png, &original)?;
    let _ = fs::remove_file(&backup);
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_is_a_hidden_sibling_of_the_png() {
        let b = backup_path(Path::new("/x/2026-11-07_120000_1.png"));
        assert_eq!(b, Path::new("/x/.2026-11-07_120000_1.orig.png"));
        assert!(b.file_name().unwrap().to_str().unwrap().starts_with('.'));
    }

    #[test]
    fn removing_a_missing_backup_is_harmless() {
        remove_backup(Path::new("/definitely/not/here.png"));
    }
}
