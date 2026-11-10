// The AI coach on one calibrated picture (Lab): mapped pitch positions -> coach State -> ranked options + reasons.
// Engine ported from the portfolio site (src/lib/coach, same author, MIT); weights in app/public/coach/models.json
// (trained on open tracking data, see its trained_on field). A single picture has no velocities: everyone stands
// still (zeros), so pitch control and pass success are a "frozen frame" opinion.
import { options, valueAt, type Coach, type CoachOption } from "./advice.ts";
import { explainOptions, type Explanation } from "./explain.ts";
import type { State } from "./features.ts";
import { HALF_LENGTH, HALF_WIDTH, normalise, type Vec } from "./geometry.ts";
import { coachFromModels, type ModelsJson } from "./models.ts";

/** Lab pitch point: metres, centre 0,0, x towards the RIGHT goal of the picture, y towards the FAR touchline. */
export type PitchPt = { x: number; y: number };
export type Team = 0 | 1 | "other";
/** +1: the carrier's team attacks the right goal of the picture (+x), -1: the left goal. */
export type AttackDir = 1 | -1;

export interface PictureState {
  state: State;
  /** Row of the carrier in state.att. */
  carrierRow: number;
}

const clampPitch = (p: Vec): Vec => [Math.max(-HALF_LENGTH, Math.min(HALF_LENGTH, p[0])), Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, p[1]))];

/**
 * Coach State from the Lab's mapped points (index = Lab player index, null = not on the map). The carrier's team
 * attacks, the other team (0 / 1) defends, "other" (referee, keeper?) is ignored. Positions are attack-normalised
 * (rotated 180° when attacking the left goal, so the attack goes to +x and the carrier's left stays +y), clamped to
 * the pitch. Velocities are unknown from one picture: zeros. Returns null when the carrier is not usable.
 */
export function stateFromPicture(pos: readonly (PitchPt | null)[], teams: readonly Team[], carrier: number, dir: AttackDir): PictureState | null {
  const team = teams[carrier], here = pos[carrier];
  if (team === undefined || team === "other" || !here) return null;
  const s: State = { att: [], attV: [], def: [], defV: [], attIdx: [], defIdx: [], ball: [0, 0], direction: dir };
  let carrierRow = -1;
  pos.forEach((p, i) => {
    const t = teams[i];
    if (!p || t === undefined || t === "other") return;
    const q = clampPitch(normalise([p.x, p.y], dir));
    if (t === team) {
      if (i === carrier) carrierRow = s.att.length;
      s.att.push(q); s.attV.push([0, 0]); s.attIdx.push(i);
    } else {
      s.def.push(q); s.defV.push([0, 0]); s.defIdx.push(i);
    }
  });
  s.ball = [s.att[carrierRow]![0], s.att[carrierRow]![1]];
  return { state: s, carrierRow };
}

/** Back from the normalised frame to Lab pitch metres (the 180° rotation is its own inverse). */
export function toPicture(p: Vec, dir: AttackDir): PitchPt {
  const q = normalise(p, dir);
  return { x: q[0], y: q[1] };
}

export interface Advice {
  ps: PictureState;
  vNow: number;
  /** All options, best first, with their explanation (same order). */
  ranked: { option: CoachOption; why: Explanation; to: PitchPt }[];
}

/** Ranks every option of the carrier. Needs at least one defender on the map (else the model sees no pressure at all). */
export function advise(ps: PictureState, coach: Coach, models: ModelsJson): Advice | null {
  if (!ps.state.def.length) return null;
  const opts = options(ps.state, ps.carrierRow, coach);
  const vNow = valueAt(coach, ps.state.att[ps.carrierRow]!);
  const why = explainOptions(ps.state, ps.carrierRow, opts, models, vNow, coach.pc);
  return { ps, vNow, ranked: opts.map((option, i) => ({ option, why: why[i]!, to: toPicture(option.to, ps.state.direction as AttackDir) })) };
}

export interface LoadedCoach { coach: Coach; models: ModelsJson }

/** Fetches and checks the weights (feature names must match the port). */
export async function loadCoach(url: string): Promise<LoadedCoach> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`models.json: HTTP ${r.status}`);
  const models = (await r.json()) as ModelsJson;
  return { coach: coachFromModels(models), models };
}

// ---------- text ----------
export const pct = (p: number) => `${Math.round(p * 100)} %`;

export function signedXg(x: number): string {
  const r = Math.round(x * 1000) / 1000;
  return `${r < 0 ? "-" : "+"}${Math.abs(r).toFixed(3)} xG`;
}

/** Carry angle in the normalised frame: > 0 is to the carrier's left (he faces the goal he attacks). */
export function carryDirection(angle: number): string {
  const a = Math.round(angle);
  return a === 0 ? "straight ahead" : a > 0 ? `${a}° left` : `${-a}° right`;
}

/** "Pass to #7", "Carry 30° left", "Shoot" (players are numbered like the Lab: index + 1). */
export function optionTitle(o: CoachOption): string {
  if (o.kind === "pass") return `Pass to #${(o.target ?? -1) + 1}`;
  if (o.kind === "carry") return `Carry ${carryDirection(o.angle ?? 0)}`;
  return "Shoot";
}

export function successLabel(o: CoachOption): string {
  return o.kind === "pass" ? `${pct(o.p)} arrives` : o.kind === "carry" ? `${pct(o.p)} keeps it` : `${pct(o.p)} goal chance`;
}
