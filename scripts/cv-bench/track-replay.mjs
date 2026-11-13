// Offline replay of the clip tracker on the raw detections dumped by clip-run.mjs (--loop '{"dump":true}' --out r.json):
// re-runs ktrack.ts (or live.ts) on the same detections with other settings and scores it like clip-run.mjs, in seconds.
//   node --experimental-strip-types scripts/cv-bench/track-replay.mjs r.json [--tracker nn|kalman] [--set '{"gate":4}'] [--raw]
//     [--teams '{"margin":0.1}'] (teams.ts TEAM_MODEL overrides) [--noprior] [--nooverride] [--nofinal] (skip labelClip: provisional labels)
// With dumped torso features (feat, box), the final clip-wide team labelling (teams.ts labelClip) is replayed too and the
// labels are scored in image space (team-score.mjs).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teamScore } from "./team-score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dump = JSON.parse(readFileSync(args[0], "utf8")).run;
const gt = JSON.parse(readFileSync(join(opt("data", join(here, "clip-data")), "gt.json"), "utf8"));
const K = await import(new URL("../../app/src/lab/ktrack.ts", import.meta.url).href);
const Lv = await import(new URL("../../app/src/lab/live.ts", import.meta.url).href);
const T = await import(new URL("../../app/src/lab/teams.ts", import.meta.url).href);
const cdets = [], cplayers = [];
let seg = 0;
const tracker = opt("tracker", "kalman"), set = JSON.parse(opt("set", "{}")), o = { ...K.KTRACK, ...set };

// replay (cuts / pauses as in cliprun.ts: a cut or a gap > 1 s suspends the tracks)
let kt = K.newTracker(), tracks = [], nextId = 1, lastOk = -Infinity;
const frames = dump.frames.map((f, k) => {
  if (f.cut || k === 0) { kt = K.suspend(kt); tracks = []; if (k > 0) seg++; }
  if (f.status !== "ok") return f;
  const dets = f.dets ?? [];
  if (f.t - lastOk > 1) { kt = K.suspend(kt); tracks = []; }
  const dt = Number.isFinite(lastOk) ? f.t - lastOk : 0.2;
  lastOk = f.t;
  let players;
  if (tracker === "kalman") {
    const r = K.kStep(kt, dets, f.t, o); kt = r.tracker;
    players = dets.map((d, j) => ({ id: r.byDet[j].id, team: r.byDet[j].team, p: args.includes("--raw") ? d.p : K.trackPos(r.byDet[j]), box: d.box ?? {} }));
  } else {
    const r = Lv.stepTracks(tracks, dets, dt, nextId); tracks = r.tracks; nextId = r.nextId;
    players = dets.map((d, j) => ({ id: r.byDet[j].id, team: r.byDet[j].team, p: r.byDet[j].p, box: d.box ?? {} }));
  }
  dets.forEach((d, j) => { if (d.feat) { cdets.push({ id: players[j].id, seg, frame: k, feat: d.feat, x: d.p.x, good: f.rating === "good" }); cplayers.push(players[j]); } });
  return { ...f, players };
});

// final team labels (as cliprun.ts)
let teamInfo = null;
if (cdets.length && !args.includes("--nofinal")) {
  const res = T.labelClip(cdets, { ...T.TEAM_MODEL, ...JSON.parse(opt("teams", "{}")) }, !args.includes("--noprior"));
  for (const f of frames) for (const p of f.players ?? []) p.team = res.byTrack.get(p.id) ?? p.team;
  if (!args.includes("--nooverride")) cplayers.forEach((p, i) => { p.team = res.final[i]; });
  teamInfo = { refits: res.refits, centres: res.model?.centres.map((c) => c.map((v) => +v.toFixed(1))) };
}

// scoring (same as clip-run.mjs)
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const errs = [], pairs = new Map(), byGt = new Map();
let nVis = 0, nMatched = 0, nTracked = 0;
frames.forEach((f, k) => {
  const g = gt.frames[Math.min(gt.frames.length - 1, Math.round(f.t * gt.fps))];
  if (f.status !== "ok" || g.view !== "wide") return;
  const vis = g.players.filter((p) => p.inFrame > 0.5), seen = f.players.filter((p) => p.box);
  nVis += vis.length; nTracked += seen.length;
  const cand = [];
  seen.forEach((s, i) => vis.forEach((v, j) => { const d = Math.hypot(s.p.x - v.pos[0], s.p.y - v.pos[1]); if (d <= 5) cand.push({ i, j, d }); }));
  cand.sort((a, b) => a.d - b.d);
  const ui = new Set(), uj = new Set();
  for (const c of cand) {
    if (ui.has(c.i) || uj.has(c.j)) continue;
    ui.add(c.i); uj.add(c.j); nMatched++; errs.push(c.d);
    const s = seen[c.i], v = vis[c.j];
    pairs.set(`${s.team}:${v.team}`, (pairs.get(`${s.team}:${v.team}`) ?? 0) + 1);
    if (!byGt.has(v.id)) byGt.set(v.id, []);
    byGt.get(v.id).push({ k, id: s.id });
  }
});
const direct = (pairs.get("0:0") ?? 0) + (pairs.get("1:1") ?? 0), swapped = (pairs.get("0:1") ?? 0) + (pairs.get("1:0") ?? 0);
const teamAll = [...pairs.values()].reduce((a, b) => a + b, 0);
const cutKs = frames.map((f, k) => (f.cut || f.status !== "ok" ? k : -1)).filter((k) => k >= 0);
let sw = 0, swCut = 0;
for (const seq of byGt.values()) for (let i = 1; i < seq.length; i++) {
  if (seq[i].id === seq[i - 1].id) continue;
  if (cutKs.some((c) => c > seq[i - 1].k && c <= seq[i].k)) swCut++; else sw++;
}
const ids = new Map();
for (const f of frames) for (const p of f.players ?? []) { const s = ids.get(p.id); if (s) { s.last = f.t; s.n++; } else ids.set(p.id, { first: f.t, last: f.t, n: 1 }); }
const kept = [...ids.values()].filter((s) => s.n >= 3);
if (cdets.length) console.log(JSON.stringify({ ...teamScore({ frames }, gt), ...teamInfo }));
console.log(JSON.stringify({ tracker, set, medianErrM: +q(errs, 0.5).toFixed(3), p90: +q(errs, 0.9).toFixed(3), recall: +(nMatched / nVis).toFixed(3), precision: +(nMatched / nTracked).toFixed(3),
  teamPurity: +(Math.max(direct, swapped) / teamAll).toFixed(3), idSwitches: sw, acrossCut: swCut, tracks: kept.length, avgTrackSec: +(kept.reduce((a, s) => a + s.last - s.first + 0.2, 0) / kept.length).toFixed(2) }));
