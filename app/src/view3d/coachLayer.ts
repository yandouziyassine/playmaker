// The coach's analysis drawn in the 3D view (part of the lazy three.js chunk; the pure maths is in analysis.ts):
// - the options as arcs over the grass: the one looked at wide (its width grows with the completion chance) in its
//   colour with a shadow on the grass, the others thin and translucent;
// - why: the pass lane (the coach's 2 m corridor), the defenders who cut it ringed in pink, the point where a lost
//   pass would be lost (the coach's loss point) as a pink cross; two switches: "Space control" (the coach's pitch
//   control as a cyan glow where the attack gets first) and "Pressure" (where each defender can be within 1.5 s);
// - screen-space labels: "44 % · +0.051" at the target looked at, a small tag at the others, laid out so they never
//   overlap each other, a target or the view's buttons (analysis.ts layoutLabels);
// - a panel under the view: one tab per option, then the breakdown card (net xG, completion, value if it arrives, if
//   it is lost) with the coach's reasons as chips (green helps, pink hurts).
// Geometry is rebuilt only when the analysis or the option looked at changes; each frame only projects the labels.
import {
  BufferAttribute, BufferGeometry, DataTexture, DoubleSide, DynamicDrawUsage, InstancedMesh, LinearFilter, Matrix4, Mesh,
  MeshBasicMaterial, PlaneGeometry, Quaternion, RGBAFormat, RingGeometry, SRGBColorSpace, Vector3, type PerspectiveCamera,
  type Scene,
} from "three";
import { pct, t, xg } from "../i18n/index.ts";
import {
  REACH_S, arcPath, arcWidth, breakdown, controlTexture, layoutLabels, laneBlockers, leadUpVelocities, lossPoint,
  mentionsLane, optionEnd, reach, sides, type Analysis3D, type AnalysisOption, type Box, type LabelItem,
} from "./analysis.ts";
import { GOAL_H, HALF_LENGTH, HALF_WIDTH, ribbon, type Moment3D, type PickTarget, type Vec } from "./geom.ts";
import { DEFAULT_PC } from "../coach/pitchControl.ts";
import { LANE_WIDTH } from "../coach/features.ts";

const MAX_ARC_VERTS = 6000, MAX_RINGS = 24, PC_NX = 84, PC_NY = 54;
const PINK = "#ff7a96", SPACE_KEY = "playmaker.view3d.space", PRESSURE_KEY = "playmaker.view3d.pressure";
const flat = <T extends BufferGeometry>(g: T): T => { g.rotateX(-Math.PI / 2); return g; };
const readFlag = (key: string, dflt: boolean) => { try { const v = localStorage.getItem(key); return v === null ? dflt : v === "1"; } catch { return dflt; } };
const saveFlag = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode */ } };
const hex = (c: string): [number, number, number] => { const n = parseInt(c.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
/** Signed xG without the unit, for the card ("+0.051"). */
const sx = (x: number) => xg(x).replace(/\s*xG$/, "");

export interface CoachLayer {
  /** A new analysis (or null to clear) about moment `mo`; `near`: the eyes camera (narrower ribbons). */
  set(mo: Moment3D | null, a: Analysis3D | null, near: boolean): void;
  /** Each render: `fade` (the reveal's replay fades the analysis out), the camera for the labels. */
  update(camera: PerspectiveCamera, fade: number, canvasW: number, canvasH: number): void;
  /** Look at option i (index in the analysis' options). */
  focus(i: number): void;
  active(): boolean;
  /** The analysis' points (carrier and option ends) for the camera framing. */
  points(): Vec[];
  /** Tap targets of the analysis' options (tap one to look at it). */
  targets(): PickTarget[];
  /** Index (in the options) of option key k, or -1. */
  indexOf(k: number): number;
  /** The view's buttons moved or appeared: re-measure the label obstacles. */
  relayout(): void;
  dispose(): void;
}

export function createCoachLayer(scene: Scene, host: HTMLElement, canvas: HTMLCanvasElement, request: () => void): CoachLayer {
  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3(), v3 = new Vector3();

  // ---- the arcs: one dynamic mesh, RGBA vertex colours (the faint ones translucent) ----
  const arcPos = new BufferAttribute(new Float32Array(MAX_ARC_VERTS * 3), 3).setUsage(DynamicDrawUsage);
  const arcCol = new BufferAttribute(new Float32Array(MAX_ARC_VERTS * 4), 4).setUsage(DynamicDrawUsage);
  const arcGeo = new BufferGeometry();
  arcGeo.setAttribute("position", arcPos); arcGeo.setAttribute("color", arcCol); arcGeo.setDrawRange(0, 0);
  const arcMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide });
  const arcs = new Mesh(arcGeo, arcMat);
  arcs.frustumCulled = false; arcs.renderOrder = 4;

  // ---- the lane corridor, the blockers, the loss point ----
  const laneMat = new MeshBasicMaterial({ color: "#4cc9f0", transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
  const lane = new Mesh(flat(new PlaneGeometry(1, 1)), laneMat);
  lane.visible = false; lane.renderOrder = 2;
  const blockMat = new MeshBasicMaterial({ color: PINK, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide });
  const blockers = new InstancedMesh(flat(new RingGeometry(0.7, 0.98, 28)), blockMat, MAX_RINGS);
  blockers.count = 0; blockers.frustumCulled = false; blockers.renderOrder = 3;
  const crossGeo = new BufferGeometry();
  { // an X on the grass, 1.6 m across
    const tri = ribbon([[[-0.8, -0.8], [0.8, 0.8]], [[-0.8, 0.8], [0.8, -0.8]]], 0.26), pos = new Float32Array((tri.length / 2) * 3);
    for (let i = 0, j = 0; i < tri.length; i += 2, j += 3) pos.set([tri[i]!, 0, -tri[i + 1]!], j);
    crossGeo.setAttribute("position", new BufferAttribute(pos, 3));
  }
  const cross = new Mesh(crossGeo, blockMat);
  cross.visible = false; cross.renderOrder = 3;

  // ---- pressure: where each defender can be within 1.5 s (unit ring scaled to the radius) ----
  const reachMat = new MeshBasicMaterial({ color: "#eef6ef", transparent: true, opacity: 0.5, depthWrite: false, side: DoubleSide });
  const reachRings = new InstancedMesh(flat(new RingGeometry(0.94, 1, 48)), reachMat, MAX_RINGS);
  reachRings.count = 0; reachRings.frustumCulled = false; reachRings.renderOrder = 2;
  const reachFill = new InstancedMesh(flat(new RingGeometry(0, 0.94, 48)), new MeshBasicMaterial({ color: "#eef6ef", transparent: true, opacity: 0.07, depthWrite: false }), MAX_RINGS);
  reachFill.count = 0; reachFill.frustumCulled = false; reachFill.renderOrder = 1;

  // ---- space control: the coach's pitch control as a texture on a plane just over the grass ----
  const pcData = new Uint8Array(PC_NX * PC_NY * 4);
  const pcTex = new DataTexture(pcData, PC_NX, PC_NY, RGBAFormat);
  pcTex.magFilter = LinearFilter; pcTex.minFilter = LinearFilter; pcTex.colorSpace = SRGBColorSpace;
  const pcMat = new MeshBasicMaterial({ map: pcTex, transparent: true, depthWrite: false });
  const pcPlane = new Mesh(flat(new PlaneGeometry(2 * HALF_LENGTH, 2 * HALF_WIDTH)), pcMat);
  pcPlane.position.y = 0.002; pcPlane.visible = false; pcPlane.renderOrder = 1;
  scene.add(pcPlane, reachFill, reachRings, lane, blockers, cross, arcs);
  const baseOpacity = new Map<MeshBasicMaterial, number>([[arcMat, 1], [laneMat, 0.12], [blockMat, 0.95], [reachMat, 0.5], [reachFill.material as MeshBasicMaterial, 0.07], [pcMat, 1]]);

  // ---- DOM: switches over the view, labels, the panel under it ----
  let space = readFlag(SPACE_KEY, true), pressure = readFlag(PRESSURE_KEY, false);
  const switches = document.createElement("div");
  switches.className = "v3d-switches"; switches.hidden = true;
  const mkSwitch = (cls: string, label: string, title: string, get: () => boolean, set: (on: boolean) => void) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `v3d-switch ${cls}`; b.textContent = label; b.title = title;
    const paint = () => b.setAttribute("aria-pressed", String(get()));
    b.addEventListener("click", () => { set(!get()); paint(); rebuildWhy(); request(); });
    paint();
    switches.append(b);
    return b;
  };
  mkSwitch("v3d-pc", t("v3d.space"), t("v3d.spaceTitle"), () => space, (on) => { space = on; saveFlag(SPACE_KEY, on); });
  mkSwitch("v3d-pressure", t("v3d.pressure"), t("v3d.pressureTitle"), () => pressure, (on) => { pressure = on; saveFlag(PRESSURE_KEY, on); });
  host.append(switches);
  const labelLayer = document.createElement("div");
  labelLayer.className = "v3d-labels"; labelLayer.setAttribute("aria-hidden", "true");
  host.append(labelLayer);
  const panel = document.createElement("div");
  panel.className = "v3d-panel"; panel.hidden = true;
  const tabs = document.createElement("div");
  tabs.className = "v3d-tabs"; tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("an.tabs"));
  const card = document.createElement("section");
  card.className = "v3d-card"; card.setAttribute("role", "tabpanel"); card.id = "v3d-card";
  panel.append(tabs, card);
  host.after(panel); // under the view, in the page flow (the host keeps the canvas' size)

  // ---- state ----
  let mo: Moment3D | null = null, an: Analysis3D | null = null, key = "", focusI = 0, near = false;
  let ends: (Vec | null)[] = [], from: Vec | null = null, pcKey = "";
  const labels: { el: HTMLDivElement; k: number; at: Vec; h: number; w: number; hgt: number }[] = [];
  let lastAnchors: number[] = [], obstacles: Box[] = [], obstaclesDirty = true, opacityNow = -1;

  function optionKind(k: number) { return mo?.options.find((o) => o.k === k)?.kind ?? "pass"; }

  function rebuildArcs() {
    let v = 0;
    if (!an || !mo || !from) { arcGeo.setDrawRange(0, 0); return; }
    const put = (x: number, y: number, z: number, c: [number, number, number], a: number) => {
      if (v >= MAX_ARC_VERTS) return;
      arcPos.setXYZ(v, x, y, z); arcCol.setXYZW(v, c[0], c[1], c[2], a); v++;
    };
    const order = an.options.map((_, i) => i).filter((i) => i !== focusI).concat(focusI < an.options.length ? [focusI] : []);
    for (const i of order) {
      const o = an.options[i]!, end = ends[i];
      if (!end) continue;
      const kind = optionKind(o.k), focused = i === focusI;
      const dx = end[0] - from[0], dy = end[1] - from[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const trim = kind === "pass" ? Math.min(0.9, len / 4) : 0; // stop at the receiver's feet, not inside him
      const to: Vec = [end[0] - (dx / len) * trim, end[1] - (dy / len) * trim];
      const path = arcPath(from, to, kind, kind === "carry" ? 12 : 22);
      const w = arcWidth(o.p, focused, near), col = hex(focused ? o.color : o.faint ?? o.color), alpha = focused ? 0.95 : 0.42;
      const strip = (pts: typeof path, width: number, c: [number, number, number], a: number, dash: boolean, ground: boolean) => {
        for (let j = 0; j + 1 < pts.length; j++) {
          if (dash && j % 2 === 1) continue;
          const A = pts[j]!, B = pts[j + 1]!;
          const gx = B[0] - A[0], gz = B[2] - A[2], gl = Math.hypot(gx, gz) || 1;
          const nx = (-gz / gl) * width / 2, nz = (gx / gl) * width / 2;
          const ya = ground ? 0.012 : A[1], yb = ground ? 0.012 : B[1];
          put(A[0] + nx, ya, A[2] + nz, c, a); put(A[0] - nx, ya, A[2] - nz, c, a); put(B[0] + nx, yb, B[2] + nz, c, a);
          put(B[0] + nx, yb, B[2] + nz, c, a); put(A[0] - nx, ya, A[2] - nz, c, a); put(B[0] - nx, yb, B[2] - nz, c, a);
        }
      };
      if (focused && kind === "shot") strip(path, w * 0.9, [0, 0, 0], 0.28, false, true); // its shadow (a pass has its lane)
      strip(path, w, col, alpha, kind === "carry", false);
      // the head: a flat triangle at the end, pointing along the path
      const E = path[path.length - 1]!, D = path[path.length - 2]!;
      const gx = E[0] - D[0], gz = E[2] - D[2], gl = Math.hypot(gx, gz) || 1, ux = gx / gl, uz = gz / gl;
      const hl = Math.max(1.1, w * 2.4), hw = Math.max(0.55, w * 1.5);
      const bx = E[0] - ux * hl * 0.6, bz = E[2] - uz * hl * 0.6, tx = E[0] + ux * hl * 0.4, tz = E[2] + uz * hl * 0.4;
      put(tx, E[1], tz, col, alpha); put(bx - uz * hw, E[1], bz + ux * hw, col, alpha); put(bx + uz * hw, E[1], bz - ux * hw, col, alpha);
    }
    arcGeo.setDrawRange(0, v - (v % 3));
    arcPos.needsUpdate = arcCol.needsUpdate = true;
  }

  /** The lane, its blockers and the loss point for the option looked at; pressure rings and space control. */
  function rebuildWhy() {
    lane.visible = cross.visible = false; blockers.count = 0; reachRings.count = reachFill.count = 0; pcPlane.visible = false;
    if (!an || !mo || !from) return;
    const sd = sides(mo), o = an.options[focusI], end = ends[focusI];
    const kind = o ? optionKind(o.k) : "pass";
    if (o && end && kind === "pass") {
      const dx = end[0] - from[0], dy = end[1] - from[1], len = Math.hypot(dx, dy) || 1;
      const ids = laneBlockers(from, end, sd.def);
      // the corridor between 5 % and 95 % of the line (the coach's lane), 2 x LANE_WIDTH wide
      lane.position.set(from[0] + dx * 0.5, 0.006, -(from[1] + dy * 0.5));
      lane.rotation.set(0, Math.atan2(dy, dx), 0);
      lane.scale.set(len * 0.9, 1, 2 * LANE_WIDTH);
      laneMat.color.set(ids.length ? PINK : "#4cc9f0");
      baseOpacity.set(laneMat, ids.length ? 0.16 : 0.12);
      lane.visible = true;
      const fr = sd.def;
      ids.slice(0, MAX_RINGS).forEach((idx, n) => {
        const d = fr.find((x) => x.i === idx)!;
        blockers.setMatrixAt(n, m.compose(p.set(d.at[0], 0.02, -d.at[1]), q.identity(), s.set(1, 1, 1)));
      });
      blockers.count = Math.min(ids.length, MAX_RINGS); blockers.instanceMatrix.needsUpdate = true;
      const lp = o.p !== undefined && o.p > 0.985 ? null : lossPoint(from, end, sd.def.map((d) => d.at));
      if (lp) { cross.position.set(lp[0], 0.018, -lp[1]); cross.visible = true; }
    }
    const vel = an.vel ?? leadUpVelocities(mo), pc = an.pc ?? DEFAULT_PC;
    if (pressure) {
      const list = sd.def.slice(0, MAX_RINGS);
      list.forEach((d, n) => {
        const r = reach(d.at, vel[d.i] ?? null, REACH_S, pc);
        m.compose(p.set(r.at[0], 0.01, -r.at[1]), q.identity(), s.set(r.r, 1, r.r));
        reachRings.setMatrixAt(n, m); reachFill.setMatrixAt(n, m);
      });
      reachRings.count = reachFill.count = list.length;
      reachRings.instanceMatrix.needsUpdate = reachFill.instanceMatrix.needsUpdate = true;
    }
    if (space) {
      if (pcKey !== key) {
        const zero: Vec = [0, 0];
        controlTexture(pcData, PC_NX, PC_NY, sd.att.map((a) => a.at), sd.att.map((a) => vel[a.i] ?? zero), sd.def.map((d) => d.at), sd.def.map((d) => vel[d.i] ?? zero), pc);
        pcTex.needsUpdate = true;
        pcKey = key;
      }
      pcPlane.visible = true;
    }
    opacityNow = -1; // re-apply the fade
  }

  // ---- labels ----
  function buildLabels() {
    labelLayer.replaceChildren();
    labels.length = 0; lastAnchors = [];
    if (!an || !mo) return;
    an.options.forEach((o, i) => {
      const end = ends[i];
      if (!end) return;
      const el = document.createElement("div");
      const focused = i === focusI, b = breakdown(o);
      el.className = `v3d-label${focused ? " on" : ""}`;
      el.style.setProperty("--c", o.color);
      el.textContent = focused ? [b.p !== null ? pct(b.p) : null, b.net !== null ? sx(b.net) : null].filter(Boolean).join(" · ") || o.tag : o.tag;
      labelLayer.append(el);
      const kind = optionKind(o.k);
      labels.push({ el, k: o.k, at: end, h: kind === "pass" ? 2.3 : kind === "shot" ? GOAL_H + 0.4 : 0.3, w: 0, hgt: 0 });
    });
    // focused first: it gets the best spot
    labels.sort((a, b) => Number(b.el.classList.contains("on")) - Number(a.el.classList.contains("on")));
    for (const l of labels) { l.w = l.el.offsetWidth || 60; l.hgt = l.el.offsetHeight || 22; }
  }

  function measureObstacles() {
    obstaclesDirty = false;
    const r = canvas.getBoundingClientRect();
    obstacles = [];
    const stage = host.parentElement ?? host;
    for (const e of stage.querySelectorAll<HTMLElement>(".v3d-modes, .v3d-names, .v3d-toggle, .v3d-switches, .v3d-help")) {
      if (e.hidden || e.offsetParent === null) continue;
      const b = e.getBoundingClientRect();
      if (b.width && b.height) obstacles.push({ x: b.left - r.left - 4, y: b.top - r.top - 4, w: b.width + 8, h: b.height + 8 });
    }
  }

  function placeLabels(camera: PerspectiveCamera, w: number, h: number, fade: number) {
    if (!labels.length) return;
    labelLayer.style.opacity = String(fade);
    labelLayer.hidden = fade < 0.05;
    if (labelLayer.hidden) return;
    let changed = lastAnchors.length !== labels.length * 2;
    const anchors = lastAnchors.length === labels.length * 2 ? lastAnchors : (lastAnchors = new Array(labels.length * 2).fill(NaN));
    labels.forEach((l, i) => {
      v3.set(l.at[0], l.h, -l.at[1]).project(camera);
      const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h, behind = v3.z > 1;
      const ax = behind ? -1e4 : x, ay = behind ? -1e4 : y;
      if (Math.abs(ax - anchors[i * 2]!) > 0.5 || Math.abs(ay - anchors[i * 2 + 1]!) > 0.5) changed = true;
      anchors[i * 2] = ax; anchors[i * 2 + 1] = ay;
    });
    if (!changed && !obstaclesDirty) return;
    if (obstaclesDirty) measureObstacles();
    const items: LabelItem[] = labels.map((l, i) => ({ x: anchors[i * 2]!, y: anchors[i * 2 + 1]!, w: l.w, h: l.hgt }));
    const boxes = layoutLabels(items, { w, h }, obstacles);
    labels.forEach((l, i) => {
      const off = anchors[i * 2]! < -1e3;
      l.el.style.visibility = off ? "hidden" : "visible";
      l.el.style.transform = `translate(${Math.round(boxes[i]!.x)}px, ${Math.round(boxes[i]!.y)}px)`;
    });
  }

  // ---- the panel: tabs and the breakdown card ----
  function buildTabs() {
    tabs.replaceChildren();
    if (!an) return;
    an.options.forEach((o, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "v3d-tab"; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", card.id);
      b.style.setProperty("--c", o.color);
      const tg = document.createElement("span"); tg.className = "tg"; tg.textContent = o.tag;
      const tl = document.createElement("span"); tl.className = "tl"; tl.textContent = o.tab;
      b.append(tg, tl);
      b.addEventListener("click", () => setFocus(i, true));
      tabs.append(b);
    });
    paintTabs();
  }
  tabs.addEventListener("keydown", (e) => {
    if (!an) return;
    const n = an.options.length;
    let i: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") i = (focusI + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") i = (focusI - 1 + n) % n;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    if (i === null) return;
    e.preventDefault(); e.stopPropagation(); // free play seeks on the arrows at the page level
    setFocus(i, true);
    (tabs.children[i] as HTMLElement | undefined)?.focus();
  });
  function paintTabs() {
    [...tabs.children].forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === focusI));
      (b as HTMLElement).tabIndex = i === focusI ? 0 : -1;
    });
  }

  function buildCard() {
    card.replaceChildren();
    const o = an?.options[focusI];
    if (!o || !mo) return;
    const kind = optionKind(o.k), b = breakdown(o);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    const hd = el("div", "hd");
    const title = el("h3", "", o.title);
    hd.append(title);
    if (b.net !== null) hd.append(el("span", "net", sx(b.net)));
    card.append(hd);
    if (b.net !== null) card.append(el("p", "netl", t("an.net")));
    const nums = el("div", "nums");
    const cell = (cls: string, value: string, label: string) => { const d = el("div", cls); d.append(el("b", "", value), el("span", "", label)); nums.append(d); };
    if (b.p !== null) cell("", pct(b.p), t(kind === "pass" ? "an.arrives" : kind === "carry" ? "an.keeps" : "an.goal"));
    if (b.gain !== null) cell("gain", sx(b.gain), t(kind === "carry" ? "an.ifKept" : "an.ifArrives"));
    if (b.loss !== null) cell("loss", sx(b.loss), t("an.ifLost"));
    if (nums.childElementCount) card.append(nums);
    const chips = el("div", "chips");
    const chip = (text: string, sign: number) => chips.append(el("span", `v3d-chip ${sign > 0 ? "good" : sign < 0 ? "bad" : "info"}`, text));
    const end = ends[focusI];
    if (kind === "pass" && from && end && !mentionsLane(o.reasons)) {
      const n = laneBlockers(from, end, sides(mo).def).length;
      chip(n === 0 ? t("an.lane0") : n === 1 ? t("an.lane1") : t("an.laneN", { n }), n === 0 ? 1 : -1);
    }
    for (const r of o.reasons) {
      if (r.sign === 0 && /xG/.test(r.text)) continue; // the value phrase: its numbers are in the card already
      chip(r.text, r.sign);
    }
    if (chips.childElementCount) card.append(chips);
    if (an?.choose) {
      const go = el("button", "primary v3d-an-choose", an.choose.label);
      go.type = "button";
      const k = o.k, fn = an.choose.fn;
      go.addEventListener("click", () => fn(k));
      card.append(go);
    }
    card.setAttribute("aria-label", t("an.cardAria", { title: o.title }));
    card.style.setProperty("--c", o.color);
  }

  function setFocus(i: number, user = false) {
    if (!an || i < 0 || i >= an.options.length) return;
    if (i === focusI && !user) return;
    const changed = i !== focusI;
    focusI = i;
    if (!changed) return;
    rebuildArcs(); rebuildWhy(); buildLabels(); paintTabs(); buildCard();
    an.onFocus?.(i);
    request();
  }

  function set(next: Moment3D | null, a: Analysis3D | null, nearCam: boolean) {
    const nearChanged = nearCam !== near;
    near = nearCam;
    if (!a || !next || !a.options.length) {
      if (an) {
        an = null; mo = null; key = ""; arcGeo.setDrawRange(0, 0); rebuildWhy(); labelLayer.replaceChildren(); labels.length = 0;
        panel.hidden = true; switches.hidden = true; obstaclesDirty = true;
      }
      return;
    }
    const sameKey = a.key === key && !!an;
    an = a; mo = next;
    if (!sameKey) {
      key = a.key;
      focusI = Math.max(0, Math.min(a.options.length - 1, a.focus ?? 0));
      const sd = sides(next);
      from = sd.carrier;
      ends = a.options.map((o) => optionEnd(next, o.k));
      buildTabs(); buildCard();
      panel.hidden = false; switches.hidden = false; obstaclesDirty = true;
      rebuildArcs(); rebuildWhy(); buildLabels();
    } else if (nearChanged) rebuildArcs();
  }

  function update(camera: PerspectiveCamera, fade: number, w: number, h: number) {
    if (!an) return;
    if (Math.abs(fade - opacityNow) > 0.005) {
      opacityNow = fade;
      for (const [mat, base] of baseOpacity) mat.opacity = base * fade;
      const vis = fade > 0.01;
      arcs.visible = vis;
    }
    placeLabels(camera, w, h, fade);
  }

  return {
    set, update,
    focus: (i) => setFocus(i, true),
    active: () => !!an,
    points: () => (an && from ? [from, ...ends.filter((e): e is Vec => !!e)] : []),
    targets: () => (an ? an.options.flatMap((o, i): PickTarget[] => { const e = ends[i]; const kind = optionKind(o.k); return e ? [{ k: o.k, kind, at: e }] : []; }) : []),
    indexOf: (k) => an?.options.findIndex((o) => o.k === k) ?? -1,
    relayout: () => { obstaclesDirty = true; lastAnchors = []; },
    dispose() {
      for (const o of [pcPlane, reachFill, reachRings, lane, blockers, cross, arcs]) scene.remove(o);
      for (const g of [arcGeo, crossGeo, lane.geometry, blockers.geometry, reachRings.geometry, reachFill.geometry, pcPlane.geometry]) g.dispose();
      for (const mt of [arcMat, laneMat, blockMat, reachMat, reachFill.material as MeshBasicMaterial, pcMat]) mt.dispose();
      blockers.dispose(); reachRings.dispose(); reachFill.dispose();
      pcTex.dispose();
      switches.remove(); labelLayer.remove(); panel.remove();
    },
  };
}

export type { AnalysisOption };
