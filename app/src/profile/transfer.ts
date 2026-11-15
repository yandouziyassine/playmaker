/** Player codes: move a player's progress between devices with no account and no server.
 *
 * Everything the game remembers lives in localStorage under keys that start with "pm." (storage.ts). A player code is
 * those keys, as JSON, deflate-compressed and base64url-encoded, behind a version tag and a CRC-32 so typos and
 * truncated pastes are caught: "PM1.<crc32 hex>.<payload>". The code can be copied, saved as a file or opened as a
 * link (#code=...): a URL fragment never reaches any server.
 *
 * Importing MERGES with what the device already has (a new phone may already hold a day or two): days, live days and
 * moment records are unions; for a day present on both sides the version with more answered moments wins. The player
 * id of the device is kept (it is only a random id for the optional crowd API), and so are device-only flags. */

export const CODE_VERSION = "PM1";
const PREFIX = "pm.";
/** Keys that describe this device, not the player: never exported, never overwritten. */
const DEVICE_ONLY = new Set(["pm.player"]);

export interface KVStore {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export type Snapshot = Record<string, string>;

/** The pm.* keys worth carrying to another device. */
export function snapshot(kv: KVStore): Snapshot {
  const out: Snapshot = {};
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (!k || !k.startsWith(PREFIX) || DEVICE_ONLY.has(k)) continue;
    const v = kv.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

// ---- CRC-32 (IEEE), for typo detection ----
let TABLE: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- base64url ----
export function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

export async function encode(snap: Snapshot): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(snap));
  const packed = await pipe(raw, new CompressionStream("deflate-raw"));
  return `${CODE_VERSION}.${crc32(raw).toString(16).padStart(8, "0")}.${toB64url(packed)}`;
}

export type DecodeError = "format" | "version" | "corrupt";
export class CodeError extends Error {
  constructor(public reason: DecodeError) { super(`player code: ${reason}`); }
}

/** Accepts the bare code, a pasted link containing #code=..., and stray spaces or line breaks. */
export function extractCode(text: string): string {
  const t = text.replace(/\s+/g, "");
  const m = /[#&?]code=([^&]+)/.exec(t);
  return m ? decodeURIComponent(m[1]!) : t;
}

export async function decode(text: string): Promise<Snapshot> {
  const parts = extractCode(text).split(".");
  if (parts.length !== 3 || !/^[0-9a-f]{8}$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw new CodeError("format");
  if (parts[0] !== CODE_VERSION) throw new CodeError("version");
  let raw: Uint8Array;
  try { raw = await pipe(fromB64url(parts[2]!), new DecompressionStream("deflate-raw")); } catch { throw new CodeError("corrupt"); }
  if (crc32(raw).toString(16).padStart(8, "0") !== parts[1]) throw new CodeError("corrupt");
  let snap: unknown;
  try { snap = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new CodeError("corrupt"); }
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) throw new CodeError("corrupt");
  const out: Snapshot = {};
  for (const [k, v] of Object.entries(snap as Record<string, unknown>)) {
    if (k.startsWith(PREFIX) && !DEVICE_ONLY.has(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

// ---- merge ----
function parse<T>(s: string | undefined, fallback: T): T {
  if (s === undefined) return fallback;
  try { const v = JSON.parse(s) as T; return v ?? fallback; } catch { return fallback; }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type Rec = { id?: unknown };
function mergeRecordLists(a: unknown, b: unknown): Rec[] {
  const byId = new Map<string, Rec>();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const r of list as Rec[]) if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Merges an imported snapshot into the device's one; returns the keys/values to write. Pure. */
export function merge(local: Snapshot, incoming: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [k, v] of Object.entries(incoming)) {
    const mine = local[k];
    if (mine === undefined) { out[k] = v; continue; }
    if (mine === v) continue;
    if (k === "pm.days") {
      const a = parse<Record<string, unknown>>(mine, {}), b = parse<Record<string, unknown>>(v, {});
      const m: Record<string, unknown> = isObj(a) ? { ...a } : {};
      if (isObj(b)) for (const [d, pts] of Object.entries(b)) {
        const cur = m[d];
        if (!Array.isArray(cur) || (Array.isArray(pts) && pts.length > cur.length)) m[d] = pts;
      }
      out[k] = JSON.stringify(m);
    } else if (k === "pm.live") {
      const a = parse<unknown[]>(mine, []), b = parse<unknown[]>(v, []);
      const set = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter((x) => typeof x === "string"));
      out[k] = JSON.stringify([...set].sort());
    } else if (k === "pm.moments") {
      const a = parse<Record<string, unknown>>(mine, {}), b = parse<Record<string, unknown>>(v, {});
      const m: Record<string, unknown> = {};
      for (const d of new Set([...Object.keys(isObj(a) ? a : {}), ...Object.keys(isObj(b) ? b : {})])) {
        m[d] = mergeRecordLists(isObj(a) ? a[d] : undefined, isObj(b) ? b[d] : undefined);
      }
      out[k] = JSON.stringify(m);
    }
    // Any other key that exists on both sides (flags, settings, training state): the device keeps its own value.
  }
  return out;
}

export interface ImportSummary { days: number; moments: number; written: number }

/** Decodes a code and merges it into storage. Throws CodeError on a bad code. */
export async function importCode(kv: KVStore, text: string): Promise<ImportSummary> {
  const incoming = await decode(text);
  const writes = merge(snapshot(kv), incoming);
  for (const [k, v] of Object.entries(writes)) kv.setItem(k, v);
  const days = Object.keys(parse<Record<string, unknown>>(incoming["pm.days"], {})).length;
  const mo = parse<Record<string, unknown[]>>(incoming["pm.moments"], {});
  const moments = Object.values(isObj(mo) ? mo : {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  return { days, moments, written: Object.keys(writes).length };
}

/** A link that opens the game and offers to import (the code rides in the fragment, never sent to a server). */
export function codeLink(base: string, code: string): string {
  return `${base.split("#")[0]}#code=${encodeURIComponent(code)}`;
}

// ---- nickname (local display name; shown on the share card and the profile, never sent anywhere) ----
export const NAME_KEY = "pm.name";
export function cleanName(s: string): string {
  return s.normalize("NFC").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}
