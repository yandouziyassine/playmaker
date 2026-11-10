// The 3D "player's eyes" view: three.js scene + renderer, loaded with import() (see toggle.ts) so three.js is a
// separate chunk and never weighs on the 2D game. Adapted from the portfolio site's football3d scene.ts / view3d.ts
// (same author, MIT): instanced capsule players with team colours, billboard shirt numbers from a drawn 10 x 10 atlas,
// pitch markings as ground ribbons, goals, ball, arrows as flat ribbons on the grass.
// The camera stands at the ball carrier's head and looks at the attacking goal; drag (or wheel) to look around,
// double-click / double-tap to re-centre. Renders only on demand (show, resize, a drag).
import {
  BufferAttribute, BufferGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, DynamicDrawUsage, Fog, HemisphereLight, InstancedBufferAttribute, InstancedMesh, Line,
  LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry,
  Quaternion, RingGeometry, Scene, ShaderMaterial, SphereGeometry, Vector3, WebGLRenderer, type Material,
} from "three";
import type { Moment } from "../api.ts";
import {
  COLORS, EYES_FOV, GOAL_H, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, LOOK_HOME, arrowSpecs, atlasCell, carrierAt,
  cmToM, dragLook, eyesArrow, eyesPose, pitchMarkings, ribbon, selectedReceiver, zoomFov, type Look, type Overlay3D, type Vec,
} from "./geom.ts";

type Cm = [number, number] | null;
export interface View3D {
  readonly canvas: HTMLCanvasElement;
  show(mo: Moment, frame: Cm[], ball: Cm, overlay?: Overlay3D): void;
  /** Back to looking at the goal. */
  reset(): void;
  dispose(): void;
}

const MAX_FIGURES = 30, MAX_ARROW_VERTS = 4 * 60 * 3, MAX_TRAIL = 200, MAX_DPR = 1.5;
const BODY_Y = 0.78, HEAD_Y = 1.7, NUMBER_Y = 2.3, BALL_R = 0.11, BALL_VIS_R = 0.16;

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

export function hasWebGL(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch { return false; }
}

const flat = <T extends BufferGeometry>(g: T): T => { g.rotateX(-Math.PI / 2); return g; };

/** Creates the view inside `host` (its canvas is prepended), or returns null when WebGL is not available. */
export function createView3D(host: HTMLElement): View3D | null {
  if (!hasWebGL()) return null;
  const canvas = document.createElement("canvas");
  canvas.className = "v3d-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3D view through the ball carrier's eyes, looking at the goal; drag to look around");
  host.prepend(canvas);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
  } catch {
    canvas.remove();
    return null;
  }
  renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));

  // ---- scene ----
  const scene = new Scene();
  scene.background = new Color("#0a1f14");
  scene.fog = new Fog("#0a1f14", 70, 160);
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(-30, 60, 40);
  scene.add(new HemisphereLight(0xffffff, 0x1d2b1f, 1.8), sun);

  const ground = (w: number, d: number, colour: string, y: number) => {
    const mesh = new Mesh(flat(new PlaneGeometry(w, d)), new MeshLambertMaterial({ color: colour }));
    mesh.position.y = y;
    return mesh;
  };
  scene.add(ground(2 * HALF_LENGTH + 40, 2 * HALF_WIDTH + 40, "#123323", -0.03));
  // mowing stripes, as on the 2D pitch
  for (let i = 0; i < 10; i++) {
    const stripe = ground(2 * HALF_LENGTH / 10, 2 * HALF_WIDTH + 6, i % 2 ? "#1b6b3d" : "#1f7845", -0.01);
    stripe.position.x = -HALF_LENGTH + (i + 0.5) * (2 * HALF_LENGTH / 10);
    scene.add(stripe);
  }
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
  const shadowMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
  const shadows = figureMesh(flat(new CircleGeometry(0.45, 12)), shadowMat);
  const bodies = figureMesh(new CapsuleGeometry(0.28, 1.0, 4, 8), new MeshLambertMaterial({ color: 0xffffff }));
  for (let i = 0; i < MAX_FIGURES; i++) bodies.setColorAt(i, colour.set(0xffffff));
  const heads = figureMesh(new SphereGeometry(0.14, 10, 8), new MeshLambertMaterial({ color: "#d8c3a5" }));
  const cells = new InstancedBufferAttribute(new Float32Array(MAX_FIGURES * 2), 2);
  const numberGeo = new PlaneGeometry(1, 1);
  numberGeo.setAttribute("aCell", cells);
  const atlas = numberAtlas();
  const numbers = figureMesh(numberGeo, new ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uSize: { value: 0.75 } }, vertexShader: NUMBER_VS, fragmentShader: NUMBER_FS,
  }));
  const ring = new Mesh(flat(new RingGeometry(0.55, 0.75, 24)), new MeshBasicMaterial({ color: "#ffffff" }));
  ring.visible = false;
  const ball = new Mesh(new SphereGeometry(BALL_VIS_R, 16, 12), new MeshLambertMaterial({ color: COLORS.ball }));
  ball.visible = false;

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
  scene.add(shadows, bodies, heads, numbers, ring, ball, arrows, trail);

  // ---- camera and steering ----
  const camera = new PerspectiveCamera(EYES_FOV, 1, 0.1, 400);
  let look: Look = LOOK_HOME, fov = EYES_FOV, eye: Vec = [0, 0], raf = 0, disposed = false;
  const aim = new Vector3();

  function render() {
    raf = 0;
    if (disposed) return;
    const pose = eyesPose(eye, look, fov);
    camera.position.set(...pose.position);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(aim.set(...pose.target));
    renderer.render(scene, camera);
  }
  const request = () => { if (!raf && !disposed) raf = requestAnimationFrame(render); };

  const pts = new Map<number, { x: number; y: number }>();
  let lastTap = 0;
  function down(e: PointerEvent) {
    canvas.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.timeStamp - lastTap < 300) { look = LOOK_HOME; fov = EYES_FOV; request(); }
    lastTap = e.timeStamp;
  }
  function move(e: PointerEvent) {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    if (pts.size >= 2) { // pinch: the distance between the first two pointers zooms
      const [a, b] = [...pts.values()];
      const d0 = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [c, d] = [...pts.values()];
      const d1 = Math.hypot(c!.x - d!.x, c!.y - d!.y);
      if (d0 > 0 && d1 > 0) fov = zoomFov(fov, -Math.log(d1 / d0) / 0.001);
    } else {
      look = dragLook(look, e.clientX - prev.x, e.clientY - prev.y, fov, canvas.clientHeight);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    request();
  }
  function up(e: PointerEvent) { pts.delete(e.pointerId); }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    fov = zoomFov(fov, Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 16 : 1))));
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
    request();
  });
  ro.observe(canvas);
  const lost = (e: Event) => e.preventDefault();
  canvas.addEventListener("webglcontextlost", lost);

  let lastMoment: string | null = null;

  return {
    canvas,
    show(mo, frame, b, o = {}) {
      if (mo.id !== lastMoment) { lastMoment = mo.id; look = LOOK_HOME; fov = EYES_FOV; }
      eye = carrierAt(mo, frame) ?? eye;
      const receiver = selectedReceiver(mo, o);
      let n = 0;
      q.identity();
      ring.visible = false;
      frame.forEach((cm, i) => {
        if (!cm || n >= MAX_FIGURES) return;
        const pl = mo.players[i];
        if (!pl) return;
        const [x, y] = cmToM(cm), z = -y, k = i === mo.carrier ? 0 : 1; // the camera is inside the carrier
        s.set(k, k, k);
        bodies.setMatrixAt(n, m.compose(p.set(x, BODY_Y, z), q, s));
        bodies.setColorAt(n, colour.set(pl.side === 0 ? COLORS.attack : COLORS.defend));
        heads.setMatrixAt(n, m.compose(p.set(x, HEAD_Y, z), q, s));
        numbers.setMatrixAt(n, m.compose(p.set(x, NUMBER_Y, z), q, s));
        const [cx, cy] = atlasCell(pl.shirt);
        cells.setXY(n, cx, cy);
        shadows.setMatrixAt(n, m.compose(p.set(x, 0.01, z), q, s));
        if (i === receiver) { ring.visible = true; ring.position.set(x, 0.02, z); }
        n++;
      });
      for (const mesh of [bodies, heads, numbers, shadows]) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; }
      bodies.instanceColor!.needsUpdate = true;
      cells.needsUpdate = true;

      ball.visible = !!b;
      if (b) { const [bx, by] = cmToM(b); ball.position.set(bx, Math.max(BALL_R, BALL_VIS_R), -by); }

      let v = 0;
      arrowSpecs(mo, o).forEach((a, ai) => {
        const tri = eyesArrow(a.from, a.to, a.dashed), y = 0.03 + ai * 0.004; // later arrows a hair higher: on top
        colour.set(a.color);
        for (let i = 0; i + 1 < tri.length && v < MAX_ARROW_VERTS; i += 2, v++) {
          arrowPos.setXYZ(v, tri[i]!, y, -tri[i + 1]!);
          arrowCol.setXYZ(v, colour.r, colour.g, colour.b);
        }
      });
      arrowGeo.setDrawRange(0, v - (v % 3));
      arrowPos.needsUpdate = arrowCol.needsUpdate = true;

      const tr = (o.balls ?? []).filter((x): x is [number, number] => !!x).slice(-MAX_TRAIL).map(cmToM);
      tr.forEach((t, i) => trailPos.setXYZ(i, t[0], 0.05, -t[1]));
      trailGeo.setDrawRange(0, tr.length);
      trailPos.needsUpdate = true;
      request();
    },
    reset() { look = LOOK_HOME; fov = EYES_FOV; request(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      for (const [t, h] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]] as const) canvas.removeEventListener(t, h as EventListener);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", lost);
      ro.disconnect();
      const mats = new Set<Material>();
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        mesh.geometry?.dispose();
        if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((x) => mats.add(x));
        if ((obj as InstancedMesh).isInstancedMesh) (obj as InstancedMesh).dispose();
      });
      mats.forEach((x) => x.dispose());
      atlas.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/** The entry point for the lazy import: a view in `container`, or null when WebGL is unavailable or fails. */
export async function mount3D(container: HTMLElement): Promise<View3D | null> {
  try { return createView3D(container); } catch { return null; }
}

export type { Vec };
