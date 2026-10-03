# MindPipe

[English](#english) | [Türkçe](#türkçe)

---

<a name="english"></a>
## English

MindPipe is a lightweight, local-first desktop application and AI context bridge built with Tauri, Rust, and React. It serves as an instant capture tool, visual project dashboard, and real-time knowledge provider for AI agents via the Model Context Protocol (MCP).

All data is stored directly on your file system as plain Markdown (`.md`) and standard image (`.png`) files. There are no proprietary databases, no cloud synchronization requirements, and zero telemetry.

### Features

- **Global Quick Capture (`Ctrl+Shift+N`):** Open a minimalist capture overlay from anywhere in the operating system. Type quick notes or paste screenshots directly from the clipboard (`Win+Shift+S` then `Ctrl+V`), select a project, and press Enter to save. The capture window hides automatically when it loses focus or on `Escape`.
- **Project Organization:** Manage isolated workspaces. Easily create projects, delete them, or open project folders in the native file explorer.
- **Notes & Media Stream:**
  - View chronologically ordered notes and screenshots.
  - Pin important reference notes to keep them permanently at the top.
  - Newly added notes automatically appear right beneath pinned notes.
  - Drag-and-drop manual card reordering, saved per project (`.order.json`).
  - Built-in note editor with instant Markdown editing and keyboard shortcut (`Ctrl+S`).
  - Fullscreen image lightbox for captured screenshots with multi-image thumbnail support.
- **Integrated Task Management (TODOs):**
  - Project-level task lists stored in plain text (`todos.md`).
  - Separate pending and completed task sections.
  - One-click task completion toggling and deletion.
- **Search System:**
  - Real-time search across note contents, file names, and project titles.
  - Filter search scope between the current project or all projects.
- **AI Context Export:**
  - One-click export of an LLM-optimized Markdown context bundle containing project guidelines, pinned notes, active tasks, and chronological entries.
- **Model Context Protocol (MCP) Bridge:**
  - Independent JSON-RPC 2.0 stdio server (`mcp-server.cjs`).
  - Allows AI agents (Antigravity, Claude Desktop, Cursor, Codex) to read project context, list projects, search notes, create projects, write notes, edit entries, and manage tasks.
  - Non-intrusive background file watcher providing real-time live synchronization between external AI agent modifications and the desktop interface.
  - AI attribution indicator showing which projects, notes, and tasks were created or modified by AI agents.
- **Granular Security Firewall & Permissions:**
  - Project-based access control: toggle AI agent read/write access per project with one click.
  - Action scoping: configure AI agent edit and delete permissions (`only_ai` created items, `all` items, or `none`).
  - Live activity logging and connected client detection.

### Architecture

- **Backend:** Rust (Tauri v2), handling global shortcuts, system tray lifecycle, native file I/O, window management, and background file state change notifications.
- **Frontend:** React with TypeScript and Vite, styled with custom zero-dependency dark theme CSS.
- **MCP Server:** Node.js script communicating over standard input/output (stdio), completely decoupled from the graphical user interface.
- **Storage Location:** `%APPDATA%/com.notesdashboard.app/projects/<project>/` (Windows) or `~/.config/com.notesdashboard.app/projects/<project>/` (Linux).

### Prerequisites

- Node.js 18+
- Rust (stable toolchain via rustup)
- Platform build dependencies: [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
# Install frontend dependencies
npm install

# Run application in development mode
npm run tauri dev
```

### Production Build

```bash
# Build production desktop binary and installers
npm run tauri build
```

Compiled binaries and installers will be located in `src-tauri/target/release/` and `src-tauri/target/release/bundle/`.

### MCP Agent Configuration

Add MindPipe to your AI agent configuration:

**Standard JSON (Antigravity, Claude Desktop, Cursor):**
- Antigravity: `~/.gemini/config/mcp_config.json`
- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "mindpipe": {
      "command": "node",
      "args": ["<PATH_TO_MINDPIPE>/mcp-server.cjs"]
    }
  }
}
```

**Codex CLI (TOML):**
- Path: `~/.codex/config.toml`

```toml
[mcp_servers.mindpipe]
command = "node"
args = ['<PATH_TO_MINDPIPE>/mcp-server.cjs']
```

---

<a name="türkçe"></a>
## Türkçe

MindPipe, Tauri, Rust ve React ile geliştirilmiş, yerel öncelikli (local-first) bir masaüstü bilgi paneli ve yapay zeka bağlam köprüsüdür. Hem hızlı bir not ve ekran görüntüsü yakalama aracı, hem görsel bir proje yönetim paneli, hem de Model Context Protocol (MCP) üzerinden yapay zeka ajanlarına (AI agents) doğrudan yapılandırılmış proje bağlamı sağlayan bir altyapıdır.

Tüm veriler doğrudan dosya sisteminizde düz Markdown (`.md`) ve standart görsel (`.png`) dosyaları olarak saklanır. Özel veritabanı formatları, harici bulut bağımlılığı ve telemetri takibi yoktur.

### Özellikler

- **Global Hızlı Yakalama (`Ctrl+Shift+N`):** İşletim sisteminin herhangi bir yerindeyken tek kısayolla minimalist yakalama penceresini açın. Not yazın veya panodaki ekran alıntısını yapıştırın (`Win+Shift+S` ardından `Ctrl+V`), hedef projeyi seçip Enter'a basın. Odak kaybedildiğinde veya `Escape` tuşuna basıldığında otomatik olarak gizlenir.
- **Proje Organizasyonu:** Çalışmalarınızı izole projelere ayırın. Kolayca yeni proje oluşturun, silin veya proje klasörünü doğrudan dosya gezgininde açın.
- **Not ve Medya Akışı:**
  - Kronolojik not ve ekran görüntüsü akışı.
  - Önemli notları ve yönergeleri en üstte tutmak için sabitleme (pin) desteği.
  - Yeni eklenen notlar otomatik olarak sabitlenen notların hemen altında, akışın en üstünde konumlanır.
  - Sürükle-bırak yöntemiyle serbest kart sıralama; sıralama proje bazında (`.order.json`) saklanır.
  - Dahili Markdown düzenleyici ve hızlı kaydetme kısayolu (`Ctrl+S`).
  - Ekran alıntıları için tam ekran görsel lightbox görüntüleyicisi ve çoklu görsel desteği.
- **Entegre Görev Yönetimi (Yapılacaklar Listesi):**
  - Proje düzeyinde görev listesi düz metin dosyasında saklanır (`todos.md`).
  - Bekleyen ve tamamlanan görevler ayrılmış listelerde gösterilir.
  - Tek tıkla durum değiştirme (tamamlandı/bekliyor) ve görev silme.
- **Arama Sistemi:**
  - Not içerikleri, dosya adları ve proje başlıkları üzerinde anlık arama.
  - Aramayı mevcut proje ile sınırlandırma veya tüm projeleri kapsama seçeneği.
- **AI Bağlamı Dışa Aktarma:**
  - Tek tıkla büyük dil modellerine (LLM) doğrudan verilebilecek standart bir Markdown bağlam çıktısı kopyalama.
- **Model Context Protocol (MCP) Köprüsü:**
  - Bağımsız JSON-RPC 2.0 stdio sunucusu (`mcp-server.cjs`).
  - Yapay zeka ajanlarının (Antigravity, Claude Desktop, Cursor, Codex) projeleri listelemesine, bağlam okumasına, arama yapmasına, proje açmasına, not yazmasına, düzenlemesine ve görevleri yönetmesine olanak tanır.
  - Arka planda çalışan hafif dosya izleyici sayesinde AI ajanlarının yaptığı değişiklikler masaüstü arayüzüne anlık ve canlı olarak yansır.
  - AI ajanlarının oluşturduğu proje, not ve görevlerde görsel AI mikroçip rozeti ile şeffaf kaynak takibi.
- **Güvenlik Duvarı ve İzin Denetimi:**
  - Proje bazlı erişim denetimi: AI ajanlarının hangi projelere erişebileceğini tek tıkla açıp kapatabilme.
  - Yetki kapsamı belirleme: not düzenleme ve silme yetkilerini sınırlama (sadece AI'ın kendi ürettiği içerikler, tüm içerikler veya salt okunur).
  - Canlı istemci algılama ve işlem geçmişi log takibi.

### Mimari

- **Backend:** Rust (Tauri v2); sistem kısayollarını, sistem çekmecesini (tray), dosya I/O operasyonlarını, pencere yönetimini ve arka plan dosya izleyicisini yönetir.
- **Frontend:** TypeScript ve React; harici ağır UI kütüphaneleri olmadan optimize edilmiş özel CSS ile çalışır.
- **MCP Sunucusu:** Node.js ile yazılmış, standart girdi/çıktı (stdio) üzerinden çalışan ve masaüstü arayüzünden bağımsız çalışabilen servis.
- **Veri Depolama Konumu:** `%APPDATA%/com.notesdashboard.app/projects/<proje>/` (Windows) veya `~/.config/com.notesdashboard.app/projects/<proje>/` (Linux).

### Gereksinimler

- Node.js 18+
- Rust (rustup ile güncel stable sürüm)
- Platform derleme bağımlılıkları: [Tauri Başlangıç Kılavuzu](https://v2.tauri.app/start/prerequisites/)

### Geliştirme Ortamı

```bash
# Bağımlılıkları yükleyin
npm install

# Geliştirme modunda çalıştırın
npm run tauri dev
```

### Üretim Derlemesi (Build)

```bash
# Bağımsız exe ve kurulum paketlerini derleyin
npm run tauri build
```

Derlenen çalıştırılabilir dosya ve kurulum paketleri `src-tauri/target/release/` ve `src-tauri/target/release/bundle/` dizinlerinde üretilir.

### MCP Ajan (Agent) Yapılandırması

MindPipe'ı kullandığınız AI ajanına bağlamak için ilgili ayar dosyasına ekleyin:

**Standart JSON (Antigravity, Claude Desktop, Cursor):**
- Antigravity: `~/.gemini/config/mcp_config.json`
- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "mindpipe": {
      "command": "node",
      "args": ["<MINDPİPE_KLASORU>/mcp-server.cjs"]
    }
  }
}
```

**Codex CLI (TOML):**
- Dosya: `~/.codex/config.toml`

```toml
[mcp_servers.mindpipe]
command = "node"
args = ['<MINDPİPE_KLASORU>/mcp-server.cjs']
```
