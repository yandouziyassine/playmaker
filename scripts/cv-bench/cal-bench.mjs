// Calibration-only check of the clip frames in Node (no browser): decodes the PNG frames of clip.mjs with ffmpeg at the
// line-search size, runs lines.ts + autocal.ts (full search, then the clip loop's upkeep: seeded refinement and motion
// propagation) and compares each homography with the ground truth (mean pitch error, metres, over the visible grass).
//   node --experimental-strip-types scripts/cv-bench/cal-bench.mjs [--data scripts/cv-bench/clip-data] [--step 2] [--full]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DATA = opt("data", join(here, "clip-data")), STEP = Number(opt("step", 2));
const gt = JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8"));
const L = await import(new URL("../../app/src/lab/lines.ts", import.meta.url).href);
const A = await import(new URL("../../app/src/lab/autocal.ts", import.meta.url).href);
const Hm = await import(new URL("../../app/src/lab/homography.ts", import.meta.url).href);
const W = 640, Hh = Math.round((W * gt.h) / gt.w), scale = W / gt.w;

function decode(i) {
  const f = join(DATA, "frames", `${String(i).padStart(4, "0")}.png`);
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", `scale=${W}:${Hh}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 });
  return { width: W, height: Hh, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) };
}

/** Mean distance (m) between the pitch points that the two homographies (pitch -> source px) give for a grid of image points. */
function pitchErr(Hs, Hg) {
  const a = Hm.invert3(Hs), b = Hm.invert3(Hg);
  if (!a || !b) return Infinity;
  const ds = [];
  for (let y = gt.h * 0.35; y < gt.h; y += gt.h / 10) for (let x = 0; x <= gt.w; x += gt.w / 10) {
    const p = Hm.applyH(a, { x, y }), q = Hm.applyH(b, { x, y });
    if (!p || !q || Math.abs(q.x) > 60 || Math.abs(q.y) > 40) continue;
    ds.push(Math.hypot(p.x - q.x, p.y - q.y));
  }
  ds.sort((u, v) => u - v);
  return ds.length ? ds[Math.floor(ds.length / 2)] : Infinity;
}

const rows = [];
let H = null, prevScan = null, ok = 0, okGood = 0, n = 0;
for (let i = 0; i < gt.frames.length; i += STEP) {
  const g = gt.frames[i];
  const img = decode(i);
  const scan = L.scanLines(img, scale, []);
  const t0 = performance.now();
  const res = A.autoCalibrate(scan);
  const full = res.best;
  let mode = "full", sol = full && full.rating !== "poor" ? full : null;
  if (sol && args.includes("--polish")) sol = A.polishCalibration(scan, sol);
  if (!sol && !args.includes("--nocircle")) { const c = A.centreCircleCalibrate(scan); if (c) { sol = c; mode = "circ"; } }
  if (!sol && H && !args.includes("--full")) {
    const p = A.propagateCalibration(scan, H);
    if (p) { sol = p; mode = `prop(${p.motion.x},${p.motion.y})`; }
  }
  const ms = performance.now() - t0;
  const err = sol ? pitchErr(sol.H, g.H) : null;
  n++;
  if (sol) { ok++; if (err < 1.5) okGood++; H = sol.H; } else H = null;
  prevScan = scan;
  rows.push(`${g.t.toFixed(1)} ${g.view.padEnd(4)} lines ${String(scan.lines.length).padStart(2)} ${sol ? `${mode} ${sol.rating.padEnd(5)} err ${err.toFixed(2)} m` : `FAIL (${res.reason ?? full?.rating ?? "?"} fit ${full?.fitWork?.toFixed(2) ?? "-"} inl ${full?.inliers ?? "-"} errIfUsed ${full ? pitchErr(full.H, g.H).toFixed(2) : "-"})`} ${ms.toFixed(0)} ms`);
}
console.log(rows.join("\n"));
console.log(`calibrated ${ok}/${n} (${((100 * ok) / n).toFixed(0)} %), within 1.5 m: ${okGood}/${n}`);
