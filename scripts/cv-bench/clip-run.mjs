// End-to-end check of the Lab's video clip mode on the synthetic clip of clip.mjs (no downloaded video): a throw-away Vite
// dev server, headless Chromium, the real page (lab.html?debug -> "Video clip" -> file input), then the tracked positions are
// compared with the ground truth: median position error, recall, team purity, ID switches, cut detection, ball error and
// the team numbers (clip.ts) computed from the tracked players vs from the true positions of the players in view.
//   node scripts/cv-bench/clip-run.mjs [--data scripts/cv-bench/clip-data] [--port 5191] [--notiled] [--shot out.png]
//     [--loop '{"tracker":"nn","fullScanEvery":3,"motion":false,"circle":false,"polish":false}'] (cliprun.ts CLIP_LOOP switches)
//     [--out report.json] [--gpu] (lab.html?gpu: the WebGL delegate)
//   prints the per-stage timings of cliprun.ts (prof.ts, window.__clipProf) after the accuracy report
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teamScore } from "./team-score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DATA = opt("data", join(here, "clip-data")), PORT = Number(opt("port", 5191)), GATE = 5;
const gt = JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8"));
const clipTs = await import(new URL("../../app/src/lab/clip.ts", import.meta.url).href); // node --experimental-strip-types

const { createServer } = await import("vite");
const server = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: PORT, strictPort: true, hmr: false, watch: null } });
await server.listen();
let run, wall, prof;
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const loop = opt("loop", null);
  if (loop) await page.addInitScript((o) => { window.__clipLoop = JSON.parse(o); }, loop);
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  await page.goto(`http://localhost:${PORT}/lab.html?debug${args.includes("--gpu") ? "&gpu" : ""}`);
  await page.click("#mode-clip");
  if (args.includes("--notiled")) await page.uncheck("#clip-tiled");
  const t0 = Date.now();
  await page.setInputFiles("#clip-file", join(DATA, "clip.webm"));
  let last = "";
  for (;;) {
    run = await page.evaluate(() => window.__labClip());
    if (run) break;
    const msg = await page.textContent("#clip-msg");
    if (msg !== last && /\d+ of \d+/.test(msg ?? "")) { const m = msg.match(/(\d+) of (\d+)/); if (m && Number(m[1]) % 10 === 0) process.stdout.write(`  ${msg}\n`); }
    last = msg;
    if (/failed|cannot/i.test(msg ?? "")) throw new Error(msg);
    await page.waitForTimeout(500);
  }
  wall = (Date.now() - t0) / 1000;
  prof = await page.evaluate(() => window.__clipProf ?? null); // cliprun.ts stage timings (prof.ts)
  await page.waitForTimeout(800);
  const shot = opt("shot", null);
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  await browser.close();
} finally {
  await server.close();
}

// ---------- comparison ----------
const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const visible = (g) => g.players.filter((p) => p.inFrame > 0.5);
const errs = [], ballErrs = [], pairs = new Map(), byGt = new Map(), statusAt = [];
let nVis = 0, nMatched = 0, nTracked = 0;
run.frames.forEach((f, k) => {
  const g = gt.frames[Math.min(gt.frames.length - 1, Math.round(f.t * gt.fps))];
  statusAt.push({ k, t: f.t, view: g.view, status: f.status, cut: f.cut, rating: f.rating });
  if (f.status !== "ok" || g.view !== "wide") return;
  const vis = visible(g), seen = f.players.filter((p) => p.box);
  nVis += vis.length; nTracked += seen.length;
  // greedy one-to-one matching, closest pairs first, within GATE metres
  const cand = [];
  seen.forEach((s, i) => vis.forEach((v, j) => { const d = Math.hypot(s.p.x - v.pos[0], s.p.y - v.pos[1]); if (d <= GATE) cand.push({ i, j, d }); }));
  cand.sort((a, b) => a.d - b.d);
  const ui = new Set(), uj = new Set();
  for (const c of cand) {
    if (ui.has(c.i) || uj.has(c.j)) continue;
    ui.add(c.i); uj.add(c.j); nMatched++;
    errs.push(c.d);
    const s = seen[c.i], v = vis[c.j];
    const key = `${s.team}:${v.team}`; pairs.set(key, (pairs.get(key) ?? 0) + 1);
    if (!byGt.has(v.id)) byGt.set(v.id, []);
    byGt.get(v.id).push({ k, id: s.id, cutBefore: false });
  }
  if (f.ball && g.ball) ballErrs.push(Math.hypot(f.ball.x - g.ball.pos[0], f.ball.y - g.ball.pos[1]));
});
// team mapping (our label -> true team) by majority
const direct = (pairs.get("0:0") ?? 0) + (pairs.get("1:1") ?? 0), swapped = (pairs.get("0:1") ?? 0) + (pairs.get("1:0") ?? 0);
const map = direct >= swapped ? [0, 1] : [1, 0];
const teamOk = Math.max(direct, swapped), teamAll = [...pairs.values()].reduce((a, b) => a + b, 0);
// ID switches: a true player matched to a different track id than on his previous match (split by: across a cut / not)
const cutKs = run.frames.map((f, k) => (f.cut || f.status !== "ok" ? k : -1)).filter((k) => k >= 0);
let switches = 0, switchesAcrossCut = 0;
for (const seq of byGt.values()) for (let i = 1; i < seq.length; i++) {
  if (seq[i].id === seq[i - 1].id) continue;
  if (cutKs.some((c) => c > seq[i - 1].k && c <= seq[i].k)) switchesAcrossCut++; else switches++;
}
// team numbers from the tracked players vs from the true positions of the players in view (same frames, same code)
const okFrames = run.frames.filter((f, k) => f.status === "ok" && gt.frames[Math.round(f.t * gt.fps)]?.view === "wide");
const truth = okFrames.map((f) => {
  const g = gt.frames[Math.round(f.t * gt.fps)];
  return { ...f, ball: { x: g.ball.pos[0], y: g.ball.pos[1] }, players: visible(g).filter((p) => p.role !== "ref").map((p) => ({ id: p.id, team: map[p.team], p: { x: p.pos[0], y: p.pos[1] }, v: null, box: {} })) };
});
const sides = clipTs.guessSides(okFrames), sidesGt = clipTs.guessSides(truth);
const trueSides = [-gt.attack[map[0]], -gt.attack[map[1]]]; // own goal = minus the attacking direction
const ours = clipTs.teamNumbers(okFrames, trueSides), theirs = clipTs.teamNumbers(truth, trueSides);
const possOurs = clipTs.possessionShare(okFrames), possGt = clipTs.possessionShare(truth);
const d = clipTs.diagnostics(run.frames, run.fps);
const f1 = (v) => (v === null || !Number.isFinite(v) ? "–" : v.toFixed(1));
const report = {
  frames: run.frames.length, wallSec: wall, msPerFrame: d.msPerFrame, size: `${run.w}x${run.h}`,
  goodCal: d.goodCal, cutsFlagged: d.cuts, cutFrames: statusAt.filter((s) => s.cut).map((s) => `${s.t.toFixed(2)}s(${s.view})`),
  nonOkFrames: statusAt.filter((s) => s.status !== "ok").map((s) => `${s.t.toFixed(2)}s ${s.view} ${s.status}`),
  zoomFramesOk: statusAt.filter((s) => s.view === "zoom" && s.status === "ok").length,
  medianErrM: q(errs, 0.5), p90ErrM: q(errs, 0.9), recall: nMatched / nVis, precision: nMatched / nTracked,
  teamPurity: teamOk / teamAll, teams: { ...teamScore(run, gt), refits: run.teamRefits, otherDets: run.otherDets }, idSwitches: switches, idSwitchesAcrossCut: switchesAcrossCut, gtPlayersTracked: byGt.size,
  tracks: d.tracks, avgTrackSec: d.avgTrackSec, ballMedianErrM: q(ballErrs, 0.5), ballFrames: ballErrs.length,
  sides: { guessed: sides, fromTruth: sidesGt, truth: trueSides },
  numbers: ["width", "depth", "lineHeight", "gapDM", "gapMA"].map((m) => `${m}: A ${f1(ours[0][m].mean)} vs ${f1(theirs[0][m].mean)} | B ${f1(ours[1][m].mean)} vs ${f1(theirs[1][m].mean)}`),
  possession: { tracked: possOurs, truth: possGt },
};
console.log(JSON.stringify(report, null, 1));
if (prof) {
  // per-stage breakdown (ms per analysed frame, calls per frame), slowest first
  const n = run.frames.length;
  const rows = Object.entries(prof).map(([stage, s]) => ({ stage, msPerFrame: s.ms / n, perFrame: s.n / n, msPerCall: s.n ? s.ms / s.n : 0 })).sort((a, b) => b.msPerFrame - a.msPerFrame);
  console.log(`stage timings over ${n} frames (ms/frame | calls/frame | ms/call):`);
  for (const r of rows) console.log(`  ${r.stage.padEnd(18)} ${r.msPerFrame.toFixed(1).padStart(8)} ${r.perFrame.toFixed(2).padStart(6)} ${r.msPerCall.toFixed(1).padStart(8)}`);
  report.stages = Object.fromEntries(rows.map((r) => [r.stage, +r.msPerFrame.toFixed(1)]));
}
writeFileSync(opt("out", join(DATA, "report.json")), JSON.stringify({ report, run }, null, 1));
