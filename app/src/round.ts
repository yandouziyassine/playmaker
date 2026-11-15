import { getMoment, postPick, type Day, type Moment, type PickResult } from "./api.ts";
import { COLORS, ballTrail, draw as draw2D, fitView, hitOption, momentFocus, optionTargets, stepOption, type View } from "./pitch.ts";
import { optionLabel, outcomeText, pct, progress, proReadLine, tier, verdict } from "./text.ts";
import { lessonsFor, revealLesson, valuesOf, type Lesson } from "./lessons.ts";
import { pct as pctI18n, t, xg, type Key } from "./i18n/index.ts";
import { translatePhrase } from "./i18n/phrases.ts";
import { is3D, on3DChange, paint3D, pick3D, setup3D } from "./view3d/toggle.ts";
import type { Overlay3D as Overlay } from "./view3d/geom.ts";
import type { Analysis3D, AnalysisOption } from "./view3d/analysis.ts";
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
  /** The answered moment's points, verdict and pro read (shown above the pitch during the reveal). */
  score?: HTMLElement;
  /** "2/5" next to the scoreboard. */
  count?: HTMLElement;
  /** Scores the answers instead of POST /api/pick (training: app/src/training.ts trainPick). */
  pick?: (mo: Moment, option: number, guess: number | null) => Promise<PickResult>;
  /** Training: no day, so no progress bar (the page draws its own running HUD). */
  training?: boolean;
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

/** Sizes the canvas to its CSS box; the view fits the whole pitch, or crops its length around `focus` when the box is
 *  too short for it (pitch.ts fitView). */
function setupCanvas(canvas: HTMLCanvasElement, focus: { must: number[]; nice: number[] } = { must: [], nice: [] }): { ctx: CanvasRenderingContext2D; v: View } {
  const v: View = fitView(canvas.clientWidth, canvas.clientHeight, focus.must, focus.nice);
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
  if (ui.training) return;
  ui.dots.innerHTML = "";
  progress(points, total).forEach((state, i) => ui.dots.append(el("span", `dot ${ui.pending?.has(i) ? "pending" : state}${just && i === points.length - 1 ? " just" : ""}`)));
  ui.dots.setAttribute("aria-label", t("game.dots", { done: points.length, total }));
  if (ui.count) ui.count.textContent = `${Math.min(points.length + (just ? 0 : 1), total)}/${total}`;
}

/** Scoreboard HUD: home – away (the score only when the moment has it), the minute; your team's tag is red with an
 *  arrow (it attacks up the screen). The full sentence is the accessible text; the board itself is decorative. */
function renderHud(ui: RoundUI, mo: Moment) {
  const side = mo.attacking === "home" ? mo.home : mo.away;
  const score = mo.scoreline ? ` ${mo.scoreline[0]}–${mo.scoreline[1]} ` : " – ";
  const board = el("span", "board"); board.setAttribute("aria-hidden", "true");
  const team = (name: string, atk: boolean) => {
    const s = el("span", `team${atk ? " atk" : ""}`, name); s.title = name;
    if (atk) s.append(icon("arrowUp"));
    return s;
  };
  board.append(team(mo.home, mo.attacking === "home"));
  if (mo.scoreline) board.append(el("span", "sc", `${mo.scoreline[0]}–${mo.scoreline[1]}`));
  board.append(team(mo.away, mo.attacking === "away"), el("span", "min", `${mo.minute}'`));
  ui.title.replaceChildren(el("span", "sr-only", t("game.title", { home: mo.home, score, away: mo.away, minute: mo.minute, side })), board);
}

async function playLeadUp(ctx: CanvasRenderingContext2D, v: View, mo: Moment) {
  const frames = reduced() ? [mo.lead_up.length - 1] : mo.lead_up.map((_, i) => i);
  for (const f of frames) {
    draw(ctx, v, mo, mo.lead_up[f]!, mo.ball[Math.min(f, mo.ball.length - 1)] ?? null);
    if (frames.length > 1) await sleep(1000 / mo.fps);
  }
}

/** One question of a moment: its step ("1/2"), the question and the hints for the 2D pitch and the 3D view. */
interface Question { step: number; tag: Key; tap: Key; list: Key }
export const Q_YOU: Question = { step: 1, tag: "q.you.tag", tap: "q.you.tap", list: "q.you.list" };
export const Q_PRO: Question = { step: 2, tag: "q.pro.tag", tap: "q.pro.tap", list: "q.pro.list" };

/** "QUESTION 1 OF 2 · WHAT WOULD YOU DO?" over the instruction. */
function setHint(ui: RoundUI, q: Question, text: Key) {
  ui.hint.innerHTML = "";
  const tag = el("b", "qtag"); tag.append(el("span", "step", t("q.step", { i: q.step, n: 2 })), document.createTextNode(t(q.tag)));
  ui.hint.append(tag, el("span", "ask", t(text)));
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

/** The reveal's analysis for the 3D view: the AI's pick, the pro's and yours (one tab each, merged when they are the
 *  same option) with the coach's completion chance and net xG (answer file), the value if it arrives / is lost (the
 *  coach's own value phrase) and its reasons. The 2D pitch keeps its arrows. */
export function revealAnalysis(mo: Moment, res: PickResult, pick: number): Analysis3D {
  const roles: { k: number; tag: string; color: string }[] = [];
  for (const r of [{ k: res.ai_pick, tag: t("who.ai"), color: COLORS.ai }, { k: res.pro_pick, tag: t("who.pro"), color: COLORS.pro }, { k: pick, tag: t("who.you"), color: COLORS.mine }]) {
    const same = roles.find((x) => x.k === r.k);
    if (same) same.tag += ` · ${r.tag}`; else roles.push({ ...r });
  }
  const options = roles.flatMap((r): AnalysisOption[] => {
    const o = mo.options.find((q) => q.k === r.k);
    if (!o) return [];
    const reasons = res.reasons[r.k] ?? [], vals = valuesOf(reasons), c = res.coach?.[r.k];
    const shirt = o.player !== undefined ? mo.players[o.player]?.shirt : undefined;
    return [{
      k: r.k, tag: r.tag, color: r.color,
      tab: o.kind === "pass" ? t("an.tabPass", { shirt: shirt ?? "?" }) : o.kind === "carry" ? t("an.tabCarry") : t("an.tabShot"),
      title: optionLabel(mo, r.k), p: c?.p, score: c?.score, gain: o.kind === "shot" ? undefined : vals.gain, loss: o.kind === "shot" ? undefined : vals.loss,
      reasons: reasons.map((x) => ({ text: translatePhrase(x.text), sign: x.effect })),
    }];
  });
  return { key: `day:${mo.id}`, options, focus: 0 };
}

async function playAfter(ctx: CanvasRenderingContext2D, v: View, mo: Moment, res: PickResult, pick: number, analysis?: Analysis3D) {
  const a = res.after;
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const arrows: Overlay = { ai: res.ai_pick, pro: res.pro_pick, mine: pick };
  const arrows3: Overlay = { ...arrows, analysis };
  draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, arrows, arrows3);
  if (!a || reduced()) return;
  await sleep(1400);
  for (let f = 0; f < a.frames.length; f++) {
    const balls = a.ball.slice(0, f + 1);
    // 3D: the arrows stay and fade out, the camera follows the ball (view3d/view.ts, overlay.replay)
    draw(ctx, v, mo, a.frames[f]!, a.ball[f] ?? null, { trail: ballTrail(balls, v), balls, dim: true },
      { ...arrows3, balls, dim: true, replay: a.frames.length > 1 ? f / (a.frames.length - 1) : 1 });
    await sleep(1000 / a.fps);
  }
  await sleep(500);
  draw2D(ctx, v, mo, a.frames[a.frames.length - 1]!, a.ball[a.ball.length - 1] ?? null, { ...arrows, trail: ballTrail(a.ball, v), dim: true });
  // 3D: with the analysis, back to the decision (its arcs, lane and rings are about the release frame); else as 2D
  if (analysis) paint3D(mo, release, mo.ball[mo.ball.length - 1] ?? null, arrows3);
  else paint3D(mo, a.frames[a.frames.length - 1]!, a.ball[a.ball.length - 1] ?? null, { ...arrows, balls: a.ball, dim: true });
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

/** The reveal. Above the pitch (ui.score, or the top of the reveal without it): the points, the verdict and the pro
 * read. Under the pitch: you / the AI coach / the pro with each option's points, the Coach's note, what the AI weighed,
 * the crowd and the replay tools. */
function renderReveal(ui: RoundUI, mo: Moment, res: PickResult, pick: number, replay: () => void, showAll: () => void, lesson: Lesson | null = null) {
  const r = ui.reveal;
  r.innerHTML = ""; r.hidden = false;
  const top = ui.score ?? r;
  if (ui.score) { ui.score.innerHTML = ""; ui.score.hidden = false; }
  const main = el("div", "shmain");
  const head = el("p", `points ${tier(res.points)}`);
  const num = el("strong");
  head.append(num, el("span", "", t("reveal.points")));
  countUp(num, res.points);
  const vd = el("p", "verdict"); vd.append(el("span", "", verdict(res, pick)));
  if (res.pro_instinct) { const pi = el("span", "instinct"); setIconText(pi, "spark", t("reveal.instinct")); vd.append(pi); }
  main.append(head, vd);
  top.append(main);
  const read = proReadLine(mo, res);
  if (read) { const p = el("p", `proread ${read.cls}`); p.append(icon(read.cls === "ok" ? "check" : "eye"), el("span", "", read.text)); top.append(p); }
  const rows = el("ul", "rows");
  // the coach's numbers for an option, when the answer has them: "arrives 86 % · +0.031 xG"
  const nums = (k: number): string | null => {
    const c = res.coach?.[k], kind = mo.options.find((o) => o.k === k)?.kind;
    if (!c) return null;
    const chance = kind === "pass" ? t("an.arrives") : kind === "carry" ? t("an.keeps") : t("an.goal");
    return `${pctI18n(c.p)} ${chance} · ${xg(c.score)}`;
  };
  const row = (cls: string, who: string, k: number, sub: Node | string | null) => {
    const li = el("li", `row ${cls}`), what = el("span", "what");
    what.append(el("b", "", `${who} · ${optionLabel(mo, k)}`));
    const n = nums(k);
    if (n) what.append(el("span", "sub tnum", n));
    if (sub) { const sp = el("span", "sub"); sp.append(sub); what.append(sp); }
    const pts = el("span", "pts", String(res.all_points[k] ?? (k === pick ? res.points : "–")));
    pts.append(el("small", "", "/100"));
    li.append(el("span", "sw"), what, pts);
    rows.append(li);
  };
  row("mine", t("who.you"), pick, pick === res.ai_pick ? t("verdict.same") : pick === res.pro_pick ? t("reveal.samePro") : null);
  const reasons = res.reasons[res.ai_pick] ?? [];
  const lead = reasons.find((x) => x.effect > 0) ?? reasons[0]; // what most helped the AI's pick
  row("ai", t("who.ai"), res.ai_pick, lead ? translatePhrase(lead.text) : null);
  const out = document.createDocumentFragment(); out.append(icon(OUTCOME_ICON[res.outcome.kind]), outcomeText(res.outcome.kind));
  row("pro", t("who.pro"), res.pro_pick, out);
  r.append(rows, el("p", "revnote", `${t("reveal.rowsNote")} ${t("reveal.opinion")}`));
  const tools = el("div", "tools");
  if (res.after) { const b = el("button", "ghost"); setIconText(b, "replay", t("reveal.replay")); b.onclick = replay; tools.append(b); }
  const all = el("button", "ghost", t("reveal.all")); all.onclick = showAll; tools.append(all);
  r.append(tools);
  if (lesson) r.append(lessonCard(lesson));
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
  } else if (import.meta.env.VITE_DEMO !== "1") { // the static demo has no server, so no crowd: say nothing there
    r.append(el("p", "fine crowdnone", t("crowd.none")));
  }
}

/** An answer that could not reach the server (offline): the page queues it and it is scored later. */
export type OnOffline = (mo: Moment, option: number, guess: number | null, index: number) => void;

/** Resolves null when the answer was saved offline (only with `onOffline`; without it a network error throws). */
/** `seen`: lesson ids already shown today (the reveal prefers a new one; app/src/lessons.ts revealLesson). */
export async function playMoment(ui: RoundUI, mo: Moment, player: string, index: number, total: number, points: number[], onOffline?: OnOffline, seen: Set<string> = new Set()): Promise<PickResult | null> {
  setup3D(ui.canvas); // once: wraps the canvas with the 3D view and its toggle
  if (ui.tour?.started && !ui.tour.ended) ui.tour.end(); // moved on without "Got it": the tour is done
  if (ui.tour && !ui.tour.ended && ui.tour.host.parentElement !== ui.canvas.parentElement) ui.canvas.parentElement?.append(ui.tour.host); // over the pitch's bottom edge
  const game = ui.canvas.closest("section");
  game?.removeAttribute("data-phase");
  if (ui.score) { ui.score.hidden = true; ui.score.innerHTML = ""; }
  let { ctx, v } = setupCanvas(ui.canvas, momentFocus(mo));
  renderHud(ui, mo);
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
    res = await (ui.pick ? ui.pick(mo, pick, guess) : postPick(player, mo.id, pick, guess)).finally(() => { ui.reveal.removeAttribute("aria-busy"); ui.actions.innerHTML = ""; });
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
  // the reveal: a shorter pitch (CSS, data-phase) cropped around the carrier, the three picks and the ball's path
  game?.setAttribute("data-phase", "reveal");
  const f = momentFocus(mo, [mine, res.ai_pick, res.pro_pick]);
  const path = (res.after?.ball ?? []).filter((b): b is [number, number] => !!b).map((b) => b[0] / 100);
  ({ ctx, v } = setupCanvas(ui.canvas, { must: f.must, nice: [...f.nice, ...path] }));
  try { navigator.vibrate?.(res.points >= 100 ? [30, 40, 30] : 20); } catch { /* not supported */ }
  ui.hint.textContent = res.after ? t("reveal.after") : "";
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  let analysis: Analysis3D | undefined;
  try { analysis = revealAnalysis(mo, res, mine); } catch { /* the 3D analysis is a bonus */ }
  const showAll = () => {
    const o: Overlay = { ai: res.ai_pick, pro: res.pro_pick, mine, scores: res.all_points };
    draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, o, { ...o, analysis });
    ui.hint.textContent = t("reveal.allHint");
  };
  let lesson: Lesson | null = null;
  try { lesson = revealLesson(lessonsFor(mo, res, (k) => optionLabel(mo, k)), seen); } catch { /* the note is a bonus */ }
  renderReveal(ui, mo, res, mine, () => void playAfter(ctx, v, mo, res, mine, analysis), showAll, lesson);
  if (res.repeat) ui.reveal.prepend(el("p", "fine", t("reveal.repeat")));
  renderDots(ui, [...points, res.points], total, true);
  await playAfter(ctx, v, mo, res, mine, analysis);
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
