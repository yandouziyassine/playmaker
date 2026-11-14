import { getMoment, postPick, type Day, type Moment, type PickResult } from "./api.ts";
import { ballTrail, draw as draw2D, hitOption, optionTargets, stepOption, type View } from "./pitch.ts";
import { optionLabel, outcomeText, pct, progress, proReadLine, tier, verdict } from "./text.ts";
import { lessonsFor, revealLesson, type Lesson } from "./lessons.ts";
import { t, type Key } from "./i18n/index.ts";
import { translatePhrase } from "./i18n/phrases.ts";
import { is3D, on3DChange, paint3D, pick3D, setup3D } from "./view3d/toggle.ts";
import type { Overlay3D as Overlay } from "./view3d/geom.ts";
import { icon, setIconText, spinner, type IconName } from "./design/icons.ts";
import { isOfflineError } from "./offline/pickQueue.ts";
import { clearOfflineReveal, renderOfflineReveal } from "./offline/ui.ts";

type Cm = [number, number] | null;
/** Paints the 2D pitch and mirrors the frame into the 3D view (shown instead of the canvas when 3D is on). */
function draw(ctx: CanvasRenderingContext2D, v: View, mo: Moment, frame: Cm[], ball: Cm, o: Overlay = {}, o3?: Overlay) {
  draw2D(ctx, v, mo, frame, ball, o);
  paint3D(mo, frame, ball, o3 ?? o);
}

export interface RoundUI {
  canvas: HTMLCanvasElement; title: HTMLElement; dots: HTMLElement; hint: HTMLElement; actions: HTMLElement;
  list: HTMLElement; reveal: HTMLElement; next: HTMLButtonElement;
  /** Coach-marks of the guided first moment (first visit only). */
  tour?: Tour | null;
  /** Indexes of moments answered offline (scored later): their progress dot is drawn as pending. */
  pending?: Set<number>;
}

/** One coach-mark of the guided first moment, in order. */
export type TourStep = "carrier" | "tap" | "confirm" | "legend";
export const TOUR_STEPS: readonly TourStep[] = ["carrier", "tap", "confirm", "legend"];

/** Coach-marks for the first moment of a first visit. They sit inline between the pitch and the controls (never over
 * a target or a button), so play never waits on them: taps, the list and the keyboard work as usual and the marks
 * follow along (selecting jumps to "Confirm"). Next / Skip tour / Got it buttons, Escape skips; focus is never
 * taken from the pitch. Finishing or skipping calls onEnd once (the page saves a flag: never shown again). */
export class Tour {
  step: TourStep | null = null;
  started = false;
  ended = false;
  private text: HTMLParagraphElement;
  private count: HTMLParagraphElement;
  private buttons: HTMLDivElement;
  private onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && this.step) { e.preventDefault(); this.end(true); } };

  constructor(readonly host: HTMLElement, private focusAfter: () => HTMLElement | null, private onEnd: () => void) {
    host.hidden = true;
    host.classList.add("coachmark");
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", t("tour.aria"));
    this.count = el("p", "cm-step tnum");
    this.text = el("p", "cm-text");
    this.text.setAttribute("aria-live", "polite");
    this.buttons = el("div", "cm-actions");
    host.replaceChildren(this.count, this.text, this.buttons);
  }

  show(step: TourStep) {
    if (this.ended) return;
    if (!this.started) { this.started = true; document.addEventListener("keydown", this.onKey); }
    this.step = step;
    this.host.dataset.step = step;
    this.count.textContent = t("tour.step", { i: TOUR_STEPS.indexOf(step) + 1, n: TOUR_STEPS.length });
    this.text.textContent = t(`tour.${step}`);
    const btn = (key: "tour.next" | "tour.skip" | "tour.done", cls: string, fn: () => void) => {
      const b = el("button", cls, t(key)); b.type = "button"; b.onclick = fn; return b;
    };
    const skip = btn("tour.skip", "quiet", () => this.end(true));
    this.buttons.replaceChildren(
      ...(step === "carrier" ? [skip, btn("tour.next", "ghost", () => { this.show("tap"); this.refocus(); })]
        : step === "legend" ? [btn("tour.done", "ghost", () => this.end(true))]
        : [skip]),
    );
    this.host.hidden = false;
  }

  /** Between marks (second question, the server's answer): out of the way, the tour goes on after the reveal. */
  hide() { this.step = null; this.host.hidden = true; }

  /** Completed or skipped: never again. `byButton`: focus moves on (the button that had it is gone). */
  end(byButton = false) {
    if (this.ended) return;
    this.ended = true; this.step = null; this.host.hidden = true;
    document.removeEventListener("keydown", this.onKey);
    this.onEnd();
    if (byButton) this.refocus();
  }

  private refocus() {
    const a = document.activeElement;
    if (a && a !== document.body && this.host.contains(a) && a.isConnected && (a as HTMLElement).offsetParent) return;
    this.focusAfter()?.focus({ preventScroll: true });
  }
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
  progress(points, total).forEach((state, i) => ui.dots.append(el("span", `dot ${ui.pending?.has(i) ? "pending" : state}${just && i === points.length - 1 ? " just" : ""}`)));
  ui.dots.setAttribute("aria-label", t("game.dots", { done: points.length, total }));
}

async function playLeadUp(ctx: CanvasRenderingContext2D, v: View, mo: Moment) {
  const frames = reduced() ? [mo.lead_up.length - 1] : mo.lead_up.map((_, i) => i);
  for (const f of frames) {
    draw(ctx, v, mo, mo.lead_up[f]!, mo.ball[Math.min(f, mo.ball.length - 1)] ?? null);
    if (frames.length > 1) await sleep(1000 / mo.fps);
  }
}

/** One question of a moment: its step ("1/2"), the question and the hints for the 2D pitch and the 3D view. */
interface Question { step: string; tag: Key; tap: Key; list: Key }
export const Q_YOU: Question = { step: "1/2", tag: "q.you.tag", tap: "q.you.tap", list: "q.you.list" };
export const Q_PRO: Question = { step: "2/2", tag: "q.pro.tag", tap: "q.pro.tap", list: "q.pro.list" };

function setHint(ui: RoundUI, q: Question, text: Key) {
  ui.hint.innerHTML = "";
  const tag = el("b", "qtag"); tag.append(el("span", "step", q.step), document.createTextNode(t(q.tag)));
  ui.hint.append(tag, document.createTextNode(t(text)));
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
  const sum = el("summary"); setIconText(sum, "list", t("choose.list")); details.append(sum);
  const ul = el("div", "optgrid");
  details.append(ul);
  ui.list.append(details);
  const said = el("span", "sr-only"); // the selection, read out by the hint's aria-live (shown visually next to Confirm)
  const modeHint = () => { setHint(ui, q, is3D() ? q.list : q.tap); ui.hint.append(said); }; // 3D: tap players in the 3D view (pick3D)
  modeHint();
  on3DChange(modeHint);
  const tour = q === Q_YOU ? ui.tour : null;
  if (tour && !tour.started) tour.show("carrier");
  return new Promise((resolve) => {
    const confirm = el("button", "primary", t("choose.confirm"));
    confirm.disabled = true;
    const label = el("span", "choice none", t("choose.none"));
    ui.actions.innerHTML = "";
    ui.actions.append(label, confirm);
    const select = (k: number) => {
      selected = k; label.textContent = optionLabel(mo, k); label.classList.remove("none"); confirm.disabled = false; repaint(); pulse(k);
      said.textContent = t("choose.selected", { label: optionLabel(mo, k) });
      if (tour && (tour.step === "carrier" || tour.step === "tap")) tour.show("confirm");
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
      if (tour?.step) tour.hide();
      ui.canvas.onclick = null; ui.canvas.onkeydown = null; ui.canvas.tabIndex = -1; ui.list.innerHTML = ""; on3DChange(null);
      if (last) { // the answers go to the server now: the button says so (playMoment clears it with the reveal)
        confirm.disabled = true; confirm.setAttribute("aria-busy", "true"); confirm.replaceChildren(spinner(), t("choose.checking"));
        ui.hint.textContent = t("choose.checkingAnswers");
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
    const balls = a.ball.slice(0, f + 1);
    // 3D: the arrows stay and fade out, the camera follows the ball (view3d/view.ts, overlay.replay)
    draw(ctx, v, mo, a.frames[f]!, a.ball[f] ?? null, { trail: ballTrail(balls, v), balls, dim: true },
      { ...arrows, balls, dim: true, replay: a.frames.length > 1 ? f / (a.frames.length - 1) : 1 });
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

/** The Coach's note in the reveal: one lesson, its skill, the facts behind it in a collapsed "Why?". */
export function lessonCard(l: Lesson): HTMLElement {
  const card = el("div", `lesson skill-${l.skill}`);
  const head = el("p", "lhead");
  const lab = el("span", "llabel"); setIconText(lab, "coach", t("lesson.label"));
  head.append(lab, el("span", "lskill", t(`skill.${l.skill}`)));
  card.append(head, el("p", "ltitle", l.title), el("p", "lbody", l.body));
  if (l.evidence.length) {
    const why = el("details", "lwhy");
    why.append(el("summary", "", t("lesson.why")));
    const ul = el("ul", "reasons");
    for (const x of l.evidence) {
      const li = el("li", x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "value");
      li.append(icon(x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "approx"), el("span", "", x.text));
      ul.append(li);
    }
    why.append(ul); card.append(why);
  }
  return card;
}

function renderReveal(ui: RoundUI, mo: Moment, res: PickResult, pick: number, replay: () => void, showAll: () => void, lesson: Lesson | null = null) {
  const r = ui.reveal;
  r.innerHTML = ""; r.hidden = false;
  const head = el("p", `points ${tier(res.points)}`);
  const num = el("strong");
  head.append(num, el("span", "", t("reveal.points")));
  countUp(num, res.points);
  const vd = el("p", "verdict"); vd.append(el("span", "", verdict(res, pick)));
  if (res.pro_instinct) { const pi = el("span", "instinct"); setIconText(pi, "spark", t("reveal.instinct")); vd.append(pi); }
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
  row("mine", t("who.you"), pick);
  row("ai", t("who.ai"), res.ai_pick);
  const proWhat = row("pro", t("who.pro"), res.pro_pick);
  const out = el("span", "out"); out.append(icon(OUTCOME_ICON[res.outcome.kind]), outcomeText(res.outcome.kind));
  proWhat.append(document.createElement("br"), out);
  r.append(rows);
  if (lesson) r.append(lessonCard(lesson));
  const reasons = res.reasons[res.ai_pick] ?? [];
  if (reasons.length) {
    const why = el("div", "why"); why.append(el("p", "label", t("reveal.why")));
    const ul = el("ul", "reasons");
    for (const x of reasons) {
      const li = el("li", x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "value");
      li.append(icon(x.effect > 0 ? "plus" : x.effect < 0 ? "minus" : "approx"), el("span", "", translatePhrase(x.text)));
      ul.append(li);
    }
    why.append(ul); r.append(why);
  }
  if (res.crowd) {
    const crowd = el("div", "crowd"); crowd.append(el("p", "label", t("reveal.crowd")));
    const bar = (name: string, share: number, cls: string) => {
      const b = el("div", "bar"); const fill = el("span", `fill ${cls}`); fill.style.width = pct(share);
      b.append(el("span", "name", name), fill, el("span", "val", pct(share))); crowd.append(b);
    };
    bar(t("crowd.yours"), res.crowd[pick] ?? 0, "mine");
    if (res.ai_pick !== pick) bar(t("crowd.ai"), res.crowd[res.ai_pick] ?? 0, "ai");
    r.append(crowd);
  } else {
    r.append(el("p", "fine", t("crowd.none")));
  }
  const tools = el("div", "tools");
  if (res.after) { const b = el("button", "ghost"); setIconText(b, "replay", t("reveal.replay")); b.onclick = replay; tools.append(b); }
  const all = el("button", "ghost", t("reveal.all")); all.onclick = showAll; tools.append(all);
  r.append(tools, el("p", "fine", t("reveal.opinion")));
}

/** An answer that could not reach the server (offline): the page queues it and it is scored later. */
export type OnOffline = (mo: Moment, option: number, guess: number | null, index: number) => void;

/** Resolves null when the answer was saved offline (only with `onOffline`; without it a network error throws). */
/** `seen`: lesson ids already shown today (the reveal prefers a new one; app/src/lessons.ts revealLesson). */
export async function playMoment(ui: RoundUI, mo: Moment, player: string, index: number, total: number, points: number[], onOffline?: OnOffline, seen: Set<string> = new Set()): Promise<PickResult | null> {
  setup3D(ui.canvas); // once: wraps the canvas with the 3D view and its toggle
  if (ui.tour?.started && !ui.tour.ended) ui.tour.end(); // moved on without "Got it": the tour is done
  if (ui.tour && !ui.tour.ended && ui.tour.host.parentElement !== ui.canvas.parentElement) ui.canvas.parentElement?.append(ui.tour.host); // over the pitch's bottom edge
  const { ctx, v } = setupCanvas(ui.canvas);
  const side = mo.attacking === "home" ? mo.home : mo.away;
  const score = mo.scoreline ? ` ${mo.scoreline[0]}–${mo.scoreline[1]} ` : " – ";
  ui.title.replaceChildren(t("game.title", { home: mo.home, score, away: mo.away, minute: mo.minute, side }), icon("arrowUp"));
  renderDots(ui, points, total);
  ui.reveal.hidden = true; ui.next.hidden = true; ui.actions.innerHTML = ""; ui.list.innerHTML = "";
  ui.hint.textContent = t("game.watch");
  await playLeadUp(ctx, v, mo);
  const passes = mo.options.filter((o) => o.kind === "pass");
  const pick = await choose(ui, ctx, v, mo, Q_YOU, !passes.length);
  // second question, nothing revealed yet: the pro always passed in these moments, so only passes are offered
  const guess = passes.length ? await choose(ui, ctx, v, { ...mo, options: passes }, Q_PRO, true) : null;
  ui.reveal.setAttribute("aria-busy", "true");
  clearOfflineReveal(ui.reveal);
  let res: PickResult;
  try {
    res = await postPick(player, mo.id, pick, guess).finally(() => { ui.reveal.removeAttribute("aria-busy"); ui.actions.innerHTML = ""; });
  } catch (e) {
    if (!onOffline || !isOfflineError(e)) throw e;
    // offline: the answer is queued; no server data to reveal, the day goes on
    onOffline(mo, pick, guess, index);
    (ui.pending ??= new Set()).add(index);
    draw(ctx, v, mo, mo.lead_up[mo.lead_up.length - 1]!, mo.ball[mo.ball.length - 1] ?? null, { mine: pick });
    ui.hint.textContent = "";
    renderOfflineReveal(ui.reveal, optionLabel(mo, pick));
    renderDots(ui, [...points, 0], total, true);
    return null;
  }
  const mine = res.option; // the first answer counts: a replayed moment shows the original pick
  try { navigator.vibrate?.(res.points >= 100 ? [30, 40, 30] : 20); } catch { /* not supported */ }
  ui.hint.textContent = res.after ? t("reveal.after") : "";
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const showAll = () => {
    draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, { ai: res.ai_pick, pro: res.pro_pick, mine, scores: res.all_points });
    ui.hint.textContent = t("reveal.allHint");
  };
  let lesson: Lesson | null = null;
  try { lesson = revealLesson(lessonsFor(mo, res, (k) => optionLabel(mo, k)), seen); } catch { /* the note is a bonus */ }
  renderReveal(ui, mo, res, mine, () => void playAfter(ctx, v, mo, res, mine), showAll, lesson);
  if (res.repeat) ui.reveal.prepend(el("p", "fine", t("reveal.repeat")));
  renderDots(ui, [...points, res.points], total, true);
  await playAfter(ctx, v, mo, res, mine);
  const legend = el("span", "legend");
  legend.append(el("span", "ai", t("who.ai")), el("span", "pro", t("who.pro")), el("span", "mine", t("who.you")));
  ui.hint.replaceChildren(legend);
  if (ui.tour?.started && !ui.tour.ended) ui.tour.show("legend");
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
  ui.hint.textContent = t("game.loading"); ui.actions.innerHTML = ""; ui.reveal.hidden = true; ui.next.hidden = true;
  try { return await p; } finally { c.classList.remove("skeleton"); game?.removeAttribute("aria-busy"); }
}

/** `onOffline`: answers that cannot reach the server are handed over (queued by the page) and count 0 points for now
 * (their index is in ui.pending); without it a network error stops the day, as before. */
export async function playDay(ui: RoundUI, day: Day, player: string, onResult: OnResult = () => {}, onOffline?: OnOffline): Promise<number[]> {
  const points: number[] = [];
  ui.pending = new Set();
  const seen = new Set<string>(); // lesson ids shown today
  const total = day.moments.length;
  let nextMoment = getMoment(day.moments[0]!);
  for (let i = 0; i < total; i++) {
    const mo = await loading(ui, nextMoment);
    if (i + 1 < total) nextMoment = getMoment(day.moments[i + 1]!); // prefetch while this one is played
    const res = await playMoment(ui, mo, player, i, total, points, onOffline, seen);
    if (res) { points.push(res.points); onResult(mo, res, i); } else points.push(0); // offline: scored later
    ui.next.hidden = false;
    if (i < total - 1) setIconText(ui.next, "arrowRight", t("game.next"), true); else ui.next.replaceChildren(t("game.seeScore"));
    ui.next.focus();
    await new Promise<void>((r) => (ui.next.onclick = () => r()));
  }
  return points;
}
