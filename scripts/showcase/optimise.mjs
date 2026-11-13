// Raw README screenshots -> small WebPs in docs/img/ (needs ffmpeg with libwebp on the PATH).
// Usage: node scripts/showcase/optimise.mjs <raw-dir> [out=docs/img] [width=540]
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [raw = "showcase-raw", out = "docs/img", width = "540"] = process.argv.slice(2);
const keep = { "1-intro": "intro", "2-choose": "choose-2d", "3-reveal": "reveal", "4-3d-stadium": "3d-stadium", "5-lab": "lab-autocal", "6-free-play": "free-play" };
mkdirSync(out, { recursive: true });
for (const f of readdirSync(raw)) {
  const name = keep[path.basename(f, ".png")];
  if (!name) continue;
  const dst = path.join(out, `${name}.webp`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(raw, f), "-vf", `scale=${width}:-2:flags=lanczos`, "-c:v", "libwebp", "-quality", "80", "-compression_level", "6", dst]);
  console.log(dst, (statSync(dst).size / 1024).toFixed(0), "kB");
}
