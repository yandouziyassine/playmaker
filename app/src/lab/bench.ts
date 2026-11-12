// Benchmark glue: runs the Lab's real detection pipeline (detector.ts, teams.ts, players.ts) on a benchmark frame inside the
// browser (scripts/cv-bench/run.mjs drives it in headless Chromium through the Vite dev server), and the pure metric
// functions (matching at IoU 0.5 by size bucket, feet error through the ground-truth homography, team purity), which are
// unit-tested in app/test/lab-bench.test.ts.
import { detectPeople, iou, type DetectRun } from "./detector.ts";
import { applyH, invert3, type Mat3 } from "./homography.ts";
import { feet, type Person } from "./players.ts";
import { meanColour, splitTeams, torsoBox, type RGB, type TeamLabel } from "./teams.ts";
import type { DetectorSettings } from "./settings.ts";

export type GtPlayer = { id: number; team: number; role: "player" | "keeper" | "ref"; pos: number[]; feet: number[]; box: number[]; hPx: number; inFrame: number; occluded: number };
export type GtFrame = { id: string; view: string; H: Mat3; players: GtPlayer[]; ball: { pos: number[]; box: number[] } | null };

export type SizeBucket = "small" | "medium" | "large";
export const bucketOf = (hPx: number): SizeBucket => (hPx < 40 ? "small" : hPx < 90 ? "medium" : "large");
/** Ground truth that the detector is expected to find: mostly in the frame and not mostly hidden. */
export const isTarget = (p: GtPlayer): boolean => p.inFrame >= 0.5 && p.occluded < 0.6;

export type FrameScore = {
  id: string; view: string; ms: number; passes: number;
  /** Per bucket: targets, found targets, and detections matched to any (even ignored) truth vs. false positives. */
  buckets: Record<SizeBucket, { targets: number; found: number }>;
  detections: number; falsePositives: number;
  feetErr: number[]; feetDy: number[];
  ballTarget: boolean; ballFound: boolean;
  /** team purity among matched outfield players labelled 0/1 (best of the two team <-> cluster mappings) */
  teamMatched: number; teamCorrect: number; othersFlagged: number; othersTotal: number;
};

const asBox = (b: number[]) => ({ x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! });

/** Greedy matching, best IoU first, one detection per truth. Returns truth index -> detection index. */
export function matchBoxes(gt: number[][], dets: { box: { x: number; y: number; w: number; h: number } }[], thr = 0.5): Map<number, number> {
  const pairs: { g: number; d: number; v: number }[] = [];
  gt.forEach((b, g) => dets.forEach((d, i) => { const v = iou(asBox(b), d.box); if (v >= thr) pairs.push({ g, d: i, v }); }));
  pairs.sort((a, b) => b.v - a.v);
  const out = new Map<number, number>(), used = new Set<number>();
  for (const p of pairs) if (!out.has(p.g) && !used.has(p.d)) { out.set(p.g, p.d); used.add(p.d); }
  return out;
}

/** Scores one frame: detections and team labels against the ground truth. Pure. */
export function scoreFrame(gt: GtFrame, run: Pick<DetectRun, "persons" | "balls" | "ms" | "passes">, labels: TeamLabel[]): FrameScore {
  const m = matchBoxes(gt.players.map((p) => p.box), run.persons);
  const inv = invert3(gt.H);
  const s: FrameScore = {
    id: gt.id, view: gt.view, ms: run.ms, passes: run.passes,
    buckets: { small: { targets: 0, found: 0 }, medium: { targets: 0, found: 0 }, large: { targets: 0, found: 0 } },
    detections: run.persons.length, falsePositives: run.persons.length - m.size,
    feetErr: [], feetDy: [], ballTarget: !!gt.ball, ballFound: false, teamMatched: 0, teamCorrect: 0, othersFlagged: 0, othersTotal: 0,
  };
  const votes = [[0, 0], [0, 0]]; // votes[gtTeam][label]
  gt.players.forEach((p, g) => {
    const d = m.get(g);
    if (isTarget(p)) {
      const b = s.buckets[bucketOf(p.hPx)];
      b.targets++;
      if (d !== undefined) b.found++;
    }
    if (d === undefined) return;
    const det = run.persons[d]!, f = feet(det.box);
    const q = inv ? applyH(inv, f) : null;
    if (q && isTarget(p)) {
      s.feetErr.push(Math.hypot(q.x - p.pos[0]!, q.y - p.pos[1]!));
      s.feetDy.push((f.y - p.feet[1]!) / p.hPx);
    }
    const l = labels[d];
    if (p.role === "player") { if (l === 0 || l === 1) votes[p.team]![l]!++; }
    else { s.othersTotal++; if (l === "other") s.othersFlagged++; }
  });
  const same = votes[0]![0]! + votes[1]![1]!, swapped = votes[0]![1]! + votes[1]![0]!;
  s.teamMatched = same + swapped; s.teamCorrect = Math.max(same, swapped);
  if (gt.ball) s.ballFound = run.balls.some((b) => iou(asBox(gt.ball!.box), b.box) >= 0.3);
  return s;
}

export type Summary = {
  frames: number; ms: { mean: number; median: number }; passes: number;
  recall: Record<SizeBucket | "all", number>; precision: number; targets: Record<SizeBucket | "all", number>;
  ballRecall: number; feetMedianM: number; feetP90M: number; feetDyMedian: number; teamPurity: number; othersFlagged: number;
  byView: Record<string, { recall: number; precision: number }>;
};

export const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
};

export function summarise(fs: FrameScore[]): Summary {
  const sum = (f: (s: FrameScore) => number) => fs.reduce((a, s) => a + f(s), 0);
  const buckets: SizeBucket[] = ["small", "medium", "large"];
  const recall = {} as Summary["recall"], targets = {} as Summary["targets"];
  let T = 0, F = 0;
  for (const b of buckets) {
    const t = sum((s) => s.buckets[b].targets), f = sum((s) => s.buckets[b].found);
    recall[b] = t ? f / t : NaN; targets[b] = t; T += t; F += f;
  }
  recall.all = T ? F / T : NaN; targets.all = T;
  const dets = sum((s) => s.detections), fp = sum((s) => s.falsePositives);
  const byView: Summary["byView"] = {};
  for (const v of new Set(fs.map((s) => s.view))) {
    const vs = fs.filter((s) => s.view === v);
    const t = vs.reduce((a, s) => a + buckets.reduce((x, b) => x + s.buckets[b].targets, 0), 0);
    const f = vs.reduce((a, s) => a + buckets.reduce((x, b) => x + s.buckets[b].found, 0), 0);
    const d = vs.reduce((a, s) => a + s.detections, 0), p = vs.reduce((a, s) => a + s.falsePositives, 0);
    byView[v] = { recall: t ? f / t : NaN, precision: d ? (d - p) / d : NaN };
  }
  const ballT = fs.filter((s) => s.ballTarget).length;
  const errs = fs.flatMap((s) => s.feetErr), dys = fs.flatMap((s) => s.feetDy);
  const tm = sum((s) => s.teamMatched), tc = sum((s) => s.teamCorrect), ot = sum((s) => s.othersTotal), of = sum((s) => s.othersFlagged);
  return {
    frames: fs.length, ms: { mean: sum((s) => s.ms) / fs.length, median: quantile(fs.map((s) => s.ms), 0.5) }, passes: sum((s) => s.passes) / fs.length,
    recall, precision: dets ? (dets - fp) / dets : NaN, targets, ballRecall: ballT ? fs.filter((s) => s.ballFound).length / ballT : NaN,
    feetMedianM: quantile(errs, 0.5), feetP90M: quantile(errs, 0.9), feetDyMedian: quantile(dys, 0.5),
    teamPurity: tm ? tc / tm : NaN, othersFlagged: ot ? of / ot : NaN, byView,
  };
}

// ---------- browser side ----------

/** Loads a PNG into a canvas. */
export async function loadFrame(url: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c;
}

/** The Lab pipeline on one frame: detection (tiled), torso colours, team split. */
export async function runFrame(src: HTMLCanvasElement, s: DetectorSettings, tiled = true): Promise<{ run: DetectRun; labels: TeamLabel[]; colours: (RGB | null)[] }> {
  const run = await detectPeople(src, tiled, s);
  const data = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
  const colours = run.persons.map((p: Person) => meanColour(data, torsoBox(p.box)));
  const valid = colours.map((c, i) => ({ c, i })).filter((x): x is { c: RGB; i: number } => !!x.c);
  const split = splitTeams(valid.map((v) => v.c));
  const labels: TeamLabel[] = colours.map(() => "other");
  valid.forEach((v, k) => { labels[v.i] = split.labels[k]!; });
  return { run, labels, colours };
}

/** One benchmark frame end to end (called from run.mjs through page.evaluate). */
export async function benchFrame(url: string, gt: GtFrame, s: DetectorSettings, tiled = true): Promise<FrameScore & { persons: Person[] }> {
  const src = await loadFrame(url);
  const { run, labels } = await runFrame(src, s, tiled);
  return { ...scoreFrame(gt, run, labels), persons: run.persons };
}
