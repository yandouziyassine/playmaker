/// <reference types="vite/client" />
// Registers /sw.js (production builds only; on localhost only with ?sw=1, so `npm run dev`, `vite preview` and the
// Playwright run against the dev server stay service-worker free) and shows a quiet "New version available" toast.
import { ot } from "./text.ts";
import "./offline.css";

const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/;

/** Whether to register: a production build, and either a real host or an explicit ?sw=1 on a local one. */
export function swEnabled(prod: boolean, hostname: string, search: string): boolean {
  if (!prod) return false;
  return !LOCAL.test(hostname) || new URLSearchParams(search).get("sw") === "1";
}

export function registerSW(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!swEnabled(import.meta.env.PROD, location.hostname, location.search)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // an update the player accepted (first installs claim the page silently: no reload then)
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) toast(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) toast(w);
        });
      });
    }).catch(() => { /* no offline mode: the game still works online */ });
  }, { once: true });
}

function toast(worker: ServiceWorker) {
  if (document.querySelector(".sw-toast")) return;
  const box = document.createElement("div");
  box.className = "sw-toast"; box.setAttribute("role", "status");
  const msg = document.createElement("span"); msg.textContent = ot("update");
  const later = document.createElement("button"); later.type = "button"; later.className = "quiet"; later.textContent = ot("dismiss");
  const reload = document.createElement("button"); reload.type = "button"; reload.className = "ghost"; reload.textContent = ot("reload");
  later.onclick = () => box.remove();
  reload.onclick = () => { reload.disabled = true; worker.postMessage({ type: "SKIP_WAITING" }); }; // controllerchange reloads
  box.append(msg, later, reload);
  document.body.append(box);
}

/** Asks the worker to cache these content URLs (today's day and its moments) so the day can be finished offline. */
export function warmOffline(urls: string[]): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !urls.length) return;
  if (!swEnabled(import.meta.env.PROD, location.hostname, location.search)) return;
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "WARM", urls })).catch(() => {});
}
