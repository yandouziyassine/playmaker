// Synthetic broadcast CLIP for the Lab's video mode: ~10 s of consecutive frames at 10 fps rendered from the REAL tracking
// data (app/public/replay, Bassek et al. 2025, DFL / Sportec, CC BY 4.0; positions interpolated from 12.5 Hz) by a main
// camera that pans with the ball, with a 1 s cut to a tight close-up in the middle (camera-cut test). Encoded as webm (VP8)
// with ffmpeg. Output (gitignored): scripts/cv-bench/clip-data/clip.webm + gt.json (per video frame: view, homography,
// every player's pitch position / team / in-frame share, the ball).
//   node scripts/cv-bench/clip.mjs [--sec 10] [--fps 10] [--start 3000] [--out scripts/cv-bench/clip-data]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { halves, match, read, renderInBrowser, W, H } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SEC = Number(opt("sec", 10)), FPS = Number(opt("fps", 10)), OUT = opt("out", join(here, "clip-data"));
const CUT = [Number(opt("cutFrom", 6)), Number(opt("cutTo", 7))]; // seconds of close-up
const DATA_HZ = match.fps; // 12.5
const half = 0, h = halves[half];
const nOut = Math.round(SEC * FPS), span = Math.ceil((SEC * DATA_HZ)) + 2;

/** First window from --start where the ball is in play, present on every frame and travels at least 25 m. */
function pickStart(from) {
  for (let f0 = from; f0 + span < h.info.frames; f0 += 25) {
    let ok = true, minX = 1e9, maxX = -1e9;
    for (let f = f0; f < f0 + span && ok; f++) {
      const b = read(h, f, h.info.slots.length);
      if (match.alive[half][f] !== "1" || !b) ok = false;
      else { minX = Math.min(minX, b[0]); maxX = Math.max(maxX, b[0]); }
    }
    if (ok && maxX - minX > 25) return f0;
  }
  throw new Error("no window found");
}

/** Players (team 0/1) and ball at fractional data frame g (linear interpolation; a player missing at either end is left out). */
function stateAt(g) {
  const f = Math.floor(g), a = g - f;
  const lerp = (p, q) => (p && q ? [p[0] + a * (q[0] - p[0]), p[1] + a * (q[1] - p[1])] : null);
  const players = [];
  for (let c = 0; c < h.info.slots.length; c++) {
    const pi = h.info.slots[c], team = match.players[pi]?.team;
    const p = lerp(read(h, f, c), read(h, f + 1, c));
    if (p && (team === 0 || team === 1)) players.push({ id: pi, team, pos: p });
  }
  const ball = lerp(read(h, f, h.info.slots.length), read(h, f + 1, h.info.slots.length));
  const o = match.owner[half][f];
  return { players, ball, attack: h.info.attack, owner: o === "1" ? 0 : o === "2" ? 1 : -1 };
}

const f0 = pickStart(Number(opt("start", 3000)));
const kits = [{ shirt: match.meta.colors[0], shorts: match.meta.colors[0] }, { shirt: match.meta.colors[1], shorts: "#1b2a5a" }];
const look = { seed: 11, blur: 0.5, exposure: 1, contrast: 1, sat: 1, noise: 8, motion: 0.6, tint: 0, kits };
const C = [0, -80, 19]; // main camera: fixed position above the near touchline, pans and keeps its zoom
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

rmSync(join(OUT, "frames"), { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent("<!doctype html><body style='margin:0'><canvas id=c></canvas></body>");
const gt = { w: W, h: H, fps: FPS, half, startFrame: f0, cut: CUT, attack: h.info.attack,
  source: "app/public/replay (Bassek et al. 2025, DFL / Sportec Solutions, CC BY 4.0); synthetic rendering, see clip.mjs", frames: [] };
let panX = null, panY = null;
for (let i = 0; i < nOut; i++) {
  const t = i / FPS, fr = { k: i, ...stateAt(f0 + t * DATA_HZ) };
  const [bx, by] = fr.ball;
  // the operator follows the ball smoothly (the pan lags a little), as a main broadcast camera does
  panX = panX === null ? bx : panX + 0.25 * (bx - panX);
  panY = panY === null ? by : panY + 0.25 * (by - panY);
  const zoom = t >= CUT[0] && t < CUT[1];
  const cam = zoom ? { kind: "zoom", C, T: [clamp(bx, -45, 45), clamp(by, -25, 25), 0.8], f: 4200 }
    : { kind: "wide", C, T: [clamp(panX * 0.85, -30, 30), clamp(panY * 0.3, -6, 8), 0], f: 1500 };
  const res = await page.evaluate(renderInBrowser, { fr, cam, look, W, H });
  writeFileSync(join(OUT, "frames", `${String(i).padStart(4, "0")}.png`), Buffer.from(res.png.split(",")[1], "base64"));
  gt.frames.push({ i, t: +t.toFixed(3), view: cam.kind, H: res.H, players: res.players.map(({ id, team, role, pos, inFrame, occluded }) => ({ id, team, role, pos: pos.map((v) => +v.toFixed(2)), inFrame, occluded })),
    ball: { pos: fr.ball.map((v) => +v.toFixed(2)), inFrame: !!res.ball && res.ball.ground[0] >= 0 && res.ball.ground[0] <= W && res.ball.ground[1] >= 0 && res.ball.ground[1] <= H } });
  if (i % 10 === 0) process.stdout.write(`${i}/${nOut} ${cam.kind} ball (${bx.toFixed(1)}, ${by.toFixed(1)})\n`);
}
await browser.close();
writeFileSync(join(OUT, "gt.json"), JSON.stringify(gt));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(OUT, "frames", "%04d.png"),
  "-c:v", "libvpx", "-b:v", "6M", "-crf", "8", "-pix_fmt", "yuv420p", "-auto-alt-ref", "0", join(OUT, "clip.webm")], { stdio: "inherit" });
console.log(`wrote ${join(OUT, "clip.webm")} (${nOut} frames, ${SEC} s at ${FPS} fps, data frames ${f0}..${f0 + Math.round(SEC * DATA_HZ)} of half ${half + 1}) and gt.json`);
