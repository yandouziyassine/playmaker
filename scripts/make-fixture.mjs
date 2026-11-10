import fs from "node:fs";
import path from "node:path";
const [src, date] = process.argv.slice(2);
const dst = path.resolve("tests/fixtures/content");
fs.rmSync(dst, { recursive: true, force: true });
const day = JSON.parse(fs.readFileSync(path.join(src, "public/days", `${date}.json`), "utf8"));
const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true }); fs.copyFileSync(path.join(src, rel), path.join(dst, rel)); };
copy(`public/days/${date}.json`);
if (fs.existsSync(path.join(src, "public/sample.json"))) copy("public/sample.json");
for (const m of day.moments) { copy(`public/moments/${m}.json`); copy(`answers/${m}.json`); }
fs.cpSync(path.join(src, "schemas"), path.join(dst, "schemas"), { recursive: true });
console.log("fixture day", date, day.moments);
