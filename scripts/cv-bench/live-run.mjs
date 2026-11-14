// End-to-end check of the Lab's LIVE camera mode on the synthetic clip of clip.mjs, through Chromium's fake camera: the
// clip frames get a frame-number barcode (8 cells, top-left 128 x 16 px) and are converted to y4m with ffmpeg (gitignored,
// clip-data/clip.y4m), Chromium plays the file as the camera (looping, at the clip's 10 fps), the real page runs
// (lab.html?debug -> "Live camera" -> Start), the calibration is set once with the Auto-calibrate button on a wide frame,
// and every processed frame (window.__labLiveHook) is compared with the ground truth of the frame it shows: median position
// error, recall / precision (pitch space, 5 m gate, wide frames), team accuracy in image space (team-score.mjs), ID
// switches (within a shot / across a cut or the loop restart), detection latency and effective fps.
//   node scripts/cv-bench/live-run.mjs [--data scripts/cv-bench/clip-data] [--port 5192] [--sec 30] [--tiled] [--out live.json]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teamScore } from "./team-score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DATA = opt("data", join(here, "clip-data")), PORT = Number(opt("port", 5192)), SEC = Number(opt("sec", 30)), GATE = 5;
const TILED = args.includes("--tiled");
const gt = JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8"));
const Y4M = join(DATA, "clip.y4m");

// frame-number barcode: cell k (16 px wide) is white when bit k of the frame number is set; neutral chroma under it
if (!existsSync(Y4M) || args.includes("--rebuild")) {
  const geq = "format=yuv420p,geq=lum='if(lt(Y\\,16)*lt(X\\,128)\\,if(mod(floor(N/pow(2\\,floor(X/16)))\\,2)\\,235\\,16)\\,lum(X\\,Y))'" +
    ":cb='if(lt(Y\\,8)*lt(X\\,64)\\,128\\,cb(X\\,Y))':cr='if(lt(Y\\,8)*lt(X\\,64)\\,128\\,cr(X\\,Y))'";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(gt.fps), "-i", join(DATA, "frames", "%04d.png"), "-vf", geq, "-pix_fmt", "yuv420p", Y4M], { stdio: "inherit" });
}

const { createServer } = await import("vite");
const server = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: PORT, strictPort: true, hmr: false, watch: null } });
await server.listen();
let log, calAt = null, prof = null;
try {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${Y4M}`] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  await page.addInitScript(() => {
    window.__liveLog = [];
    window.__labLiveHook = (c, f) => {
      const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, 128, 16).data;
      let code = 0;
      for (let k = 0; k < 8; k++) if (d[(8 * 128 + 16 * k + 8) * 4 + 1] > 128) code |= 1 << k;
      window.__liveLog.push({ code, wall: performance.now(), ...JSON.parse(JSON.stringify(f)) });
    };
  });
  await page.goto(`http://localhost:${PORT}/lab.html?debug`);
  await page.click("#mode-live");
  if (TILED) await page.check("#live-tiled"); else await page.uncheck("#live-tiled");
  await page.click("#cam-start");
  await page.waitForFunction(() => window.__liveLog.length > 3, null, { timeout: 120000 });
  // calibration: the Auto-calibrate button on a wide frame (first second of the clip, far from the cut)
  for (let a = 0; a < 40 && calAt === null; a++) {
    const last = await page.evaluate(() => window.__liveLog.at(-1)?.code ?? -1);
    if (last >= 2 && last <= 45) {
      await page.evaluate(() => window.__labAutoCal());
      const ok = await page.evaluate(() => window.__labState.pts.every(Boolean));
      if (ok) calAt = await page.evaluate(() => performance.now());
    }
    if (calAt === null) await page.waitForTimeout(250);
  }
  if (calAt === null) throw new Error("auto-calibration failed");
  await page.waitForTimeout(SEC * 1000);
  log = await page.evaluate(() => window.__liveLog);
  prof = await page.evaluate(() => window.__labLiveStats?.() ?? null);
  await browser.close();
} finally {
  await server.close();
}

// ---------- comparison ----------
const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const frames = log.filter((f) => f.wall > calAt && f.code < gt.frames.length);
const visible = (g) => g.players.filter((p) => p.inFrame > 0.5);
const errs = [], byGt = new Map();
let nVis = 0, nMatched = 0, nTracked = 0, nCal = 0, nWide = 0;
frames.forEach((f, k) => {
  const g = gt.frames[f.code];
  if (g.view !== "wide") return;
  nWide++;
  if (!f.calibrated) { nVis += visible(g).length; return; }
  nCal++;
  const vis = visible(g), seen = f.players.filter((p) => p.box && p.p);
  nVis += vis.length; nTracked += seen.length;
  const cand = [];
  seen.forEach((s, i) => vis.forEach((v, j) => { const d = Math.hypot(s.p.x - v.pos[0], s.p.y - v.pos[1]); if (d <= GATE) cand.push({ i, j, d }); }));
  cand.sort((a, b) => a.d - b.d);
  const ui = new Set(), uj = new Set();
  for (const c of cand) {
    if (ui.has(c.i) || uj.has(c.j)) continue;
    ui.add(c.i); uj.add(c.j); nMatched++; errs.push(c.d);
    const v = vis[c.j];
    if (!byGt.has(v.id)) byGt.set(v.id, []);
    byGt.get(v.id).push({ k, code: f.code, id: seen[c.i].id });
  }
});
// ID switches: within a shot vs across a cut (a zoom frame or the loop restart between the two matches)
const cutBetween = (a, b) => {
  if (b.code < a.code) return true;
  for (let c = a.code + 1; c <= b.code; c++) if (gt.frames[c].view !== gt.frames[a.code].view) return true;
  return false;
};
let switches = 0, switchesAcrossCut = 0;
for (const seq of byGt.values()) for (let i = 1; i < seq.length; i++) {
  if (seq[i].id === seq[i - 1].id) continue;
  if (cutBetween(seq[i - 1], seq[i])) switchesAcrossCut++; else switches++;
}
const run = { frames: frames.map((f) => ({ t: f.code / gt.fps, status: f.calibrated ? "ok" : "poorCal", players: f.players.filter((p) => p.p) })) };
const ts = teamScore(run, gt);
const span = (frames.at(-1).wall - frames[0].wall) / 1000;
const report = {
  tiled: TILED, frames: frames.length, seconds: +span.toFixed(1), fps: +((frames.length - 1) / span).toFixed(2),
  repeatedFrames: frames.filter((f, i) => i > 0 && f.code === frames[i - 1].code).length, // camera slower than the detector
  detectMs: { median: +q(frames.map((f) => f.ms), 0.5).toFixed(1), p90: +q(frames.map((f) => f.ms), 0.9).toFixed(1) },
  wideFrames: nWide, calibratedWide: nCal / nWide,
  medianErrM: +q(errs, 0.5).toFixed(3), p90ErrM: +q(errs, 0.9).toFixed(3), recall: +(nMatched / nVis).toFixed(3), precision: +(nMatched / nTracked).toFixed(3),
  teamFrameAcc: +ts.frameAcc.toFixed(3), teamTrackAcc: +ts.trackAcc.toFixed(3), idSwitches: switches, idSwitchesAcrossCut: switchesAcrossCut,
  gtPlayersTracked: byGt.size, stats: prof,
};
console.log(JSON.stringify(report, null, 1));
writeFileSync(opt("out", join(DATA, `live-report${TILED ? "-tiled" : ""}.json`)), JSON.stringify({ report, log: frames }, null, 1));
