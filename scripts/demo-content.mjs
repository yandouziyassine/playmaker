// Package the first N days of a content release for the static demo (GitHub Pages): public moment files, the answer
// files (scored in the browser in the demo: see app/src/demo.ts), a trimmed day index, the sample moment and demo.json.
// Usage: node scripts/demo-content.mjs <content-vN folder> [days=30]   -> demo/content/
import fs from "node:fs";
import path from "node:path";

const [src, daysArg = "30"] = process.argv.slice(2);
if (!src || !fs.existsSync(path.join(src, "public", "days", "index.json"))) {
  console.error("usage: node scripts/demo-content.mjs <content-vN folder> [days]");
  process.exit(1);
}
const n = Number(daysArg);
const dst = path.resolve("demo/content");
fs.rmSync(dst, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const index = JSON.parse(fs.readFileSync(path.join(src, "public/days/index.json"), "utf8"));
const days = index.days.slice(0, n);
let moments = 0;
for (const d of days) {
  copy(path.join(src, "public/days", `${d.date}.json`), path.join(dst, "days", `${d.date}.json`));
  const day = JSON.parse(fs.readFileSync(path.join(src, "public/days", `${d.date}.json`), "utf8"));
  for (const id of day.moments) {
    copy(path.join(src, "public/moments", `${id}.json`), path.join(dst, "moments", `${id}.json`));
    copy(path.join(src, "answers", `${id}.json`), path.join(dst, "answers", `${id}.json`));
    moments++;
  }
}
fs.writeFileSync(path.join(dst, "days", "index.json"), JSON.stringify({ days }));
if (fs.existsSync(path.join(src, "public/sample.json"))) copy(path.join(src, "public/sample.json"), path.join(dst, "sample.json"));
fs.writeFileSync(path.join(dst, "demo.json"), JSON.stringify({ start: days[0].date, days: days.length }));
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`demo content: ${days.length} days, ${moments} moments, ${(size(dst) / 1e6).toFixed(1)} MB -> ${dst}`);
