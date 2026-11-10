// The game page's offline hooks: service worker registration, the queue of answers given offline and its flushing
// (on load, on 'online', then on the queue's backoff while picks are left).
import { PickQueue, type OnScored, type FlushReport } from "./pickQueue.ts";

export { registerSW, warmOffline } from "./register.ts";
export { markPendingDay } from "./ui.ts";

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };
export const pickQueue = new PickQueue(storage());

/** Flushes now (forced: a fresh page load), on every 'online' event (forced) and on a timer while picks are left.
 * `onFlushed` runs after a flush that scored something (re-render what depends on the day's points). */
export function startFlushing(onScored: OnScored, onFlushed: (r: FlushReport) => void = () => {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (force: boolean) => {
    clearTimeout(timer);
    if (!pickQueue.pending().length) return;
    void pickQueue.flush(onScored, force).then((r) => {
      if (r.scored) onFlushed(r);
      const at = pickQueue.nextRetryAt();
      if (at !== null && (typeof navigator === "undefined" || navigator.onLine)) timer = setTimeout(() => run(false), Math.max(1000, at - Date.now()));
    });
  };
  window.addEventListener("online", () => run(true));
  run(true);
  return { flushNow: () => run(true) };
}
