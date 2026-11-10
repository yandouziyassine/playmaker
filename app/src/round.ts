import { getMoment, postPick, type Day, type Moment, type PickResult } from "./api.ts";
import { draw, hitOption, optionTargets, type View } from "./pitch.ts";

export interface RoundUI {
  canvas: HTMLCanvasElement; title: HTMLElement; actions: HTMLElement; reveal: HTMLElement; next: HTMLButtonElement;
}
const OUTCOME = { goal: "Goal within 15 s", shot: "Shot within 15 s", kept: "Possession kept", lost: "Ball lost" };

export async function playMoment(ui: RoundUI, mo: Moment, player: string, index: number): Promise<PickResult> {
  const ctx = ui.canvas.getContext("2d")!;
  const v: View = { w: ui.canvas.clientWidth, h: ui.canvas.clientHeight };
  ui.canvas.width = v.w * devicePixelRatio; ui.canvas.height = v.h * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio);
  const side = mo.attacking === "home" ? mo.home : mo.away;
  ui.title.textContent = `${index + 1}/5 · ${mo.home} – ${mo.away} · ${mo.minute}' · ${side} on the ball`;
  ui.reveal.hidden = true; ui.next.hidden = true;
  for (let f = 0; f < mo.lead_up.length; f++) { draw(ctx, v, mo, f); await new Promise((r) => setTimeout(r, 1000 / mo.fps)); }
  const last = mo.lead_up.length - 1;
  draw(ctx, v, mo, last);
  const pick = await new Promise<number>((resolve) => {
    const targets = optionTargets(v, mo);
    ui.canvas.onclick = (e) => { const r = ui.canvas.getBoundingClientRect(); const k = hitOption(targets, [e.clientX - r.left, e.clientY - r.top], 28); if (k !== null) resolve(k); };
    ui.actions.innerHTML = "";
    const carry = mo.options.filter((o) => o.kind === "carry");
    const best = carry.find((o) => o.angle === 0) ?? carry[0];
    if (best) ui.actions.append(button("Carry forward", () => resolve(best.k)));
    const shot = mo.options.find((o) => o.kind === "shot");
    if (shot) ui.actions.append(button("Shoot", () => resolve(shot.k)));
  });
  ui.canvas.onclick = null; ui.actions.innerHTML = "";
  const res = await postPick(player, mo.id, pick);
  draw(ctx, v, mo, last, { ai: res.ai_pick, pro: res.pro_pick, mine: pick });
  ui.reveal.hidden = false;
  ui.reveal.innerHTML = "";
  const line = (t: string, cls = "") => { const p = document.createElement("p"); p.textContent = t; if (cls) p.className = cls; ui.reveal.append(p); };
  line(`${res.points} points${res.among_best ? " · among the best" : ""}${res.pro_instinct ? " · pro instinct" : ""}`, "points");
  line(`AI pick (blue): ${label(mo, res.ai_pick)}. ${(res.reasons[res.ai_pick] ?? []).join("; ")}`);
  line(`What the pro did (yellow): ${label(mo, res.pro_pick)} → ${OUTCOME[res.outcome.kind]}.`);
  if (res.crowd) line(`Players: ${Math.round((res.crowd[pick] ?? 0) * 100)} % made your choice.`);
  line("The AI's ranking is a model opinion, not the truth.", "fine");
  return res;
}

function label(mo: Moment, k: number): string {
  const o = mo.options.find((q) => q.k === k)!;
  if (o.kind === "pass") { const p = mo.players[o.player!]!; return `pass to #${p.shirt} ${p.name}`; }
  return o.kind === "shot" ? "shoot" : `carry (${o.angle}°)`;
}
function button(text: string, on: () => void) { const b = document.createElement("button"); b.textContent = text; b.onclick = on; return b; }

export async function playDay(ui: RoundUI, day: Day, player: string): Promise<number[]> {
  const points: number[] = [];
  for (let i = 0; i < day.moments.length; i++) {
    const mo = await getMoment(day.moments[i]!);
    const res = await playMoment(ui, mo, player, i);
    points.push(res.points);
    ui.next.hidden = false; ui.next.textContent = i < day.moments.length - 1 ? "Next moment" : "See my score";
    await new Promise<void>((r) => (ui.next.onclick = () => r()));
  }
  return points;
}
