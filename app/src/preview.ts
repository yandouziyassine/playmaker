// Intro preview: the actual product, not a description of it. Loops the lead-up of a moment from the most recent past
// day (never today's: no head start), zoomed on the ball carrier, then holds the release frame with the options and a
// sample pick. Loaded lazily after the day; falls back to the release sample.json on launch day; hidden if it fails.
import { getDay, getIndex, getMoment, type Moment } from "./api.ts";
import { draw, toScreen, type View } from "./pitch.ts";

const getSample = (): Promise<Moment> => fetch("/content/sample.json").then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<Moment>; });

const PX_PER_M = 5.6; // zoom: about 40 m of pitch in the 232 px tall preview

export function startPreview(fig: HTMLElement, canvas: HTMLCanvasElement, cap: HTMLElement, today: string): () => void {
  let stopped = false, timer = 0;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  (async () => {
    const idx = await getIndex().catch(() => ({ days: [] as { date: string; day_number: number }[] }));
    const past = idx.days.filter((d) => d.date < today);
    const src = past[past.length - 1];
    if (stopped) return;
    fig.hidden = false;
    fig.setAttribute("aria-busy", "true");
    // most recent past day; on launch day, the release's sample moment (never part of a daily set)
    const mo = src ? await getMoment((await getDay(src.date)).moments[0]!) : await getSample();
    if (stopped) return;
    fig.removeAttribute("aria-busy");
    canvas.classList.remove("skeleton");
    cap.textContent = src
      ? `A moment from day #${src.day_number}: watch 3 seconds of play, then make your pick.`
      : "A sample moment: watch 3 seconds of play, then make your pick.";
    run(canvas, mo, reduced, (f, ms) => { if (!stopped) timer = window.setTimeout(f, ms); });
  })().catch(() => { fig.hidden = true; });
  return stop;
}

function run(canvas: HTMLCanvasElement, mo: Moment, reduced: boolean, later: (f: () => void, ms: number) => void) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext("2d")!;
  const v: View = { w: 68 * PX_PER_M + 28, h: 105 * PX_PER_M + 28 };
  const release = mo.lead_up[mo.lead_up.length - 1]!;
  const at = release[mo.carrier] ?? mo.ball[mo.ball.length - 1] ?? [0, 0];
  const [cx, cy] = toScreen([at[0] / 100, at[1] / 100], v);
  const tx = Math.max(0, Math.min(v.w - cw, cx - cw / 2)), ty = Math.max(0, Math.min(v.h - ch, cy - ch * 0.55));
  ctx.setTransform(dpr, 0, 0, dpr, -tx * dpr, -ty * dpr);
  const sample = mo.options.find((o) => o.kind === "pass")?.k;
  const hold = () => draw(ctx, v, mo, release, mo.ball[mo.ball.length - 1] ?? null, { targets: true, selected: sample });
  if (reduced) { hold(); return; }
  let f = 0;
  const tick = () => {
    if (!canvas.isConnected) return;
    if (f < mo.lead_up.length) {
      draw(ctx, v, mo, mo.lead_up[f]!, mo.ball[Math.min(f, mo.ball.length - 1)] ?? null);
      f++; later(tick, 1000 / mo.fps);
    } else { hold(); f = 0; later(tick, 2600); }
  };
  tick();
}
