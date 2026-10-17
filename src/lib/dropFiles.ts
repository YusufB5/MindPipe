import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** A file dropped onto the window, already validated and read by the backend. */
export interface DroppedFile {
  name: string;
  /** "image" (data = base64) or "text" (data = the text itself) */
  kind: "image" | "text";
  mime: string;
  data: string;
}

/**
 * Reads dropped paths through the backend, which only accepts real images and plain-text files
 * within size limits. Anything else is counted as skipped.
 */
export async function readDroppedFiles(paths: string[]): Promise<{ files: DroppedFile[]; skipped: number }> {
  const results = await Promise.allSettled(paths.map((path) => invoke<DroppedFile>("read_dropped_file", { path })));
  const files: DroppedFile[] = [];
  let skipped = 0;
  for (const r of results) {
    if (r.status === "fulfilled") files.push(r.value);
    else skipped += 1;
  }
  return { files, skipped };
}

/** Notes store screenshots as PNG, so other formats are re-encoded (animated GIFs keep their first frame). */
export async function imageToPngDataUrl(file: DroppedFile): Promise<string> {
  const source = `data:${file.mime};base64,${file.data}`;
  if (file.mime === "image/png") return source;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Subscribes to OS file drops on the current window. Returns the unsubscribe function. */
export function listenForFileDrops(handlers: {
  onHover: (active: boolean) => void;
  onDrop: (paths: string[]) => void;
}): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "enter" || payload.type === "over") {
      handlers.onHover(true);
    } else if (payload.type === "leave") {
      handlers.onHover(false);
    } else if (payload.type === "drop") {
      handlers.onHover(false);
      handlers.onDrop(payload.paths);
    }
  });
}
