// Build-time half of the service worker (Node, used by vite.config.ts): emits app/src/offline/sw.ts as /sw.js and,
// once the bundle is written, injects the game page's precache list (index.html, its hashed JS/CSS and their static
// imports; not the lazy 3D chunk, not the Lab / replay / about pages) and a version hash of that list.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SW_SRC = fileURLToPath(new URL("./sw.ts", import.meta.url));
export const SW_FILE = "sw.js";

/** The bits of a Rollup output chunk / asset this needs (kept small for the unit test). */
export interface BundleFile {
  type: "chunk" | "asset";
  fileName: string;
  imports?: string[];
  viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> };
}

/** Files referenced by the built game page (script src, stylesheet / modulepreload / icon / manifest href). */
export function htmlRefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    const ref = m[1]!;
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue; // other origins
    out.push(ref.startsWith("/") ? ref : `/${ref.replace(/^\.\//, "")}`);
  }
  return out;
}

/** The precache list: the page, what it references and, for each JS file, its static imports, CSS and assets
 * (recursively). Dynamic imports (the 3D view) are left out on purpose. Sorted, de-duplicated, root-relative. */
export function precacheList(bundle: Record<string, BundleFile>, page: string, html: string, extra: string[] = []): string[] {
  const out = new Set<string>([`/${page}`, ...extra]);
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.add(`/${file}`);
    const f = bundle[file];
    if (!f || f.type !== "chunk") return;
    for (const i of f.imports ?? []) visit(i);
    for (const c of f.viteMetadata?.importedCss ?? []) visit(c);
    for (const a of f.viteMetadata?.importedAssets ?? []) visit(a);
  };
  for (const ref of htmlRefs(html)) {
    const file = ref.slice(1);
    if (bundle[file]) visit(file); else out.add(ref); // public/ files (favicon, manifest)
  }
  return [...out].sort();
}

export const versionOf = (list: string[]) => createHash("sha1").update(list.join("\n")).digest("hex").slice(0, 10);

export function swPlugin(page = "index.html"): Plugin {
  return {
    name: "playmaker-sw",
    apply: "build",
    buildStart() {
      this.emitFile({ type: "chunk", id: SW_SRC, fileName: SW_FILE });
    },
    writeBundle(opts, bundle) {
      const dir = opts.dir ?? path.dirname(opts.file ?? "");
      const swPath = path.join(dir, SW_FILE);
      const htmlPath = path.join(dir, page);
      if (!fs.existsSync(swPath) || !fs.existsSync(htmlPath)) return;
      const list = precacheList(bundle as unknown as Record<string, BundleFile>, page, fs.readFileSync(htmlPath, "utf8"));
      const code = fs.readFileSync(swPath, "utf8");
      if (!code.includes("__PM_PRECACHE__")) throw new Error("playmaker-sw: __PM_PRECACHE__ not found in sw.js");
      fs.writeFileSync(swPath, code.replaceAll("__PM_PRECACHE__", JSON.stringify(list)).replaceAll("__PM_VERSION__", JSON.stringify(versionOf(list))));
      this.info?.(`precache: ${list.length} files`);
    },
  };
}
