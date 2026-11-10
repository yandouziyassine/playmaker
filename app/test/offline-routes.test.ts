import { describe, expect, it } from "vitest";
import { routeFor, type RouteContext } from "../src/offline/routes.ts";
import { htmlRefs, precacheList, versionOf, type BundleFile } from "../src/offline/vitePlugin.ts";
import { swEnabled } from "../src/offline/register.ts";

const O = "https://playmaker.example";
const ctx: RouteContext = { origin: O, precache: new Set(["/index.html", "/assets/main-abc.js", "/assets/main-abc.css"]) };
const r = (path: string, extra: Partial<RouteContext> = {}) => routeFor(new URL(path, O), { ...ctx, ...extra });

describe("routeFor (service worker strategies)", () => {
  it("days, the day index and the sample: network first", () => {
    expect(r("/content/days/2026-12-01.json")).toBe("network-first");
    expect(r("/content/days/index.json")).toBe("network-first");
    expect(r("/content/days/2026-12-01.json?x=1")).toBe("network-first");
    expect(r("/content/sample.json")).toBe("network-first");
  });
  it("moments: cache first", () => {
    expect(r("/content/moments/1886347-0-1299.json")).toBe("cache-first");
  });
  it("never the API, another origin, a POST, or unknown content", () => {
    expect(r("/api/pick")).toBe("none");
    expect(r("/api/pick", { method: "POST" })).toBe("none");
    expect(r("/api")).toBe("none");
    expect(r("/content/moments/x.json", { method: "POST" })).toBe("none");
    expect(routeFor(new URL("https://cdn.example/assets/main-abc.js"), ctx)).toBe("none");
    expect(r("/content/answers/x.json".replace("answers", "moments/deep/x"))).toBe("none");
    expect(r("/content/days/../secret.txt")).toBe("none");
  });
  it("page loads: navigate; precached shell files: shell; the rest (3D chunk, Lab): network only", () => {
    expect(r("/", { mode: "navigate" })).toBe("navigate");
    expect(r("/lab.html", { mode: "navigate" })).toBe("navigate");
    expect(r("/assets/main-abc.js")).toBe("shell");
    expect(r("/index.html")).toBe("shell");
    expect(r("/assets/view-3d.js")).toBe("none");
    expect(r("/assets/lab-xyz.js")).toBe("none");
  });
});

describe("precache list (build)", () => {
  const css = (...f: string[]) => ({ importedCss: new Set(f), importedAssets: new Set<string>() });
  const bundle: Record<string, BundleFile> = {
    "index.html": { type: "asset", fileName: "index.html" },
    "assets/main-1.js": { type: "chunk", fileName: "assets/main-1.js", imports: ["assets/icons-2.js"], viteMetadata: css("assets/main-1.css") },
    "assets/icons-2.js": { type: "chunk", fileName: "assets/icons-2.js", imports: [], viteMetadata: css("assets/ui-3.css") },
    "assets/view-9.js": { type: "chunk", fileName: "assets/view-9.js", imports: ["assets/icons-2.js"] }, // dynamic import only
    "assets/lab-4.js": { type: "chunk", fileName: "assets/lab-4.js", imports: [] },
  };
  const html = `<link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest">
    <script type="module" crossorigin src="/assets/main-1.js"></script><link rel="modulepreload" href="/assets/icons-2.js">
    <link rel="stylesheet" href="/assets/main-1.css"><link rel="preconnect" href="https://fonts.example">`;
  it("reads the page's references (same origin only)", () => {
    expect(htmlRefs(html)).toEqual(["/favicon.svg", "/manifest.webmanifest", "/assets/main-1.js", "/assets/icons-2.js", "/assets/main-1.css"]);
  });
  it("follows static imports and CSS, leaves out lazy chunks and other pages", () => {
    const list = precacheList(bundle, "index.html", html);
    expect(list).toEqual(["/assets/icons-2.js", "/assets/main-1.css", "/assets/main-1.js", "/assets/ui-3.css", "/favicon.svg", "/index.html", "/manifest.webmanifest"]);
    expect(versionOf(list)).toMatch(/^[0-9a-f]{10}$/);
    expect(versionOf(list)).not.toBe(versionOf([...list, "/assets/x.js"]));
  });
  it("adds every stylesheet, so lazily imported CSS (the stats card) renders offline", () => {
    const lazy = { ...bundle, "assets/stats-5.css": { type: "asset", fileName: "assets/stats-5.css" } as BundleFile };
    expect(precacheList(lazy, "index.html", html)).toContain("/assets/stats-5.css");
    expect(precacheList(lazy, "index.html", html)).not.toContain("/assets/view-9.js");
  });
});

describe("swEnabled", () => {
  it("production only; on localhost only with ?sw=1", () => {
    expect(swEnabled(false, "playmaker.example", "")).toBe(false);
    expect(swEnabled(true, "playmaker.example", "")).toBe(true);
    expect(swEnabled(true, "localhost", "?date=2026-12-01")).toBe(false);
    expect(swEnabled(true, "127.0.0.1", "")).toBe(false);
    expect(swEnabled(true, "localhost", "?sw=1&date=2026-12-01")).toBe(true);
  });
});
