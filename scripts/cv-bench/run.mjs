// Runs the Lab's real detection pipeline (app/src/lab/bench.ts -> detector.ts, teams.ts, players.ts) on the benchmark frames of
// scripts/cv-bench/data/ in headless Chromium, served by a throw-away Vite dev server, and prints / writes the metrics.
//   node scripts/cv-bench/run.mjs [--configs legacy,default,lite2] [--n 60] [--port 5190] [--notiled] [--jobs 1]
// Named configs below; an ad-hoc one: --model lite2 --tile 448 --overlap 0.25 --tileMinScore 0.35 (--label name).
// --jobs N scores N frames at once in N pages (separate renderer processes): faster, but the ms / frame figures then include
// CPU contention, so time the pipeline with --jobs 1. robust.mjs imports runBench() from here.
import { chromium } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

export const CONFIGS = {
  legacy: { model: "lite0", tile: 0, overlap: 0.2, tileMinScore: 0.3 },
  // = DEFAULT_SETTINGS of app/src/lab/settings.ts
  default: { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.25 },
  "tiles-t30": { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.3 },
  // Lite2 as first measured; "lite2-t25" = MODEL_PRESETS.lite2 of settings.ts since robust.mjs (docs/cv-robustness.md)
  lite2: { model: "lite2", tile: 448, overlap: 0.25, tileMinScore: 0.3 },
  "lite2-t25": { model: "lite2", tile: 448, overlap: 0.25, tileMinScore: 0.25 },
  "lite2-t20": { model: "lite2", tile: 448, overlap: 0.25, tileMinScore: 0.2 },
  "t20": { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.2 },
  "tile320": { model: "lite0", tile: 320, overlap: 0.25, tileMinScore: 0.25 },
  // experiment: the proposed auto-gain for dark frames (see preGain), not in the app
  "default-gain": { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.25, pre: "gain" },
};

const pct = (v) => (Number.isFinite(v) ? `${(100 * v).toFixed(1)}%` : "–");
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");

export function table(results) {
  const rows = [
    ["config", ...Object.keys(results)],
    ["recall all", ...Object.values(results).map((r) => pct(r.recall.all))],
    ["recall small (<40 px)", ...Object.values(results).map((r) => `${pct(r.recall.small)} (n=${r.targets.small})`)],
    ["recall medium (40-90)", ...Object.values(results).map((r) => `${pct(r.recall.medium)} (n=${r.targets.medium})`)],
    ["recall large (>=90)", ...Object.values(results).map((r) => `${pct(r.recall.large)} (n=${r.targets.large})`)],
    ["precision", ...Object.values(results).map((r) => pct(r.precision))],
    ["ball recall", ...Object.values(results).map((r) => pct(r.ballRecall))],
    ["feet err median / p90 (m)", ...Object.values(results).map((r) => `${num(r.feetMedianM)} / ${num(r.feetP90M)}`)],
    ["feet dy median (box h)", ...Object.values(results).map((r) => num(r.feetDyMedian, 3))],
    ["team purity", ...Object.values(results).map((r) => pct(r.teamPurity))],
    ["keeper/ref flagged other", ...Object.values(results).map((r) => pct(r.othersFlagged))],
    ["ms / frame (median)", ...Object.values(results).map((r) => `${num(r.ms.median, 0)} (${num(r.passes, 1)} passes)`)],
    ...[...new Set(Object.values(results).flatMap((r) => Object.keys(r.byView)))].map((v) => [`${v}: recall / precision`, ...Object.values(results).map((r) => (r.byView[v] ? `${pct(r.byView[v].recall)} / ${pct(r.byView[v].precision)}` : "–"))]),
  ];
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join(" | ")).join("\n");
}

/**
 * Experimental preprocessing (config `pre: "gain"`), runs in the page: the proposed detector.ts auto-gain for dark frames
 * (docs/cv-robustness.md). Mean luma on a 160 x 90 thumbnail; below 85 the frame is brightened by min(1.8, 85 / mean)
 * (serialised into the page, so the constants are inline). The team colours are then also read on the brightened frame.
 */
async function preGain(url) {
  const img = new Image(); img.src = url; await img.decode();
  const t = document.createElement("canvas"); t.width = 160; t.height = 90;
  const tx = t.getContext("2d", { willReadFrequently: true }); tx.drawImage(img, 0, 0, 160, 90);
  const d = tx.getImageData(0, 0, 160, 90).data;
  let y = 0; for (let i = 0; i < d.length; i += 4) y += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const mean = y / (d.length / 4), g = Math.min(1.8, 85 / Math.max(1, mean));
  if (g <= 1.02) return url;
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext("2d"); cx.filter = `brightness(${g})`; cx.drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * Scores `frames` (gt.json records of `dataDir`) under each config. Returns { results: name -> summary, perFrame: name -> scores }
 * (per-frame scores without the person boxes, in frame order).
 */
export async function runBench({ dataDir, frames, configs, port = 5190, tiled = true, jobs = 1, log = (s) => process.stdout.write(s) }) {
  // vite dev server (root: app), in-process; no HMR / file watching: other edits must not reload the page mid-run
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port, strictPort: true, hmr: false, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const pages = await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
      const page = await browser.newPage();
      page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
      await page.goto(`http://localhost:${port}/about.html`);
      return page;
    }));
    const load = (page) => page.evaluate(() => import("/src/lab/bench.ts").then((m) => { window.__bench = m; }));
    await Promise.all(pages.map(load));
    /** A source edit makes Vite reload the page mid-run: re-import the module and retry the frame. */
    const evaluate = async (page, fn, arg) => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (!(await page.evaluate(() => !!window.__bench))) await load(page);
          return await page.evaluate(fn, arg);
        } catch (e) {
          if (attempt >= 3 || !/context was destroyed|navigation|reading 'bench/i.test(String(e))) throw e;
          await page.waitForLoadState("load");
        }
      }
    };
    const results = {}, perFrame = {};
    for (const [name, cfg] of Object.entries(configs)) {
      const scores = new Array(frames.length);
      log(`\n${name} ${JSON.stringify(cfg)}\n`);
      let next = 0;
      await Promise.all(pages.map(async (page) => {
        while (next < frames.length) {
          const i = next++, fr = frames[i];
          let png = `data:image/png;base64,${readFileSync(join(dataDir, `${fr.id}.png`)).toString("base64")}`;
          if (cfg.pre === "gain") png = await evaluate(page, preGain, png);
          const s = await evaluate(page, ([url, g, c, t]) => window.__bench.benchFrame(url, g, c, t), [png, fr, cfg, tiled]);
          scores[i] = s;
          const t = Object.values(s.buckets).reduce((a, b) => a + b.targets, 0), f = Object.values(s.buckets).reduce((a, b) => a + b.found, 0);
          log(`  ${fr.id} ${fr.view.padEnd(7)} ${f}/${t} found, ${s.falsePositives} FP, ball ${s.ballFound ? "yes" : "no"}, ${Math.round(s.ms)} ms\n`);
        }
      }));
      results[name] = await evaluate(pages[0], (ss) => window.__bench.summarise(ss), scores);
      perFrame[name] = scores.map(({ persons, ...rest }) => rest);
    }
    return { results, perFrame };
  } finally {
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const DATA = opt("data", join(here, "data"));
  const TILED = !args.includes("--notiled");
  const gt = JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8"));
  const frames = gt.frames.slice(0, Number(opt("n", gt.frames.length)));
  let configs;
  if (opt("model") || opt("tile")) {
    const label = opt("label", "adhoc");
    configs = { [label]: { model: opt("model", "lite0"), tile: Number(opt("tile", 384)), overlap: Number(opt("overlap", 0.25)), tileMinScore: Number(opt("tileMinScore", 0.3)) } };
  } else {
    configs = Object.fromEntries(opt("configs", "legacy,default").split(",").map((k) => { if (!CONFIGS[k]) throw new Error(`unknown config ${k}`); return [k, CONFIGS[k]]; }));
  }
  const { results, perFrame } = await runBench({ dataDir: DATA, frames, configs, port: Number(opt("port", 5190)), tiled: TILED, jobs: Number(opt("jobs", 1)) });
  console.log(`\n${table(results)}\n`);
  const out = { date: new Date().toISOString(), frames: frames.length, tiled: TILED, configs, results, perFrame };
  const file = join(here, opt("out", "results.json"));
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...prev, ...out, results: { ...(prev.results ?? {}), ...results }, configs: { ...(prev.configs ?? {}), ...configs }, perFrame: { ...(prev.perFrame ?? {}), ...perFrame } }, null, 1));
  console.log(`wrote ${file}`);
}
