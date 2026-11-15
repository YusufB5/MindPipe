import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EntryMeta } from "./lib/api";
import { deleteEntry, revealInFolder } from "./lib/api";
import { translations, type Language } from "./lib/i18n";
import {
  bytesToBase64,
  drawStroke,
  exportAnnotatedPdf,
  HIGHLIGHT_ALPHA,
  imageHasOriginal,
  restoreOriginalImage,
  saveEditedImage,
  handleAt,
  hitStroke,
  moveStroke,
  parseInk,
  rotateStroke,
  scaleStroke,
  selectionFrame,
  type SelectionHandle,
  readPdfInk,
  savePdfInk,
  serializeInk,
  strokeDistance,
  type InkDoc,
  type Stroke,
  emptyInk,
} from "./lib/pdfInk";

type Tool = "pen" | "highlighter" | "eraser" | "select" | "hand";

const PEN_COLORS = ["#111111", "#dc2626", "#2563eb", "#16a34a"];
const HIGHLIGHT_COLORS = ["#facc15", "#4ade80", "#f472b6", "#38bdf8"];

const PEN_PRESETS = [
  "#111111", "#4b5563", "#9ca3af", "#ffffff",
  "#dc2626", "#ea580c", "#f59e0b", "#16a34a",
  "#0d9488", "#2563eb", "#7c3aed", "#db2777",
  "#92400e", "#0e7490", "#be123c", "#4d7c0f",
];
const HIGHLIGHT_PRESETS = [
  "#facc15", "#fde047", "#a3e635", "#4ade80",
  "#2dd4bf", "#38bdf8", "#818cf8", "#c084fc",
  "#f472b6", "#fb7185", "#fb923c", "#e5e7eb",
];
/** Colours shown in the toolbar per tool; picking a new one from the menu replaces the oldest. */
const MAX_QUICK = 4;
const HEX = /^#[0-9a-f]{6}$/i;
const COLORS_KEY = "mindpipe_pdf_colors";
const BAR_KEY = "mindpipe_pdf_bar";
const SNAP_DISTANCE = 72;

type Dock = "top" | "bottom" | "left" | "right" | "float";
interface BarLayout {
  dock: Dock;
  x: number;
  y: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

function loadBarLayout(): BarLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(BAR_KEY) || "null");
    if (raw && ["top", "bottom", "left", "right", "float"].includes(raw.dock) && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { dock: raw.dock, x: raw.x, y: raw.y };
    }
  } catch {
    // storage unavailable or corrupt: fall back to the default
  }
  return { dock: "top", x: 24, y: 80 };
}

function saveBarLayout(layout: BarLayout) {
  try {
    localStorage.setItem(BAR_KEY, JSON.stringify(layout));
  } catch {
    // not persisted
  }
}

function loadQuickColors(): { pen: string[]; hl: string[] } {
  const fallback = { pen: [...PEN_COLORS], hl: [...HIGHLIGHT_COLORS] };
  try {
    const raw = JSON.parse(localStorage.getItem(COLORS_KEY) || "null");
    if (!raw) return fallback;
    const clean = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, MAX_QUICK) : [];
    const pen = clean(raw.pen);
    const hl = clean(raw.hl);
    return { pen: pen.length > 0 ? pen : fallback.pen, hl: hl.length > 0 ? hl : fallback.hl };
  } catch {
    return fallback;
  }
}

function saveQuickColors(q: { pen: string[]; hl: string[] }) {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify(q));
  } catch {
    // not persisted
  }
}

/** The window edge the pointer is close enough to for docking, if any. */
function nearestEdge(px: number, py: number, width: number, height: number): Dock | null {
  const candidates: [Dock, number][] = [
    ["top", py],
    ["bottom", height - py],
    ["left", px],
    ["right", width - px],
  ];
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0][1] < SNAP_DISTANCE ? candidates[0][0] : null;
}
/** Line widths as a fraction of the page width (an A4 page is ~595 pt wide). */
const SIZES = [0.0012, 0.0025, 0.005];
const HIGHLIGHT_FACTOR = 6;
const ERASER_RADIUS = 0.012;
const MIN_POINT_GAP = 0.0006;
/** Selection frame metrics, in CSS pixels */
const FRAME_PAD = 4;
const ROTATE_OFFSET = 26;
const HANDLE_SIZE = 9;
const HANDLE_REACH = 11;

interface PdfPageProps {
  doc: PDFDocumentProxy | null;
  /** Image mode: this picture is the page background instead of a PDF page */
  image?: ImageBitmap | null;
  index: number;
  cssWidth: number;
  /** height / width of the page */
  aspect: number;
  scroller: HTMLElement | null;
  rev: number;
  tool: Tool;
  color: string;
  size: number;
  /** Index of the selected stroke on this page, if any */
  selected: number | null;
  getStrokes: (index: number) => Stroke[];
  setStrokes: (index: number, strokes: Stroke[]) => void;
  onStrokeAdded: (index: number, before: Stroke[], after: Stroke[]) => void;
  onChanged: (index: number, before: Stroke[], after: Stroke[]) => void;
  onSelect: (index: number, stroke: number | null) => void;
}

function PdfPage(props: PdfPageProps) {
  const { doc, index, cssWidth, aspect, scroller, rev } = props;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.max(1, Math.round(cssWidth * dpr));
  const pxH = Math.max(1, Math.round(pxW * aspect));
  const wrapRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Only pages near the viewport get canvases; the rest are empty placeholders of the right size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !scroller) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      root: scroller,
      rootMargin: "1200px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      try {
        if (props.image) {
          const canvas = pdfCanvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) return;
          canvas.width = pxW;
          canvas.height = pxH;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(props.image, 0, 0, pxW, pxH);
          return;
        }
        if (!doc) return;
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: pxW / base.width });
        const canvas = pdfCanvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch {
        // cancelled or a page that failed to render: the placeholder stays blank
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, index, pxW, props.image]);

  // Committed strokes
  useEffect(() => {
    if (!visible) return;
    const canvas = inkCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const hlCanvas = highlightCanvasRef.current;
    const hlCtx = hlCanvas?.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hlCtx?.clearRect(0, 0, canvas.width, canvas.height);
    const strokes = props.getStrokes(index);
    // Highlighter strokes live on their own multiply-blended layer, under the pen strokes.
    for (const s of strokes) {
      if (s.h && hlCtx) drawStroke(hlCtx, s, pxW);
      else drawStroke(ctx, s, pxW);
    }
    const sel = props.selected !== null ? strokes[props.selected] : undefined;
    if (sel) {
      const fr = selectionFrame(sel, FRAME_PAD / cssWidth, ROTATE_OFFSET / cssWidth);
      ctx.save();
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.fillRect(fr.x0 * pxW, fr.y0 * pxW, (fr.x1 - fr.x0) * pxW, (fr.y1 - fr.y0) * pxW);
      ctx.strokeRect(fr.x0 * pxW, fr.y0 * pxW, (fr.x1 - fr.x0) * pxW, (fr.y1 - fr.y0) * pxW);
      // line from the top edge to the rotation handle
      ctx.beginPath();
      ctx.moveTo(fr.handles.rotate[0] * pxW, fr.y0 * pxW);
      ctx.lineTo(fr.handles.rotate[0] * pxW, fr.handles.rotate[1] * pxW);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      for (const name of ["nw", "ne", "se", "sw"] as const) {
        const [hx, hy] = fr.handles[name];
        const r = HANDLE_SIZE * dpr;
        ctx.fillRect(hx * pxW - r / 2, hy * pxW - r / 2, r, r);
        ctx.strokeRect(hx * pxW - r / 2, hy * pxW - r / 2, r, r);
      }
      ctx.beginPath();
      ctx.arc(fr.handles.rotate[0] * pxW, fr.handles.rotate[1] * pxW, (HANDLE_SIZE * dpr) / 2 + dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rev, pxW, pxH, index, props.selected]);

  const gesture = useRef<{
    pointerId: number;
    erasing: boolean;
    stroke: Stroke | null;
    before: Stroke[];
    changed: boolean;
    /** Select tool: the stroke being dragged and where the drag started */
    move: {
      stroke: number;
      start: [number, number];
      mode: "move" | SelectionHandle;
      /** scale: the opposite corner stays put; rotate: turn about the centre */
      pivot: [number, number];
    } | null;
  } | null>(null);

  function pointOf(e: PointerEvent | React.PointerEvent): [number, number, number] | null {
    const el = liveCanvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    let pressure = e.pressure;
    if (e.pointerType !== "pen" || pressure === 0) pressure = 0.5;
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width, pressure];
  }

  function drawLive() {
    const canvas = liveCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const g = gesture.current;
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (g?.stroke) drawStroke(ctx, g.stroke, canvas.width);
  }

  function eraseAt(pt: [number, number, number]) {
    const g = gesture.current;
    if (!g) return;
    const current = propsRef.current.getStrokes(index);
    const kept = current.filter((s) => strokeDistance(s, pt[0], pt[1]) > ERASER_RADIUS + s.w / 2);
    if (kept.length !== current.length) {
      g.changed = true;
      propsRef.current.setStrokes(index, kept);
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Fingers scroll/zoom (use the Scroll tool); only the pen and the mouse draw.
    if (e.pointerType === "touch") return;
    if (e.button !== 0 && e.button !== 5) return;
    const p = propsRef.current;
    const erasing = p.tool === "eraser" || (e.buttons & 32) !== 0 || e.button === 5;
    const pt = pointOf(e);
    if (!pt) return;
    e.preventDefault();
    if (p.tool === "select" && !erasing) {
      const strokes = p.getStrokes(index);
      const selected = p.selected !== null ? strokes[p.selected] : undefined;
      const frame = selected ? selectionFrame(selected, FRAME_PAD / p.cssWidth, ROTATE_OFFSET / p.cssWidth) : null;
      let target = -1;
      let mode: "move" | SelectionHandle = "move";
      let pivot: [number, number] = [0, 0];
      const handle = frame ? handleAt(frame, pt[0], pt[1], HANDLE_REACH / p.cssWidth) : null;
      if (frame && handle && p.selected !== null) {
        target = p.selected;
        mode = handle;
        const opposite = { nw: "se", ne: "sw", se: "nw", sw: "ne" } as const;
        pivot = handle === "rotate" ? frame.center : frame.handles[opposite[handle]];
      } else {
        const hit = hitStroke(strokes, pt[0], pt[1]);
        // A click inside the selection frame drags the selected stroke, even away from its line.
        const inFrame = frame && pt[0] >= frame.x0 && pt[0] <= frame.x1 && pt[1] >= frame.y0 && pt[1] <= frame.y1;
        target = hit >= 0 ? hit : inFrame && p.selected !== null ? p.selected : -1;
      }
      p.onSelect(index, target >= 0 ? target : null);
      if (target < 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone
      }
      gesture.current = {
        pointerId: e.pointerId,
        erasing: false,
        stroke: null,
        before: strokes,
        changed: false,
        move: { stroke: target, start: [pt[0], pt[1]], mode, pivot },
      };
      return;
    }
    if (erasing) p.onSelect(index, null);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone: the stroke still ends on pointerup/cancel
    }
    const highlighter = p.tool === "highlighter" && !erasing;
    gesture.current = {
      pointerId: e.pointerId,
      erasing,
      stroke: erasing ? null : { c: p.color, w: p.size * (highlighter ? HIGHLIGHT_FACTOR : 1), h: highlighter || undefined, p: [pt] },
      before: p.getStrokes(index),
      changed: false,
      move: null,
    };
    if (erasing) eraseAt(pt);
    else drawLive();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const g = gesture.current;
    if (!g && propsRef.current.tool === "select") {
      updateHoverCursor(e);
      return;
    }
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.move) {
      const pt = pointOf(e);
      if (!pt) return;
      const { stroke: idx, start, mode, pivot } = g.move;
      const original = g.before[idx];
      let next: Stroke;
      if (mode === "move") {
        next = moveStroke(original, pt[0] - start[0], pt[1] - start[1]);
      } else if (mode === "rotate") {
        const a0 = Math.atan2(start[1] - pivot[1], start[0] - pivot[0]);
        const a1 = Math.atan2(pt[1] - pivot[1], pt[0] - pivot[0]);
        next = rotateStroke(original, pivot[0], pivot[1], a1 - a0);
      } else {
        const d0 = Math.hypot(start[0] - pivot[0], start[1] - pivot[1]);
        const d1 = Math.hypot(pt[0] - pivot[0], pt[1] - pivot[1]);
        next = scaleStroke(original, pivot[0], pivot[1], d0 > 0 ? Math.max(0.05, d1 / d0) : 1);
      }
      g.changed = true;
      propsRef.current.setStrokes(
        index,
        g.before.map((s, i) => (i === idx ? next : s))
      );
      return;
    }
    const native = e.nativeEvent;
    const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    for (const ev of events.length > 0 ? events : [native]) {
      const pt = pointOf(ev);
      if (!pt) continue;
      if (g.erasing) {
        eraseAt(pt);
      } else if (g.stroke) {
        const last = g.stroke.p[g.stroke.p.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= MIN_POINT_GAP) g.stroke.p.push(pt);
      }
    }
    if (!g.erasing) drawLive();
  }

  /** Pointer shape over the selection frame: resize corners, rotate handle, or move inside. */
  function updateHoverCursor(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = propsRef.current;
    const el = e.currentTarget;
    const pt = pointOf(e);
    const selected = p.selected !== null ? p.getStrokes(index)[p.selected] : undefined;
    if (!pt || !selected) {
      el.style.cursor = "";
      return;
    }
    const frame = selectionFrame(selected, FRAME_PAD / p.cssWidth, ROTATE_OFFSET / p.cssWidth);
    const handle = handleAt(frame, pt[0], pt[1], HANDLE_REACH / p.cssWidth);
    if (handle === "rotate") el.style.cursor = "grab";
    else if (handle === "nw" || handle === "se") el.style.cursor = "nwse-resize";
    else if (handle === "ne" || handle === "sw") el.style.cursor = "nesw-resize";
    else if (pt[0] >= frame.x0 && pt[0] <= frame.x1 && pt[1] >= frame.y0 && pt[1] <= frame.y1) el.style.cursor = "move";
    else el.style.cursor = "";
  }

  function endGesture(e: React.PointerEvent<HTMLCanvasElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    const p = propsRef.current;
    if (g.move) {
      if (g.changed) p.onChanged(index, g.before, p.getStrokes(index));
    } else if (g.erasing) {
      if (g.changed) p.onChanged(index, g.before, p.getStrokes(index));
    } else if (g.stroke && g.stroke.p.length > 0) {
      p.onStrokeAdded(index, g.before, [...g.before, g.stroke]);
    }
    const live = liveCanvasRef.current?.getContext("2d");
    if (live && liveCanvasRef.current) live.clearRect(0, 0, liveCanvasRef.current.width, liveCanvasRef.current.height);
  }

  const interactive = props.tool !== "hand";
  return (
    <div ref={wrapRef} className="pdf-page" style={{ width: cssWidth, height: Math.round(cssWidth * aspect) }}>
      {visible && (
        <>
          <canvas key={pxW} ref={pdfCanvasRef} className="pdf-page__canvas" />
          <canvas ref={highlightCanvasRef} className="pdf-page__canvas pdf-page__canvas--highlight" width={pxW} height={pxH} />
          <canvas ref={inkCanvasRef} className="pdf-page__canvas" width={pxW} height={pxH} />
          <canvas
            ref={liveCanvasRef}
            className={`pdf-page__canvas pdf-page__canvas--live pdf-page__canvas--${props.tool}`}
            width={pxW}
            height={pxH}
            style={{ pointerEvents: interactive ? "auto" : "none", mixBlendMode: props.tool === "highlighter" ? "multiply" : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        </>
      )}
    </div>
  );
}

interface HistoryItem {
  page: number;
  before: Stroke[];
  after: Stroke[];
}

type IconName = "pen" | "highlighter" | "eraser" | "select" | "hand" | "trash" | "undo" | "redo" | "download" | "close" | "grip" | "save" | "revert";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  pen: (
    <>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  highlighter: (
    <>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>
  ),
  eraser: (
    <>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </>
  ),
  select: <path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" />,
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </>
  ),
  revert: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

export default function PdfAnnotator({
  entry,
  lang,
  onClose,
  imageMode = false,
  onImageSaved,
}: {
  entry: EntryMeta;
  lang: Language;
  onClose: () => void;
  /** Draw on a PNG attachment (entry.path) instead of a PDF; saving bakes the drawing into the picture. */
  imageMode?: boolean;
  onImageSaved?: () => void;
}) {
  const tr = translations[lang];
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [hasOriginal, setHasOriginal] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [aspects, setAspects] = useState<number[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [quick, setQuick] = useState(loadQuickColors);
  const [penColor, setPenColor] = useState(() => quick.pen[0]);
  const [highlightColor, setHighlightColor] = useState(() => quick.hl[0]);
  const [colorMenu, setColorMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const customColorRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<BarLayout>(loadBarLayout);
  const [drag, setDrag] = useState<{ x: number; y: number; hint: Dock | null } | null>(null);
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const dragLatest = useRef<{ x: number; y: number; hint: Dock | null } | null>(null);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rev, setRev] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [exportState, setExportState] = useState<"idle" | "busy">("idle");
  const [message, setMessage] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [selection, setSelection] = useState<{ page: number; stroke: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const [viewWidth, setViewWidth] = useState(800);

  const inkRef = useRef<InkDoc>(emptyInk());
  const inkLoaded = useRef(false);
  const dirty = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const undoStack = useRef<HistoryItem[]>([]);
  const redoStack = useRef<HistoryItem[]>([]);
  const messageTimer = useRef<number | undefined>(undefined);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // A fresh query string every open, so an edited picture is never served from a stale cache.
  const pdfUrl = useMemo(() => convertFileSrc(entry.path) + (imageMode ? `?t=${Date.now()}` : ""), [entry.path, imageMode]);
  const title = imageMode ? entry.path.split(/[\\/]/).pop() ?? entry.name : inkRef.current.name || entry.preview || entry.name;

  // A replaced (or unmounted) picture's bitmap is released, so repeated saves do not pile up decoded copies.
  useEffect(() => () => img?.close(), [img]);

  // ----- load the PDF (pdf.js is only fetched when a PDF is opened)
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      if (imageMode) {
        try {
          inkLoaded.current = true;
          const res = await fetch(pdfUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bmp = await createImageBitmap(await res.blob());
          if (cancelled) {
            bmp.close();
            return;
          }
          setImg(bmp);
          setAspects([bmp.height / bmp.width]);
          setRev((r) => r + 1);
          imageHasOriginal(entry.path).then(setHasOriginal).catch(() => {});
        } catch (err) {
          if (!cancelled) setLoadError(`${tr.pdfLoadError}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      try {
        const [pdfjs, worker, inkJson] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
          readPdfInk(entry.path).catch(() => ""),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        inkRef.current = parseInk(inkJson);
        inkLoaded.current = true;
        // Read the whole file first: simpler and sturdier than range requests over the asset protocol.
        const res = await fetch(pdfUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        loaded = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDoc(loaded);
        setRev((r) => r + 1);
        // Page sizes up front so the scrollbar is right before any page is rendered.
        const sizes: number[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const page = await loaded.getPage(i);
          if (cancelled) return;
          const vp = page.getViewport({ scale: 1 });
          sizes.push(vp.height / vp.width);
          if (i % 25 === 0) setAspects([...sizes]);
        }
        setAspects(sizes);
      } catch (err) {
        if (!cancelled) setLoadError(`${tr.pdfLoadError}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path]);

  // ----- layout
  useEffect(() => {
    if (!scrollerEl) return;
    const ro = new ResizeObserver(() => setViewWidth(scrollerEl.clientWidth));
    ro.observe(scrollerEl);
    setViewWidth(scrollerEl.clientWidth);
    return () => ro.disconnect();
  }, [scrollerEl]);

  // A small picture is shown at its own size instead of being blown up to the window width.
  const fitWidth = Math.max(280, viewWidth - 40);
  const cssWidth = Math.round((imageMode && img ? Math.min(fitWidth, img.width) : fitWidth) * zoom);
  const firstAspect = aspects[0] ?? 1.414;
  const numPages = imageMode ? (img ? 1 : 0) : doc?.numPages ?? 0;

  function updateCurrentPage() {
    const sc = scrollerEl;
    if (!sc) return;
    const mid = sc.getBoundingClientRect().top + sc.clientHeight / 3;
    let best = 0;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (el && el.getBoundingClientRect().top <= mid) best = i;
    }
    setCurrentPage(best + 1);
  }

  // ----- strokes, history, saving
  function flashMessage(text: string) {
    setMessage(text);
    window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(""), 6000);
  }

  const doSave = useCallback(async () => {
    if (!inkLoaded.current || imageMode) return;
    window.clearTimeout(saveTimer.current);
    dirty.current = false;
    setSaveState("saving");
    try {
      await savePdfInk(entry.path, serializeInk(inkRef.current));
      setSaveState(dirty.current ? "saving" : "saved");
    } catch {
      dirty.current = true;
      setSaveState("error");
    }
  }, [entry.path]);

  function scheduleSave() {
    if (imageMode) {
      // Saved strokes are baked into the picture and cleared, so whatever is still on the page is unsaved.
      // Undoing (or erasing) back to an empty page therefore leaves nothing to save.
      const pending = (inkRef.current.pages["0"] ?? []).length > 0;
      dirty.current = pending;
      setUnsaved(pending);
      return;
    }
    dirty.current = true;
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), 700);
  }

  const getStrokes = useCallback((index: number) => inkRef.current.pages[String(index)] ?? [], []);

  const setStrokes = useCallback((index: number, strokes: Stroke[]) => {
    inkRef.current.pages[String(index)] = strokes;
    setRev((r) => r + 1);
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushHistory(item: HistoryItem) {
    undoStack.current.push(item);
    if (undoStack.current.length > 300) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }

  const onStrokeAdded = useCallback((index: number, before: Stroke[], after: Stroke[]) => {
    setStrokes(index, after);
    pushHistory({ page: index, before, after });
    setSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChanged = useCallback((index: number, before: Stroke[], after: Stroke[]) => {
    pushHistory({ page: index, before, after });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = useCallback((page: number, stroke: number | null) => {
    setSelection(stroke === null ? null : { page, stroke });
  }, []);

  function deleteSelected() {
    if (!selection) return;
    const before = getStrokes(selection.page);
    const after = before.filter((_, i) => i !== selection.stroke);
    setStrokes(selection.page, after);
    pushHistory({ page: selection.page, before, after });
    setSelection(null);
  }

  function undo() {
    const item = undoStack.current.pop();
    if (!item) return;
    redoStack.current.push(item);
    setSelection(null);
    setStrokes(item.page, item.before);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    scrollToPage(item.page);
  }

  function redo() {
    const item = redoStack.current.pop();
    if (!item) return;
    undoStack.current.push(item);
    setSelection(null);
    setStrokes(item.page, item.after);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    scrollToPage(item.page);
  }

  function scrollToPage(index: number) {
    const el = pageRefs.current[index];
    const sc = scrollerEl;
    if (!el || !sc) return;
    const r = el.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    if (r.bottom < s.top || r.top > s.bottom) el.scrollIntoView({ block: "center" });
  }

  async function handleClose() {
    if (imageMode) {
      if (dirty.current && !window.confirm(tr.imgDiscardConfirm)) return;
      onClose();
      return;
    }
    if (dirty.current) await doSave();
    // A blank page nobody drew on is not worth keeping in the project.
    const ink = inkRef.current;
    if (inkLoaded.current && ink.blank && Object.values(ink.pages).every((s) => s.length === 0)) {
      try {
        await deleteEntry(entry.path, []);
      } catch {
        // keep it if it cannot be removed
      }
    }
    onClose();
  }

  useEffect(() => {
    saveBarLayout(bar);
  }, [bar]);

  // A floating toolbar stays reachable when the window shrinks.
  useEffect(() => {
    if (bar.dock !== "float") return;
    const keepInside = () => {
      const v = viewerRef.current;
      const b = barRef.current;
      if (!v || !b) return;
      const x = clamp(bar.x, 0, v.clientWidth - b.offsetWidth);
      const y = clamp(bar.y, 0, v.clientHeight - b.offsetHeight);
      if (x !== bar.x || y !== bar.y) setBar({ dock: "float", x, y });
    };
    keepInside();
    window.addEventListener("resize", keepInside);
    return () => window.removeEventListener("resize", keepInside);
  }, [bar]);

  useEffect(() => {
    if (!colorMenu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (menuRef.current?.contains(target as Node) || target?.closest?.(".pdf-viewer__swatch--more")) return;
      setColorMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    const input = customColorRef.current;
    // "change" fires once the picker is dismissed, so one custom colour is one undo step.
    const onCommit = () => {
      if (input) chooseColorRef.current(input.value);
    };
    input?.addEventListener("change", onCommit);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      input?.removeEventListener("change", onCommit);
    };
  }, [colorMenu]);

  const closeRef = useRef(handleClose);
  closeRef.current = handleClose;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => (colorMenu ? setColorMenu(null) : selection ? setSelection(null) : void handleClose());
  const deleteRef = useRef(deleteSelected);
  deleteRef.current = deleteSelected;
  const saveImageRef = useRef<() => void>(() => {});
  saveImageRef.current = () => void handleSaveImage();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        escapeRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (imageMode) saveImageRef.current();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redoRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(messageTimer.current);
    };
  }, []);

  // Last resort: a save that is still pending when the viewer unmounts is written out.
  useEffect(() => {
    return () => {
      if (!imageMode && dirty.current && inkLoaded.current) void savePdfInk(entry.path, serializeInk(inkRef.current)).catch(() => {});
    };
  }, [entry.path]);

  // ----- Scroll tool: drag the page around with the mouse or pen
  function onPanDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "hand" || e.pointerType === "touch" || e.button !== 0) return;
    const sc = e.currentTarget;
    if (e.clientX > sc.getBoundingClientRect().left + sc.clientWidth) return; // the scrollbar itself
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
    setPanning(true);
    try {
      sc.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
  }

  function onPanMove(e: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.id !== e.pointerId) return;
    e.currentTarget.scrollLeft = pan.left - (e.clientX - pan.x);
    e.currentTarget.scrollTop = pan.top - (e.clientY - pan.y);
  }

  function onPanEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (panRef.current?.id === e.pointerId) {
      panRef.current = null;
      setPanning(false);
    }
  }

  // ----- picture mode: bake the strokes into the PNG itself
  async function reloadPicture(blob?: Blob) {
    let source = blob;
    if (!source) {
      const res = await fetch(`${convertFileSrc(entry.path)}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      source = await res.blob();
    }
    const bmp = await createImageBitmap(source);
    setImg(bmp);
    setAspects([bmp.height / bmp.width]);
    inkRef.current = emptyInk();
    undoStack.current = [];
    redoStack.current = [];
    dirty.current = false;
    setUnsaved(false);
    setCanUndo(false);
    setCanRedo(false);
    setSelection(null);
    setRev((r) => r + 1);
  }

  async function handleSaveImage() {
    if (!img || exportState === "busy") return;
    setExportState("busy");
    try {
      const W = img.width;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.drawImage(img, 0, 0);
      const strokes = getStrokes(0);
      // Highlighters multiply with the picture (like on screen), pen strokes go on top of them.
      for (const s of strokes.filter((st) => st.h)) {
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        drawStroke(ctx, s, W);
        ctx.restore();
      }
      for (const s of strokes.filter((st) => !st.h)) drawStroke(ctx, s, W);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("PNG encode failed");
      await saveEditedImage(entry.path, bytesToBase64(new Uint8Array(await blob.arrayBuffer())));
      await reloadPicture(blob);
      setHasOriginal(true);
      onImageSaved?.();
      flashMessage(tr.imgSaved);
    } catch (err) {
      flashMessage(`${tr.pdfSaveError}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportState("idle");
    }
  }

  async function handleRevertImage() {
    if (!window.confirm(tr.imgRevertConfirm)) return;
    try {
      await restoreOriginalImage(entry.path);
      await reloadPicture();
      setHasOriginal(false);
      onImageSaved?.();
    } catch (err) {
      flashMessage(`${tr.pdfSaveError}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ----- export: bake the strokes into a copy of the PDF
  async function handleExport() {
    if (exportState === "busy") return;
    setExportState("busy");
    try {
      if (dirty.current) await doSave();
      const { PDFDocument, rgb, LineCapStyle, BlendMode } = await import("pdf-lib");
      const res = await fetch(pdfUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const source = new Uint8Array(await res.arrayBuffer());
      const out = await PDFDocument.load(source, { ignoreEncryption: true });
      const pages = out.getPages();
      const hex = (c: string) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
        const n = m ? parseInt(m[1], 16) : 0;
        return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
      };
      for (const [key, strokes] of Object.entries(inkRef.current.pages)) {
        const page = pages[Number(key)];
        if (!page || strokes.length === 0) continue;
        const box = page.getCropBox();
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const W = box.width;
        const H = box.height;
        // Strokes are stored in the displayed (rotated) page's coordinates, as fractions of its width.
        const displayWidth = rot === 90 || rot === 270 ? H : W;
        const toPage = (px: number, py: number): [number, number] => {
          const u = px * displayWidth;
          const v = py * displayWidth;
          let x: number;
          let y: number;
          if (rot === 90) {
            x = v;
            y = u;
          } else if (rot === 180) {
            x = W - u;
            y = v;
          } else if (rot === 270) {
            x = W - v;
            y = H - u;
          } else {
            x = u;
            y = H - v;
          }
          return [box.x + x, box.y + y];
        };
        // Highlighter first, so pen strokes always end up on top of it (as on screen).
        const ordered = [...strokes.filter((s) => s.h), ...strokes.filter((s) => !s.h)];
        for (const s of ordered) {
          const pts = s.p.map(([px, py]) => toPage(px, py));
          const color = hex(s.c);
          const base = s.w * displayWidth;
          if (s.h) {
            const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${(-y).toFixed(2)}`).join(" ");
            page.drawSvgPath(pts.length === 1 ? `${d} L ${pts[0][0] + 0.01} ${-pts[0][1]}` : d, {
              x: 0,
              y: 0,
              borderColor: color,
              borderWidth: base,
              borderOpacity: HIGHLIGHT_ALPHA,
              blendMode: BlendMode.Multiply,
              borderLineCap: LineCapStyle.Round,
            });
            continue;
          }
          if (pts.length === 1) {
            page.drawCircle({ x: pts[0][0], y: pts[0][1], size: (base * (0.35 + 1.3 * s.p[0][2])) / 2, color });
            continue;
          }
          for (let i = 1; i < pts.length; i++) {
            const pressure = (s.p[i - 1][2] + s.p[i][2]) / 2;
            page.drawLine({
              start: { x: pts[i - 1][0], y: pts[i - 1][1] },
              end: { x: pts[i][0], y: pts[i][1] },
              thickness: Math.max(0.2, base * (0.35 + 1.3 * Math.min(1, Math.max(0, pressure)))),
              color,
              lineCap: LineCapStyle.Round,
            });
          }
        }
      }
      const bytes = await out.save();
      const path = await exportAnnotatedPdf(title, bytesToBase64(bytes));
      flashMessage(tr.pdfExported(path));
      void revealInFolder(path).catch(() => {});
    } catch (err) {
      flashMessage(`${tr.pdfSaveError}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportState("idle");
    }
  }

  // With a stroke selected, the colour and thickness controls edit that stroke instead of the pen.
  const selectedStroke = selection ? getStrokes(selection.page)[selection.stroke] : undefined;
  const editingSelection = tool === "select" && selectedStroke !== undefined;
  const isHighlighterStroke = editingSelection ? Boolean(selectedStroke?.h) : tool === "highlighter";
  const activeColor = editingSelection && selectedStroke ? selectedStroke.c : isHighlighterStroke ? highlightColor : penColor;
  const palette = isHighlighterStroke ? quick.hl : quick.pen;
  const colorsEnabled = tool === "pen" || tool === "highlighter" || editingSelection;
  const activeSizeIndex =
    editingSelection && selectedStroke
      ? SIZES.reduce((best, size, i) => {
          const w = selectedStroke.w / (selectedStroke.h ? HIGHLIGHT_FACTOR : 1);
          return Math.abs(size - w) < Math.abs(SIZES[best] - w) ? i : best;
        }, 0)
      : sizeIndex;

  function changeSelected(change: Partial<Pick<Stroke, "c" | "w">>) {
    if (!selection) return;
    const before = getStrokes(selection.page);
    if (!before[selection.stroke]) return;
    const after = before.map((s, i) => (i === selection.stroke ? { ...s, ...change } : s));
    setStrokes(selection.page, after);
    pushHistory({ page: selection.page, before, after });
  }

  /** Pick a colour for the pen, the highlighter or the selected stroke, and remember it in the toolbar. */
  function chooseColor(c: string) {
    if (!HEX.test(c)) return;
    if (editingSelection) changeSelected({ c });
    else if (tool === "highlighter") setHighlightColor(c);
    else setPenColor(c);
    const type = isHighlighterStroke ? "hl" : "pen";
    setQuick((q) => {
      if (q[type].includes(c)) return q;
      const next = { ...q, [type]: [c, ...q[type]].slice(0, MAX_QUICK) };
      saveQuickColors(next);
      return next;
    });
  }
  const chooseColorRef = useRef(chooseColor);
  chooseColorRef.current = chooseColor;

  const floating = drag !== null || bar.dock === "float";
  const vertical = floating || bar.dock === "left" || bar.dock === "right";
  const dockNow: Dock = drag ? "float" : bar.dock;

  function openColorMenu(e: React.MouseEvent<HTMLButtonElement>) {
    if (colorMenu) {
      setColorMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const W = 204;
    const H = 240;
    let x: number;
    let y: number;
    if (vertical) {
      x = bar.dock === "right" ? r.left - W - 8 : r.right + 8 + W <= window.innerWidth ? r.right + 8 : r.left - W - 8;
      y = r.top;
    } else {
      x = r.left;
      y = bar.dock === "bottom" ? r.top - H - 8 : r.bottom + 8;
    }
    setColorMenu({ x: clamp(x, 8, window.innerWidth - W - 8), y: clamp(y, 8, window.innerHeight - H - 8) });
  }

  // ----- toolbar: drag it anywhere; dropping it near an edge docks it there
  function onGripDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    const viewer = viewerRef.current;
    const el = barRef.current;
    if (!viewer || !el) return;
    const vr = viewer.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    // The bar changes shape while it is carried, so keep the grip (its top-left corner) under the pointer.
    dragRef.current = { id: e.pointerId, dx: Math.min(e.clientX - br.left, 24), dy: Math.min(e.clientY - br.top, 24) };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    const start = { x: br.left - vr.left, y: br.top - vr.top, hint: null as Dock | null };
    dragLatest.current = start;
    setDrag(start);
    e.preventDefault();
  }

  function onGripMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    const viewer = viewerRef.current;
    const el = barRef.current;
    if (!d || d.id !== e.pointerId || !viewer || !el) return;
    const vr = viewer.getBoundingClientRect();
    const px = e.clientX - vr.left;
    const py = e.clientY - vr.top;
    const next = {
      x: clamp(px - d.dx, 0, vr.width - el.offsetWidth),
      y: clamp(py - d.dy, 0, vr.height - el.offsetHeight),
      hint: nearestEdge(px, py, vr.width, vr.height),
    };
    dragLatest.current = next;
    setDrag(next);
  }

  function onGripUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    const last = dragLatest.current;
    dragLatest.current = null;
    setDrag(null);
    if (!last) return;
    setBar({ dock: last.hint ?? "float", x: last.x, y: last.y });
  }

  return (
    <div className="pdf-viewer" role="dialog" aria-label={title} data-dock={dockNow} ref={viewerRef}>
      {drag?.hint && <div className={`pdf-viewer__dockhint pdf-viewer__dockhint--${drag.hint}`} />}
      <div
        ref={barRef}
        className={`pdf-viewer__bar ${vertical ? "pdf-viewer__bar--vertical" : ""} ${floating ? "pdf-viewer__bar--float" : ""}`}
        style={floating ? { left: drag ? drag.x : bar.x, top: drag ? drag.y : bar.y } : undefined}
      >
        <div className="pdf-viewer__group pdf-viewer__group--head">
        <button
          type="button"
          className="pdf-viewer__btn pdf-viewer__grip"
          title={tr.pdfDragToolbar}
          aria-label={tr.pdfDragToolbar}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onDoubleClick={() => setBar((b) => ({ ...b, dock: "top" }))}
        >
          <Icon name="grip" />
        </button>
        <button type="button" className="pdf-viewer__btn" onClick={() => void handleClose()} title={tr.pdfClose} aria-label={tr.pdfClose}>
          <Icon name="close" />
        </button>
        {imageMode && (
          <button
            type="button"
            className={`pdf-viewer__btn pdf-viewer__btn--save ${unsaved ? "pdf-viewer__btn--save-ready" : ""}`}
            onClick={() => void handleSaveImage()}
            disabled={!img || !unsaved || exportState === "busy"}
            title={`${tr.imgSave} (Ctrl+S)`}
            aria-label={tr.imgSave}
          >
            <Icon name="save" />
          </button>
        )}
        {imageMode && hasOriginal && (
          <button type="button" className="pdf-viewer__btn" onClick={() => void handleRevertImage()} title={tr.imgRevert} aria-label={tr.imgRevert}>
            <Icon name="revert" />
          </button>
        )}
        </div>
        <span className="pdf-viewer__title" title={title}>
          {title}
        </span>

        <div className="pdf-viewer__group">
          {(
            [
              ["pen", tr.pdfPen],
              ["highlighter", tr.pdfHighlighter],
              ["eraser", tr.pdfEraser],
              ["select", tr.pdfSelect],
              ["hand", tr.pdfHand],
            ] as [Tool, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`pdf-viewer__btn ${tool === id ? "pdf-viewer__btn--active" : ""}`}
              onClick={() => {
                setTool(id);
                if (id !== "select") setSelection(null);
              }}
              title={label}
              aria-label={label}
              aria-pressed={tool === id}
            >
              <Icon name={id} />
            </button>
          ))}
          <button
            type="button"
            className="pdf-viewer__btn"
            onClick={deleteSelected}
            disabled={!selection}
            title={tr.pdfDeleteSelected}
            aria-label={tr.pdfDeleteSelected}
          >
            <Icon name="trash" />
          </button>
        </div>

        <div className="pdf-viewer__group pdf-viewer__group--colors" aria-hidden={!colorsEnabled} style={{ opacity: colorsEnabled ? 1 : 0.35 }}>
          {palette.map((c) => (
            <button
              key={c}
              type="button"
              className={`pdf-viewer__swatch ${activeColor === c ? "pdf-viewer__swatch--active" : ""}`}
              style={{ background: c }}
              disabled={!colorsEnabled}
              onClick={() => chooseColor(c)}
              aria-label={c}
            />
          ))}
          <button
            type="button"
            className="pdf-viewer__swatch pdf-viewer__swatch--more"
            disabled={!colorsEnabled}
            onClick={openColorMenu}
            title={tr.pdfMoreColors}
            aria-label={tr.pdfMoreColors}
          >
            +
          </button>
        </div>
        <div className="pdf-viewer__group pdf-viewer__group--sizes" aria-hidden={!colorsEnabled} style={{ opacity: colorsEnabled ? 1 : 0.35 }}>
          {SIZES.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`pdf-viewer__btn pdf-viewer__size ${activeSizeIndex === i ? "pdf-viewer__btn--active" : ""}`}
              disabled={!colorsEnabled}
              onClick={() => {
                if (editingSelection) changeSelected({ w: SIZES[i] * (isHighlighterStroke ? HIGHLIGHT_FACTOR : 1) });
                else setSizeIndex(i);
              }}
              title={tr.pdfSize}
              aria-label={`${tr.pdfSize} ${i + 1}`}
            >
              <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
        </div>

        <div className="pdf-viewer__group">
          <button type="button" className="pdf-viewer__btn" onClick={undo} disabled={!canUndo} title={tr.pdfUndo} aria-label={tr.pdfUndo}>
            <Icon name="undo" />
          </button>
          <button type="button" className="pdf-viewer__btn" onClick={redo} disabled={!canRedo} title={tr.pdfRedo} aria-label={tr.pdfRedo}>
            <Icon name="redo" />
          </button>
        </div>

        <div className="pdf-viewer__group">
          <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} title={tr.pdfZoomOut}>
            −
          </button>
          <span className="pdf-viewer__zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" className="pdf-viewer__btn" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} title={tr.pdfZoomIn}>
            +
          </button>
        </div>

        <span className="pdf-viewer__spacer" />
        <div className="pdf-viewer__group pdf-viewer__group--tail">
        {!imageMode && numPages > 0 && (
          <span className="pdf-viewer__status" title={tr.pdfPageOf(currentPage, numPages)}>
            {currentPage} / {numPages}
          </span>
        )}
        {!imageMode && (
          <span
            className={`pdf-viewer__status pdf-viewer__save pdf-viewer__status--${saveState}`}
            title={saveState === "saving" ? tr.pdfSaving : saveState === "saved" ? tr.pdfSaved : saveState === "error" ? tr.pdfSaveError : ""}
          >
            {saveState === "saving" ? "…" : saveState === "saved" ? "✓" : saveState === "error" ? "!" : ""}
          </span>
        )}
        {!imageMode && (
          <button
            type="button"
            className="pdf-viewer__btn pdf-viewer__btn--export"
            onClick={() => void handleExport()}
            disabled={!doc || exportState === "busy"}
            title={exportState === "busy" ? tr.pdfExporting : tr.pdfExport}
            aria-label={tr.pdfExport}
          >
            <Icon name="download" />
          </button>
        )}
        </div>
      </div>

      {message && <div className="pdf-viewer__message">{message}</div>}

      <div
        className={`pdf-viewer__scroll ${tool === "hand" ? "pdf-viewer__scroll--hand" : ""} ${panning ? "pdf-viewer__scroll--panning" : ""}`}
        ref={setScrollerEl}
        onScroll={updateCurrentPage}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        {loadError ? (
          <div className="pdf-viewer__empty">{loadError}</div>
        ) : (imageMode ? !img : !doc) ? (
          <div className="pdf-viewer__empty">{tr.pdfLoading}</div>
        ) : (
          <div className="pdf-viewer__pages">
            {Array.from({ length: numPages }, (_, i) => (
              <div key={i} ref={(el) => (pageRefs.current[i] = el)}>
                <PdfPage
                  doc={doc}
                  image={img}
                  index={i}
                  cssWidth={cssWidth}
                  aspect={aspects[i] ?? firstAspect}
                  scroller={scrollerEl}
                  rev={rev}
                  tool={tool}
                  color={activeColor}
                  size={SIZES[sizeIndex]}
                  selected={selection?.page === i ? selection.stroke : null}
                  getStrokes={getStrokes}
                  setStrokes={setStrokes}
                  onStrokeAdded={onStrokeAdded}
                  onChanged={onChanged}
                  onSelect={onSelect}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {colorMenu && (
        <div className="pdf-colormenu" ref={menuRef} style={{ left: colorMenu.x, top: colorMenu.y }}>
          <div className="pdf-colormenu__grid">
            {(isHighlighterStroke ? HIGHLIGHT_PRESETS : PEN_PRESETS).map((c) => (
              <button
                key={c}
                type="button"
                className={`pdf-viewer__swatch pdf-colormenu__swatch ${activeColor.toLowerCase() === c ? "pdf-viewer__swatch--active" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  chooseColor(c);
                  setColorMenu(null);
                }}
                aria-label={c}
              />
            ))}
          </div>
          <label className="pdf-colormenu__custom">
            <input ref={customColorRef} type="color" defaultValue={HEX.test(activeColor) ? activeColor : "#111111"} />
            <span>{tr.pdfCustomColor}</span>
          </label>
        </div>
      )}
    </div>
  );
}
