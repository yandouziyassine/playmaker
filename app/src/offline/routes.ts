// Which caching strategy the service worker (sw.ts) uses for a request. Pure, so it is unit tested
// (app/test/offline-routes.test.ts) and shared by the worker and its "warm these URLs" message.

export type Strategy =
  /** Not handled: the browser goes to the network as if there were no service worker (/api/*, other origins,
   * POST, the 3D chunk, the Lab, anything not precached). */
  | "none"
  /** A page load: network, then the cached game page when offline. */
  | "navigate"
  /** A precached app-shell file (hashed name: immutable): cache, then network. */
  | "shell"
  /** Days, the day index, the intro sample: network (so a new day shows up), then cache when offline. */
  | "network-first"
  /** Moment files (immutable for a content version): cache, then network. */
  | "cache-first";

export const CACHE_PREFIX = "pm-";
export const shellCacheName = (version: string) => `${CACHE_PREFIX}shell-${version}`;
/** Bump the suffix when the content format changes: activate() deletes every pm-* cache not in use. */
export const CONTENT_CACHE = `${CACHE_PREFIX}content-v1`;
export const MOMENTS_CACHE = `${CACHE_PREFIX}moments-v1`;
/** Moment files kept (a few weeks of days); the oldest go first. */
export const MAX_MOMENTS = 100;

const MOMENT_RE = /^\/content\/moments\/[^/]+\.json$/;
const CONTENT_RE = /^\/content\/(?:days\/[^/]+|[^/]+)\.json$/; // days/*.json (incl. index.json), sample.json

export interface RouteContext {
  /** The worker's own origin: other origins are never touched. */
  origin: string;
  method?: string;
  /** Request.mode: "navigate" for page loads. */
  mode?: string;
  /** Paths of the precached app shell (e.g. "/index.html", "/assets/main-abc.js"). */
  precache: ReadonlySet<string>;
}

export function routeFor(url: URL, ctx: RouteContext): Strategy {
  if ((ctx.method ?? "GET").toUpperCase() !== "GET" || url.origin !== ctx.origin) return "none";
  const p = url.pathname;
  if (p === "/api" || p.startsWith("/api/")) return "none"; // answers are never cached
  if (MOMENT_RE.test(p)) return "cache-first";
  if (CONTENT_RE.test(p)) return "network-first";
  if (p.startsWith("/content/")) return "none";
  if (ctx.mode === "navigate") return "navigate";
  if (ctx.precache.has(p)) return "shell";
  return "none";
}

/** The page the game lives on: offline page loads of these fall back to the cached shell. */
export const isGamePage = (pathname: string) => pathname === "/" || pathname === "/index.html";

/** Cache key of a content file: the path only (a query string must not create a second copy). */
export const contentKey = (url: URL) => url.pathname;
