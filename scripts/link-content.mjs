import fs from "node:fs";
import path from "node:path";
const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, "release.json"))) { console.error("usage: npm run content:link -- <content-vN folder>"); process.exit(1); }
const dest = path.resolve("content");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log("content ->", dest);
