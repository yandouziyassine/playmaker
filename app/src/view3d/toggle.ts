// The "3D · player's eyes" / "2D" toggle next to the pitch canvas. Small and three.js-free: the 3D view (view.ts, with
// three.js) is loaded with import() the first time the visitor turns 3D on, so it is its own chunk.
// The 2D canvas is always drawn (it stays the source of truth and the tap target); in 3D mode it is hidden and every
// paint is mirrored into the 3D view. When WebGL is missing or the chunk fails to load, the button says so and the game
// stays in 2D. The choice lasts for the session (all of the day's moments); 2D is the default.
import type { Moment } from "../api.ts";
import type { Overlay3D } from "./geom.ts";
import type { View3D } from "./view.ts";
import { icon, spinner } from "../design/icons.ts";
import "./view3d.css";

type Cm = [number, number] | null;
type Paint = { mo: Moment; frame: Cm[]; ball: Cm; overlay: Overlay3D };

const KEY = "playmaker.view3d";
let on = (() => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } })();
let view: View3D | null = null, loading: Promise<View3D | null> | null = null, failed = false;
let canvas2d: HTMLCanvasElement | null = null, stage: HTMLElement | null = null, host: HTMLElement | null = null, button: HTMLButtonElement | null = null;
let last: Paint | null = null;
let hook: (() => void) | null = null;
let pick: { fn: (k: number) => void; mo: Moment } | null = null, help: HTMLElement | null = null;
const HELP = "Drag to look around · double-tap to re-centre", HELP_PICK = "Tap a teammate, a yellow chevron or the goal · drag to look";

export const is3D = () => on && !!view;

/** Called when 3D turns on or off (round.ts uses it to open the option list). One listener at a time. */
export function on3DChange(cb: (() => void) | null) { hook = cb; }

function label() {
  if (!button) return;
  button.replaceChildren(...(failed ? [] : [icon(on ? "pitch" : "cube")]), failed ? "3D unavailable" : on ? "2D" : "3D");
  button.disabled = failed;
  button.removeAttribute("aria-busy");
  button.setAttribute("aria-pressed", String(on && !failed));
  button.title = failed ? "This browser cannot draw the 3D view (WebGL)" : on ? "Back to the 2D pitch" : "See the moment through the ball carrier's eyes";
}

function apply() {
  const show3 = on && !!view;
  stage?.classList.toggle("is3d", show3);
  if (host) host.hidden = !show3;
  label();
  if (view) { if (pick) view.setPickHandler(pick.fn, pick.mo); else view.clearPickHandler(); }
  if (show3 && last) view!.show(last.mo, last.frame, last.ball, last.overlay);
  hook?.();
}

async function load(): Promise<View3D | null> {
  if (view || failed) return view;
  loading ??= import("./view.ts").then((m) => m.mount3D(host!)).catch(() => null);
  const v = await loading;
  loading = null;
  if (v) view = v; else failed = true;
  return v;
}

async function setOn(next: boolean) {
  on = next;
  try { sessionStorage.setItem(KEY, next ? "1" : "0"); } catch { /* private mode */ }
  if (on) {
    host!.hidden = false; // the canvas needs a size when the renderer is created
    stage?.classList.add("is3d");
    if (button) { button.replaceChildren(spinner(), "Loading 3D…"); button.setAttribute("aria-busy", "true"); }
    await load();
    if (failed) on = false;
  }
  apply();
}

/** Wraps the 2D canvas once: adds the 3D host and the toggle button over its top-right corner. */
export function setup3D(canvas: HTMLCanvasElement) {
  if (canvas2d === canvas) return;
  canvas2d = canvas;
  stage = document.createElement("div");
  stage.className = "v3d-stage";
  canvas.replaceWith(stage);
  host = document.createElement("div");
  host.className = "v3d-host";
  host.hidden = true;
  help = document.createElement("p");
  help.className = "v3d-help";
  help.textContent = pick ? HELP_PICK : HELP;
  host.append(help);
  button = document.createElement("button");
  button.type = "button";
  button.className = "v3d-toggle";
  button.onclick = () => void setOn(!on);
  stage.append(canvas, host, button);
  label();
  if (on) void setOn(true); // remembered from earlier in the session
}

/** Mirror a 2D paint into the 3D view (kept for when 3D is turned on later). */
export function paint3D(mo: Moment, frame: Cm[], ball: Cm, overlay: Overlay3D = {}) {
  last = { mo, frame, ball, overlay };
  if (on && view) view.show(mo, frame, ball, overlay);
}

/** While choosing: taps in 3D on a teammate (pass), a carry chevron or the goal mouth call fn(option k).
 *  Pass null once the choice is confirmed. Survives turning 3D on later in the same choice. */
export function pick3D(mo: Moment | null, fn: ((k: number) => void) | null) {
  pick = mo && fn ? { fn, mo } : null;
  if (help) help.textContent = pick ? HELP_PICK : HELP;
  if (!view) return;
  if (pick) view.setPickHandler(pick.fn, pick.mo); else view.clearPickHandler();
}

/** Point badges in 3D (normally not needed: paint3D already shows overlay.scores). null clears them. */
export function scores3D(scores: Record<number, number> | null) { view?.showScores(scores); }

// Dev builds only: a handle for the Playwright review scripts (wire picking without round.ts, inspect the view).
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__playmaker3d = { pick3D, scores3D, view: () => view };
}
