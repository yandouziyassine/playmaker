// Team split from shirt colours: mean CIELAB colour of each player's torso, k-means (k = 2),
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
