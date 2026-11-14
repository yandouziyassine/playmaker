// Coach's notebook: a small rule-based lesson engine. From one answered moment (the moment at release, the server's
// answer and the player's pick) it turns the player's own decision into 0-2 short tactical lessons, each grounded in
// numbers we can compute here: geometry from the release frame (attack-normalised, cm -> m) and the coach's own
// reason phrases (coach/explain.ts PHRASES: "+0.021 xG if it arrives, ...", "{pct} % pitch control ...", the shot's
// xG). No outside statistics: general claims are phrased qualitatively. Pure: no DOM, no storage.
import type { Moment, PickResult, Reason } from "./api.ts";
import { goalGeometry, type Vec } from "./coach/geometry.ts";
import { num, pct, t, xg, type Key } from "./i18n/index.ts";
import { translatePhrase } from "./i18n/phrases.ts";
import type { MomentRecord, Skill } from "./storage.ts";

export type { Skill };
export const SKILLS: readonly Skill[] = ["scanning", "risk", "progression", "finishing", "reading"];
export type LessonId = "lane" | "space" | "long" | "back" | "shot" | "noshot" | "carry" | "pro" | "guess";

export interface Lesson {
  id: LessonId; skill: Skill;
  /** Localised, generic ("Crowded passing lane"). */
  title: string;
  /** Localised, about this moment, with its numbers. */
  body: string;
  /** The facts behind it ("Why?"): computed numbers (effect 0) and the coach's own phrases about the pick. */
  evidence: Reason[];
  /** Usefulness: higher first (rule weight, more for a costly pick). */
  weight: number;
}

/** Thresholds (metres, degrees). The lane width is the coach's own (coach/features.ts LANE_WIDTH). */
export const LANE_M = 2.0;
export const CROWDED = 2;
export const TIGHT_M = 2.5;
export const ROOMY_M = 4.0;
export const LONG_M = 30;
export const BACK_M = -2;
export const FORWARD_M = 5;
export const FAR_SHOT_M = 20;
export const NARROW_DEG = 15;
export const LOW_CONTROL = 35;

export const SKILL_OF: Record<LessonId, Skill> = {
  lane: "scanning", space: "scanning", long: "risk", carry: "risk", back: "progression",
  shot: "finishing", noshot: "finishing", pro: "reading", guess: "reading",
};
const WEIGHT: Record<LessonId, number> = { lane: 5, shot: 5, space: 4, noshot: 4, long: 3, back: 3, carry: 3, pro: 1.5, guess: 1 };

type Opt = Moment["options"][number];
const DEG = 180 / Math.PI;

// ---------- geometry ----------

/** Positions at the release (metres); null when not tracked. */
function release(mo: Moment): (Vec | null)[] {
  const f = mo.lead_up[mo.lead_up.length - 1] ?? [];
  return f.map((p) => (p ? [p[0] / 100, p[1] / 100] : null));
}

export function carrierAt(mo: Moment): Vec | null {
  const p = release(mo)[mo.carrier];
  if (p) return p;
  const b = mo.ball[mo.ball.length - 1];
  return b ? [b[0] / 100, b[1] / 100] : null;
}

const defenders = (mo: Moment): Vec[] =>
  release(mo).filter((p, i): p is Vec => !!p && mo.players?.[i]?.side === 1);

function segDist(p: Vec, a: Vec, b: Vec): { d: number; t: number } {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const raw = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-9);
  const tt = Math.min(1, Math.max(0, raw));
  return { d: Math.hypot(p[0] - (a[0] + tt * abx), p[1] - (a[1] + tt * aby)), t: tt };
}

export interface PassGeom { length: number; forward: number; angle: number; lane: number; space: number }
/** Pass geometry from the release frame: length, metres forward, degrees off straight ahead, defenders within LANE_M
 *  of the line (the ends excluded, as in the coach), the receiver's space (nearest defender). */
export function passGeom(mo: Moment, o: Opt): PassGeom | null {
  if (o.kind !== "pass") return null;
  const a = carrierAt(mo);
  const b = (o.player != null ? release(mo)[o.player] : null) ?? [o.to[0] / 100, o.to[1] / 100];
  if (!a) return null;
  let lane = 0, space = Infinity;
  for (const p of defenders(mo)) {
    const { d, t: tt } = segDist(p, a, b);
    if (d < LANE_M && tt > 0.05 && tt < 0.95) lane++;
    space = Math.min(space, Math.hypot(p[0] - b[0], p[1] - b[1]));
  }
  return {
    length: Math.hypot(b[0] - a[0], b[1] - a[1]), forward: b[0] - a[0],
    angle: Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) * DEG, lane, space,
  };
}

/** Distance to the goal centre (m) and the goal mouth visible (degrees) from the carrier. */
export function shotGeom(mo: Moment): { dist: number; angle: number } | null {
  const c = carrierAt(mo);
  if (!c) return null;
  const g = goalGeometry(c);
  return { dist: g.dist, angle: g.angle * DEG };
}

// ---------- the coach's own numbers (English phrases from the answer file) ----------

const N = "([-+]?\\d+(?:\\.\\d+)?)";
const RE_PASS = new RegExp(`^${N} xG if it arrives, ${N} if lost there$`);
const RE_CARRY = new RegExp(`^${N} xG if kept, ${N} if lost there$`);
const RE_CONTROL = new RegExp(`^${N} % pitch control where the carry ends$`);
const RE_SHOT = new RegExp(`^${N} xG for the shot, ${N} if the ball is kept here$`);

export interface Values { gain?: number; loss?: number; control?: number; shotXg?: number }
export function valuesOf(reasons: Reason[] | undefined): Values {
  const v: Values = {};
  for (const r of reasons ?? []) {
    const s = r.text.trim();
    let m = RE_PASS.exec(s) ?? RE_CARRY.exec(s);
    if (m) { v.gain = Number(m[1]); v.loss = Number(m[2]); continue; }
    if ((m = RE_CONTROL.exec(s))) { v.control = Number(m[1]); continue; }
    if ((m = RE_SHOT.exec(s))) v.shotXg = Number(m[1]);
  }
  return v;
}

// ---------- rules ----------

const optOf = (mo: Moment, k: number) => mo.options.find((o) => o.k === k);
const m0 = (x: number) => num(Math.abs(x), 0);
const m1 = (x: number) => num(x, 1);
const who = (mo: Moment, o: Opt) => { const p = mo.players?.[o.player!]; return { shirt: p?.shirt ?? "?", name: p?.name ?? "" }; };

/** The AI's alternative, told through the number that matters for the rule: "The AI preferred #9 B. Nine, with
 *  6.2 m of space." / "..., on a clear line." / "a shorter pass: #9 B. Nine, 12 m." / "The AI preferred: Shoot." */
function aiAlt(mo: Moment, ai: Opt | undefined, label: (k: number) => string, angle: "space" | "lane" | "length" = "space"): string {
  if (!ai) return "";
  const g = passGeom(mo, ai);
  if (g && angle === "lane" && g.lane === 0) return " " + t("lesson.alt.laneClear", who(mo, ai));
  if (g && angle === "length") return " " + t("lesson.alt.short", { ...who(mo, ai), d: m0(g.length) });
  if (g && Number.isFinite(g.space) && g.space >= ROOMY_M) return " " + t("lesson.alt.pass", { ...who(mo, ai), space: m1(g.space) });
  return " " + t("lesson.alt.other", { label: label(ai.k) });
}

/** The coach's phrases about the player's pick that count against it (effect -1), in the current language. */
const against = (res: PickResult, k: number): Reason[] =>
  (res.reasons?.[k] ?? []).filter((r) => r.effect < 0).map((r) => ({ text: translatePhrase(r.text), effect: r.effect }));
const fact = (key: Key, params: Record<string, string | number>): Reason => ({ text: t(key, params), effect: 0 });

function lesson(id: LessonId, body: string, evidence: Reason[], points: number): Lesson {
  return { id, skill: SKILL_OF[id], title: t(`lesson.${id}.title`), body, evidence, weight: WEIGHT[id] * (1 + (100 - points) / 100) };
}

/** 0-2 lessons for one answered moment, most useful first, never two of the same skill. None when the pick was the
 *  AI's. A pick rated as good as the AI's ("close call") only gets the reading-the-pro notes. `label`: the option's
 *  name (text.ts optionLabel; passed in so this module stays free of the option wording). */
export function lessonsFor(mo: Moment, res: PickResult, label: (k: number) => string = (k) => `#${k}`): Lesson[] {
  const pick = res.option;
  if (pick === res.ai_pick) return [];
  const mine = optOf(mo, pick), ai = optOf(mo, res.ai_pick);
  if (!mine) return [];
  const pts = res.points;
  const out: Lesson[] = [];
  const close = res.among_best;
  const gMine = passGeom(mo, mine), gAi = ai ? passGeom(mo, ai) : null;
  const vMine = valuesOf(res.reasons?.[pick]), vAi = valuesOf(res.reasons?.[res.ai_pick]);

  if (!close) {
    // scanning: a crowded lane (2+ defenders near the line, or 1 when the AI's lane was clear)
    if (gMine && (gMine.lane >= CROWDED || (gMine.lane === 1 && gAi && gAi.lane === 0))) {
      const ev = [fact("lesson.ev.lane", { n: gMine.lane, w: num(LANE_M, 0) })];
      if (gAi) ev.push(fact("lesson.ev.aiLane", { n: gAi.lane }));
      out.push(lesson("lane", t(gMine.lane === 1 ? "lesson.lane.body1" : "lesson.lane.body", { n: gMine.lane, w: num(LANE_M, 0) }) + aiAlt(mo, ai, label, "lane"), [...ev, ...against(res, pick)], pts));
    }
    // scanning: a marked receiver while the AI's had room
    if (gMine && gMine.space < TIGHT_M && gAi && gAi.space >= Math.max(ROOMY_M, 2 * gMine.space)) {
      out.push(lesson("space", t("lesson.space.body", { d: m1(gMine.space) }) + aiAlt(mo, ai, label),
        [fact("lesson.ev.space", { d: m1(gMine.space) }), fact("lesson.ev.aiSpace", { d: m1(gAi.space) }), ...against(res, pick)], pts));
    }
    // finishing: a low-percentage shot
    const sg = shotGeom(mo);
    if (mine.kind === "shot" && sg && (sg.dist >= FAR_SHOT_M || sg.angle < NARROW_DEG)) {
      const key: Key = vMine.shotXg != null ? "lesson.shot.body" : "lesson.shot.bodyNoP";
      out.push(lesson("shot", t(key, { d: m0(sg.dist), a: m0(sg.angle), p: pct(vMine.shotXg ?? 0) }) + aiAlt(mo, ai, label),
        [fact("lesson.ev.goalDist", { d: m0(sg.dist) }), fact("lesson.ev.goalAngle", { a: m0(sg.angle) }), ...against(res, pick)], pts));
    }
    // finishing: the AI would have shot
    if (ai?.kind === "shot" && mine.kind !== "shot" && sg) {
      const key: Key = vAi.shotXg != null ? "lesson.noshot.body" : "lesson.noshot.bodyNoP";
      out.push(lesson("noshot", t(key, { d: m0(sg.dist), a: m0(sg.angle), p: pct(vAi.shotXg ?? 0) }),
        [fact("lesson.ev.goalDist", { d: m0(sg.dist) }), fact("lesson.ev.goalAngle", { a: m0(sg.angle) })], pts));
    }
    // risk: a long pass when the AI's choice was shorter (or not a pass)
    if (gMine && gMine.length >= LONG_M && (!gAi || gAi.length <= gMine.length - 8)) {
      const body = t(vMine.loss != null ? "lesson.long.body" : "lesson.long.bodyNoLoss", { d: m0(gMine.length), loss: xg(vMine.loss ?? 0) });
      const ev = [fact("lesson.ev.length", { d: m0(gMine.length) })];
      if (gAi) ev.push(fact("lesson.ev.aiLength", { d: m0(gAi.length) }));
      out.push(lesson("long", body + aiAlt(mo, ai, label, "length"), [...ev, ...against(res, pick)], pts));
    }
    // risk: a carry where the team controls little of the space
    if (mine.kind === "carry" && vMine.control != null && vMine.control < LOW_CONTROL) {
      out.push(lesson("carry", t("lesson.carry.body", { p: pct(vMine.control / 100) }) + aiAlt(mo, ai, label),
        [fact("lesson.ev.control", { p: pct(vMine.control / 100) }), ...(vMine.loss != null ? [fact("lesson.ev.lost", { loss: xg(vMine.loss) })] : [])], pts));
    }
    // progression: a backward pass when the AI went forward and gained more
    if (gMine && gMine.forward <= BACK_M && ai && ai.kind !== "shot" && vAi.gain != null && (vMine.gain == null || vAi.gain > vMine.gain)) {
      const fwd = gAi ? gAi.forward : (ai.to[0] / 100) - (carrierAt(mo)?.[0] ?? 0);
      if (fwd >= FORWARD_M) {
        const key: Key = ai.kind === "pass" ? "lesson.back.body" : "lesson.back.bodyCarry";
        const ev = [fact("lesson.ev.back", { d: m0(gMine.forward) }), fact("lesson.ev.aiGain", { gain: xg(vAi.gain) })];
        if (vMine.gain != null) ev.push(fact("lesson.ev.myGain", { gain: xg(vMine.gain) }));
        out.push(lesson("back", t(key, { d: m0(gMine.forward), f: m0(fwd), gain: xg(vAi.gain), ...(ai.kind === "pass" ? who(mo, ai) : {}) }), ev, pts));
      }
    }
  }
  // reading the pro: the player made the pro's choice, the AI another
  if (pick === res.pro_pick) out.push(lesson("pro", t("lesson.pro.body"), [], pts));
  // reading the pro: the second question was wrong; what the pro saw
  const pro = optOf(mo, res.pro_pick);
  const gPro = pro ? passGeom(mo, pro) : null;
  if (res.guess_right === false && pro && gPro && Number.isFinite(gPro.space)) {
    const dir = t(gPro.forward >= 0 ? "lesson.dir.fwd" : "lesson.dir.back", { d: m0(gPro.forward) });
    out.push(lesson("guess", t("lesson.guess.body", { ...who(mo, pro), space: m1(gPro.space), dir }),
      [fact("lesson.ev.proSpace", { d: m1(gPro.space) }), fact("lesson.ev.proLane", { n: gPro.lane })], 100));
  }
  return pickTop(out, 2);
}

/** The `n` heaviest lessons, one per skill (stable for equal weights). */
function pickTop(ls: Lesson[], n: number): Lesson[] {
  const sorted = ls.map((l, i) => [l, i] as const).sort((a, b) => b[0].weight - a[0].weight || a[1] - b[1]).map(([l]) => l);
  const out: Lesson[] = [];
  for (const l of sorted) if (out.length < n && !out.some((o) => o.skill === l.skill)) out.push(l);
  return out;
}

/** The one lesson for the reveal: the most useful one not shown yet today (else the most useful). Marks it seen. */
export function revealLesson(ls: Lesson[], seen: Set<string>): Lesson | null {
  const l = ls.find((x) => !seen.has(x.id)) ?? ls[0] ?? null;
  if (l) seen.add(l.id);
  return l;
}

export interface NotebookEntry { lesson: Lesson; count: number }
/** The day's notebook: lessons grouped by rule (deduplicated), summed usefulness, the `n` best. The latest instance
 *  of a rule speaks for it. */
export function dayNotebook(perMoment: Lesson[][], n = 3): NotebookEntry[] {
  const by = new Map<LessonId, { lesson: Lesson; count: number; score: number; first: number }>();
  perMoment.flat().forEach((l, i) => {
    const e = by.get(l.id);
    if (e) { e.lesson = l; e.count++; e.score += l.weight; } else by.set(l.id, { lesson: l, count: 1, score: l.weight, first: i });
  });
  return [...by.values()].sort((a, b) => b.score - a.score || a.first - b.first).slice(0, n).map(({ lesson, count }) => ({ lesson, count }));
}

/** Lesson ids stored on a record (rule ids only: no names, no numbers). */
export const isLessonId = (x: unknown): x is LessonId => typeof x === "string" && x in SKILL_OF;

/** A notebook rebuilt from stored records (a finished day reopened): one entry per rule, generic tip as the body. */
export function notebookFromRecords(recs: unknown, n = 3): NotebookEntry[] {
  const list = (Array.isArray(recs) ? recs : []) as Partial<MomentRecord>[];
  const counts = new Map<LessonId, number>();
  for (const r of list) for (const id of Array.isArray(r?.lessons) ? r.lessons : []) if (isLessonId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] * WEIGHT[b[0]] - a[1] * WEIGHT[a[0]]).slice(0, n)
    .map(([id, count]) => ({ count, lesson: { id, skill: SKILL_OF[id], title: t(`lesson.${id}.title`), body: t(`lesson.${id}.tip`), evidence: [], weight: WEIGHT[id] } }));
}

export interface Weakest { skill: Skill; n: number; of: number }
/** The skill most often flagged over all stored history, among records made since lessons exist (they carry a
 *  `skills` array, possibly empty). Null until something was flagged. */
export function weakestSkill(moments: Record<string, unknown>): Weakest | null {
  const recs = Object.values(moments && typeof moments === "object" ? moments : {})
    .flatMap((l) => (Array.isArray(l) ? l : [])) as Partial<MomentRecord>[];
  const known = recs.filter((r) => r && typeof r === "object" && Array.isArray(r.skills));
  const counts = new Map<Skill, number>();
  for (const r of known) for (const s of new Set(r.skills)) if (SKILLS.includes(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: Weakest | null = null;
  for (const s of SKILLS) { const n = counts.get(s) ?? 0; if (n && (!best || n > best.n)) best = { skill: s, n, of: known.length }; }
  return best;
}
