// The 3D view: three.js scene + renderer, loaded with import() (see toggle.ts) so three.js is a separate chunk and
// never weighs on the 2D game. Adapted from the portfolio site's football3d scene.ts / view3d.ts / camera.ts (same
// author, MIT): low-poly footballers (one InstancedMesh per body part, see gait.ts) in their team's kit with a dark rim,
// billboard shirt numbers from a drawn 10 x 10 atlas, soft contact shadows, a textured pitch with mowing stripes, a cheap
// stadium surround (one textured cylinder), goals, ball, arrows as flat ribbons on the grass.
// Three cameras: the ball carrier's eyes (drag to look around), the stadium (TV side view following the ball, drag to
// orbit) and tactical (high and tilted, drag to orbit); double-tap re-centres. The mode is remembered (localStorage).
// Tracking frames arrive at 10-12.5 fps: the loop interpolates positions between the last two frames at the screen's
// rate, turns each figure towards its direction of motion and animates a procedural walk / run / sprint cycle from its
// smoothed speed, leaning into accelerations (with reduced motion: a still standing pose). Renders only while something
// moves (a frame transition, a drag, the camera settling).
// Free play passes the ball's real height (overlay.ballH): the ball flies, its shadow stays on the grass under it, a faint
// line joins them. During the daily reveal's replay (overlay.replay) the stadium camera follows the ball like a
// broadcast (damped, leading along its velocity), the eyes turn towards it, tactical holds still, the arrows fade out;
// with reduced motion the camera holds still and only the figures move. "Names" (off by default, remembered) puts
// "number surname" labels over the players, hidden beyond 45 m in the eyes and stadium views.
import {
  BackSide, BufferAttribute, BufferGeometry, CanvasTexture, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight,
  DoubleSide, DynamicDrawUsage, Fog, HemisphereLight, InstancedBufferAttribute, InstancedMesh, Line, Group,
  LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry, Quaternion,
  RepeatWrapping, RingGeometry, Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, Vector3,
  WebGLRenderer, type Material,
} from "three";
import { t } from "../i18n/index.ts";
import {
  CAMERA_MODES, COLORS, EYES_ARROW, EYES_FOV, FAR_ARROW, GOAL_H, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, LOOK_HOME, NO_FRAMING,
  ORBIT_HOME, arrowFade, arrowSpecs, atlasCell, badgeItems, ballScale, ballShadow, broadcastFollow, cameraPose, carrierAt, cmToM, damp, dragLook,
  dragOrbit, eyesArrow, eyesFollowYaw, followFocus, frameTips, goalOf, isCameraMode, isTap, labelVisible, lerpFrame, lerpPoint, motion,
  pickTargets, pitchMarkings, rayPick, ribbon, surname, toWorld, turnTowards, zoomFov, zoomOrbit,
  type CameraMode, type Follow, type Framing, type Look, type Moment3D, type Orbit, type Overlay3D, type PickTarget, type Vec,
} from "./geom.ts";
import { IDLE_MS, LIMBS, accelLean, advancePhase, figureMatrices, gaitParams, kitColors, poseAt, rootMatrix, skinTone } from "./gait.ts";

type Cm = [number, number] | null;
export interface View3D {
  readonly canvas: HTMLCanvasElement;
  /** Draw one frame; overlay.selected rings the target, overlay.ai/pro frame the reveal, overlay.scores shows badges. */
  show(mo: Moment3D, frame: Cm[], ball: Cm, overlay?: Overlay3D): void;
  /** Taps on a teammate (pass), a carry chevron or the goal mouth call fn(option k) until clearPickHandler(). */
  setPickHandler(fn: (k: number) => void, mo: Moment3D): void;
  clearPickHandler(): void;
  /** Point badges over each pass target, the goal and the best carry (null clears them). */
  showScores(scores: Record<number, number> | null): void;
  /** The option under a client point while picking is on (tests / debugging), or null. */
  pickAt(clientX: number, clientY: number): number | null;
  /** The camera mode, remembered across visits. */
  getMode(): CameraMode;
  setMode(mode: CameraMode): void;
  onModeChange(cb: ((mode: CameraMode) => void) | null): void;
  /** Back to the resting view (looking at the goal, or the mode's default camera). */
  reset(): void;
  /** Draw calls of the last render and the mean time of the last frames (ms), for the review scripts. */
  stats(): { calls: number; frameMs: number; frames: number };
  dispose(): void;
}

export const MODE_KEY = "playmaker.view3d.mode", NAMES_KEY = "playmaker.view3d.names";
const LABEL_FRAC = 0.034, TETHER_MIN = 0.6; // label height: 3.4 % of the canvas; the ball's line to its shadow above 0.6 m
const MAX_CARRIES = 16, Y_AXIS = new Vector3(0, 1, 0);
const MAX_FIGURES = 36, MAX_ARROW_VERTS = 8 * 60 * 3, MAX_TRAIL = 200, MAX_DPR = 1.5;
const NUMBER_Y = 2.3, FIGURE_H = 1.8, BALL_R = 0.11, BALL_VIS_R = 0.16;
/** The figures are drawn a little larger from the far cameras, where a 1.8 m player is a few pixels tall. */
const FIGURE_SCALE: Record<CameraMode, number> = { eyes: 1, stadium: 1.15, tactical: 1.3 };
const SPEED_TAU = 0.15, ACCEL_TAU = 0.3, RIM = 0.5; // s: smoothing of each figure's speed and acceleration; edge darkening

/** Adds a dark rim (view-angle shading) to a Lambert material: the figures' outline without a second draw. */
function withRim<T extends MeshLambertMaterial>(mat: T): T {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <tonemapping_fragment>",
      `gl_FragColor.rgb *= 1.0 - ${RIM.toFixed(2)} * pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.0);\n#include <tonemapping_fragment>`);
  };
  mat.customProgramCacheKey = () => "figure-rim";
  return mat;
}

/** White vertex colours (the instance colour shows as is), or `paint` per vertex position. */
function vertexColours<T extends BufferGeometry>(g: T, paint?: (x: number, y: number, z: number) => number): T {
  const pos = g.getAttribute("position"), c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { const k = paint ? paint(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1; c.set([k, k, k], i * 3); }
  g.setAttribute("color", new BufferAttribute(c, 3));
  return g;
}
const MAX_FRAME_MS = 200, JUMP_M = 12; // a transition never lasts longer; a player moving further between frames is a cut
const STAND_R = 120, STAND_H = 38;

const NUMBER_VS = /* glsl */ `
attribute vec2 aCell;
uniform float uSize;
varying vec2 vUv;
void main() {
  float k = length(instanceMatrix[0].xyz);
  vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  centre.xy += position.xy * uSize * k;
  gl_Position = projectionMatrix * centre;
  vUv = (aCell + uv) / 10.0;
}`;
const NUMBER_FS = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.35) discard;
  gl_FragColor = c;
}`;

/** White shirt numbers 0-99 with a dark outline, drawn here (no image from the web). */
function numberAtlas(): CanvasTexture {
  const c = document.createElement("canvas"), cell = 64;
  c.width = c.height = cell * 10;
  const g = c.getContext("2d")!;
  g.font = `700 ${Math.round(cell * 0.62)}px system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  g.lineWidth = cell * 0.14; g.strokeStyle = "#0b2a1a"; g.fillStyle = "#ffffff";
  for (let n = 0; n < 100; n++) {
    const x = ((n % 10) + 0.5) * cell, y = (Math.floor(n / 10) + 0.5) * cell;
    g.strokeText(String(n), x, y); g.fillText(String(n), x, y);
  }
  return new CanvasTexture(c);
}

/** A soft dark blob (radial gradient) for the contact shadows under players and the ball. */
function blobTexture(): CanvasTexture {
  const c = document.createElement("canvas"), n = 64;
  c.width = c.height = n;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.55)"); grad.addColorStop(0.55, "rgba(0,0,0,0.28)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, n, n);
  return new CanvasTexture(c);
}

/** The grass: mowing stripes along the pitch (as on the 2D pitch) with a little grain, one texture for one plane. */
function grassTexture(): CanvasTexture {
  const c = document.createElement("canvas"), w = 1024, h = 640;
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? "#1b6b3d" : "#1f7845"; g.fillRect((i * w) / 10, 0, w / 10 + 1, h); }
  const img = g.getImageData(0, 0, w, h), d = img.data;
  let seed = 7;
  for (let i = 0; i < d.length; i += 4) { // cheap grain: a few per cent of brightness, deterministic
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const k = ((seed >> 8) & 31) - 16;
    d[i] = Math.max(0, d[i]! + k); d[i + 1] = Math.max(0, d[i + 1]! + k); d[i + 2] = Math.max(0, d[i + 2]! + (k >> 1));
  }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** The stand: hoardings, a band of crowd (speckled seats), the roof line and the evening sky above; wraps round. */
function standTexture(): CanvasTexture {
  const c = document.createElement("canvas"), w = 1024, h = 256;
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
  sky.addColorStop(0, "#0a1f14"); sky.addColorStop(1, "#15402a");
  g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.55);
  g.fillStyle = "#101a14"; g.fillRect(0, h * 0.55, w, h * 0.03);         // the roof line
  const crowd = g.createLinearGradient(0, h * 0.58, 0, h * 0.9);
  crowd.addColorStop(0, "#2b3340"); crowd.addColorStop(1, "#171c24");
  g.fillStyle = crowd; g.fillRect(0, h * 0.58, w, h * 0.32);
  let seed = 0x9e3779b9;
  const rnd = () => { // mulberry32: deterministic, no stripes
    seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  const tones = ["#6b7280", "#9aa3ad", "#c5a880", "#8b5e5e", "#3f5f8a", "#d9d9d9"];
  for (let i = 0; i < 12000; i++) { // the crowd: dots in a few muted colours
    g.fillStyle = tones[Math.floor(rnd() * tones.length)]!;
    g.fillRect(Math.floor(rnd() * w), h * 0.58 + Math.floor(rnd() * h * 0.32), 2, 2);
  }
  g.fillStyle = "#0b2a1a"; g.fillRect(0, h * 0.9, w, h * 0.1);            // hoardings
  g.fillStyle = "#2b7f93"; for (let x = 0; x < w; x += 128) g.fillRect(x + 8, h * 0.93, 60, h * 0.035); // a few muted panels
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace; tex.wrapS = RepeatWrapping; tex.repeat.set(4, 1);
  return tex;
}

export function hasWebGL(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch { return false; }
}

const flat = <T extends BufferGeometry>(g: T): T => { g.rotateX(-Math.PI / 2); return g; };
const readMode = (): CameraMode => { try { const v = localStorage.getItem(MODE_KEY); return isCameraMode(v) ? v : "eyes"; } catch { return "eyes"; } };
const readNames = (): boolean => { try { return localStorage.getItem(NAMES_KEY) === "1"; } catch { return false; } };

/** A name label: "number surname" in white on a dark pill (drawn here); the canvas aspect for the sprite's scale. */
function labelTexture(text: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement("canvas"), g = c.getContext("2d")!, h = 48, font = "700 30px system-ui, sans-serif";
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w; c.height = h;
  g.font = font; g.fillStyle = "rgba(7, 23, 14, 0.78)"; g.beginPath(); g.roundRect(0, 4, w, h - 8, (h - 8) / 2); g.fill();
  g.fillStyle = "#ffffff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, w / 2, h / 2 + 1);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return { tex, aspect: w / h };
}

// the mode selector's icons: local SVG (20 px grid like design/icons.ts, but only the 3D chunk needs them)
const MODE_ICON: Record<CameraMode, string> = {
  eyes: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.5"/>',
  stadium: '<path d="M3 15.5h14M4.5 15.5V9l5.5-3.5L15.5 9v6.5"/><path d="M7.5 15.5V11h5v4.5"/>',
  tactical: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M10 4v12M3 10h14"/><circle cx="10" cy="10" r="2"/>',
};
const MODE_LABEL: Record<CameraMode, () => string> = { eyes: () => t("v3d.modeEyes"), stadium: () => t("v3d.modeStadium"), tactical: () => t("v3d.modeTactical") };

/** Creates the view inside `host` (its canvas and mode selector are prepended), or null when WebGL is not available. */
export function createView3D(host: HTMLElement): View3D | null {
  if (!hasWebGL()) return null;
  const canvas = document.createElement("canvas");
  canvas.className = "v3d-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", t("v3d.canvasAria"));
  host.prepend(canvas);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
  } catch {
    canvas.remove();
    return null;
  }
  renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- scene ----
  const scene = new Scene();
  scene.background = new Color("#0a1f14");
  scene.fog = new Fog("#0f2a1b", 90, 260);
  const sun = new DirectionalLight(0xfff4e0, 1.3);
  sun.position.set(-30, 60, 40);
  scene.add(new HemisphereLight(0xcfe6ff, 0x1d3b24, 1.7), sun);

  const grass = grassTexture();
  grass.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const pitch = new Mesh(flat(new PlaneGeometry(2 * HALF_LENGTH + 6, 2 * HALF_WIDTH + 6)), new MeshLambertMaterial({ map: grass }));
  pitch.position.y = -0.01;
  const apron = new Mesh(flat(new PlaneGeometry(2 * STAND_R + 10, 2 * STAND_R + 10)), new MeshLambertMaterial({ color: "#123323" }));
  apron.position.y = -0.03;
  const standTex = standTexture();
  const stand = new Mesh(new CylinderGeometry(STAND_R, STAND_R, STAND_H, 32, 1, true), new MeshBasicMaterial({ map: standTex, side: BackSide, fog: false }));
  stand.position.y = STAND_H / 2 - 0.05;
  scene.add(apron, pitch, stand);

  const flatLines = ribbon(pitchMarkings()), linePos = new Float32Array((flatLines.length / 2) * 3);
  for (let i = 0, j = 0; i < flatLines.length; i += 2, j += 3) linePos.set([flatLines[i]!, 0.005, -flatLines[i + 1]!], j);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
  scene.add(new Mesh(lineGeo, new MeshBasicMaterial({ color: "#e8efe9", side: DoubleSide })));

  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3(), colour = new Color();
  const goals = new InstancedMesh(new CylinderGeometry(0.06, 0.06, 1, 8), new MeshLambertMaterial({ color: "#ffffff" }), 6);
  const bar = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  let gi = 0;
  const netMat = new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false });
  for (const side of [-1, 1]) {
    const x = side * HALF_LENGTH;
    for (const y of [-GOAL_HALF_WIDTH, GOAL_HALF_WIDTH]) goals.setMatrixAt(gi++, m.compose(p.set(x, GOAL_H / 2, -y), q.identity(), s.set(1, GOAL_H, 1)));
    goals.setMatrixAt(gi++, m.compose(p.set(x, GOAL_H, 0), bar, s.set(1, 2 * GOAL_HALF_WIDTH, 1)));
    const net = new Mesh(new PlaneGeometry(2 * GOAL_HALF_WIDTH, GOAL_H), netMat);
    net.rotation.y = Math.PI / 2;
    net.position.set(x + side * 1.5, GOAL_H / 2, 0);
    scene.add(net);
  }
  scene.add(goals);

  const figureMesh = (geometry: BufferGeometry, material: Material) => {
    const mesh = new InstancedMesh(geometry, material, MAX_FIGURES);
    mesh.count = 0; mesh.frustumCulled = false;
    return mesh;
  };
  const blob = blobTexture();
  const shadowMat = new MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false });
  const shadows = figureMesh(flat(new PlaneGeometry(1.5, 1.5)), shadowMat);
  // the footballers: one InstancedMesh per body part (see gait.ts for the figure's frame and sizes), all sharing one
  // material: vertex colours times the instance colour (kit, skin), a dark rim instead of an outline hull
  const figureMat = withRim(new MeshLambertMaterial({ vertexColors: true }));
  const torsoGeo = vertexColours(new CylinderGeometry(0.5, 0.4, 1, 8, 1).translate(0, 0.5, 0));  // shoulders wider than the waist
  const shortsGeo = vertexColours(new CylinderGeometry(0.5, 0.56, 1, 8, 1).translate(0, -0.5, 0));
  // the head, hair on the top and the back (the figure faces +x): the hair colour is the skin tone times 0.22
  const headGeo = vertexColours(new SphereGeometry(1, 10, 8), (x, y) => (y > 0.25 || (x < -0.35 && y > -0.35) ? 0.22 : 1));
  // a limb: y in [-1.15, 0.15] at unit scale (rounded ends overlap at the joints), 1 unit across
  const limbGeo = vertexColours(new CapsuleGeometry(0.5, 1, 3, 6).scale(1, 0.65, 1).translate(0, -0.5, 0));
  const torsos = figureMesh(torsoGeo, figureMat), shortsMesh = figureMesh(shortsGeo, figureMat), heads = figureMesh(headGeo, figureMat);
  const limbs = new InstancedMesh(limbGeo, figureMat, MAX_FIGURES * LIMBS);
  limbs.count = 0; limbs.frustumCulled = false;
  for (const mesh of [torsos, shortsMesh, heads]) for (let i = 0; i < MAX_FIGURES; i++) mesh.setColorAt(i, colour.set(0xffffff));
  for (let i = 0; i < MAX_FIGURES * LIMBS; i++) limbs.setColorAt(i, colour.set(0xffffff));
  const figureParts = [torsos, shortsMesh, heads, limbs];
  const colourCache = new Map<string, Color>();
  const col = (hex: string) => { let c = colourCache.get(hex); if (!c) { c = new Color(hex); colourCache.set(hex, c); } return c; };
  const SHOE = "#15181d";
  const cells = new InstancedBufferAttribute(new Float32Array(MAX_FIGURES * 2), 2);
  const numberGeo = new PlaneGeometry(1, 1);
  numberGeo.setAttribute("aCell", cells);
  const atlas = numberAtlas();
  const numberSize = { value: 0.75 };
  const numbers = figureMesh(numberGeo, new ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uSize: numberSize }, vertexShader: NUMBER_VS, fragmentShader: NUMBER_FS,
  }));
  const ring = new Mesh(flat(new RingGeometry(0.55, 0.75, 24)), new MeshBasicMaterial({ color: "#ffffff" }));
  ring.visible = false;
  const carrierRing = new Mesh(flat(new RingGeometry(0.5, 0.66, 24)), new MeshBasicMaterial({ color: COLORS.ball }));
  carrierRing.visible = false;
  const ball = new Mesh(new SphereGeometry(BALL_VIS_R, 16, 12), new MeshLambertMaterial({ color: COLORS.ball }));
  ball.visible = false;
  const ballShadowMat = new MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false });
  const ballShadowMesh = new Mesh(flat(new PlaneGeometry(0.8, 0.8)), ballShadowMat);
  ballShadowMesh.visible = false;
  const tetherPos = new BufferAttribute(new Float32Array(6), 3).setUsage(DynamicDrawUsage);
  const tetherGeo = new BufferGeometry();
  tetherGeo.setAttribute("position", tetherPos);
  const tether = new Line(tetherGeo, new LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.35, depthWrite: false }));
  tether.visible = false; tether.frustumCulled = false;
  // name labels: one sprite per player (texture drawn once per name), placed in render()
  const labels = new Group(), labelOf = new Map<number, { sprite: Sprite; aspect: number; text: string }>();
  let names = readNames();

  const arrowPos = new BufferAttribute(new Float32Array(MAX_ARROW_VERTS * 3), 3).setUsage(DynamicDrawUsage);
  const arrowCol = new BufferAttribute(new Float32Array(MAX_ARROW_VERTS * 3), 3).setUsage(DynamicDrawUsage);
  const arrowGeo = new BufferGeometry();
  arrowGeo.setAttribute("position", arrowPos);
  arrowGeo.setAttribute("color", arrowCol);
  arrowGeo.setDrawRange(0, 0);
  const arrows = new Mesh(arrowGeo, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
  arrows.frustumCulled = false;

  const trailPos = new BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3).setUsage(DynamicDrawUsage);
  const trailGeo = new BufferGeometry();
  trailGeo.setAttribute("position", trailPos);
  trailGeo.setDrawRange(0, 0);
  const trail = new Line(trailGeo, new LineBasicMaterial({ color: COLORS.ball, transparent: true, opacity: 0.55 }));
  trail.frustumCulled = false;
  // carry markers: yellow chevrons on the grass at the carry options' points, only while picking is on
  const chevron = new BufferGeometry();
  { // a V pointing along +x in pitch metres, lifted to the grass (pitch (x, y) -> world (x, 0, -y))
    const tri = ribbon([[[-0.7, 0.8], [0, 0], [-0.7, -0.8]]], 0.28), pos = new Float32Array((tri.length / 2) * 3);
    for (let i = 0, j = 0; i < tri.length; i += 2, j += 3) pos.set([tri[i]!, 0, -tri[i + 1]!], j);
    chevron.setAttribute("position", new BufferAttribute(pos, 3));
  }
  const chevrons = new InstancedMesh(chevron, new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }), MAX_CARRIES);
  for (let i = 0; i < MAX_CARRIES; i++) chevrons.setColorAt(i, colour.set(COLORS.ball));
  chevrons.count = 0; chevrons.frustumCulled = false;
  const badges = new Group();
  scene.add(shadows, ...figureParts, numbers, ring, carrierRing, ball, ballShadowMesh, tether, arrows, trail, chevrons, badges, labels);
  const arrowMat = arrows.material as MeshBasicMaterial;

  // ---- camera, steering and the motion state ----
  const camera = new PerspectiveCamera(EYES_FOV, 1, 0.1, 500);
  let mode: CameraMode = readMode(), modeCb: ((m: CameraMode) => void) | null = null;
  let look: Look = LOOK_HOME, fov = EYES_FOV, orbit: Orbit = ORBIT_HOME, framing: Framing = NO_FRAMING;
  let eye: Vec = [0, 0], focus: Vec = [0, 0], goal: Vec = goalOf(1), raf = 0, disposed = false;
  const aim = new Vector3(), ndc = new Vector3();
  let picker: { fn: (k: number) => void; targets: PickTarget[] } | null = null;
  let lastMo: Moment3D | null = null, lastFrame: Cm[] = [], lastBall: Cm = null, lastOverlay: Overlay3D = {};
  // the transition: from `prev` (what was on screen) to `cur` (the last frame shown) over `dur` ms from `t0`
  let prev: Cm[] = [], cur: Cm[] = [], prevBall: Cm = null, curBall: Cm = null, t0 = 0, dur = 0, u = 1;
  // per player: last drawn position, facing (radians, pitch frame), smoothed speed (m/s) and acceleration (m/s^2),
  // stride phase (radians)
  const drawn: Cm[] = [], heading: number[] = [], speeds: number[] = [], accels: number[] = [], phases: number[] = [];
  let lastTick = 0, moving = false, settled = true;
  // the reveal's replay: the broadcast follow, the eyes' turn and pull-back, the framing it started from
  let follow: Follow = { focus: [0, 0], vel: [0, 0] }, followYaw = 0, followBack = 0, inReplay = false, replayFraming: Framing = NO_FRAMING;
  let replayEye: Vec = [0, 0];
  const times: number[] = []; // the last frame times, for stats()

  const aspect = () => Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
  const screen = () => ({ fov: camera.fov, heightPx: Math.max(1, canvas.clientHeight) });

  /** Place every figure, the ball and the camera for the positions on screen now, then draw. */
  function render(now = performance.now()) {
    raf = 0;
    if (disposed) return;
    const t1 = performance.now();
    const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
    lastTick = now;
    u = dur > 0 ? Math.min(1, (now - t0) / dur) : 1;
    const frame = u >= 1 ? cur : lerpFrame(prev, cur, u), b = u >= 1 ? curBall : lerpPoint(prevBall, curBall, u);
    const mo = lastMo, o = lastOverlay;
    if (!mo) return;
    const bm: Vec | null = b ? cmToM(b) : null;

    // the eyes stand at the carrier (the ball when he is not tracked; during the replay, where he was last seen)
    const replayNow = o.replay !== undefined;
    const ec = carrierAt(mo, frame);
    if (replayNow && !inReplay) { follow = { focus, vel: [0, 0] }; replayFraming = framing; followYaw = framing.yaw; followBack = framing.back; replayEye = ec ?? eye; }
    inReplay = replayNow;
    if (ec) eye = ec;
    else if (b && !inReplay) eye = bm!;
    if (inReplay && reduced) eye = replayEye; // no camera motion: the eyes stay where the replay started

    // the camera: the eyes at the carrier; the others following the ball with a lag (the replay: see the header)
    const want: Vec = bm ?? eye;
    let next: Vec;
    if (inReplay) {
      const vel: Vec = dur > 0 && prevBall && curBall ? [(curBall[0] - prevBall[0]) / dur * 10, (curBall[1] - prevBall[1]) / dur * 10] : [0, 0]; // cm/ms -> m/s
      const yaw0 = followYaw;
      if (mode === "stadium" && bm) follow = broadcastFollow(follow, bm, vel, dt, reduced);
      if (mode === "eyes" && bm) followYaw = eyesFollowYaw(followYaw, eye, bm, dt, reduced, goal);
      if (!reduced) followBack = damp(followBack, 0, dt, 0.4);
      framing = mode === "eyes" ? { yaw: followYaw, back: followBack, fov: replayFraming.fov } : framing;
      next = mode === "stadium" ? follow.focus : focus; // tactical (and reduced motion) hold still
      settled = Math.hypot(next[0] - focus[0], next[1] - focus[1]) < 0.01 && Math.abs(followYaw - yaw0) < 1e-4 && followBack < 0.01;
    } else {
      next = dt > 0 ? followFocus(focus, want, dt) : want;
      settled = Math.hypot(next[0] - focus[0], next[1] - focus[1]) < 0.01 && Math.hypot(want[0] - next[0], want[1] - next[1]) < 0.05;
    }
    focus = next;
    const pose = cameraPose(mode, eye, focus, look, fov, framing, orbit, goal);
    camera.position.set(...pose.position);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(aim.set(...pose.target));

    // figures: kit by side, facing their motion, running at their speed; the carrier hidden from his own eyes
    const showCarrier = mode !== "eyes" || framing.back > 0;
    const labelH = LABEL_FRAC * 2 * Math.tan((camera.fov * Math.PI) / 360); // constant height on screen
    for (const l of labelOf.values()) l.sprite.visible = false;
    let n = 0;
    moving = false;
    const fs = FIGURE_SCALE[mode], numberY = NUMBER_Y + FIGURE_H * (fs - 1); // the number stays over the (scaled) head
    frame.forEach((cm, i) => {
      if (!cm || n >= MAX_FIGURES) return;
      const pl = mo.players[i];
      if (!pl) return;
      const [x, y] = cmToM(cm), z = -y;
      const mv = motion(drawn[i] ?? null, [x, y], dt);
      // speed smoothed over ~0.15 s (interpolated tracking is jerky frame to frame), its change for the lean
      const sp0 = speeds[i] ?? mv.speed, sp = dt > 0 ? damp(sp0, mv.speed, dt, SPEED_TAU) : sp0;
      accels[i] = dt > 0 ? damp(accels[i] ?? 0, (sp - sp0) / dt, dt, ACCEL_TAU) : accels[i] ?? 0;
      speeds[i] = sp;
      heading[i] = mv.heading === null ? heading[i] ?? Math.atan2(goal[1] - y, goal[0] - x) : turnTowards(heading[i] ?? mv.heading, mv.heading, dt);
      phases[i] = advancePhase(phases[i] ?? (i * 2.39996) % (2 * Math.PI), mv.speed * dt, sp, reduced); // staggered starts
      drawn[i] = [x, y];
      if (mv.speed >= IDLE_MS || sp >= 0.05) moving = true; // keep drawing until the stride has eased back to standing
      const k = i === mo.carrier && !showCarrier ? 0 : 1; // the camera is inside the carrier
      q.setFromAxisAngle(Y_AXIS, heading[i]!);
      // the figure: the gait from the speed, the pose at this point of the stride, every part's matrix
      const g = gaitParams(sp, reduced);
      const pose = poseAt(phases[i]!, g, reduced ? 0 : accelLean(accels[i]!));
      const fm = figureMatrices(rootMatrix(x, z, heading[i]!, k * fs), pose);
      const bob = pose.bob * fs;
      torsos.instanceMatrix.array.set(fm.torso, n * 16);
      shortsMesh.instanceMatrix.array.set(fm.shorts, n * 16);
      heads.instanceMatrix.array.set(fm.head, n * 16);
      fm.limbs.forEach((lm, j) => limbs.instanceMatrix.array.set(lm, (n * LIMBS + j) * 16));
      const side = pl.side === 0 ? mo.colors?.[0] ?? COLORS.attack : mo.colors?.[1] ?? COLORS.defend;
      const kit = kitColors(side, !!(pl as { keeper?: boolean }).keeper, pl.side), skin = col(skinTone(i));
      const shirt = col(kit.shirt);
      torsos.setColorAt(n, shirt);
      shortsMesh.setColorAt(n, col(kit.shorts));
      heads.setColorAt(n, skin);
      // LIMB_ORDER: thighs (skin), shins (socks), shoes, upper arms (sleeves), forearms (skin)
      const limbCols = [skin, skin, col(kit.socks), col(kit.socks), col(SHOE), col(SHOE), shirt, shirt, skin, skin];
      limbCols.forEach((c, j) => limbs.setColorAt(n * LIMBS + j, c));
      let kn = i === mo.carrier && mode === "eyes" ? 0 : 1; // seen from just behind him, his own number would fill the screen
      if (names && kn && labelVisible(mode, Math.hypot(x - camera.position.x, numberY - camera.position.y, z - camera.position.z))) {
        const text = `${pl.shirt} ${surname(pl.name)}`;
        let l = labelOf.get(i);
        if (!l || l.text !== text) {
          if (l) { l.sprite.material.map?.dispose(); l.sprite.material.dispose(); labels.remove(l.sprite); }
          const { tex, aspect } = labelTexture(text);
          const sprite = new Sprite(new SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true, depthWrite: false }));
          sprite.renderOrder = 5;
          l = { sprite, aspect, text };
          labelOf.set(i, l);
          labels.add(sprite);
        }
        l.sprite.visible = true;
        l.sprite.position.set(x, numberY + 0.15 + bob, z);
        l.sprite.scale.set(labelH * l.aspect, labelH, 1);
        kn = 0; // the label carries the number
      }
      numbers.setMatrixAt(n, m.compose(p.set(x, numberY + bob, z), q, s.set(kn, kn, kn)));
      const [cx, cy] = atlasCell(pl.shirt);
      cells.setXY(n, cx, cy);
      shadows.setMatrixAt(n, m.compose(p.set(x, 0.012, z), q, s.set(0.85 * k * fs, k * fs, k * fs)));
      n++;
    });
    for (const mesh of [torsos, shortsMesh, heads, numbers, shadows]) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; }
    limbs.count = n * LIMBS; limbs.instanceMatrix.needsUpdate = true;
    for (const mesh of figureParts) mesh.instanceColor!.needsUpdate = true;
    cells.needsUpdate = true;
    q.identity();

    const carrier = frame[mo.carrier];
    carrierRing.visible = !!carrier && showCarrier;
    if (carrier) { const [cx, cy] = cmToM(carrier); carrierRing.position.set(cx, 0.02, -cy); }

    // the ball at its height (free play), its shadow on the grass right under it, a faint line between them when high
    const bh = o.ballH ?? BALL_R;
    ball.visible = ballShadowMesh.visible = !!bm;
    tether.visible = !!bm && bh > TETHER_MIN;
    if (bm) {
      const [bx, by] = bm, sh = ballShadow(bh), y = Math.max(BALL_VIS_R, bh + BALL_VIS_R - BALL_R);
      const k = ballScale(Math.hypot(bx - camera.position.x, y - camera.position.y, -by - camera.position.z), camera.fov, canvas.clientHeight, BALL_VIS_R);
      ball.position.set(bx, Math.max(y, BALL_VIS_R * k), -by);
      ball.scale.setScalar(k);
      ballShadowMesh.position.set(bx, 0.015, -by);
      ballShadowMesh.scale.setScalar(sh.scale * k);
      ballShadowMat.opacity = sh.opacity;
      if (tether.visible) { tetherPos.setXYZ(0, bx, 0.02, -by); tetherPos.setXYZ(1, bx, ball.position.y - BALL_VIS_R, -by); tetherPos.needsUpdate = true; }
    }
    numberSize.value = mode === "eyes" ? 0.75 : 1.15;
    renderer.render(scene, camera);
    times.push(performance.now() - t1);
    if (times.length > 120) times.shift();
    if (u < 1 || (moving && !reduced) || !settled) request();
  }
  const request = () => { if (!raf && !disposed) raf = requestAnimationFrame(render); };

  /** The option under a client point, from the camera ray (render() keeps the camera current). */
  function pickAt(clientX: number, clientY: number): number | null {
    if (!picker) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    render(); // make sure the camera matches what is on screen
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1), 0.5).unproject(camera).sub(camera.position).normalize();
    return rayPick([camera.position.x, camera.position.y, camera.position.z], [ndc.x, ndc.y, ndc.z], picker.targets, screen());
  }

  const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let multi = false, lastEmptyTap = -1e9;
  function home() { look = LOOK_HOME; fov = EYES_FOV; orbit = ORBIT_HOME; }
  function down(e: PointerEvent) {
    canvas.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
    if (pts.size > 1) multi = true;
  }
  function zoom(wheel: number) { if (mode === "eyes") fov = zoomFov(fov, wheel); else orbit = zoomOrbit(orbit, wheel); }
  function move(e: PointerEvent) {
    const prevPt = pts.get(e.pointerId);
    if (!prevPt) return;
    if (pts.size >= 2) { // pinch: the distance between the first two pointers zooms
      const [a, c] = [...pts.values()];
      const d0 = Math.hypot(a!.x - c!.x, a!.y - c!.y);
      prevPt.x = e.clientX; prevPt.y = e.clientY;
      const [d, f] = [...pts.values()];
      const d1 = Math.hypot(d!.x - f!.x, d!.y - f!.y);
      if (d0 > 0 && d1 > 0) zoom(-Math.log(d1 / d0) / 0.001);
    } else {
      const dx = e.clientX - prevPt.x, dy = e.clientY - prevPt.y;
      if (mode === "eyes") look = dragLook(look, dx, dy, fov, canvas.clientHeight);
      else orbit = dragOrbit(orbit, dx, dy, canvas.clientHeight);
      prevPt.x = e.clientX; prevPt.y = e.clientY;
    }
    request();
  }
  function up(e: PointerEvent) {
    const p0 = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (p0 && e.type === "pointerup" && !multi && isTap(e.clientX - p0.x0, e.clientY - p0.y0, e.timeStamp - p0.t0)) {
      const k = pickAt(e.clientX, e.clientY);
      if (k !== null && picker) picker.fn(k);
      else if (e.timeStamp - lastEmptyTap < 350) { home(); lastEmptyTap = -1e9; request(); } // double tap on nothing: re-centre
      else lastEmptyTap = e.timeStamp;
    }
    if (pts.size === 0) multi = false;
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    zoom(Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 16 : 1))));
    request();
  }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });

  const ro = new ResizeObserver(() => {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (lastMo) show(lastMo, lastFrame, lastBall, lastOverlay); // the framing depends on the aspect
    request();
  });
  ro.observe(canvas);
  const lost = (e: Event) => e.preventDefault();
  canvas.addEventListener("webglcontextlost", lost);

  // ---- the mode selector: three icon buttons over the top-left corner ----
  const modes = document.createElement("div");
  modes.className = "v3d-modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", t("v3d.modes"));
  const modeButtons = new Map<CameraMode, HTMLButtonElement>();
  for (const md of CAMERA_MODES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "v3d-mode"; b.dataset.mode = md;
    b.innerHTML = `<svg class="icon" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${MODE_ICON[md]}</svg>`;
    b.title = MODE_LABEL[md]();
    b.setAttribute("aria-label", MODE_LABEL[md]());
    b.addEventListener("click", () => setMode(md));
    modes.append(b);
    modeButtons.set(md, b);
  }
  host.prepend(modes);
  function paintModes() { for (const [md, b] of modeButtons) b.setAttribute("aria-pressed", String(md === mode)); }
  function setMode(next: CameraMode) {
    if (!isCameraMode(next)) return;
    const changed = next !== mode;
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
    paintModes();
    home();
    if (lastMo) show(lastMo, lastFrame, lastBall, lastOverlay); else request();
    if (changed) modeCb?.(mode);
  }
  paintModes();

  // ---- the "Names" switch, under the mode selector: off by default, remembered ----
  const namesBtn = document.createElement("button");
  namesBtn.type = "button"; namesBtn.className = "v3d-names";
  namesBtn.textContent = t("v3d.names");
  namesBtn.title = t("v3d.namesTitle");
  const paintNames = () => namesBtn.setAttribute("aria-pressed", String(names));
  namesBtn.addEventListener("click", () => {
    names = !names;
    try { localStorage.setItem(NAMES_KEY, names ? "1" : "0"); } catch { /* private mode */ }
    paintNames();
    request();
  });
  paintNames();
  host.prepend(namesBtn);
  function clearLabels() {
    for (const l of labelOf.values()) { l.sprite.material.map?.dispose(); l.sprite.material.dispose(); labels.remove(l.sprite); }
    labelOf.clear();
  }

  // ---- score badges: sprites with a drawn label, constant size on screen ----
  function clearBadges() {
    for (const sp of [...badges.children] as Sprite[]) { sp.material.map?.dispose(); sp.material.dispose(); badges.remove(sp); }
  }
  function showScores(scores: Record<number, number> | null) {
    clearBadges();
    if (!scores || !lastMo) { request(); return; }
    for (const b of badgeItems(lastMo, scores)) {
      const c = document.createElement("canvas"), g = c.getContext("2d")!;
      c.width = 128; c.height = 64;
      g.fillStyle = b.color; g.beginPath(); g.roundRect(4, 6, 120, 52, 26); g.fill();
      g.fillStyle = "#07170e"; g.font = "800 38px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(b.pts), 64, 34);
      const sp = new Sprite(new SpriteMaterial({ map: new CanvasTexture(c), sizeAttenuation: false, depthTest: false, transparent: true }));
      sp.scale.set(0.11, 0.055, 1);
      sp.position.set(...toWorld(b.at, b.h));
      sp.renderOrder = 10;
      badges.add(sp);
    }
    request();
  }

  let lastMoment: string | null = null, scoresKey = "";

  /** A new frame: the transition starts from what is on screen now; a jump (new moment, a seek) cuts. */
  function setFrame(mo: Moment3D, frame: Cm[], b: Cm) {
    const same = frame === cur && b === curBall;
    if (same) return;
    const jumped = mo.id !== lastMoment || cur.some((c, i) => { const f = frame[i]; return !!c && !!f && Math.hypot(f[0] - c[0], f[1] - c[1]) > JUMP_M * 100; });
    if (jumped || mo.live || !cur.length) { prev = frame; prevBall = b; dur = 0; }
    else { prev = u >= 1 ? cur : lerpFrame(prev, cur, u); prevBall = u >= 1 ? curBall : lerpPoint(prevBall, curBall, u); dur = Math.min(MAX_FRAME_MS, 1000 / (mo.fps || 10)); }
    cur = frame; curBall = b; t0 = performance.now(); u = dur > 0 ? 0 : 1;
    if (jumped) { drawn.length = 0; heading.length = 0; speeds.length = 0; accels.length = 0; phases.length = 0; lastTick = 0; const c = carrierAt(mo, frame); focus = b ? cmToM(b) : c ?? focus; }
  }

  function show(mo: Moment3D, frame: Cm[], b: Cm, o: Overlay3D = {}) {
    if (mo.id !== lastMoment) home();
    setFrame(mo, frame, b);
    lastMoment = mo.id;
    lastMo = mo; lastFrame = frame; lastBall = b; lastOverlay = o;
    goal = goalOf(mo.attack);
    const release = mo.lead_up[mo.lead_up.length - 1] ?? frame;
    const specs = arrowSpecs(mo, o);
    // the reveal (AI / pro / your arrows): turn and, if needed, widen and step back so they are all in view
    const at = carrierAt(mo, frame) ?? eye;
    framing = mode === "eyes" && (o.ai !== undefined || o.pro !== undefined) ? frameTips(at, specs.map((a) => a.to), aspect(), EYES_FOV, goal) : NO_FRAMING;

    // the selected target: a ring under the teammate, on the carry point, or in the goal mouth
    const sel = o.selected === undefined ? undefined : pickTargets(mo).find((tg) => tg.k === o.selected);
    ring.visible = !!sel;
    if (sel) {
      const pos: Vec = sel.kind === "shot" ? [sel.at[0] - Math.sign(sel.at[0]) * 1.2, 0] : sel.at;
      ring.position.set(pos[0], 0.025, -pos[1]);
      ring.scale.setScalar(sel.kind === "shot" ? 2.6 : sel.kind === "carry" ? 1.4 : 1.15);
    }

    // carry chevrons while picking, pointing away from the carrier; the selected one white
    const carries = picker ? picker.targets.filter((tg) => tg.kind === "carry").slice(0, MAX_CARRIES) : [];
    const from = carrierAt(mo, release) ?? at;
    carries.forEach((tg, i) => {
      const a = Math.atan2(tg.at[1] - from[1], tg.at[0] - from[0]);
      chevrons.setMatrixAt(i, m.compose(p.set(tg.at[0], 0.02, -tg.at[1]), q.setFromAxisAngle(Y_AXIS, a), s.set(1, 1, 1)));
      chevrons.setColorAt(i, colour.set(tg.k === o.selected ? "#ffffff" : COLORS.ball));
    });
    q.identity();
    chevrons.count = carries.length;
    chevrons.instanceMatrix.needsUpdate = true;
    if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;

    let v = 0;
    const style = mode === "eyes" ? EYES_ARROW : FAR_ARROW;
    specs.forEach((a, ai) => {
      const tri = eyesArrow(a.from, a.to, a.dashed, style), y = 0.03 + ai * 0.004; // later arrows a hair higher: on top
      colour.set(a.color);
      for (let i = 0; i + 1 < tri.length && v < MAX_ARROW_VERTS; i += 2, v++) {
        arrowPos.setXYZ(v, tri[i]!, y, -tri[i + 1]!);
        arrowCol.setXYZ(v, colour.r, colour.g, colour.b);
      }
    });
    arrowGeo.setDrawRange(0, v - (v % 3));
    arrowPos.needsUpdate = arrowCol.needsUpdate = true;
    const fade = arrowFade(o.replay); // the reveal's replay: the arrows stay at first, then fade out as it runs
    arrowMat.opacity = 0.95 * fade;
    arrows.visible = fade > 0.01;

    const tr = (o.balls ?? []).filter((x): x is [number, number] => !!x).slice(-MAX_TRAIL).map(cmToM);
    tr.forEach((tp, i) => trailPos.setXYZ(i, tp[0], 0.05, -tp[1]));
    trailGeo.setDrawRange(0, tr.length);
    trailPos.needsUpdate = true;

    // the 2D overlay's scores (round.ts's "Show every option's score") become badges; any other paint clears them
    const key = o.scores ? `${mo.id}:${JSON.stringify(o.scores)}` : "";
    if (key !== scoresKey) { scoresKey = key; showScores(o.scores ?? null); }
    request();
  }

  return {
    canvas,
    show,
    setPickHandler(fn, mo) {
      picker = { fn, targets: pickTargets(mo) };
      canvas.classList.add("v3d-picking");
      if (lastMo) show(lastMo, lastFrame, lastBall, lastOverlay); // draw the carry markers
    },
    clearPickHandler() {
      picker = null;
      canvas.classList.remove("v3d-picking");
      if (lastMo) show(lastMo, lastFrame, lastBall, lastOverlay);
    },
    showScores(scores) { scoresKey = ""; showScores(scores); },
    pickAt,
    getMode: () => mode,
    setMode,
    onModeChange(cb) { modeCb = cb; },
    reset() { home(); request(); },
    stats() {
      const frames = times.length, frameMs = frames ? times.reduce((a, b) => a + b, 0) / frames : 0;
      return { calls: renderer.info.render.calls, frameMs, frames };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      for (const [ty, h] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]] as const) canvas.removeEventListener(ty, h as EventListener);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", lost);
      ro.disconnect();
      clearBadges();
      clearLabels();
      const mats = new Set<Material>();
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        mesh.geometry?.dispose();
        if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((x) => mats.add(x));
        if ((obj as InstancedMesh).isInstancedMesh) (obj as InstancedMesh).dispose();
      });
      mats.forEach((x) => x.dispose());
      for (const tex of [atlas, blob, grass, standTex]) tex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      modes.remove();
      namesBtn.remove();
      canvas.remove();
    },
  };
}

/** The entry point for the lazy import: a view in `container`, or null when WebGL is unavailable or fails. */
export async function mount3D(container: HTMLElement): Promise<View3D | null> {
  try { return createView3D(container); } catch { return null; }
}

export type { Vec };
