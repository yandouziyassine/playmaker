// Free play: the coach at a paused frame and what the pro did next. advice from app/src/coach (parity-tested port);
// proChoice / outcome ported from the portfolio site's src/lib/coach/decision.ts. Pure functions of the match data.
import { options, valueAt, type Coach, type CoachOption } from "../coach/advice.ts";
import { explainOptions } from "../coach/explain.ts";
import type { State } from "../coach/features.ts";
import { HALF_LENGTH, normalise, type Vec } from "../coach/geometry.ts";
import type { ModelsJson } from "../coach/models.ts";
import { pct as pctI18n, t, xg } from "../i18n/index.ts";

/** The page's localised number helpers (English output identical to coach/picture.ts). */
const pct = (p: number) => pctI18n(p);
const signedXg = (x: number) => xg(x);
/** Carry angle in the normalised frame: > 0 is to the carrier's left. */
const carryDirection = (angle: number) => {
  const a = Math.round(angle);
  return a === 0 ? t("rp.straight") : t(a > 0 ? "rp.left" : "rp.right", { a: Math.abs(a) });
};
import { ballAt, carrierAt, eventFrame, nearestCarrierFrame, playerAt, stateAt, type Carrier, type HalfData, type MatchEvent, type MatchMeta, type PlayerInfo } from "./data.ts";

export interface Reason { text: string; sign: number }
export interface RankedOption { option: CoachOption; reasons: Reason[]; /** end point in raw tracking metres */ to: Vec }
export interface FrameAdvice { half: number; frame: number; carrier: Carrier; state: State; row: number; vNow: number; ranked: RankedOption[] }

/** Raw tracking metres of an option's end point: the target's position for a pass, the carry point, the goal mouth. */
export function optionEnd(o: CoachOption, s: State): Vec {
  const p: Vec = o.kind === "pass" ? (s.att[s.attIdx.indexOf(o.target ?? -1)] ?? o.to) : o.kind === "shot" ? [HALF_LENGTH, 0] : o.to;
  return normalise(p, s.direction); // the 180° turn is its own inverse
}

/** Every option of the carrier at this exact frame, best first, with reasons; null when nobody has the ball. */
export function adviceAt(m: MatchMeta, half: number, h: HalfData, frame: number, coach: Coach, models: ModelsJson): FrameAdvice | null {
  const carrier = carrierAt(m, half, h, frame);
  if (!carrier) return null;
  const state = stateAt(m, half, h, frame, carrier.team);
  const row = state.attIdx.indexOf(carrier.player);
  if (row < 0 || !state.def.length) return null;
  const opts = options(state, row, coach);
  const vNow = valueAt(coach, state.att[row]!);
  const why = explainOptions(state, row, opts, models, vNow, coach.pc);
  const ranked = opts.map((option, i) => ({
    option, to: optionEnd(option, state),
    reasons: why[i]!.phrases.map((text, k) => ({ text, sign: why[i]!.signs[k] ?? 0 })),
  }));
  return { half, frame, carrier, state, row, vNow, ranked };
}

/** Pause logic: the frame itself when someone has the ball there, else the nearest such frame within 2 s, else null. */
export const snapFrame = (m: MatchMeta, half: number, h: HalfData, frame: number): number | null =>
  carrierAt(m, half, h, frame) ? frame : nearestCarrierFrame(m, half, h, frame);

// ---------- what the pro did ----------
export const REVEAL_S = 10;    // the pro's choice: his next pass or shot, at most this long after the pause
export const OUTCOME_S = 15;   // the outcome window (the value model's horizon)
export const LOST_S = 1;       // the opponent must hold the ball this long to count as "lost"
export const BALL_AFTER_S = 1; // failed pass: the intended teammate is the one nearest the ball this long after release
export const CARRY_LOOK_S = 2; // a carry's direction: the carrier's movement over this time
export const MIN_CARRY_M = 1;  // moving less than this is "held the ball"

export type ProKind = "pass" | "shot" | "carry" | "hold";
export interface ProChoice { kind: ProKind; revealFrame: number; option: CoachOption | null; recipient: number | null; success: boolean | null; approx: boolean }
export type Outcome = "goal" | "shot" | "lost" | "kept";

function nearest(opts: CoachOption[], kind: CoachOption["kind"], dist: (o: CoachOption) => number): CoachOption | null {
  let best: CoachOption | null = null;
  for (const o of opts) if (o.kind === kind && (best === null || dist(o) < dist(best))) best = o;
  return best;
}

export function proChoice(m: MatchMeta, half: number, h: HalfData, frame: number, carrier: Carrier, opts: CoachOption[]): ProChoice {
  const fps = m.fps, last = m.halves[half]!.frames - 1, dir = m.halves[half]!.attack[carrier.team]!;
  const horizon = Math.min(last, frame + Math.round(REVEAL_S * fps));
  let next: { e: MatchEvent; f: number } | null = null;
  for (const e of m.events) {
    const f = eventFrame(e);
    if (e.half !== half || f === null || f < frame || f > horizon) continue;
    if (!next || f < next.f) next = { e, f };
  }
  if (next && next.e.player === carrier.player) {
    const { e, f } = next, base = { revealFrame: f, approx: e.frame === null };
    if (e.type === "shot") return { ...base, kind: "shot", option: opts.find((o) => o.kind === "shot") ?? null, recipient: null, success: e.goal ?? null };
    if (e.success && e.recipient != null && m.players[e.recipient]?.team === carrier.team)
      return { ...base, kind: "pass", option: opts.find((o) => o.kind === "pass" && o.target === e.recipient) ?? null, recipient: e.recipient, success: true };
    // a failed pass: the recorded recipient is the opponent who won the ball, so the intended teammate is inferred
    const ball = ballAt(h, Math.min(last, f + Math.round(BALL_AFTER_S * fps)));
    const end = ball ? normalise(ball, dir) : null;
    const option = end ? nearest(opts, "pass", (o) => Math.hypot(o.to[0] - end[0], o.to[1] - end[1])) : null;
    return { ...base, kind: "pass", option, recipient: e.recipient ?? null, success: false };
  }
  const revealFrame = next ? next.f : horizon;
  const hold: ProChoice = { kind: "hold", revealFrame, option: null, recipient: null, success: null, approx: false };
  const a = playerAt(h, frame, carrier.player);
  const b = playerAt(h, Math.min(revealFrame, frame + Math.round(CARRY_LOOK_S * fps)), carrier.player);
  if (!a || !b) return hold;
  const d = normalise([b[0] - a[0], b[1] - a[1]], dir);
  if (Math.hypot(d[0], d[1]) < MIN_CARRY_M) return hold;
  const angle = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  return { ...hold, kind: "carry", option: nearest(opts, "carry", (o) => Math.abs((o.angle ?? 0) - angle)) };
}

export function outcome(m: MatchMeta, half: number, frame: number, team: number): Outcome {
  const end = Math.min(m.halves[half]!.frames - 1, frame + Math.round(OUTCOME_S * m.fps));
  const shots = m.events.filter((e) => {
    const f = eventFrame(e);
    return e.type === "shot" && e.half === half && e.team === team && f !== null && f >= frame && f <= end;
  });
  if (shots.some((e) => e.goal)) return "goal";
  if (shots.length) return "shot";
  const opp = String(2 - team), need = Math.round(LOST_S * m.fps), owner = m.owner[half] ?? "";
  for (let f = frame + 1, run = 0; f <= end; f++) {
    run = owner[f] === opp ? run + 1 : 0;
    if (run >= need) return "lost";
  }
  return "kept";
}

// ---------- text ----------
const who = (players: PlayerInfo[], i: number | null | undefined) => {
  const p = i == null ? undefined : players[i];
  return p ? `#${p.shirt} ${p.name}` : t("rp.teammate");
};

export function optionTitle(o: CoachOption, players: PlayerInfo[]): string {
  if (o.kind === "pass") return t("rp.pass", { who: who(players, o.target) });
  if (o.kind === "carry") return t("rp.carry", { dir: carryDirection(o.angle ?? 0) });
  return t("rp.shoot");
}
export function successLabel(o: CoachOption): string {
  return t(o.kind === "pass" ? "rp.arrives" : o.kind === "carry" ? "rp.keeps" : "rp.goalChance", { p: pct(o.p) });
}

export function proLabel(pro: ProChoice, players: PlayerInfo[]): string {
  const what =
    pro.kind === "shot" ? t(pro.success ? "rp.proScored" : "rp.proShot")
    : pro.kind === "carry" ? t("rp.proCarried", { dir: carryDirection(pro.option?.angle ?? 0) })
    : pro.kind === "hold" ? t("rp.proHeld")
    : pro.success ? t("rp.proPassed", { who: who(players, pro.recipient) })
    : pro.option ? t("rp.proMissedTo", { who: who(players, pro.option.target) }) : t("rp.proMissed");
  const value = pro.option ? t("rp.coachValue", { xg: signedXg(pro.option.score) }) : pro.kind === "hold" ? "" : t("rp.notOption");
  return `${what}${value}${pro.approx ? t("rp.approx") : ""}.`;
}
export const outcomeLabel = (o: Outcome): string => t(({ goal: "rp.outGoal", shot: "rp.outShot", lost: "rp.outLost", kept: "rp.outKept" } as const)[o]);


export { loadCoach } from "../coach/picture.ts";
export { pct, signedXg };
