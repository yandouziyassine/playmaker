// The service worker, built to /sw.js by the plugin in app/src/offline/vitePlugin.ts (production builds only), which
// also replaces __PM_PRECACHE__ (the game page's hashed files) and __PM_VERSION__ (a hash of that list).
// Strategies: see routes.ts. /api/* is never cached; the 3D chunk and the Lab are not precached (network only).
import { CACHE_PREFIX, CONTENT_CACHE, contentKey, isGamePage, MAX_MOMENTS, MOMENTS_CACHE, routeFor, shellCacheName } from "./routes.ts";

declare const __PM_PRECACHE__: string[];
declare const __PM_VERSION__: string;

// Minimal service-worker typings (the project's lib is DOM, not WebWorker).
interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(r: Response | Promise<Response>): void }
interface ExtendableMessageEvent extends ExtendableEvent { data: unknown }
interface SWScope {
  location: Location;
  registration: { active: unknown };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "message", fn: (e: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as SWScope;
const PRECACHE: string[] = __PM_PRECACHE__;
const SHELL = shellCacheName(__PM_VERSION__);
const precache = new Set(PRECACHE);
const KEEP = new Set([SHELL, CONTENT_CACHE, MOMENTS_CACHE]);
const NETWORK_TIMEOUT_MS = 5000;

sw.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })));
    // first install: take over at once (offline works after the first visit). An update waits for the page's
    // "New version available" toast (SKIP_WAITING), so a running game never switches files under the player.
    if (!sw.registration.active) await sw.skipWaiting();
  })());
});

sw.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && !KEEP.has(k)) await caches.delete(k);
    await sw.clients.claim();
  })());
});

sw.addEventListener("message", (e) => {
  const d = e.data as { type?: string; urls?: unknown } | null;
  if (d?.type === "SKIP_WAITING") { void sw.skipWaiting(); return; }
  if (d?.type === "WARM" && Array.isArray(d.urls)) e.waitUntil(warm(d.urls.filter((u): u is string => typeof u === "string")));
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  switch (routeFor(url, { origin: sw.location.origin, method: req.method, mode: req.mode, precache })) {
    case "shell": e.respondWith(shell(req, url)); break;
    case "navigate": e.respondWith(navigate(req, url)); break;
    case "network-first": e.respondWith(networkFirst(req, url)); break;
    case "cache-first": e.respondWith(cacheFirst(req, url)); break;
    default: break; // "none": the browser's own network fetch
  }
});

async function shell(req: Request, url: URL): Promise<Response> {
  return (await caches.match(url.pathname, { cacheName: SHELL })) ?? fetch(req);
}

async function navigate(req: Request, url: URL): Promise<Response> {
  try {
    return await fetch(req);
  } catch (err) {
    const page = isGamePage(url.pathname) ? await caches.match("/index.html", { cacheName: SHELL }) : undefined;
    if (page) return page;
    throw err;
  }
}

async function fetchWithTimeout(req: Request | string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NETWORK_TIMEOUT_MS);
  try { return await fetch(req, { signal: ctl.signal }); } finally { clearTimeout(timer); }
}

async function networkFirst(req: Request | string, url: URL): Promise<Response> {
  const key = contentKey(url);
  try {
    const res = await fetchWithTimeout(req);
    if (res.ok) { const c = await caches.open(CONTENT_CACHE); await c.put(key, res.clone()); }
    return res; // a 404 (no day yet) is passed on, never cached
  } catch (err) {
    const hit = await caches.match(key, { cacheName: CONTENT_CACHE });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req: Request | string, url: URL): Promise<Response> {
  const key = contentKey(url);
  const c = await caches.open(MOMENTS_CACHE);
  const hit = await c.match(key);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { await c.put(key, res.clone()); await trimMoments(c); }
  return res;
}

async function trimMoments(c: Cache) {
  const keys = await c.keys(); // insertion order: the oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MOMENTS))) await c.delete(k);
}

/** The page asks for today's day and moments once it has them: a player who opened the day online can finish it
 * offline, even on the very first visit (when the page's own fetches happened before this worker was in charge). */
async function warm(urls: string[]) {
  for (const u of urls.slice(0, 20)) {
    const url = new URL(u, sw.location.origin);
    const s = routeFor(url, { origin: sw.location.origin, precache });
    try {
      if (s === "network-first") await networkFirst(url.href, url);
      else if (s === "cache-first") await cacheFirst(url.href, url);
    } catch { /* offline or missing: the page's own fetch reports it */ }
  }
}
