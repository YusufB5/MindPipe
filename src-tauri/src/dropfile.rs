//! Reads files dropped onto the app windows (images and plain-text notes only).
//!
//! The webview hands us a path; before anything is read we check the extension, the file's real
//! contents (image signatures, UTF-8 text without NUL bytes) and a size cap, so a renamed or
//! oversized file is simply skipped.

use super::*;
use std::io::Read;
use std::path::Path;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    /// "image" (data = base64) or "text" (data = the text)
    pub kind: String,
    pub mime: String,
    pub data: String,
}

fn image_mime(ext: &str, head: &[u8]) -> Option<&'static str> {
    match ext {
        "png" if head.starts_with(&[0x89, 0x50, 0x4E, 0x47]) => Some("image/png"),
        "jpg" | "jpeg" if head.starts_with(&[0xFF, 0xD8, 0xFF]) => Some("image/jpeg"),
        "gif" if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") => Some("image/gif"),
        "webp" if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" => Some("image/webp"),
        "bmp" if head.starts_with(b"BM") => Some("image/bmp"),
        _ => None,
    }
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "Dosya okunamadı".to_string())?;
    let mut buf = Vec::new();
    // Read one byte past the cap so a file that grew after the size check is still rejected.
    file.take(cap + 1).read_to_end(&mut buf).map_err(|_| "Dosya okunamadı".to_string())?;
    if buf.len() as u64 > cap {
        return Err("Dosya çok büyük".into());
    }
    Ok(buf)
}

pub fn load_with_limits(path: &Path, max_image: u64, max_text: u64) -> Result<DroppedFile, String> {
    let meta = fs::metadata(path).map_err(|_| "Dosya okunamadı".to_string())?;
    if !meta.is_file() {
        return Err("Klasörler desteklenmiyor".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

    let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp");
    let is_text = matches!(ext.as_str(), "txt" | "md" | "markdown");

    if is_image {
        if meta.len() > max_image {
            return Err("Dosya çok büyük".into());
        }
        let bytes = read_capped(path, max_image)?;
        let mime = image_mime(&ext, &bytes[..bytes.len().min(12)])
            .ok_or_else(|| "Dosya içeriği uzantısıyla uyuşmuyor".to_string())?;
        return Ok(DroppedFile {
            name,
            kind: "image".into(),
            mime: mime.into(),
            data: STANDARD.encode(&bytes),
        });
    }

    if is_text {
        if meta.len() > max_text {
            return Err("Dosya çok büyük".into());
        }
        let bytes = read_capped(path, max_text)?;
        if bytes.contains(&0) {
            return Err("Metin dosyası değil".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| "Metin UTF-8 değil".to_string())?;
        let text = text.trim_start_matches('\u{feff}').to_string();
        if text.trim().is_empty() {
            return Err("Dosya boş".into());
        }
        return Ok(DroppedFile { name, kind: "text".into(), mime: "text/plain".into(), data: text });
    }

    Err("Desteklenmeyen dosya türü".into())
}

pub fn load_dropped_file(path: &Path) -> Result<DroppedFile, String> {
    load_with_limits(path, MAX_IMAGE_BYTES, MAX_TEXT_BYTES)
}

#[tauri::command]
pub fn read_dropped_file(path: String) -> Result<DroppedFile, String> {
    load_dropped_file(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mindpipe_drop_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    #[test]
    fn accepts_real_images_of_each_supported_type() {
        let dir = temp_dir("images");
        let cases: [(&str, &[u8], &str); 5] = [
            ("a.png", PNG, "image/png"),
            ("b.JPG", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0], "image/jpeg"),
            ("c.gif", b"GIF89a....", "image/gif"),
            ("d.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),
            ("e.bmp", b"BM......", "image/bmp"),
        ];
        for (file, bytes, mime) in cases {
            fs::write(dir.join(file), bytes).unwrap();
            let got = load_dropped_file(&dir.join(file)).unwrap();
            assert_eq!(got.kind, "image", "{}", file);
            assert_eq!(got.mime, mime, "{}", file);
            assert_eq!(STANDARD.decode(&got.data).unwrap(), bytes);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_files_whose_content_does_not_match_the_extension() {
        let dir = temp_dir("fake");
        fs::write(dir.join("fake.png"), "this is just text").unwrap();
        fs::write(dir.join("jpg_named_png.png"), [0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap();
        assert!(load_dropped_file(&dir.join("fake.png")).is_err());
        assert!(load_dropped_file(&dir.join("jpg_named_png.png")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unsupported_types_directories_and_missing_files() {
        let dir = temp_dir("unsupported");
        fs::write(dir.join("run.exe"), "MZ").unwrap();
        fs::write(dir.join("vector.svg"), "<svg/>").unwrap();
        fs::write(dir.join("doc.pdf"), "%PDF").unwrap();
        fs::create_dir_all(dir.join("folder.txt")).unwrap();
        for f in ["run.exe", "vector.svg", "doc.pdf", "folder.txt", "missing.png"] {
            assert!(load_dropped_file(&dir.join(f)).is_err(), "{}", f);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforces_size_caps() {
        let dir = temp_dir("caps");
        fs::write(dir.join("big.png"), [PNG, &vec![0u8; 100]].concat()).unwrap();
        fs::write(dir.join("big.txt"), vec![b'a'; 100]).unwrap();
        assert!(load_with_limits(&dir.join("big.png"), 50, 50).is_err());
        assert!(load_with_limits(&dir.join("big.txt"), 50, 50).is_err());
        assert!(load_with_limits(&dir.join("big.png"), 1000, 1000).is_ok());
        assert!(load_with_limits(&dir.join("big.txt"), 1000, 1000).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_files_must_be_clean_utf8_and_not_empty() {
        let dir = temp_dir("text");
        fs::write(dir.join("ok.md"), "\u{feff}# Title\nbody çğıöşü").unwrap();
        fs::write(dir.join("binary.txt"), [b'a', 0, b'b']).unwrap();
        fs::write(dir.join("latin1.txt"), [0xE7, 0xFF, 0xFE]).unwrap();
        fs::write(dir.join("blank.txt"), "  \n\n ").unwrap();

        let ok = load_dropped_file(&dir.join("ok.md")).unwrap();
        assert_eq!(ok.kind, "text");
        assert_eq!(ok.data, "# Title\nbody çğıöşü");
        for f in ["binary.txt", "latin1.txt", "blank.txt"] {
            assert!(load_dropped_file(&dir.join(f)).is_err(), "{}", f);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
