import { invoke } from "@tauri-apps/api/core";

export type EntryKind = "note" | "image" | "mixed";

export interface EntryMeta {
  id: string;
  /** File name on disk, e.g. "2026-08-23_141201" */
  name: string;
  /** Absolute path to main file (markdown note or screenshot) */
  path: string;
  /** Absolute paths to all screenshot images attached to this entry */
  imagePaths: string[];
  kind: EntryKind;
  /** Unix ms timestamp, from the file's modified time */
  modified: number;
  /** First chars of the note; undefined if no note */
  preview?: string;
  /** Whether the note is pinned to the top */
  pinned: boolean;
  /** Whether the note was created or managed by AI */
  isAi?: boolean;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  isAi?: boolean;
}

export interface SearchResultItem {
  project: string;
  entry: EntryMeta;
  matchedSnippet: string;
}

/** Lists project folder names. Creates "inbox" automatically on first run. */
export function listProjects(): Promise<string[]> {
  return invoke("list_projects");
}

export function createProject(name: string): Promise<void> {
  return invoke("create_project", { name });
}

export function deleteProject(name: string): Promise<void> {
  return invoke("delete_project", { name });
}

/** Opens a project's folder in the native Windows File Explorer. */
export function openProjectFolder(name: string): Promise<void> {
  return invoke("open_project_folder", { name });
}

export function listEntries(project: string): Promise<EntryMeta[]> {
  return invoke("list_entries", { project });
}

/** Saves custom drag-and-drop order of entries in a project. */
export function reorderEntries(project: string, orderedIds: string[]): Promise<void> {
  return invoke("reorder_entries", { project, orderedIds });
}

/** Exports clean LLM-optimized project context Markdown. */
export function exportAiContext(project: string): Promise<string> {
  return invoke("export_ai_context", { project });
}

/** Toggles pin status of an entry in a project. */
export function togglePinEntry(project: string, entryId: string): Promise<boolean> {
  return invoke("toggle_pin_entry", { project, entryId });
}

/** Lists todos in a project's todos.md file. */
export function listTodos(project: string): Promise<TodoItem[]> {
  return invoke("list_todos", { project });
}

/** Adds a new todo to a project. */
export function addTodo(project: string, text: string): Promise<void> {
  return invoke("add_todo", { project, text });
}

/** Toggles done status of a todo. */
export function toggleTodo(project: string, id: string, done: boolean): Promise<void> {
  return invoke("toggle_todo", { project, id, done });
}

/** Deletes a todo item. */
export function deleteTodo(project: string, id: string): Promise<void> {
  return invoke("delete_todo", { project, id });
}

/** Saves a text note as a timestamped .md file inside the project folder. */
export function saveNote(project: string, content: string): Promise<string> {
  return invoke("save_note", { project, content });
}

/**
 * Saves a screenshot. `pngBase64` should be the raw base64 payload
 * (no "data:image/png;base64," prefix).
 */
export function saveScreenshot(project: string, pngBase64: string): Promise<string> {
  return invoke("save_screenshot", { project, pngBase64 });
}

/** Saves text and/or multiple screenshots together in the specified project. */
export function saveCapture(
  project: string,
  text?: string,
  images?: string[]
): Promise<void> {
  return invoke("save_capture", {
    project,
    text: text || null,
    images: images || null,
  });
}

/** Attaches a new screenshot image to an existing note entry. */
export function attachImageToEntry(
  entryPath: string,
  pngBase64: string
): Promise<string> {
  return invoke("attach_image_to_entry", { entryPath, pngBase64 });
}

/** Deletes a single image file. */
export function deleteImageFile(path: string): Promise<void> {
  return invoke("delete_image_file", { path });
}

/** Reads the text content of a note. */
export function readNote(path: string): Promise<string> {
  return invoke("read_note", { path });
}

/** Updates the text content of a note. */
export function updateNote(path: string, content: string): Promise<void> {
  return invoke("update_note", { path, content });
}

/** Deletes a note or image entry (and its linked screenshots if any). */
export function deleteEntry(path: string, imagePaths?: string[]): Promise<void> {
  return invoke("delete_entry", { path, imagePaths: imagePaths || null });
}

/** Performs high-speed search across note contents and names in one or all projects. */
export function searchEntries(
  query: string,
  project?: string
): Promise<SearchResultItem[]> {
  return invoke("search_entries", { query, project: project || null });
}

/** Opens an entry's file with the OS default application. */
export function openEntry(path: string): Promise<void> {
  return invoke("open_entry", { path });
}

export interface McpLogEntry {
  id: string;
  timestamp: number;
  tool: string;
  project: string;
  details: string;
}

export interface McpStatus {
  isConfigured: boolean;
  allowedAll: boolean;
  allowedProjects: string[];
  isLiveProcessing: boolean;
  detectedClient?: string;
  lastActiveTime?: number;
  blockedProjects: string[];
  aiProjects: string[];
  allowAiEdit: string;
  allowAiDelete: string;
  serverScriptPath?: string;
  logs: McpLogEntry[];
}

/** Returns live MCP status, allowed projects, and recent activity logs. */
export function getMcpStatus(): Promise<McpStatus> {
  return invoke("get_mcp_status");
}

/** Toggles AI access for a specific project. Returns true if now allowed, false if blocked. */
export function toggleProjectMcpAccess(project: string): Promise<boolean> {
  return invoke("toggle_project_mcp_access", { project });
}

/** Updates an AI permission setting (e.g. allowAiEdit, allowAiDelete). */
export function setMcpPermissionSetting(key: string, value: string): Promise<void> {
  return invoke("set_mcp_permission_setting", { key, value });
}

/** Clears all MCP activity logs. */
export function clearMcpLogs(): Promise<void> {
  return invoke("clear_mcp_logs");
}

/** Gets the currently registered global shortcut for the Pipe capture window. */
export function getCaptureShortcut(): Promise<string> {
  return invoke("get_capture_shortcut");
}

/** Updates the global capture shortcut. Returns the registered shortcut string or throws on failure. */
export function updateCaptureShortcut(newShortcut: string): Promise<string> {
  return invoke("update_capture_shortcut", { newShortcut });
}




