// Free play page: the whole match on the portrait pitch (fixed view: home attacks up in the first half). Pause (or
// "Ask the coach") snaps to the nearest moment someone has the ball and shows the coach's top 3 options; follow the
// coach, play on, or pick another option, then see what the pro did. The second half (4.5 MB) loads when first needed.
// The coach (engine + weights) is loaded with import() next to the match data, so the page's first paint stays small.
// The 3D toggle (view3d/toggle.ts) mirrors every paint into the lazy three.js view: the whole match in 3D, with the
// coach's arrows and taps on a teammate / the goal / a carry chevron choosing that option.
import type { LoadedCoach } from "../coach/picture.ts";
import type { FrameAdvice, Outcome, ProChoice } from "./coach.ts";
import {
  ballHeightAt, carrierAt, clock, decodeBallZ, decodeHalf, frameDots, fromGlobal, goals, minuteLabel, playerAt, scoreAt, toGlobal, toView, totalFrames, trail,
  viewFlip, type HalfData, type MatchMeta,
} from "./data.ts";
import type { Vec } from "../coach/geometry.ts";
import type { Moment3D, Overlay3D } from "../view3d/geom.ts";
import { is3D, on3DChange, paint3D, pick3D, setup3D } from "../view3d/toggle.ts";
import { ARROW_COLORS, TOP, drawPitch, drawScene, type View } from "./draw.ts";
import { setIconText, spinner } from "../design/icons.ts";
import { getLang, initLang, localizeDom, num, t } from "../i18n/index.ts";
import { translatePhrase } from "../i18n/phrases.ts";
import { mountLangSwitch } from "../i18n/ui.ts";

initLang();
localizeDom();
mountLangSwitch();

const BASE = "replay/"; // relative: works at / and under a base path (GitHub Pages demo)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("pitch"), ctx = canvas.getContext("2d")!;
const playBtn = $<HTMLButtonElement>("play"), askBtn = $<HTMLButtonElement>("ask"), time = $<HTMLInputElement>("time");
const status = $("status"), coachBox = $("coach"), list = $("options"), revealBox = $("reveal"), tallyBox = $("tally");
const speedBtns = [...document.querySelectorAll<HTMLButtonElement>("[data-speed]")];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let C = null as unknown as typeof import("./coach.ts");
let meta = null as unknown as MatchMeta, brain = null as unknown as LoadedCoach, flip: 1 | -1 = 1;
let ready = false, playing = false, speed = 1, g = 0, last = 0;
const halves: (HalfData | undefined)[] = [], loads: (Promise<HalfData> | undefined)[] = [];
/** The ball's height per half (z<i>.bin): undefined not asked yet, null missing (the 3D ball then rests on the grass). */
const heights: (Int16Array | null | undefined)[] = [], heightLoads: (Promise<void> | undefined)[] = [];
let advice: FrameAdvice | null = null;
let pending: { half: number; pro: ProChoice; result: Outcome; mine: string; followed: boolean } | null = null;
const tally = { decisions: 0, followed: 0, you: 0, coach: 0 };

/** Status line; `busy`: a spinner and aria-busy on the pitch while match data downloads. */
const say = (t: string, busy = false) => {
  status.replaceChildren(...(busy ? [spinner()] : []), t);
  if (busy) canvas.setAttribute("aria-busy", "true"); else canvas.removeAttribute("aria-busy");
};
const setPlayLabel = (on: boolean) => setIconText(playBtn, on ? "pause" : "play", on ? t("rp.pause") : t("rp.play"));
const failed = (e: unknown) => { console.warn(e); say(t("rp.failed")); };
const where = () => fromGlobal(meta, Math.floor(g));

function getHalf(i: number): Promise<HalfData> {
  if (halves[i]) return Promise.resolve(halves[i]!);
  return (loads[i] ??= fetch(`${BASE}h${i}.bin`)
    .then((r) => { if (!r.ok) throw new Error(`h${i}.bin: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((buf) => (halves[i] = decodeHalf(buf, meta.halves[i]!, meta.players.length)))
    .catch((e) => { loads[i] = undefined; throw e; }));
}

/** The ball's height is only drawn in 3D: fetched the first time 3D shows that half (68 kB), then a redraw. */
function needHeight(i: number) {
  if (heights[i] !== undefined || heightLoads[i] || !meta) return;
  heightLoads[i] = fetch(`${BASE}z${i}.bin`)
    .then(async (r) => { heights[i] = r.ok ? decodeBallZ(await r.arrayBuffer(), meta.halves[i]!.frames) : null; })
    .catch((e) => { console.warn(e); heights[i] = null; })
    .finally(() => { heightLoads[i] = undefined; if (!playing) draw(); });
}

// ---------- drawing ----------
let view: View = { w: 1, h: 1 };
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view = { w: Math.max(1, canvas.clientWidth), h: Math.max(1, canvas.clientHeight) };
  canvas.width = Math.round(view.w * dpr); canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() {
  if (!ready) { drawPitch(ctx, view); return; }
  const fpos = fromGlobal(meta, g), h = halves[fpos.half];
  if (!h) { drawPitch(ctx, view); return; }
  const { players, ball } = frameDots(h, fpos.frame);
  const shown = !playing && advice && advice.half === fpos.half && advice.frame === Math.floor(fpos.frame) ? advice : null;
  const tr = reduced ? [] : trail(h, fpos.frame, meta.fps);
  drawScene(ctx, view, meta, flip, {
    players, ball, trail: tr, advice: shown,
    carrierAt: shown ? playerAt(h, shown.frame, shown.carrier.player) : null, top: TOP,
  });
  if (is3D()) needHeight(fpos.half);
  paint3D(...scene3D(h, fpos.half, fpos.frame, players, ball, tr, shown));
}

// ---------- 3D ----------
/** Raw tracking metres to the 3D view's centimetres: the fixed view's orientation (home attacks +x in the first half). */
const cm3D = (p: Vec): [number, number] => { const v = toView(p, flip); return [Math.round(v[0] * 100), Math.round(v[1] * 100)]; };
let players3D: Moment3D["players"] = [];
let last3D: Moment3D | null = null;
/** The frame dressed as a moment for the 3D view: team colours by side, the carrier (for the eyes camera and his
 *  ring), the goal he attacks, and the coach's options as arrows and tap targets when the coach is shown. */
function scene3D(h: HalfData, half: number, frame: number, players: { player: number; at: Vec }[], ball: Vec | null, tr: Vec[], shown: FrameAdvice | null):
  [Moment3D, ([number, number] | null)[], [number, number] | null, Overlay3D] {
  const fr: ([number, number] | null)[] = new Array(meta.players.length).fill(null);
  for (const d of players) fr[d.player] = cm3D(d.at);
  const carrier = shown ? shown.carrier : carrierAt(meta, half, h, Math.floor(frame));
  const team = carrier?.team ?? 0;
  const attack = ((meta.halves[half]?.attack[team] ?? 1) * flip) as 1 | -1;
  const options = shown ? shown.ranked.slice(0, TOP).map((r, i) => ({ k: i, kind: r.option.kind, player: r.option.target, to: cm3D(r.to) })) : [];
  const mo: Moment3D = {
    id: "replay", league: "", home: meta.meta.home, away: meta.meta.guest, attacking: "home", minute: 0, fps: meta.fps,
    carrier: carrier?.player ?? -1, players: players3D, lead_up: [fr], ball: [ball ? cm3D(ball) : null], options, credit: meta.credit,
    attack, colors: meta.meta.colors, live: true,
  };
  last3D = mo;
  const o: Overlay3D = { balls: tr.map(cm3D), ballH: ballHeightAt(heights[half], frame) };
  if (shown) o.coach = options.map((q, i) => ({ k: q.k, color: ARROW_COLORS[i] ?? "#f1faee" }));
  return [mo, fr, ball ? cm3D(ball) : null, o];
}

function showTime() {
  const { half, frame } = where(), s = scoreAt(meta, half, frame);
  $("scoreline").textContent = `${s[0]}–${s[1]}`;
  $("half").textContent = half ? t("rp.half2") : t("rp.half1");
  $("minute").textContent = minuteLabel(half, frame, meta.fps);
  $("clock").textContent = clock(half, frame, meta.fps);
  time.value = String(Math.floor(g));
  time.setAttribute("aria-valuetext", t(half ? "rp.valueText2" : "rp.valueText1", { clock: clock(half, frame, meta.fps), home: meta.meta.home, a: s[0], b: s[1], guest: meta.meta.guest }));
}

// ---------- coach ----------
// one dominant action at a time: Play, or (coach shown) Follow the coach
function hideCoach() { coachBox.hidden = true; advice = null; playBtn.className = "primary"; pick3D(null, null); }

/** Snap to the nearest moment someone has the ball (within 2 s) and show the coach's options there. */
function askCoach() {
  const { half, frame } = where(), h = halves[half];
  if (!h) return;
  const f = C.snapFrame(meta, half, h, frame);
  advice = f === null ? null : C.adviceAt(meta, half, h, f, brain.coach, brain.models);
  if (!advice || f === null) {
    hideCoach(); draw();
    say(t("rp.nobody"));
    return;
  }
  const shift = f - frame;
  g = toGlobal(meta, half, f);
  showTime();
  const p = meta.players[advice.carrier.player]!, team = advice.carrier.team ? meta.meta.guest : meta.meta.home;
  $("coach-who").textContent = t("rp.coachWho", { shirt: p.shirt, name: p.name });
  list.replaceChildren(...advice.ranked.slice(0, TOP).map((r, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "opt"; b.style.setProperty("--c", ARROW_COLORS[i] ?? "#f1faee");
    const title = document.createElement("span"); title.className = "t"; title.textContent = `${i + 1}. ${C.optionTitle(r.option, meta.players)}`;
    const nums = document.createElement("span"); nums.className = "n"; nums.textContent = t("rp.optNums", { success: C.successLabel(r.option), xg: C.signedXg(r.option.score) });
    b.append(title, nums);
    b.addEventListener("click", () => choose(i));
    const why = document.createElement("ul"); why.className = "why";
    for (const reason of r.reasons) {
      const w = document.createElement("li");
      w.className = reason.sign === 1 ? "helps" : reason.sign === -1 ? "hurts" : "val";
      w.textContent = translatePhrase(reason.text); why.append(w);
    }
    li.append(b, why);
    return li;
  }));
  coachBox.hidden = false; playBtn.className = "ghost";
  const moved = shift ? t(shift < 0 ? "rp.movedBack" : "rp.movedOn", { s: num(Math.abs(shift) / meta.fps, 1) }) : "";
  say(t("rp.hasBall", { moved, shirt: p.shirt, name: p.name, team, n: advice.ranked.length }));
  draw();
  if (last3D) pick3D(last3D, choose); // in 3D: tap a teammate, the goal or a carry chevron to choose that option
}

function choose(i: number) {
  if (!advice) return;
  const a = advice, h = halves[a.half]!, opts = a.ranked.map((r) => r.option), option = opts[i]!;
  tally.decisions++; if (i === 0) tally.followed++;
  tally.you += option.score; tally.coach += opts[0]!.score;
  pending = {
    half: a.half, pro: C.proChoice(meta, a.half, h, a.frame, a.carrier, opts), result: C.outcome(meta, a.half, a.frame, a.carrier.team),
    mine: `${C.optionTitle(option, meta.players)} (${C.signedXg(option.score)})`, followed: i === 0,
  };
  revealBox.hidden = true;
  play();
  say(t("rp.watchPro", { who: t(i === 0 ? "rp.followed" : "rp.ownWay"), mine: pending.mine }));
}

function doReveal() {
  if (!pending) return;
  const p = pending; pending = null;
  revealBox.textContent = t("rp.reveal", { who: t(p.followed ? "rp.followed" : "rp.yourChoice"), mine: p.mine, pro: C.proLabel(p.pro, meta.players), outcome: C.outcomeLabel(p.result) });
  revealBox.hidden = false;
  tallyBox.textContent = t("rp.tally", { followed: tally.followed, decisions: tally.decisions, you: C.signedXg(tally.you), coach: C.signedXg(tally.coach) });
  tallyBox.hidden = false;
}

// ---------- playback ----------
function tick(now: number) {
  if (!playing) return;
  const end = totalFrames(meta) - 1;
  const next = Math.min(end, g + (Math.min(100, now - last) / 1000) * meta.fps * speed);
  last = now;
  const at = fromGlobal(meta, next);
  if (!halves[at.half]) { // crossing into a half that is not loaded yet
    pause(false); say(t("rp.loadingSecond"), true);
    getHalf(at.half).then(() => { g = next; play(); }).catch(failed);
    return;
  }
  g = next;
  if (at.half === 0 && g > meta.halves[0]!.frames - 60 * meta.fps) getHalf(1).catch(() => {}); // prefetch
  if (pending && (at.half !== pending.half || at.frame >= pending.pro.revealFrame)) doReveal();
  showTime(); draw();
  if (g >= end) { pause(false); say(t("rp.fullTime")); return; }
  requestAnimationFrame(tick);
}

function play() {
  if (playing || !ready || g >= totalFrames(meta) - 1) return;
  playing = true; setPlayLabel(true); hideCoach();
  if (!pending) say("");
  last = performance.now(); requestAnimationFrame(tick);
}

function pause(ask = true) {
  if (!playing) return;
  playing = false; setPlayLabel(false);
  g = Math.floor(g);
  if (ask) askCoach(); else draw();
}

async function seek(global: number, ask: boolean) {
  if (playing) pause(false);
  if (pending) doReveal();
  g = Math.max(0, Math.min(totalFrames(meta) - 1, Math.round(global)));
  hideCoach();
  const { half } = where();
  if (!halves[half]) { say(t(half ? "rp.loadingHalf2" : "rp.loadingHalf1"), true); await getHalf(half); say(""); }
  showTime();
  if (ask) askCoach(); else draw();
}

function setSpeed(s: number) {
  speed = s;
  speedBtns.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === s)));
}

// ---------- wiring ----------
playBtn.addEventListener("click", () => (playing ? pause() : play()));
askBtn.addEventListener("click", () => (playing ? pause() : askCoach()));
$("follow").addEventListener("click", () => choose(0));
$("playon").addEventListener("click", () => play());
speedBtns.forEach((b) => b.addEventListener("click", () => setSpeed(Number(b.dataset.speed))));
time.addEventListener("input", () => { seek(Number(time.value), false).catch(failed); });
time.addEventListener("change", () => { seek(Number(time.value), true).catch(failed); });
document.addEventListener("keydown", (e) => {
  if (!ready || e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); if (playing) pause(); else play(); }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && tag !== "INPUT") {
    e.preventDefault(); seek(g + (e.key === "ArrowLeft" ? -5 : 5) * meta.fps, true).catch(failed);
  } else if (e.key === "a" || e.key === "A") { if (playing) pause(); else askCoach(); }
  else if ((e.key === "f" || e.key === "F") && advice && !coachBox.hidden) choose(0);
});
new ResizeObserver(resize).observe(canvas);
resize();
setup3D(canvas, true); // once: wraps the canvas with the 3D view and its toggle
on3DChange(() => { if (ready && is3D()) needHeight(where().half); });

async function boot() {
  const [m, c] = await Promise.all([
    fetch(`${BASE}match.json`).then((r) => { if (!r.ok) throw new Error(`match.json: HTTP ${r.status}`); return r.json() as Promise<MatchMeta>; }),
    import("./coach.ts"),
  ]);
  meta = m; C = c; flip = viewFlip(meta);
  brain = await C.loadCoach("coach/models.json");
  await getHalf(0);
  $("home").textContent = meta.meta.home; $("guest").textContent = meta.meta.guest;
  $("home-dot").style.background = meta.meta.colors[0]; $("guest-dot").style.background = meta.meta.colors[1];
  players3D = meta.players.map((p) => ({ side: p.team === 0 ? 0 : 1, shirt: p.shirt, name: p.name }));
  if (getLang() === "en") $("credit").textContent = meta.credit; // French: the translated credit from the page
  const total = totalFrames(meta);
  time.max = String(total - 1); time.disabled = false; playBtn.disabled = false; askBtn.disabled = false;
  const marks = $("marks"), half0 = meta.halves[0]!.frames;
  const ht = document.createElement("span"); ht.className = "mark ht"; ht.style.left = `${(100 * half0) / (total - 1)}%`; ht.title = t("rp.halfTime");
  marks.replaceChildren(ht, ...goals(meta).map((gl) => {
    const s = document.createElement("span");
    s.className = `mark goal t${gl.team}`; s.style.left = `${(100 * toGlobal(meta, gl.half, gl.frame)) / (total - 1)}%`; s.title = t("rp.goal", { label: gl.label });
    return s;
  }));
  canvas.setAttribute("aria-label", t("rp.pitchAria", { home: meta.meta.home, guest: meta.meta.guest }));
  ready = true;
  canvas.classList.remove("skeleton");
  setPlayLabel(false); setIconText(askBtn, "coach", t("rp.ask"));
  showTime(); draw();
  say(t("rp.ready", { home: meta.meta.home, guest: meta.meta.guest }));
}
boot().catch(failed);
