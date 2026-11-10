// Free play page: the whole match on the portrait pitch (fixed view: home attacks up in the first half). Pause (or
// "Ask the coach") snaps to the nearest moment someone has the ball and shows the coach's top 3 options; follow the
// coach, play on, or pick another option, then see what the pro did. The second half (4.5 MB) loads when first needed.
// The coach (engine + weights) is loaded with import() next to the match data, so the page's first paint stays small.
import type { LoadedCoach } from "../coach/picture.ts";
import type { FrameAdvice, Outcome, ProChoice } from "./coach.ts";
import {
  clock, decodeHalf, frameDots, fromGlobal, goals, minuteLabel, playerAt, scoreAt, toGlobal, totalFrames, trail, viewFlip,
  type HalfData, type MatchMeta,
} from "./data.ts";
import { ARROW_COLORS, TOP, drawPitch, drawScene, type View } from "./draw.ts";

const BASE = "/replay/";
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
let advice: FrameAdvice | null = null;
let pending: { half: number; pro: ProChoice; result: Outcome; mine: string; followed: boolean } | null = null;
const tally = { decisions: 0, followed: 0, you: 0, coach: 0 };

const say = (t: string) => { status.textContent = t; };
const failed = (e: unknown) => { console.warn(e); say("Could not load the match data. Please reload the page."); };
const where = () => fromGlobal(meta, Math.floor(g));

function getHalf(i: number): Promise<HalfData> {
  if (halves[i]) return Promise.resolve(halves[i]!);
  return (loads[i] ??= fetch(`${BASE}h${i}.bin`)
    .then((r) => { if (!r.ok) throw new Error(`h${i}.bin: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((buf) => (halves[i] = decodeHalf(buf, meta.halves[i]!, meta.players.length)))
    .catch((e) => { loads[i] = undefined; throw e; }));
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
  drawScene(ctx, view, meta, flip, {
    players, ball, trail: reduced ? [] : trail(h, fpos.frame, meta.fps), advice: shown,
    carrierAt: shown ? playerAt(h, shown.frame, shown.carrier.player) : null, top: TOP,
  });
}

function showTime() {
  const { half, frame } = where(), s = scoreAt(meta, half, frame);
  $("scoreline").textContent = `${s[0]}–${s[1]}`;
  $("half").textContent = half ? "2nd half" : "1st half";
  $("minute").textContent = minuteLabel(half, frame, meta.fps);
  $("clock").textContent = clock(half, frame, meta.fps);
  time.value = String(Math.floor(g));
  time.setAttribute("aria-valuetext", `${clock(half, frame, meta.fps)}, ${half ? "second" : "first"} half, ${meta.meta.home} ${s[0]}–${s[1]} ${meta.meta.guest}`);
}

// ---------- coach ----------
function hideCoach() { coachBox.hidden = true; advice = null; }

/** Snap to the nearest moment someone has the ball (within 2 s) and show the coach's options there. */
function askCoach() {
  const { half, frame } = where(), h = halves[half];
  if (!h) return;
  const f = C.snapFrame(meta, half, h, frame);
  advice = f === null ? null : C.adviceAt(meta, half, h, f, brain.coach, brain.models);
  if (!advice || f === null) {
    hideCoach(); draw();
    say("Nobody has the ball at this moment: play on a little and ask again.");
    return;
  }
  const shift = f - frame;
  g = toGlobal(meta, half, f);
  showTime();
  const p = meta.players[advice.carrier.player]!, team = advice.carrier.team ? meta.meta.guest : meta.meta.home;
  $("coach-who").textContent = `for #${p.shirt} ${p.name}`;
  list.replaceChildren(...advice.ranked.slice(0, TOP).map((r, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "opt"; b.style.setProperty("--c", ARROW_COLORS[i] ?? "#f1faee");
    const title = document.createElement("span"); title.className = "t"; title.textContent = `${i + 1}. ${C.optionTitle(r.option, meta.players)}`;
    const nums = document.createElement("span"); nums.className = "n"; nums.textContent = `${C.successLabel(r.option)} · value ${C.signedXg(r.option.score)}`;
    b.append(title, nums);
    b.addEventListener("click", () => choose(i));
    const why = document.createElement("ul"); why.className = "why";
    for (const reason of r.reasons) {
      const w = document.createElement("li");
      w.className = reason.sign === 1 ? "helps" : reason.sign === -1 ? "hurts" : "val";
      w.textContent = reason.text; why.append(w);
    }
    li.append(b, why);
    return li;
  }));
  coachBox.hidden = false;
  const moved = shift ? `Moved ${(Math.abs(shift) / meta.fps).toFixed(1)} s ${shift < 0 ? "back" : "on"}: ` : "";
  say(`${moved}#${p.shirt} ${p.name} (${team}) has the ball. ${advice.ranked.length} options ranked, top 3 shown.`);
  draw();
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
  say(`${i === 0 ? "You followed the coach" : "You went your own way"}: ${pending.mine}. Watch what the pro does…`);
}

function doReveal() {
  if (!pending) return;
  const p = pending; pending = null;
  revealBox.textContent = `${p.followed ? "You followed the coach" : "Your choice"}: ${p.mine}. ${C.proLabel(p.pro, meta.players)} Within 15 s: ${C.outcomeLabel(p.result)}.`;
  revealBox.hidden = false;
  tallyBox.textContent = `You followed the coach ${tally.followed} of ${tally.decisions} times · your picks ${C.signedXg(tally.you)}, the coach's ${C.signedXg(tally.coach)}.`;
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
    pause(false); say("Loading the second half…");
    getHalf(at.half).then(() => { g = next; play(); }).catch(failed);
    return;
  }
  g = next;
  if (at.half === 0 && g > meta.halves[0]!.frames - 60 * meta.fps) getHalf(1).catch(() => {}); // prefetch
  if (pending && (at.half !== pending.half || at.frame >= pending.pro.revealFrame)) doReveal();
  showTime(); draw();
  if (g >= end) { pause(false); say("Full time."); return; }
  requestAnimationFrame(tick);
}

function play() {
  if (playing || !ready || g >= totalFrames(meta) - 1) return;
  playing = true; playBtn.textContent = "Pause"; hideCoach();
  if (!pending) say("");
  last = performance.now(); requestAnimationFrame(tick);
}

function pause(ask = true) {
  if (!playing) return;
  playing = false; playBtn.textContent = "Play";
  g = Math.floor(g);
  if (ask) askCoach(); else draw();
}

async function seek(global: number, ask: boolean) {
  if (playing) pause(false);
  if (pending) doReveal();
  g = Math.max(0, Math.min(totalFrames(meta) - 1, Math.round(global)));
  hideCoach();
  const { half } = where();
  if (!halves[half]) { say(`Loading the ${half ? "second" : "first"} half…`); await getHalf(half); }
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

async function boot() {
  const [m, c] = await Promise.all([
    fetch(`${BASE}match.json`).then((r) => { if (!r.ok) throw new Error(`match.json: HTTP ${r.status}`); return r.json() as Promise<MatchMeta>; }),
    import("./coach.ts"),
  ]);
  meta = m; C = c; flip = viewFlip(meta);
  brain = await C.loadCoach("/coach/models.json");
  await getHalf(0);
  $("home").textContent = meta.meta.home; $("guest").textContent = meta.meta.guest;
  $("home-dot").style.background = meta.meta.colors[0]; $("guest-dot").style.background = meta.meta.colors[1];
  $("credit").textContent = meta.credit;
  const total = totalFrames(meta);
  time.max = String(total - 1); time.disabled = false; playBtn.disabled = false; askBtn.disabled = false;
  const marks = $("marks"), half0 = meta.halves[0]!.frames;
  const ht = document.createElement("span"); ht.className = "mark ht"; ht.style.left = `${(100 * half0) / (total - 1)}%`; ht.title = "Half time";
  marks.replaceChildren(ht, ...goals(meta).map((gl) => {
    const s = document.createElement("span");
    s.className = `mark goal t${gl.team}`; s.style.left = `${(100 * toGlobal(meta, gl.half, gl.frame)) / (total - 1)}%`; s.title = `Goal ${gl.label}`;
    return s;
  }));
  canvas.setAttribute("aria-label", `Pitch seen from above: ${meta.meta.home} (attacking up in the first half) against ${meta.meta.guest}`);
  ready = true;
  showTime(); draw();
  say(`${meta.meta.home} against ${meta.meta.guest}. Press Play; pause any time and the coach shows the ball carrier's best options.`);
}
boot().catch(failed);
