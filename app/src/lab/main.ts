// Lab page: picture -> people detection -> team colours -> 4-point pitch calibration -> top-down map -> lanes.
import { applyH, computeHomography, hasCollinearTriple, orientH, wOf, type Mat3, type Pt } from "./homography.ts";
import { DEFAULT_LANDMARKS, LANDMARKS, PITCH, landmark, pitchLines } from "./landmarks.ts";
import { feet, passingLanes, toPitch, type Person } from "./players.ts";
import { meanColour, splitTeams, torsoBox, type RGB, type TeamLabel } from "./teams.ts";
import { detectPeople, loadDetector } from "./detector.ts";
import { drawScene, SCENE_H, SCENE_W } from "./scene.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_SIDE = 1600;
const PT_COLOURS = ["#ffd166", "#4cc9f0", "#ff9f1c", "#c77dff"];
const LANE_COLOURS = { open: "#06d6a0", tight: "#ffd166", blocked: "#ef476f" } as const;

const src = document.createElement("canvas"); // the picture at working resolution
const img = $<HTMLCanvasElement>("img"), top = $<HTMLCanvasElement>("top");
const status = $("status"), calibMsg = $("calib-msg");

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
};

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
    sel.setAttribute("aria-label", `Landmark for point ${i + 1}`);
    for (const [group, filter] of [["Centre", "c"], ["Left goal", "L-"], ["Right goal", "R-"]] as const) {
      const og = document.createElement("optgroup");
      og.label = group;
      for (const l of LANDMARKS.filter((l) => (filter === "c" ? !/^[LR]-/.test(l.id) : l.id.startsWith(filter)))) {
        const o = document.createElement("option");
        o.value = l.id; o.textContent = l.label; o.selected = l.id === id;
        og.append(o);
      }
      sel.append(og);
    }
    sel.addEventListener("change", () => { st.ids[i] = sel.value; render(); });
    const state = document.createElement("span");
    state.className = "state";
    if (st.pts[i]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ghost"; b.textContent = st.active === i ? "tap picture" : "re-place";
      b.addEventListener("click", () => { st.active = i; buildCalib(); render(); });
      state.append(b);
    } else state.textContent = st.active === i ? "tap picture" : "not placed";
    li.append(num, sel, state);
    ol.append(li);
  });
}

// ---------- geometry ----------
type Calib = { p2i: Mat3; i2p: Mat3 } | { error: string };

function calibration(): Calib | null {
  if (st.pts.some((p) => !p)) return null;
  if (new Set(st.ids).size < 4) return { error: "Pick 4 different landmarks." };
  const pitchPts = st.ids.map((id) => landmark(id)!);
  const imgPts = st.pts as Pt[];
  if (hasCollinearTriple(pitchPts, 2e-3)) return { error: "3 of these landmarks are on one line: pick another one." };
  if (hasCollinearTriple(imgPts, 1e-3)) return { error: "3 points are almost on one line in the picture: move one." };
  const p2i = computeHomography(pitchPts, imgPts), i2pRaw = computeHomography(imgPts, pitchPts);
  if (!p2i || !i2pRaw) return { error: "These points do not define a pitch view: check the order." };
  const c = { x: imgPts.reduce((s, p) => s + p.x, 0) / 4, y: imgPts.reduce((s, p) => s + p.y, 0) / 4 };
  const pc = { x: pitchPts.reduce((s, p) => s + p.x, 0) / 4, y: pitchPts.reduce((s, p) => s + p.y, 0) / 4 };
  return { p2i: orientH(p2i, pc), i2p: orientH(i2pRaw, c) };
}

function mapped(cal: Calib | null): (Pt | null)[] {
  if (!cal || "error" in cal) return st.persons.map(() => null);
  return st.persons.map((p) => toPitch(cal.i2p, feet(p.box)));
}

// ---------- drawing ----------
const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;
function teamColour(l: TeamLabel): string {
  return l === "other" ? "#8d99ae" : rgb(st.teamRgb[l]!);
}
function teamName(l: TeamLabel): string {
  return l === "other" ? "other" : l === 0 ? "A" : "B";
}

function drawImage(cal: Calib | null) {
  const ctx = img.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
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
      const tag = `${i + 1}${teamName(l) === "other" ? "" : teamName(l)}`;
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
  st.pts.forEach((p, i) => {
    if (!p) return;
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

function drawTop(cal: Calib | null, pos: (Pt | null)[]) {
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
  // passing lanes
  const lanes = laneData(pos);
  if (lanes) for (const l of lanes.list) {
    const a = toTop(lanes.from), b = toTop(pos[l.idx]!);
    ctx.strokeStyle = LANE_COLOURS[l.rating]; ctx.lineWidth = s * 0.55; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1;
  }
  const r = Math.max(6, s * 1.5);
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
  if (!cal || "error" in cal) {
    ctx.fillStyle = "rgba(7,23,14,0.7)"; ctx.fillRect(0, 0, top.width, top.height);
    ctx.fillStyle = "#f1faee"; ctx.font = `600 ${s * 2.4}px system-ui, sans-serif`; ctx.textAlign = "center";
    ctx.fillText(cal ? "Fix the calibration to see the map" : "Place the 4 calibration points", top.width / 2, top.height / 2);
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

function laneData(pos: (Pt | null)[]) {
  const c = st.carrier;
  if (c === null || !pos[c]) return null;
  const team = st.labels[c];
  if (team === undefined || team === "other") return null;
  const mates = pos.map((p, i) => ({ p, i })).filter(({ p, i }) => p && i !== c && st.labels[i] === team);
  const opps = pos.filter((p, i): p is Pt => !!p && st.labels[i] !== team && st.labels[i] !== "other");
  const lanes = passingLanes(pos[c]!, mates.map((m) => m.p!), opps, st.dir);
  return { from: pos[c]!, list: lanes.map((l) => ({ ...l, idx: mates[l.to]!.i })) };
}

function renderSide(pos: (Pt | null)[]) {
  const counts = { 0: 0, 1: 0, other: 0 } as Record<string, number>;
  st.labels.forEach((l) => counts[String(l)]!++);
  $("st-count").textContent = st.ms === null ? "–" : String(st.persons.length);
  $("st-ms").textContent = st.ms === null ? "–" : String(Math.round(st.ms));
  $("st-teams").textContent = st.ms === null ? "–" : `${counts["0"]} / ${counts["1"]} / ${counts["other"]}`;
  $("st-mapped").textContent = st.ms === null ? "–" : String(pos.filter(Boolean).length);
  const legend = $("legend");
  legend.innerHTML = "";
  if (st.persons.length) {
    for (const l of [0, 1, "other"] as TeamLabel[]) {
      const s = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = teamColour(l);
      if (l === 1) i.className = "b";
      if (l === "other") i.className = "o";
      s.append(i, `${l === "other" ? "Other (referee, keeper?)" : `Team ${teamName(l)}`}: ${counts[String(l)]}`);
      legend.append(s);
    }
    if (st.separation < 15) {
      const w = document.createElement("span");
      w.textContent = "Kits look similar: check the teams (tap a box to fix).";
      w.style.color = "#ffd166";
      legend.append(w);
    }
  }
  const ul = $("lanes");
  ul.innerHTML = "";
  const lanes = laneData(pos);
  if (st.carrier !== null && !lanes) ul.innerHTML = "<li class='tight'>The carrier must be in team A or B and on the map.</li>";
  if (lanes) {
    for (const l of [...lanes.list].sort((a, b) => b.gap - a.gap)) {
      const li = document.createElement("li");
      li.className = l.rating;
      const fwd = l.forward >= 0 ? `${l.forward.toFixed(0)} m forward` : `${(-l.forward).toFixed(0)} m back`;
      const gap = Number.isFinite(l.gap) ? `nearest opponent ${l.gap.toFixed(1)} m from the line` : "no opponent on the map";
      li.textContent = `→ #${l.idx + 1}: ${l.rating} · ${l.length.toFixed(0)} m pass, ${fwd} · ${gap}`;
      ul.append(li);
    }
    if (!lanes.list.length) ul.innerHTML = "<li class='tight'>No teammate of the carrier on the map.</li>";
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
      : cal ? "Calibrated. If the blue lines do not sit on the painted lines, drag the points or check the landmarks."
      : `Tap point ${(st.active ?? 0) + 1} on the picture.`;
    calibMsg.classList.toggle("bad", !!cal && "error" in cal);
    const pos = mapped(cal);
    drawImage(cal);
    drawTop(cal, pos);
    renderSide(pos);
  });
}

// ---------- picture loading ----------
function setPicture(draw: (ctx: CanvasRenderingContext2D) => void, w: number, h: number) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  src.width = Math.round(w * k); src.height = Math.round(h * k);
  const ctx = src.getContext("2d", { willReadFrequently: true })!;
  ctx.save(); ctx.scale(k, k); draw(ctx); ctx.restore();
  img.width = src.width; img.height = src.height;
  top.width = 840; top.height = Math.round(840 * (PITCH.width + 2 * TOP_M) / (PITCH.length + 2 * TOP_M));
  Object.assign(st, { loaded: true, persons: [], colours: [], labels: [], ms: null, carrier: null, separation: 99 });
  $("work").hidden = false;
}

async function loadFile(file: File) {
  if (!file.type.startsWith("image/")) { status.textContent = "That file is not a picture."; return; }
  try {
    const bmp = await createImageBitmap(file);
    setPicture((ctx) => ctx.drawImage(bmp, 0, 0), bmp.width, bmp.height);
    bmp.close();
  } catch {
    status.textContent = "Could not read this picture."; return;
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
  status.textContent = "Synthetic scene drawn by code. The 4 points are placed slightly off: drag them to refine.";
  void runDetect();
}

async function runDetect() {
  if (st.busy || !st.loaded) return;
  st.busy = true;
  const btn = $<HTMLButtonElement>("detect");
  btn.disabled = true;
  try {
    status.textContent = "Loading the detector (first time only: 7 MB model + ~15 MB engine)…";
    const t0 = performance.now();
    await loadDetector();
    const loadMs = performance.now() - t0;
    status.textContent = "Detecting people…";
    await new Promise((r) => setTimeout(r, 30));
    const run = await detectPeople(src, $<HTMLInputElement>("tiled").checked);
    // number players from left to right
    const persons = run.persons.sort((a, b) => feet(a.box).x - feet(b.box).x);
    const data = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
    const colours = persons.map((p) => meanColour(data, torsoBox(p.box)));
    const valid = colours.map((c, i) => ({ c, i })).filter((x): x is { c: RGB; i: number } => !!x.c);
    const split = splitTeams(valid.map((v) => v.c));
    const labels: TeamLabel[] = persons.map(() => "other");
    valid.forEach((v, k) => { labels[v.i] = split.labels[k]!; });
    const teamRgb: RGB[] = [0, 1].map((t) => {
      const cs = valid.filter((_, k) => split.labels[k] === t).map((v) => v.c);
      return cs.length ? (cs.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => v / cs.length) as RGB) : st.teamRgb[t]!;
    });
    Object.assign(st, { persons, colours, labels, teamRgb, separation: split.separation, ms: run.ms, carrier: null });
    status.textContent = `${persons.length} people in ${Math.round(run.ms)} ms (${run.passes} pass${run.passes > 1 ? "es" : ""}` +
      `${loadMs > 50 ? `, detector loaded in ${(loadMs / 1000).toFixed(1)} s` : ""}).` +
      (persons.length === 0 ? " Nobody found: try the tiled scan, or a closer shot." : "");
  } catch (e) {
    console.error(e);
    status.textContent = "The detector could not start in this browser (WebAssembly / network). The calibration still works.";
  } finally {
    st.busy = false; btn.disabled = false;
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
    st.pts[st.active] = p;
    const next = st.pts.findIndex((q) => !q);
    st.active = next >= 0 ? next : null;
    buildCalib(); render(); return;
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
  st.pts[st.drag] = { x: Math.max(0, Math.min(img.width, p.x)), y: Math.max(0, Math.min(img.height, p.y)) };
  render();
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
  if (best >= 0) { st.carrier = best === st.carrier ? null : best; ($<HTMLDetailsElement>("opts")).open = true; render(); }
});

$("dir").addEventListener("click", () => {
  st.dir = st.dir === 1 ? -1 : 1;
  $("dir").textContent = st.dir === 1 ? "Attacking → right goal" : "Attacking ← left goal";
  render();
});
$("clear-carrier").addEventListener("click", () => { st.carrier = null; render(); });
$("reset-pts").addEventListener("click", () => { st.pts = [null, null, null, null]; st.active = 0; buildCalib(); render(); });
$("detect").addEventListener("click", () => void runDetect());
$("demo").addEventListener("click", loadDemo);
for (const id of ["show-lines", "show-boxes"]) $(id).addEventListener("change", render);

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
    if (f) void loadFile(f);
  });
}

buildCalib();
