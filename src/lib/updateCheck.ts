// Checks GitHub for a newer MindPipe release. Notice only: nothing is downloaded
// or installed; the user is sent to the release page.

const LATEST_RELEASE_API = "https://api.github.com/repos/YusufB5/MindPipe/releases/latest";
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const KEY_ENABLED = "mindpipe_update_check";
const KEY_SKIPPED = "mindpipe_update_skipped";
const KEY_CACHE = "mindpipe_update_cache";

/** How often a running app re-evaluates the (cached) check; GitHub is hit at most once per CHECK_INTERVAL_MS. */
export const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
}

interface CacheEntry {
  checkedAt: number;
  version: string;
  url: string;
  notes?: string;
}

export interface NoteLine {
  bullet: boolean;
  text: string;
}

const MAX_NOTE_LINES = 12;
const NEWLINE = String.fromCharCode(10);

/** Turns a GitHub release body (markdown) into a few plain lines for the banner. */
export function formatReleaseNotes(body: string): NoteLine[] {
  const lines: NoteLine[] = [];
  for (const raw of body.split(NEWLINE)) {
    const trimmed = raw.trim();
    if (!trimmed || /^see the assets below/i.test(trimmed) || /^download the installer/i.test(trimmed)) continue;
    const bullet = /^[-*]\s+/.test(trimmed);
    const text = trimmed
      .replace(/^[-*]\s+/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    if (text) lines.push({ bullet, text });
    if (lines.length >= MAX_NOTE_LINES) break;
  }
  return lines;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: ignore */
  }
}

export function isUpdateCheckEnabled(): boolean {
  return readStorage(KEY_ENABLED) !== "off";
}

export function setUpdateCheckEnabled(enabled: boolean) {
  writeStorage(KEY_ENABLED, enabled ? "on" : "off");
}

export function skipUpdateVersion(version: string) {
  writeStorage(KEY_SKIPPED, version);
}

function parseVersion(raw: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function fetchLatest(): Promise<CacheEntry | null> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const tag = typeof data?.tag_name === "string" ? data.tag_name : "";
  const url = typeof data?.html_url === "string" ? data.html_url : "";
  if (!parseVersion(tag) || !url.startsWith("https://github.com/")) return null;
  const notes = typeof data?.body === "string" ? data.body : "";
  return { checkedAt: Date.now(), version: tag.replace(/^v/, ""), url, notes };
}

/** Returns the newer release to announce, or null (disabled, up to date, skipped, or offline). */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (!isUpdateCheckEnabled()) return null;

  let entry: CacheEntry | null = null;
  const cachedRaw = readStorage(KEY_CACHE);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CacheEntry;
      if (Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) entry = cached;
    } catch {
      /* bad cache: refetch */
    }
  }

  if (!entry) {
    try {
      entry = await fetchLatest();
    } catch {
      return null;
    }
    if (!entry) return null;
    writeStorage(KEY_CACHE, JSON.stringify(entry));
  }

  if (!isNewerVersion(entry.version, currentVersion)) return null;
  if (readStorage(KEY_SKIPPED) === entry.version) return null;
  return { version: entry.version, url: entry.url, notes: entry.notes ?? "" };
}
