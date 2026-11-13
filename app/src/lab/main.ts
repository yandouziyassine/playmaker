// Lab page: picture -> people detection -> team colours -> 4-point pitch calibration -> top-down map -> AI coach.
// Live mode: the same pipeline on camera frames (VIDEO-mode detector, throttled), with tracking (live.ts).
import { applyH, computeHomography, hasCollinearTriple, orientH, wOf, type Mat3, type Pt } from "./homography.ts";
import { DEFAULT_LANDMARKS, LANDMARKS, PITCH, landmark, pitchLines } from "./landmarks.ts";
import { feet, toPitch, type Person } from "./players.ts";
import type { Advice, LoadedCoach } from "../coach/picture.ts"; // types only: the engine is loaded lazily
import { meanColour, splitTeams, torsoBox, type RGB, type TeamLabel } from "./teams.ts";
import { detectPeople, detectVideoFrame, loadDetector, loadVideoDetector } from "./detector.ts";
import { getSettings, MODELS, setSettings, type ModelId } from "./settings.ts";
import { CAMERA_MESSAGES, cameraProblem, openCamera, stopStream } from "./camera.ts";
import {
  assignTeam, blendPoints, CAL_WATCH, delayUntilNext, fixCentroids, nextFps, nextThrottle, START_THROTTLE, START_WATCH, stepTracks,
  trackVelocity, watchResidual, type CalWatch, type Centroids, type Throttle, type Track,
} from "./live.ts";
import { autoCalibrate, pickFour, refineCalibration, residualOf, type AutoCal, type AutoCalResult } from "./autocal.ts";
import type { State } from "../coach/features.ts";
import { drawScene, SCENE_H, SCENE_W } from "./scene.ts";
import { attackDirection, ballGround, pickBall, pickCarrier, stepBall, trackBox, type Ball, type BallTrack } from "./ball.ts";
import { calibrationCheck, fitQuality, LINE_SIDE, pointAt, scanLines, snapPoint, toSource, type LineScan } from "./lines.ts";
import { setIconText, spinner, type IconName } from "../design/icons.ts";
import type { CoachOption } from "../coach/advice.ts";
import { initLang, num, pct, t, xg } from "../i18n/index.ts";
import { localizeLab, tl, tln, type LabKey } from "./i18n.ts";
import { translatePhrase } from "../i18n/phrases.ts";
import { mountLangSwitch } from "../i18n/ui.ts";
import { CLIP, diagnostics, frameAt, guessSides, heatBins, possessionShare, processingSize, teamNumbers, teamPoints, type Avg, type ClipFrame } from "./clip.ts";
import { analyseClip, seekTo, type ClipRun } from "./cliprun.ts";

initLang();
localizeLab();
mountLangSwitch();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// detector choice: fast EfficientDet-Lite0 (default) or accurate Lite2 (scripts/cv-bench: recall 69.9 % vs 80.1 %, ~2.4x slower)
{
  const sel = $<HTMLSelectElement>("det-model");
  for (const [id, m] of Object.entries(MODELS)) sel.add(new Option(m.label, id));
  sel.value = getSettings().model;
  sel.addEventListener("change", () => { setSettings({ model: sel.value as ModelId }); void loadDetector(); });
}
const MAX_SIDE = 1600;
const PT_COLOURS = ["#ffd166", "#4cc9f0", "#ff9f1c", "#c77dff"];
const RANK_COLOURS = ["#06d6a0", "#4cc9f0", "#ffd166"];
const TOP_N = 3;

/** Coach option texts in the page language (English identical to coach/picture.ts; carries reuse the replay's keys). */
function carryDirection(angle: number): string {
  const a = Math.round(angle);
  return a === 0 ? t("rp.straight") : t(a > 0 ? "rp.left" : "rp.right", { a: Math.abs(a) });
}
function optionTitle(o: CoachOption): string {
  if (o.kind === "pass") return tl("lab.opt.pass", { n: (o.target ?? -1) + 1 });
  if (o.kind === "carry") return t("rp.carry", { dir: carryDirection(o.angle ?? 0) });
  return t("rp.shoot");
}
function successLabel(o: CoachOption): string {
  return t(o.kind === "pass" ? "rp.arrives" : o.kind === "carry" ? "rp.keeps" : "rp.goalChance", { p: pct(o.p) });
}

const src = document.createElement("canvas"); // the picture at working resolution
const img = $<HTMLCanvasElement>("img"), top = $<HTMLCanvasElement>("top");
const status = $("status"), calibMsg = $("calib-msg");
$("work").querySelector<HTMLElement>(".stage")!.dataset.frozen = tl("lab.frozen"); // the "Frozen" badge (CSS content: attr())
/** Landmark names: the full one (title) and a short one that fits the closed dropdown at 360 px. */
const lmFull = (id: string) => tl(`lab.lm.${id}` as LabKey);
const lmShort = (id: string) => tl(`lab.lms.${id}` as LabKey);

const st = {
  loaded: false,
  persons: [] as Person[],
  colours: [] as (RGB | null)[],
  labels: [] as TeamLabel[],
  teamRgb: [[230, 230, 230], [40, 40, 40]] as RGB[],
  separation: 0,
  ms: null as number | null,
  ids: [...DEFAULT_LANDMARKS],
  pts: [null, null, null, null] as (Pt | null)[],
  active: 0 as number | null,
  drag: null as number | null,
  carrier: null as number | null,
  dir: 1 as 1 | -1,
  busy: false,
  balls: [] as Ball[],            // picture mode: every "sports ball" candidate of the last detection
  carrierManual: false,           // the user tapped a carrier (or cleared it): no automatic pick until the next detection
  dirManual: false,               // the user picked the attacking direction
  autoNote: "",                   // why the carrier / direction were preselected
  snaps: [null, null, null, null] as ({ from: Pt; t0: number; d: number } | null)[], // where a snapped point was tapped
};
const SNAP_CSS_PX = 20; // tap snapping radius, in CSS pixels on screen
const SNAP_MS = 320;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- calibration list ----------
function buildCalib() {
  const ol = $("calib");
  ol.innerHTML = "";
  st.ids.forEach((id, i) => {
    const li = document.createElement("li");
    li.className = st.active === i ? "active" : "";
    const num = document.createElement("span");
    num.className = "num"; num.textContent = String(i + 1); num.style.background = PT_COLOURS[i]!;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", tl("lab.calib.pointAria", { n: i + 1 }));
    sel.title = lmFull(id);
    for (const [group, filter] of [["lab.grp.centre", "c"], ["lab.grp.left", "L-"], ["lab.grp.right", "R-"]] as const) {
      const og = document.createElement("optgroup");
      og.label = tl(group);
      for (const l of LANDMARKS.filter((l) => (filter === "c" ? !/^[LR]-/.test(l.id) : l.id.startsWith(filter)))) {
        const o = document.createElement("option");
        o.value = l.id; o.textContent = lmShort(l.id); o.title = lmFull(l.id); o.selected = l.id === id;
        og.append(o);
      }
      sel.append(og);
    }
    sel.addEventListener("change", () => { st.ids[i] = sel.value; sel.title = lmFull(sel.value); calibChanged(); render(); });
    const state = document.createElement("span");
    state.className = "state";
    if (st.pts[i]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ghost"; b.textContent = tl(st.active === i ? "lab.calib.tapPicture" : "lab.calib.replace");
      b.addEventListener("click", () => { st.active = i; buildCalib(); render(); });
      state.append(b);
    } else state.textContent = tl(st.active === i ? "lab.calib.tapPicture" : "lab.calib.notPlaced");
    li.append(num, sel, state);
    ol.append(li);
  });
}

// ---------- geometry ----------
type Calib = { p2i: Mat3; i2p: Mat3 } | { error: string };

function calibration(): Calib | null {
  if (st.pts.some((p) => !p)) return null;
  if (new Set(st.ids).size < 4) return { error: tl("lab.err.distinct") };
  const pitchPts = st.ids.map((id) => landmark(id)!);
  const imgPts = st.pts as Pt[];
  if (hasCollinearTriple(pitchPts, 2e-3)) return { error: tl("lab.err.pitchLine") };
  if (hasCollinearTriple(imgPts, 1e-3)) return { error: tl("lab.err.picLine") };
  const p2i = computeHomography(pitchPts, imgPts), i2pRaw = computeHomography(imgPts, pitchPts);
  if (!p2i || !i2pRaw) return { error: tl("lab.err.order") };
  const c = { x: imgPts.reduce((s, p) => s + p.x, 0) / 4, y: imgPts.reduce((s, p) => s + p.y, 0) / 4 };
  const pc = { x: pitchPts.reduce((s, p) => s + p.x, 0) / 4, y: pitchPts.reduce((s, p) => s + p.y, 0) / 4 };
  return { p2i: orientH(p2i, pc), i2p: orientH(i2pRaw, c) };
}

function mapped(cal: Calib | null): (Pt | null)[] {
  if (!cal || "error" in cal) return st.persons.map(() => null);
  if (live.on && live.pos.length === st.persons.length) return live.pos; // tracked, smoothed positions
  if (clip.on && clip.pos.length === st.persons.length) return clip.pos; // the clip frame's tracked positions
  return st.persons.map((p) => toPitch(cal.i2p, feet(p.box)));
}

/** The ball on the picture: live, the smoothed track; picture mode, the best plausible candidate (crowd filter once calibrated). */
function currentBall(cal: Calib | null): (Ball & { predicted?: boolean }) | null {
  if (live.on) return live.ball && (live.ball.hits >= 2 || live.ball.misses === 0)
    ? { box: trackBox(live.ball), score: live.ball.score, predicted: live.ball.misses > 0 } : null;
  if (clip.on) { const f = clipFrame(); return f?.ballBox ? { box: f.ballBox, score: f.ballScore } : null; }
  return pickBall(st.balls, st.persons, cal && !("error" in cal) ? cal.i2p : null, img.width);
}

/** Ball ground point on the pitch (approximate: a ball in the air is mapped too far away). */
function ballOnPitch(cal: Calib | null, ball: Ball | null): Pt | null {
  if (!ball || !cal || "error" in cal) return null;
  return toPitch(cal.i2p, ballGround(ball.box));
}

// ---------- detected pitch lines (calibration assist) ----------
let scan: LineScan | null = null;
const lineCanvas = document.createElement("canvas");
/** Painted lines of the current picture (or frozen frame), computed on demand on a <= 640 px copy, players masked out. */
function getScan(): LineScan | null {
  if (scan) return scan;
  if (!st.loaded || !src.width) return null;
  const k = Math.min(1, LINE_SIDE / Math.max(src.width, src.height));
  lineCanvas.width = Math.max(1, Math.round(src.width * k)); lineCanvas.height = Math.max(1, Math.round(src.height * k));
  const lc = lineCanvas.getContext("2d", { willReadFrequently: true })!;
  lc.drawImage(src, 0, 0, lineCanvas.width, lineCanvas.height);
  const data = lc.getImageData(0, 0, lineCanvas.width, lineCanvas.height);
  const boxes = st.persons.map((p) => ({ x: p.box.x * k, y: p.box.y * k, w: p.box.w * k, h: p.box.h * k }));
  scan = scanLines(data, k, boxes);
  return scan;
}
/** Detected corners in picture pixels. */
function corners(): Pt[] {
  const s = getScan();
  return s ? s.corners.map((c) => toSource(s.scale, c)) : [];
}
const lineScanAllowed = () => !live.on || live.frozen;

function snapRadius(): number {
  const w = img.getBoundingClientRect().width;
  return w > 0 ? (SNAP_CSS_PX * img.width) / w : SNAP_CSS_PX;
}

/** Snaps point i to the nearest detected corner within the radius; returns the distance moved, or null. */
function snapPointAt(i: number, tap: Pt): number | null {
  const s = snapPoint(tap, corners(), snapRadius());
  if (!s) { st.pts[i] = tap; st.snaps[i] = null; return null; }
  st.pts[i] = { ...s.p };
  st.snaps[i] = { from: tap, t0: performance.now(), d: s.d };
  if (!reducedMotion()) animateSnap();
  return s.d;
}

let animUntil = 0;
function animateSnap() {
  animUntil = performance.now() + SNAP_MS;
  const step = () => { render(); if (performance.now() < animUntil) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

const LINE_CORNER_IDS = LANDMARKS.filter((l) => !/spot|^centre$/.test(l.id));
type Fit = { quality: ReturnType<typeof fitQuality>; check: ReturnType<typeof calibrationCheck> };
function fitReport(cal: Calib | null): Fit | null {
  if (!cal || "error" in cal || !lineScanAllowed()) return null;
  const s = getScan();
  if (!s) return null;
  const pitch4 = st.ids.map((id) => landmark(id)!);
  const extra = LINE_CORNER_IDS.filter((l) => !st.ids.includes(l.id));
  return { quality: fitQuality(s, cal.p2i, pitchLines()), check: calibrationCheck(pitch4, st.pts as Pt[], extra, corners()) };
}

// ---------- automatic calibration (autocal.ts): the detected lines matched to the pitch model, no taps ----------
let lastAuto: { res: AutoCalResult; index: number } | null = null;

/** Fills the 4 landmarks and points from a solution (the matched corners first). False when no 4 usable landmarks. */
function applySolution(sol: AutoCal): boolean {
  const four = pickFour(sol, img.width, img.height);
  if (!four) return false;
  st.ids = four.ids; st.pts = four.pts; st.snaps = [null, null, null, null]; st.active = null;
  return true;
}

function showSolution(res: AutoCalResult, index: number, force = false) {
  const sol = index === 0 ? res.best : res.alternatives[index - 1] ?? null;
  const alt = $<HTMLButtonElement>("autocal-alt");
  const ms = Math.round(res.ms);
  if (!sol || (sol.rating === "poor" && !force) || !applySolution(sol)) {
    status.textContent = sol ? tl("lab.st.autocal.poor", { d: num(sol.fitMean ?? 0, 1), ms }) : tl("lab.st.autocal.none");
    alt.hidden = true;
    if (st.active === null && st.pts.some((p) => !p)) st.active = st.pts.findIndex((p) => !p);
    buildCalib(); render();
    return;
  }
  lastAuto = { res, index };
  const second = res.alternatives[0];
  const ambiguous = !!second && !!res.best && second.score < res.best.score * 1.5 + 1;
  alt.hidden = !ambiguous;
  status.textContent = tl("lab.st.autocal.ok", { ms, side: tl(`lab.autocal.side.${sol.side}`), rating: tl(`lab.fit.${sol.rating}`), n: sol.inliers, d: num(sol.fitMean ?? 0, 1) })
    + (ambiguous && index === 0 ? " " + tl("lab.st.autocal.alt") : "");
  status.classList.remove("bad");
  calibChanged(); buildCalib(); render();
}

/** The Auto-calibrate button (picture, or the last camera frame live). Synchronous: bounded to ~300 ms by autocal.ts. */
function runAutoCal(): AutoCalResult | null {
  if (!st.loaded) return null;
  const s = getScan();
  if (!s) { status.textContent = tl("lab.st.autocal.none"); return null; }
  const res = autoCalibrate(s);
  lastAuto = null;
  showSolution(res, 0);
  return res;
}

// ---------- drawing ----------
const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;
function teamColour(l: TeamLabel): string {
  return l === "other" ? "#8d99ae" : rgb(st.teamRgb[l]!);
}
function teamName(l: TeamLabel): string {
  return l === "other" ? tl("lab.team.other") : l === 0 ? "A" : "B";
}

/** The picture (or, live, the current video frame) with the overlays. */
function drawImage(cal: Calib | null, source: CanvasImageSource = src) {
  const ctx = img.getContext("2d")!;
  ctx.drawImage(source, 0, 0, img.width, img.height);
  const u = img.width / 800; // line unit
  if ($<HTMLInputElement>("show-lines").checked && cal && !("error" in cal)) {
    ctx.save();
    ctx.strokeStyle = "rgba(76, 201, 240, 0.95)"; ctx.lineWidth = 2.2 * u; ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 3 * u;
    for (const line of pitchLines()) {
      const dense: Pt[] = [];
      for (let k = 0; k < line.length - 1; k++) for (let t = 0; t < 12; t++) {
        const a = line[k]!, b = line[k + 1]!;
        dense.push({ x: a.x + ((b.x - a.x) * t) / 12, y: a.y + ((b.y - a.y) * t) / 12 });
      }
      dense.push(line[line.length - 1]!);
      ctx.beginPath();
      let pen = false;
      for (const m of dense) {
        const ok = wOf(cal.p2i, m) > 0;
        const q = ok ? applyH(cal.p2i, m) : null;
        if (!q || Math.abs(q.x) > img.width * 4 || Math.abs(q.y) > img.height * 4) { pen = false; continue; }
        if (pen) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  if ($<HTMLInputElement>("show-boxes").checked) {
    ctx.font = `700 ${12 * u}px system-ui, sans-serif`;
    st.persons.forEach((p, i) => {
      const l = st.labels[i] ?? "other";
      ctx.lineWidth = 2 * u;
      ctx.setLineDash(l === "other" ? [4 * u, 3 * u] : []);
      ctx.strokeStyle = i === st.carrier ? "#ffd166" : l === "other" ? "#8d99ae" : l === 0 ? "#ffffff" : "#111111";
      ctx.strokeRect(p.box.x, p.box.y, p.box.w, p.box.h);
      ctx.setLineDash([]);
      const tag = `${i + 1}${l === "other" ? "" : teamName(l)}`;
      const tw = ctx.measureText(tag).width + 6 * u;
      ctx.fillStyle = teamColour(l);
      ctx.fillRect(p.box.x, p.box.y - 15 * u, tw, 15 * u);
      ctx.fillStyle = lum(l) > 0.55 ? "#111" : "#fff";
      ctx.fillText(tag, p.box.x + 3 * u, p.box.y - 3.5 * u);
      const f = feet(p.box);
      ctx.fillStyle = "#ffd166";
      ctx.beginPath(); ctx.arc(f.x, f.y, 2.6 * u, 0, Math.PI * 2); ctx.fill();
    });
  }
  // detected painted lines and their corners (calibration assist)
  const sc = lineScanAllowed() ? (($<HTMLInputElement>("show-detected").checked || st.active !== null) ? getScan() : null) : null;
  if (sc) {
    ctx.save();
    if ($<HTMLInputElement>("show-detected").checked) {
      ctx.strokeStyle = "rgba(255, 159, 28, 0.9)"; ctx.lineWidth = 2 * u;
      for (const l of sc.lines) for (const [a, b] of l.runs) {
        const pa = toSource(sc.scale, pointAt(l, a)), pb = toSource(sc.scale, pointAt(l, b));
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.fillStyle = "rgba(255, 159, 28, 0.85)"; ctx.lineWidth = 1.5 * u;
    for (const c0 of sc.corners) {
      const { x, y } = toSource(sc.scale, c0), r = 4 * u;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  // the ball
  const ball = currentBall(cal);
  if (ball) {
    const c = { x: ball.box.x + ball.box.w / 2, y: ball.box.y + ball.box.h / 2 }, r = Math.max(ball.box.w, ball.box.h) / 2 + 5 * u;
    ctx.save();
    ctx.strokeStyle = "#ff9f1c"; ctx.lineWidth = 2.5 * u; ctx.setLineDash(ball.predicted ? [4 * u, 3 * u] : []);
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 3 * u;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${11 * u}px system-ui, sans-serif`; ctx.fillStyle = "#ff9f1c";
    ctx.fillText(tl("lab.cv.ball", { p: pct(ball.score) }), c.x + r + 3 * u, c.y - r);
    ctx.restore();
  }
  const now = performance.now();
  st.pts.forEach((p, i) => {
    if (!p) return;
    const sn = st.snaps[i];
    if (sn) {
      // where the tap landed, and (briefly) a ring closing on the detected corner
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5 * u; ctx.setLineDash([3 * u, 3 * u]);
      ctx.beginPath(); ctx.moveTo(sn.from.x, sn.from.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(sn.from.x, sn.from.y, 4 * u, 0, Math.PI * 2); ctx.stroke();
      const k = Math.min(1, (now - sn.t0) / SNAP_MS);
      if (k < 1 && !reducedMotion()) {
        const e = 1 - (1 - k) ** 3;
        ctx.strokeStyle = PT_COLOURS[i]!; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * u;
        ctx.beginPath(); ctx.arc(p.x, p.y, (30 - 18 * e) * u, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.lineWidth = 2.5 * u; ctx.strokeStyle = "#000"; ctx.fillStyle = PT_COLOURS[i]!;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x - 15 * u, p.y); ctx.lineTo(p.x + 15 * u, p.y); ctx.moveTo(p.x, p.y - 15 * u); ctx.lineTo(p.x, p.y + 15 * u); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.font = `800 ${11 * u}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), p.x, p.y + 0.5 * u);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  });
}

function lum(l: TeamLabel): number {
  if (l === "other") return 0.5;
  const [r, g, b] = st.teamRgb[l]!;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const TOP_M = 4; // margin around the pitch, metres
function topScale() { return top.width / (PITCH.length + 2 * TOP_M); }
function toTop(p: Pt): Pt {
  const s = topScale();
  return { x: (p.x + PITCH.halfL + TOP_M) * s, y: (PITCH.halfW + TOP_M - p.y) * s };
}

function drawTop(cal: Calib | null, pos: (Pt | null)[], advice: Advice | null, ballPt: Pt | null) {
  const ctx = top.getContext("2d")!, s = topScale();
  ctx.fillStyle = "#14532d"; ctx.fillRect(0, 0, top.width, top.height);
  for (let i = 0; i < 20; i += 2) {
    const a = toTop({ x: -PITCH.halfL + i * 5.25, y: PITCH.halfW }), b = toTop({ x: -PITCH.halfL + (i + 1) * 5.25, y: -PITCH.halfW });
    ctx.fillStyle = "#17602f"; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  ctx.strokeStyle = "rgba(241,250,238,0.75)"; ctx.lineWidth = Math.max(1.5, s * 0.25);
  for (const line of pitchLines()) {
    ctx.beginPath();
    line.forEach((m, k) => { const p = toTop(m); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke();
  }
  // visible area of the picture on the pitch
  if (cal && !("error" in cal)) {
    const corners = [{ x: 0, y: 0 }, { x: img.width, y: 0 }, { x: img.width, y: img.height }, { x: 0, y: img.height }];
    const poly = sampleBorder(corners).map((c) => (wOf(cal.i2p, c) > 0 ? applyH(cal.i2p, c) : null)).filter((q): q is Pt => !!q && Math.abs(q.x) < 400 && Math.abs(q.y) < 400);
    if (poly.length > 2) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, top.width, top.height); ctx.clip();
      ctx.fillStyle = "rgba(76, 201, 240, 0.10)"; ctx.strokeStyle = "rgba(76, 201, 240, 0.6)"; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
      ctx.beginPath(); poly.forEach((q, k) => { const p = toTop(q); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath();
      ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }
  // AI coach: the top options as arrows from the carrier (drawn under the players, labels on top)
  const top3 = advice && st.carrier !== null && pos[st.carrier] ? advice.ranked.slice(0, TOP_N) : [];
  const from = top3.length ? toTop(pos[st.carrier!]!) : null;
  for (let k = top3.length - 1; k >= 0; k--) arrow(ctx, from!, toTop(top3[k]!.to), RANK_COLOURS[k]!, s);
  const r = Math.max(6, s * 1.5);
  // live: estimated velocities, drawn as the distance covered in the next second
  if (live.on || clip.on) pos.forEach((p, i) => {
    const v = velOf(i);
    if (!p || !v || Math.hypot(v.x, v.y) < 0.8) return;
    arrow(ctx, toTop(p), toTop({ x: p.x + v.x, y: p.y + v.y }), "rgba(241,250,238,0.85)", s * 0.45);
  });
  pos.forEach((p, i) => {
    if (!p) return;
    const q = toTop(p), l = st.labels[i] ?? "other";
    ctx.fillStyle = teamColour(l);
    ctx.strokeStyle = i === st.carrier ? "#ffd166" : l === 1 ? "#111" : l === 0 ? "#fff" : "#8d99ae";
    ctx.lineWidth = i === st.carrier ? 4 : 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = lum(l) > 0.55 ? "#111" : "#fff";
    ctx.font = `700 ${r * 1.05}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), q.x, q.y + 0.5);
  });
  ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  if (ballPt) {
    // approximate: the ground point under the ball box (a lofted ball lands too far from the camera)
    const q = toTop(ballPt), br = Math.max(4, s * 0.9);
    ctx.save();
    ctx.strokeStyle = "rgba(255,159,28,0.95)"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(q.x, q.y, br * 2.6, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#111"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(q.x, q.y, br, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = `700 ${Math.max(11, s * 1.5)}px system-ui, sans-serif`; ctx.fillStyle = "#ff9f1c";
    ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 3;
    ctx.fillText(tl("lab.cv.ballApprox"), q.x + br * 2.8, q.y - br * 1.5);
    ctx.restore();
  }
  if (coachText) {
    const placed: Rect[] = [];
    top3.forEach((r, k) => tagAt(ctx, toTop(r.to), from!, `${k + 1} · ${pct(r.option.p)} · ${xg(r.option.score)}`, RANK_COLOURS[k]!, s, placed));
  }
  if (!cal || "error" in cal) {
    ctx.fillStyle = "rgba(7,23,14,0.7)"; ctx.fillRect(0, 0, top.width, top.height);
    ctx.fillStyle = "#f1faee"; ctx.font = `600 ${s * 2.4}px system-ui, sans-serif`; ctx.textAlign = "center";
    ctx.fillText(tl(cal ? "lab.cv.fixCal" : live.on ? "lab.cv.freezePlace" : "lab.cv.place"),
      top.width / 2, top.height / 2);
    ctx.textAlign = "start";
  }
}

function sampleBorder(corners: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!, b = corners[(k + 1) % 4]!;
    for (let t = 0; t < 10; t++) out.push({ x: a.x + ((b.x - a.x) * t) / 10, y: a.y + ((b.y - a.y) * t) / 10 });
  }
  return out;
}

function arrow(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string, s: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, head = Math.max(9, s * 1.6);
  ctx.save();
  ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = Math.max(3, s * 0.5); ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 3;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x - ux * head * 0.8, b.y - uy * head * 0.8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - ux * head - uy * head * 0.55, b.y - uy * head + ux * head * 0.55);
  ctx.lineTo(b.x - ux * head + uy * head * 0.55, b.y - uy * head - ux * head * 0.55);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Label next to an arrow's end, on the far side from the carrier, kept inside the canvas and off earlier labels. */
function tagAt(ctx: CanvasRenderingContext2D, end: Pt, from: Pt, text: string, colour: string, s: number, placed: Rect[]) {
  ctx.save();
  ctx.font = `700 ${Math.max(11, s * 1.7)}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10, h = Math.max(17, s * 2.5);
  let x = end.x >= from.x ? end.x + 6 : end.x - 6 - w, y = end.y - h - 4;
  x = Math.max(2, Math.min(top.width - w - 2, x)); y = Math.max(2, Math.min(top.height - h - 2, y));
  for (let k = 0; k < 6 && placed.some((p) => overlaps(p, { x, y, w, h })); k++) y = Math.min(top.height - h - 2, y + h + 3);
  placed.push({ x, y, w, h });
  ctx.fillStyle = "rgba(7,23,14,0.85)"; ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = colour; ctx.textBaseline = "middle";
  ctx.fillText(text, x + 5, y + h / 2 + 0.5);
  ctx.restore();
}

// ---------- AI coach (lazy: the engine and its 6 kB of weights load on the first carrier tap) ----------
type CoachMod = typeof import("../coach/picture.ts");
let coachText: CoachMod | null = null, coachW: LoadedCoach | null = null, coachErr = "", coachLoading = false;
function ensureCoach() {
  if (coachW || coachLoading || coachErr) return;
  coachLoading = true;
  import("../coach/picture.ts")
    .then(async (m) => { coachW = await m.loadCoach(new URL("coach/models.json", document.baseURI).href); coachText = m; })
    .catch((e) => { console.error(e); coachErr = tl("lab.coach.loadErr"); })
    .finally(() => { coachLoading = false; render(); });
}

type CoachView = { advice: Advice } | { msg: string } | null;
function coachData(pos: (Pt | null)[]): CoachView {
  const c = st.carrier;
  if (c === null) return null;
  if (live.on && !live.frozen) return { msg: tl("lab.coach.freezeFirst") };
  if (clip.on && clip.playing) return { msg: tl("lab.coach.pauseFirst") };
  const team = st.labels[c];
  if (!pos[c] || team === undefined || team === "other") return { msg: tl("lab.coach.carrierTeam") };
  if (!coachW || !coachText) { ensureCoach(); return { msg: coachErr || tl("lab.coach.loading") }; }
  const ps = coachText.stateFromPicture(pos, st.labels, c, st.dir);
  if (!ps) return { msg: tl("lab.coach.carrierTeamShort") };
  if (live.on || clip.on) withVelocities(ps.state, st.dir);
  const advice = coachText.advise(ps, coachW.coach, coachW.models);
  return advice ? { advice } : { msg: tl("lab.coach.noOpp") };
}

/** Live: the tracked velocities (pitch frame) into the coach State (attack-normalised: rotated 180° for the left goal). */
function withVelocities(s: State, dir: 1 | -1) {
  const fill = (idx: number[], out: [number, number][]) => idx.forEach((i, r) => {
    const v = velOf(i);
    if (v) out[r] = dir === 1 ? [v.x, v.y] : [-v.x, -v.y];
  });
  fill(s.attIdx, s.attV as [number, number][]); fill(s.defIdx, s.defV as [number, number][]);
}

function renderSide(pos: (Pt | null)[], view: CoachView) {
  const counts = { 0: 0, 1: 0, other: 0 } as Record<string, number>;
  st.labels.forEach((l) => counts[String(l)]!++);
  $("st-count").textContent = st.ms === null ? "–" : String(st.persons.length);
  $("st-ms").textContent = st.ms === null ? "–" : String(Math.round(st.ms));
  $("st-teams").textContent = st.ms === null ? "–" : `${counts["0"]} / ${counts["1"]} / ${counts["other"]}`;
  $("st-mapped").textContent = st.ms === null ? "–" : String(pos.filter(Boolean).length);
  const moving = live.on || clip.on;
  const nVel = live.on ? live.vel.filter(Boolean).length : clip.on ? clip.vel.filter(Boolean).length : 0;
  $("coach-tag").textContent = tl(live.on ? "lab.coach.tagLive" : clip.on ? "lab.coach.tagClip" : "lab.coach.tagPicture");
  $("coach-still").textContent = !moving ? tl("lab.coach.still") : nVel ? tln("lab.coach.vel", nVel) : tl("lab.coach.noVel");
  const legend = $("legend");
  legend.innerHTML = "";
  if (st.persons.length) {
    for (const l of [0, 1, "other"] as TeamLabel[]) {
      const s = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = teamColour(l);
      if (l === 1) i.className = "b";
      if (l === "other") i.className = "o";
      s.append(i, l === "other" ? tl("lab.legend.other", { n: counts["other"]! }) : tl("lab.legend.team", { t: teamName(l), n: counts[String(l)]! }));
      legend.append(s);
    }
    if (st.separation < 15) {
      const w = document.createElement("span");
      w.textContent = tl("lab.legend.similar");
      w.style.color = "#ffd166";
      legend.append(w);
    }
  }
  const auto = $("coach-auto");
  auto.textContent = st.autoNote; auto.hidden = !st.autoNote;
  const ol = $("coach-list");
  ol.innerHTML = "";
  if (view && "msg" in view) {
    const li = document.createElement("li");
    li.className = "msg"; li.textContent = view.msg;
    ol.append(li);
  } else if (view && coachText) {
    const a = view.advice;
    a.ranked.slice(0, TOP_N).forEach((r, k) => {
      const li = document.createElement("li");
      li.className = `rank-${k + 1}`;
      const head = document.createElement("div");
      head.className = "head";
      const num = document.createElement("span"); num.className = "num"; num.textContent = `${k + 1}.`;
      const title = document.createElement("b"); title.textContent = optionTitle(r.option);
      const ok = document.createElement("span"); ok.textContent = successLabel(r.option);
      const val = document.createElement("span"); val.textContent = tl("lab.opt.value", { xg: xg(r.option.score) });
      head.append(num, title, ok, val);
      const why = document.createElement("ul");
      r.why.phrases.forEach((p, i) => {
        const w = document.createElement("li");
        const sign = r.why.signs[i];
        w.className = sign === 1 ? "helps" : sign === -1 ? "hurts" : "val";
        if (sign === 1 || sign === -1) w.dataset.pre = tl(sign === 1 ? "lab.why.helps" : "lab.why.hurts");
        w.textContent = translatePhrase(p);
        why.append(w);
      });
      li.append(head, why);
      ol.append(li);
    });
    const rest = a.ranked.length - TOP_N;
    if (rest > 0) {
      const li = document.createElement("li");
      li.className = "msg";
      const mates = a.ps.state.att.length - 1, opps = a.ps.state.def.length;
      li.textContent = tln("lab.coach.rest", rest, { mates: tln("lab.mates", mates), opps: tln("lab.opps", opps) });
      ol.append(li);
    }
  }
}

let frame = 0;
function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!st.loaded) return;
    const cal = calibration();
    calibMsg.textContent = cal && "error" in cal ? cal.error
      : cal ? tl("lab.calib.ok")
      : tl(live.on && !live.frozen ? "lab.calib.freezeTap" : "lab.calib.tap", { n: (st.active ?? 0) + 1 });
    calibMsg.classList.toggle("bad", !!cal && "error" in cal);
    const pos = mapped(cal);
    const ballPt = ballOnPitch(cal, currentBall(cal));
    autoCarrier(pos, ballPt);
    const view = coachData(pos);
    drawImage(cal);
    drawTop(cal, pos, view && "advice" in view ? view.advice : null, ballPt);
    renderSide(pos, view);
    renderFit(fitReport(cal));
  });
}

/**
 * Ball found and pitch calibrated: preselect the carrier (nearest team player within 3 m of the ball) and, unless the user
 * chose it, the attacking direction (ball.ts heuristics). A tap on the map overrides it until the next detection.
 */
function autoCarrier(pos: (Pt | null)[], ballPt: Pt | null) {
  if (st.carrierManual || (live.on && !live.frozen) || (clip.on && clip.playing)) return;
  const pick = ballPt ? pickCarrier(ballPt, pos, st.labels) : null;
  if (!pick) {
    if (st.autoNote) { st.carrier = null; st.autoNote = ""; }
    return;
  }
  const team = st.labels[pick.index] as 0 | 1;
  const first = st.carrier !== pick.index || !st.autoNote;
  st.carrier = pick.index;
  let dirNote = "";
  if (!st.dirManual) {
    const ad = attackDirection(pos, st.labels, team);
    if (ad) {
      if (ad.dir !== st.dir) setDir(ad.dir, false);
      dirNote = tl("lab.auto.dir", { side: tl(ad.dir === 1 ? "lab.side.right" : "lab.side.left"), team: teamName(team), own: tl(ad.ownSide === 1 ? "lab.side.right" : "lab.side.left") });
    }
  }
  st.autoNote = [tl("lab.auto.carrier", { n: pick.index + 1, team: teamName(team), d: num(pick.dist, 1) }), dirNote, tl("lab.auto.override")].filter(Boolean).join(" ");
  if (first && !live.on && !clip.on) $<HTMLDetailsElement>("opts").open = true; // picture mode: the coach runs straight away
}

function renderFit(f: Fit | null) {
  const el = $("fit");
  el.className = "hint fit";
  if (!f) { el.textContent = ""; el.hidden = true; return; }
  el.hidden = false;
  const parts: string[] = [];
  if (f.quality) {
    el.classList.add(f.quality.rating);
    parts.push(tl("lab.fit", { rating: tl(`lab.fit.${f.quality.rating}`), d: num(f.quality.mean, 1) }));
  } else parts.push(tl("lab.fit.few"));
  if (f.check) parts.push(f.check.n > 4
    ? tln("lab.fit.err", f.check.n - 4, { e: num(f.check.err, 1) })
    : tl("lab.fit.exact"));
  el.textContent = parts.join(" · ") + ".";
}

// ---------- picture loading ----------
function setPicture(draw: (ctx: CanvasRenderingContext2D) => void, w: number, h: number) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  src.width = Math.round(w * k); src.height = Math.round(h * k);
  const ctx = src.getContext("2d", { willReadFrequently: true })!;
  ctx.save(); ctx.scale(k, k); draw(ctx); ctx.restore();
  img.width = src.width; img.height = src.height;
  top.width = 840; top.height = Math.round(840 * (PITCH.width + 2 * TOP_M) / (PITCH.length + 2 * TOP_M));
  Object.assign(st, { loaded: true, persons: [], colours: [], labels: [], ms: null, carrier: null, separation: 99, balls: [],
    carrierManual: false, dirManual: false, autoNote: "", snaps: [null, null, null, null] });
  scan = null;
  $("work").hidden = false;
}

async function loadFile(file: File) {
  if (!file.type.startsWith("image/")) { status.textContent = tl("lab.st.notPicture"); return; }
  try {
    const bmp = await createImageBitmap(file);
    setPicture((ctx) => ctx.drawImage(bmp, 0, 0), bmp.width, bmp.height);
    bmp.close();
  } catch {
    status.textContent = tl("lab.st.cantRead"); return;
  }
  st.pts = [null, null, null, null]; st.active = 0;
  buildCalib(); render();
  void runDetect();
}

function loadDemo() {
  let H: Mat3 | null = null;
  setPicture((ctx) => { H = drawScene(ctx); }, SCENE_W, SCENE_H);
  st.ids = [...DEFAULT_LANDMARKS];
  // points placed a little off on purpose: drag them onto the box corners and watch the blue lines snap into place
  const nudge = [{ x: 9, y: -6 }, { x: -8, y: 7 }, { x: 6, y: 8 }, { x: -7, y: -9 }];
  st.pts = st.ids.map((id, i) => { const p = applyH(H!, landmark(id)!)!; return { x: p.x + nudge[i]!.x, y: p.y + nudge[i]!.y }; });
  st.active = null;
  buildCalib(); render();
  status.textContent = tl("lab.st.demo");
  void runDetect();
}

/** Team split of one frame's torso colours (k-means, teams.ts). */
function labelTeams(colours: (RGB | null)[]): { labels: TeamLabel[]; teamRgb: RGB[]; separation: number } {
  const valid = colours.map((c, i) => ({ c, i })).filter((x): x is { c: RGB; i: number } => !!x.c);
  const split = splitTeams(valid.map((v) => v.c));
  const labels: TeamLabel[] = colours.map(() => "other");
  valid.forEach((v, k) => { labels[v.i] = split.labels[k]!; });
  const teamRgb: RGB[] = [0, 1].map((t) => {
    const cs = valid.filter((_, k) => split.labels[k] === t).map((v) => v.c);
    return cs.length ? (cs.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => v / cs.length) as RGB) : st.teamRgb[t]!;
  });
  return { labels, teamRgb, separation: split.separation };
}

async function runDetect() {
  if (st.busy || !st.loaded) return;
  st.busy = true;
  const btn = $<HTMLButtonElement>("detect");
  btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.replaceChildren(spinner(), tl("lab.detecting"));
  const busy = (t: string) => status.replaceChildren(spinner(), t);
  try {
    busy(tl("lab.st.loadingDetector"));
    const t0 = performance.now();
    await loadDetector();
    const loadMs = performance.now() - t0;
    busy(tl("lab.st.detectingPeople"));
    await new Promise((r) => setTimeout(r, 30));
    const run = await detectPeople(src, $<HTMLInputElement>("tiled").checked);
    // number players from left to right
    const persons = run.persons.sort((a, b) => feet(a.box).x - feet(b.box).x);
    const data = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
    const colours = persons.map((p) => meanColour(data, torsoBox(p.box)));
    const { labels, teamRgb, separation } = labelTeams(colours);
    Object.assign(st, { persons, colours, labels, teamRgb, separation, ms: run.ms, carrier: null, balls: run.balls, carrierManual: false, autoNote: "" });
    scan = null; // the players are masked out of the line search
    const cal = calibration();
    const ball = pickBall(run.balls, persons, cal && !("error" in cal) ? cal.i2p : null, img.width);
    status.textContent = [
      tl("lab.st.found", { people: tln("lab.people", persons.length), ms: Math.round(run.ms), passes: tln("lab.passes", run.passes),
        load: loadMs > 50 ? tl("lab.st.loadedIn", { s: num(loadMs / 1000, 1) }) : "" }),
      persons.length === 0 ? tl("lab.st.nobody") : "",
      ball ? tl("lab.st.ball", { p: pct(ball.score) }) : tl($<HTMLInputElement>("tiled").checked ? "lab.st.noBall" : "lab.st.noBallTiled"),
    ].filter(Boolean).join(" ");
  } catch (e) {
    console.error(e);
    status.textContent = tl("lab.st.detFail");
  } finally {
    st.busy = false; btn.disabled = false; btn.removeAttribute("aria-busy"); btn.replaceChildren(tl("lab.detect"));
    render();
  }
}

// ---------- interaction ----------
function canvasPoint(c: HTMLCanvasElement, e: PointerEvent): Pt {
  const r = c.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
}

img.addEventListener("pointerdown", (e) => {
  if (!st.loaded) return;
  const p = canvasPoint(img, e);
  const hit = (24 * img.width) / img.getBoundingClientRect().width;
  const near = st.pts.findIndex((q) => q && Math.hypot(q.x - p.x, q.y - p.y) < hit);
  if (near >= 0) {
    st.drag = near; img.setPointerCapture(e.pointerId); e.preventDefault(); return;
  }
  if (st.active !== null) {
    const i = st.active;
    const d = snapPointAt(i, p);
    const next = st.pts.findIndex((q) => !q);
    st.active = next >= 0 ? next : null;
    calibChanged(); buildCalib(); render();
    if (d !== null) status.textContent = tl("lab.st.snapped", { n: i + 1, d: num(d, 0) });
    return;
  }
  const inBox = st.persons.map((q, i) => ({ q, i }))
    .filter(({ q }) => p.x >= q.box.x && p.x <= q.box.x + q.box.w && p.y >= q.box.y && p.y <= q.box.y + q.box.h)
    .sort((a, b) => a.q.box.w * a.q.box.h - b.q.box.w * b.q.box.h)[0];
  if (inBox) {
    const cur = st.labels[inBox.i];
    st.labels[inBox.i] = cur === 0 ? 1 : cur === 1 ? "other" : 0;
    render();
  }
});
img.addEventListener("pointermove", (e) => {
  if (st.drag === null) return;
  const p = canvasPoint(img, e);
  st.snaps[st.drag] = null; // dragging undoes a snap (and never snaps)
  st.pts[st.drag] = { x: Math.max(0, Math.min(img.width, p.x)), y: Math.max(0, Math.min(img.height, p.y)) };
  calibChanged(); render();
});
const endDrag = () => { st.drag = null; };
img.addEventListener("pointerup", endDrag);
img.addEventListener("pointercancel", endDrag);

top.addEventListener("pointerdown", (e) => {
  const cal = calibration();
  const pos = mapped(cal);
  const s = topScale(), p = canvasPoint(top, e);
  const m = { x: p.x / s - PITCH.halfL - TOP_M, y: PITCH.halfW + TOP_M - p.y / s };
  let best = -1, bestD = 5;
  pos.forEach((q, i) => { if (q && Math.hypot(q.x - m.x, q.y - m.y) < bestD) { bestD = Math.hypot(q.x - m.x, q.y - m.y); best = i; } });
  if (best >= 0) {
    st.carrier = best === st.carrier ? null : best; st.carrierManual = true; st.autoNote = "";
    ($<HTMLDetailsElement>("opts")).open = true; render();
  }
});

function setDir(d: 1 | -1, manual = true) {
  if (manual) st.dirManual = true;
  st.dir = d;
  $("dir-left").setAttribute("aria-pressed", String(d === -1));
  $("dir-right").setAttribute("aria-pressed", String(d === 1));
  render();
}
for (const b of document.querySelectorAll<HTMLElement>("[data-icon], [data-icon-after]")) {
  const after = b.dataset.iconAfter;
  setIconText(b, (after ?? b.dataset.icon) as IconName, b.textContent ?? "", !!after);
}
$("dir-left").addEventListener("click", () => setDir(-1));
$("dir-right").addEventListener("click", () => setDir(1));
$("clear-carrier").addEventListener("click", () => { st.carrier = null; st.carrierManual = true; st.autoNote = ""; render(); });
$("snap-all").addEventListener("click", () => {
  let n = 0;
  st.pts.forEach((p, i) => { if (p && snapPointAt(i, st.snaps[i]?.from ?? p) !== null) n++; });
  status.textContent = n ? tln("lab.st.snappedN", n) : tl("lab.st.noSnap");
  calibChanged(); buildCalib(); render();
});
$("autocal").addEventListener("click", () => { runAutoCal(); });
$("autocal-alt").addEventListener("click", () => {
  if (!lastAuto) return;
  const n = 1 + lastAuto.res.alternatives.length;
  showSolution(lastAuto.res, (lastAuto.index + 1) % n, true);
});
$("reset-pts").addEventListener("click", () => { st.pts = [null, null, null, null]; st.snaps = [null, null, null, null]; st.active = 0; calibChanged(); buildCalib(); render(); });
$("detect").addEventListener("click", () => void runDetect());
$("demo").addEventListener("click", loadDemo);
for (const id of ["show-lines", "show-boxes", "show-detected"]) $(id).addEventListener("change", render);

const fileInput = $<HTMLInputElement>("file");
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; if (f) void loadFile(f); fileInput.value = ""; });
const drop = $("drop");
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
for (const el of [drop, img]) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  el.addEventListener("dragleave", () => drop.classList.remove("over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f && mode === "picture") void loadFile(f);
  });
}


// ---------- live camera mode ----------
// The video is drawn into `src` on every animation frame (smooth picture, boxes from the last detection on top); the
// detector runs on a throttled loop whose interval follows the measured processing time (live.ts: nextThrottle).
const LIVE_MAX_SIDE = 1280;
const lastBox = new Map<number, Person>(); // track id -> its last detected box
const video = $<HTMLVideoElement>("cam"), camMsg = $("cam-msg");

const live = {
  on: false,
  stream: null as MediaStream | null,
  frozen: false,
  raf: 0,
  timer: 0 as ReturnType<typeof setTimeout> | 0,
  throttle: START_THROTTLE as Throttle,
  fps: null as number | null,
  lastStart: 0,
  lastT: 0,
  tracks: [] as Track[],
  nextId: 1,
  pos: [] as (Pt | null)[], // smoothed pitch position per st.persons index
  vel: [] as (Pt | null)[], // m/s, null until a track has a few hits
  cents: null as Centroids | null,
  ball: null as BallTrack | null,   // smoothed ball, image pixels
  ballT: 0,
  moved: false,
  err: "",
  // calibration upkeep (every CAL_WATCH.periodMs, off the detection loop): residual watch, line refinement, auto recalibration
  watch: START_WATCH as CalWatch,
  calTimer: 0 as ReturnType<typeof setInterval> | 0,
  calBusy: false,
  inTick: false,
  nextFull: 0,      // earliest time of the next full automatic search after a camera move
  autoText: "",     // "recalibrated automatically" notice, shown until autoUntil
  autoUntil: 0,
};

function camStatus(text: string, bad = false, busy = false) {
  camMsg.replaceChildren(...(busy ? [spinner()] : []), text);
  camMsg.classList.toggle("bad", bad);
}

function resetTracking() {
  lastBox.clear();
  Object.assign(live, { tracks: [], pos: [], vel: [], lastT: 0, moved: false, ball: null, ballT: 0 });
}

/** Called whenever the calibration points or landmarks change: tracks and the camera reference restart. */
function calibChanged() {
  if (!live.on) return;
  resetTracking();
  live.watch = START_WATCH;
}

type Mode = "picture" | "live" | "clip";
let mode: Mode = "picture";
function setMode(m: Mode) {
  if (mode === m) return;
  mode = m;
  const on = m === "live";
  live.on = on;
  document.body.classList.toggle("live", on);
  document.body.classList.toggle("clip", m === "clip");
  for (const k of ["picture", "live", "clip"] as const) $(`mode-${k}`).setAttribute("aria-pressed", String(k === m));
  $("load-card").hidden = m !== "picture";
  $("live-card").hidden = !on;
  $("live-actions").hidden = !on;
  stopCamera();
  stopClip();
  clip.on = m === "clip";
  // the picture (or the last camera frame) belongs to the other mode
  Object.assign(st, { loaded: false, persons: [], colours: [], labels: [], ms: null, carrier: null, pts: [null, null, null, null], active: 0,
    snaps: [null, null, null, null], balls: [], carrierManual: false, dirManual: false, autoNote: "" });
  scan = null;
  live.cents = null; live.watch = START_WATCH; resetTracking(); setFrozen(false);
  $("work").hidden = true;
  status.textContent = "";
  camStatus(on ? tl("lab.cam.private") : "");
  buildCalib();
}

async function startCamera() {
  if (live.stream) return;
  const btn = $<HTMLButtonElement>("cam-start");
  btn.disabled = true;
  camStatus(tl("lab.cam.asking"), false, true);
  let stream: MediaStream;
  try {
    stream = await openCamera();
  } catch (e) {
    console.warn(e);
    camStatus(CAMERA_MESSAGES[cameraProblem(e)], true);
    btn.disabled = false;
    return;
  }
  if (!live.on) { stopStream(stream); btn.disabled = false; return; } // the user left live mode meanwhile
  live.stream = stream;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  } catch (e) {
    console.warn(e);
    stopCamera(); camStatus(CAMERA_MESSAGES.other, true); btn.disabled = false;
    return;
  }
  const k = Math.min(1, LIVE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  src.width = Math.round(video.videoWidth * k); src.height = Math.round(video.videoHeight * k);
  img.width = src.width; img.height = src.height;
  top.width = 840; top.height = Math.round(840 * (PITCH.width + 2 * TOP_M) / (PITCH.length + 2 * TOP_M));
  Object.assign(st, { loaded: true, persons: [], colours: [], labels: [], ms: null, carrier: null, separation: 99, carrierManual: false, autoNote: "" });
  scan = null;
  live.throttle = START_THROTTLE; live.fps = null; live.lastStart = 0; live.err = "";
  resetTracking(); setFrozen(false);
  $("work").hidden = false;
  btn.hidden = true; btn.disabled = false;
  $("cam-stop").hidden = false;
  camStatus(tl("lab.cam.on"));
  drawLoop();
  $("work").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  status.replaceChildren(spinner(), tl("lab.st.loadingDetector"));
  try {
    await loadVideoDetector();
  } catch (e) {
    console.error(e);
    status.textContent = tl("lab.st.detFailCam");
    return;
  }
  schedule(0);
  if (live.calTimer) clearInterval(live.calTimer);
  live.calTimer = setInterval(calTick, CAL_WATCH.periodMs);
  buildCalib(); render();
}

function stopCamera() {
  stopStream(live.stream);
  live.stream = null;
  video.srcObject = null;
  if (live.raf) cancelAnimationFrame(live.raf);
  if (live.timer) clearTimeout(live.timer);
  if (live.calTimer) clearInterval(live.calTimer);
  live.raf = 0; live.timer = 0; live.calTimer = 0;
  $("cam-start").hidden = false;
  $("cam-stop").hidden = true;
}

const sctx = () => src.getContext("2d", { willReadFrequently: true })!;
// the frame being detected; copied into `src` only when its result is used, so a frozen frame always matches its boxes
const work = document.createElement("canvas");
const wctx = () => work.getContext("2d", { willReadFrequently: true })!;

function drawLoop() {
  live.raf = requestAnimationFrame(() => {
    if (!live.stream) return;
    // the video goes straight to the screen; `src` only gets a copy at each detection (it stays as the frozen frame)
    if (!live.frozen && video.readyState >= 2) drawImage(calibration(), video);
    drawLoop();
  });
}

function schedule(ms: number) {
  if (live.timer) clearTimeout(live.timer);
  live.timer = setTimeout(() => void tick(), ms);
}

async function tick() {
  live.timer = 0;
  if (!live.stream || live.frozen || document.hidden || video.readyState < 2) { if (live.stream && !live.frozen) schedule(200); return; }
  const t0 = performance.now();
  if (live.lastStart && t0 - live.lastStart < 3000) live.fps = nextFps(live.fps, t0 - live.lastStart); // skip the detector warm-up
  live.lastStart = t0;
  try {
    if (work.width !== src.width || work.height !== src.height) { work.width = src.width; work.height = src.height; }
    wctx().drawImage(video, 0, 0, work.width, work.height);
    live.inTick = true;
    const run = await detectVideoFrame(work, $<HTMLInputElement>("live-tiled").checked);
    if (!live.stream || live.frozen) return; // stopped or frozen while detecting
    processFrame(run.persons, run.balls, run.ms, t0);
  } catch (e) {
    console.error(e);
    status.textContent = tl("lab.st.liveFail");
    return;
  } finally {
    live.inTick = false;
  }
  const spent = performance.now() - t0;
  live.throttle = nextThrottle(live.throttle, spent);
  schedule(delayUntilNext(live.throttle.interval, spent));
  render();
}

/** One detection result: team colours, camera-move check, mapping through the homography and tracking. */
function processFrame(found: Person[], balls: Ball[], ms: number, now: number) {
  sctx().drawImage(work, 0, 0);
  scan = null; // a new frame
  const data = wctx().getImageData(0, 0, work.width, work.height);
  const cal = calibration();
  const ok = !!cal && !("error" in cal);
  let persons = found;
  let colours = persons.map((p) => meanColour(data, torsoBox(p.box)));
  if (!ok) live.moved = false; // else: calTick() keeps live.moved from the reprojection residual
  // teams: per-frame split until calibrated, then fixed centroids so the labels do not flip between frames
  if (ok && !live.cents) {
    live.cents = fixCentroids(colours.filter((c): c is RGB => !!c));
    if (live.cents) st.teamRgb = live.cents.rgb.slice(0, 2);
  }
  let labels: TeamLabel[], separation: number;
  if (live.cents) {
    labels = colours.map((c) => (c ? assignTeam(c, live.cents!) : "other"));
    separation = live.cents.separation;
  } else {
    const lt = labelTeams(colours);
    labels = lt.labels; separation = lt.separation; st.teamRgb = lt.teamRgb;
  }
  let pos: (Pt | null)[] = [], vel: (Pt | null)[] = [];
  if (ok) {
    const raw = persons.map((p) => toPitch(cal.i2p, feet(p.box)));
    const idx = raw.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const dt = live.lastT ? (now - live.lastT) / 1000 : live.throttle.interval / 1000;
    live.lastT = now;
    const res = stepTracks(live.tracks, idx.map((i) => ({ p: raw[i]!, team: labels[i]! })), dt, live.nextId);
    live.tracks = res.tracks; live.nextId = res.nextId;
    const trackOf: (Track | null)[] = persons.map(() => null);
    idx.forEach((i, k) => { trackOf[i] = res.byDet[k]!; lastBox.set(res.byDet[k]!.id, persons[i]!); });
    type Row = { person: Person; colour: RGB | null; label: TeamLabel; track: Track | null };
    const rows: Row[] = persons.map((person, i) => ({ person, colour: colours[i]!, label: trackOf[i]?.team ?? labels[i]!, track: trackOf[i]! }));
    // a player missed for a frame or two stays on the map at his predicted position (last box on the picture)
    for (const t of live.tracks) {
      const box = lastBox.get(t.id);
      if (t.misses > 0 && box) rows.push({ person: box, colour: null, label: t.team, track: t });
    }
    const alive = new Set(live.tracks.map((t) => t.id));
    for (const id of lastBox.keys()) if (!alive.has(id)) lastBox.delete(id);
    // order players by track id: their numbers stay the same from frame to frame while they are tracked
    rows.sort((a, b) => (a.track?.id ?? 1e9) - (b.track?.id ?? 1e9));
    persons = rows.map((r) => r.person);
    colours = rows.map((r) => r.colour);
    labels = rows.map((r) => r.label);
    pos = rows.map((r) => r.track?.p ?? null);
    vel = rows.map((r) => (r.track ? trackVelocity(r.track) : null));
  }
  live.pos = pos; live.vel = vel;
  // the ball: best candidate of this frame (crowd filter once calibrated), smoothed by its own tracker
  const meas = pickBall(balls, found, ok ? cal.i2p : null, work.width);
  const bdt = live.ballT ? (now - live.ballT) / 1000 : live.throttle.interval / 1000;
  live.ballT = now;
  live.ball = stepBall(live.ball, meas, bdt, work.width);
  Object.assign(st, { persons, colours, labels, separation, ms, carrier: null, carrierManual: false, autoNote: "" });
  const fps = live.fps === null ? "–" : num(live.fps, 1);
  if (live.moved) {
    status.textContent = tl(performance.now() < live.nextFull ? "lab.st.movedAuto" : "lab.st.moved");
  } else if (live.autoText && now < live.autoUntil) {
    status.textContent = live.autoText;
  } else {
    status.textContent = tl("lab.live.status", { fps, ms: Math.round(ms), people: tln("lab.people", persons.length) }) +
      (ok ? (live.cents ? tl("lab.live.fixed") : "") : tl("lab.live.uncal")) + (live.ball ? tl("lab.live.ball") : "");
  }
  status.classList.toggle("bad", live.moved);
}

/**
 * Calibration upkeep, every CAL_WATCH.periodMs on its own timer (skipped while a detection, a drag or another upkeep is in
 * progress): the reprojection residual of the current calibration on the last detected frame feeds the residual watch;
 * calm: the calibration is refined from the lines (seeded by the current one) and the 4 points eased towards the result;
 * moved: a full automatic search replaces the calibration (retried every CAL_WATCH.retryMs while it fails).
 */
function calTick() {
  if (!live.on || !live.stream || live.frozen || document.hidden || live.calBusy || live.inTick || st.busy || st.drag !== null) return;
  const cal = calibration();
  if (!cal || "error" in cal) return;
  live.calBusy = true;
  try {
    const s = getScan();
    if (!s) return;
    live.watch = watchResidual(live.watch, residualOf(s, cal.p2i));
    if (live.watch.moved) {
      const t = performance.now();
      if (t >= live.nextFull) {
        live.nextFull = t + CAL_WATCH.retryMs;
        const res = autoCalibrate(s);
        if (res.best && res.best.rating !== "poor" && applySolution(res.best)) {
          resetTracking();
          live.watch = watchResidual(START_WATCH, residualOf(s, res.best.H));
          live.moved = false; live.nextFull = 0;
          live.autoText = tl("lab.st.autoRecal", { d: num(res.best.fitMean ?? 0, 1) }); live.autoUntil = t + 4000;
          status.textContent = live.autoText; status.classList.remove("bad");
          buildCalib(); render();
          return;
        }
      }
      live.moved = true;
      return;
    }
    live.moved = false;
    const r = refineCalibration(s, cal.p2i);
    if (!r || r.rating === "poor") return;
    const next = st.ids.map((id) => { const m = landmark(id)!; return wOf(r.H, m) > 0 ? applyH(r.H, m) : null; });
    st.pts = blendPoints(st.pts, next, CAL_WATCH.alpha);
    st.snaps = [null, null, null, null];
  } finally {
    live.calBusy = false;
  }
}

function setFrozen(f: boolean) {
  live.frozen = f;
  const b = $("freeze");
  b.textContent = tl(f ? "lab.resume" : "lab.freeze");
  b.setAttribute("aria-pressed", String(f));
  $("work").querySelector(".stage")!.classList.toggle("frozen", f && live.on);
  if (!live.stream) return;
  if (f) {
    if (live.timer) clearTimeout(live.timer);
    live.timer = 0;
  } else {
    // a resumed stream: the old tracks are stale (the time gap breaks the velocities)
    st.carrier = null; resetTracking(); live.lastStart = 0;
    schedule(0);
  }
  render();
}

$("mode-picture").addEventListener("click", () => setMode("picture"));
$("mode-live").addEventListener("click", () => setMode("live"));
$("mode-clip").addEventListener("click", () => setMode("clip"));
$("cam-start").addEventListener("click", () => void startCamera());
$("cam-stop").addEventListener("click", () => { stopCamera(); setFrozen(true); camStatus(tl("lab.cam.stopped")); });
$("freeze").addEventListener("click", () => setFrozen(!live.frozen));
$("ask-coach").addEventListener("click", () => {
  setFrozen(true);
  $<HTMLDetailsElement>("opts").open = true;
  status.textContent = tl(live.ball ? "lab.st.frozenBall" : "lab.st.frozenNoBall");
  status.classList.remove("bad");
  top.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("recal").addEventListener("click", () => {
  setFrozen(true);
  st.pts = [null, null, null, null]; st.snaps = [null, null, null, null]; st.active = 0;
  live.cents = null; live.watch = START_WATCH; live.moved = false; resetTracking();
  status.textContent = tl("lab.st.recal");
  status.classList.remove("bad");
  buildCalib(); render();
});
// ---------- video clip mode: offline analysis of a local file (cliprun.ts), replay, team numbers, heatmaps (clip.ts) ----------
// The analysed frames are replayed through the picture pipeline: the selected frame is drawn into `src`, its tracked players
// become st.persons, its calibration the 4 points, and the coach reads it (paused) with the tracked velocities.
const clipVideo = $<HTMLVideoElement>("clip-video"), clipMsg = $("clip-msg");
const clip = {
  on: false,
  run: null as ClipRun | null,
  idx: -1,
  want: -1,
  showing: false,
  pos: [] as (Pt | null)[],
  vel: [] as (Pt | null)[],
  playing: false,
  timer: 0 as ReturnType<typeof setTimeout> | 0,
  abort: null as AbortController | null,
  url: "",
};
function clipFrame(): ClipFrame | null { return clip.run && clip.idx >= 0 ? clip.run.frames[clip.idx] ?? null : null; }
function velOf(i: number): Pt | null { return (live.on ? live.vel[i] : clip.on ? clip.vel[i] : null) ?? null; }

function clipStatus(text: string, bad = false, busy = false) {
  clipMsg.replaceChildren(...(busy ? [spinner()] : []), text);
  clipMsg.classList.toggle("bad", bad);
}

function stopClip() {
  clip.abort?.abort(); clip.abort = null;
  pauseClip();
  Object.assign(clip, { run: null, idx: -1, want: -1, pos: [], vel: [] });
  if (clip.url) { URL.revokeObjectURL(clip.url); clip.url = ""; clipVideo.removeAttribute("src"); clipVideo.load(); }
  $("clip-nav").hidden = true; $("clip-results").hidden = true; $("clip-progress").hidden = true; $("clip-cancel").hidden = true;
  clipStatus("");
}

/** Resolves once the video has a first frame (false on a decoding error). A MediaRecorder webm has no duration: seek far to learn it. */
async function clipReady(): Promise<boolean> {
  const ok = await new Promise<boolean>((r) => {
    if (clipVideo.readyState >= 2) { r(true); return; }
    clipVideo.addEventListener("loadeddata", () => r(true), { once: true });
    clipVideo.addEventListener("error", () => r(false), { once: true });
  });
  if (!ok || !clipVideo.videoWidth) return false;
  if (!Number.isFinite(clipVideo.duration)) { await seekTo(clipVideo, 1e7); await seekTo(clipVideo, 0); }
  return clipVideo.duration > 0 && Number.isFinite(clipVideo.duration);
}

async function loadClip(file: File) {
  if (!file.type.startsWith("video/") && !/\.(mp4|webm|m4v|mov)$/i.test(file.name)) { clipStatus(tl("lab.clip.notVideo"), true); return; }
  stopClip();
  Object.assign(st, { loaded: false, persons: [], colours: [], labels: [], ms: null, carrier: null, balls: [], carrierManual: false, dirManual: false, autoNote: "" });
  $("work").hidden = true;
  const url = URL.createObjectURL(file);
  clip.url = url;
  clipVideo.src = url;
  clipStatus(tl("lab.clip.opening"), false, true);
  if (!(await clipReady())) { if (clip.url === url) clipStatus(tl("lab.clip.cantRead"), true); return; }
  if (clip.url !== url) return;
  const size = processingSize(clipVideo.videoWidth, clipVideo.videoHeight);
  src.width = size.w; src.height = size.h; img.width = size.w; img.height = size.h;
  top.width = 840; top.height = Math.round(840 * (PITCH.width + 2 * TOP_M) / (PITCH.length + 2 * TOP_M));
  const ctrl = new AbortController();
  clip.abort = ctrl;
  const prog = $<HTMLProgressElement>("clip-progress");
  prog.hidden = false; prog.value = 0;
  $("clip-cancel").hidden = false;
  clipStatus(tl("lab.st.loadingDetector"), false, true);
  let run: ClipRun;
  try {
    run = await analyseClip(clipVideo, {
      tiled: $<HTMLInputElement>("clip-tiled").checked, signal: ctrl.signal,
      onProgress: ({ done, total, frame }) => {
        if (clip.abort !== ctrl) return;
        prog.value = done / total;
        clipStatus(tl("lab.clip.progress", { done, total, ms: Math.round(frame?.ms ?? 0) }), false, true);
      },
    });
  } catch (e) {
    console.error(e);
    if (clip.abort === ctrl) { clip.abort = null; prog.hidden = true; $("clip-cancel").hidden = true; clipStatus(tl("lab.clip.fail"), true); }
    return;
  }
  if (clip.abort !== ctrl) return; // another clip, or another mode, meanwhile
  clip.abort = null;
  prog.hidden = true; $("clip-cancel").hidden = true;
  if (!run.frames.length) { clipStatus(tl("lab.clip.none"), true); return; }
  clip.run = run;
  clipStatus([tl(run.cancelled ? "lab.clip.cancelled" : "lab.clip.done", { n: run.frames.length, s: num(run.totalMs / 1000, 1) }),
    run.capped ? tl("lab.clip.capped", { s: CLIP.maxSec }) : ""].filter(Boolean).join(" "));
  st.loaded = true;
  $("work").hidden = false; $("clip-nav").hidden = false;
  const scrub = $<HTMLInputElement>("clip-scrub");
  scrub.max = String(run.frames.length - 1);
  renderClipResults(run);
  await showClipFrame(Math.max(0, run.frames.findIndex((f) => f.status === "ok")));
}

/** Shows analysed frame i (seeks the video, then swaps the frame into the picture pipeline); fast scrubbing keeps the last wish. */
async function showClipFrame(i: number) {
  const run = clip.run;
  if (!run) return;
  clip.want = Math.max(0, Math.min(run.frames.length - 1, i));
  if (clip.showing) return;
  clip.showing = true;
  try {
    while (clip.run === run && clip.want !== clip.idx) {
      const k = clip.want, f = run.frames[k]!;
      await seekTo(clipVideo, f.t);
      if (clip.run !== run) return;
      src.getContext("2d", { willReadFrequently: true })!.drawImage(clipVideo, 0, 0, src.width, src.height);
      setClipFrame(run, k, f);
    }
  } finally {
    clip.showing = false;
  }
}

function setClipFrame(run: ClipRun, k: number, f: ClipFrame) {
  clip.idx = k;
  const seen = f.players.filter((q) => q.box);
  Object.assign(st, {
    persons: seen.map((q) => ({ box: q.box!, score: 1 })), colours: seen.map(() => null), labels: seen.map((q) => q.team),
    teamRgb: run.teamRgb.slice(0, 2), separation: run.separation, ms: f.ms, carrier: null, balls: [], carrierManual: false, autoNote: "",
    snaps: [null, null, null, null], ids: f.cal ? [...f.cal.ids] : [...DEFAULT_LANDMARKS], pts: f.cal ? f.cal.pts.map((p) => ({ ...p })) : [null, null, null, null],
    active: f.cal ? null : 0,
  });
  clip.pos = seen.map((q) => q.p); clip.vel = seen.map((q) => q.v);
  scan = null;
  $<HTMLInputElement>("clip-scrub").value = String(k);
  $("clip-time").textContent = tl("lab.clip.time", { t: num(f.t, 1), d: num(Math.min(run.duration, CLIP.maxSec), 1), k: k + 1, n: run.frames.length });
  const note = f.status === "ok"
    ? tl("lab.clip.frame.ok", { people: tln("lab.people", seen.length), rating: tl(`lab.fit.${f.rating ?? "check"}`) })
    : tl(f.status === "noPitch" ? "lab.clip.frame.noPitch" : "lab.clip.frame.poorCal");
  status.textContent = note + (f.cut ? " " + tl("lab.clip.frame.cut") : "");
  status.classList.toggle("bad", f.status !== "ok");
  buildCalib(); render();
}

function pauseClip() {
  clip.playing = false;
  if (clip.timer) clearTimeout(clip.timer);
  clip.timer = 0;
  const b = $("clip-play");
  b.textContent = tl("lab.clip.play"); b.setAttribute("aria-pressed", "false");
}

function playClip() {
  const run = clip.run;
  if (!run) return;
  clip.playing = true;
  const b = $("clip-play");
  b.textContent = tl("lab.clip.pause"); b.setAttribute("aria-pressed", "true");
  const period = 1000 / run.fps;
  const step = async () => {
    if (!clip.playing || clip.run !== run) return;
    const t0 = performance.now(), next = clip.idx + 1;
    if (next >= run.frames.length) { pauseClip(); render(); return; }
    await showClipFrame(next);
    clip.timer = setTimeout(() => void step(), Math.max(0, period - (performance.now() - t0)));
  };
  if (clip.idx >= run.frames.length - 1) void showClipFrame(0).then(() => { clip.timer = setTimeout(() => void step(), period); });
  else clip.timer = setTimeout(() => void step(), period);
  render();
}

const HEAT = { cols: 21, rows: 14, margin: 3 } as const;
function drawHeat(cv: HTMLCanvasElement, bins: number[], colour: RGB) {
  const M = HEAT.margin, s = cv.width / (PITCH.length + 2 * M);
  cv.height = Math.round(s * (PITCH.width + 2 * M));
  const ctx = cv.getContext("2d")!;
  const P = (p: Pt) => ({ x: (p.x + PITCH.halfL + M) * s, y: (PITCH.halfW + M - p.y) * s });
  ctx.fillStyle = "#14532d"; ctx.fillRect(0, 0, cv.width, cv.height);
  const max = Math.max(1, ...bins), cw = PITCH.length / HEAT.cols, ch = PITCH.width / HEAT.rows;
  for (let r = 0; r < HEAT.rows; r++) for (let c = 0; c < HEAT.cols; c++) {
    const v = bins[r * HEAT.cols + c]! / max;
    if (v <= 0) continue;
    const a = P({ x: -PITCH.halfL + c * cw, y: -PITCH.halfW + (r + 1) * ch }), b = P({ x: -PITCH.halfL + (c + 1) * cw, y: -PITCH.halfW + r * ch });
    ctx.fillStyle = `rgba(${colour.map((x) => Math.round(x)).join(",")},${(0.15 + 0.8 * Math.sqrt(v)).toFixed(3)})`;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  ctx.strokeStyle = "rgba(241,250,238,0.7)"; ctx.lineWidth = Math.max(1, s * 0.25);
  for (const line of pitchLines()) {
    ctx.beginPath();
    line.forEach((m, k) => { const p = P(m); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke();
  }
}

function renderClipResults(run: ClipRun) {
  const fr = run.frames;
  const sides = guessSides(fr), nums = teamNumbers(fr, sides.sides), poss = possessionShare(fr), d = diagnostics(fr, run.fps);
  const side = (s: 1 | -1) => tl(s === -1 ? "lab.side.left" : "lab.side.right");
  $("clip-sides").textContent = sides.n
    ? tl("lab.clip.sides", { a: side(sides.sides[0]), b: side(sides.sides[1]), p: pct(sides.agree), n: sides.n })
    : tl("lab.clip.sidesNone");
  const table = $<HTMLTableElement>("clip-table");
  table.replaceChildren();
  const cap = table.createCaption();
  cap.className = "fine"; cap.textContent = tl("lab.clip.tableCap");
  const head = table.createTHead().insertRow();
  for (const h of [tl("lab.clip.col.metric"), tl("lab.clip.team", { t: "A" }), tl("lab.clip.team", { t: "B" })]) {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.append(th);
  }
  const body = table.createTBody();
  const metres = (a: Avg) => a.mean === null ? "–" : tl("lab.clip.approxM", { v: num(a.mean, 1) });
  const row = (label: string, cells: [string, string], notes: [string, string] = ["", ""]) => {
    const tr = body.insertRow();
    const th = document.createElement("th"); th.scope = "row"; th.textContent = label; tr.append(th);
    cells.forEach((c, k) => {
      const td = tr.insertCell(); td.textContent = c;
      if (notes[k]) { const sm = document.createElement("small"); sm.textContent = " " + notes[k]; td.append(sm); }
    });
  };
  const nNote = (a: Avg) => a.n ? tln("lab.clip.frames", a.n) : "";
  for (const key of ["width", "depth", "lineHeight", "gapDM", "gapMA"] as const)
    row(tl(`lab.clip.m.${key}`), [metres(nums[0][key]), metres(nums[1][key])], [nNote(nums[0][key]), nNote(nums[1][key])]);
  const share = (v: number | null) => (v === null ? "–" : `≈ ${pct(v)}`);
  row(tl("lab.clip.m.poss"), [share(poss.a), share(poss.b)]);
  const foot = table.createTFoot().insertRow().insertCell();
  foot.colSpan = 3; foot.className = "fine";
  foot.textContent = tl("lab.clip.possNote", { n: poss.n, open: poss.open, m: CLIP.possessionM });
  ([0, 1] as const).forEach((t) => {
    const pts = teamPoints(fr, t), id = t === 0 ? "a" : "b";
    const cv = $<HTMLCanvasElement>(`heat-${id}`);
    drawHeat(cv, heatBins(pts, HEAT.cols, HEAT.rows), run.teamRgb[t] ?? [200, 200, 200]);
    cv.setAttribute("aria-label", tl("lab.clip.heatAria", { t: t === 0 ? "A" : "B" }));
    $(`heat-${id}-cap`).textContent = tl("lab.clip.heatCap", { t: t === 0 ? "A" : "B", n: pts.length });
  });
  const items = [
    tl("lab.clip.d.frames", { n: d.frames, fps: run.fps, w: run.w, h: run.h }),
    tl("lab.clip.d.cal", { p: pct(d.goodCal) }),
    tln("lab.clip.d.cuts", d.cuts),
    tl("lab.clip.d.skipped", { np: d.noPitch, pc: d.poorCal }),
    tl("lab.clip.d.tracks", { n: d.tracks, s: d.avgTrackSec === null ? "–" : num(d.avgTrackSec, 1) }),
    tl("lab.clip.d.speed", { ms: Math.round(d.msPerFrame ?? 0), s: num(run.totalMs / 1000, 1) }),
  ];
  $("clip-diag").replaceChildren(...items.map((x) => { const li = document.createElement("li"); li.textContent = x; return li; }));
  $("clip-results").hidden = false;
}

const clipInput = $<HTMLInputElement>("clip-file");
clipInput.addEventListener("change", () => { const f = clipInput.files?.[0]; if (f) void loadClip(f); clipInput.value = ""; });
const clipDrop = $("clip-drop");
clipDrop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clipInput.click(); } });
clipDrop.addEventListener("dragover", (e) => { e.preventDefault(); clipDrop.classList.add("over"); });
clipDrop.addEventListener("dragleave", () => clipDrop.classList.remove("over"));
clipDrop.addEventListener("drop", (e) => {
  e.preventDefault(); clipDrop.classList.remove("over");
  const f = (e as DragEvent).dataTransfer?.files[0];
  if (f) void loadClip(f);
});
$("clip-cancel").addEventListener("click", () => { clip.abort?.abort(); clipStatus(tl("lab.clip.cancelling"), false, true); });
$("clip-play").addEventListener("click", () => { if (clip.playing) { pauseClip(); render(); } else playClip(); });
$("clip-scrub").addEventListener("input", () => { pauseClip(); void showClipFrame(Number($<HTMLInputElement>("clip-scrub").value)); });
$("clip-coach").addEventListener("click", () => {
  pauseClip();
  $<HTMLDetailsElement>("opts").open = true;
  render();
  top.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
});

// privacy and battery: no camera while the page is hidden or left
document.addEventListener("visibilitychange", () => {
  if (document.hidden && live.stream) {
    stopCamera(); setFrozen(true);
    camStatus(tl("lab.cam.hidden"));
  }
});
addEventListener("pagehide", () => stopCamera());
if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { __labClip: () => clip.run, __labLive: live, __labState: st, __labScan: () => getScan(), __labFit: () => fitReport(calibration()), __labBall: () => currentBall(calibration()), __labAutoCal: () => runAutoCal(), __labCalTick: () => calTick() }); // headless checks

buildCalib();
