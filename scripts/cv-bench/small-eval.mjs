// Small-player experiment (app/src/lab/scaletile.ts): scores configs on the randomised set (robust-data) and/or the original
// 60 frames (data), and prints recall by size bucket and by condition, precision, F1 and passes; timing with --jobs 1.
//   node scripts/cv-bench/small-eval.mjs --configs default,small [--set robust|orig|both] [--n 148] [--jobs 6] [--port 5193]
//   [--out file.json] (default scripts/cv-bench/small-results.json, merged by set and config name)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGS, runBench } from "./run.mjs";
import { aggregate, byCondition } from "./robust.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const configs = Object.fromEntries(opt("configs", "default,small").split(",").map((k) => { if (!CONFIGS[k]) throw new Error(`unknown config ${k}`); return [k, CONFIGS[k]]; }));
const set = opt("set", "both"), jobs = Number(opt("jobs", 6)), port = Number(opt("port", 5193)), n = Number(opt("n", 1e9));
const OUT = opt("out", join(here, "small-results.json"));
const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const pct = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) : "–");

function bySize(scores) {
  const o = {};
  for (const b of ["small", "medium", "large"]) {
    let t = 0, f = 0;
    for (const s of scores) { t += s.buckets[b].targets; f += s.buckets[b].found; }
    o[b] = { targets: t, recall: t ? f / t : NaN };
  }
  return o;
}

for (const name of set === "both" ? ["robust", "orig"] : [set]) {
  const dataDir = join(here, name === "robust" ? "robust-data" : "data");
  const gt = JSON.parse(readFileSync(join(dataDir, "gt.json"), "utf8"));
  const frames = gt.frames.slice(0, n);
  const { results, perFrame } = await runBench({ dataDir, frames, configs, port, jobs, log: () => {} });
  store[name] = store[name] ?? {};
  for (const c of Object.keys(configs)) {
    const sc = perFrame[c];
    const entry = { settings: configs[c], frames: frames.length, jobs, all: aggregate(sc), size: bySize(sc), msMedian: results[c].ms.median, msMean: results[c].ms.mean, passes: results[c].passes, cond: name === "robust" ? byCondition(frames, sc) : undefined };
    store[name][c] = entry;
    const a = entry.all;
    console.log(`${name} ${c}: recall ${pct(a.recall)} prec ${pct(a.precision)} F1 ${pct(a.f1)} | small ${pct(entry.size.small.recall)} med ${pct(entry.size.medium.recall)} large ${pct(entry.size.large.recall)} | ${entry.passes.toFixed(1)} passes, ${Math.round(entry.msMedian)} ms median (jobs ${jobs})`);
    if (entry.cond) for (const dim of ["cam", "blur", "kitSim"]) console.log(`   ${dim}: ${Object.entries(entry.cond[dim]).map(([k, v]) => `${k} ${pct(v.recall)}/${pct(v.precision)}`).join(", ")}`);
  }
}
writeFileSync(OUT, JSON.stringify(store, null, 1));
console.log(`wrote ${OUT}`);
