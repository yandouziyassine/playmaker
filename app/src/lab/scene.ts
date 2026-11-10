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
  return H;
}

function figure(ctx: CanvasRenderingContext2D, feet: Pt, h: number, kit: Kit) {
  const w = h * 0.28, x = feet.x, y = feet.y;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(x, y, w * 0.8, w * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#e0b48a";
  ctx.fillRect(x - w * 0.32, y - h * 0.47, w * 0.22, h * 0.42); // legs
  ctx.fillRect(x + w * 0.1, y - h * 0.47, w * 0.22, h * 0.42);
  ctx.fillStyle = "#111";
  ctx.fillRect(x - w * 0.36, y - h * 0.06, w * 0.3, h * 0.06); // boots
  ctx.fillRect(x + w * 0.06, y - h * 0.06, w * 0.3, h * 0.06);
  ctx.fillStyle = kit.shorts;
  ctx.fillRect(x - w * 0.42, y - h * 0.55, w * 0.84, h * 0.17);
  ctx.fillStyle = kit.shirt;
  ctx.fillRect(x - w * 0.5, y - h * 0.84, w, h * 0.32); // torso
  ctx.fillRect(x - w * 0.78, y - h * 0.83, w * 0.28, h * 0.27); // arms
  ctx.fillRect(x + w * 0.5, y - h * 0.83, w * 0.28, h * 0.27);
  ctx.fillStyle = "#c99a70";
  ctx.beginPath(); ctx.arc(x, y - h * 0.91, h * 0.08, 0, Math.PI * 2); ctx.fill();
}
