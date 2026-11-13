// Team split from shirt colours: mean CIELAB colour of each player's torso, k-means (k = 2) (photo and live modes; the clip
// mode uses the grass-masked median features and the clip-wide model at the end of this file),
// plus an "other" label (referee, keeper, bad crop) for colours far from both team centres.

export type RGB = [number, number, number];
export type Lab = [number, number, number];
export type Box = { x: number; y: number; w: number; h: number }; // pixels, top-left origin
export type ImageLike = { data: ArrayLike<number>; width: number; height: number };

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0..255) to CIELAB (D65). */
export function rgbToLab([r, g, b]: RGB): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Torso crop: the upper-middle part of a person box (skips head, legs and most of the background). */
export function torsoBox(b: Box): Box {
  return { x: b.x + b.w * 0.25, y: b.y + b.h * 0.2, w: b.w * 0.5, h: b.h * 0.3 };
}

/** Mean colour of a region, ignoring grass-green pixels (hue ~ 70-170 deg, saturated) that leak into the crop. */
export function meanColour(img: ImageLike, region: Box): RGB | null {
  const x0 = Math.max(0, Math.floor(region.x)), y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(img.width, Math.ceil(region.x + region.w)), y1 = Math.min(img.height, Math.ceil(region.y + region.h));
  let r = 0, g = 0, b = 0, n = 0, ra = 0, ga = 0, ba = 0, na = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const R = img.data[i]!, G = img.data[i + 1]!, B = img.data[i + 2]!;
    ra += R; ga += G; ba += B; na++;
    if (isGrass(R, G, B)) continue;
    r += R; g += G; b += B; n++;
  }
  if (na === 0) return null;
  if (n < na * 0.15) return [ra / na, ga / na, ba / na]; // nearly all green: maybe a green kit, keep everything
  return [r / n, g / n, b / n];
}

export function isGrass(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 30 || g !== max) return false;
  const sat = (max - min) / max;
  return sat > 0.25 && g > r * 1.15 && g > b * 1.1;
}

export function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
}

/** Deterministic k-means: farthest-point initialisation, Lloyd iterations. */
export function kmeans(points: number[][], k: number, iters = 50): { centres: number[][]; labels: number[] } {
  if (points.length === 0) return { centres: [], labels: [] };
  k = Math.min(k, points.length);
  const dim = points[0]!.length;
  const mean = Array.from({ length: dim }, (_, d) => points.reduce((s, p) => s + p[d]!, 0) / points.length);
  // first centre: the point farthest from the mean; then repeatedly the point farthest from all chosen centres
  let first = 0;
  points.forEach((p, i) => { if (dist(p, mean) > dist(points[first]!, mean)) first = i; });
  const centres = [points[first]!.slice()];
  while (centres.length < k) {
    let best = 0, bestD = -1;
    points.forEach((p, i) => {
      const d = Math.min(...centres.map((c) => dist(p, c)));
      if (d > bestD) { bestD = d; best = i; }
    });
    centres.push(points[best]!.slice());
  }
  let labels = new Array<number>(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = points.map((p) => {
      let bi = 0;
      centres.forEach((c, i) => { if (dist(p, c) < dist(p, centres[bi]!)) bi = i; });
      return bi;
    });
    const changed = next.some((l, i) => l !== labels[i]);
    labels = next;
    for (let c = 0; c < k; c++) {
      const mine = points.filter((_, i) => labels[i] === c);
      if (mine.length) centres[c] = Array.from({ length: dim }, (_, d) => mine.reduce((s, p) => s + p[d]!, 0) / mine.length);
    }
    if (!changed && it > 0) break;
  }
  return { centres, labels };
}

export type TeamLabel = 0 | 1 | "other";
export type TeamSplit = { labels: TeamLabel[]; centres: Lab[]; separation: number; colours: RGB[] };

/**
 * Splits torso colours into two teams. A colour is "other" when it is much farther from its team centre than
 * the typical team member (> max(2.5 x median distance, 18 Lab units)): referees and keepers usually are.
 * With poor separation between the two centres (< 15 Lab units), the split is unreliable: `separation` reports it.
 */
export function splitTeams(colours: RGB[]): TeamSplit {
  const labs = colours.map(rgbToLab);
  if (labs.length < 2) return { labels: labs.map(() => 0 as const), centres: labs, separation: 0, colours };
  // first pass on everyone, then refit without the outliers so a referee does not drag a team centre
  let { centres, labels } = kmeans(labs, 2);
  const d = labs.map((p, i) => dist(p, centres[labels[i]!]!));
  const med = median(d);
  const cut = Math.max(2.5 * med, 18);
  const keep = labs.map((_, i) => d[i]! <= cut);
  if (keep.filter(Boolean).length >= 2) {
    const refit = kmeans(labs.filter((_, i) => keep[i]), 2);
    centres = refit.centres;
    labels = labs.map((p) => (dist(p, centres[0]!) <= dist(p, centres[1] ?? centres[0]!) ? 0 : 1));
  }
  const out: TeamLabel[] = labs.map((p, i) => (dist(p, centres[labels[i]!]!) > cut ? "other" : (labels[i] as 0 | 1)));
  // a "team" of one is more likely a referee or keeper than a team
  for (const t of [0, 1] as const) {
    const idx = out.map((l, i) => (l === t ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 1 && labs.length >= 6) out[idx[0]!] = "other";
  }
  const separation = centres.length === 2 ? dist(centres[0]!, centres[1]!) : 0;
  return { labels: out, centres: centres as Lab[], separation, colours };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---------- clip team model: grass-masked torso features, one 2-team model per clip, track voting ----------

/** Grass colour range of one frame (HSV: hue in degrees, saturation 0..1, value 0..255). */
export type GrassModel = { hueLo: number; hueHi: number; satMin: number; valMin: number };
export const DEFAULT_GRASS: GrassModel = { hueLo: 70, hueHi: 170, satMin: 0.25, valMin: 30 };

export function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  let h = 0;
  if (c > 0) h = max === r ? 60 * (((g - b) / c + 6) % 6) : max === g ? 60 * ((b - r) / c + 2) : 60 * ((r - g) / c + 4);
  return [h, max ? c / max : 0, max];
}

const quant = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]!; };

/**
 * Grass range estimated from the pitch area of the frame (the lower 3/4: above it is mostly stands and sky): the hue mode of
 * the loosely green pixels, then their 2nd-98th hue percentiles around it (+-6 deg) and low percentiles of saturation and
 * value. Falls back to DEFAULT_GRASS with fewer than 200 green samples.
 */
export function grassModel(img: ImageLike, step = 6): GrassModel {
  const hs: number[] = [], ss: number[] = [], vs: number[] = [];
  for (let y = Math.floor(img.height / 4); y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 4;
    const [h, s, v] = hsv(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
    if (h >= 50 && h <= 190 && s >= 0.15 && v >= 25) { hs.push(h); ss.push(s); vs.push(v); }
  }
  if (hs.length < 200) return DEFAULT_GRASS;
  const bins = new Array<number>(28).fill(0); // 5-degree bins over 50..190
  for (const h of hs) bins[Math.min(27, Math.floor((h - 50) / 5))]!++;
  const mode = 50 + 5 * bins.indexOf(Math.max(...bins)) + 2.5;
  const near = hs.map((h, i) => ({ h, s: ss[i]!, v: vs[i]! })).filter((p) => Math.abs(p.h - mode) <= 40);
  if (near.length < 100) return DEFAULT_GRASS;
  return {
    hueLo: Math.max(45, quant(near.map((p) => p.h), 0.02) - 6), hueHi: Math.min(195, quant(near.map((p) => p.h), 0.98) + 6),
    satMin: Math.max(0.12, 0.8 * quant(near.map((p) => p.s), 0.05)), valMin: Math.max(15, 0.7 * quant(near.map((p) => p.v), 0.03)),
  };
}

export function isGrassIn(m: GrassModel, r: number, g: number, b: number): boolean {
  const [h, s, v] = hsv(r, g, b);
  return h >= m.hueLo && h <= m.hueHi && s >= m.satMin && v >= m.valMin;
}

/**
 * Torso colour descriptor: lab = per-channel median CIELAB of the shirt pixels left once grass is masked out; hist = the
 * a*b* histogram of those pixels (abHist); kept = share of crop pixels kept; w = quality weight
 * in 0..1 (pixels kept, box height, kept share); allGrass: almost nothing survived the mask (a green kit? all pixels used).
 */
export type ColourFeat = { lab: Lab; hist: number[]; kept: number; w: number; allGrass: boolean };
/**
 * 5 x 5 a*b* histogram, bins 20 units wide centred on -40, -20, 0, 20, 40 (clamped), bilinear votes, sums to 1. The middle
 * bin is centred on the neutral axis so white, grey and black kits do not straddle a bin edge.
 */
export const AB_BINS = 5;
export function abHist(labs: Lab[]): number[] {
  const h = new Array<number>(AB_BINS * AB_BINS).fill(0);
  if (!labs.length) return h;
  const split = (v: number): [number, number, number] => {
    const u = Math.min(AB_BINS - 1, Math.max(0, (v + 50) / 20 - 0.5)), i = Math.min(AB_BINS - 2, Math.floor(u));
    return [i, i + 1, u - i];
  };
  for (const p of labs) {
    const [a0, a1, fa] = split(p[1]), [b0, b1, fb] = split(p[2]);
    h[a0 * AB_BINS + b0]! += (1 - fa) * (1 - fb); h[a0 * AB_BINS + b1]! += (1 - fa) * fb;
    h[a1 * AB_BINS + b0]! += fa * (1 - fb); h[a1 * AB_BINS + b1]! += fa * fb;
  }
  return h.map((v) => v / labs.length);
}

/** Shirt crop of a person box (narrower than torsoBox: less background at the sides). */
export function shirtBox(b: Box): Box {
  return { x: b.x + b.w * 0.28, y: b.y + b.h * 0.18, w: b.w * 0.44, h: b.h * 0.3 };
}

export function torsoFeature(img: ImageLike, box: Box, grass: GrassModel = DEFAULT_GRASS): ColourFeat | null {
  const r = shirtBox(box);
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.w)), y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  const keep: Lab[] = [], all: Lab[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const R = img.data[i]!, G = img.data[i + 1]!, B = img.data[i + 2]!;
    const lab = rgbToLab([R, G, B]);
    all.push(lab);
    if (!isGrassIn(grass, R, G, B)) keep.push(lab);
  }
  if (!all.length) return null;
  const allGrass = keep.length < Math.max(3, 0.15 * all.length);
  const px = allGrass ? all : keep;
  const lab = [0, 1, 2].map((c) => quant(px.map((p) => p[c]!), 0.5)) as Lab;
  const hist = abHist(px);
  const kept = keep.length / all.length;
  const w = Math.min(1, px.length / 60) * Math.min(1, Math.max(0.2, box.h / 50)) * (allGrass ? 0.3 : Math.min(1, Math.max(0.3, kept / 0.5)));
  return { lab, hist, kept, w, allGrass };
}

/**
 * histW: weight of the histogram term (half L1 distance 0..1 times histW, in Lab units); lW: weight of the L* difference
 * (shading moves L* more than the chroma); cutK / cutMin: a sample farther than max(cutK x the team's weighted median
 * distance, cutMin) from its team centre is "other" (keeper, referee, bad crop); margin: relative margin
 * (d2 - d1) / (d2 + d1) under which a label is a near-tie; minSamples: samples needed to fit; best: share of the samples
 * (highest weights) used for the fit; refitMove: after a cut, refit when the samples of the new shot sit farther than this
 * many x the fitted spread from the centres (the light or the kits clearly changed); prior: vote weight of the spatial prior
 * on near-ties; override: a detection shows its own label instead of its track's when it is a clear team colour (margin >=
 * override): the tracker mixed two people in that track. (Not for "other": a dark or blurred crop of a player is often
 * beyond the cut, and the track vote handles it better.)
 */
export const TEAM_MODEL = { histW: 25, lW: 0.6, cutK: 3, cutMin: 14, margin: 0.12, minSamples: 12, best: 0.6, refitMove: 2.5, prior: 0.5, override: 0.35 };
export type TeamModelOpts = typeof TEAM_MODEL;

export type TeamModel = { centres: [Lab, Lab]; hists: [number[], number[]]; spread: [number, number]; cut: [number, number]; separation: number; other: Lab | null };

const histDist = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - (b[i] ?? 0)); return s / 2; };
/** Distance of a feature to a centre: weighted Lab (L* down-weighted) + histogram term. */
export function featDist(f: Pick<ColourFeat, "lab" | "hist">, lab: Lab, hist: number[] | null, o: TeamModelOpts = TEAM_MODEL): number {
  const d = Math.sqrt((o.lW * (f.lab[0] - lab[0])) ** 2 + (f.lab[1] - lab[1]) ** 2 + (f.lab[2] - lab[2]) ** 2);
  return d + (hist ? o.histW * histDist(f.hist, hist) : 0);
}

function wMedian(xs: number[], ws: number[]): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const tot = ws.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of idx) { acc += ws[i]!; if (acc >= tot / 2) return xs[i]!; }
  return idx.length ? xs[idx[idx.length - 1]!]! : 0;
}
function wMeanLab(fs: ColourFeat[]): Lab {
  const W = fs.reduce((a, f) => a + f.w, 0) || 1;
  return [0, 1, 2].map((c) => fs.reduce((a, f) => a + f.w * f.lab[c]!, 0) / W) as Lab;
}
function wMeanHist(fs: ColourFeat[]): number[] {
  const W = fs.reduce((a, f) => a + f.w, 0) || 1;
  return Array.from({ length: AB_BINS * AB_BINS }, (_, k) => fs.reduce((a, f) => a + f.w * f.hist[k]!, 0) / W);
}

/** Weighted 2-means on the samples (robust farthest-pair initialisation among the heavier half, Lloyd iterations). */
function twoMeans(fs: ColourFeat[], o: TeamModelOpts): { centres: Lab[]; hists: number[][]; labels: number[] } {
  const heavy = [...fs].sort((a, b) => b.w - a.w).slice(0, Math.max(2, Math.ceil(fs.length / 2)));
  // init: each heavy sample pulled to the mean of its 4 nearest heavy neighbours (a lone referee then lands inside a
  // crowd and loses its pull), then the two such seeds farthest apart
  const seeds = heavy.map((s) => {
    const nn = [...heavy].sort((x, y) => featDist(x, s.lab, s.hist, o) - featDist(y, s.lab, s.hist, o)).slice(0, 4);
    return { lab: wMeanLab(nn), hist: wMeanHist(nn) };
  });
  let a = 0, b = 1, bd = -1;
  seeds.forEach((p, i) => seeds.forEach((q, j) => { const d = featDist(p, q.lab, q.hist, o); if (d > bd) { bd = d; a = i; b = j; } }));
  let cs = [seeds[a]!, seeds[b]!];
  let labels = fs.map(() => -1);
  for (let it = 0; it < 30; it++) {
    const next = fs.map((f) => (featDist(f, cs[0]!.lab, cs[0]!.hist, o) <= featDist(f, cs[1]!.lab, cs[1]!.hist, o) ? 0 : 1));
    const same = next.every((l, i) => l === labels[i]);
    labels = next;
    if (same) break;
    cs = [0, 1].map((t) => { const m = fs.filter((_, i) => labels[i] === t); return m.length ? { lab: wMeanLab(m), hist: wMeanHist(m) } : cs[t]!; });
  }
  return { centres: cs.map((c) => c.lab), hists: cs.map((c) => c.hist), labels };
}

/**
 * Fits the two team centroids on the best samples (highest quality weights): 2-means, then the samples beyond each team's
 * cut are set aside as "other" (keepers, referees, bad crops) and the centroids refitted without them (up to 3 rounds).
 * The mean of the outliers is kept as the "other" colour when there are at least 2. Null with fewer than minSamples
 * usable samples or a team of fewer than 2.
 */
export function fitTeamModel(samples: ColourFeat[], o: TeamModelOpts = TEAM_MODEL): TeamModel | null {
  const good = samples.filter((s) => s.w > 0 && !s.allGrass);
  if (good.length < o.minSamples) return null;
  // the best samples: weight at least the (1 - best) quantile (equal weights all stay), at least minSamples of them
  const thr = Math.min(quant(good.map((g) => g.w), 1 - o.best), [...good].sort((a, b) => b.w - a.w)[o.minSamples - 1]!.w);
  const fs = good.filter((g) => g.w >= thr);
  let use = fs, model: TeamModel | null = null;
  for (let round = 0; round < 3; round++) {
    const km = twoMeans(use, o);
    const members = [0, 1].map((t) => use.filter((_, i) => km.labels[i] === t));
    if (members.some((m) => m.length < 2)) break;
    const spread = members.map((m, t) => wMedian(m.map((f) => featDist(f, km.centres[t] as Lab, km.hists[t]!, o)), m.map((f) => f.w))) as [number, number];
    const cut = spread.map((s) => Math.max(o.cutK * s, o.cutMin)) as [number, number];
    model = { centres: km.centres as [Lab, Lab], hists: km.hists as [number[], number[]], spread, cut, separation: dist(km.centres[0]!, km.centres[1]!), other: null };
    const m = model;
    const inl = fs.filter((f) => classifyFeat(f, m, o).team !== "other");
    if (inl.length === use.length) break;
    use = inl;
  }
  if (!model) return null;
  const m = model;
  const out = fs.filter((f) => classifyFeat(f, m, o).team === "other");
  if (out.length >= 2) model.other = wMeanLab(out);
  return model;
}

export type FeatLabel = { team: TeamLabel; best: 0 | 1; margin: number; d: [number, number] };
/** Nearest centroid; "other" beyond that team's cut. margin = (d2 - d1) / (d2 + d1): near 0 = a near-tie. */
export function classifyFeat(f: Pick<ColourFeat, "lab" | "hist">, m: TeamModel, o: TeamModelOpts = TEAM_MODEL): FeatLabel {
  const d = [0, 1].map((t) => featDist(f, m.centres[t]!, m.hists[t]!, o)) as [number, number];
  const best: 0 | 1 = d[0] <= d[1] ? 0 : 1, other = (1 - best) as 0 | 1;
  const margin = (d[other] - d[best]) / Math.max(1e-6, d[other] + d[best]);
  return { team: d[best] > m.cut[best] ? "other" : best, best, margin, d };
}

/** One detection of the clip for the final labelling: its track, shot (segment between cuts), frame, feature, pitch x. */
export type ClipDet = { id: number; seg: number; frame: number; feat: ColourFeat; x: number | null; good: boolean };

/**
 * Votes of one track: [A, B, other], each detection weighted by its quality and its margin (a near-tie counts little);
 * on near-ties the spatial prior (-1..1, positive towards A) adds prior x o.prior x weight to the team it favours.
 */
export type TrackVotes = [number, number, number];
export function addVote(v: TrackVotes, l: FeatLabel, w: number, prior = 0, o: TeamModelOpts = TEAM_MODEL): TrackVotes {
  const out = [...v] as TrackVotes;
  if (l.team === "other") { out[2] += w; return out; }
  out[l.team] += w * Math.min(1, 0.2 + l.margin / 0.3);
  if (l.margin < o.margin && prior) out[prior > 0 ? 0 : 1] += w * o.prior * Math.min(1, Math.abs(prior));
  return out;
}
/** Track label: "other" only when it outweighs both teams; ties go to A. */
export function trackLabel(v: TrackVotes): TeamLabel {
  return v[2] > v[0] && v[2] > v[1] ? "other" : v[0] >= v[1] ? 0 : 1;
}

/**
 * Spatial prior of a detection at pitch x: (|x - mean x of B| - |x - mean x of A|) / |mean A - mean B|, clamped to -1..1
 * (positive: nearer the A players). Zero when the two means are closer than 5 m (no separation to use).
 */
export function spatialPrior(x: number | null, meanA: number | null, meanB: number | null): number {
  if (x === null || meanA === null || meanB === null || Math.abs(meanA - meanB) < 5) return 0;
  return Math.max(-1, Math.min(1, (Math.abs(x - meanB) - Math.abs(x - meanA)) / Math.abs(meanA - meanB)));
}

/**
 * Labels a whole clip: the model is fitted once on the best samples (good calibration, highest weights) and kept fixed;
 * after a cut it is refitted on that shot only if its samples clearly moved away (weighted median distance > refitMove x
 * spread), the new centroids keeping the A/B order of the old ones. Each detection gets the nearest centroid (margin and
 * cut), each track the weighted majority of its detections; near-ties get the spatial prior of their frame. Returns the
 * label per track id, the colour label per detection, the label to show per detection (its track's, unless the detection
 * is clearly something else: see TEAM_MODEL.override), the model and the number of refits.
 */
export function labelClip(dets: ClipDet[], o: TeamModelOpts = TEAM_MODEL, usePrior = true):
  { model: TeamModel | null; byTrack: Map<number, TeamLabel>; perDet: FeatLabel[]; final: TeamLabel[]; refits: number } {
  const goodFs = dets.filter((d) => d.good).map((d) => d.feat);
  const model = fitTeamModel(goodFs.filter((f) => !f.allGrass).length >= o.minSamples ? goodFs : dets.map((d) => d.feat), o);
  if (!model) return { model: null, byTrack: new Map(), perDet: [], final: dets.map(() => "other"), refits: 0 };
  const segModel = new Map<number, TeamModel>();
  let refits = 0;
  for (const seg of new Set(dets.map((d) => d.seg))) {
    const fs = dets.filter((d) => d.seg === seg && !d.feat.allGrass).map((d) => d.feat);
    segModel.set(seg, model);
    if (fs.length < o.minSamples) continue;
    const near = wMedian(fs.map((f) => Math.min(...classifyFeat(f, model, o).d)), fs.map((f) => f.w));
    if (near <= o.refitMove * Math.max(model.spread[0], model.spread[1], 3)) continue;
    const m2 = fitTeamModel(fs, o);
    if (!m2) continue;
    const keep = dist(m2.centres[0], model.centres[0]) + dist(m2.centres[1], model.centres[1]) <= dist(m2.centres[0], model.centres[1]) + dist(m2.centres[1], model.centres[0]);
    segModel.set(seg, keep ? m2 : { ...m2, centres: [m2.centres[1], m2.centres[0]], hists: [m2.hists[1], m2.hists[0]], spread: [m2.spread[1], m2.spread[0]], cut: [m2.cut[1], m2.cut[0]] });
    refits++;
  }
  const perDet = dets.map((d) => classifyFeat(d.feat, segModel.get(d.seg)!, o));
  // spatial prior: per frame, the mean x of the confident A and B detections (at least 3 each)
  const means = new Map<number, [number | null, number | null]>();
  if (usePrior) {
    const acc = new Map<number, number[][]>();
    dets.forEach((d, i) => {
      const l = perDet[i]!;
      if (d.x === null || l.team === "other" || l.margin < o.margin) return;
      if (!acc.has(d.frame)) acc.set(d.frame, [[], []]);
      acc.get(d.frame)![l.team]!.push(d.x);
    });
    for (const [fr, xs] of acc) means.set(fr, xs.map((v) => (v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null)) as [number | null, number | null]);
  }
  const votes = new Map<number, TrackVotes>();
  dets.forEach((d, i) => {
    const m = means.get(d.frame);
    const prior = m ? spatialPrior(d.x, m[0], m[1]) : 0;
    votes.set(d.id, addVote(votes.get(d.id) ?? [0, 0, 0], perDet[i]!, Math.max(0.05, d.feat.w), prior, o));
  });
  const byTrack = new Map<number, TeamLabel>();
  for (const [id, v] of votes) byTrack.set(id, trackLabel(v));
  const final = dets.map((d, i) => {
    const l = perDet[i]!;
    return !d.feat.allGrass && l.team !== "other" && l.margin >= o.override ? l.team : byTrack.get(d.id)!;
  });
  return { model, byTrack, perDet, final, refits };
}

/** CIELAB (D65) back to sRGB 0..255 (clamped), to show a centroid. */
export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const g = (v: number) => 255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  return [g(R), g(G), g(B)];
}
