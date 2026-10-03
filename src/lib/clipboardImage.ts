/**
 * Looks at a browser ClipboardEvent (e.g. from an onPaste handler) for an
 * image -- this is what you get after Win+Shift+S puts a screenshot on the
 * clipboard and the user hits Ctrl+V. Returns a PNG data URL, or null if
 * the clipboard held plain text/nothing usable, so the caller can fall
 * back to normal text paste.
 */
export async function extractImageFromPasteEvent(
  event: ClipboardEvent
): Promise<string | null> {
  const items = event.clipboardData?.items;
  if (!items) return null;

  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) continue;
      return await blobToPngDataUrl(blob);
    }
  }
  return null;
}

function blobToPngDataUrl(blob: Blob): Promise<string> {
  // Re-draw through a canvas so the output is always PNG, regardless of
  // what format the clipboard actually handed us.
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("2D canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not load clipboard image"));
    };
    img.src = objectUrl;
  });
}

/** Strips the "data:image/png;base64," prefix so the backend gets raw base64. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}
