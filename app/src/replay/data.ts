// Free play: one full Bundesliga match (data: Bassek et al. (2025), DFL / Sportec Solutions, CC BY 4.0), ported from
// the portfolio site's src/lib/coach/replay.ts (same author, MIT). Files in app/public/replay/: match.json (players,
// halves, possession, events) and h<i>.bin per half: little-endian int16 centimetres; for each frame the half's player
// slots (match.json halves[i].slots, ascending player index), then the ball, each (x, y); -32768 = absent. 12.5 fps.
// Int16Array reads the platform's byte order: little-endian on every browser that runs this app.
import type { State } from "../coach/features.ts";
import { normalise, type Vec } from "../coach/geometry.ts";

export const ABSENT = -32768;
/** Velocity lag: training used 4 frames at 25 fps (0.16 s), which is 2 frames at 12.5 fps. */
export const BACK_FRAMES = 2;
/** The nearest player of the team in possession has the ball when within this distance of it (m). */
export const CARRIER_M = 2.0;

export interface PlayerInfo { team: number; shirt: number; name: string }
export interface HalfInfo { frames: number; slots: number[]; attack: [number, number] }
export interface MatchEvent {
  type: "pass" | "shot"; half: number | null; frame: number | null; nominal?: number | null; team: number;
  player: number | null; recipient?: number | null; success?: boolean; goal?: boolean; xg?: number | null;
}
export interface MatchMeta {
  match_id: string; fps: number; halves: HalfInfo[]; players: PlayerInfo[];
  meta: { home: string; guest: string; colors: [string, string] };
  /** Per half, one character per frame: "1" home has the ball, "2" guest, anything else unknown. */
  owner: string[];
  /** Per half, one character per frame: "1" the ball is in play. */
  alive: string[];
  events: MatchEvent[]; credit: string;
}
export interface HalfData { info: HalfInfo; data: Int16Array; column: Int16Array; stride: number }
export interface Carrier { player: number; team: number }

export function decodeHalf(buf: ArrayBuffer, info: HalfInfo, players: number): HalfData {
  const stride = (info.slots.length + 1) * 2;
  if (buf.byteLength !== info.frames * stride * 2)
    throw new Error(`half file has ${buf.byteLength} bytes, expected ${info.frames * stride * 2}`);
  const column = new Int16Array(players).fill(-1);
  info.slots.forEach((p, c) => (column[p] = c));
  return { info, data: new Int16Array(buf), column, stride };
}

function read(h: HalfData, frame: number, col: number): Vec | null {
  const i = frame * h.stride + col * 2, x = h.data[i];
  return x === undefined || x === ABSENT ? null : [x / 100, h.data[i + 1]! / 100];
}
export const playerAt = (h: HalfData, frame: number, player: number): Vec | null => {
  const c = h.column[player];
  return c === undefined || c < 0 ? null : read(h, frame, c);
};
export const ballAt = (h: HalfData, frame: number): Vec | null => read(h, frame, h.info.slots.length);

/** Backward difference over `back` frames (fewer at the start of the half); zero when the player was absent. */
export function velocityAt(h: HalfData, frame: number, player: number, fps: number, back = BACK_FRAMES): Vec {
  const b = Math.max(0, frame - back);
  if (frame <= b) return [0, 0];
  const p = playerAt(h, frame, player), q = playerAt(h, b, player);
  if (!p || !q) return [0, 0];
  const k = fps / (frame - b);
  return [(p[0] - q[0]) * k, (p[1] - q[1]) * k];
}

/** The coach's state for `team` at a frame (coach/features.py state() with fps = 12.5, back_frames = 2). */
export function stateAt(m: MatchMeta, half: number, h: HalfData, frame: number, team: number): State {
  const direction = m.halves[half]!.attack[team]!;
  const s: State = { att: [], attV: [], def: [], defV: [], attIdx: [], defIdx: [], ball: [NaN, NaN], direction };
  for (const p of h.info.slots) {
    const pos = playerAt(h, frame, p), t = m.players[p]?.team;
    if (!pos || t === undefined || (t !== team && t !== 1 - team)) continue; // team -1: not on the match sheet
    const v = velocityAt(h, frame, p, m.fps);
    if (t === team) { s.att.push(normalise(pos, direction)); s.attV.push(normalise(v, direction)); s.attIdx.push(p); }
    else { s.def.push(normalise(pos, direction)); s.defV.push(normalise(v, direction)); s.defIdx.push(p); }
  }
  const ball = ballAt(h, frame);
  if (ball) s.ball = normalise(ball, direction);
  return s;
}

/** Team in possession at a frame: 0 home, 1 guest, -1 unknown. */
export const ownerAt = (m: MatchMeta, half: number, frame: number): number => {
  const c = m.owner[half]?.[frame];
  return c === "1" ? 0 : c === "2" ? 1 : -1;
};

export function carrierAt(m: MatchMeta, half: number, h: HalfData, frame: number): Carrier | null {
  const team = ownerAt(m, half, frame), ball = ballAt(h, frame);
  if (m.alive[half]?.[frame] !== "1" || team < 0 || !ball) return null;
  let best = -1, bestD = Infinity;
  for (const p of h.info.slots) {
    if (m.players[p]?.team !== team) continue;
    const pos = playerAt(h, frame, p);
    if (!pos) continue;
    const d = Math.hypot(pos[0] - ball[0], pos[1] - ball[1]);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best >= 0 && bestD <= CARRIER_M ? { player: best, team } : null;
}

/**
 * The frame closest to `frame` (within `maxBack` s before and `maxForward` s after) at which someone has the ball,
 * or null. The carrier rule above is strict on purpose (parity with the library), so a viewer who pauses while the
 * ball travels is moved to the nearest moment where the coach has a player to advise. Ties go to the earlier frame.
 */
export function nearestCarrierFrame(m: MatchMeta, half: number, h: HalfData, frame: number, maxBack = 2, maxForward = 2): number | null {
  const back = Math.round(maxBack * m.fps), forward = Math.round(maxForward * m.fps), last = h.info.frames - 1;
  for (let d = 0; d <= Math.max(back, forward); d++) {
    if (d <= back && frame - d >= 0 && frame - d <= last && carrierAt(m, half, h, frame - d)) return frame - d;
    if (d > 0 && d <= forward && frame + d >= 0 && frame + d <= last && carrierAt(m, half, h, frame + d)) return frame + d;
  }
  return null;
}

/** Positions at a fractional frame t (linear between frames; a player missing at either end shows at the nearer). */
export function frameDots(h: HalfData, t: number): { players: { player: number; at: Vec }[]; ball: Vec | null } {
  const last = h.info.frames - 1;
  const f0 = Math.max(0, Math.min(last, Math.floor(t))), f1 = Math.min(last, f0 + 1), a = Math.max(0, Math.min(1, t - f0));
  const mix = (p: Vec | null, q: Vec | null): Vec | null => (p && q ? [p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a] : a < 0.5 ? p : q);
  const players: { player: number; at: Vec }[] = [];
  for (const p of h.info.slots) {
    const at = mix(playerAt(h, f0, p), playerAt(h, f1, p));
    if (at) players.push({ player: p, at });
  }
  return { players, ball: mix(ballAt(h, f0), ballAt(h, f1)) };
}

/** Ball positions over the last `seconds` up to frame t. */
export function trail(h: HalfData, t: number, fps: number, seconds = 1): Vec[] {
  const f = Math.max(0, Math.min(h.info.frames - 1, Math.floor(t))), out: Vec[] = [];
  for (let i = Math.max(0, f - Math.round(seconds * fps)); i <= f; i++) {
    const b = ballAt(h, i);
    if (b) out.push(b);
  }
  return out;
}

// ---------- the ball's height (3D only) ----------
// z<i>.bin (library coach/export.py, same data and licence as h<i>.bin): one little-endian int16 per frame of the half,
// the ball centre's height in centimetres, -32768 = unknown. 68 kB per half, fetched the first time 3D shows the half.
/** Height (m) of the ball's centre when it rests on the grass. */
export const BALL_REST_M = 0.11;

export function decodeBallZ(buf: ArrayBuffer, frames: number): Int16Array {
  if (buf.byteLength !== frames * 2) throw new Error(`ball height file has ${buf.byteLength} bytes, expected ${frames * 2}`);
  return new Int16Array(buf);
}

/** The ball centre's height (m) at a fractional frame, linear between frames like the positions; an unknown frame takes
 *  its neighbour's value; resting height without data, when both are unknown, or below it. */
export function ballHeightAt(z: Int16Array | null | undefined, t: number): number {
  if (!z || !z.length) return BALL_REST_M;
  const last = z.length - 1, f0 = Math.max(0, Math.min(last, Math.floor(t))), f1 = Math.min(last, f0 + 1);
  const a = Math.max(0, Math.min(1, t - f0)), v0 = z[f0]!, v1 = z[f1]!;
  if (v0 === ABSENT && v1 === ABSENT) return BALL_REST_M;
  const cm = v0 === ABSENT ? v1 : v1 === ABSENT ? v0 : v0 + (v1 - v0) * a;
  return Math.max(BALL_REST_M, cm / 100);
}

// ---------- time ----------
/** Match clock "mm:ss" (the second half starts at 45:00). */
export function clock(half: number, frame: number, fps: number): string {
  const s = Math.floor(frame / fps) + half * 45 * 60;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Minute as on a scoreboard: 1' at kick-off, 45+2' in stoppage time, 46' at the start of the second half. */
export function minuteLabel(half: number, frame: number, fps: number): string {
  const inHalf = Math.floor(frame / fps / 60) + 1;
  return inHalf > 45 ? `${45 * (half + 1)}+${inHalf - 45}'` : `${inHalf + 45 * half}'`;
}

/** The scrubber runs over the whole match: global position = frames of the earlier halves + frame in the half. */
export const totalFrames = (m: Pick<MatchMeta, "halves">): number => m.halves.reduce((n, h) => n + h.frames, 0);

export function toGlobal(m: Pick<MatchMeta, "halves">, half: number, frame: number): number {
  let g = 0;
  for (let i = 0; i < half; i++) g += m.halves[i]!.frames;
  return g + frame;
}

/** Inverse of toGlobal, clamped to the match. Keeps the fraction of a fractional position. */
export function fromGlobal(m: Pick<MatchMeta, "halves">, g: number): { half: number; frame: number } {
  let rest = Math.max(0, g);
  for (let i = 0; i < m.halves.length; i++) {
    const n = m.halves[i]!.frames;
    if (rest < n || i === m.halves.length - 1) return { half: i, frame: Math.min(rest, n - 1) };
    rest -= n;
  }
  return { half: 0, frame: 0 };
}

// ---------- events ----------
/** Frame of an event: the synced frame, else the nominal one, else null. */
export const eventFrame = (e: Pick<MatchEvent, "frame" | "nominal">): number | null => e.frame ?? e.nominal ?? null;

/** Goals scored up to (half, frame), as [home, guest]: shot events with goal = true, credited to the shooting team. */
export function scoreAt(m: Pick<MatchMeta, "events">, half: number, frame: number): [number, number] {
  const s: [number, number] = [0, 0];
  for (const e of m.events) {
    const f = eventFrame(e);
    if (e.type !== "shot" || !e.goal || e.half === null || f === null || (e.team !== 0 && e.team !== 1)) continue;
    if (e.half < half || (e.half === half && f <= frame)) s[e.team]++;
  }
  return s;
}

export interface Goal { half: number; frame: number; team: number; label: string }
export function goals(m: MatchMeta): Goal[] {
  const out: Goal[] = [];
  for (const e of m.events) {
    const f = eventFrame(e);
    if (e.type !== "shot" || !e.goal || e.half === null || f === null || (e.team !== 0 && e.team !== 1)) continue;
    const p = e.player != null ? m.players[e.player] : undefined;
    out.push({ half: e.half, frame: f, team: e.team,
      label: `${minuteLabel(e.half, f, m.fps)} ${e.team ? m.meta.guest : m.meta.home}${p ? ` · #${p.shirt} ${p.name}` : ""}` });
  }
  return out.sort((a, b) => a.half - b.half || a.frame - b.frame);
}

// ---------- screen orientation ----------
/**
 * Free play uses one fixed view for the whole match (no attack normalisation): the home team attacks up the screen in
 * the first half, down in the second. Returns the factor that turns raw tracking metres into pitch.ts's "attack up"
 * metres: +1 when home attacks +x in the first half, -1 otherwise (a 180° turn).
 */
export const viewFlip = (m: Pick<MatchMeta, "halves">): 1 | -1 => (m.halves[0]!.attack[0]! >= 0 ? 1 : -1);
export const toView = (p: Vec, flip: 1 | -1): Vec => [p[0] * flip, p[1] * flip];
