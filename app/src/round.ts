import { getMoment, postPick, type Day, type Moment, type PickResult } from "./api.ts";
import { ballTrail, draw, hitOption, optionTargets, type Overlay, type View } from "./pitch.ts";
import { OUTCOME_TEXT, optionLabel, pct, progress, tier, verdict } from "./text.ts";

export interface RoundUI {
  canvas: HTMLCanvasElement; title: HTMLElement; dots: HTMLElement; hint: HTMLElement; actions: HTMLElement;
  list: HTMLElement; reveal: HTMLElement; next: HTMLButtonElement;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function setupCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; v: View } {
  const v: View = { w: canvas.clientWidth, h: canvas.clientHeight };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(v.w * dpr); canvas.height = Math.round(v.h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, v };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
}

function renderDots(ui: RoundUI, points: number[], total: number) {
  ui.dots.innerHTML = "";
  for (const state of progress(points, total)) ui.dots.append(el("span", `dot ${state}`));
}

async function playLeadUp(ctx: CanvasRenderingContext2D, v: View, mo: Moment) {
  const frames = reduced() ? [mo.lead_up.length - 1] : mo.lead_up.map((_, i) => i);
  for (const f of frames) {
    draw(ctx, v, mo, mo.lead_up[f]!, mo.ball[Math.min(f, mo.ball.length - 1)] ?? null);
    if (frames.length > 1) await sleep(1000 / mo.fps);
  }
}

/** Waits for a confirmed choice: tap a target (teammate, carry dot, goal) or a list button, then Confirm. */
function choose(ui: RoundUI, ctx: CanvasRenderingContext2D, v: View, mo: Moment): Promise<number> {
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const ball = mo.ball[mo.ball.length - 1] ?? null;
  const targets = optionTargets(v, mo);
  let selected: number | undefined;
  const repaint = () => draw(ctx, v, mo, release, ball, { targets: true, selected });
  repaint();
  ui.hint.textContent = "Tap a teammate to pass, a yellow arrow to carry, or the goal to shoot.";
  ui.list.innerHTML = "";
  const details = el("details", "optlist");
  details.append(el("summary", "", "Choose from a list"));
  const ul = el("div", "optgrid");
  details.append(ul);
  ui.list.append(details);
  return new Promise((resolve) => {
    const confirm = el("button", "primary", "Confirm");
    confirm.disabled = true;
    const label = el("span", "choice", "Nothing selected");
    ui.actions.innerHTML = "";
    ui.actions.append(label, confirm);
    const select = (k: number) => {
      selected = k; label.textContent = optionLabel(mo, k); confirm.disabled = false; repaint();
      for (const b of ul.querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.k) === k);
    };
    const rank = { pass: 0, shot: 1, carry: 2 } as const;
    for (const o of [...mo.options].sort((a, b) => rank[a.kind] - rank[b.kind] || a.k - b.k)) {
      const b = el("button", "opt", optionLabel(mo, o.k)); b.dataset.k = String(o.k); b.onclick = () => select(o.k); ul.append(b);
    }
    ui.canvas.onclick = (e) => {
      const r = ui.canvas.getBoundingClientRect();
      const k = hitOption(targets, [e.clientX - r.left, e.clientY - r.top], 26);
      if (k !== null) select(k);
    };
    confirm.onclick = () => {
      if (selected === undefined) return;
      ui.canvas.onclick = null; ui.actions.innerHTML = ""; ui.list.innerHTML = ""; ui.hint.textContent = "";
      resolve(selected);
    };
  });
}

async function playAfter(ctx: CanvasRenderingContext2D, v: View, mo: Moment, res: PickResult, pick: number) {
  const a = res.after;
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const arrows: Overlay = { ai: res.ai_pick, pro: res.pro_pick, mine: pick };
  draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, arrows);
  if (!a || reduced()) return;
  await sleep(1400);
  for (let f = 0; f < a.frames.length; f++) {
    draw(ctx, v, mo, a.frames[f]!, a.ball[f] ?? null, { trail: ballTrail(a.ball.slice(0, f + 1), v), dim: true });
    await sleep(1000 / a.fps);
  }
  await sleep(500);
  draw(ctx, v, mo, a.frames[a.frames.length - 1]!, a.ball[a.ball.length - 1] ?? null, { ...arrows, trail: ballTrail(a.ball, v), dim: true });
}

function renderReveal(ui: RoundUI, mo: Moment, res: PickResult, pick: number, replay: () => void, showAll: () => void) {
  const r = ui.reveal;
  r.innerHTML = ""; r.hidden = false;
  const head = el("div", `points ${tier(res.points)}`);
  head.append(el("strong", "", String(res.points)), el("span", "", " points"));
  r.append(head, el("p", "verdict", verdict(res, pick) + (res.pro_instinct ? " · 🧠 Pro instinct" : "")));
  const rows = el("div", "rows");
  const row = (cls: string, who: string, k: number, extra = "") => {
    const d = el("div", `row ${cls}`);
    d.append(el("span", "who", who), el("span", "what", optionLabel(mo, k) + extra));
    rows.append(d);
  };
  row("mine", "You", pick);
  row("ai", "AI coach", res.ai_pick);
  row("pro", "The pro", res.pro_pick, ` → ${OUTCOME_TEXT[res.outcome.kind]}`);
  r.append(rows);
  const reasons = res.reasons[res.ai_pick] ?? [];
  if (reasons.length) {
    const why = el("div", "why"); why.append(el("p", "label", "What the AI weighed for its pick"));
    const ul = el("ul", "reasons");
    for (const x of reasons) {
      const li = el("li", x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "value");
      li.append(el("span", "icon", x.effect > 0 ? "+" : x.effect < 0 ? "−" : "≈"), el("span", "", x.text));
      ul.append(li);
    }
    why.append(ul); r.append(why);
  }
  if (res.crowd) {
    const crowd = el("div", "crowd"); crowd.append(el("p", "label", "Other players"));
    const bar = (name: string, share: number, cls: string) => {
      const b = el("div", "bar"); const fill = el("span", `fill ${cls}`); fill.style.width = pct(share);
      b.append(el("span", "name", name), fill, el("span", "val", pct(share))); crowd.append(b);
    };
    bar("Your pick", res.crowd[pick] ?? 0, "mine");
    if (res.ai_pick !== pick) bar("AI's pick", res.crowd[res.ai_pick] ?? 0, "ai");
    r.append(crowd);
  } else {
    r.append(el("p", "fine", "Crowd stats appear once 20 players have answered."));
  }
  const tools = el("div", "tools");
  if (res.after) { const b = el("button", "ghost", "↺ Replay what happened"); b.onclick = replay; tools.append(b); }
  const all = el("button", "ghost", "Show every option's score"); all.onclick = showAll; tools.append(all);
  r.append(tools, el("p", "fine", "The AI's ranking is a model opinion, not the truth."));
}

export async function playMoment(ui: RoundUI, mo: Moment, player: string, index: number, total: number, points: number[]): Promise<PickResult> {
  const { ctx, v } = setupCanvas(ui.canvas);
  const side = mo.attacking === "home" ? mo.home : mo.away;
  const score = mo.scoreline ? ` ${mo.scoreline[0]}–${mo.scoreline[1]} ` : " – ";
  ui.title.textContent = `${mo.home}${score}${mo.away} · ${mo.minute}' · ${side} attack ↑`;
  renderDots(ui, points, total);
  ui.reveal.hidden = true; ui.next.hidden = true; ui.actions.innerHTML = ""; ui.list.innerHTML = "";
  ui.hint.textContent = "Watch the build-up…";
  await playLeadUp(ctx, v, mo);
  const pick = await choose(ui, ctx, v, mo);
  ui.hint.textContent = "Checking…";
  const res = await postPick(player, mo.id, pick);
  const mine = res.option; // the first answer counts: a replayed moment shows the original pick
  try { navigator.vibrate?.(res.points >= 100 ? [30, 40, 30] : 20); } catch { /* not supported */ }
  ui.hint.textContent = res.after ? "What really happened next:" : "";
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const showAll = () => {
    draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, { ai: res.ai_pick, pro: res.pro_pick, mine, scores: res.all_points });
    ui.hint.textContent = "Points of every option (green 100 · yellow 50+ · grey below)";
  };
  renderReveal(ui, mo, res, mine, () => void playAfter(ctx, v, mo, res, mine), showAll);
  if (res.repeat) ui.reveal.prepend(el("p", "fine", "You already answered this moment: your first answer counts."));
  renderDots(ui, [...points, res.points], total);
  await playAfter(ctx, v, mo, res, mine);
  ui.hint.textContent = "Blue: AI coach · Yellow: the pro · White: you";
  return res;
}

export async function playDay(ui: RoundUI, day: Day, player: string, onPoints: (p: number[]) => void = () => {}): Promise<number[]> {
  const points: number[] = [];
  const total = day.moments.length;
  let nextMoment = getMoment(day.moments[0]!);
  for (let i = 0; i < total; i++) {
    const mo = await nextMoment;
    if (i + 1 < total) nextMoment = getMoment(day.moments[i + 1]!); // prefetch while this one is played
    const res = await playMoment(ui, mo, player, i, total, points);
    points.push(res.points); onPoints(points);
    ui.next.hidden = false; ui.next.textContent = i < total - 1 ? "Next moment →" : "See my score";
    ui.next.focus();
    await new Promise<void>((r) => (ui.next.onclick = () => r()));
  }
  return points;
}
