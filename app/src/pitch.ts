import type { Moment } from "./api.ts";

export interface View { w: number; h: number }
export type Pt = [number, number];
type Cm = [number, number] | null;

const L = 105, W = 68, PAD = 14;
export const COLORS = { attack: "#ef476f", defend: "#f1faee", ai: "#4cc9f0", pro: "#ffd166", mine: "#ffffff", ball: "#ffe066" };

/** Metres (attack-normalised: the attacking side plays towards +x) to canvas pixels, portrait: attack points up and,
 * facing +x, +y is on the player's left, so it is drawn on the left. */
export function toScreen(p: Pt, v: View): Pt {
  const s = scale(v);
  return [v.w / 2 - p[1] * s, v.h / 2 - p[0] * s];
}
export const scale = (v: View) => Math.min((v.w - 2 * PAD) / W, (v.h - 2 * PAD) / L);

export function hitOption(opts: { k: number; at: Pt }[], tap: Pt, radius: number): number | null {
  let best: number | null = null, bestD = radius;
  for (const o of opts) { const d = Math.hypot(o.at[0] - tap[0], o.at[1] - tap[1]); if (d <= bestD) { best = o.k; bestD = d; } }
  return best;
}

/** Keyboard play: the option after (dir 1) or before (dir -1) `cur` in `order`. Arrow keys wrap around; Tab does not
 * (wrap false): null past either end, so focus can leave the pitch (no keyboard trap). */
export function stepOption(order: number[], cur: number | undefined, dir: 1 | -1, wrap = true): number | null {
  if (!order.length) return null;
  const i = cur === undefined ? -1 : order.indexOf(cur);
  if (i < 0) return !wrap && dir < 0 ? null : dir > 0 ? order[0]! : order[order.length - 1]!;
  const j = i + dir;
  if (j >= 0 && j < order.length) return order[j]!;
  return wrap ? order[(j + order.length) % order.length]! : null;
}

const m = (cm: [number, number]): Pt => [cm[0] / 100, cm[1] / 100];

/** Screen position of every option's tap target: the teammate (pass), the carry point, the goal mouth (shot). */
export function optionTargets(v: View, mo: Moment, frame: Cm[] = mo.lead_up[mo.lead_up.length - 1]!): { k: number; at: Pt }[] {
  return mo.options.map((o) => {
    const p = o.kind === "pass" && frame[o.player!] ? m(frame[o.player!]!) : m(o.to);
    return { k: o.k, at: toScreen(p, v) };
  });
}

function drawPitch(ctx: CanvasRenderingContext2D, v: View) {
  const c = (x: number, y: number) => toScreen([x, y], v);
  const s = scale(v);
  ctx.fillStyle = "#0b2a1a"; ctx.fillRect(0, 0, v.w, v.h);
  for (let i = 0; i < 10; i++) { // mowing stripes
    const [, y0] = c(L / 2 - i * (L / 10), 0), [, y1] = c(L / 2 - (i + 1) * (L / 10), 0);
    ctx.fillStyle = i % 2 ? "#1b6b3d" : "#1f7845";
    const [xl] = c(0, W / 2), [xr] = c(0, -W / 2);
    ctx.fillRect(xl, y0, xr - xl, y1 - y0);
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
    const spot = c(sx * (L / 2 - 11), 0);
    ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(...spot, 1.6, 0, 2 * Math.PI); ctx.fill();
    // penalty arc: the part of the 9.15 m circle around the spot outside the box
    const a = Math.acos(5.5 / 9.15);
    const mid = sx > 0 ? Math.PI / 2 : -Math.PI / 2; // screen angle pointing away from the goal
    ctx.beginPath(); ctx.arc(...spot, 9.15 * s, mid - a, mid + a); ctx.stroke();
    // goal
    ctx.lineWidth = 2.2; rect(sx * L / 2, -3.66, sx * (L / 2 + 2), 3.66); ctx.lineWidth = 1.4;
  }
  ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(...c(0, 0), 1.6, 0, 2 * Math.PI); ctx.fill();
}

export interface Overlay {
  ai?: number; pro?: number; mine?: number; selected?: number; targets?: boolean; trail?: Pt[]; dim?: boolean;
  scores?: Record<number, number>;
}

function arrowTo(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, color: string, width: number, dashed = false) {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len, uy = dy / len, head = 8 + width;
  const end: Pt = [to[0] - ux * 6, to[1] - uy * 6];
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = "round";
  ctx.setLineDash(dashed ? [6, 5] : []);
  ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(end[0] - ux * head * 0.6, end[1] - uy * head * 0.6); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(...end);
  ctx.lineTo(end[0] - ux * head - uy * head * 0.55, end[1] - uy * head + ux * head * 0.55);
  ctx.lineTo(end[0] - ux * head + uy * head * 0.55, end[1] - uy * head - ux * head * 0.55);
  ctx.closePath(); ctx.fill();
}

/** One frame: pitch, option targets (carry chevrons, goal), players (defenders first), ball, arrows. */
export function draw(ctx: CanvasRenderingContext2D, v: View, mo: Moment, frame: Cm[], ball: Cm, o: Overlay = {}) {
  drawPitch(ctx, v);
  const c = (p: [number, number]) => toScreen(m(p), v);
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const carrierAt = release[mo.carrier] ? c(release[mo.carrier]!) : null;
  if (o.targets && carrierAt) {
    for (const opt of mo.options) {
      if (opt.kind === "carry") {
        // a chevron pointing away from the carrier (yellow: never confused with the white defenders)
        const at = c(opt.to); const sel = o.selected === opt.k;
        const dx = at[0] - carrierAt[0], dy = at[1] - carrierAt[1], len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len, r = sel ? 7 : 5.5;
        ctx.strokeStyle = sel ? "#fff" : "rgba(255,224,102,0.85)"; ctx.lineWidth = sel ? 3 : 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(at[0] - ux * r - uy * r, at[1] - uy * r + ux * r);
        ctx.lineTo(at[0], at[1]);
        ctx.lineTo(at[0] - ux * r + uy * r, at[1] - uy * r - ux * r);
        ctx.stroke();
      }
      if (opt.kind === "shot") {
        const g = c([5250, 0]); const sel = o.selected === opt.k;
        ctx.strokeStyle = sel ? "#fff" : "rgba(255,255,255,0.55)"; ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath(); ctx.arc(...g, 12, 0, 2 * Math.PI); ctx.stroke();
      }
    }
  }
  if (o.trail && o.trail.length > 1) {
    ctx.strokeStyle = "rgba(255,224,102,0.55)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...o.trail[0]!);
    for (const p of o.trail.slice(1)) ctx.lineTo(...p);
    ctx.stroke();
  }
  const order = frame.map((_, i) => i).sort((a, b) => mo.players[b]!.side - mo.players[a]!.side);
  for (const i of order) {
    const p = frame[i]; if (!p) continue;
    const [x, y] = c(p); const pl = mo.players[i]!; const isCarrier = i === mo.carrier;
    const sel = o.selected !== undefined && mo.options.find((q) => q.k === o.selected)?.player === i;
    ctx.globalAlpha = o.dim && pl.side === 1 ? 0.75 : 1;
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(x + 1.5, y + 2, 8, 6, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = pl.side === 0 ? COLORS.attack : COLORS.defend;
    ctx.beginPath(); ctx.arc(x, y, isCarrier ? 9.5 : 8, 0, 2 * Math.PI); ctx.fill();
    if (isCarrier || sel) { ctx.strokeStyle = sel ? "#fff" : COLORS.ball; ctx.lineWidth = sel ? 3 : 2.5; ctx.stroke(); }
    ctx.fillStyle = pl.side === 0 ? "#fff" : "#0b2a1a"; ctx.font = "600 9px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(pl.shirt), x, y + 0.5);
    ctx.globalAlpha = 1;
  }
  if (ball) {
    const [bx, by] = c(ball);
    ctx.fillStyle = COLORS.ball; ctx.strokeStyle = "#222"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(bx, by, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }
  if (carrierAt) {
    const tip = (k: number) => {
      const opt = mo.options.find((q) => q.k === k)!;
      if (opt.kind === "pass" && release[opt.player!]) return c(release[opt.player!]!);
      return c(opt.to);
    };
    if (o.selected !== undefined) arrowTo(ctx, carrierAt, tip(o.selected), COLORS.mine, 2.5, true);
    if (o.pro !== undefined) arrowTo(ctx, carrierAt, tip(o.pro), COLORS.pro, 3.5);
    if (o.ai !== undefined) arrowTo(ctx, carrierAt, tip(o.ai), COLORS.ai, 3.5);
    if (o.mine !== undefined && o.mine !== o.ai && o.mine !== o.pro) arrowTo(ctx, carrierAt, tip(o.mine), COLORS.mine, 2.5);
    if (o.scores) {
      const carries = mo.options.filter((q) => q.kind === "carry");
      const bestCarry = carries.reduce<number | undefined>((b, q) => (b === undefined || (o.scores![q.k] ?? -1) > (o.scores![b] ?? -1) ? q.k : b), undefined);
      for (const opt of mo.options) {
        if (opt.kind === "carry" && opt.k !== bestCarry) continue; // one badge for the best carry: 6 m carries overlap
        const pts = o.scores[opt.k]; if (pts === undefined) continue;
        const [x, y] = opt.kind === "shot" ? c([5250, 0]) : tip(opt.k);
        const col = pts >= 100 ? "#06d6a0" : pts >= 50 ? "#ffd166" : "#93a0b4"; // = --top / --mid / --low (design/tokens.css)
        ctx.font = "700 10px system-ui, sans-serif"; const w = ctx.measureText(String(pts)).width + 8;
        ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x + 7, y - 19, w, 14, 7); ctx.fill();
        ctx.fillStyle = "#07170e"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(pts), x + 7 + w / 2, y - 12);
      }
    }
  }
}

export const ballTrail = (balls: Cm[], v: View): Pt[] => balls.filter((b): b is [number, number] => !!b).map((b) => toScreen(m(b), v));
