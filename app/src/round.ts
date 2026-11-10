import { getMoment, postPick, type Day, type Moment, type PickResult } from "./api.ts";
import { ballTrail, draw as draw2D, hitOption, optionTargets, stepOption, type View } from "./pitch.ts";
import { OUTCOME_TEXT, optionLabel, pct, progress, proReadLine, tier, verdict } from "./text.ts";
import { is3D, on3DChange, paint3D, pick3D, setup3D } from "./view3d/toggle.ts";
import type { Overlay3D as Overlay } from "./view3d/geom.ts";
import { icon, setIconText, spinner, type IconName } from "./design/icons.ts";

type Cm = [number, number] | null;
/** Paints the 2D pitch and mirrors the frame into the 3D view (shown instead of the canvas when 3D is on). */
function draw(ctx: CanvasRenderingContext2D, v: View, mo: Moment, frame: Cm[], ball: Cm, o: Overlay = {}) {
  draw2D(ctx, v, mo, frame, ball, o);
  paint3D(mo, frame, ball, o);
}

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

/** Progress dots; `just`: the last answered dot fills with a short pop (useful feedback: the answer counted). */
function renderDots(ui: RoundUI, points: number[], total: number, just = false) {
  ui.dots.innerHTML = "";
  progress(points, total).forEach((state, i) => ui.dots.append(el("span", `dot ${state}${just && i === points.length - 1 ? " just" : ""}`)));
  ui.dots.setAttribute("aria-label", `${points.length} of ${total} moments answered`);
}

async function playLeadUp(ctx: CanvasRenderingContext2D, v: View, mo: Moment) {
  const frames = reduced() ? [mo.lead_up.length - 1] : mo.lead_up.map((_, i) => i);
  for (const f of frames) {
    draw(ctx, v, mo, mo.lead_up[f]!, mo.ball[Math.min(f, mo.ball.length - 1)] ?? null);
    if (frames.length > 1) await sleep(1000 / mo.fps);
  }
}

/** One question of a moment: its step ("1/2"), the question and the hints for the 2D pitch and the 3D view. */
interface Question { step: string; tag: string; tap: string; list: string }
export const Q_YOU: Question = {
  step: "1/2", tag: "What would you do?",
  tap: "Tap a teammate to pass, a yellow chevron to carry, or the goal to shoot.",
  list: "Through the carrier's eyes: tap a teammate, a yellow chevron or the goal (drag to look around), or use the list.",
};
export const Q_PRO: Question = {
  step: "2/2", tag: "What did the pro actually do?",
  tap: "Your pick is locked in. The pro passed here: tap the teammate who got the ball.",
  list: "Your pick is locked in. The pro passed here: tap the receiver (drag to look around), or use the list.",
};

function setHint(ui: RoundUI, q: Question, text: string) {
  ui.hint.innerHTML = "";
  const tag = el("b", "qtag"); tag.append(el("span", "step", q.step), document.createTextNode(q.tag));
  ui.hint.append(tag, document.createTextNode(text));
}

/** Waits for a confirmed choice: tap a target (teammate, carry dot, goal) or a list button, then Confirm.
 * `mo` may be a copy restricted to some options (the second question offers passes only). */
function choose(ui: RoundUI, ctx: CanvasRenderingContext2D, v: View, mo: Moment, q: Question = Q_YOU, last = false): Promise<number> {
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const ball = mo.ball[mo.ball.length - 1] ?? null;
  const targets = optionTargets(v, mo);
  let selected: number | undefined;
  const repaint = () => draw(ctx, v, mo, release, ball, { targets: true, selected });
  repaint();
  // selection feedback: one accent ring expanding from the chosen target (skipped with reduced motion)
  let pulseRaf = 0;
  const pulse = (k: number) => {
    cancelAnimationFrame(pulseRaf);
    const at = targets.find((t) => t.k === k)?.at;
    if (!at || reduced()) return;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 420);
      repaint();
      ctx.save(); ctx.strokeStyle = `rgba(76, 201, 240, ${1 - t})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(at[0], at[1], 10 + 16 * t, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
      if (t < 1 && selected === k) pulseRaf = requestAnimationFrame(step); else repaint();
    };
    pulseRaf = requestAnimationFrame(step);
  };
  ui.list.innerHTML = "";
  const details = el("details", "optlist");
  const sum = el("summary"); setIconText(sum, "list", "Choose from a list"); details.append(sum);
  const ul = el("div", "optgrid");
  details.append(ul);
  ui.list.append(details);
  const said = el("span", "sr-only"); // the selection, read out by the hint's aria-live (shown visually next to Confirm)
  const modeHint = () => { setHint(ui, q, is3D() ? q.list : q.tap); ui.hint.append(said); }; // 3D: tap players in the 3D view (pick3D)
  modeHint();
  on3DChange(modeHint);
  return new Promise((resolve) => {
    const confirm = el("button", "primary", "Confirm");
    confirm.disabled = true;
    const label = el("span", "choice none", "Nothing selected");
    ui.actions.innerHTML = "";
    ui.actions.append(label, confirm);
    const select = (k: number) => {
      selected = k; label.textContent = optionLabel(mo, k); label.classList.remove("none"); confirm.disabled = false; repaint(); pulse(k);
      said.textContent = ` Selected: ${optionLabel(mo, k)}.`;
      for (const b of ul.querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.k) === k);
    };
    pick3D(mo, select); // taps on players / goal / carry chevrons in the 3D view select too
    const rank = { pass: 0, shot: 1, carry: 2 } as const;
    const order = [...mo.options].sort((a, b) => rank[a.kind] - rank[b.kind] || a.k - b.k).map((o) => o.k);
    for (const k of order) {
      const b = el("button", "chip opt", optionLabel(mo, k)); b.dataset.k = String(k); b.onclick = () => select(k); ul.append(b);
    }
    // keyboard: arrows (wrapping) or Tab / Shift+Tab (leaving the pitch past either end) move the selection on the
    // pitch in the list's order, Home / End jump, Enter confirms
    ui.canvas.tabIndex = 0;
    ui.canvas.onkeydown = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let k: number | null;
      switch (e.key) {
        case "ArrowRight": case "ArrowDown": k = stepOption(order, selected, 1); break;
        case "ArrowLeft": case "ArrowUp": k = stepOption(order, selected, -1); break;
        case "Home": k = order[0] ?? null; break;
        case "End": k = order[order.length - 1] ?? null; break;
        case "Tab": k = stepOption(order, selected, e.shiftKey ? -1 : 1, false); if (k === null) return; break;
        case "Enter": if (selected !== undefined) { e.preventDefault(); confirm.click(); } return;
        default: return;
      }
      e.preventDefault();
      if (k !== null) select(k);
    };
    // focus was dropped (the Play / Confirm / Next button just disappeared): continue on the pitch, without scrolling
    const active = document.activeElement as HTMLElement | null;
    const dropped = !active || active === document.body || !active.isConnected || !active.getClientRects().length;
    if (!is3D() && dropped) ui.canvas.focus({ preventScroll: true });
    ui.canvas.onclick = (e) => {
      const r = ui.canvas.getBoundingClientRect();
      const k = hitOption(targets, [e.clientX - r.left, e.clientY - r.top], 26);
      if (k !== null) select(k);
    };
    confirm.onclick = () => {
      if (selected === undefined || confirm.getAttribute("aria-busy") === "true") return;
      cancelAnimationFrame(pulseRaf); repaint();
      ui.canvas.onclick = null; ui.canvas.onkeydown = null; ui.canvas.tabIndex = -1; ui.list.innerHTML = ""; on3DChange(null);
      if (last) { // the answers go to the server now: the button says so (playMoment clears it with the reveal)
        confirm.disabled = true; confirm.setAttribute("aria-busy", "true"); confirm.replaceChildren(spinner(), "Checking…");
        ui.hint.textContent = "Checking your answers…";
      } else { ui.actions.innerHTML = ""; ui.hint.textContent = ""; }
      pick3D(null, null);
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
    draw(ctx, v, mo, a.frames[f]!, a.ball[f] ?? null, { trail: ballTrail(a.ball.slice(0, f + 1), v), balls: a.ball.slice(0, f + 1), dim: true });
    await sleep(1000 / a.fps);
  }
  await sleep(500);
  draw(ctx, v, mo, a.frames[a.frames.length - 1]!, a.ball[a.ball.length - 1] ?? null, { ...arrows, trail: ballTrail(a.ball, v), balls: a.ball, dim: true });
}

const OUTCOME_ICON: Record<PickResult["outcome"]["kind"], IconName> = { goal: "goal", shot: "target", kept: "keep", lost: "lost" };

/** Points count up from 0 (useful feedback: how much this answer is worth); instant with reduced motion. */
function countUp(node: HTMLElement, to: number) {
  node.textContent = String(to);
  if (reduced() || to <= 0) return;
  const t0 = performance.now(), dur = 600;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur), e = 1 - (1 - t) ** 3;
    node.textContent = String(Math.round(to * e));
    if (t < 1) requestAnimationFrame(step);
  };
  node.textContent = "0";
  requestAnimationFrame(step);
}

function renderReveal(ui: RoundUI, mo: Moment, res: PickResult, pick: number, replay: () => void, showAll: () => void) {
  const r = ui.reveal;
  r.innerHTML = ""; r.hidden = false;
  const head = el("p", `points ${tier(res.points)}`);
  const num = el("strong");
  head.append(num, el("span", "", "/100 points"));
  countUp(num, res.points);
  const vd = el("p", "verdict"); vd.append(el("span", "", verdict(res, pick)));
  if (res.pro_instinct) { const pi = el("span", "instinct"); setIconText(pi, "spark", "Picked like the pro"); vd.append(pi); }
  r.append(head, vd);
  const read = proReadLine(mo, res);
  if (read) { const p = el("p", `proread ${read.cls}`); p.append(icon(read.cls === "ok" ? "check" : "eye"), el("span", "", read.text)); r.append(p); }
  const rows = el("div", "rows");
  const row = (cls: string, who: string, k: number) => {
    const d = el("div", `row ${cls}`), what = el("span", "what", optionLabel(mo, k));
    d.append(el("span", "who", who), what);
    rows.append(d);
    return what;
  };
  row("mine", "You", pick);
  row("ai", "AI coach", res.ai_pick);
  const proWhat = row("pro", "The pro", res.pro_pick);
  const out = el("span", "out"); out.append(icon(OUTCOME_ICON[res.outcome.kind]), OUTCOME_TEXT[res.outcome.kind]);
  proWhat.append(document.createElement("br"), out);
  r.append(rows);
  const reasons = res.reasons[res.ai_pick] ?? [];
  if (reasons.length) {
    const why = el("div", "why"); why.append(el("p", "label", "What the AI weighed for its pick"));
    const ul = el("ul", "reasons");
    for (const x of reasons) {
      const li = el("li", x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "value");
      li.append(icon(x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "approx"), el("span", "", x.text));
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
  if (res.after) { const b = el("button", "ghost"); setIconText(b, "replay", "Replay what happened"); b.onclick = replay; tools.append(b); }
  const all = el("button", "ghost", "Every option's score"); all.onclick = showAll; tools.append(all);
  r.append(tools, el("p", "fine", "The AI's ranking is a model opinion, not the truth."));
}

export async function playMoment(ui: RoundUI, mo: Moment, player: string, index: number, total: number, points: number[]): Promise<PickResult> {
  setup3D(ui.canvas); // once: wraps the canvas with the 3D view and its toggle
  const { ctx, v } = setupCanvas(ui.canvas);
  const side = mo.attacking === "home" ? mo.home : mo.away;
  const score = mo.scoreline ? ` ${mo.scoreline[0]}–${mo.scoreline[1]} ` : " – ";
  ui.title.replaceChildren(`${mo.home}${score}${mo.away} · ${mo.minute}' · ${side} attack `, icon("arrowUp"));
  renderDots(ui, points, total);
  ui.reveal.hidden = true; ui.next.hidden = true; ui.actions.innerHTML = ""; ui.list.innerHTML = "";
  ui.hint.textContent = "Watch the build-up…";
  await playLeadUp(ctx, v, mo);
  const passes = mo.options.filter((o) => o.kind === "pass");
  const pick = await choose(ui, ctx, v, mo, Q_YOU, !passes.length);
  // second question, nothing revealed yet: the pro always passed in these moments, so only passes are offered
  const guess = passes.length ? await choose(ui, ctx, v, { ...mo, options: passes }, Q_PRO, true) : null;
  ui.reveal.setAttribute("aria-busy", "true");
  const res = await postPick(player, mo.id, pick, guess).finally(() => { ui.reveal.removeAttribute("aria-busy"); ui.actions.innerHTML = ""; });
  const mine = res.option; // the first answer counts: a replayed moment shows the original pick
  try { navigator.vibrate?.(res.points >= 100 ? [30, 40, 30] : 20); } catch { /* not supported */ }
  ui.hint.textContent = res.after ? "What really happened next:" : "";
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const showAll = () => {
    draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, { ai: res.ai_pick, pro: res.pro_pick, mine, scores: res.all_points });
    ui.hint.textContent = "Points of every option: green 100, yellow 50+, grey below";
  };
  renderReveal(ui, mo, res, mine, () => void playAfter(ctx, v, mo, res, mine), showAll);
  if (res.repeat) ui.reveal.prepend(el("p", "fine", "You already answered this moment: your first answer counts."));
  renderDots(ui, [...points, res.points], total, true);
  await playAfter(ctx, v, mo, res, mine);
  const legend = el("span", "legend");
  legend.append(el("span", "ai", "AI coach"), el("span", "pro", "The pro"), el("span", "mine", "You"));
  ui.hint.replaceChildren(legend);
  return res;
}

/** Called after every answered moment (stats, history). */
export type OnResult = (mo: Moment, res: PickResult, index: number) => void;

/** Shows a skeleton pitch (and aria-busy) while a moment is still downloading; nothing when it is already there. */
async function loading<T>(ui: RoundUI, p: Promise<T>): Promise<T> {
  const ready = await Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 80))]);
  if (ready) return p;
  const c = ui.canvas, game = c.closest("section");
  c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  c.classList.add("skeleton"); game?.setAttribute("aria-busy", "true");
  ui.hint.textContent = "Loading the moment…"; ui.actions.innerHTML = ""; ui.reveal.hidden = true; ui.next.hidden = true;
  try { return await p; } finally { c.classList.remove("skeleton"); game?.removeAttribute("aria-busy"); }
}

export async function playDay(ui: RoundUI, day: Day, player: string, onResult: OnResult = () => {}): Promise<number[]> {
  const points: number[] = [];
  const total = day.moments.length;
  let nextMoment = getMoment(day.moments[0]!);
  for (let i = 0; i < total; i++) {
    const mo = await loading(ui, nextMoment);
    if (i + 1 < total) nextMoment = getMoment(day.moments[i + 1]!); // prefetch while this one is played
    const res = await playMoment(ui, mo, player, i, total, points);
    points.push(res.points); onResult(mo, res, i);
    ui.next.hidden = false;
    if (i < total - 1) setIconText(ui.next, "arrowRight", "Next moment", true); else ui.next.replaceChildren("See my score");
    ui.next.focus();
    await new Promise<void>((r) => (ui.next.onclick = () => r()));
  }
  return points;
}
