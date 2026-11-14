import type { Moment, PickResult } from "./api.ts";
import type { MomentRecord, PickKind, Zone } from "./storage.ts";
import { pct, t, tn } from "./i18n/index.ts";
import { lessonsFor } from "./lessons.ts";

/** Thirds of the pitch, from the release position (cm, attack towards +x, pitch x in [-5250, 5250]). */
export const ZONE_EDGE_CM = 1750;
export const ZONES: Zone[] = ["build", "middle", "final"];
export const KINDS: PickKind[] = ["pass", "carry", "shot"];
export const zoneLabel = (z: Zone) => t(`zone.${z}`);
export const kindLabel = (k: PickKind) => t(`kind.${k}`);

export function zoneOf(x: number | null | undefined): Zone {
  if (x == null || !Number.isFinite(x)) return "middle";
  return x < -ZONE_EDGE_CM ? "build" : x > ZONE_EDGE_CM ? "final" : "middle";
}

/** The record of one answered moment, built from the moment and the server's answer (with its notebook lessons:
 *  rule ids and skills only). */
export function toRecord(mo: Moment, res: PickResult): MomentRecord {
  let ls: ReturnType<typeof lessonsFor> = [];
  try { ls = lessonsFor(mo, res); } catch { /* the record still counts without its lessons */ }
  const release = mo.lead_up[mo.lead_up.length - 1];
  const pos = release?.[mo.carrier] ?? mo.ball[mo.ball.length - 1] ?? null;
  const kind = mo.options.find((o) => o.k === res.option)?.kind ?? "pass";
  return {
    id: mo.id, points: res.points, among_best: res.among_best, pro_instinct: res.pro_instinct,
    same_as_ai: res.option === res.ai_pick, kind, zone: zoneOf(pos?.[0]), league: mo.league, outcome: res.outcome.kind,
    guess_right: typeof res.guess_right === "boolean" ? res.guess_right : null,
    lessons: ls.map((l) => l.id), skills: ls.map((l) => l.skill),
  };
}

/** Second-question score of a set of records ("Pro reads 3/5"); null when none of them has a guess. */
export function proReads(recs: unknown): { right: number; of: number } | null {
  const known = (Array.isArray(recs) ? recs : []).filter((r) => valid(r) && typeof r.guess_right === "boolean") as MomentRecord[];
  return known.length ? { right: known.filter((r) => r.guess_right).length, of: known.length } : null;
}

export interface Bucket { n: number; avg: number | null }
export interface Stats {
  games: number; moments: number;
  avgDay: number | null; bestDay: { date: string; total: number } | null;
  /** Shares in [0, 1] (null when there is nothing to count). */
  perfect: number | null; proInstinct: number | null; aiAgree: number | null;
  /** Share of second-question guesses that matched the pro's real pass, over `proReadN` moments with a guess. */
  proRead: number | null; proReadN: number;
  byZone: Record<Zone, Bucket>; byKind: Record<PickKind, Bucket>;
  shots: { chosen: number; aiAgreed: number };
  insight: string;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const ratio = (n: number, d: number) => (d ? n / d : null);
const bucket = (recs: MomentRecord[]): Bucket => ({ n: recs.length, avg: recs.length ? Math.round(sum(recs.map((r) => r.points)) / recs.length) : null });
const valid = (r: unknown): r is MomentRecord =>
  !!r && typeof r === "object" && typeof (r as MomentRecord).points === "number" && typeof (r as MomentRecord).id === "string";

/** Minimum answered moments before the stats say anything about style. */
export const MIN_FOR_INSIGHT = 5;
const MIN_PER_BUCKET = 2;

export function computeStats(days: Record<string, number[]>, moments: Record<string, MomentRecord[]>): Stats {
  const totals = Object.entries(days)
    .filter(([, p]) => Array.isArray(p) && p.length)
    .map(([date, p]) => ({ date, total: sum(p), points: p }));
  const allPoints = totals.flatMap((t) => t.points);
  let best: Stats["bestDay"] = null;
  for (const t of totals) if (!best || t.total > best.total || (t.total === best.total && t.date > best.date)) best = { date: t.date, total: t.total };

  const recs = Object.values(moments && typeof moments === "object" ? moments : {})
    .flatMap((l) => (Array.isArray(l) ? l : [])).filter(valid);
  const byZone = Object.fromEntries(ZONES.map((z) => [z, bucket(recs.filter((r) => r.zone === z))])) as Record<Zone, Bucket>;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, bucket(recs.filter((r) => r.kind === k))])) as Record<PickKind, Bucket>;
  const shotRecs = recs.filter((r) => r.kind === "shot");
  const reads = proReads(recs);
  const s: Stats = {
    games: totals.length, moments: recs.length,
    avgDay: totals.length ? Math.round(sum(totals.map((t) => t.total)) / totals.length) : null,
    bestDay: best,
    perfect: ratio(allPoints.filter((p) => p >= 100).length, allPoints.length),
    proInstinct: ratio(recs.filter((r) => r.pro_instinct).length, recs.length),
    aiAgree: ratio(recs.filter((r) => r.same_as_ai).length, recs.length),
    proRead: reads ? reads.right / reads.of : null, proReadN: reads?.of ?? 0,
    byZone, byKind,
    shots: { chosen: shotRecs.length, aiAgreed: shotRecs.filter((r) => r.same_as_ai).length },
    insight: "",
  };
  s.insight = insightFor(s);
  return s;
}

/** One line about the player's style, picked by simple rules in priority order. */
export function insightFor(s: Stats): string {
  if (s.games === 0) return "";
  if (s.moments < MIN_FOR_INSIGHT) {
    const left = MIN_FOR_INSIGHT - s.moments;
    return tn("insight.unlock", left);
  }
  // 1. shooting much more than the AI would
  const { chosen, aiAgreed } = s.shots;
  if (chosen >= 3 && aiAgreed * 2 < chosen)
    return t("insight.shots", { chosen, agreed: aiAgreed });
  // 2. a clear gap between the best and the worst third of the pitch
  const zones = ZONES.filter((z) => s.byZone[z].n >= MIN_PER_BUCKET && s.byZone[z].avg != null);
  if (zones.length >= 2) {
    const sorted = [...zones].sort((a, b) => s.byZone[b].avg! - s.byZone[a].avg!);
    const hi = sorted[0]!, lo = sorted[sorted.length - 1]!;
    const gap = s.byZone[hi].avg! - s.byZone[lo].avg!;
    if (gap >= 20)
      return t("insight.zones", { hi: t(`zonePhrase.${hi}`), hiAvg: s.byZone[hi].avg!, lo: t(`zonePhrase.${lo}`), loAvg: s.byZone[lo].avg!, advice: t(`zoneAdvice.${lo}`) });
  }
  // 3. carries well below passes
  const pass = s.byKind.pass, carry = s.byKind.carry;
  if (pass.n >= MIN_PER_BUCKET && carry.n >= MIN_PER_BUCKET && pass.avg! - carry.avg! >= 20)
    return t("insight.carries", { carry: carry.avg!, pass: pass.avg! });
  // 4. reading the pros (second question, objective: the real pass)
  if (s.proRead != null && s.proReadN >= MIN_FOR_INSIGHT) {
    const p = pct(s.proRead);
    if (s.proRead >= 0.6) return t("insight.readsHigh", { p });
    if (s.proRead <= 0.2) return t("insight.readsLow", { p });
  }
  // 5. strong reads
  if (s.proInstinct != null && s.proInstinct >= 0.5)
    return t("insight.instinct", { p: pct(s.proInstinct) });
  if (s.aiAgree != null && s.aiAgree >= 0.5)
    return t("insight.ai", { p: pct(s.aiAgree) });
  if (s.perfect != null && s.perfect >= 0.6) return t("insight.perfect", { p: pct(s.perfect) });
  return t("insight.balanced");
}
