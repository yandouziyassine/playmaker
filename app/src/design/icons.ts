// One inline-SVG icon set for the whole UI: 20 px grid, 1.75 px stroke, round caps and joins, currentColor.
// Decorative (aria-hidden): the text next to an icon always carries the meaning, and textContent stays plain text.
const P = {
  arrowRight: '<path d="M4 10h12M11 5l5 5-5 5"/>',
  arrowLeft: '<path d="M16 10H4M9 5l-5 5 5 5"/>',
  arrowUp: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  x: '<path d="M5 5l10 10M15 5L5 15"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  approx: '<path d="M4 8c2-2 4-2 6 0s4 2 6 0M4 13c2-2 4-2 6 0s4 2 6 0"/>',
  eye: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.5"/>',
  flame: '<path d="M10 2.5c.5 3 4.5 4.5 4.5 9a4.5 4.5 0 0 1-9 0c0-2 1-3.3 2-4.3.2 1.6 1 2.6 2 2.8-.6-2.5-.2-5.3.5-7.5z"/>',
  spark: '<path d="M10 2.5l1.8 5.7 5.7 1.8-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8z"/>',
  target: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.5"/><circle cx="10" cy="10" r=".6"/>',
  goal: '<path d="M2.5 16V5h15v11"/><path d="M2.5 8.5h15M2.5 12h15M7.5 5v11M12.5 5v11"/>',
  keep: '<circle cx="10" cy="10" r="7"/><path d="M7 10.3l2 2 4-4.5"/>',
  lost: '<circle cx="10" cy="10" r="7"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/>',
  replay: '<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.5V7h3.5"/>',
  share: '<path d="M10 12.5V3M6.5 6.5L10 3l3.5 3.5"/><path d="M4 10v6h12v-6"/>',
  download: '<path d="M10 3v9.5M6.5 9L10 12.5 13.5 9"/><path d="M4 16h12"/>',
  play: '<path d="M6.5 4.5v11l9-5.5z"/>',
  pause: '<path d="M7 4.5v11M13 4.5v11"/>',
  cube: '<path d="M10 2.5l6.5 3.7v7.6L10 17.5l-6.5-3.7V6.2z"/><path d="M3.5 6.2L10 10l6.5-3.8M10 10v7.5"/>',
  pitch: '<rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M4 10h12"/><circle cx="10" cy="10" r="2.25"/>',
  list: '<path d="M7 5.5h10M7 10h10M7 14.5h10M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01"/>',
  coach: '<path d="M10 3a4 4 0 0 1 4 4c0 1.6-.8 2.6-1.8 3.4-.7.6-1 1.1-1 2.1H8.8c0-1-.3-1.5-1-2.1C6.8 9.6 6 8.6 6 7a4 4 0 0 1 4-4zM8.5 15.5h3M9 17.5h2"/>',
  chevron: '<path d="M7.5 5l5 5-5 5"/>',
} as const;
export type IconName = keyof typeof P;

/** SVG markup of an icon (for innerHTML). */
export function iconSvg(name: IconName, cls = ""): string {
  return `<svg class="icon${cls ? ` ${cls}` : ""}" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name]}</svg>`;
}

/** An icon as an element. */
export function icon(name: IconName, cls = ""): Element {
  const t = document.createElement("template");
  t.innerHTML = iconSvg(name, cls);
  return t.content.firstElementChild!;
}

/** Replaces an element's content with an icon and a text node (before it, or after with `after`). */
export function setIconText(el: HTMLElement, name: IconName, text: string, after = false) {
  const t = document.createTextNode(text);
  if (after) el.replaceChildren(t, icon(name)); else el.replaceChildren(icon(name), t);
  el.classList.add("with-icon");
}

/** A small spinner element (decorative; pair it with aria-busy on the busy element and a text label). */
export function spinner(): HTMLElement {
  const s = document.createElement("span");
  s.className = "spinner"; s.setAttribute("aria-hidden", "true");
  return s;
}
