// Static demo build (VITE_DEMO=1, GitHub Pages): no server, so a pick is scored in the browser from the answer file
// shipped with the demo content, with the server's own result builder (api/src/result.ts). First answer wins, as on the
// server (stored in this browser). No crowd stats. The real service keeps answers on the server until you pick; the
// demo trades that for running anywhere as static files (said on the About page).
import { buildResult } from "../../api/src/result.ts";
import type { Answer, PickResult } from "../../api/src/types.ts";

export const DEMO = import.meta.env.VITE_DEMO === "1";

/** First date of the demo content and its number of days (written by scripts/demo-content.mjs into demo.json). */
export interface DemoInfo { start: string; days: number }

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(d + "T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The demo has a fixed set of days: today's date is mapped onto it cyclically, so there is always a "today". */
export function demoDate(today: string, info: DemoInfo): string {
  const n = Math.max(1, info.days);
  const offset = Math.floor((utc(today) - utc(info.start)) / DAY_MS);
  return iso(utc(info.start) + (((offset % n) + n) % n) * DAY_MS);
}

export const getDemoInfo = (): Promise<DemoInfo> => fetch("content/demo.json").then((r) => {
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<DemoInfo>;
});

const KEY = "pm.demo.picks";
type Stored = Record<string, { option: number; guess: number | null }>;
function load(): Stored { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored; } catch { return {}; } }
function save(s: Stored) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: session only */ } }

/** Same contract as POST /api/pick: the first answer per moment counts, a repeat returns it with repeat = true. */
export async function demoPick(moment: string, option: number, guess: number | null): Promise<PickResult> {
  const r = await fetch(`content/answers/${moment}.json`);
  if (!r.ok) throw new Error(String(r.status));
  const answer = (await r.json()) as Answer;
  const picks = load();
  const prev = picks[moment];
  if (prev) return buildResult(answer, prev.option, {}, true, prev.guess);
  if (!answer.options.some((o) => o.k === option)) throw new Error("400");
  picks[moment] = { option, guess };
  save(picks);
  return buildResult(answer, option, {}, false, guess);
}
