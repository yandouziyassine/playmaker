// What the game shows when an answer could not reach the server: the pick is saved, the score comes later.
import { ot, pendingText } from "./text.ts";
import "./offline.css";

/** Replaces the reveal (server data) with the offline state. */
export function renderOfflineReveal(reveal: HTMLElement, pickLabel: string) {
  reveal.innerHTML = ""; reveal.hidden = false;
  reveal.classList.add("offline");
  const head = document.createElement("p"); head.className = "offline-head"; head.textContent = ot("savedTitle");
  const msg = document.createElement("p"); msg.textContent = ot("saved");
  const pick = document.createElement("p"); pick.className = "fine"; pick.textContent = ot("savedPick", { pick: pickLabel });
  reveal.setAttribute("role", "status");
  reveal.append(head, msg, pick);
}

/** Undo renderOfflineReveal's marks before a normal reveal reuses the element. */
export function clearOfflineReveal(reveal: HTMLElement) {
  reveal.classList.remove("offline");
  if (reveal.getAttribute("role") === "status") reveal.removeAttribute("role");
}

/** Done screen: pending tiles drawn hollow and, after `anchor`, a note saying they are scored later (removed when
 * none are left). */
export function markPendingDay(anchor: HTMLElement, tiles: Element | null, pending: number[]) {
  document.querySelector(".pending-note")?.remove();
  if (!pending.length) return;
  if (tiles) pending.forEach((i) => tiles.children[i]?.classList.add("pending"));
  const note = document.createElement("p"); note.className = "fine pending-note"; note.setAttribute("role", "status");
  note.textContent = pendingText(pending.length);
  anchor.after(note);
}
