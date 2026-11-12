// Static demo build for GitHub Pages: the app built with VITE_DEMO=1 under the repo's base path, plus the packaged demo
// content copied to dist/content. Usage: node scripts/demo-build.mjs [base=/playmaker/]
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "/playmaker/";
if (!fs.existsSync("demo/content/demo.json")) {
  console.error("demo/content is missing: run node scripts/demo-content.mjs <release> first");
  process.exit(1);
}
execSync(`npx vite build --base=${base}`, { stdio: "inherit", env: { ...process.env, VITE_DEMO: "1" } });
fs.cpSync("demo/content", path.join("dist", "content"), { recursive: true });
fs.writeFileSync(path.join("dist", ".nojekyll"), ""); // serve files and folders as they are
console.log(`demo build ready in dist/ (base ${base})`);
