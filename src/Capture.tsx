import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createProject, listProjects, saveCapture } from "./lib/api";
import { extractImageFromPasteEvent, stripDataUrlPrefix } from "./lib/clipboardImage";

const appWindow = getCurrentWindow();

const LAST_PROJECT_KEY = "notes_dashboard_last_project";

function getStoredProject(): string {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) || "inbox";
  } catch {
    return "inbox";
  }
}

function setStoredProject(p: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, p);
  } catch {}
}

export default function Capture() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string>(getStoredProject);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  async function loadProjects() {
    try {
      const list = await listProjects();
      setProjects(list);
      const saved = getStoredProject();
      if (list.length > 0) {
        if (list.includes(saved)) {
          setProject(saved);
        } else if (list.includes("inbox")) {
          setProject("inbox");
          setStoredProject("inbox");
        } else {
          setProject(list[0]);
          setStoredProject(list[0]);
        }
      }
    } catch (err) {
      console.error("Projeler yüklenemedi:", err);
    }
  }

  function handleSelectProject(p: string) {
    setProject(p);
    setStoredProject(p);
  }

  async function handleCreateNewProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    try {
      await createProject(name);
      setNewProjectName("");
      setIsCreatingProject(false);
      await loadProjects();
      handleSelectProject(name);
      setStatus(`"${name}" oluşturuldu`);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (err) {
      setStatus(`Hata: ${String(err)}`);
    }
  }

  function reset() {
    setText("");
    setImages([]);
    setStatus("");
    setIsSaving(false);
    setIsCreatingProject(false);
    setNewProjectName("");
  }

  // Reload projects and reset capture state whenever window gains focus
  useEffect(() => {
    loadProjects();

    const unlisten = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        loadProjects();
        reset();
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global window paste and keydown listeners
  useEffect(() => {
    async function onWindowPaste(e: ClipboardEvent) {
      if (isCreatingProject) return;
      const dataUrl = await extractImageFromPasteEvent(e);
      if (dataUrl) {
        e.preventDefault();
        setImages((prev) => [...prev, dataUrl]);
        setStatus("Görsel eklendi");
        textareaRef.current?.focus();
      }
    }

    function onWindowKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (isCreatingProject) {
          setIsCreatingProject(false);
          setNewProjectName("");
          textareaRef.current?.focus();
          return;
        }
        appWindow.hide();
      }
    }

    window.addEventListener("paste", onWindowPaste);
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("paste", onWindowPaste);
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [isCreatingProject]);

  async function handleSave() {
    if (isSaving || isCreatingProject) return;
    const hasImages = images.length > 0;
    const trimmedText = text.trim();

    if (!hasImages && trimmedText.length === 0) {
      return; // nothing to save
    }

    setIsSaving(true);
    setStatus("Kaydediliyor...");

    try {
      const strippedImages = images.map((img) => stripDataUrlPrefix(img));
      await saveCapture(
        project,
        trimmedText.length > 0 ? trimmedText : undefined,
        strippedImages.length > 0 ? strippedImages : undefined
      );
      reset();
      await appWindow.hide();
    } catch (err) {
      setStatus(`Kaydedilemedi: ${String(err)}`);
      setIsSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      appWindow.hide();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSave();
    }
  }

  function handleRemoveImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
    textareaRef.current?.focus();
  }

  return (
    <div className="capture">
      <div className="capture__spine" />
      <div className="capture__body">
        <div className="capture__top">
          {isCreatingProject ? (
            <form className="capture__new-project-form" onSubmit={handleCreateNewProject}>
              <input
                ref={newProjectInputRef}
                type="text"
                className="capture__new-project-input"
                placeholder="Yeni proje adı..."
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                autoFocus
              />
              <button type="submit" className="capture__new-project-btn-ok" title="Projeyi Oluştur">
                ✓
              </button>
              <button
                type="button"
                className="capture__new-project-btn-cancel"
                title="İptal (Esc)"
                onClick={() => {
                  setIsCreatingProject(false);
                  setNewProjectName("");
                  textareaRef.current?.focus();
                }}
              >
                ✕
              </button>
            </form>
          ) : (
            <div className="capture__top-left">
              <select
                className="capture__project"
                value={project}
                onChange={(e) => {
                  if (e.target.value === "__create__") {
                    setIsCreatingProject(true);
                  } else {
                    handleSelectProject(e.target.value);
                  }
                }}
                onFocus={() => loadProjects()}
              >
                {projects.length === 0 && <option value="inbox">inbox</option>}
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="__create__">+ Yeni Proje...</option>
              </select>
              <button
                type="button"
                className="capture__create-proj-btn"
                title="Yeni Proje Oluştur"
                onClick={() => setIsCreatingProject(true)}
              >
                +
              </button>
            </div>
          )}
          <span className="capture__status">{status}</span>
        </div>

        {images.length > 0 && (
          <div className="capture__attachments-strip">
            {images.map((img, idx) => (
              <div key={idx} className="capture__attachment-chip">
                <img
                  src={img}
                  alt={`Ekran görüntüsü ${idx + 1}`}
                  className="capture__attachment-chip-thumb"
                />
                <button
                  type="button"
                  className="capture__attachment-chip-remove"
                  title="Görseli Kaldır"
                  onClick={() => handleRemoveImage(idx)}
                >
                  ✕
                </button>
              </div>
            ))}
            <span className="capture__attachments-count">
              {images.length} görsel
            </span>
          </div>
        )}

        <textarea
          ref={textareaRef}
          className={`capture__textarea ${images.length > 0 ? "capture__textarea--compact" : ""}`}
          placeholder={
            images.length > 0
              ? "Açıklama notu ekle (Enter: Hepsini Kaydet)..."
              : "Bir şey yaz ya da ekran görüntüsü yapıştır (birden fazla yapıştırabilirsiniz)..."
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus={!isCreatingProject}
        />

        <div className="capture__hint">
          <span>
            <kbd>Enter</kbd> kaydet
          </span>
          <span>
            <kbd>Shift+Enter</kbd> yeni satır
          </span>
          <span>
            <kbd>Esc</kbd> kapat
          </span>
        </div>
      </div>
    </div>
  );
}


