// Free play drawing on the portrait pitch: same mapping and look as pitch.ts (attack up, +y on the left), fed with raw
// tracking metres turned by viewFlip so that the view stays fixed for the whole match (home attacks up in the first
// half). The few lines of mapping are copied, not imported, so that the game's bundle is not split into shared chunks.
import type { Vec } from "../coach/geometry.ts";
import type { CoachOption } from "../coach/advice.ts";
import type { FrameAdvice } from "./coach.ts";
import { toView, type MatchMeta } from "./data.ts";
import { pct, xg } from "../i18n/index.ts";

const L = 105, W = 68, PAD = 14;
export interface View { w: number; h: number }
export const COLORS = { ai: "#4cc9f0", ball: "#ffe066" };
export const scale = (v: View) => Math.min((v.w - 2 * PAD) / W, (v.h - 2 * PAD) / L);
/** Attack-up metres to canvas pixels (pitch.ts toScreen). */
export function toScreen(p: Vec, v: View): Vec {
  const s = scale(v);
  return [v.w / 2 - p[1] * s, v.h / 2 - p[0] * s];
}
/** How many of the coach's options are drawn and listed. */
export const TOP = 3;

/** Short label drawn next to an arrow: rank, success and value (same rounding as coach/picture.ts). */
export function arrowLabel(rank: number, o: Pick<CoachOption, "p" | "score">): string {
  const r = Math.round(o.score * 1000) / 1000;
  return `${rank + 1} · ${pct(o.p)} · ${xg(r)}`;
}

export const ARROW_COLORS = [COLORS.ai, "#ffd166", "#f1faee"] as const;

/** Dark or light ink for text on a team colour (#rrggbb). */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) > 140 ? "#0b2a1a" : "#ffffff";
}

export function drawPitch(ctx: CanvasRenderingContext2D, v: View) {
  const c = (x: number, y: number) => toScreen([x, y], v), s = scale(v);
  ctx.fillStyle = "#0b2a1a"; ctx.fillRect(0, 0, v.w, v.h);
  const [xl] = c(0, W / 2), [xr] = c(0, -W / 2);
  for (let i = 0; i < 10; i++) {
    const [, y0] = c(L / 2 - i * (L / 10), 0), [, y1] = c(L / 2 - (i + 1) * (L / 10), 0);
    ctx.fillStyle = i % 2 ? "#1b6b3d" : "#1f7845"; ctx.fillRect(xl, y0, xr - xl, y1 - y0);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.4;
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const [a, b] = c(x0, y0), [d, e] = c(x1, y1);
    ctx.strokeRect(Math.min(a, d), Math.min(b, e), Math.abs(d - a), Math.abs(e - b));
  };
  rect(-L / 2, -W / 2, L / 2, W / 2);
  ctx.beginPath(); ctx.moveTo(...c(0, -W / 2)); ctx.lineTo(...c(0, W / 2)); ctx.stroke();
  ctx.beginPath(); ctx.arc(...c(0, 0), 9.15 * s, 0, 2 * Math.PI); ctx.stroke();
  for (const sx of [1, -1]) {
    rect(sx * L / 2, -20.16, sx * (L / 2 - 16.5), 20.16);
    rect(sx * L / 2, -9.16, sx * (L / 2 - 5.5), 9.16);
    ctx.lineWidth = 2.2; rect(sx * L / 2, -3.66, sx * (L / 2 + 2), 3.66); ctx.lineWidth = 1.4;
    ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(...c(sx * (L / 2 - 11), 0), 1.6, 0, 2 * Math.PI); ctx.fill();
  }
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Places a label box near (x, y), moved down (then up) until it clears the boxes already placed. */
export function placeLabel(want: Box, taken: Box[], v: { w: number; h: number }): Box {
  const clampBox = (b: Box): Box => ({ ...b, x: Math.min(v.w - b.w - 2, Math.max(2, b.x)), y: Math.min(v.h - b.h - 2, Math.max(2, b.y)) });
  for (let k = 0; k < 8; k++) {
    for (const dir of [1, -1]) {
      const b = clampBox({ ...want, y: want.y + dir * k * (want.h + 2) });
      if (!taken.some((t) => overlaps(t, b))) return b;
    }
  }
  return clampBox(want);
}

function arrow(ctx: CanvasRenderingContext2D, from: Vec, to: Vec, color: string, width: number) {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len, uy = dy / len, head = 8 + width;
  const end: Vec = [to[0] - ux * 7, to[1] - uy * 7];
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(end[0] - ux * head * 0.6, end[1] - uy * head * 0.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(...end);
  ctx.lineTo(end[0] - ux * head - uy * head * 0.55, end[1] - uy * head + ux * head * 0.55);
  ctx.lineTo(end[0] - ux * head + uy * head * 0.55, end[1] - uy * head - ux * head * 0.55);
  ctx.closePath(); ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, at: Vec, color: string, text: string, taken: Box[], v: View) {
  ctx.font = "700 10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const b = placeLabel({ x: at[0] + 9, y: at[1] - 20, w: ctx.measureText(text).width + 10, h: 16 }, taken, v);
  taken.push(b);
  ctx.fillStyle = "rgba(7,23,14,0.88)"; ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.fillText(text, b.x + 5, b.y + b.h / 2 + 0.5);
}

export interface Scene {
  players: { player: number; at: Vec }[]; ball: Vec | null; trail: Vec[];
  advice: FrameAdvice | null; carrierAt: Vec | null; top: number;
}

export function drawScene(ctx: CanvasRenderingContext2D, v: View, m: MatchMeta, flip: 1 | -1, sc: Scene) {
  const px = (p: Vec): Vec => toScreen(toView(p, flip), v);
  drawPitch(ctx, v);
  if (sc.trail.length > 1) {
    ctx.strokeStyle = "rgba(255,224,102,0.5)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...px(sc.trail[0]!));
    for (const p of sc.trail.slice(1)) ctx.lineTo(...px(p));
    ctx.stroke();
  }
  const carrier = sc.advice?.carrier.player;
  for (const d of sc.players) {
    const info = m.players[d.player];
    const fill = info && (info.team === 0 || info.team === 1) ? m.meta.colors[info.team] : "#777777", ink = textOn(fill);
    const [x, y] = px(d.at);
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(x + 1.5, y + 2, 8, 6, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI); ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = ink === "#ffffff" ? "rgba(255,255,255,0.6)" : "rgba(11,42,26,0.6)"; ctx.stroke();
    if (d.player === carrier) { ctx.beginPath(); ctx.arc(x, y, 11.5, 0, 2 * Math.PI); ctx.lineWidth = 2.5; ctx.strokeStyle = COLORS.ball; ctx.stroke(); }
    ctx.fillStyle = ink; ctx.font = "600 9px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(info?.shirt ?? ""), x, y + 0.5);
  }
  if (sc.ball) {
    const [bx, by] = px(sc.ball);
    ctx.fillStyle = COLORS.ball; ctx.strokeStyle = "#222"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(bx, by, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }
  if (sc.advice && sc.carrierAt) {
    const from = px(sc.carrierAt), shown = sc.advice.ranked.slice(0, sc.top);
    for (let i = shown.length - 1; i >= 0; i--) // best drawn last, on top
      arrow(ctx, from, px(shown[i]!.to), ARROW_COLORS[i] ?? "#f1faee", i === 0 ? 3.5 : 2.5);
    const taken: Box[] = []; // labels after the arrows, best placed first, never on top of each other
    shown.forEach((r, i) => label(ctx, px(r.to), ARROW_COLORS[i] ?? "#f1faee", arrowLabel(i, r.option), taken, v));
  }
}
