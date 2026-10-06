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
  type EntryMeta,
  type TodoItem,
  type SearchResultItem,
  type McpStatus,
} from "./lib/api";
import { extractImageFromPasteEvent, stripDataUrlPrefix } from "./lib/clipboardImage";

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

  // Lightbox state for full-size image viewing
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // DevLog Stream states
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [inlineEditingPath, setInlineEditingPath] = useState<string | null>(null);
  const [inlineDraftText, setInlineDraftText] = useState("");
  const [inlineStatus, setInlineStatus] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});

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
      alert(`Kopyalanamadı: ${String(err)}`);
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
      alert(`Erişim izni güncellenemedi: ${String(err)}`);
    }
  }

  async function handleClearMcpLogs() {
    try {
      await clearMcpLogs();
      await refreshMcpStatus();
    } catch (err) {
      alert(`Loglar temizlenemedi: ${String(err)}`);
    }
  }

  async function handleSetPermissionSetting(key: string, value: string) {
    try {
      await setMcpPermissionSetting(key, value);
      await refreshMcpStatus();
    } catch (err) {
      alert(`Yetki ayarı kaydedilemedi: ${String(err)}`);
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
    const confirmed = window.confirm(
      `"${projectName}" projesini ve içindeki tüm notları silmek istediğinizden emin misiniz?`
    );
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
    const confirmed = window.confirm(`"${entry.name}" kaydını silmek istiyor musunuz?`);
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

  async function handleCreateDirectNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNoteContent.trim()) return;
    try {
      await saveNote(active, newNoteContent.trim());
      setNewNoteContent("");
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
        if (isCreatingNote) {
          setIsCreatingNote(false);
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
        e.key === "s" &&
        editingEntry &&
        (editingEntry.kind === "note" || editingEntry.kind === "mixed")
      ) {
        e.preventDefault();
        handleSaveEditedNote();
      }
    }

    async function onWindowPaste(e: ClipboardEvent) {
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
  }, [editingEntry, editorContent, lightboxImage, isCreatingNote, searchQuery, active, inlineEditingPath]);

  return (
    <div className="dashboard">
      <aside className="dashboard__sidebar">
        <div className="dashboard__sidebar-title">Projeler</div>
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
                          ? "AI Erişimi: KAPALI (Engellendi)\nTıklayarak AI erişimini TEKRAR AÇABİLİRSİNİZ."
                          : mcpStatus.isLiveProcessing
                          ? `AI Aktif İşlem Yapıyor: ${mcpStatus.detectedClient || "AI"}\n(Tıkla: Bu projenin AI erişimini KAPAT)`
                          : `AI Erişimi Açık (Hazır / Beklemede - ${mcpStatus.detectedClient || "AI"})\n(Tıkla: Bu projenin AI erişimini KAPAT)`
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
                    title="Klasörü Dosya Gezgininde Aç"
                    onClick={(e) => handleOpenFolder(p, e)}
                    aria-label="Klasörde Aç"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  {p !== "inbox" && (
                    <button
                      type="button"
                      className="dashboard__project-btn dashboard__project-btn--delete"
                      title="Projeyi Sil"
                      onClick={(e) => handleDeleteProject(p, e)}
                      aria-label="Projeyi Sil"
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
            placeholder="+ yeni proje ekle"
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
          title="MindPipe MCP Durumu, İstemci Bağlantısı ve Güvenlik Duvarı (Tıkla)"
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
                ? `${mcpStatus.detectedClient || "AI"} · çalışıyor`
                : mcpStatus?.isConfigured
                ? `${mcpStatus.detectedClient || "AI"} · hazır`
                : "MCP bağlı değil"}
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
                  {activeTab === "notes" ? `${entries.length} kayıt` : `${todos.length} görev`}
                </span>
              </div>

              {/* View Mode Toggle: Notes vs Todos */}
              <div className="dashboard__view-tabs">
                <button
                  type="button"
                  className={`dashboard__view-tab ${activeTab === "notes" ? "dashboard__view-tab--active" : ""}`}
                  onClick={() => setActiveTab("notes")}
                  title="Notlar Akışı"
                >
                  Notlar
                </button>
                <button
                  type="button"
                  className={`dashboard__view-tab ${activeTab === "todos" ? "dashboard__view-tab--active" : ""}`}
                  onClick={() => setActiveTab("todos")}
                  title="Yapılacaklar Listesi"
                >
                  Görevler
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
                  onClick={() => setIsCreatingNote(true)}
                  title="Yeni Not Ekle (Hızlı yakalama: Ctrl+Shift+N)"
                >
                  + Not Ekle
                </button>
              )}

              {/* AI Context Copy Icon Button */}
              <button
                type="button"
                className={`dashboard__icon-btn ${aiContextStatus ? "dashboard__icon-btn--success" : ""}`}
                onClick={handleCopyAiContext}
                title={aiContextStatus ? "AI Bağlamı Kopyalandı ✓" : "AI Bağlamını Kopyala"}
                aria-label="AI Bağlamını Kopyala"
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
                title="Proje Klasörünü Aç"
                aria-label="Klasörde Aç"
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
                  title="Projeyi Sil"
                  aria-label="Projeyi Sil"
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
                  placeholder="Yeni görev ekle ve Enter'a bas..."
                  value={newTodoText}
                  onChange={(e) => setNewTodoText(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn--primary todos-view__submit-btn">
                  Ekle
                </button>
              </form>

              {todosLoading ? (
                <div className="empty-state">Görevler yükleniyor...</div>
              ) : todos.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-state__title">Bu projede henüz görev yok</p>
                  <p className="empty-state__sub">
                    Yukarıdaki kutucuğa yazıp <strong>Enter</strong> tuşuna basarak hızlıca görev ekleyebilirsiniz.
                  </p>
                </div>
              ) : (
                <div className="todos-view__lists">
                  {/* Active Todos */}
                  {todos.filter((t) => !t.done).length > 0 && (
                    <div className="todos-view__section">
                      <div className="todos-view__section-title">
                        Bekleyenler ({todos.filter((t) => !t.done).length})
                      </div>
                      <div className="todos-view__items">
                        {todos
                          .filter((t) => !t.done)
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
                                title="Görevi Sil"
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
                  {todos.filter((t) => t.done).length > 0 && (
                    <div className="todos-view__section todos-view__section--completed">
                      <div className="todos-view__section-title">
                        Tamamlananlar ({todos.filter((t) => t.done).length})
                      </div>
                      <div className="todos-view__items">
                        {todos
                          .filter((t) => t.done)
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
                                title="Görevi Sil"
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
                    placeholder={`Ara (Ctrl+F) — ${searchScope === "current" ? `"${active}" içinde` : "Tüm projelerde"}...`}
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
                    Bu Projede
                  </button>
                  <button
                    type="button"
                    className={
                      "dashboard__scope-btn" +
                      (searchScope === "all" ? " dashboard__scope-btn--active" : "")
                    }
                    onClick={() => setSearchScope("all")}
                  >
                    Tüm Projelerde
                  </button>
                </div>
              </div>

              {isCreatingNote && (
                <form className="dashboard__quick-note" onSubmit={handleCreateDirectNote}>
                  <textarea
                    placeholder="Yeni not içeriğini yazın..."
                    value={newNoteContent}
                    onChange={(e) => setNewNoteContent(e.target.value)}
                    autoFocus
                  />
                  <div className="dashboard__quick-note-actions">
                    <button type="submit" className="btn btn--primary">
                      Kaydet
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => {
                        setIsCreatingNote(false);
                        setNewNoteContent("");
                      }}
                    >
                      İptal
                    </button>
                  </div>
                </form>
              )}

              {/* Search Results Display or Regular Entries List */}
              {searchQuery.trim() ? (
                <div className="search-results">
                  <div className="search-results__header">
                    <span>
                      <strong>"{searchQuery}"</strong> için arama sonuçları ({searchResults.length} eşleşme)
                    </span>
                    {isSearching && <span className="search-results__loading">Aranıyor...</span>}
                  </div>

                  {searchResults.length === 0 && !isSearching ? (
                    <div className="empty-state">
                      <p className="empty-state__title">Eşleşen kayıt bulunamadı</p>
                      <p className="empty-state__sub">Farklı bir arama kelimesi deneyebilir veya kapsamı "Tüm Projelerde" olarak değiştirebilirsiniz.</p>
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
                              title="Büyütmek için tıklayın"
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
                                <span className="entry__ai-tag" title="AI tarafından oluşturuldu">
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
                <div className="empty-state">Yükleniyor...</div>
              ) : entries.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-state__title">Bu projede henüz kayıt yok</p>
                  <p className="empty-state__sub">
                    <strong>Ctrl+Shift+N</strong> kısayolu ile hızlı yakalayabilir veya yukarıdan <strong>+ Not Ekle</strong> butonunu kullanabilirsiniz.
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
                              title="Sıralamak için sürükleyin"
                            >
                              ⠿
                            </div>

                            {entry.pinned && (
                              <div className="devlog-item__pinned-badge" title="Başa sabitlendi">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M16 3H8v2h1v5l-2 3v2h5v6l1 1 1-1v-6h5v-2l-2-3V5h1V3z" />
                                </svg>
                                <span>Sabitlendi</span>
                              </div>
                            )}

                            {entry.isAi && (
                              <span className="entry__ai-tag" title="AI tarafından oluşturuldu">
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
                              title="Metni Kopyala"
                              onClick={(e) => handleCopyEntryText(entry, e)}
                            >
                              {copiedPath === entry.path ? "Kopyalandı ✓" : "Kopyala"}
                            </button>

                            <button
                              type="button"
                              className={`devlog-action-btn ${entry.pinned ? "devlog-action-btn--pinned" : ""}`}
                              title={entry.pinned ? "Sabitlemeyi Kaldır" : "Başa Sabitle"}
                              onClick={(e) => handleTogglePin(entry, e)}
                            >
                              {entry.pinned ? "Sabiti Kaldır" : "📌 Sabitle"}
                            </button>

                            <button
                              type="button"
                              className="devlog-action-btn"
                              title={isInlineEditing ? "Düzenlemeyi Kapat" : "Düzenle"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isInlineEditing) {
                                  setInlineEditingPath(null);
                                } else {
                                  startInlineEdit(entry);
                                }
                              }}
                            >
                              ✏️ {isInlineEditing ? "Kapat" : "Düzenle"}
                            </button>

                            <button
                              type="button"
                              className="devlog-action-btn devlog-action-btn--delete"
                              title="Sil"
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
                                    title="Tam boyutta büyütmek için tıklayın"
                                  />
                                  {isInlineEditing && (
                                    <button
                                      type="button"
                                      className="devlog-item__image-delete"
                                      title="Bu görseli kaldır"
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
                                placeholder="Not içeriğini düzenleyin... (Ctrl+S ile kaydet)"
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
                                    💾 Kaydet (Ctrl+S)
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--secondary"
                                    onClick={() => setInlineEditingPath(null)}
                                  >
                                    İptal (Esc)
                                  </button>
                                  {inlineStatus && (
                                    <span className="devlog-item__status">{inlineStatus}</span>
                                  )}
                                </div>
                                <span className="devlog-item__editor-hint">
                                  Ctrl+V ile görsel ekleyebilirsiniz
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div
                              className={`devlog-item__content ${shouldClamp ? "devlog-item__content--clamped" : ""}`}
                              onDoubleClick={() => startInlineEdit(entry)}
                              title="Düzenlemek için çift tıklayın"
                            >
                              {renderDevLogContent(fullContent)}
                              {!fullContent.trim() && (!entry.imagePaths || entry.imagePaths.length === 0) && (
                                <span className="devlog-empty">(Boş kayıt)</span>
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
                              <span>Devamını Gör</span>
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
                              <span>Daha az göster</span>
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
                title="Kapat (Esc)"
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
                        title="Tam boyutta açmak için tıklayın"
                      />
                      <button
                        type="button"
                        className="modal-card__gallery-delete-btn"
                        title="Bu görseli kaldır"
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
                Yeni ekran görüntüsü eklemek için doğrudan <strong>Ctrl+V</strong> ile yapıştırabilirsiniz.
              </div>

              {(editingEntry.kind === "note" || editingEntry.kind === "mixed") && (
                <div className="modal-card__editor-wrap">
                  {editorLoading ? (
                    <div className="modal-card__loading">Not yükleniyor...</div>
                  ) : (
                    <textarea
                      className="modal-card__editor"
                      value={editorContent}
                      onChange={(e) => setEditorContent(e.target.value)}
                      placeholder="Not içeriğini buraya yazın..."
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
                    💾 Kaydet (Ctrl+S)
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => openEntry(editingEntry.path)}
                  title="İşletim sisteminin varsayılan uygulamasında aç"
                >
                  🔗 Dış Programda Aç
                </button>
                <button
                  type="button"
                  className="btn btn--danger-subtle"
                  onClick={() => handleDeleteEntry(editingEntry)}
                >
                  🗑 Sil
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
                Kapat
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
          title="Kapatmak için tıklayın veya Esc tuşuna basın"
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
              title="Kapat (Esc)"
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
                <span className="modal-card__title">MindPipe MCP Denetim Masası</span>
                <span className="mcp-modal__subtitle">
                  Yapay zeka tüneli, istemci bağlantısı ve proje güvenlik duvarı
                </span>
              </div>
              <button
                type="button"
                className="modal-card__close-btn"
                onClick={() => setIsMcpModalOpen(false)}
                title="Kapat (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="modal-card__content mcp-modal__body">
              {/* Summary stats */}
              <div className="mcp-modal__stats">
                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">AI İstemcisi & Durum</span>
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
                        ? `${mcpStatus.detectedClient || "AI"} (İşlem Yapılıyor)`
                        : mcpStatus?.isConfigured
                        ? `${mcpStatus.detectedClient || "AI"} (Hazır / Beklemede)`
                        : "Yapılandırılmadı"}
                    </span>
                  </div>
                  {mcpStatus?.lastActiveTime ? (
                    <span className="mcp-modal__stat-sub">
                      Son İşlem: {formatTimestamp(mcpStatus.lastActiveTime)}
                    </span>
                  ) : mcpStatus?.isConfigured ? (
                    <span className="mcp-modal__stat-sub">
                      Tünel açık, komut bekleniyor
                    </span>
                  ) : null}
                </div>

                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">Güvenlik Duvarı</span>
                  <span className="mcp-modal__stat-value mcp-modal__stat-value--scope">
                    {projects.filter((p) => isProjectMcpAllowed(p)).length} / {projects.length} Proje Açık
                  </span>
                </div>

                <div className="mcp-modal__stat-card">
                  <span className="mcp-modal__stat-label">Toplam İşlem</span>
                  <span className="mcp-modal__stat-value">
                    {mcpStatus?.logs.length || 0} kayıt
                  </span>
                </div>
              </div>

              {/* One-click Copyable MCP Setup Configuration */}
              <div className="mcp-modal__setup-box">
                <div className="mcp-modal__setup-header">
                  <div className="mcp-modal__setup-title-group">
                    <span className="mcp-modal__setup-title">Bağlantı Kurulumu</span>
                    <span className="mcp-modal__setup-sub">
                      Aşağıdaki yapılandırmayı AI istemcinizin MCP ayar dosyasına ekleyip istemciyi yeniden başlatın.
                    </span>
                  </div>
                  <div className="mcp-modal__client-tabs">
                    <button
                      type="button"
                      className={`mcp-modal__client-tab ${mcpClientTab === "json" ? "mcp-modal__client-tab--active" : ""}`}
                      onClick={() => setMcpClientTab("json")}
                    >
                      Standart (JSON)
                    </button>
                    <button
                      type="button"
                      className={`mcp-modal__client-tab ${mcpClientTab === "codex" ? "mcp-modal__client-tab--active" : ""}`}
                      onClick={() => setMcpClientTab("codex")}
                    >
                      Codex (TOML)
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
                      {mcpConfigCopied ? "Kopyalandı ✓" : "Kopyala"}
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
                  <span className="mcp-modal__firewall-title">Proje Bazlı AI Erişim İzinleri</span>
                  <span className="mcp-modal__firewall-sub">
                    Yapay zekanın okuyup yazabileceği projeleri tek tıkla açıp kapatabilirsiniz:
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
                          title={isAllowed ? "Erişimi Kapat (Yapay zekayı engelle)" : "Erişimi Aç (Yapay zekaya izin ver)"}
                        >
                          {isAllowed ? "Açık ✓" : "Kapalı ✕"}
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
                    Yapay Zeka Yetkilendirme & Güvenlik Kapsamı
                  </span>
                  <span className="mcp-modal__permissions-sub">
                    AI modellerinin (Antigravity/Claude/Cursor) notları düzenleme ve silme yetki sınırlarını belirleyin:
                  </span>
                </div>

                <div className="mcp-modal__perm-list">
                  <div className="mcp-modal__perm-row">
                    <div className="mcp-modal__perm-info">
                      <span className="mcp-modal__perm-label">Not Düzenleme Yetkisi</span>
                      <span className="mcp-modal__perm-desc">
                        {mcpStatus?.allowAiEdit === "all"
                          ? "Tüm notları düzenleyebilir."
                          : mcpStatus?.allowAiEdit === "none"
                          ? "Hiçbir notu düzenleyemez (Salt okunur)."
                          : "Sadece AI'ın kendi oluşturduğu notları ve projeleri düzenleyebilir."}
                      </span>
                    </div>
                    <div className="mcp-modal__perm-options">
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${(!mcpStatus?.allowAiEdit || mcpStatus.allowAiEdit === "only_ai") ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "only_ai")}
                        title="Yalnızca AI'ın oluşturduğu notları ve projeleri düzenleyebilir"
                      >
                        Yalnızca AI
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiEdit === "all" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "all")}
                        title="Tüm notları düzenleyebilir"
                      >
                        Tümü
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiEdit === "none" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiEdit", "none")}
                        title="Hiçbir notu düzenleyemez"
                      >
                        Kapalı
                      </button>
                    </div>
                  </div>

                  <div className="mcp-modal__perm-row">
                    <div className="mcp-modal__perm-info">
                      <span className="mcp-modal__perm-label">Not & Görev Silme Yetkisi</span>
                      <span className="mcp-modal__perm-desc">
                        {mcpStatus?.allowAiDelete === "all"
                          ? "Tüm not ve görevleri silebilir."
                          : mcpStatus?.allowAiDelete === "none"
                          ? "Hiçbir notu veya görevi silemez."
                          : "Sadece AI'ın kendi oluşturduğu projeleri ve notları silebilir."}
                      </span>
                    </div>
                    <div className="mcp-modal__perm-options">
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${(!mcpStatus?.allowAiDelete || mcpStatus.allowAiDelete === "only_ai") ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "only_ai")}
                        title="Yalnızca AI'ın oluşturduğu notları ve projeleri silebilir"
                      >
                        Yalnızca AI
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiDelete === "all" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "all")}
                        title="Tüm not ve görevleri silebilir"
                      >
                        Tümü
                      </button>
                      <button
                        type="button"
                        className={`mcp-modal__perm-btn ${mcpStatus?.allowAiDelete === "none" ? "mcp-modal__perm-btn--active" : ""}`}
                        onClick={() => handleSetPermissionSetting("allowAiDelete", "none")}
                        title="Hiçbir şeyi silemez"
                      >
                        Kapalı
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Log actions */}
              <div className="mcp-modal__log-header">
                <span className="mcp-modal__log-title">Son AI Aktiviteleri (Canlı)</span>
                {mcpStatus?.logs && mcpStatus.logs.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--secondary mcp-modal__clear-btn"
                    onClick={handleClearMcpLogs}
                  >
                    Günlüğü Temizle
                  </button>
                )}
              </div>

              {/* Log entries */}
              {!mcpStatus?.logs || mcpStatus.logs.length === 0 ? (
                <div className="mcp-modal__empty">
                  Henüz bir AI modeli (Antigravity / Claude / Cursor) işlem gerçekleştirmedi.
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
                  Yapay zeka modelleri bu tünel üzerinden notlarınızı, görevlerinizi ve ekran görüntülerinizi okuyup yazabilir.
                </span>
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setIsMcpModalOpen(false)}
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


