// Stage timings of the clip loop (and the detector passes it calls): accumulated ms and call counts per named stage, so
// the benchmark (scripts/cv-bench/clip-run.mjs reads window.__clipProf) can report where a frame's time goes. Pure
// accumulator plus one module-level instance; costs a performance.now() pair per timed call.

export type StageStat = { ms: number; n: number };
export type Prof = Record<string, StageStat>;

export function newProf(): Prof { return {}; }

/** Adds `ms` (and `n` calls) to a stage. */
export function addTime(p: Prof, stage: string, ms: number, n = 1): Prof {
  const s = p[stage] ?? (p[stage] = { ms: 0, n: 0 });
  s.ms += ms; s.n += n;
  return p;
}

/** Per-stage summary over `frames` frames: total ms, ms per frame, calls per frame, ms per call; slowest first. */
export function profSummary(p: Prof, frames: number): { stage: string; ms: number; msPerFrame: number; perFrame: number; msPerCall: number }[] {
  const f = Math.max(1, frames);
  return Object.entries(p)
    .map(([stage, s]) => ({ stage, ms: s.ms, msPerFrame: s.ms / f, perFrame: s.n / f, msPerCall: s.n ? s.ms / s.n : 0 }))
    .sort((a, b) => b.ms - a.ms);
}

/** The running instance (reset by the clip loop at the start of a clip). */
export let labProf: Prof = newProf();
export function resetProf(): Prof {
  labProf = newProf();
  (globalThis as { __clipProf?: Prof }).__clipProf = labProf;
  return labProf;
}

/** Times a synchronous call into `stage` of the running instance. */
export function timed<T>(stage: string, fn: () => T): T {
  const t0 = performance.now();
  try { return fn(); } finally { addTime(labProf, stage, performance.now() - t0); }
}
