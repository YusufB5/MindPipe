export type Language = "tr" | "en";
export type ThemeId = "amber" | "oled" | "emerald" | "slate" | "paper" | "nordic";

export const translations = {
  tr: {
    // Sidebar
    projects: "PROJELER",
    newProjectBtn: "+ yeni proje ekle",
    newProjectPlaceholder: "Proje adı...",
    create: "Oluştur",
    cancel: "İptal",
    ready: "hazır",

    // Header & Project Actions
    entriesCount: "kayıt",
    notesTab: "Notlar",
    todosTab: "Görevler",
    addNoteBtn: "+ Not Ekle",
    copyAiContext: "AI Bağlamını Kopyala",
    copiedAiContext: "AI Bağlamı Kopyalandı ✓",
    openFolder: "Proje Klasörünü Aç",
    deleteProject: "Projeyi Sil",
    deleteProjectConfirm: (name: string) => `"${name}" projesini ve içindeki tüm notları silmek istiyor musunuz?`,

    // Search
    searchPlaceholderCurrent: (proj: string) => `Ara (Ctrl+F) — "${proj}" içinde...`,
    searchPlaceholderAll: "Ara (Ctrl+F) — Tüm projelerde...",
    searchScopeCurrent: "Bu Projede",
    searchScopeAll: "Tüm Projelerde",
    searchResultsFor: (query: string, count: number) => `"${query}" için arama sonuçları (${count} eşleşme)`,
    searching: "Aranıyor...",
    noMatchingEntries: "Eşleşen kayıt bulunamadı",
    noMatchingEntriesSub: "Farklı bir arama kelimesi deneyebilir veya kapsamı \"Tüm Projelerde\" olarak değiştirebilirsiniz.",

    // DevLog Stream Feed
    noEntriesTitle: "Bu projede henüz kayıt yok",
    noEntriesSub: "Ctrl+Shift+N kısayolu ile hızlı yakalayabilir veya yukarıdan + Not Ekle butonunu kullanabilirsiniz.",
    loading: "Yükleniyor...",
    emptyEntry: "(Boş kayıt)",
    pinnedBadge: "Sabitlendi",
    pin: "📌 Sabitle",
    unpin: "Sabiti Kaldır",
    copy: "Kopyala",
    copied: "Kopyalandı ✓",
    edit: "✏️ Düzenle",
    closeEdit: "✏️ Kapat",
    delete: "Sil",
    deleteEntryConfirm: (name: string) => `"${name}" kaydını silmek istiyor musunuz?`,
    readMore: "Devamını Gör",
    showLess: "Daha az göster",
    reorderTitle: "Sıralamak için sürükleyin",
    doubleClickToEdit: "Düzenlemek için çift tıklayın",
    clickToZoom: "Tam boyutta büyütmek için tıklayın",
    removeImage: "Bu görseli kaldır",

    // Inline Editor & Quick Note
    save: "Kaydet",
    saved: "Kaydedildi ✓",
    saving: "Kaydediliyor...",
    inlineEditorPlaceholder: "Not içeriğini düzenleyin... (Ctrl+S ile kaydet)",
    inlineEditorHint: "Ctrl+V ile görsel ekleyebilirsiniz",
    quickNotePlaceholder: "Yeni not içeriğini yazın...",

    // Todos
    todoPlaceholder: "Yeni görev ekle ve Enter'a bas...",
    addTodoBtn: "Ekle",
    noTodosTitle: "Bu projede henüz görev yok",
    noTodosSub: "Yukarıdaki kutucuğa yazıp Enter tuşuna basarak hızlıca görev ekleyebilirsiniz.",
    pendingTodos: "Bekleyenler",
    completedTodos: "Tamamlananlar",
    deleteTodo: "Görevi Sil",

    // Settings Modal
    settingsTitle: "Ayarlar",
    appearance: "Görünüm",
    shortcuts: "Kısayollar",
    about: "Hakkında",
    languageLabel: "Uygulama Dili",
    themeLabel: "Renk Teması",
    themeAmber: "Amber Dark (Varsayılan)",
    themeAmberDesc: "Sıcak koyu tonlar ve kehribar sarısı vurgular",
    themeOled: "OLED Midnight",
    themeOledDesc: "Derin saf siyah zemin ve altın sarısı dokunuşlar",
    themeEmerald: "Emerald Forest",
    themeEmeraldDesc: "Koyu zümrüt yeşili ve modern matrix havası",
    themeSlate: "Slate Minimal",
    themeSlateDesc: "Soğuk mavi-gri ve sade karanlık tema",
    themePaper: "Paper Light",
    themePaperDesc: "Sıcak krem-kağıt zemin ve kehribar dokunuşlar",
    themeNordic: "Nordic Frost",
    themeNordicDesc: "Ferah açık gri zemin ve kutup mavisi vurgular",

    // Shortcuts List
    shortcutQuickCapture: "Hızlı Not ve Ekran Görüntüsü Yakalama (Pipe)",
    shortcutSearch: "Arama çubuğuna odaklan",
    shortcutSave: "Satır içi düzenlemeyi kaydet",
    shortcutPaste: "Düzenleyiciye ekran görüntüsü yapıştır",
    shortcutEsc: "İptal et veya açık paneli kapat",
    shortcutNewNote: "Hızlı not kutusunu aç",
    shortcutEditBtn: "Değiştir",
    shortcutSaveBtn: "Kaydet",
    shortcutResetBtn: "Varsayılana Sıfırla (Ctrl+Shift+N)",
    shortcutPlaceholder: "Örn: Ctrl+Shift+N veya Alt+Space",
    shortcutSaved: "Kısayol güncellendi ✓",
    shortcutHint: "Birden fazla tuşu '+' ile birleştirin (örn. Alt+Space, Ctrl+Alt+N).",

    // About
    aboutDesc: "Geliştiriciler ve üretken beyinler için hafif, yerel ve AI-uyumlu devlog & not alma istasyonu.",
    versionLabel: "Sürüm",
    githubRepo: "GitHub Deposu",
    viewOnGithub: "GitHub'da İncele ↗",
    licenseLabel: "Lisans",

    // Quick Capture Window
    capturePlaceholder: "Bir şey yaz ya da ekran görüntüsü yapıştır (birden fazla yapıştırabilirsiniz)...",
    captureDescPlaceholder: "Açıklama notu ekle (Enter: Hepsini Kaydet)...",
    captureEnter: "kaydet",
    captureShiftEnter: "yeni satır",
    captureEsc: "kapat",
    captureImagesCount: (count: number) => `${count} görsel`,

    // MCP Modal
    mcpTitle: "MindPipe MCP Denetim Masası",
    mcpSubtitle: "Yapay zeka tüneli, istemci bağlantısı ve proje güvenlik duvarı",
    mcpClientStatus: "AI İstemcisi & Durum",
    mcpProcessing: "İşlem Yapılıyor",
    mcpReadyIdle: "Hazır / Beklemede",
    mcpNotConfigured: "Yapılandırılmadı",
    mcpLastActive: (time: string) => `Son İşlem: ${time}`,
    mcpTunnelOpen: "Tünel açık, komut bekleniyor",
    mcpFirewall: "Güvenlik Duvarı",
    mcpProjectsAllowed: (allowed: number, total: number) => `${allowed} / ${total} Proje Açık`,
    mcpTotalOperations: "Toplam İşlem",
    mcpLogEntriesCount: (count: number) => `${count} kayıt`,
    mcpConnectionSetup: "Bağlantı Kurulumu",
    mcpConnectionSetupDesc: "Aşağıdaki yapılandırmayı AI istemcinizin MCP ayar dosyasına ekleyip istemciyi yeniden başlatın.",
    mcpStandardJson: "Standart (JSON)",
    mcpCodexToml: "Codex (TOML)",
    mcpProjectPermissions: "Proje Bazlı AI Erişim İzinleri",
    mcpProjectPermissionsDesc: "Yapay zekanın okuyup yazabileceği projeleri tek tıkla açıp kapatabilirsiniz:",
    mcpAccessAllowed: "Açık ✓",
    mcpAccessBlocked: "Kapalı ✕",
    mcpRevokeAccessTitle: "Erişimi Kapat (Yapay zekayı engelle)",
    mcpGrantAccessTitle: "Erişimi Aç (Yapay zekaya izin ver)",
    mcpPermissionsScope: "Yapay Zeka Yetkilendirme & Güvenlik Kapsamı",
    mcpPermissionsScopeDesc: "AI modellerinin (Antigravity/Claude/Cursor) notları düzenleme ve silme yetki sınırlarını belirleyin:",
    mcpEditPermissionLabel: "Not Düzenleme Yetkisi",
    mcpEditAllDesc: "Tüm notları düzenleyebilir.",
    mcpEditNoneDesc: "Hiçbir notu düzenleyemez (Salt okunur).",
    mcpEditOnlyAiDesc: "Sadece AI'ın kendi oluşturduğu notları ve projeleri düzenleyebilir.",
    mcpDeletePermissionLabel: "Not & Görev Silme Yetkisi",
    mcpDeleteAllDesc: "Tüm not ve görevleri silebilir.",
    mcpDeleteNoneDesc: "Hiçbir notu veya görevi silemez.",
    mcpDeleteOnlyAiDesc: "Sadece AI'ın kendi oluşturduğu projeleri ve notları silebilir.",
    mcpBtnOnlyAi: "Yalnızca AI",
    mcpBtnAll: "Tümü",
    mcpBtnOff: "Kapalı",
    mcpRecentLogs: "Son AI Aktiviteleri (Canlı)",
    mcpClearLogs: "Günlüğü Temizle",
    mcpNoLogsYet: "Henüz bir AI modeli (Antigravity / Claude / Cursor) işlem gerçekleştirmedi.",
    mcpFooterHint: "Yapay zeka modelleri bu tünel üzerinden notlarınızı, görevlerinizi ve ekran görüntülerinizi okuyup yazabilir.",
  },

  en: {
    // Sidebar
    projects: "PROJECTS",
    newProjectBtn: "+ add new project",
    newProjectPlaceholder: "Project name...",
    create: "Create",
    cancel: "Cancel",
    ready: "ready",

    // Header & Project Actions
    entriesCount: "entries",
    notesTab: "Notes",
    todosTab: "Tasks",
    addNoteBtn: "+ Add Note",
    copyAiContext: "Copy AI Context",
    copiedAiContext: "AI Context Copied ✓",
    openFolder: "Open Project Folder",
    deleteProject: "Delete Project",
    deleteProjectConfirm: (name: string) => `Are you sure you want to delete project "${name}" and all its notes?`,

    // Search
    searchPlaceholderCurrent: (proj: string) => `Search (Ctrl+F) — in "${proj}"...`,
    searchPlaceholderAll: "Search (Ctrl+F) — in all projects...",
    searchScopeCurrent: "In This Project",
    searchScopeAll: "All Projects",
    searchResultsFor: (query: string, count: number) => `Search results for "${query}" (${count} matches)`,
    searching: "Searching...",
    noMatchingEntries: "No matching entries found",
    noMatchingEntriesSub: "Try a different search query or change scope to \"All Projects\".",

    // DevLog Stream Feed
    noEntriesTitle: "No entries in this project yet",
    noEntriesSub: "Use Ctrl+Shift+N to quick capture or click + Add Note above.",
    loading: "Loading...",
    emptyEntry: "(Empty entry)",
    pinnedBadge: "Pinned",
    pin: "📌 Pin",
    unpin: "Unpin",
    copy: "Copy",
    copied: "Copied ✓",
    edit: "✏️ Edit",
    closeEdit: "✏️ Close",
    delete: "Delete",
    deleteEntryConfirm: (name: string) => `Are you sure you want to delete "${name}"?`,
    readMore: "Read More",
    showLess: "Show Less",
    reorderTitle: "Drag to reorder",
    doubleClickToEdit: "Double-click to edit",
    clickToZoom: "Click to zoom full size",
    removeImage: "Remove this image",

    // Inline Editor & Quick Note
    save: "Save",
    saved: "Saved ✓",
    saving: "Saving...",
    inlineEditorPlaceholder: "Edit note content... (Ctrl+S to save)",
    inlineEditorHint: "Paste screenshots with Ctrl+V",
    quickNotePlaceholder: "Write new note content...",

    // Todos
    todoPlaceholder: "Add a new task and press Enter...",
    addTodoBtn: "Add",
    noTodosTitle: "No tasks in this project yet",
    noTodosSub: "Type in the field above and press Enter to quickly add a task.",
    pendingTodos: "Pending",
    completedTodos: "Completed",
    deleteTodo: "Delete Task",

    // Settings Modal
    settingsTitle: "Settings",
    appearance: "Appearance",
    shortcuts: "Shortcuts",
    about: "About",
    languageLabel: "Interface Language",
    themeLabel: "Color Theme",
    themeAmber: "Amber Dark (Default)",
    themeAmberDesc: "Warm dark tones with signature amber accents",
    themeOled: "OLED Midnight",
    themeOledDesc: "Deep pure black background with gold highlights",
    themeEmerald: "Emerald Forest",
    themeEmeraldDesc: "Dark emerald green with a modern cyber aesthetic",
    themeSlate: "Slate Minimal",
    themeSlateDesc: "Cool blue-grey minimal dark theme",
    themePaper: "Paper Light",
    themePaperDesc: "Warm cream-paper background with amber highlights",
    themeNordic: "Nordic Frost",
    themeNordicDesc: "Crisp cool light-grey background with arctic blue accents",

    // Shortcuts List
    shortcutQuickCapture: "Quick Note & Screenshot Capture (Pipe)",
    shortcutSearch: "Focus search bar",
    shortcutSave: "Save inline note edit",
    shortcutPaste: "Paste screenshot into editor",
    shortcutEsc: "Cancel or close open modal",
    shortcutNewNote: "Open quick note form",
    shortcutEditBtn: "Change",
    shortcutSaveBtn: "Save",
    shortcutResetBtn: "Reset to Default (Ctrl+Shift+N)",
    shortcutPlaceholder: "e.g. Ctrl+Shift+N or Alt+Space",
    shortcutSaved: "Shortcut updated ✓",
    shortcutHint: "Combine keys with '+' (e.g. Alt+Space, Ctrl+Alt+N).",

    // About
    aboutDesc: "A lightweight, local-first, AI-ready devlog & notes station for builders and developers.",
    versionLabel: "Version",
    githubRepo: "GitHub Repository",
    viewOnGithub: "View on GitHub ↗",
    licenseLabel: "License",

    // Quick Capture Window
    capturePlaceholder: "Write something or paste screenshots (multiple allowed)...",
    captureDescPlaceholder: "Add description note (Enter: Save All)...",
    captureEnter: "save",
    captureShiftEnter: "new line",
    captureEsc: "close",
    captureImagesCount: (count: number) => `${count} images`,

    // MCP Modal
    mcpTitle: "MindPipe MCP Control Panel",
    mcpSubtitle: "AI tunnel, client connection & project firewall",
    mcpClientStatus: "AI Client & Status",
    mcpProcessing: "Processing",
    mcpReadyIdle: "Ready / Idle",
    mcpNotConfigured: "Not Configured",
    mcpLastActive: (time: string) => `Last Activity: ${time}`,
    mcpTunnelOpen: "Tunnel active, awaiting commands",
    mcpFirewall: "Firewall",
    mcpProjectsAllowed: (allowed: number, total: number) => `${allowed} / ${total} Projects Allowed`,
    mcpTotalOperations: "Total Operations",
    mcpLogEntriesCount: (count: number) => `${count} entries`,
    mcpConnectionSetup: "Connection Setup",
    mcpConnectionSetupDesc: "Add the following configuration to your AI client's MCP configuration file and restart the client.",
    mcpStandardJson: "Standard (JSON)",
    mcpCodexToml: "Codex (TOML)",
    mcpProjectPermissions: "Per-Project AI Access Permissions",
    mcpProjectPermissionsDesc: "Toggle projects that AI models can read and modify with one click:",
    mcpAccessAllowed: "Allowed ✓",
    mcpAccessBlocked: "Blocked ✕",
    mcpRevokeAccessTitle: "Revoke Access (Block AI)",
    mcpGrantAccessTitle: "Grant Access (Allow AI)",
    mcpPermissionsScope: "AI Permission Scope & Security",
    mcpPermissionsScopeDesc: "Define editing and deletion boundaries for AI models (Antigravity/Claude/Cursor):",
    mcpEditPermissionLabel: "Note Editing Permission",
    mcpEditAllDesc: "Can edit all notes.",
    mcpEditNoneDesc: "Cannot edit any notes (Read-only).",
    mcpEditOnlyAiDesc: "Can only edit notes and projects created by AI.",
    mcpDeletePermissionLabel: "Note & Task Deletion Permission",
    mcpDeleteAllDesc: "Can delete all notes and tasks.",
    mcpDeleteNoneDesc: "Cannot delete any notes or tasks.",
    mcpDeleteOnlyAiDesc: "Can only delete projects and notes created by AI.",
    mcpBtnOnlyAi: "AI Only",
    mcpBtnAll: "All",
    mcpBtnOff: "Disabled",
    mcpRecentLogs: "Recent AI Activities (Live)",
    mcpClearLogs: "Clear Log",
    mcpNoLogsYet: "No AI model (Antigravity / Claude / Cursor) has performed actions yet.",
    mcpFooterHint: "AI models can read and write your notes, tasks, and screenshots through this tunnel.",
  },
} as const;

export function getInitialLanguage(): Language {
  const saved = localStorage.getItem("mindpipe_lang");
  if (saved === "tr" || saved === "en") return saved;
  const sysLang = navigator.language.toLowerCase();
  return sysLang.startsWith("tr") ? "tr" : "en";
}

export function getInitialTheme(): ThemeId {
  const saved = localStorage.getItem("mindpipe_theme");
  if (
    saved === "amber" ||
    saved === "oled" ||
    saved === "emerald" ||
    saved === "slate" ||
    saved === "paper" ||
    saved === "nordic"
  ) {
    return saved;
  }
  return "amber";
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("mindpipe_theme", theme);
}
