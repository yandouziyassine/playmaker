// Licence-safe CV benchmark: renders broadcast-like frames from the REAL player tracking of app/public/replay/
// (Bassek et al. 2025, DFL / Sportec, CC BY 4.0) with a virtual pinhole camera, in headless Chromium (plain canvas).
// Because the camera is known, the ground truth is exact: homography pitch -> image, every player's projected
// 1.8 x 0.6 x 0.4 m box, feet point, in-frame / occluded ratios, team and role, and the ball box.
// Output: scripts/cv-bench/data/<frame>.png (gitignored) + scripts/cv-bench/data/gt.json.
//   node scripts/cv-bench/render.mjs [--n 60] [--out scripts/cv-bench/data]
// --random [--seed 1]: seeded domain randomisation (lighting day / overcast / floodlit night with shadows, exposure and white
// balance, grass colour / texture / mowing pattern, hard kit pairs, low / main / high / zoomed cameras, motion blur, JPEG and
// resolution loss, scoreboard / ticker graphics, crowd density and colour). Each frame gets condition labels (`cond`) in
// gt.json; robust.mjs scores the pipeline per condition. Without --random the frames are byte-identical to before.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("n", 60));
const OUT = opt("out", join(here, "data"));
export const W = 1280, H = 720;

// ---------- tracking data (same decoder as app/src/replay/data.ts) ----------
const ABSENT = -32768;
export const match = JSON.parse(readFileSync(join(root, "app/public/replay/match.json"), "utf8"));
export const halves = match.halves.map((info, i) => {
  const buf = readFileSync(join(root, `app/public/replay/h${i}.bin`));
  const data = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  return { info, data, stride: (info.slots.length + 1) * 2 };
});
export const read = (h, frame, col) => { const i = frame * h.stride + col * 2, x = h.data[i]; return x === undefined || x === ABSENT ? null : [x / 100, h.data[i + 1] / 100]; };

/** Picks N frames evenly over the match where the ball is in play and every slot is present. */
export function pickFrames(n) {
  const total = halves.reduce((s, h) => s + h.info.frames, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let g = Math.floor(((k + 0.5) * total) / n), half = 0;
    while (g >= halves[half].info.frames) { g -= halves[half].info.frames; half++; }
    const h = halves[half];
    let f = g;
    for (let tries = 0; tries < 2000; tries++, f = Math.min(h.info.frames - 1, f + 7)) {
      if (match.alive[half][f] !== "1") continue;
      const ball = read(h, f, h.info.slots.length);
      if (!ball) continue;
      const players = [];
      for (let c = 0; c < h.info.slots.length; c++) {
        const p = read(h, f, c), pi = h.info.slots[c], team = match.players[pi]?.team;
        if (p && (team === 0 || team === 1)) players.push({ id: pi, team, pos: p });
      }
      if (players.length < 20) continue;
      out.push({ k, half, frame: f, ball, players, attack: h.info.attack, owner: match.owner[half][f] === "1" ? 0 : match.owner[half][f] === "2" ? 1 : -1 });
      break;
    }
  }
  return out;
}

/** Deterministic RNG (mulberry32). */
export const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** View assignment: 4 of 6 wide main-camera shots, 1 zoomed, 1 end zone. */
export function cameraFor(fr, r) {
  const kind = fr.k % 6 === 4 ? "zoom" : fr.k % 6 === 5 ? "endzone" : "wide";
  const [bx, by] = fr.ball;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  if (kind === "endzone") {
    const s = bx < 0 ? -1 : 1; // camera behind the goal the ball is nearer to
    return { kind, C: [s * (52.5 + 26 + r() * 8), (r() - 0.5) * 10, 13 + r() * 5], T: [s * (24 + r() * 10), (r() - 0.5) * 12, 0], f: 1300 + r() * 500 };
  }
  const C = [(r() - 0.5) * 12, -(34 + 42 + r() * 8), 16 + r() * 5];
  if (kind === "zoom") return { kind, C, T: [clamp(bx, -45, 45), clamp(by, -25, 25), 0.8], f: 2800 + r() * 1200 };
  return { kind, C, T: [clamp(bx * 0.6, -28, 28), 2 + r() * 4, 0], f: 1350 + r() * 400 };
}

// ---------- domain randomisation (--random) ----------
/** Kit pairs; `sim`: distinct, similar (hard for the colour split), grass (one kit close to the pitch colour). */
export const KIT_PAIRS = [
  { name: "red-white", sim: "distinct", kits: [{ shirt: "#c8102e", shorts: "#ffffff" }, { shirt: "#f4f4f4", shorts: "#1b2a5a" }] },
  { name: "blue-yellow", sim: "distinct", kits: [{ shirt: "#1d4fb8", shorts: "#ffffff" }, { shirt: "#f2d21b", shorts: "#1a3d1a" }] },
  { name: "black-white", sim: "distinct", ref: "#e8e03a", kits: [{ shirt: "#151515", shorts: "#151515" }, { shirt: "#f4f4f4", shorts: "#f4f4f4" }] },
  { name: "red-skyblue", sim: "distinct", kits: [{ shirt: "#b3122a", shorts: "#b3122a" }, { shirt: "#8cc4ec", shorts: "#ffffff" }] },
  { name: "white-lightgrey", sim: "similar", kits: [{ shirt: "#f6f6f6", shorts: "#f6f6f6" }, { shirt: "#c4c7cc", shorts: "#c4c7cc" }] },
  { name: "navy-black", sim: "similar", ref: "#e8e03a", kits: [{ shirt: "#1a2342", shorts: "#1a2342" }, { shirt: "#121212", shorts: "#121212" }] },
  { name: "red-orange", sim: "similar", kits: [{ shirt: "#c8102e", shorts: "#c8102e" }, { shirt: "#e2531c", shorts: "#ffffff" }] },
  { name: "maroon-purple", sim: "similar", kits: [{ shirt: "#6b1f2e", shorts: "#ffffff" }, { shirt: "#432166", shorts: "#ffffff" }] },
  { name: "green-white", sim: "grass", kits: [{ shirt: "#2f7d3c", shorts: "#ffffff" }, { shirt: "#f4f4f4", shorts: "#151515" }] },
  { name: "darkgreen-navy", sim: "grass", kits: [{ shirt: "#1e5631", shorts: "#1e5631" }, { shirt: "#1a2342", shorts: "#ffffff" }] },
];
const GRASS = { lush: [34, 108, 52], yellow: [82, 118, 46], dark: [20, 78, 38], blue: [28, 100, 72], worn: [92, 104, 62] };
const pickW = (opts, u) => { let acc = 0; const tot = opts.reduce((s, o) => s + o[1], 0); for (const [v, w] of opts) { acc += w / tot; if (u < acc) return v; } return opts[opts.length - 1][0]; };

/** Random camera: main (high broadcast), far (main zoomed out), high (tactical), low (touchline), zoom, endzone. */
export function cameraRandom(fr, r) {
  const kind = pickW([["main", 0.3], ["far", 0.15], ["high", 0.15], ["low", 0.15], ["zoom", 0.15], ["endzone", 0.1]], r());
  const [bx, by] = fr.ball;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  if (kind === "endzone") {
    const s = bx < 0 ? -1 : 1;
    return { kind, C: [s * (52.5 + 26 + r() * 8), (r() - 0.5) * 10, 13 + r() * 5], T: [s * (24 + r() * 10), (r() - 0.5) * 12, 0], f: 1300 + r() * 500 };
  }
  if (kind === "low") return { kind, C: [clamp(bx, -40, 40) * 0.6 + (r() - 0.5) * 10, -(34 + 8 + r() * 8), 6 + r() * 3], T: [clamp(bx, -45, 45), clamp(by, -20, 20), 0.5], f: 900 + r() * 500 };
  if (kind === "high") return { kind, C: [(r() - 0.5) * 16, -(58 + r() * 14), 30 + r() * 10], T: [clamp(bx * 0.6, -25, 25), 4 + r() * 4, 0], f: 1100 + r() * 350 };
  const C = [(r() - 0.5) * 12, -(34 + 42 + r() * 8), 16 + r() * 5];
  if (kind === "zoom") return { kind, C, T: [clamp(bx, -45, 45), clamp(by, -25, 25), 0.8], f: 2800 + r() * 1200 };
  if (kind === "far") return { kind, C, T: [clamp(bx * 0.4, -20, 20), r() * 4, 0], f: 950 + r() * 250 };
  return { kind, C, T: [clamp(bx * 0.6, -28, 28), 2 + r() * 4, 0], f: 1350 + r() * 400 };
}

/** One randomised scene: camera, the `look` passed to the browser (with `dr`), and the condition labels for gt.json. */
export function randomScene(fr, seed) {
  const r = rng(seed * 100003 + fr.k * 7919 + 17);
  const cam = cameraRandom(fr, r);
  const light = pickW([["day", 0.4], ["overcast", 0.3], ["night", 0.3]], r());
  const pair = KIT_PAIRS[Math.floor(r() * KIT_PAIRS.length)];
  const kits = r() < 0.5 ? pair.kits : [pair.kits[1], pair.kits[0]];
  const exposure = light === "night" ? 0.6 + r() * 0.45 : 0.75 + r() * 0.6;
  const temp = light === "night" ? (r() - 0.5) * 2 : (r() - 0.5) * 1.2; // -1 cool .. +1 warm
  const gt = 1 + (r() - 0.5) * 0.08;
  const g = [1 + 0.18 * temp, gt, 1 - 0.18 * temp], gm = Math.max(...g);
  const grassName = pickW([["lush", 0.35], ["yellow", 0.15], ["dark", 0.2], ["blue", 0.15], ["worn", 0.15]], r());
  const base = GRASS[grassName].map((v) => Math.round(v * (0.9 + r() * 0.2)));
  const stripe = 1.08 + r() * 0.17;
  const mow = pickW([["vertical", 0.35], ["horizontal", 0.2], ["checker", 0.2], ["none", 0.25]], r());
  const shadows = light === "day" ? [{ a: r() * 2 * Math.PI, len: 0.4 + r() * 0.9, alpha: 0.45 }]
    : light === "overcast" ? [{ a: Math.PI / 2, len: 0.15, alpha: 0.2 }]
    : (() => { const a0 = r() * Math.PI; return [0, 1, 2, 3].map((i) => ({ a: a0 + (i * Math.PI) / 2, len: 0.5, alpha: 0.17 })); })();
  const roof = light === "day" && r() < 0.5 ? { y0: -34 + r() * 40 } : null;
  const blurPx = r() < 0.5 ? r() * 3 : 3 + r() * 11;
  const jpegQ = r() < 0.4 ? 0.15 + r() * 0.35 : 0.55 + r() * 0.4;
  const scale = r() < 0.3 ? 0.5 + r() * 0.25 : 1;
  const score = r() < 0.6, ticker = r() < 0.25;
  const overlayRects = [...(score ? [[36, 28, 300, 40]] : []), ...(ticker ? [[0, H - 96, W, 56]] : [])];
  const density = 0.15 + r() * 1.45;
  const crowdPal = pickW([["mixed", 0.5], ["kit", 0.3], ["dark", 0.2]], r());
  const noise = light === "night" ? 12 + r() * 18 : 4 + r() * 16;
  const look = {
    seed: 7 + fr.k + seed * 1000, blur: 0.3 + r() * 0.9, exposure, noise, motion: 0, tint: 0, kits,
    contrast: light === "night" ? 1.05 + r() * 0.15 : light === "overcast" ? 0.85 + r() * 0.1 : 0.95 + r() * 0.15,
    sat: light === "overcast" ? 0.75 + r() * 0.2 : 0.9 + r() * 0.25,
    dr: {
      light, ref: pair.ref, wb: g.map((v) => v / gm), grass: { g0: base, g1: base.map((v) => Math.min(255, Math.round(v * stripe))), mow, width: 5 + r() * 7, speckle: r() },
      shadows, roof, blurPx, blurAngle: (r() - 0.5) * 0.5, jpegQ, scale, overlayRects, score, ticker, crowd: { density, palette: crowdPal },
    },
  };
  const cond = {
    light, exposure: +exposure.toFixed(2), expo: exposure < 0.8 ? "under" : exposure > 1.15 ? "over" : "normal", temp: +temp.toFixed(2),
    grass: grassName, mow, kitPair: pair.name, kitSim: pair.sim, cam: cam.kind, camH: +cam.C[2].toFixed(1), f: Math.round(cam.f),
    blurPx: +blurPx.toFixed(1), blur: blurPx < 3 ? "low" : blurPx < 8 ? "mid" : "high", jpegQ: +jpegQ.toFixed(2), scale: +scale.toFixed(2),
    compression: jpegQ < 0.5 || scale < 1 ? "heavy" : "light", overlay: ticker ? (score ? "score+ticker" : "ticker") : score ? "score" : "none",
    crowd: density < 0.6 ? "sparse" : density < 1.1 ? "medium" : "dense", crowdPal, roof: !!roof,
  };
  return { cam, look, cond };
}

// ---------- browser side: projection, drawing, ground truth ----------
// Runs inside Chromium (plain canvas). `fr` is the frame record, `cam` the camera, `look` the exposure/blur/seed knobs.
export async function renderInBrowser({ fr, cam, look, W, H }) {
  const seed = look.seed;
  const dr = look.dr || null; // domain randomisation knobs (render.mjs --random); null = the original look
  let s = seed | 0;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const fwd = norm(sub(cam.T, cam.C)), right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
  const cx = W / 2, cy = H / 2;
  /** 3D point -> [px, py, depth]; null behind the camera. */
  const proj = (P) => { const d = sub(P, cam.C), z = dot(fwd, d); if (z <= 0.05) return null; return [cx + (cam.f * dot(right, d)) / z, cy - (cam.f * dot(up, d)) / z, z]; };
  // homography pitch (X, Y, 0) -> image, row-major: K * [right; -up; fwd] * [[1,0,-Cx],[0,1,-Cy],[0,0,-Cz]]
  const R = [right, up.map((v) => -v), fwd];
  const K = [[cam.f, 0, cx], [0, cam.f, cy], [0, 0, 1]];
  const M = [[1, 0, -cam.C[0]], [0, 1, -cam.C[1]], [0, 0, -cam.C[2]]];
  const mm = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((acc, v, k) => acc + v * B[k][j], 0)));
  const Hm = mm(mm(K, R), M).flat();

  const cv = document.getElementById("c") || Object.assign(document.createElement("canvas"), { id: "c" });
  cv.width = W; cv.height = H;
  if (!cv.parentNode) document.body.appendChild(cv);
  const scene = document.createElement("canvas"); scene.width = W; scene.height = H;
  const ctx = scene.getContext("2d");

  // crowd + sky everywhere first (the ground polygon covers it; what stays visible is the stands)
  const skyC = !dr ? ["#9fb7cc", "#6c7f93"] : dr.light === "night" ? ["#04060c", "#111827"] : dr.light === "overcast" ? ["#c3c8ce", "#8d949c"] : ["#8fb3d9", "#6c7f93"];
  const standC = !dr || dr.light !== "night" ? ["#2a2f3a", "#1a1d26"] : ["#14161c", "#0b0c10"];
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.35);
  sky.addColorStop(0, skyC[0]); sky.addColorStop(1, skyC[1]);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  const stand = ctx.createLinearGradient(0, H * 0.06, 0, H);
  stand.addColorStop(0, standC[0]); stand.addColorStop(1, standC[1]);
  ctx.fillStyle = stand; ctx.fillRect(0, H * 0.06, W, H);
  let palette = ["#c8c1b4", "#8a3b3b", "#3b4f8a", "#d9d2c5", "#5a5a5a", "#b58a4a", "#e0e0e0", "#2d2d2d", "#7a9ac0", "#a35252"];
  if (dr?.crowd.palette === "kit") palette = [look.kits[0].shirt, look.kits[1].shirt, look.kits[0].shirt, look.kits[1].shorts, "#5a5a5a", "#2d2d2d", look.kits[0].shirt, look.kits[1].shirt];
  if (dr?.crowd.palette === "dark") palette = ["#2d2d2d", "#3a3a44", "#1d1f26", "#4a4a4a", "#5a4a3a", "#26303f"];
  const nDots = dr ? Math.round(9000 * dr.crowd.density) : 9000, nFans = dr ? Math.round(25 * dr.crowd.density) : 25;
  for (let i = 0; i < nDots; i++) {
    const x = rnd() * W, y = H * 0.06 + rnd() * H * 0.94, r = 1 + rnd() * 2.2;
    ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
    ctx.globalAlpha = 0.5 + rnd() * 0.5;
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.7, r, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // a few larger "standing fan" shapes: person-like false-positive bait
  for (let i = 0; i < nFans; i++) {
    const x = rnd() * W, y = H * 0.1 + rnd() * H * 0.5, h = 10 + rnd() * 18;
    ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
    ctx.fillRect(x - h * 0.18, y - h, h * 0.36, h * 0.7);
    ctx.beginPath(); ctx.arc(x, y - h * 1.1, h * 0.13, 0, Math.PI * 2); ctx.fill();
  }
  if (dr?.light === "night") { // floodlight banks above the stands
    for (let i = 0; i < 6; i++) {
      const x = ((i + 0.5) * W) / 6 + (rnd() - 0.5) * 80, y = H * (0.02 + rnd() * 0.1);
      const gl = ctx.createRadialGradient(x, y, 2, x, y, 60);
      gl.addColorStop(0, "rgba(255,255,240,0.95)"); gl.addColorStop(0.2, "rgba(255,250,220,0.4)"); gl.addColorStop(1, "rgba(255,250,220,0)");
      ctx.fillStyle = gl; ctx.fillRect(x - 60, y - 60, 120, 120);
    }
  }
  const poly = (pts, fill) => { ctx.fillStyle = fill; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); };
  /** Pitch-plane polygon clipped to the camera's near plane, then projected (randomised cameras can stand inside the margin). */
  const clipProj = (pts2) => {
    const P = pts2.map(([x, y]) => [x, y, 0]), z = (p) => dot(fwd, sub(p, cam.C)) - 0.5, out = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], za = z(a), zb = z(b);
      if (za >= 0) out.push(a);
      if ((za >= 0) !== (zb >= 0)) { const t = za / (za - zb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 0]); }
    }
    return out.length >= 3 ? out.map(proj).filter(Boolean) : null;
  };
  if (dr) {
    const gg = dr.grass, rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`, M = 22;
    const gpoly = clipProj([[-52.5 - M, -34 - M], [52.5 + M, -34 - M], [52.5 + M, 34 + M], [-52.5 - M, 34 + M]]);
    if (gpoly) poly(gpoly, rgb(gg.g0));
    const band = (x0, x1, y0, y1) => { const q = clipProj([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); if (q) poly(q, rgb(gg.g1)); };
    const n = Math.ceil(58 / gg.width);
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
      const x0 = i * gg.width, y0 = j * gg.width;
      if (x0 > 55.5 || x0 + gg.width < -55.5 || y0 > 37 || y0 + gg.width < -37) continue;
      const on = gg.mow === "vertical" ? i % 2 !== 0 : gg.mow === "horizontal" ? j % 2 !== 0 : gg.mow === "checker" ? (i + j) % 2 !== 0 : false;
      if (on) band(Math.max(-55.5, x0), Math.min(55.5, x0 + gg.width), Math.max(-37, y0), Math.min(37, y0 + gg.width));
    }
    if (gpoly && gg.speckle > 0.05) { // turf texture: light / dark speckles on the grass only
      ctx.save(); ctx.beginPath(); gpoly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.clip();
      for (let i = 0; i < 9000 * gg.speckle; i++) {
        ctx.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(255,255,200,0.08)";
        ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 2);
      }
      ctx.restore();
    }
  } else {
  // ground: grass with a track margin, clipped to what is in front of the camera
  const ground = (margin) => [[-52.5 - margin, -34 - margin], [52.5 + margin, -34 - margin], [52.5 + margin, 34 + margin], [-52.5 - margin, 34 + margin]].map(([x, y]) => proj([x, y, 0]));
  let margin = 22;
  while (margin > 2 && ground(margin).some((p) => !p)) margin -= 2;
  const g0 = `rgb(${34 + look.tint},${108 + look.tint},${52})`, g1 = `rgb(${40 + look.tint},${122 + look.tint},${58})`;
  poly(ground(margin), g0);
  // mowing stripes (every 10.5 m along x) within the pitch + 3 m
  for (let i = -6; i < 6; i++) {
    if (i % 2 === 0) continue;
    const x0 = i * 10.5, x1 = x0 + 10.5;
    const q = [[x0, -37], [x1, -37], [x1, 37], [x0, 37]].map(([x, y]) => proj([x, y, 0]));
    if (q.every(Boolean)) poly(q, g1);
  }
  }
  // painted lines
  const L = 52.5, Wd = 34, lines = [
    [[-L, -Wd], [L, -Wd], [L, Wd], [-L, Wd], [-L, -Wd]], [[0, -Wd], [0, Wd]],
  ];
  const arc = (cx0, cy0, r, a0, a1, n = 48) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx0 + r * Math.cos(a), cy0 + r * Math.sin(a)]; });
  lines.push(arc(0, 0, 9.15, 0, 2 * Math.PI, 64));
  for (const sgn of [-1, 1]) {
    const g = sgn * L, b = sgn * (L - 16.5), a = sgn * (L - 5.5), p = sgn * (L - 11);
    lines.push([[g, -20.16], [b, -20.16], [b, 20.16], [g, 20.16]]);
    lines.push([[g, -9.16], [a, -9.16], [a, 9.16], [g, 9.16]]);
    const half = Math.acos((16.5 - 11) / 9.15), base = sgn < 0 ? 0 : Math.PI;
    lines.push(arc(p, 0, 9.15, base - half, base + half, 24));
  }
  ctx.strokeStyle = "rgba(255,255,255,0.92)"; ctx.lineCap = "round";
  for (const line of lines) {
    const pts = line.map(([x, y]) => proj([x, y, 0]));
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i - 1] || !pts[i]) continue;
      ctx.lineWidth = Math.max(1, (0.12 * cam.f) / Math.min(pts[i - 1][2], pts[i][2]));
      ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
    }
  }
  // goals (posts + crossbar)
  for (const sgn of [-1, 1]) {
    const g = sgn * L, pts = [[g, -3.66, 0], [g, -3.66, 2.44], [g, 3.66, 2.44], [g, 3.66, 0]].map(proj);
    if (pts.every(Boolean)) { ctx.strokeStyle = "#f4f4f4"; ctx.lineWidth = Math.max(1.5, (0.12 * cam.f) / pts[0][2]); ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); }
  }

  // ---------- people ----------
  const KITS = {
    0: { shirt: look.kits[0].shirt, shorts: look.kits[0].shorts },
    1: { shirt: look.kits[1].shirt, shorts: look.kits[1].shorts },
    gk0: { shirt: "#2fb36a", shorts: "#1d6b40" }, gk1: { shirt: "#e8b11c", shorts: "#2b2b2b" }, ref: { shirt: dr?.ref ?? "#151515", shorts: "#151515" },
  };
  const keepers = {};
  for (const t of [0, 1]) { // the keeper: the team's deepest player towards its own goal
    const own = -fr.attack[t];
    let best = null;
    for (const p of fr.players) if (p.team === t && (!best || p.pos[0] * own > best.pos[0] * own)) best = p;
    if (best) keepers[best.id] = true;
  }
  const people = fr.players.map((p) => ({ ...p, role: keepers[p.id] ? "keeper" : "player", kit: keepers[p.id] ? KITS[`gk${p.team}`] : KITS[p.team] }));
  const dir = fr.owner >= 0 ? fr.attack[fr.owner] : 1;
  const refPos = [Math.max(-50, Math.min(50, fr.ball[0] - dir * (7 + rnd() * 6))), Math.max(-32, Math.min(32, fr.ball[1] + (rnd() - 0.5) * 16))];
  people.push({ id: -1, team: -1, pos: refPos, role: "ref", kit: KITS.ref });
  const figure = (feetPx, hPx, wPx, kit, pose) => {
    const [x, y] = feetPx, h = hPx, w = wPx;
    const rr = (x0, y0, ww, hh, fill, r = Math.min(ww, hh) / 2) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x0, y0, ww, Math.max(0.5, hh), Math.max(0, r)); ctx.fill(); };
    if (dr) for (const sh of dr.shadows) { // cast shadow(s): one sun shadow, a soft overcast blob, or four floodlight shadows
      const L = sh.len * h, dx = Math.cos(sh.a) * L, dy = Math.sin(sh.a) * L * 0.3;
      ctx.fillStyle = `rgba(0,0,0,${sh.alpha})`;
      ctx.beginPath(); ctx.ellipse(x + dx / 2, y + dy / 2, Math.max(w * 0.4, Math.hypot(dx, dy) / 2), w * 0.3, Math.atan2(dy, dx), 0, Math.PI * 2); ctx.fill();
    }
    else {
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath(); ctx.ellipse(x + w * 0.2, y, w * 0.8, w * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    }
    const spread = pose.spread * w; // legs apart when running
    rr(x - w * 0.3 - spread, y - h * 0.47, w * 0.24, h * 0.45, "#d9a77e");
    rr(x + w * 0.06 + spread, y - h * 0.47, w * 0.24, h * 0.45, "#d9a77e");
    rr(x - w * 0.31 - spread, y - h * 0.22, w * 0.26, h * 0.18, kit.shorts === "#ffffff" ? "#777" : kit.shorts, w * 0.06);
    rr(x + w * 0.05 + spread, y - h * 0.22, w * 0.26, h * 0.18, kit.shorts === "#ffffff" ? "#777" : kit.shorts, w * 0.06);
    rr(x - w * 0.36 - spread, y - h * 0.05, w * 0.32, h * 0.05, "#111", w * 0.04);
    rr(x + w * 0.04 + spread, y - h * 0.05, w * 0.32, h * 0.05, "#111", w * 0.04);
    rr(x - w * 0.4, y - h * 0.57, w * 0.8, h * 0.16, kit.shorts, w * 0.08);
    ctx.fillStyle = kit.shirt;
    ctx.beginPath(); ctx.moveTo(x - w * 0.5, y - h * 0.8); ctx.lineTo(x + w * 0.5, y - h * 0.8); ctx.lineTo(x + w * 0.4, y - h * 0.53); ctx.lineTo(x - w * 0.4, y - h * 0.53); ctx.closePath(); ctx.fill();
    rr(x - w * 0.48, y - h * 0.83, w * 0.96, h * 0.08, kit.shirt, w * 0.16);
    rr(x - w * 0.5, y - h * 0.8, w * 0.2, h * 0.16, kit.shirt, w * 0.08); // sleeves
    rr(x + w * 0.3, y - h * 0.8, w * 0.2, h * 0.16, kit.shirt, w * 0.08);
    rr(x - w * 0.48, y - h * 0.66, w * 0.16, h * 0.2, "#d9a77e"); // forearms
    rr(x + w * 0.32, y - h * 0.66, w * 0.16, h * 0.2, "#d9a77e");
    rr(x - w * 0.08, y - h * 0.87, w * 0.16, h * 0.06, "#c99a70", w * 0.04);
    ctx.fillStyle = pose.skin;
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.925, h * 0.055, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#2b1d14";
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.95, h * 0.058, h * 0.045, 0, Math.PI, 2 * Math.PI); ctx.fill();
  };
  // depth order: far to near
  const drawn = people.map((p) => {
    const f = proj([p.pos[0], p.pos[1], 0]), top = proj([p.pos[0], p.pos[1], 1.8]);
    // 1.8 x 0.6 x 0.4 m box corners (0.6 m across x, 0.4 m across y)
    const corners = [];
    for (const dx of [-0.3, 0.3]) for (const dy of [-0.2, 0.2]) for (const dz of [0, 1.8]) corners.push(proj([p.pos[0] + dx, p.pos[1] + dy, dz]));
    if (!f || !top || corners.some((c) => !c)) return { ...p, visible: false };
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    const hPx = f[1] - top[1];
    const wPx = Math.max(2, box[2] * 0.9); // the figure fills ~90 % of the projected box width (end-zone views included)
    return { ...p, visible: true, feet: [f[0], f[1]], depth: f[2], box, hPx, wPx, pose: { spread: rnd() * 0.35, skin: ["#c99a70", "#8d5a3b", "#e8c2a0", "#5a3a26"][Math.floor(rnd() * 4)] } };
  });
  const order = drawn.filter((p) => p.visible).sort((a, b) => b.depth - a.depth);
  for (const p of order) {
    if (p.box[0] + p.box[2] < -20 || p.box[0] > W + 20 || p.box[1] + p.box[3] < -20 || p.box[1] > H + 20) continue;
    // mild motion blur: a faint ghost offset along a random direction, then the figure
    if (look.motion > 0.2) { ctx.globalAlpha = 0.35; figure([p.feet[0] + look.motion * 1.5, p.feet[1]], p.hPx, p.wPx, p.kit, p.pose); ctx.globalAlpha = 1; }
    figure(p.feet, p.hPx, p.wPx, p.kit, p.pose);
  }
  // ball (radius 0.11 m; drawn at least 2.6 px so it is not swallowed by the noise, as a broadcast ball is not)
  let ballGt = null;
  const bg = proj([fr.ball[0], fr.ball[1], 0]);
  if (bg) {
    const r = Math.max(2.6, (0.11 * cam.f) / bg[2]), c = [bg[0], bg[1] - r];
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(bg[0] + r * 0.3, bg[1], r * 1.1, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    const grad = ctx.createRadialGradient(c[0] - r * 0.35, c[1] - r * 0.35, r * 0.1, c[0], c[1], r);
    grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#bdbdbd");
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2 + 0.4; ctx.beginPath(); ctx.arc(c[0] + r * 0.5 * Math.cos(a), c[1] + r * 0.5 * Math.sin(a), r * 0.26, 0, Math.PI * 2); ctx.fill(); }
    ballGt = { pos: fr.ball, box: [c[0] - r, c[1] - r, 2 * r, 2 * r], ground: [bg[0], bg[1]] };
  }

  // stand roof shadow over the near part of the pitch (sun / shade split crossing the players)
  if (dr?.roof) { const q = clipProj([[-80, -70], [80, -70], [80, dr.roof.y0], [-80, dr.roof.y0]]); if (q) poly(q, "rgba(0,0,0,0.38)"); }

  // ---------- compositing: blur, exposure, sensor noise ----------
  const out = cv.getContext("2d");
  out.filter = `blur(${look.blur}px) brightness(${look.exposure}) contrast(${look.contrast}) saturate(${look.sat})`;
  if (dr && dr.blurPx > 0.5) { // camera-pan motion blur: equal-weight average of shifted copies along the pan direction
    const n = 9, ux = Math.cos(dr.blurAngle), uy = Math.sin(dr.blurAngle);
    for (let i = 0; i < n; i++) {
      const o = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (dr.blurPx / (n - 1));
      out.globalAlpha = 1 / (i + 1);
      out.drawImage(scene, o * ux, o * uy);
    }
    out.globalAlpha = 1;
  } else out.drawImage(scene, 0, 0);
  out.filter = "none";
  if (dr) {
    out.globalCompositeOperation = "multiply"; // white balance
    out.fillStyle = `rgb(${dr.wb.map((v) => Math.round(255 * v)).join(",")})`; out.fillRect(0, 0, W, H);
    out.globalCompositeOperation = "source-over";
    if (dr.light === "night") { const v = out.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.75); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.45)"); out.fillStyle = v; out.fillRect(0, 0, W, H); }
    // broadcast graphics: scoreboard bar, lower-third ticker (not affected by the scene lighting)
    if (dr.score) {
      out.fillStyle = "rgba(14,18,32,0.92)"; out.fillRect(36, 28, 300, 40);
      out.fillStyle = look.kits[0].shirt; out.fillRect(42, 34, 8, 28); out.fillStyle = look.kits[1].shirt; out.fillRect(322, 34, 8, 28);
      out.fillStyle = "#fff"; out.font = "bold 20px sans-serif"; out.fillText("HOM  1 - 0  AWY   63:12", 60, 55);
    }
    if (dr.ticker) { out.fillStyle = "rgba(12,32,84,0.9)"; out.fillRect(0, H - 96, W, 56); out.fillStyle = "#fff"; out.font = "22px sans-serif"; out.fillText("LIVE  |  Matchday 12  |  Possession 54 % - 46 %  |  Shots 7 - 4", 40, H - 60); }
  }
  const img = out.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * look.noise; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  out.putImageData(img, 0, 0);
  if (dr) { // stream quality: optional downscale, then JPEG at quality jpegQ, decoded back (real block / ringing artefacts)
    const sw = Math.round(W * dr.scale), sh = Math.round(H * dr.scale);
    const small = document.createElement("canvas"); small.width = sw; small.height = sh;
    small.getContext("2d").drawImage(cv, 0, 0, sw, sh);
    const im = new Image(); im.src = small.toDataURL("image/jpeg", dr.jpegQ); await im.decode();
    out.clearRect(0, 0, W, H); out.drawImage(im, 0, 0, W, H);
  }

  // ---------- ground truth ----------
  const overlays = dr ? dr.overlayRects : [];
  const underOverlay = (x, y) => overlays.some((o) => x >= o[0] && x <= o[0] + o[2] && y >= o[1] && y <= o[1] + o[3]);
  if (ballGt && underOverlay(ballGt.box[0] + ballGt.box[2] / 2, ballGt.box[1] + ballGt.box[3] / 2)) ballGt = null;
  const clipFrac = (b) => { const x0 = Math.max(0, b[0]), y0 = Math.max(0, b[1]), x1 = Math.min(W, b[0] + b[2]), y1 = Math.min(H, b[1] + b[3]); return b[2] * b[3] > 0 ? (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / (b[2] * b[3]) : 0; };
  const players = order.map((p) => {
    // occlusion: share of a point grid inside the box hidden by the body (central 70 % of the box) of a nearer person
    const nearer = order.filter((q) => q !== p && q.depth < p.depth);
    let hid = 0, tot = 0;
    for (let j = 0; j < 12; j++) for (let i = 0; i < 6; i++) {
      const x = p.box[0] + ((i + 0.5) * p.box[2]) / 6, y = p.box[1] + ((j + 0.5) * p.box[3]) / 12;
      tot++;
      if (nearer.some((q) => x >= q.box[0] + 0.15 * q.box[2] && x <= q.box[0] + 0.85 * q.box[2] && y >= q.box[1] && y <= q.box[1] + q.box[3]) || underOverlay(x, y)) hid++;
    }
    return { id: p.id, team: p.team, role: p.role, pos: p.pos, feet: p.feet.map((v) => +v.toFixed(2)), box: p.box.map((v) => +v.toFixed(2)), hPx: +p.hPx.toFixed(2), inFrame: +clipFrac(p.box).toFixed(3), occluded: +(hid / tot).toFixed(3) };
  });
  return { H: Hm, players, ball: ballGt, png: cv.toDataURL("image/png") };
}

export async function render(n = N, outDir = OUT, { random = false, seed = 1 } = {}) {
  mkdirSync(outDir, { recursive: true });
  const frames = pickFrames(n);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent("<!doctype html><body style='margin:0'><canvas id=c></canvas></body>");
  const gt = { w: W, h: H, source: "app/public/replay (Bassek et al. 2025, DFL / Sportec Solutions, CC BY 4.0); synthetic rendering, see render.mjs", frames: [] };
  const kits = [{ shirt: match.meta.colors[0], shorts: match.meta.colors[0] }, { shirt: match.meta.colors[1], shorts: "#1b2a5a" }];
  if (random) gt.random = { seed, n };
  for (const fr of frames) {
    let cam, look, cond;
    if (random) ({ cam, look, cond } = randomScene(fr, seed));
    else {
      const r = rng(1000 + fr.k);
      cam = cameraFor(fr, r);
      look = { seed: 7 + fr.k, blur: 0.3 + r() * 0.7, exposure: 0.88 + r() * 0.24, contrast: 0.95 + r() * 0.1, sat: 0.9 + r() * 0.2, noise: 6 + r() * 14, motion: r() * 2.5, tint: Math.round((r() - 0.5) * 20), kits };
    }
    const res = await page.evaluate(renderInBrowser, { fr, cam, look, W, H });
    const id = String(fr.k).padStart(3, "0");
    writeFileSync(join(outDir, `${id}.png`), Buffer.from(res.png.split(",")[1], "base64"));
    gt.frames.push({ id, half: fr.half, frame: fr.frame, view: cam.kind, camera: { C: cam.C.map((v) => +v.toFixed(2)), T: cam.T.map((v) => +v.toFixed(2)), f: +cam.f.toFixed(1) }, H: res.H, players: res.players, ball: res.ball, ...(cond ? { cond } : {}) });
    process.stdout.write(`${id} ${cam.kind} ${res.players.length} people, ${res.players.filter((p) => p.inFrame > 0.5).length} in frame${cond ? ` ${cond.light} ${cond.kitPair} blur ${cond.blurPx}` : ""}\n`);
  }
  await browser.close();
  writeFileSync(join(outDir, "gt.json"), JSON.stringify(gt));
  return gt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await render(N, OUT, { random: args.includes("--random"), seed: Number(opt("seed", 1)) });
