// Planar homography by normalised DLT (Hartley), solved with our own Gaussian elimination.
// Pure functions, no DOM: unit-tested in app/test/lab-homography.test.ts.

export type Pt = { x: number; y: number };
/** Row-major 3x3 matrix: [h11, h12, h13, h21, h22, h23, h31, h32, h33]. */
export type Mat3 = number[];

/** Solves A x = b (A is n x n, row-major arrays) with partial pivoting. Returns null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const pr = M[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!;
      const f = row[col]! / pr[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * pr[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = M[r]!;
    let s = row[n]!;
    for (let c = r + 1; c < n; c++) s -= row[c]! * x[c]!;
    x[r] = s / row[r]!;
  }
  return x;
}

/** Similarity transform moving the centroid to 0 and the mean distance to sqrt(2). */
function normaliser(pts: Pt[]): Mat3 {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

export function mul3(A: Mat3, B: Mat3): Mat3 {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[i * 3 + k]! * B[k * 3 + j]!;
    C[i * 3 + j] = s;
  }
  return C;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

/** Maps a point through H. Returns null when the point lands on/behind the line at infinity. */
export function applyH(H: Mat3, p: Pt): Pt | null {
  const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
  if (Math.abs(w) < 1e-12) return null;
  return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
}

/** Sign of w for a point (useful to reject points on the far side of the horizon). */
export function wOf(H: Mat3, p: Pt): number {
  return H[6]! * p.x + H[7]! * p.y + H[8]!;
}

/** Rescales H (by -1 if needed) so that w > 0 at a point known to be valid, e.g. a calibration point. */
export function orientH(H: Mat3, valid: Pt): Mat3 {
  return wOf(H, valid) < 0 ? H.map((v) => -v) : H;
}

/**
 * Homography H with dst ~ H src, from >= 4 correspondences (h33 fixed to 1).
 * Exactly 4 points: the 8x8 system is solved directly; more points: least squares via the normal equations.
 * Returns null for degenerate input (e.g. 3 collinear points).
 */
export function computeHomography(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length !== dst.length || src.length < 4) return null;
  const Ts = normaliser(src), Td = normaliser(dst);
  const s = src.map((p) => applyH(Ts, p)!), d = dst.map((p) => applyH(Td, p)!);
  const rows: number[][] = [], rhs: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const { x, y } = s[i]!, { x: u, y: v } = d[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
  }
  let A = rows, b = rhs;
  if (rows.length > 8) { // normal equations A^T A h = A^T b
    A = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => rows.reduce((acc, r) => acc + r[i]! * r[j]!, 0)));
    b = Array.from({ length: 8 }, (_, i) => rows.reduce((acc, r, k) => acc + r[i]! * rhs[k]!, 0));
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  const Hn: Mat3 = [...h, 1];
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  const H = mul3(TdInv, mul3(Hn, Ts));
  const k = H[8]!;
  if (Math.abs(k) < 1e-15) return H;
  const out = H.map((v) => v / k);
  return out.every(Number.isFinite) ? out : null;
}

/** Mean distance between H(src) and dst (in dst units). */
export function reprojectionError(H: Mat3, src: Pt[], dst: Pt[]): number {
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    const p = applyH(H, src[i]!);
    s += p ? Math.hypot(p.x - dst[i]!.x, p.y - dst[i]!.y) : Infinity;
  }
  return s / src.length;
}

/** True if any 3 of the 4 points are (nearly) collinear, relative to their spread. */
export function hasCollinearTriple(pts: Pt[], tol = 1e-3): boolean {
  const span = Math.max(1e-9, ...pts.flatMap((a) => pts.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const a = pts[i]!, b = pts[j]!, c = pts[k]!;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area / (span * span) < tol) return true;
  }
  return false;
}
