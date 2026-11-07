import { invoke } from "@tauri-apps/api/core";

/** One pen stroke. Coordinates are fractions of the page width (so they survive any zoom level). */
export interface Stroke {
  /** CSS colour */
  c: string;
  /** Line width as a fraction of the page width */
  w: number;
  /** Highlighter stroke (translucent, constant width) */
  h?: boolean;
  /** Points: x, y, pressure (0..1) */
  p: [number, number, number][];
}

/** Sidecar file next to the PDF: `<stamp>.ink.json`. The PDF itself is never modified. */
export interface InkDoc {
  version: number;
  name: string;
  pages: Record<string, Stroke[]>;
}

export function emptyInk(name = ""): InkDoc {
  return { version: 1, name, pages: {} };
}

export function parseInk(json: string): InkDoc {
  if (!json.trim()) return emptyInk();
  try {
    const raw = JSON.parse(json);
    const pages: Record<string, Stroke[]> = {};
    if (raw && typeof raw.pages === "object" && raw.pages) {
      for (const [k, v] of Object.entries(raw.pages as Record<string, unknown>)) {
        if (!Array.isArray(v)) continue;
        pages[k] = (v as Stroke[]).filter(
          (s) => s && typeof s.c === "string" && typeof s.w === "number" && Array.isArray(s.p) && s.p.length > 0
        );
      }
    }
    return { version: 1, name: typeof raw?.name === "string" ? raw.name : "", pages };
  } catch {
    return emptyInk();
  }
}

export function serializeInk(doc: InkDoc): string {
  const pages: Record<string, Stroke[]> = {};
  for (const [k, v] of Object.entries(doc.pages)) {
    if (v.length > 0) {
      // Keep the file small: 4 decimals are far below one pixel at any sensible zoom.
      pages[k] = v.map((s) => ({
        ...s,
        w: round(s.w, 5),
        p: s.p.map(([x, y, pr]) => [round(x, 4), round(y, 4), round(pr, 2)] as [number, number, number]),
      }));
    }
  }
  return JSON.stringify({ version: 1, name: doc.name, pages });
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Highlighter opacity. Highlighter strokes are blended with "multiply" (on screen and in the exported
 * PDF), so they tint the white paper but leave dark text dark.
 */
export const HIGHLIGHT_ALPHA = 0.65;

/** Draws one stroke on a canvas; `width` is the page width in canvas pixels. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, width: number) {
  const pts = stroke.p;
  if (pts.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const base = stroke.w * width;

  if (stroke.h) {
    ctx.strokeStyle = stroke.c;
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.lineWidth = base;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * width, pts[0][1] * width);
    if (pts.length === 1) ctx.lineTo(pts[0][0] * width + 0.01, pts[0][1] * width);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * width;
      const my = ((pts[i][1] + pts[i + 1][1]) / 2) * width;
      ctx.quadraticCurveTo(pts[i][0] * width, pts[i][1] * width, mx, my);
    }
    if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0] * width, pts[pts.length - 1][1] * width);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.strokeStyle = stroke.c;
  ctx.fillStyle = stroke.c;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * width, pts[0][1] * width, (base * pressureScale(pts[0][2])) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // Pressure changes the width along the stroke, so it is drawn as short round-capped segments.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.lineWidth = base * pressureScale((a[2] + b[2]) / 2);
    ctx.beginPath();
    ctx.moveTo(a[0] * width, a[1] * width);
    ctx.lineTo(b[0] * width, b[1] * width);
    ctx.stroke();
  }
  ctx.restore();
}

/** 0 → thin, 1 → thick; an unpressured device (mouse) reports 0.5 and gets the nominal width. */
export function pressureScale(p: number): number {
  return 0.35 + 1.3 * Math.min(1, Math.max(0, p));
}

/** Distance from a point to a stroke polyline, in page-width fractions. */
export function strokeDistance(stroke: Stroke, x: number, y: number): number {
  const pts = stroke.p;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    if (i === 0) best = Math.min(best, Math.hypot(x - ax, y - ay));
    if (i > 0) {
      const [px, py] = pts[i - 1];
      const dx = ax - px;
      const dy = ay - py;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2));
      best = Math.min(best, Math.hypot(x - (px + t * dx), y - (py + t * dy)));
    }
  }
  return best;
}

/** The topmost stroke (last drawn) within reach of a point, or -1. */
export function hitStroke(strokes: Stroke[], x: number, y: number, reach = 0.012): number {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokeDistance(strokes[i], x, y) <= reach + strokes[i].w / 2) return i;
  }
  return -1;
}

export function moveStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  return { ...stroke, p: stroke.p.map(([x, y, pr]) => [x + dx, y + dy, pr] as [number, number, number]) };
}

/** Uniform scale about an anchor point. The line width is kept: resizing a drawing does not change the pen. */
export function scaleStroke(stroke: Stroke, ax: number, ay: number, s: number): Stroke {
  return { ...stroke, p: stroke.p.map(([x, y, pr]) => [ax + (x - ax) * s, ay + (y - ay) * s, pr] as [number, number, number]) };
}

export function rotateStroke(stroke: Stroke, cx: number, cy: number, angle: number): Stroke {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    ...stroke,
    p: stroke.p.map(([x, y, pr]) => {
      const dx = x - cx;
      const dy = y - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, pr] as [number, number, number];
    }),
  };
}

export type SelectionHandle = "nw" | "ne" | "se" | "sw" | "rotate";

/** Selection frame (the stroke's bounds plus `pad`) with its corner and rotation handle positions. */
export function selectionFrame(stroke: Stroke, pad: number, rotateOffset: number) {
  const b = strokeBounds(stroke);
  const x0 = b.x0 - pad;
  const y0 = b.y0 - pad;
  const x1 = b.x1 + pad;
  const y1 = b.y1 + pad;
  const handles: Record<SelectionHandle, [number, number]> = {
    nw: [x0, y0],
    ne: [x1, y0],
    se: [x1, y1],
    sw: [x0, y1],
    rotate: [(x0 + x1) / 2, y0 - rotateOffset],
  };
  return { x0, y0, x1, y1, handles, center: [(x0 + x1) / 2, (y0 + y1) / 2] as [number, number] };
}

/** Which handle of the frame (if any) lies within `reach` of the point. */
export function handleAt(frame: ReturnType<typeof selectionFrame>, x: number, y: number, reach: number): SelectionHandle | null {
  for (const name of ["rotate", "nw", "ne", "se", "sw"] as SelectionHandle[]) {
    const [hx, hy] = frame.handles[name];
    if (Math.hypot(x - hx, y - hy) <= reach) return name;
  }
  return null;
}

/** Bounding box in page-width fractions, padded by half the line width. */
export function strokeBounds(stroke: Stroke): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of stroke.p) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const pad = stroke.w * (stroke.h ? 0.5 : 1);
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// ---------------------------------------------------------------- backend calls

export function importPdfFromPath(project: string, path: string): Promise<string> {
  return invoke("import_pdf_from_path", { project, path });
}

export function importPdfBytes(project: string, name: string, dataB64: string): Promise<string> {
  return invoke("import_pdf_bytes", { project, name, dataB64 });
}

export function readPdfInk(pdfPath: string): Promise<string> {
  return invoke("read_pdf_ink", { pdfPath });
}

export function savePdfInk(pdfPath: string, json: string): Promise<void> {
  return invoke("save_pdf_ink", { pdfPath, json });
}

export function exportAnnotatedPdf(name: string, dataB64: string): Promise<string> {
  return invoke("export_annotated_pdf", { name, dataB64 });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
