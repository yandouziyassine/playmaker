// A synthetic broadcast-like scene drawn by code (no third-party image): grass, painted lines and simple
// player figures seen through a known homography, so the calibration UI can be tried without a photo.
import { applyH, computeHomography, type Mat3, type Pt } from "./homography.ts";
import { pitchLines } from "./landmarks.ts";

export const SCENE_W = 1280, SCENE_H = 720;

/** Pitch metres -> scene pixels: right half of the pitch, camera high on the near side. */
export function sceneHomography(): Mat3 {
  return computeHomography(
    [{ x: 8, y: 34 }, { x: 52.5, y: 34 }, { x: 52.5, y: -34 }, { x: 8, y: -34 }],
    [{ x: 40, y: 120 }, { x: 1050, y: 140 }, { x: 1250, y: 930 }, { x: -420, y: 870 }],
  )!;
}

type Kit = { shirt: string; shorts: string };
const RED: Kit = { shirt: "#d7263d", shorts: "#ffffff" };
const WHITE: Kit = { shirt: "#f4f4f4", shorts: "#1b1f3b" };
const REF: Kit = { shirt: "#f2e205", shorts: "#111111" };
const KEEPER: Kit = { shirt: "#22aa55", shorts: "#22aa55" };

export const SCENE_PLAYERS: { p: Pt; kit: Kit }[] = [
  ...[[20, 12], [24, -6], [30, 20], [33, 2], [38, -14], [42, 8], [28, -22], [45, -3]].map(([x, y]) => ({ p: { x: x!, y: y! }, kit: RED })),
  ...[[23, 5], [27, -12], [35, 14], [39, -4], [44, 2], [41, -18], [47, 12], [32, -2]].map(([x, y]) => ({ p: { x: x!, y: y! }, kit: WHITE })),
  { p: { x: 29, y: 9 }, kit: REF },
  { p: { x: 51, y: 0.5 }, kit: KEEPER },
];

/** The ball, on the ground at the feet of the red player at (42, 8): he is the expected carrier. */
export const SCENE_BALL: Pt = { x: 42.8, y: 7.4 };
/** Drawn radius in pixels: a real ball would be ~2 px here, too small for the 320 px detector, so it is drawn oversized. */
export const SCENE_BALL_R = 9;

export function drawScene(ctx: CanvasRenderingContext2D): Mat3 {
  const H = sceneHomography();
  const P = (x: number, y: number) => applyH(H, { x, y })!;
  ctx.fillStyle = "#1f6b33";
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  // mowing stripes, 5.25 m wide
  for (let i = -10; i < 10; i++) {
    if (i % 2 === 0) continue;
    const x0 = i * 5.25, x1 = x0 + 5.25;
    const q = [P(x0, -40), P(x1, -40), P(x1, 40), P(x0, 40)];
    ctx.fillStyle = "#257a3b";
    ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.fill();
  }
  // stands above the far touchline
  ctx.fillStyle = "#1b2430";
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(SCENE_W, 0);
  const far = [P(60, 37), P(-20, 37)];
  ctx.lineTo(SCENE_W, far[0]!.y); ctx.lineTo(0, far[1]!.y); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3; ctx.lineCap = "round";
  for (const line of pitchLines()) {
    ctx.beginPath();
    line.forEach((m, k) => { const p = P(m.x, m.y); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.stroke();
  }
  // players, back to front
  const order = [...SCENE_PLAYERS].sort((a, b) => b.p.y - a.p.y);
  for (const { p, kit } of order) {
    const f = P(p.x, p.y);
    const side = P(p.x + 1, p.y);
    const s = Math.hypot(side.x - f.x, side.y - f.y); // pixels per metre here
    figure(ctx, f, s * 1.8, kit);
  }
  drawBall(ctx, P(SCENE_BALL.x, SCENE_BALL.y), SCENE_BALL_R);
  return H;
}

/** A classic black-and-white ball resting on its ground point g (shadow, shading, pentagon patches). */
export function drawBall(ctx: CanvasRenderingContext2D, g: Pt, r: number) {
  const c = { x: g.x, y: g.y - r };
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath(); ctx.ellipse(g.x + r * 0.3, g.y, r * 1.1, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  const grad = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.35, r * 0.1, c.x, c.y, r);
  grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#c9c9c9");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#151515";
  const pent = (x: number, y: number, rr: number, rot: number) => {
    ctx.beginPath();
    for (let k = 0; k < 5; k++) { const a = rot + (k * 2 * Math.PI) / 5; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
    ctx.closePath(); ctx.fill();
  };
  pent(c.x, c.y, r * 0.36, -Math.PI / 2);
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5 + Math.PI / 5;
    pent(c.x + r * 0.86 * Math.cos(a), c.y + r * 0.86 * Math.sin(a), r * 0.26, a);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
}

/** A simple player figure with rounded limbs, arms by the body and a head with hair (h = height in pixels). */
function figure(ctx: CanvasRenderingContext2D, feet: Pt, h: number, kit: Kit) {
  const w = h * 0.3, x = feet.x, y = feet.y;
  const rr = (x0: number, y0: number, ww: number, hh: number, fill: string, r = Math.min(ww, hh) / 2) => {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x0, y0, ww, hh, r); ctx.fill();
  };
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath(); ctx.ellipse(x + w * 0.15, y, w * 0.85, w * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  // legs (skin, then socks in the shorts colour), a gap between them, boots
  rr(x - w * 0.36, y - h * 0.48, w * 0.26, h * 0.46, "#d9a77e");
  rr(x + w * 0.1, y - h * 0.48, w * 0.26, h * 0.46, "#d9a77e");
  rr(x - w * 0.37, y - h * 0.24, w * 0.28, h * 0.2, kit.shorts === "#ffffff" ? "#d7263d" : kit.shorts, w * 0.08);
  rr(x + w * 0.09, y - h * 0.24, w * 0.28, h * 0.2, kit.shorts === "#ffffff" ? "#d7263d" : kit.shorts, w * 0.08);
  rr(x - w * 0.42, y - h * 0.055, w * 0.34, h * 0.055, "#111", w * 0.05);
  rr(x + w * 0.08, y - h * 0.055, w * 0.34, h * 0.055, "#111", w * 0.05);
  // shorts and shirt (wider at the shoulders)
  rr(x - w * 0.44, y - h * 0.58, w * 0.88, h * 0.16, kit.shorts, w * 0.1);
  ctx.fillStyle = kit.shirt;
  ctx.beginPath();
  ctx.moveTo(x - w * 0.55, y - h * 0.8); ctx.lineTo(x + w * 0.55, y - h * 0.8);
  ctx.lineTo(x + w * 0.44, y - h * 0.54); ctx.lineTo(x - w * 0.44, y - h * 0.54); ctx.closePath(); ctx.fill();
  rr(x - w * 0.5, y - h * 0.83, w, h * 0.08, kit.shirt, w * 0.2);
  // arms hanging by the body: sleeve, then forearm and hand
  rr(x - w * 0.78, y - h * 0.81, w * 0.26, h * 0.16, kit.shirt, w * 0.1);
  rr(x + w * 0.52, y - h * 0.81, w * 0.26, h * 0.16, kit.shirt, w * 0.1);
  rr(x - w * 0.76, y - h * 0.67, w * 0.21, h * 0.2, "#d9a77e");
  rr(x + w * 0.55, y - h * 0.67, w * 0.21, h * 0.2, "#d9a77e");
  // neck, head, hair
  rr(x - w * 0.1, y - h * 0.87, w * 0.2, h * 0.06, "#c99a70", w * 0.05);
  ctx.fillStyle = "#c99a70";
  ctx.beginPath(); ctx.ellipse(x, y - h * 0.925, h * 0.062, h * 0.075, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#2b1d14";
  ctx.beginPath(); ctx.ellipse(x, y - h * 0.955, h * 0.065, h * 0.05, 0, Math.PI, 2 * Math.PI); ctx.fill();
}
