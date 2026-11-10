import type { Moment } from "./api.ts";
export interface View { w: number; h: number }
export type Pt = [number, number];
const L = 105, W = 68, PAD = 12;

export function toScreen(p: Pt, v: View): Pt {
  const s = Math.min((v.w - 2 * PAD) / W, (v.h - 2 * PAD) / L);
  // attack points up the screen; facing +x, +y is on the player's left
  return [v.w / 2 - p[1] * s, v.h / 2 - p[0] * s];
}
export function hitOption(opts: { k: number; at: Pt }[], tap: Pt, radius: number): number | null {
  let best: number | null = null, bestD = radius;
  for (const o of opts) { const d = Math.hypot(o.at[0] - tap[0], o.at[1] - tap[1]); if (d <= bestD) { best = o.k; bestD = d; } }
  return best;
}
const m = (cm: [number, number]): Pt => [cm[0] / 100, cm[1] / 100];

export function draw(ctx: CanvasRenderingContext2D, v: View, mo: Moment, frame: number, highlight: { ai?: number; pro?: number; mine?: number } = {}) {
  ctx.clearRect(0, 0, v.w, v.h);
  ctx.fillStyle = "#1f6f3a"; ctx.fillRect(0, 0, v.w, v.h);
  ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.5;
  const c = (x: number, y: number) => toScreen([x, y], v);
  const [x0, y0] = c(L / 2, -W / 2), [x1, y1] = c(-L / 2, W / 2);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.beginPath(); ctx.moveTo(...c(0, -W / 2)); ctx.lineTo(...c(0, W / 2)); ctx.stroke();
  for (const sx of [1, -1]) { const [a, b] = c(sx * (L / 2 - 16.5), -20.16), [d, e] = c(sx * L / 2, 20.16); ctx.strokeRect(Math.min(a, d), Math.min(b, e), Math.abs(d - a), Math.abs(e - b)); }
  const f = mo.lead_up[Math.min(frame, mo.lead_up.length - 1)]!;
  const carrierAt = f[mo.carrier] ? c(...m(f[mo.carrier]!)) : null;
  const arrow = (k: number | undefined, color: string, width: number) => {
    if (k === undefined || !carrierAt) return;
    const o = mo.options.find((q) => q.k === k)!; const to = c(...m(o.to));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(...carrierAt); ctx.lineTo(...to); ctx.stroke();
  };
  const order = f.map((_, i) => i).sort((a, b) => mo.players[b]!.side - mo.players[a]!.side); // defenders first, attackers on top
  for (const i of order) {
    const p = f[i]; if (!p) continue; const [x, y] = c(...m(p)); const pl = mo.players[i]!;
    ctx.fillStyle = pl.side === 0 ? "#e63946" : "#f1faee"; ctx.beginPath(); ctx.arc(x, y, i === mo.carrier ? 9 : 7, 0, 2 * Math.PI); ctx.fill();
    if (i === mo.carrier) { ctx.strokeStyle = "#ffe066"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = pl.side === 0 ? "#fff" : "#111"; ctx.font = "9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(pl.shirt), x, y);
  }
  arrow(highlight.pro, "#ffd166", 3); arrow(highlight.ai, "#4cc9f0", 3); arrow(highlight.mine, "#ffffff", 2);
  const b = mo.ball[Math.min(frame, mo.ball.length - 1)]!; const [bx, by] = c(...m(b));
  ctx.fillStyle = "#ffe066"; ctx.beginPath(); ctx.arc(bx, by, 4, 0, 2 * Math.PI); ctx.fill();
}

export function optionTargets(v: View, mo: Moment): { k: number; at: Pt }[] {
  const last = mo.lead_up[mo.lead_up.length - 1]!;
  return mo.options.filter((o) => o.kind === "pass").map((o) => ({ k: o.k, at: toScreen(m(last[o.player!] ?? o.to), v) }));
}
