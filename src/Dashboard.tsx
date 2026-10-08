import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createProject,
  deleteProject,
  deleteEntry,
  listEntries,
  listProjects,
  openEntry,
  openProjectFolder,
  readNote,
  saveNote,
  saveCapture,
  updateNote,
  searchEntries,
  attachImageToEntry,
  deleteImageFile,
  togglePinEntry,
  reorderEntries,
  exportAiContext,
  listTodos,
  addTodo,
  toggleTodo,
  deleteTodo,
  getMcpStatus,
  toggleProjectMcpAccess,
  setMcpPermissionSetting,
  clearMcpLogs,
  getCaptureShortcut,
  updateCaptureShortcut,
  type EntryMeta,
  type TodoItem,
  type SearchResultItem,
  type McpStatus,
} from "./lib/api";
import { extractImageFromPasteEvent, stripDataUrlPrefix } from "./lib/clipboardImage";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type Language,
  type ThemeId,
  translations,
  getInitialLanguage,
  getInitialTheme,
  applyTheme,
} from "./lib/i18n";

const appWindow = getCurrentWindow();

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function renderDevLogContent(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  return (
    <div className="devlog-text">
      {lines.map((line, i) => {
        const l = line.trim();
        if (l.startsWith("### ")) {
          return <h4 key={i} className="devlog-h3">{l.substring(4)}</h4>;
        }
        if (l.startsWith("## ")) {
          return <h3 key={i} className="devlog-h2">{l.substring(3)}</h3>;
        }
        if (l.startsWith("# ")) {
          return <h2 key={i} className="devlog-h1">{l.substring(2)}</h2>;
        }
        if (l.startsWith("- ") || l.startsWith("* ")) {
          return (
            <div key={i} className="devlog-bullet">
              <span className="devlog-bullet-dot">•</span>
              <span>{l.substring(2)}</span>
            </div>
          );
        }
        if (!l) {
          return <div key={i} className="devlog-spacer" />;
        }
        return (
          <p key={i} className="devlog-p">
            {line}
          </p>
        );
      })}
    </div>
  );
}

function AiSparkleIcon({ size = 11, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`ai-sparkle-icon ${className}`}
      aria-hidden="true"
    >
      <path d="M12 2Q12 12 2 12Q12 12 12 22Q12 12 22 12Q12 12 12 2Z" />
    </svg>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>("inbox");
  const [entries, setEntries] = useState<EntryMeta[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [loading, setLoading] = useState(true);

  // View mode tab: "notes" | "todos"
  const [activeTab, setActiveTab] = useState<"notes" | "todos">("notes");

  // TODO state
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodoText, setNewTodoText] = useState("");
  const [todosLoading, setTodosLoading] = useState(false);

  // AI Context status notification
  const [aiContextStatus, setAiContextStatus] = useState("");

  // Pointer-based card reordering state
  const [pointerDragIndex, setPointerDragIndex] = useState<number | null>(null);
  const [pointerDropIndex, setPointerDropIndex] = useState<number | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const isDraggingCardRef = useRef(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"current" | "all">("current");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Note editor & viewer modal state
  const [editingEntry, setEditingEntry] = useState<EntryMeta | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorStatus, setEditorStatus] = useState("");

  // Direct new note modal state
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState("");
  const [newNoteImages, setNewNoteImages] = useState<string[]>([]);

  // Lightbox state for full-size image viewing
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // DevLog Stream states
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [inlineEditingPath, setInlineEditingPath] = useState<string | null>(null);
  const [inlineDraftText, setInlineDraftText] = useState("");
  const [inlineStatus, setInlineStatus] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});

  // Settings & i18n states
  const [lang, setLang] = useState<Language>(getInitialLanguage);
  const [theme, setTheme] = useState<ThemeId>(getInitialTheme);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "shortcuts" | "about">("appearance");

  const t = <K extends keyof typeof translations.tr>(key: K): (typeof translations.tr)[K] => {
    return (translations[lang] as any)[key];
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function handleLanguageChange(newLang: Language) {
    setLang(newLang);
    localStorage.setItem("mindpipe_lang", newLang);
  }

  function handleThemeChange(newTheme: ThemeId) {
    setTheme(newTheme);
    applyTheme(newTheme);
  }

  // Shortcut customization state
  const [captureShortcut, setCaptureShortcut] = useState("Ctrl+Shift+N");
  const [isEditingShortcut, setIsEditingShortcut] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState("Ctrl+Shift+N");
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [shortcutError, setShortcutError] = useState("");

  useEffect(() => {
    getCaptureShortcut()
      .then((sc) => {
        if (sc) {
          setCaptureShortcut(sc);
          setShortcutDraft(sc);
        }
      })
      .catch((err) => console.error("Could not get capture shortcut:", err));
  }, []);

  async function handleSaveCaptureShortcut(newVal?: string) {
    const toSave = (newVal !== undefined ? newVal : shortcutDraft).trim();
    if (!toSave) return;
    setShortcutError("");
    setShortcutStatus("");
    try {
      const updated = await updateCaptureShortcut(toSave);
      setCaptureShortcut(updated);
      setShortcutDraft(updated);
      setIsEditingShortcut(false);
      setShortcutStatus(t("shortcutSaved"));
      setTimeout(() => setShortcutStatus(""), 3000);
    } catch (err) {
      setShortcutError(String(err));
    }
  }

  async function handleResetCaptureShortcut() {
    await handleSaveCaptureShortcut("Ctrl+Shift+N");
  }

  // MCP Status & Logs state
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const [mcpClientTab, setMcpClientTab] = useState<"json" | "codex">("json");
  const [mcpConfigCopied, setMcpConfigCopied] = useState(false);

  function getMcpConfigSnippet(format: "json" | "codex", scriptPath?: string) {
    const rawPath = scriptPath || "<mcp-server.cjs yolu>";

    if (format === "codex") {
      // Codex CLI uses TOML (~/.codex/config.toml); single quotes = literal string, no escaping needed
      return `[mcp_servers.mindpipe]\ncommand = "node"\nargs = ['${rawPath}']`;
    }

    return JSON.stringify(
      {
        mcpServers: {
          mindpipe: {
            command: "node",
            args: [rawPath],
          },
        },
      },
      null,
      2
    );
  }

  async function handleCopyMcpConfig(snippet: string) {
    try {
      await navigator.clipboard.writeText(snippet);
      setMcpConfigCopied(true);
      setTimeout(() => setMcpConfigCopied(false), 2200);
    } catch (err) {
      alert(lang === "tr" ? `Kopyalanamadı: ${String(err)}` : `Copy failed: ${String(err)}`);
    }
  }

  async function refreshMcpStatus() {
    try {
      const status = await getMcpStatus();
      setMcpStatus(status);
    } catch (err) {
      console.error("MCP status error:", err);
    }
  }

  function isProjectMcpAllowed(projectName: string) {
    if (!mcpStatus || !mcpStatus.isConfigured) return false;
    const clean = projectName.toLowerCase();
    if (mcpStatus.blockedProjects?.some((p) => p.toLowerCase() === clean)) {
      return false;
    }
    if (mcpStatus.allowedAll) return true;
    return mcpStatus.allowedProjects?.some((p) => p.toLowerCase() === clean) ?? false;
  }

  async function handleToggleProjectMcp(projectName: string, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    try {
      await toggleProjectMcpAccess(projectName);
      await refreshMcpStatus();
    } catch (err) {
      alert(lang === "tr" ? `Erişim izni güncellenemedi: ${String(err)}` : `Failed to update permission: ${String(err)}`);
    }
  }

  async function handleClearMcpLogs() {
    try {
      await clearMcpLogs();
      await refreshMcpStatus();
    } catch (err) {
      alert(lang === "tr" ? `Loglar temizlenemedi: ${String(err)}` : `Failed to clear logs: ${String(err)}`);
    }
  }

  async function handleSetPermissionSetting(key: string, value: string) {
    try {
      await setMcpPermissionSetting(key, value);
      await refreshMcpStatus();
    } catch (err) {
      alert(lang === "tr" ? `Yetki ayarı kaydedilemedi: ${String(err)}` : `Failed to save permission: ${String(err)}`);
    }
  }

  async function refreshProjects() {
    const list = await listProjects();
    setProjects(list);
    if (list.length > 0 && !list.includes(active)) {
      setActive(list.includes("inbox") ? "inbox" : list[0]);
    }
  }

  async function refreshEntries(project: string, isSilent = false) {
    if (!isSilent) setLoading(true);
    try {
      const list = await listEntries(project);
      setEntries(list);

      // Load full contents for DevLog stream
      const noteEntries = list.filter((e) => e.kind === "note" || e.kind === "mixed");
      const contents: Record<string, string> = {};
      await Promise.all(
        noteEntries.map(async (entry) => {
          try {
            contents[entry.path] = await readNote(entry.path);
          } catch {
            contents[entry.path] = entry.preview || "";
          }
        })
      );
      setNoteContents(contents);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }

  async function refreshTodos(project: string, isSilent = false) {
    if (!isSilent) setTodosLoading(true);
    try {
      const list = await listTodos(project);
      setTodos(list);
    } catch (err) {
      console.error("Görevler yüklenemedi:", err);
    } finally {
      if (!isSilent) setTodosLoading(false);
    }
  }

  // Load projects initially
  useEffect(() => {
    refreshProjects();
    refreshMcpStatus();
    const interval = setInterval(refreshMcpStatus, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll MCP status faster when modal is open
  useEffect(() => {
    if (isMcpModalOpen) {
      refreshMcpStatus();
      const interval = setInterval(refreshMcpStatus, 1500);
      return () => clearInterval(interval);
    }
  }, [isMcpModalOpen]);

  // Refresh entries and todos on project change
  useEffect(() => {
    if (active) {
      refreshEntries(active);
      refreshTodos(active);
      setExpandedNotes({});
    }
  }, [active]);

  // Real-time auto refresh from backend events and window focus
  useEffect(() => {
    const unlistenNotes = listen("notes-updated", () => {
      refreshProjects();
      refreshMcpStatus();
      if (active) {
        refreshEntries(active, true);
        refreshTodos(active, true);
      }
    });

    const unlistenFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        refreshProjects();
        refreshMcpStatus();
        if (active) {
          refreshEntries(active, true);
          refreshTodos(active, true);
        }
      }
    });

    return () => {
      unlistenNotes.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Search runner
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchEntries(
          q,
          searchScope === "current" ? active : undefined
        );
        setSearchResults(results);
      } catch (err) {
        console.error("Arama hatası:", err);
      } finally {
        setIsSearching(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [searchQuery, searchScope, active]);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    try {
      await createProject(name);
      setNewProjectName("");
      await refreshProjects();
      setActive(name);
    } catch (err) {
      alert(`Proje oluşturulamadı: ${String(err)}`);
    }
  }

  async function handleTogglePin(entry: EntryMeta, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await togglePinEntry(active, entry.id);
      await refreshEntries(active);
    } catch (err) {
      alert(`Sabitleme işlemi başarısız: ${String(err)}`);
    }
  }

  async function handleCopyAiContext() {
    try {
      const text = await exportAiContext(active);
      await navigator.clipboard.writeText(text);
      setAiContextStatus("AI Bağlamı Kopyalandı ✓");
      setTimeout(() => setAiContextStatus(""), 2500);
    } catch (err) {
      alert(`AI Bağlamı kopyalanamadı: ${String(err)}`);
    }
  }

  function handleStartCardDrag(e: React.PointerEvent, index: number) {
    if (e.button !== 0) return; // Only primary mouse button
    if (searchQuery.trim()) return; // Don't reorder during search results

    // Ignore interactive children
    const target = e.target as HTMLElement;
    const isDirectHandle = Boolean(target.closest(".devlog-item__drag-handle, .entry__drag-handle"));

    if (
      !isDirectHandle &&
      (
        target.closest("button") ||
        target.closest("input") ||
        target.closest("textarea") ||
        target.closest("a") ||
        target.closest(".devlog-item__image") ||
        target.closest(".devlog-item__gallery") ||
        target.closest(".devlog-item__editor-wrap") ||
        target.closest(".devlog-item__content") ||
        target.closest(".entry__thumb") ||
        target.closest(".entry__thumb-wrap")
      )
    ) {
      return;
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const fromIndex = index;
    let dragStarted = false;

    if (isDirectHandle) {
      e.preventDefault();
    }

    const onPointerMove = (moveEvt: PointerEvent) => {
      const deltaX = Math.abs(moveEvt.clientX - startX);
      const deltaY = Math.abs(moveEvt.clientY - startY);

      if (!dragStarted && (isDirectHandle || deltaY > 4 || deltaX > 4)) {
        dragStarted = true;
        isDraggingCardRef.current = true;
        setPointerDragIndex(fromIndex);
        setPointerDropIndex(fromIndex);
        document.body.classList.add("is-reordering-cards");
      }

      if (dragStarted) {
        // 1. Check if cursor is back over the original dragged card's area (cancel/abort intent):
        const origCardEl = document.querySelector(`.devlog-item[data-index="${fromIndex}"], .entry[data-index="${fromIndex}"]`);
        if (origCardEl) {
          const origRect = origCardEl.getBoundingClientRect();
          if (
            moveEvt.clientX >= origRect.left &&
            moveEvt.clientX <= origRect.right &&
            moveEvt.clientY >= origRect.top &&
            moveEvt.clientY <= origRect.bottom
          ) {
            setPointerDropIndex(fromIndex);
            return;
          }
        }

        // 2. Check if cursor moved outside horizontal stream boundaries (e.g. into sidebar or off-screen to cancel):
        const listEl = document.querySelector(".devlog-stream, .entries-list");
        if (listEl) {
          const listRect = listEl.getBoundingClientRect();
          if (moveEvt.clientX < listRect.left - 40 || moveEvt.clientX > listRect.right + 40) {
            setPointerDropIndex(fromIndex);
            return;
          }
        }

        // 3. Element under point
        const el = document.elementFromPoint(moveEvt.clientX, moveEvt.clientY);
        const cardEl = el?.closest(".devlog-item[data-index], .entry[data-index]");
        if (cardEl) {
          const idxStr = cardEl.getAttribute("data-index");
          if (idxStr !== null) {
            const targetIdx = parseInt(idxStr, 10);
            if (!isNaN(targetIdx) && targetIdx >= 0 && targetIdx < entriesRef.current.length) {
              setPointerDropIndex(targetIdx);
            }
          }
        } else {
          // If cursor went slightly above or below the list
          if (listEl) {
            const listRect = listEl.getBoundingClientRect();
            if (moveEvt.clientY < listRect.top + 30) {
              setPointerDropIndex(0);
            } else if (moveEvt.clientY > listRect.bottom - 30) {
              setPointerDropIndex(entriesRef.current.length - 1);
            }
          }
        }
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("is-reordering-cards");
    };

    const onKeyDown = (kEvt: KeyboardEvent) => {
      if (kEvt.key === "Escape") {
        cleanup();
        setPointerDragIndex(null);
        setPointerDropIndex(null);
        setTimeout(() => {
          isDraggingCardRef.current = false;
        }, 80);
      }
    };

    const onPointerUp = async () => {
      cleanup();

      if (dragStarted) {
        setTimeout(() => {
          isDraggingCardRef.current = false;
        }, 80);

        setPointerDropIndex((targetIdx) => {
          setPointerDragIndex((srcIdx) => {
            if (srcIdx !== null && targetIdx !== null && srcIdx !== targetIdx) {
              const updated = [...entriesRef.current];
              const [removed] = updated.splice(srcIdx, 1);
              updated.splice(targetIdx, 0, removed);
              setEntries(updated);

              reorderEntries(active, updated.map((item) => item.id)).catch((err) => {
                console.error("Sıralama kaydedilemedi:", err);
              });
            }
            return null;
          });
          return null;
        });
      } else {
        isDraggingCardRef.current = false;
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
  }


  async function handleAddTodo(e: React.FormEvent) {
    e.preventDefault();
    const text = newTodoText.trim();
    if (!text) return;
    try {
      await addTodo(active, text);
      setNewTodoText("");
      await refreshTodos(active);
    } catch (err) {
      alert(`Görev eklenemedi: ${String(err)}`);
    }
  }

  async function handleToggleTodo(id: string, done: boolean) {
    try {
      await toggleTodo(active, id, done);
      await refreshTodos(active);
    } catch (err) {
      alert(`Görev güncellenemedi: ${String(err)}`);
    }
  }

  async function handleDeleteTodo(id: string) {
    try {
      await deleteTodo(active, id);
      await refreshTodos(active);
    } catch (err) {
      alert(`Görev silinemedi: ${String(err)}`);
    }
  }

  async function handleDeleteProject(projectName: string, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    if (projectName === "inbox") {
      alert("inbox projesi silinemez.");
      return;
    }
    const confirmed = window.confirm(t("deleteProjectConfirm")(projectName));
    if (!confirmed) return;

    try {
      await deleteProject(projectName);
      await refreshProjects();
      setActive("inbox");
    } catch (err) {
      alert(`Proje silinemedi: ${String(err)}`);
    }
  }

  async function handleOpenFolder(projectName: string, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    try {
      await openProjectFolder(projectName);
    } catch (err) {
      alert(`Klasör açılamadı: ${String(err)}`);
    }
  }

  async function handleOpenEntryModal(entry: EntryMeta) {
    setEditingEntry(entry);
    setEditorStatus("");
    if (entry.kind === "note" || entry.kind === "mixed") {
      setEditorLoading(true);
      try {
        const text = await readNote(entry.path);
        setEditorContent(text);
      } catch (err) {
        setEditorContent(`Hata: Not okunamadı (${String(err)})`);
      } finally {
        setEditorLoading(false);
      }
    }
  }

  async function handleSaveEditedNote() {
    if (!editingEntry) return;
    try {
      setEditorStatus("Kaydediliyor...");
      await updateNote(editingEntry.path, editorContent);
      setEditorStatus("Kaydedildi ✓");
      await refreshEntries(active);
      setTimeout(() => setEditorStatus(""), 2000);
    } catch (err) {
      setEditorStatus(`Hata: ${String(err)}`);
    }
  }

  async function handleDeleteEntry(entry: EntryMeta, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    const confirmed = window.confirm(t("deleteEntryConfirm")(entry.name));
    if (!confirmed) return;

    try {
      await deleteEntry(entry.path, entry.imagePaths);
      if (editingEntry?.id === entry.id) {
        setEditingEntry(null);
      }
      await refreshEntries(active);
    } catch (err) {
      alert(`Silinemedi: ${String(err)}`);
    }
  }

  async function handleDeleteImageFromModal(imgPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!editingEntry) return;
    try {
      await deleteImageFile(imgPath);
      const updatedImages = editingEntry.imagePaths.filter((p) => p !== imgPath);
      const newKind = updatedImages.length > 0 ? (editingEntry.kind === "image" ? "image" : "mixed") : "note";
      setEditingEntry({
        ...editingEntry,
        imagePaths: updatedImages,
        kind: newKind,
      });
      await refreshEntries(active);
    } catch (err) {
      alert(`Görsel silinemedi: ${String(err)}`);
    }
  }

  function startInlineEdit(entry: EntryMeta) {
    setInlineEditingPath(entry.path);
    setInlineDraftText(noteContents[entry.path] ?? entry.preview ?? "");
    setInlineStatus("");
  }

  async function handleSaveInlineNote(entry: EntryMeta) {
    try {
      setInlineStatus("Kaydediliyor...");
      await updateNote(entry.path, inlineDraftText);
      setNoteContents((prev) => ({ ...prev, [entry.path]: inlineDraftText }));
      setExpandedNotes((prev) => ({ ...prev, [entry.path]: true }));
      setInlineStatus("Kaydedildi ✓");
      setTimeout(() => {
        setInlineEditingPath(null);
        setInlineStatus("");
      }, 400);
      await refreshEntries(active, true);
    } catch (err) {
      setInlineStatus(`Hata: ${String(err)}`);
    }
  }

  function toggleNoteExpand(path: string) {
    setExpandedNotes((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  }

  async function handleCopyEntryText(entry: EntryMeta, e: React.MouseEvent) {
    e.stopPropagation();
    const text = noteContents[entry.path] ?? entry.preview ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(entry.path);
      setTimeout(() => setCopiedPath(null), 1800);
    } catch {}
  }

  async function handleDeleteImageInline(_entry: EntryMeta, imgPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deleteImageFile(imgPath);
      await refreshEntries(active, true);
    } catch (err) {
      alert(`Görsel silinemedi: ${String(err)}`);
    }
  }

  async function handleCreateDirectNote(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const hasImages = newNoteImages.length > 0;
    const trimmed = newNoteContent.trim();
    if (!hasImages && !trimmed) return;
    try {
      if (hasImages) {
        const strippedImages = newNoteImages.map((img) => stripDataUrlPrefix(img));
        await saveCapture(
          active,
          trimmed.length > 0 ? trimmed : undefined,
          strippedImages
        );
      } else {
        await saveNote(active, trimmed);
      }
      setNewNoteContent("");
      setNewNoteImages([]);
      setIsCreatingNote(false);
      await refreshEntries(active);
    } catch (err) {
      alert(`Not kaydedilemedi: ${String(err)}`);
    }
  }

  // Keyboard shortcuts & Modal clipboard image paste
  useEffect(() => {
    async function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (lightboxImage) {
          setLightboxImage(null);
          return;
        }
        if (editingEntry) {
          setEditingEntry(null);
          return;
        }
        if (isSettingsOpen) {
          setIsSettingsOpen(false);
          return;
        }
        if (isMcpModalOpen) {
          setIsMcpModalOpen(false);
          return;
        }
        if (isCreatingNote) {
          setIsCreatingNote(false);
          setNewNoteContent("");
          setNewNoteImages([]);
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        isCreatingNote
      ) {
        e.preventDefault();
        handleCreateDirectNote();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "s" &&
        editingEntry &&
        (editingEntry.kind === "note" || editingEntry.kind === "mixed")
      ) {
        e.preventDefault();
        handleSaveEditedNote();
      }
    }

    let lastPasteTime = 0;
    async function onWindowPaste(e: ClipboardEvent) {
      if (isCreatingNote) {
        const now = Date.now();
        if (now - lastPasteTime < 350) return;
        const dataUrl = await extractImageFromPasteEvent(e);
        if (dataUrl) {
          lastPasteTime = Date.now();
          e.preventDefault();
          setNewNoteImages((prev) => [...prev, dataUrl]);
          return;
        }
      }
      if (inlineEditingPath) {
        const dataUrl = await extractImageFromPasteEvent(e);
        if (dataUrl) {
          e.preventDefault();
          try {
            const stripped = stripDataUrlPrefix(dataUrl);
            await attachImageToEntry(inlineEditingPath, stripped);
            setInlineStatus("Yeni görsel eklendi ✓");
            setTimeout(() => setInlineStatus(""), 2200);
            await refreshEntries(active, true);
          } catch (err) {
            alert(`Görsel eklenemedi: ${String(err)}`);
          }
          return;
        }
      }
      if (editingEntry) {
        const dataUrl = await extractImageFromPasteEvent(e);
        if (dataUrl) {
          e.preventDefault();
          try {
            const stripped = stripDataUrlPrefix(dataUrl);
            const newPath = await attachImageToEntry(editingEntry.path, stripped);
            const updatedImages = [...editingEntry.imagePaths, newPath];
            setEditingEntry({
              ...editingEntry,
              imagePaths: updatedImages,
              kind: editingEntry.kind === "note" ? "mixed" : editingEntry.kind,
            });
            setEditorStatus("Yeni görsel eklendi ✓");
            setTimeout(() => setEditorStatus(""), 2500);
            await refreshEntries(active);
          } catch (err) {
            alert(`Görsel eklenemedi: ${String(err)}`);
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onWindowPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onWindowPaste);
    };
  }, [editingEntry, editorContent, lightboxImage, isCreatingNote, newNoteImages, newNoteContent, searchQuery, active, inlineEditingPath, isSettingsOpen, isMcpModalOpen]);

  return (
    <div className="dashboard">
      <aside className="dashboard__sidebar">
        <div className="dashboard__sidebar-header">
          <span className="dashboard__sidebar-title">{t("projects")}</span>
          <button
            type="button"
            className="dashboard__settings-trigger-btn"
            onClick={() => setIsSettingsOpen(true)}
            title={t("settingsTitle")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        <div className="dashboard__projects-list">
          {projects.map((p) => {
            const isAllowed = isProjectMcpAllowed(p);
            return (
              <div
                key={p}
                className={
                  "dashboard__project" +
                  (p === active ? " dashboard__project--active" : "")
                }
                onClick={() => setActive(p)}
              >
                <div className="dashboard__project-info">
                  {mcpStatus?.isConfigured && (
                    <button
                      type="button"
                      className={`dashboard__project-mcp-btn ${
                        !isAllowed
                          ? "dashboard__project-mcp-btn--blocked"
                          : mcpStatus.isLiveProcessing
                          ? "dashboard__project-mcp-btn--live"
                          : "dashboard__project-mcp-btn--ready"
                      }`}
                      onClick={(e) => handleToggleProjectMcp(p, e)}
                      title={
                        !isAllowed
                          ? (lang === "tr" ? "AI Erişimi: KAPALI (Engellendi)\nTıklayarak AI erişimini TEKRAR AÇABİLİRSİNİZ." : "AI Access: OFF (Blocked)\nClick to ALLOW AI access.")
                          : mcpStatus.isLiveProcessing
                          ? (lang === "tr" ? `AI Aktif İşlem Yapıyor: ${mcpStatus.detectedClient || "AI"}\n(Tıkla: Bu projenin AI erişimini KAPAT)` : `AI Actively Processing: ${mcpStatus.detectedClient || "AI"}\n(Click to BLOCK AI access)`)
                          : (lang === "tr" ? `AI Erişimi Açık (Hazır / Beklemede - ${mcpStatus.detectedClient || "AI"})\n(Tıkla: Bu projenin AI erişimini KAPAT)` : `AI Access Allowed (Ready / Idle - ${mcpStatus.detectedClient || "AI"})\n(Click to BLOCK AI access)`)
                      }
                      aria-label={`MCP AI Erişimi (${p})`}
                    >
                      <span className="dashboard__project-mcp-dot" />
                    </button>
                  )}
                  <span
                    className={`dashboard__project-name ${
                      mcpStatus?.aiProjects?.includes(p) ? "dashboard__project-name--ai" : ""
                    }`}
                    title={mcpStatus?.aiProjects?.includes(p) ? "Bu proje AI tarafından oluşturuldu" : undefined}
                  >
                    {p}
                  </span>
                </div>
                <div className="dashboard__project-actions">
                  <button
                    type="button"
                    className="dashboard__project-btn"
                    title={t("openFolder")}
                    onClick={(e) => handleOpenFolder(p, e)}
                    aria-label={t("openFolder")}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  {p !== "inbox" && (
                    <button
                      type="button"
                      className="dashboard__project-btn dashboard__project-btn--delete"
                      title={t("deleteProject")}
                      onClick={(e) => handleDeleteProject(p, e)}
                      aria-label={t("deleteProject")}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <form className="dashboard__new-project" onSubmit={handleCreateProject}>
          <input
            type="text"
            placeholder={t("newProjectBtn")}
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
          />
        </form>

        {/* MindPipe MCP Status & Activity Bar */}
        <div
          className={`sidebar__mcp-status ${
            mcpStatus?.isLiveProcessing
              ? "sidebar__mcp-status--live"
              : mcpStatus?.isConfigured
              ? "sidebar__mcp-status--ready"
              : ""
          }`}
          onClick={() => setIsMcpModalOpen(true)}
          title={lang === "tr" ? "MindPipe MCP Durumu, İstemci Bağlantısı ve Güvenlik Duvarı (Tıkla)" : "MindPipe MCP Status, Client Connection & Firewall (Click)"}
        >
          <div className="sidebar__mcp-status-info">
            <span
              className={`sidebar__mcp-pulse ${
                mcpStatus?.isLiveProcessing
                  ? "sidebar__mcp-pulse--live"
                  : mcpStatus?.isConfigured
                  ? "sidebar__mcp-pulse--ready"
                  : ""
              }`}
            />
            <span className="sidebar__mcp-label">
              {mcpStatus?.isLiveProcessing
                ? `${mcpStatus.detectedClient || "AI"} · ${lang === "tr" ? "çalışıyor" : "active"}`
                : mcpStatus?.isConfigured
                ? `${mcpStatus.detectedClient || "AI"} · ${t("ready")}`
                : lang === "tr" ? "MCP bağlı değil" : "MCP not connected"}
            </span>
          </div>
          {mcpStatus?.logs && mcpStatus.logs.length > 0 && (
            <span className="sidebar__mcp-log-badge">
              {mcpStatus.logs.length}
            </span>
          )}
        </div>
      </aside>

      <main className="dashboard__main">
        <div className="dashboard__container">
          <div className="dashboard__header">
            <div className="dashboard__header-left">
              <div className="dashboard__title-wrap">
                <h1 title={active}>{active}</h1>
                {mcpStatus?.aiProjects?.includes(active) && (
                  <span className="dashboard__ai-badge" title="Bu proje AI tarafından oluşturuldu">
                    <AiSparkleIcon size={12} />
                  </span>
                )}
                <span className="dashboard__entry-badge">
                  {activeTab === "notes" ? `${entries.length} ${t("entriesCount")}` : `${todos.length} ${t("todosTab").toLowerCase()}`}
                </span>
              </div>

              {/* View Mode Toggle: Notes vs Todos */}
              <div className="dashboard__view-tabs">
                <button
                  type="button"
                  className={`dashboard__view-tab ${activeTab === "notes" ? "dashboard__view-tab--active" : ""}`}
                  onClick={() => setActiveTab("notes")}
                  title={t("notesTab")}
                >
                  {t("notesTab")}
                </button>
                <button
                  type="button"
                  className={`dashboard__view-tab ${activeTab === "todos" ? "dashboard__view-tab--active" : ""}`}
                  onClick={() => setActiveTab("todos")}
                  title={t("todosTab")}
                >
                  {t("todosTab")}
                  {todos.filter((t) => !t.done).length > 0 && (
                    <span className="dashboard__view-tab-count">
                      {todos.filter((t) => !t.done).length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            <div className="dashboard__header-actions">
              {activeTab === "notes" && (
                <button
                  type="button"
                  className="btn btn--primary dashboard__add-btn"
                  onClick={() => {
                    setIsCreatingNote(true);
                    setNewNoteContent("");
                    setNewNoteImages([]);
                  }}
                  title={`${t("addNoteBtn")} (Ctrl+Shift+N)`}
                >
                  {t("addNoteBtn")}
                </button>
              )}

              {/* AI Context Copy Icon Button */}
              <button
                type="button"
                className={`dashboard__icon-btn ${aiContextStatus ? "dashboard__icon-btn--success" : ""}`}
                onClick={handleCopyAiContext}
                title={aiContextStatus ? t("copiedAiContext") : t("copyAiContext")}
                aria-label={t("copyAiContext")}
              >
                {aiContextStatus ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>

              {/* Open Folder Icon Button */}
              <button
                type="button"
                className="dashboard__icon-btn"
                onClick={(e) => handleOpenFolder(active, e)}
                title={t("openFolder")}
                aria-label={t("openFolder")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>

              {/* Delete Project Icon Button */}
              {active !== "inbox" && (
                <button
                  type="button"
                  className="dashboard__icon-btn dashboard__icon-btn--danger"
                  onClick={() => handleDeleteProject(active)}
                  title={t("deleteProject")}
                  aria-label={t("deleteProject")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {activeTab === "todos" ? (
            /* TODO / Tasks View */
            <div className="todos-view">
              <form className="todos-view__add-form" onSubmit={handleAddTodo}>
                <input
                  type="text"
                  className="todos-view__input"
                  placeholder={t("todoPlaceholder")}
                  value={newTodoText}
                  onChange={(e) => setNewTodoText(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn--primary todos-view__submit-btn">
                  {t("addTodoBtn")}
                </button>
              </form>

              {todosLoading ? (
                <div className="empty-state">{t("loading")}</div>
              ) : todos.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-state__title">{t("noTodosTitle")}</p>
                  <p className="empty-state__sub">
                    {t("noTodosSub")}
                  </p>
                </div>
              ) : (
                <div className="todos-view__lists">
                  {/* Active Todos */}
                  {todos.filter((tItem) => !tItem.done).length > 0 && (
                    <div className="todos-view__section">
                      <div className="todos-view__section-title">
                        {t("pendingTodos")} ({todos.filter((tItem) => !tItem.done).length})
                      </div>
                      <div className="todos-view__items">
                        {todos
                          .filter((tItem) => !tItem.done)
                          .map((todo) => (
                            <div key={todo.id} className="todo-item">
                              <label className="todo-item__check-label">
                                <input
                                  type="checkbox"
                                  className="todo-item__checkbox"
                                  checked={false}
                                  onChange={() => handleToggleTodo(todo.id, true)}
                                />
                                <span className="todo-item__custom-box" />
                                <span className="todo-item__text">{todo.text}</span>
                                {todo.isAi && (
                                  <span className="todo-item__ai-chip" title="Bu görev AI tarafından oluşturuldu">
                                    <AiSparkleIcon size={11} />
                                  </span>
                                )}
                              </label>
                              <button
                                type="button"
                                className="todo-item__delete-btn"
                                title={t("deleteTodo")}
                                onClick={() => handleDeleteTodo(todo.id)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Completed Todos */}
                  {todos.filter((tItem) => tItem.done).length > 0 && (
                    <div className="todos-view__section todos-view__section--completed">
                      <div className="todos-view__section-title">
                        {t("completedTodos")} ({todos.filter((tItem) => tItem.done).length})
                      </div>
                      <div className="todos-view__items">
                        {todos
                          .filter((tItem) => tItem.done)
                          .map((todo) => (
                            <div key={todo.id} className="todo-item todo-item--done">
                              <label className="todo-item__check-label">
                                <input
                                  type="checkbox"
                                  className="todo-item__checkbox"
                                  checked={true}
                                  onChange={() => handleToggleTodo(todo.id, false)}
                                />
                                <span className="todo-item__custom-box" />
                                <span className="todo-item__text">{todo.text}</span>
                                {todo.isAi && (
                                  <span className="todo-item__ai-chip" title="Bu görev AI tarafından oluşturuldu">
                                    <AiSparkleIcon size={11} />
                                  </span>
                                )}
                              </label>
                              <button
                                type="button"
                                className="todo-item__delete-btn"
                                title={t("deleteTodo")}
                                onClick={() => handleDeleteTodo(todo.id)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* Notes Feed View */
            <>
              {/* Search Bar */}
              <div className="dashboard__search-bar">
                <div className="dashboard__search-input-wrap">
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="dashboard__search-input"
                    placeholder={
                      searchScope === "current"
                        ? t("searchPlaceholderCurrent")(active)
                        : t("searchPlaceholderAll")
                    }
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="dashboard__search-clear"
                      onClick={() => setSearchQuery("")}
                      title="Aramayı Temizle (Esc)"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="dashboard__search-scope-toggle">
                  <button
                    type="button"
                    className={
                      "dashboard__scope-btn" +
                      (searchScope === "current" ? " dashboard__scope-btn--active" : "")
                    }
                    onClick={() => setSearchScope("current")}
                  >
                    {t("searchScopeCurrent")}
                  </button>
                  <button
                    type="button"
                    className={
                      "dashboard__scope-btn" +
                      (searchScope === "all" ? " dashboard__scope-btn--active" : "")
                    }
                    onClick={() => setSearchScope("all")}
                  >
                    {t("searchScopeAll")}
                  </button>
                </div>
              </div>

              {isCreatingNote && (
                <form className="dashboard__quick-note" onSubmit={handleCreateDirectNote}>
                  <textarea
                    placeholder={t("quickNotePlaceholder")}
                    value={newNoteContent}
                    onChange={(e) => setNewNoteContent(e.target.value)}
                    autoFocus
                  />

                  {newNoteImages.length > 0 && (
                    <div className="dashboard__quick-note-images">
                      {newNoteImages.map((img, idx) => (
                        <div key={idx} className="dashboard__quick-note-image-chip">
                          <img src={img} alt={`Görsel ${idx + 1}`} />
                          <button
                            type="button"
                            className="dashboard__quick-note-image-remove"
                            title={lang === "tr" ? "Görseli Kaldır" : "Remove Image"}
                            onClick={() => setNewNoteImages((prev) => prev.filter((_, i) => i !== idx))}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="dashboard__quick-note-footer">
                    <span className="dashboard__quick-note-hint">
                      {lang === "tr"
                        ? "💡 Görselleri doğrudan Ctrl+V ile yapıştırabilirsiniz"
                        : "💡 You can paste images directly with Ctrl+V"}
                    </span>
                    <div className="dashboard__quick-note-actions">
                      <button type="submit" className="btn btn--primary">
                        {t("save")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => {
                          setIsCreatingNote(false);
                          setNewNoteContent("");
                          setNewNoteImages([]);
                        }}
                      >
                        {t("cancel")}
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {/* Search Results Display or Regular Entries List */}
              {searchQuery.trim() ? (
                <div className="search-results">
                  <div className="search-results__header">
                    <span>
                      {t("searchResultsFor")(searchQuery, searchResults.length)}
                    </span>
                    {isSearching && <span className="search-results__loading">{t("searching")}</span>}
                  </div>

                  {searchResults.length === 0 && !isSearching ? (
                    <div className="empty-state">
                      <p className="empty-state__title">{t("noMatchingEntries")}</p>
                      <p className="empty-state__sub">{t("noMatchingEntriesSub")}</p>
                    </div>
                  ) : (
                    <div className="entries-list">
                      {searchResults.map((item, idx) => (
                        <div
                          key={idx}
                          className="entry"
                          onClick={() => handleOpenEntryModal(item.entry)}
                        >
                          {item.entry.imagePaths && item.entry.imagePaths.length > 0 && (
                            <img
                              className="entry__thumb"
                              src={convertFileSrc(item.entry.imagePaths[0])}
                              alt=""
                              title={t("clickToZoom")}
                              onClick={(e) => {
                                e.stopPropagation();
                                setLightboxImage(item.entry.imagePaths[0]);
                              }}
                            />
                          )}
                          <div className="entry__body">
                            <div className="entry__tags">
                              {searchScope === "all" && (
                                <span className="entry__project-tag">{item.project}</span>
                              )}
                              {item.entry.isAi && (
                                <span className="entry__ai-tag" title={lang === "tr" ? "AI tarafından oluşturuldu" : "Created by AI"}>
                                  <AiSparkleIcon size={11} />
                                </span>
                              )}
                            </div>
                            <div className="entry__preview">{item.matchedSnippet}</div>
                            <div className="entry__meta">{formatTimestamp(item.entry.modified)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : loading ? (
                <div className="empty-state">{t("loading")}</div>
              ) : entries.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-state__title">{t("noEntriesTitle")}</p>
                  <p className="empty-state__sub">
                    {t("noEntriesSub")}
                  </p>
                </div>
              ) : (
                <div
                  className={`devlog-stream ${pointerDragIndex !== null ? "devlog-stream--dragging-active entries-list--dragging-active" : ""}`}
                >
                  {entries.map((entry, idx) => {
                    const isDragging = pointerDragIndex === idx;
                    const isDropTarget = pointerDropIndex === idx && pointerDragIndex !== null && pointerDragIndex !== idx;
                    const dropDirection = isDropTarget
                      ? (pointerDropIndex! > pointerDragIndex! ? "below" : "above")
                      : null;
                    const isInlineEditing = inlineEditingPath === entry.path;
                    const fullContent = noteContents[entry.path] ?? entry.preview ?? "";
                    const isLong = fullContent.length > 380 || fullContent.split("\n").filter((l) => l.trim().length > 0).length > 7;
                    const isExpanded = Boolean(expandedNotes[entry.path]);
                    const shouldClamp = isLong && !isExpanded && !isInlineEditing;

                    return (
                      <article
                        key={entry.id || entry.path}
                        data-index={idx}
                        className={`devlog-item ${entry.pinned ? "devlog-item--pinned" : ""} ${isDragging ? "devlog-item--dragging" : ""} ${dropDirection ? `devlog-item--drop-target-${dropDirection}` : ""}`}
                        onPointerDown={(e) => handleStartCardDrag(e, idx)}
                      >
                        {/* DevLog Item Header */}
                        <header className="devlog-item__header">
                          <div className="devlog-item__meta">
                            <div
                              className="devlog-item__drag-handle"
                              title={t("reorderTitle")}
                            >
                              ⠿
                            </div>

                            {entry.pinned && (
                              <div className="devlog-item__pinned-badge" title={lang === "tr" ? "Başa sabitlendi" : "Pinned to top"}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M16 3H8v2h1v5l-2 3v2h5v6l1 1 1-1v-6h5v-2l-2-3V5h1V3z" />
                                </svg>
                                <span>{t("pinnedBadge")}</span>
                              </div>
                            )}

                            {entry.isAi && (
                              <span className="entry__ai-tag" title={lang === "tr" ? "AI tarafından oluşturuldu" : "Created by AI"}>
                                <AiSparkleIcon size={11} />
                              </span>
                            )}

                            <time className="devlog-item__time">
                              {formatTimestamp(entry.modified)}
                            </time>
                          </div>

                          {/* Quick Actions Toolbar */}
                          <div className="devlog-item__actions">
                            <button
                              type="button"
                              className="devlog-action-btn"
                              title={lang === "tr" ? "Metni Kopyala" : "Copy Text"}
                              onClick={(e) => handleCopyEntryText(entry, e)}
                            >
                              {copiedPath === entry.path ? t("copied") : t("copy")}
                            </button>

                            <button
                              type="button"
                              className={`devlog-action-btn ${entry.pinned ? "devlog-action-btn--pinned" : ""}`}
                              title={entry.pinned ? (lang === "tr" ? "Sabitlemeyi Kaldır" : "Unpin") : (lang === "tr" ? "Başa Sabitle" : "Pin to Top")}
                              onClick={(e) => handleTogglePin(entry, e)}
                            >
                              {entry.pinned ? t("unpin") : t("pin")}
                            </button>

                            <button
                              type="button"
                              className="devlog-action-btn"
                              title={isInlineEditing ? (lang === "tr" ? "Düzenlemeyi Kapat" : "Close Editor") : (lang === "tr" ? "Düzenle" : "Edit")}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isInlineEditing) {
                                  setInlineEditingPath(null);
                                } else {
                                  startInlineEdit(entry);
                                }
                              }}
                            >
                              {isInlineEditing ? t("closeEdit") : t("edit")}
                            </button>

                            <button
                              type="button"
                              className="devlog-action-btn devlog-action-btn--delete"
                              title={t("delete")}
                              onClick={(e) => handleDeleteEntry(entry, e)}
                            >
                              🗑️
                            </button>
                          </div>
                        </header>

                        {/* DevLog Item Body */}
                        <div className="devlog-item__body">
                          {/* Attached Screenshots Reel */}
                          {entry.imagePaths && entry.imagePaths.length > 0 && (
                            <div className="devlog-item__gallery">
                              {entry.imagePaths.map((imgPath, imgIdx) => (
                                <div key={imgIdx} className="devlog-item__gallery-card">
                                  <img
                                    src={convertFileSrc(imgPath)}
                                    alt=""
                                    className="devlog-item__image"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setLightboxImage(imgPath);
                                    }}
                                    title={t("clickToZoom")}
                                  />
                                  {isInlineEditing && (
                                    <button
                                      type="button"
                                      className="devlog-item__image-delete"
                                      title={t("removeImage")}
                                      onClick={(e) => handleDeleteImageInline(entry, imgPath, e)}
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Content: Inline Editor or Direct Readable Text */}
                          {isInlineEditing ? (
                            <div className="devlog-item__editor-wrap" onClick={(e) => e.stopPropagation()}>
                              <textarea
                                className="devlog-item__editor"
                                value={inlineDraftText}
                                onChange={(e) => setInlineDraftText(e.target.value)}
                                placeholder={t("inlineEditorPlaceholder")}
                                autoFocus
                                rows={Math.max(4, Math.min(18, (inlineDraftText.split("\n").length + 2)))}
                                onKeyDown={(e) => {
                                  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                                    e.preventDefault();
                                    handleSaveInlineNote(entry);
                                  } else if (e.key === "Escape") {
                                    setInlineEditingPath(null);
                                  }
                                }}
                              />
                              <div className="devlog-item__editor-actions">
                                <div className="devlog-item__editor-left">
                                  <button
                                    type="button"
                                    className="btn btn--primary"
                                    onClick={() => handleSaveInlineNote(entry)}
                                  >
                                    💾 {t("save")} (Ctrl+S)
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--secondary"
                                    onClick={() => setInlineEditingPath(null)}
                                  >
                                    {t("cancel")} (Esc)
                                  </button>
                                  {inlineStatus && (
                                    <span className="devlog-item__status">{inlineStatus}</span>
                                  )}
                                </div>
                                <span className="devlog-item__editor-hint">
                                  {t("inlineEditorHint")}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div
                              className={`devlog-item__content ${shouldClamp ? "devlog-item__content--clamped" : ""}`}
                              onDoubleClick={() => startInlineEdit(entry)}
                              title={t("doubleClickToEdit")}
                            >
                              {renderDevLogContent(fullContent)}
                              {!fullContent.trim() && (!entry.imagePaths || entry.imagePaths.length === 0) && (
                                <span className="devlog-empty">{t("emptyEntry")}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Dashed DevLog Divider or Seam Boundary with Button */}
                        {shouldClamp ? (
                          <div className="devlog-item__divider devlog-item__divider--with-btn">
                            <button
                              type="button"
                              className="devlog-expand-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleNoteExpand(entry.path);
                              }}
                            >
                              <span>{t("readMore")}</span>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </button>
                          </div>
                        ) : isLong && isExpanded && !isInlineEditing ? (
                          <div className="devlog-item__divider devlog-item__divider--with-btn">
                            <button
                              type="button"
                              className="devlog-collapse-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleNoteExpand(entry.path);
                              }}
                            >
                              <span>{t("showLess")}</span>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="18 15 12 9 6 15" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <div className="devlog-item__divider" />
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Note / Image / Mixed Editor & Viewer Modal */}
      {editingEntry && (
        <div className="modal-overlay" onClick={() => setEditingEntry(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card__header">
              <div className="modal-card__title-box">
                <span className="modal-card__title">{editingEntry.name}</span>
                {editingEntry.isAi && (
                  <span className="entry__ai-tag" title="Bu not AI tarafından oluşturuldu / yönetildi">
                    <AiSparkleIcon size={11} />
                  </span>
                )}
                <span className="modal-card__date">
                  {formatTimestamp(editingEntry.modified)}
                </span>
              </div>
              <button
                type="button"
                className="modal-card__close-btn"
                onClick={() => setEditingEntry(null)}
                title={lang === "tr" ? "Kapat (Esc)" : "Close (Esc)"}
              >
                ✕
              </button>
            </div>

            <div className="modal-card__body">
              {/* Image Gallery inside Modal */}
              {editingEntry.imagePaths && editingEntry.imagePaths.length > 0 && (
                <div className="modal-card__gallery">
                  {editingEntry.imagePaths.map((imgPath, i) => (
                    <div key={i} className="modal-card__gallery-item">
                      <img
                        src={convertFileSrc(imgPath)}
                        alt={`Görsel ${i + 1}`}
                        className="modal-card__gallery-image"
                        onClick={() => setLightboxImage(imgPath)}
                        title={t("clickToZoom")}
                      />
                      <button
                        type="button"
                        className="modal-card__gallery-delete-btn"
                        title={t("removeImage")}
                        onClick={(e) => handleDeleteImageFromModal(imgPath, e)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Paste helper hint in modal */}
              <div className="modal-card__paste-hint">
                {lang === "tr" ? (
                  <>Yeni ekran görüntüsü eklemek için doğrudan <strong>Ctrl+V</strong> ile yapıştırabilirsiniz.</>
                ) : (
                  <>Paste new screenshots directly with <strong>Ctrl+V</strong>.</>
                )}
              </div>

              {(editingEntry.kind === "note" || editingEntry.kind === "mixed") && (
                <div className="modal-card__editor-wrap">
                  {editorLoading ? (
                    <div className="modal-card__loading">{t("loading")}</div>
                  ) : (
                    <textarea
                      className="modal-card__editor"
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      placeholder={lang === "tr" ? "Not içeriğini buraya yazın..." : "Write note content here..."}
                      autoFocus={editingEntry.imagePaths.length === 0}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="modal-card__footer">
              <div className="modal-card__footer-left">
                {(editingEntry.kind === "note" || editingEntry.kind === "mixed") && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleSaveEditedNote}
                  >
                    💾 {t("save")} (Ctrl+S)
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => openEntry(editingEntry.path)}
                  title={lang === "tr" ? "İşletim sisteminin varsayılan uygulamasında aç" : "Open in system default app"}
                >
                  🔗 {lang === "tr" ? "Dış Programda Aç" : "Open in System App"}
                </button>
                <button
                  type="button"
                  className="btn btn--danger-subtle"
                  onClick={() => handleDeleteEntry(editingEntry)}
                >
                  🗑 {t("delete")}
                </button>
                {editorStatus && (
                  <span className="modal-card__status">{editorStatus}</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setEditingEntry(null)}
              >
                {lang === "tr" ? "Kapat" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Image Lightbox Modal */}
      {lightboxImage && (
        <div
          className="lightbox-overlay"
          onClick={() => setLightboxImage(null)}
          title={lang === "tr" ? "Kapatmak için tıklayın veya Esc tuşuna basın" : "Click to close or press Esc"}
        >
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img
              src={convertFileSrc(lightboxImage)}
              alt="Tam boyut ekran görüntüsü"
              className="lightbox-image"
            />
            <button
              type="button"
              className="lightbox-close-btn"
              onClick={() => setLightboxImage(null)}
              title={lang === "tr" ? "Kapat (Esc)" : "Close (Esc)"}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* MCP Log & Status Modal */}
      {isMcpModalOpen && (
        <div className="modal-overlay" onClick={() => setIsMcpModalOpen(false)}>
          <div className="modal-card modal-card--mcp" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card__header mcp-modal__header">
              <div className="modal-card__title-box mcp-modal__title-box">
                <span className="modal-card__title">{t("mcpTitle")}</span>
                <span className="mcp-modal__subtitle">
                  {t("mcpSubtitle")}
                </span>
              </div>
              <button
                type="button"
                className="modal-card__close-btn"
                onClick={() => setIsMcpModalOpen(false)}
                title={lang === "tr" ? "Kapat (Esc)" : "Close (Esc)"}
              >
                ✕
              </button>
            </div>

            <div className="modal-card__content mcp-modal__body">
              {/* Summary stats */}
              <div className="mcp-modal__stats">
                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">{t("mcpClientStatus")}</span>
                  <div className="mcp-modal__stat-value">
                    <span
                      className={`sidebar__mcp-pulse ${
                        mcpStatus?.isLiveProcessing
                          ? "sidebar__mcp-pulse--live"
                          : mcpStatus?.isConfigured
                          ? "sidebar__mcp-pulse--ready"
                          : ""
                      }`}
                    />
                    <span>
                      {mcpStatus?.isLiveProcessing
                        ? `${mcpStatus.detectedClient || "AI"} (${t("mcpProcessing")})`
                        : mcpStatus?.isConfigured
                        ? `${mcpStatus.detectedClient || "AI"} (${t("mcpReadyIdle")})`
                        : t("mcpNotConfigured")}
                    </span>
                  </div>
                  {mcpStatus?.lastActiveTime ? (
                    <span className="mcp-modal__stat-sub">
                      {t("mcpLastActive")(formatTimestamp(mcpStatus.lastActiveTime))}
                    </span>
                  ) : mcpStatus?.isConfigured ? (
                    <span className="mcp-modal__stat-sub">
                      {t("mcpTunnelOpen")}
                    </span>
                  ) : null}
                </div>

                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">{t("mcpFirewall")}</span>
                  <span className="mcp-modal__stat-value mcp-modal__stat-value--scope">
                    {t("mcpProjectsAllowed")(
                      projects.filter((p) => isProjectMcpAllowed(p)).length,
                      projects.length
                    )}
                  </span>
                </div>

                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">{t("mcpTotalOperations")}</span>
                  <span className="mcp-modal__stat-value">
                    {t("mcpLogEntriesCount")(mcpStatus?.logs.length || 0)}
                  </span>
                </div>
              </div>

              {/* One-click Copyable MCP Setup Configuration */}
              <div className="mcp-modal__setup-box">
                <div className="mcp-modal__setup-header">
                  <div className="mcp-modal__setup-title-group">
                    <span className="mcp-modal__setup-title">{t("mcpConnectionSetup")}</span>
                    <span className="mcp-modal__setup-sub">
                      {t("mcpConnectionSetupDesc")}
                    </span>
                  </div>
                  <div className="mcp-modal__client-tabs">
                    <button
                      type="button"
                      className={`mcp-modal__client-tab ${mcpClientTab === "json" ? "mcp-modal__client-tab--active" : ""}`}
                      onClick={() => setMcpClientTab("json")}
                    >
                      {t("mcpStandardJson")}
                    </button>
                    <button
                      type="button"
                      className={`mcp-modal__client-tab ${mcpClientTab === "codex" ? "mcp-modal__client-tab--active" : ""}`}
                      onClick={() => setMcpClientTab("codex")}
                    >
                      {t("mcpCodexToml")}
                    </button>
                  </div>
                </div>

                <div className="mcp-modal__setup-targets">
                  {mcpClientTab === "json" ? (
                    <>
                      <div className="mcp-modal__setup-target">
                        <span>Antigravity</span>
                        <code>~/.gemini/config/mcp_config.json</code>
                      </div>
                      <div className="mcp-modal__setup-target">
                        <span>Claude Desktop</span>
                        <code>%APPDATA%\Claude\claude_desktop_config.json</code>
                      </div>
                      <div className="mcp-modal__setup-target">
                        <span>Cursor</span>
                        <code>~/.cursor/mcp.json</code>
                      </div>
                    </>
                  ) : (
                    <div className="mcp-modal__setup-target">
                      <span>Codex CLI</span>
                      <code>~/.codex/config.toml</code>
                    </div>
                  )}
                </div>

                <div className="mcp-modal__code-wrap">
                  <div className="mcp-modal__code-toolbar">
                    <span className="mcp-modal__code-lang">
                      {mcpClientTab === "json" ? "json" : "toml"}
                    </span>
                    <button
                      type="button"
                      className={`mcp-modal__code-copy-btn ${mcpConfigCopied ? "mcp-modal__code-copy-btn--success" : ""}`}
                      onClick={() => handleCopyMcpConfig(getMcpConfigSnippet(mcpClientTab, mcpStatus?.serverScriptPath))}
                    >
                      {mcpConfigCopied ? t("copied") : t("copy")}
                    </button>
                  </div>
                  <pre className="mcp-modal__code-block">
                    {getMcpConfigSnippet(mcpClientTab, mcpStatus?.serverScriptPath)}
                  </pre>
                </div>
              </div>

              {/* Project AI Access Control Firewall */}
              <div className="mcp-modal__firewall">
                <div className="mcp-modal__firewall-header">
                  <span className="mcp-modal__firewall-title">{t("mcpProjectPermissions")}</span>
                  <span className="mcp-modal__firewall-sub">
                    {t("mcpProjectPermissionsDesc")}
                  </span>
                </div>
                <div className="mcp-modal__firewall-grid">
                  {projects.map((proj) => {
                    const isAllowed = isProjectMcpAllowed(proj);
                    return (
                      <div key={proj} className="mcp-modal__firewall-item" title={proj}>
                        <div className="mcp-modal__firewall-name-wrap">
                          <span
                            className={`mcp-modal__firewall-dot ${
                              isAllowed ? "mcp-modal__firewall-dot--on" : "mcp-modal__firewall-dot--off"
                            }`}
                          />
                          <span className="mcp-modal__firewall-name">{proj}</span>
                        </div>
                        <button
                          type="button"
                          className={`mcp-modal__firewall-btn ${
                            isAllowed ? "mcp-modal__firewall-btn--allowed" : "mcp-modal__firewall-btn--blocked"
                          }`}
                          onClick={(e) => handleToggleProjectMcp(proj, e)}
                          title={isAllowed ? t("mcpRevokeAccessTitle") : t("mcpGrantAccessTitle")}
                        >
                          {isAllowed ? t("mcpAccessAllowed") : t("mcpAccessBlocked")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Scoped AI Permission Controls */}
              <div className="mcp-modal__permissions">
                <div className="mcp-modal__permissions-header">
                  <span className="mcp-modal__permissions-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    {t("mcpPermissionsScope")}
                  </span>
                  <span className="mcp-modal__permissions-sub">
                    {t("mcpPermissionsScopeDesc")}
                  </span>
                </div>

                <div className="mcp-modal__perm-list">
                  <div className="mcp-modal__perm-row">
                    <div className="mcp-modal__perm-info">
                      <span className="mcp-modal__perm-label">{t("mcpEditPermissionLabel")}</span>
                      <span className="mcp-modal__perm-desc">
                        {mcpStatus?.allowAiEdit === "all"
                          ? t("mcpEditAllDesc")
                          : mcpStatus?.allowAiEdit === "none"
                          ? t("mcpEditNoneDesc")
                          : t("mcpEditOnlyAiDesc")}
                      </span>
                    </div>
                    <div className="mcp-modal__perm-options">
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${(!mcpStatus?.allowAiEdit || mcpStatus.allowAiEdit === "only_ai") ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "only_ai")}
                        title={lang === "tr" ? "Yalnızca AI'ın oluşturduğu notları ve projeleri düzenleyebilir" : "Can only edit notes and projects created by AI"}
                      >
                        {t("mcpBtnOnlyAi")}
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiEdit === "all" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "all")}
                        title={lang === "tr" ? "Tüm notları düzenleyebilir" : "Can edit all notes"}
                      >
                        {t("mcpBtnAll")}
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiEdit === "none" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "none")}
                        title={lang === "tr" ? "Hiçbir notu düzenleyemez" : "Cannot edit any notes"}
                      >
                        {t("mcpBtnOff")}
                      </button>
                    </div>
                  </div>

                  <div className="mcp-modal__perm-row">
                    <div className="mcp-modal__perm-info">
                      <span className="mcp-modal__perm-label">{t("mcpDeletePermissionLabel")}</span>
                      <span className="mcp-modal__perm-desc">
                        {mcpStatus?.allowAiDelete === "all"
                          ? t("mcpDeleteAllDesc")
                          : mcpStatus?.allowAiDelete === "none"
                          ? t("mcpDeleteNoneDesc")
                          : t("mcpDeleteOnlyAiDesc")}
                      </span>
                    </div>
                    <div className="mcp-modal__perm-options">
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${(!mcpStatus?.allowAiDelete || mcpStatus.allowAiDelete === "only_ai") ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "only_ai")}
                        title={lang === "tr" ? "Yalnızca AI'ın oluşturduğu notları ve projeleri silebilir" : "Can only delete projects and notes created by AI"}
                      >
                        {t("mcpBtnOnlyAi")}
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiDelete === "all" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "all")}
                        title={lang === "tr" ? "Tüm not ve görevleri silebilir" : "Can delete all notes and tasks"}
                      >
                        {t("mcpBtnAll")}
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiDelete === "none" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "none")}
                        title={lang === "tr" ? "Hiçbir şeyi silemez" : "Cannot delete anything"}
                      >
                        {t("mcpBtnOff")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Log actions */}
              <div className="mcp-modal__log-header">
                <span className="mcp-modal__log-title">{t("mcpRecentLogs")}</span>
                {mcpStatus?.logs && mcpStatus.logs.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--secondary mcp-modal__clear-btn"
                    onClick={handleClearMcpLogs}
                  >
                    {t("mcpClearLogs")}
                  </button>
                )}
              </div>

              {/* Log entries */}
              {!mcpStatus?.logs || mcpStatus.logs.length === 0 ? (
                <div className="mcp-modal__empty">
                  {t("mcpNoLogsYet")}
                </div>
              ) : (
                <div className="mcp-modal__log-list">
                  {mcpStatus.logs.map((log) => (
                    <div key={log.id} className="mcp-log-item">
                      <div className="mcp-log-item__header">
                        <span className="mcp-log-item__tool">{log.tool}</span>
                        <span className="mcp-log-item__project">{log.project}</span>
                        <span className="mcp-log-item__time">{formatTimestamp(log.timestamp)}</span>
                      </div>
                      <div className="mcp-log-item__details">{log.details}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-card__footer">
              <div className="modal-card__footer-left">
                <span className="mcp-modal__footer-hint">
                  {t("mcpFooterHint")}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setIsMcpModalOpen(false)}
              >
                {lang === "tr" ? "Kapat" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-card modal-card--settings" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card__header">
              <div className="modal-card__title-box">
                <span className="modal-card__title">⚙️ {t("settingsTitle")}</span>
              </div>
              <button
                type="button"
                className="modal-card__close-btn"
                onClick={() => setIsSettingsOpen(false)}
                title={lang === "tr" ? "Kapat (Esc)" : "Close (Esc)"}
              >
                ✕
              </button>
            </div>

            {/* Settings Tabs */}
            <div className="settings-tabs">
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "appearance" ? "settings-tab-btn--active" : ""}`}
                onClick={() => setSettingsTab("appearance")}
              >
                🎨 {t("appearance")}
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "shortcuts" ? "settings-tab-btn--active" : ""}`}
                onClick={() => setSettingsTab("shortcuts")}
              >
                ⌨️ {t("shortcuts")}
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "about" ? "settings-tab-btn--active" : ""}`}
                onClick={() => setSettingsTab("about")}
              >
                ℹ️ {t("about")}
              </button>
            </div>

            {/* Settings Body */}
            <div className="settings-body">
              {settingsTab === "appearance" && (
                <>
                  {/* Language Selection */}
                  <div className="settings-group">
                    <span className="settings-group__title">{t("languageLabel")}</span>
                    <div className="settings-grid">
                      <div
                        className={`settings-card ${lang === "tr" ? "settings-card--active" : ""}`}
                        onClick={() => handleLanguageChange("tr")}
                      >
                        <div className="settings-card__radio">
                          <div className="settings-card__radio-inner" />
                        </div>
                        <div className="settings-card__info">
                          <span className="settings-card__title">🇹🇷 Türkçe</span>
                          <span className="settings-card__desc">Varsayılan dil</span>
                        </div>
                      </div>

                      <div
                        className={`settings-card ${lang === "en" ? "settings-card--active" : ""}`}
                        onClick={() => handleLanguageChange("en")}
                      >
                        <div className="settings-card__radio">
                          <div className="settings-card__radio-inner" />
                        </div>
                        <div className="settings-card__info">
                          <span className="settings-card__title">🇬🇧 English</span>
                          <span className="settings-card__desc">English localization</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Theme Selection */}
                  <div className="settings-group">
                    <span className="settings-group__title">{t("themeLabel")}</span>
                    <div className="settings-grid">
                      {/* Amber */}
                      <div
                        className={`settings-card ${theme === "amber" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("amber")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #1c1c20 50%, #e5a95d 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themeAmber")}</span>
                          <span className="settings-card__desc">{t("themeAmberDesc")}</span>
                        </div>
                      </div>

                      {/* OLED */}
                      <div
                        className={`settings-card ${theme === "oled" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("oled")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #000000 50%, #f59e0b 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themeOled")}</span>
                          <span className="settings-card__desc">{t("themeOledDesc")}</span>
                        </div>
                      </div>

                      {/* Emerald */}
                      <div
                        className={`settings-card ${theme === "emerald" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("emerald")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #0b1512 50%, #10b981 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themeEmerald")}</span>
                          <span className="settings-card__desc">{t("themeEmeraldDesc")}</span>
                        </div>
                      </div>

                      {/* Slate */}
                      <div
                        className={`settings-card ${theme === "slate" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("slate")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #0f141c 50%, #60a5fa 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themeSlate")}</span>
                          <span className="settings-card__desc">{t("themeSlateDesc")}</span>
                        </div>
                      </div>

                      {/* Paper Light */}
                      <div
                        className={`settings-card ${theme === "paper" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("paper")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #f8f6f0 50%, #d97706 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themePaper")}</span>
                          <span className="settings-card__desc">{t("themePaperDesc")}</span>
                        </div>
                      </div>

                      {/* Nordic Frost */}
                      <div
                        className={`settings-card ${theme === "nordic" ? "settings-card--active" : ""}`}
                        onClick={() => handleThemeChange("nordic")}
                      >
                        <div
                          className="settings-theme-swatch"
                          style={{ background: "linear-gradient(135deg, #f4f6fa 50%, #2563eb 50%)" }}
                        />
                        <div className="settings-card__info">
                          <span className="settings-card__title">{t("themeNordic")}</span>
                          <span className="settings-card__desc">{t("themeNordicDesc")}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {settingsTab === "shortcuts" && (
                <div className="shortcuts-table">
                  {/* Interactive Quick Capture Shortcut Row */}
                  <div className="shortcuts-row shortcuts-row--capture">
                    <span className="shortcuts-row__desc">{t("shortcutQuickCapture")}</span>
                    <div className="shortcuts-row__keys">
                      {captureShortcut.split("+").map((keyPart, i) => (
                        <kbd key={i} className="shortcut-kbd">{keyPart.trim()}</kbd>
                      ))}
                      <button
                        type="button"
                        className="shortcuts-row__edit-btn"
                        onClick={() => {
                          setIsEditingShortcut(!isEditingShortcut);
                          setShortcutDraft(captureShortcut);
                          setShortcutError("");
                        }}
                        title={t("shortcutEditBtn")}
                      >
                        ✏️ {t("shortcutEditBtn")}
                      </button>
                    </div>
                  </div>

                  {/* Editing Panel for Quick Capture */}
                  {isEditingShortcut && (
                    <div className="shortcut-edit-panel">
                      <div className="shortcut-presets">
                        <span className="shortcut-edit-hint">
                          {lang === "tr" ? "Hızlı Seçim:" : "Presets:"}
                        </span>
                        {["Ctrl+Shift+N", "Alt+Space", "Ctrl+Alt+N", "Ctrl+Shift+Space"].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={`shortcut-preset-btn ${shortcutDraft === preset ? "shortcut-preset-btn--active" : ""}`}
                            onClick={() => {
                              setShortcutDraft(preset);
                              handleSaveCaptureShortcut(preset);
                            }}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>

                      <div className="shortcut-input-row">
                        <input
                          type="text"
                          className="shortcut-text-input"
                          value={shortcutDraft}
                          onChange={(e) => setShortcutDraft(e.target.value)}
                          placeholder={t("shortcutPlaceholder")}
                        />
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => handleSaveCaptureShortcut()}
                        >
                          {t("shortcutSaveBtn")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          onClick={() => {
                            setIsEditingShortcut(false);
                            setShortcutError("");
                          }}
                        >
                          {t("cancel")}
                        </button>
                      </div>

                      <div className="shortcut-edit-footer">
                        <span className="shortcut-edit-hint">{t("shortcutHint")}</span>
                        {captureShortcut !== "Ctrl+Shift+N" && (
                          <button
                            type="button"
                            className="shortcuts-row__edit-btn"
                            onClick={handleResetCaptureShortcut}
                          >
                            ↺ {t("shortcutResetBtn")}
                          </button>
                        )}
                      </div>

                      {shortcutError && (
                        <span className="shortcut-feedback--error">{shortcutError}</span>
                      )}
                      {shortcutStatus && (
                        <span className="shortcut-feedback--success">{shortcutStatus}</span>
                      )}
                    </div>
                  )}

                  <div className="shortcuts-row">
                    <span className="shortcuts-row__desc">{t("shortcutSearch")}</span>
                    <div className="shortcuts-row__keys">
                      <kbd className="shortcut-kbd">Ctrl</kbd>
                      <kbd className="shortcut-kbd">F</kbd>
                    </div>
                  </div>
                  <div className="shortcuts-row">
                    <span className="shortcuts-row__desc">{t("shortcutSave")}</span>
                    <div className="shortcuts-row__keys">
                      <kbd className="shortcut-kbd">Ctrl</kbd>
                      <kbd className="shortcut-kbd">S</kbd>
                    </div>
                  </div>
                  <div className="shortcuts-row">
                    <span className="shortcuts-row__desc">{t("shortcutPaste")}</span>
                    <div className="shortcuts-row__keys">
                      <kbd className="shortcut-kbd">Ctrl</kbd>
                      <kbd className="shortcut-kbd">V</kbd>
                    </div>
                  </div>
                  <div className="shortcuts-row">
                    <span className="shortcuts-row__desc">{t("shortcutEsc")}</span>
                    <div className="shortcuts-row__keys">
                      <kbd className="shortcut-kbd">Esc</kbd>
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "about" && (
                <div className="about-panel">
                  <div className="about-logo">
                    Mind<span>Pipe</span>
                  </div>
                  <p className="about-desc">{t("aboutDesc")}</p>
                  <div className="about-meta">
                    <span className="about-meta__item">{t("versionLabel")}: <strong>v0.1.0</strong></span>
                    <span className="about-meta__item">{t("licenseLabel")}: <strong>MIT</strong></span>
                  </div>
                  <button
                    type="button"
                    className="about-github-btn"
                    onClick={async () => {
                      try {
                        await openUrl("https://github.com/YusufB5/MindPipe");
                      } catch (err) {
                        console.error("Failed to open GitHub URL:", err);
                        window.open("https://github.com/YusufB5/MindPipe", "_blank");
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span>{t("viewOnGithub")}</span>
                  </button>
                </div>
              )}
            </div>

            <div className="modal-card__footer">
              <div className="modal-card__footer-left" />
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setIsSettingsOpen(false)}
              >
                {lang === "tr" ? "Kapat" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


