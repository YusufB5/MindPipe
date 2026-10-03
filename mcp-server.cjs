#!/usr/bin/env node

/**
 * Notes Dashboard - Model Context Protocol (MCP) Server
 * Standard JSON-RPC 2.0 stdio server providing isolated project context,
 * notes, and TODOs to AI models (Antigravity, Cursor, Claude Desktop, etc.)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Project Root resolver
function getProjectsRoot() {
  const appData = process.env.APPDATA || (process.platform === "darwin" 
    ? path.join(process.env.HOME, "Library", "Application Support")
    : path.join(process.env.HOME, ".config"));
  
  return path.join(appData, "com.notesdashboard.app", "projects");
}

function sanitizeName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("Geçersiz proje adı");
  }
  return trimmed;
}

function getAllowedProjects() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const configPath = path.join(home, ".gemini", "config", "mcp_config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const serverCfg = cfg?.mcpServers?.["mindpipe"] || cfg?.mcpServers?.["notes-dashboard"];
      if (serverCfg && Array.isArray(serverCfg.args)) {
        const allowedArg = serverCfg.args.find((a) => a.startsWith("--allowed="));
        if (allowedArg) {
          return allowedArg.replace("--allowed=", "").split(",").map((s) => s.trim().toLowerCase());
        }
        return null; // If no --allowed argument is in config, ALL projects are allowed
      }
    }
  } catch (err) {
    // fallback to process argv
  }

  const allowedArg = process.argv.find((a) => a.startsWith("--allowed="));
  if (allowedArg) {
    return allowedArg.replace("--allowed=", "").split(",").map((s) => s.trim().toLowerCase());
  }
  if (process.env.ALLOWED_PROJECTS) {
    return process.env.ALLOWED_PROJECTS.split(",").map((s) => s.trim().toLowerCase());
  }
  return null;
}

function getAppDir() {
  return path.dirname(getProjectsRoot());
}

function getPermissions() {
  try {
    const permFile = path.join(getAppDir(), "mcp-permissions.json");
    if (fs.existsSync(permFile)) {
      const perms = JSON.parse(fs.readFileSync(permFile, "utf-8"));
      return {
        blockedProjects: Array.isArray(perms?.blockedProjects) ? perms.blockedProjects.map((p) => p.toLowerCase()) : [],
        allowAiEdit: perms?.allowAiEdit || "only_ai",
        allowAiDelete: perms?.allowAiDelete || "only_ai",
      };
    }
  } catch (e) {}
  return {
    blockedProjects: [],
    allowAiEdit: "only_ai",
    allowAiDelete: "only_ai",
  };
}

function getBlockedProjects() {
  return getPermissions().blockedProjects;
}

function isAiProject(projectName) {
  try {
    const root = getProjectsRoot();
    const marker = path.join(root, projectName, ".ai");
    return fs.existsSync(marker);
  } catch (e) {
    return false;
  }
}

function isAiNote(fileName) {
  const stem = path.parse(fileName).name;
  return stem.endsWith("_ai") || stem.includes("_ai_") || stem.endsWith("_ai_note");
}

function canAiEdit(projectName, fileName) {
  const perms = getPermissions();
  const mode = perms.allowAiEdit || "only_ai";
  if (mode === "all") return true;
  if (mode === "none") return false;
  // "only_ai"
  if (isAiProject(projectName)) return true;
  if (fileName && isAiNote(fileName)) return true;
  return false;
}

function canAiDelete(projectName, fileName) {
  const perms = getPermissions();
  const mode = perms.allowAiDelete || "only_ai";
  if (mode === "all") return true;
  if (mode === "none") return false;
  // "only_ai"
  if (isAiProject(projectName)) return true;
  if (fileName && isAiNote(fileName)) return true;
  return false;
}

function isProjectAllowed(projectName) {
  const clean = projectName.toLowerCase();
  
  // 1. Check if user toggled access off in MindPipe UI
  const blocked = getBlockedProjects();
  if (blocked.includes(clean)) {
    return false;
  }

  // 2. Check config file allowed list (if any)
  const allowed = getAllowedProjects();
  if (!allowed) return true;
  return allowed.includes(clean);
}

let currentClient = "";

function recordMcpActivity(toolName, project) {
  try {
    const appDir = getAppDir();
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    const sessionFile = path.join(appDir, "mcp-session.json");
    let existing = {};
    if (fs.existsSync(sessionFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      } catch (e) {}
    }
    const data = {
      client: currentClient || existing.client || "AI Client",
      lastActive: Date.now(),
      lastTool: toolName || "initialize",
      lastProject: project || "Genel",
    };
    fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {}
}

function clearMcpSession() {
  try {
    const sessionFile = path.join(getAppDir(), "mcp-session.json");
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  } catch (e) {}
}

function listProjects() {
  const root = getProjectsRoot();
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const list = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => isProjectAllowed(name));
  
  list.sort();
  const inboxIdx = list.indexOf("inbox");
  if (inboxIdx > -1) {
    list.splice(inboxIdx, 1);
    list.unshift("inbox");
  }
  return list;
}

function parseTodos(dir) {
  const todoFile = path.join(dir, "todos.md");
  if (!fs.existsSync(todoFile)) return [];
  const content = fs.readFileSync(todoFile, "utf-8");
  const items = [];
  content.split("\n").forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [ ] ")) {
      items.push({ id: `todo_${idx}`, text: trimmed.substring(6).trim(), done: false });
    } else if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      items.push({ id: `todo_${idx}`, text: trimmed.substring(6).trim(), done: true });
    }
  });
  return items;
}

function getProjectContext(projectName) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine erişim izni bulunmuyor (İzole proje politikası).`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    throw new Error(`"${clean}" projesi bulunamadı.`);
  }

  // Read pinned
  let pinnedIds = [];
  const pinFile = path.join(dir, ".pinned.json");
  if (fs.existsSync(pinFile)) {
    try {
      pinnedIds = JSON.parse(fs.readFileSync(pinFile, "utf-8"));
    } catch {}
  }

  // Read files
  const files = fs.readdirSync(dir).filter((f) => f !== "todos.md" && !f.startsWith("."));
  const notes = [];
  const images = [];

  for (const f of files) {
    const fullPath = path.join(dir, f);
    if (f.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const isPinned = pinnedIds.some((p) => f.startsWith(p));
      notes.push({ file: f, content: content.trim(), isPinned });
    } else if (f.endsWith(".png")) {
      images.push(f);
    }
  }

  const todos = parseTodos(dir);

  let output = `# Proje Bağlamı: ${clean}\n\n`;

  if (todos.length > 0) {
    output += `## 📋 Yapılacaklar (TODOs)\n`;
    const pending = todos.filter((t) => !t.done);
    const completed = todos.filter((t) => t.done);
    if (pending.length > 0) {
      output += `### Bekleyenler:\n`;
      pending.forEach((t) => { output += `- [ ] ${t.text}\n`; });
    }
    if (completed.length > 0) {
      output += `\n### Tamamlananlar:\n`;
      completed.forEach((t) => { output += `- [x] ${t.text}\n`; });
    }
    output += `\n---\n\n`;
  }

  const pinnedNotes = notes.filter((n) => n.isPinned);
  if (pinnedNotes.length > 0) {
    output += `## 📌 Sabitlenmiş Önemli Notlar & Kurallar\n\n`;
    pinnedNotes.forEach((n) => {
      output += `### ${n.file}\n${n.content}\n\n`;
    });
    output += `---\n\n`;
  }

  const regularNotes = notes.filter((n) => !n.isPinned);
  if (regularNotes.length > 0) {
    output += `## 📝 Notlar ve Kayıtlar\n\n`;
    regularNotes.forEach((n) => {
      output += `### ${n.file}\n${n.content}\n\n`;
    });
  }

  if (images.length > 0) {
    output += `\n## 🖼️ Ekli Ekran Görüntüleri (${images.length} adet)\n`;
    images.forEach((img) => {
      const imgPath = path.join(dir, img);
      output += `- ${img} (Dosya yolu: ${imgPath})\n`;
    });
  }

  return output;
}

function getImage(projectName, imageName) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine erişim izni bulunmuyor.`);
  }
  const root = getProjectsRoot();
  const imgPath = path.join(root, clean, imageName);
  if (!fs.existsSync(imgPath)) {
    throw new Error(`Görsel bulunamadı: ${imageName}`);
  }
  const buffer = fs.readFileSync(imgPath);
  return {
    mimeType: "image/png",
    base64: buffer.toString("base64"),
    filePath: imgPath,
  };
}

function searchNotes(query, projectName) {
  const q = query.toLowerCase();
  const root = getProjectsRoot();
  const projects = projectName ? [sanitizeName(projectName)] : listProjects();
  const results = [];

  for (const proj of projects) {
    if (!isProjectAllowed(proj)) continue;
    const dir = path.join(root, proj);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    for (const f of files) {
      const fullPath = path.join(dir, f);
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.toLowerCase().includes(q) || f.toLowerCase().includes(q)) {
        results.push({
          project: proj,
          file: f,
          snippet: content.substring(0, 200),
        });
      }
    }
  }
  return results;
}

function createProject(projectName) {
  const clean = sanitizeName(projectName);
  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Write .ai marker file so MindPipe recognizes AI ownership
  const marker = path.join(dir, ".ai");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ createdBy: "ai", createdAt: Date.now() }, null, 2), "utf-8");
  }
  return { success: true, project: clean };
}

function addProjectNote(projectName, content) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine yazma izni bulunmuyor.`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // Name ends with _ai.md so UI & backend recognize it as an AI-generated note
  const fileName = `${ts}_ai.md`;
  const filePath = path.join(dir, fileName);

  fs.writeFileSync(filePath, content.trim(), "utf-8");
  return { success: true, file: fileName, project: clean };
}

function editProjectNote(projectName, noteName, content) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine erişim izni bulunmuyor.`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    throw new Error(`"${clean}" projesi bulunamadı.`);
  }

  let targetFile = noteName;
  if (!fs.existsSync(path.join(dir, targetFile))) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    const match = files.find((f) => f === noteName || f === `${noteName}.md` || f.startsWith(noteName));
    if (match) {
      targetFile = match;
    } else {
      throw new Error(`"${noteName}" adlı not bulunamadı.`);
    }
  }

  if (!canAiEdit(clean, targetFile)) {
    throw new Error(`AI Yetkilendirmesi: "${targetFile}" notunu düzenleme yetkiniz yok. (Yalnızca AI tarafından oluşturulan içerikler düzenlenebilir)`);
  }

  const filePath = path.join(dir, targetFile);
  fs.writeFileSync(filePath, content.trim(), "utf-8");
  return { success: true, file: targetFile, project: clean };
}

function deleteProjectNote(projectName, noteName) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine erişim izni bulunmuyor.`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    throw new Error(`"${clean}" projesi bulunamadı.`);
  }

  let targetFile = noteName;
  if (!fs.existsSync(path.join(dir, targetFile))) {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
    const match = files.find((f) => f === noteName || f === `${noteName}.md` || f.startsWith(noteName));
    if (match) {
      targetFile = match;
    } else {
      throw new Error(`"${noteName}" adlı dosya bulunamadı.`);
    }
  }

  if (!canAiDelete(clean, targetFile)) {
    throw new Error(`AI Yetkilendirmesi: "${targetFile}" notunu silme yetkiniz yok. (Yalnızca AI tarafından oluşturulan içerikler silinebilir)`);
  }

  const filePath = path.join(dir, targetFile);
  fs.unlinkSync(filePath);
  return { success: true, file: targetFile, project: clean };
}

function addProjectTodo(projectName, text) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine yazma izni bulunmuyor.`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const todoFile = path.join(dir, "todos.md");
  let existing = "";
  if (fs.existsSync(todoFile)) {
    existing = fs.readFileSync(todoFile, "utf-8");
  }

  const newLine = `- [ ] ${text.trim()} <!--ai-->\n`;
  fs.writeFileSync(todoFile, newLine + existing, "utf-8");
  return { success: true, text: text.trim(), project: clean };
}

function toggleProjectTodo(projectName, textOrIndex, done) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine yazma izni bulunmuyor.`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  const todoFile = path.join(dir, "todos.md");
  if (!fs.existsSync(todoFile)) {
    throw new Error("Projede TODO listesi bulunamadı.");
  }

  let content = fs.readFileSync(todoFile, "utf-8");
  const lines = content.split("\n");
  let updated = false;
  const target = String(textOrIndex).trim().toLowerCase();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      const itemText = trimmed.substring(6).trim();
      if (itemText.toLowerCase() === target || itemText.toLowerCase().includes(target)) {
        updated = true;
        return done ? `- [x] ${itemText}` : `- [ ] ${itemText}`;
      }
    }
    return line;
  });

  if (!updated) {
    throw new Error(`"${textOrIndex}" görev listesinde eşleşmedi.`);
  }

  fs.writeFileSync(todoFile, newLines.join("\n"), "utf-8");
  return { success: true, project: clean, done };
}

function deleteProjectTodo(projectName, text) {
  const clean = sanitizeName(projectName);
  if (!isProjectAllowed(clean)) {
    throw new Error(`"${clean}" projesine yazma izni bulunmuyor.`);
  }

  if (!canAiDelete(clean)) {
    throw new Error(`AI Yetkilendirmesi: Bu projedeki görevleri silme yetkiniz yok. (Yalnızca AI tarafından oluşturulan projelerdeki görevler silinebilir)`);
  }

  const root = getProjectsRoot();
  const dir = path.join(root, clean);
  const todoFile = path.join(dir, "todos.md");
  if (!fs.existsSync(todoFile)) {
    throw new Error("Projede TODO listesi bulunamadı.");
  }

  let content = fs.readFileSync(todoFile, "utf-8");
  const lines = content.split("\n");
  const target = String(text).trim().toLowerCase();
  let deleted = false;

  const newLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
      const itemText = trimmed.substring(6).trim();
      if (itemText.toLowerCase() === target || itemText.toLowerCase().includes(target)) {
        deleted = true;
        return false;
      }
    }
    return true;
  });

  if (!deleted) {
    throw new Error(`"${text}" görev listesinde bulunamadı.`);
  }

  fs.writeFileSync(todoFile, newLines.join("\n"), "utf-8");
  return { success: true, project: clean, text };
}

// MCP JSON-RPC stdio protocol loop
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("close", () => {
  if (global.mcpHeartbeat) clearInterval(global.mcpHeartbeat);
  clearMcpSession();
  process.exit(0);
});

const TOOLS = [
  {
    name: "notes_list_projects",
    description: "MindPipe içindeki erişilebilir tüm proje isimlerini listeler.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notes_get_project_context",
    description: "Belirtilen projenin tüm notlarını, sabitlenmiş kurallarını, TODO listesini ve ekran görüntüsü dosya yollarını eksiksiz bağlam olarak döner.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı (örneğin: 'ASCILINE', 'inbox')" },
      },
      required: ["project"],
    },
  },
  {
    name: "notes_get_image",
    description: "Belirtilen projedeki bir ekran görüntüsünü (PNG) base64 ve yerel dosya yolu olarak getirir. Görsel analizi yapmak için kullanılır.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı" },
        imageName: { type: "string", description: "Görsel dosya adı (örneğin: '2026-08-23_203728.png')" },
      },
      required: ["project", "imageName"],
    },
  },
  {
    name: "notes_search",
    description: "Tüm projelerde veya belirli bir projede notlar arasında arama yapar.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Aranacak kelime veya cümle" },
        project: { type: "string", description: "İsteğe bağlı belirli bir proje adı" },
      },
      required: ["query"],
    },
  },
  {
    name: "notes_create_project",
    description: "Yeni bir proje oluşturur ve projeyi AI tarafından oluşturulmuş olarak işaretler.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Oluşturulacak proje adı" },
      },
      required: ["project"],
    },
  },
  {
    name: "notes_add_note",
    description: "Belirtilen projeye yeni bir not kaydeder.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Notun kaydedileceği proje adı" },
        content: { type: "string", description: "Not içeriği (Markdown formatında)" },
      },
      required: ["project", "content"],
    },
  },
  {
    name: "notes_edit_note",
    description: "Belirtilen projedeki bir notu düzenler. İzin politikasına tabidir (varsayılan: sadece AI'ın oluşturduğu notları düzenleyebilir).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı" },
        noteName: { type: "string", description: "Düzenlenecek notun dosya adı veya başlığı" },
        content: { type: "string", description: "Yeni not içeriği (Markdown)" },
      },
      required: ["project", "noteName", "content"],
    },
  },
  {
    name: "notes_delete_note",
    description: "Belirtilen projedeki bir notu siler. İzin politikasına tabidir (varsayılan: sadece AI'ın oluşturduğu notları silebilir).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı" },
        noteName: { type: "string", description: "Silinecek notun dosya adı" },
      },
      required: ["project", "noteName"],
    },
  },
  {
    name: "notes_add_todo",
    description: "Belirtilen projeye yeni bir yapılacak görev (TODO) ekler.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Görevin ekleneceği proje adı" },
        text: { type: "string", description: "Görev metni" },
      },
      required: ["project", "text"],
    },
  },
  {
    name: "notes_toggle_todo",
    description: "Belirtilen projedeki bir görevin tamamlanma durumunu değiştirir.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı" },
        text: { type: "string", description: "Görevin metni" },
        done: { type: "boolean", description: "Tamamlandı mı (true/false)" },
      },
      required: ["project", "text", "done"],
    },
  },
  {
    name: "notes_delete_todo",
    description: "Belirtilen projedeki bir görevi siler. İzin politikasına tabidir.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Proje adı" },
        text: { type: "string", description: "Silinecek görevin metni" },
      },
      required: ["project", "text"],
    },
  },
];

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    return;
  }

  const { id, method, params } = req;

  function respond(result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  function error(code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

function logMcpActivity(toolName, project, details) {
  try {
    const appDir = path.dirname(getProjectsRoot());
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
    const logFile = path.join(appDir, "mcp-log.json");
    let logs = [];
    if (fs.existsSync(logFile)) {
      try {
        logs = JSON.parse(fs.readFileSync(logFile, "utf-8"));
      } catch (e) {
        logs = [];
      }
    }
    const entry = {
      id: "log_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      tool: toolName,
      project: project || "Genel",
      details: details || "",
    };
    logs.unshift(entry);
    if (logs.length > 60) logs = logs.slice(0, 60);
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), "utf-8");
    recordMcpActivity(toolName, project);
  } catch (err) {
    // silent
  }
}

  if (method === "initialize") {
    if (params && params.clientInfo && params.clientInfo.name) {
      currentClient = params.clientInfo.name;
    }
    recordMcpActivity("initialize", "Genel");

    respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mindpipe-mcp", version: "0.2.0" },
    });
  } else if (method === "tools/list") {
    respond({ tools: TOOLS });
  } else if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      if (name === "notes_list_projects") {
        const list = listProjects();
        logMcpActivity("notes_list_projects", "Tüm Projeler", "Projeleri listeledi");
        respond({ content: [{ type: "text", text: JSON.stringify(list, null, 2) }] });
      } else if (name === "notes_get_project_context") {
        const context = getProjectContext(args.project);
        logMcpActivity("notes_get_project_context", args.project, "Notları ve görevleri okudu");
        respond({ content: [{ type: "text", text: context }] });
      } else if (name === "notes_get_image") {
        const img = getImage(args.project, args.imageName);
        logMcpActivity("notes_get_image", args.project, `Ekran görüntüsü incelendi: ${args.imageName}`);
        respond({
          content: [
            { type: "text", text: `Görsel Dosya Yolu: ${img.filePath}` },
            { type: "image", data: img.base64, mimeType: img.mimeType },
          ],
        });
      } else if (name === "notes_search") {
        const results = searchNotes(args.query, args.project);
        logMcpActivity("notes_search", args.project || "Tüm Projeler", `Arama yapıldı: "${args.query}"`);
        respond({ content: [{ type: "text", text: JSON.stringify(results, null, 2) }] });
      } else if (name === "notes_create_project") {
        const res = createProject(args.project);
        logMcpActivity("notes_create_project", args.project, `Yeni proje açtı: "${res.project}"`);
        respond({ content: [{ type: "text", text: `Proje başarıyla oluşturuldu: ${res.project}` }] });
      } else if (name === "notes_add_note") {
        const res = addProjectNote(args.project, args.content);
        logMcpActivity("notes_add_note", args.project, `Yeni not oluşturdu: ${res.file}`);
        respond({ content: [{ type: "text", text: `Not başarıyla eklendi: ${res.file}` }] });
      } else if (name === "notes_edit_note") {
        const res = editProjectNote(args.project, args.noteName, args.content);
        logMcpActivity("notes_edit_note", args.project, `Not güncellendi: ${res.file}`);
        respond({ content: [{ type: "text", text: `Not başarıyla güncellendi: ${res.file}` }] });
      } else if (name === "notes_delete_note") {
        const res = deleteProjectNote(args.project, args.noteName);
        logMcpActivity("notes_delete_note", args.project, `Not silindi: ${res.file}`);
        respond({ content: [{ type: "text", text: `Not başarıyla silindi: ${res.file}` }] });
      } else if (name === "notes_add_todo") {
        const res = addProjectTodo(args.project, args.text);
        logMcpActivity("notes_add_todo", args.project, `Yeni görev ekledi: "${res.text}"`);
        respond({ content: [{ type: "text", text: `Görev başarıyla eklendi: "${res.text}"` }] });
      } else if (name === "notes_toggle_todo") {
        const res = toggleProjectTodo(args.project, args.text, args.done);
        logMcpActivity("notes_toggle_todo", args.project, `Görev durumu güncellendi: "${args.text}" -> ${args.done ? "Tamamlandı" : "Bekliyor"}`);
        respond({ content: [{ type: "text", text: `Görev güncellendi: "${args.text}" -> ${args.done ? "Tamamlandı" : "Bekliyor"}` }] });
      } else if (name === "notes_delete_todo") {
        const res = deleteProjectTodo(args.project, args.text);
        logMcpActivity("notes_delete_todo", args.project, `Görev silindi: "${res.text}"`);
        respond({ content: [{ type: "text", text: `Görev silindi: "${res.text}"` }] });
      } else {
        error(-32601, `Bilinmeyen tool: ${name}`);
      }
    } catch (err) {
      logMcpActivity(name || "hata", args?.project || "Genel", `Hata: ${err.message}`);
      respond({ content: [{ type: "text", text: `Hata: ${err.message}` }], isError: true });
    }
  } else if (method === "notifications/initialized") {
    // No-op for initialized notification
  } else {
    error(-32601, "Method not found");
  }
});
