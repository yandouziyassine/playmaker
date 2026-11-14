// Robustness benchmark: renders domain-randomised frames (render.mjs --random: lighting, white balance, grass, hard kit pairs,
// low / high / zoomed cameras, motion blur, JPEG, graphics, crowd) and scores the Lab pipeline per condition bucket.
//   node scripts/cv-bench/robust.mjs [--n 150] [--seed 1] [--configs default,lite2] [--jobs 4] [--port 5197] [--orig] [--rerender]
//   [--filter light=night]: only the frames of one bucket; stored under "subsets" (the per-condition tables are untouched).
// --orig also scores the same configs on the original 60-frame set (scripts/cv-bench/data), so a settings change can be
// checked for regressions there. Results merge into scripts/cv-bench/robust-results.json (by config name) and the tables
// between the markers of docs/cv-robustness.md are regenerated. Frames: scripts/cv-bench/robust-data/ (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./render.mjs";
import { CONFIGS, runBench, table } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("n", 150)), SEED = Number(opt("seed", 1)), JOBS = Number(opt("jobs", 4)), PORT = Number(opt("port", 5197));
const DATA = join(here, "robust-data"), RESULTS = join(here, "robust-results.json"), DOC = join(root, "docs", "cv-robustness.md");
const configs = Object.fromEntries(opt("configs", "default,lite2").split(",").map((k) => { if (!CONFIGS[k]) throw new Error(`unknown config ${k}`); return [k, CONFIGS[k]]; }));

/** Condition dimensions reported (gt.json `cond` keys) and the order of their buckets. */
export const DIMS = {
  light: ["day", "overcast", "night"],
  expo: ["under", "normal", "over"],
  kitSim: ["distinct", "similar", "grass"],
  cam: ["far", "high", "main", "low", "zoom", "endzone"],
  blur: ["low", "mid", "high"],
  compression: ["light", "heavy"],
  overlay: ["none", "score", "ticker", "score+ticker"],
  crowd: ["sparse", "medium", "dense"],
  crowdPal: ["mixed", "dark", "kit"],
  mow: ["none", "vertical", "horizontal", "checker"],
  grass: ["lush", "yellow", "dark", "blue", "worn"],
};

/** Aggregates per-frame scores (run.mjs perFrame) into recall / precision / ball / team purity. Pure. */
export function aggregate(scores) {
  let t = 0, f = 0, ts = 0, fs = 0, dets = 0, fp = 0, bt = 0, bf = 0, tm = 0, tc = 0;
  for (const s of scores) {
    for (const [k, b] of Object.entries(s.buckets)) { t += b.targets; f += b.found; if (k === "small") { ts += b.targets; fs += b.found; } }
    dets += s.detections; fp += s.falsePositives;
    if (s.ballTarget) { bt++; if (s.ballFound) bf++; }
    tm += s.teamMatched; tc += s.teamCorrect;
  }
  const recall = t ? f / t : NaN, precision = dets ? (dets - fp) / dets : NaN;
  return { frames: scores.length, targets: t, recall, precision, f1: recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : NaN, smallRecall: ts ? fs / ts : NaN, smallTargets: ts, ballRecall: bt ? bf / bt : NaN, teamPurity: tm ? tc / tm : NaN };
}

export function byCondition(frames, scores) {
  const out = { all: aggregate(scores) };
  for (const [dim, order] of Object.entries(DIMS)) {
    out[dim] = {};
    for (const v of order) {
      const idx = frames.map((fr, i) => (fr.cond?.[dim] === v ? i : -1)).filter((i) => i >= 0);
      if (idx.length) out[dim][v] = aggregate(idx.map((i) => scores[i]));
    }
  }
  return out;
}

const pct = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) : "–");

export function markdown(store) {
  const names = Object.keys(store.robust ?? {});
  const lines = [];
  lines.push(`Randomised set: ${store.meta?.frames ?? "?"} frames, seed ${store.meta?.seed ?? "?"} (render.mjs --random); generated ${store.meta?.date ?? ""}.`, "");
  lines.push("**Overall** (recall / precision / F1 / small-player recall / ball recall / team purity, %)", "");
  lines.push(`| config | settings | recall | precision | F1 | small recall | ball | team purity |`, `|---|---|---|---|---|---|---|---|`);
  for (const n of names) { const a = store.robust[n].all; lines.push(`| ${n} | \`${JSON.stringify(store.configs[n])}\` | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ${pct(a.smallRecall)} (n=${a.smallTargets}) | ${pct(a.ballRecall)} | ${pct(a.teamPurity)} |`); }
  if (store.orig && Object.keys(store.orig).length) {
    lines.push("", "**Original 60-frame set** (scripts/cv-bench/data, one look), same configs", "", `| config | recall | precision | F1 | small recall | ball | team purity |`, `|---|---|---|---|---|---|---|`);
    for (const [n, a] of Object.entries(store.orig)) lines.push(`| ${n} | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ${pct(a.smallRecall)} | ${pct(a.ballRecall)} | ${pct(a.teamPurity)} |`);
  }
  for (const [sub, cs] of Object.entries(store.subsets ?? {})) {
    lines.push("", `**Subset ${sub}** (robust.mjs --filter)`, "", "| config | frames | recall | precision | F1 | ball | team purity |", "|---|---|---|---|---|---|---|");
    for (const [n, a] of Object.entries(cs)) lines.push(`| ${n} | ${a.frames} | ${pct(a.recall)} | ${pct(a.precision)} | ${pct(a.f1)} | ${pct(a.ballRecall)} | ${pct(a.teamPurity)} |`);
  }
  for (const dim of Object.keys(DIMS)) {
    lines.push("", `**${dim}** — recall / precision / team purity (%) per bucket; n = frames (targets)`, "");
    lines.push(`| ${dim} | n | ${names.join(" | ")} |`, `|---|---|${names.map(() => "---").join("|")}|`);
    for (const v of DIMS[dim]) {
      const first = names.map((n) => store.robust[n][dim]?.[v]).find(Boolean);
      if (!first) continue;
      lines.push(`| ${v} | ${first.frames} (${first.targets}) | ${names.map((n) => { const a = store.robust[n][dim]?.[v]; return a ? `${pct(a.recall)} / ${pct(a.precision)} / ${pct(a.teamPurity)}` : "–"; }).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let gt = existsSync(join(DATA, "gt.json")) ? JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8")) : null;
  if (args.includes("--rerender") || !gt || gt.random?.seed !== SEED || (gt.random.n ?? N) !== N) {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(join(DATA, ".gitignore"), "# generated by robust.mjs (render.mjs --random)\n*\n");
    gt = await render(N, DATA, { random: true, seed: SEED });
  }
  const filter = opt("filter");
  const [fk, fv] = filter ? filter.split("=") : [];
  const frames = filter ? gt.frames.filter((fr) => String(fr.cond?.[fk]) === fv) : gt.frames;
  const { results, perFrame } = await runBench({ dataDir: DATA, frames, configs, port: PORT, jobs: JOBS });
  console.log(`\n${table(results)}\n`);
  const store = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
  store.configs = { ...(store.configs ?? {}), ...configs };
  if (filter) {
    store.subsets = store.subsets ?? {};
    store.subsets[filter] = { ...(store.subsets[filter] ?? {}), ...Object.fromEntries(Object.keys(configs).map((n) => [n, aggregate(perFrame[n])])) };
  } else {
    store.meta = { date: new Date().toISOString(), frames: gt.frames.length, seed: SEED };
    store.robust = store.robust ?? {};
    for (const n of Object.keys(configs)) store.robust[n] = byCondition(gt.frames, perFrame[n]);
  }
  if (args.includes("--orig")) {
    const og = JSON.parse(readFileSync(join(here, "data", "gt.json"), "utf8"));
    const o = await runBench({ dataDir: join(here, "data"), frames: og.frames, configs, port: PORT, jobs: JOBS });
    console.log(`\noriginal set\n${table(o.results)}\n`);
    store.orig = store.orig ?? {};
    for (const n of Object.keys(configs)) store.orig[n] = aggregate(o.perFrame[n]);
  }
  writeFileSync(RESULTS, JSON.stringify(store, null, 1));
  const md = markdown(store);
  const begin = "<!-- robust:begin (generated by scripts/cv-bench/robust.mjs) -->", end = "<!-- robust:end -->";
  const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : `# CV robustness\n\n${begin}\n${end}\n`;
  const i = doc.indexOf(begin), j = doc.indexOf(end);
  writeFileSync(DOC, i >= 0 && j > i ? `${doc.slice(0, i + begin.length)}\n${md}\n${doc.slice(j)}` : `${doc}\n${begin}\n${md}\n${end}\n`);
  console.log(`wrote ${RESULTS} and ${DOC}`);
}
