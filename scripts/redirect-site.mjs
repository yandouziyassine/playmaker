// The game moved to https://playmaker-game.github.io. The old address (yandouziyassine.github.io/playmaker/) keeps
// working as a redirect: every page keeps its path, query and fragment (so #code= player links still import).
// Usage: node scripts/redirect-site.mjs  -> dist-redirect/
import fs from "node:fs";
import path from "node:path";

const TARGET = "https://playmaker-game.github.io";
const OLD_BASE = "/playmaker";
const out = "dist-redirect";
fs.rmSync(out, { recursive: true, force: true });
const page = (p) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Playmaker has moved</title>
<link rel="canonical" href="${TARGET}${p}">
<meta http-equiv="refresh" content="0; url=${TARGET}${p}">
<meta name="robots" content="noindex">
<script>location.replace(${JSON.stringify(TARGET)} + location.pathname.replace(${JSON.stringify(OLD_BASE)}, "") + location.search + location.hash);</script>
</head><body style="font-family:system-ui;background:#06120c;color:#eef6ef;padding:2rem">
<p>Playmaker has moved to <a style="color:#4cc9f0" href="${TARGET}${p}">${TARGET.replace("https://", "")}</a>.</p>
</body></html>
`;
for (const p of ["/", "/replay.html", "/lab.html", "/about.html"]) {
  const file = p === "/" ? "index.html" : p.slice(1);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, file), page(p));
}
fs.copyFileSync(path.join(out, "index.html"), path.join(out, "404.html"));
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`redirect site ready in ${out}/`);
