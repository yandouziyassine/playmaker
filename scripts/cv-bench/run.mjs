// Runs the Lab's real detection pipeline (app/src/lab/bench.ts -> detector.ts, teams.ts, players.ts) on the benchmark frames of
// scripts/cv-bench/data/ in headless Chromium, served by a throw-away Vite dev server, and prints / writes the metrics.
//   node scripts/cv-bench/run.mjs [--configs legacy,default,lite2] [--n 60] [--port 5190] [--notiled]
// Named configs below; an ad-hoc one: --model lite2 --tile 448 --overlap 0.25 --tileMinScore 0.35 (--label name).
import { chromium } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt("port", 5190));
const DATA = opt("data", join(here, "data"));
const TILED = !args.includes("--notiled");

export const CONFIGS = {
  legacy: { model: "lite0", tile: 0, overlap: 0.2, tileMinScore: 0.3 },
  // = DEFAULT_SETTINGS of app/src/lab/settings.ts
  default: { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.25 },
  "tiles-t30": { model: "lite0", tile: 384, overlap: 0.25, tileMinScore: 0.3 },
  lite2: { model: "lite2", tile: 448, overlap: 0.25, tileMinScore: 0.3 },
};

const gt = JSON.parse(readFileSync(join(DATA, "gt.json"), "utf8"));
const frames = gt.frames.slice(0, Number(opt("n", gt.frames.length)));
let configs;
if (opt("model") || opt("tile")) {
  const label = opt("label", "adhoc");
  configs = { [label]: { model: opt("model", "lite0"), tile: Number(opt("tile", 384)), overlap: Number(opt("overlap", 0.25)), tileMinScore: Number(opt("tileMinScore", 0.3)) } };
} else {
  configs = Object.fromEntries(opt("configs", "legacy,default").split(",").map((k) => { if (!CONFIGS[k]) throw new Error(`unknown config ${k}`); return [k, CONFIGS[k]]; }));
}

// ---------- vite dev server (root: app), in-process; no HMR / file watching: other edits must not reload the page mid-run ----------
const { createServer } = await import("vite");
const server = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "error", server: { port: PORT, strictPort: true, hmr: false, watch: null } });
const ready = server.listen();
const stop = () => server.close();

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
    ...["wide", "zoom", "endzone"].map((v) => [`${v}: recall / precision`, ...Object.values(results).map((r) => (r.byView[v] ? `${pct(r.byView[v].recall)} / ${pct(r.byView[v].precision)}` : "–"))]),
  ];
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join(" | ")).join("\n");
}

try {
  await ready;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  await page.goto(`http://localhost:${PORT}/about.html`);
  const load = () => page.evaluate(() => import("/src/lab/bench.ts").then((m) => { window.__bench = m; }));
  await load();
  /** A source edit makes Vite reload the page mid-run: re-import the module and retry the frame. */
  const evaluate = async (fn, arg) => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!(await page.evaluate(() => !!window.__bench))) await load();
        return await page.evaluate(fn, arg);
      } catch (e) {
        if (attempt >= 3 || !/context was destroyed|navigation|reading 'bench/i.test(String(e))) throw e;
        await page.waitForLoadState("load");
      }
    }
  };
  const results = {}, perFrame = {};
  for (const [name, cfg] of Object.entries(configs)) {
    const scores = [];
    process.stdout.write(`\n${name} ${JSON.stringify(cfg)}\n`);
    for (const fr of frames) {
      const png = `data:image/png;base64,${readFileSync(join(DATA, `${fr.id}.png`)).toString("base64")}`;
      const s = await evaluate(([url, g, c, tiled]) => window.__bench.benchFrame(url, g, c, tiled), [png, fr, cfg, TILED]);
      scores.push(s);
      const t = Object.values(s.buckets).reduce((a, b) => a + b.targets, 0), f = Object.values(s.buckets).reduce((a, b) => a + b.found, 0);
      process.stdout.write(`  ${fr.id} ${fr.view.padEnd(7)} ${f}/${t} found, ${s.falsePositives} FP, ball ${s.ballFound ? "yes" : "no"}, ${Math.round(s.ms)} ms\n`);
    }
    results[name] = await evaluate((ss) => window.__bench.summarise(ss), scores);
    perFrame[name] = scores.map(({ persons, ...rest }) => rest);
  }
  await browser.close();
  console.log(`\n${table(results)}\n`);
  const out = { date: new Date().toISOString(), frames: frames.length, tiled: TILED, configs, results, perFrame };
  const file = join(here, opt("out", "results.json"));
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...prev, ...out, results: { ...(prev.results ?? {}), ...results }, configs: { ...(prev.configs ?? {}), ...configs }, perFrame: { ...(prev.perFrame ?? {}), ...perFrame } }, null, 1));
  console.log(`wrote ${file}`);
} finally {
  stop();
}
