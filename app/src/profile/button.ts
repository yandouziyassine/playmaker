// The profile button in the top bar. The panel itself (panel.ts, transfer.ts, profile.css) is a lazy chunk loaded on the
// first tap, or right away when the page was opened from a player-code link (#code=...).
import { pt } from "./i18n.ts";

const USER_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="7" r="3.5"/><path d="M3.5 17c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5"/></svg>';

async function open(pendingCode?: string) {
  const { openProfile } = await import("./panel.ts");
  openProfile({ pendingCode, onImported: () => setTimeout(() => location.reload(), 1200) });
}

export function mountProfileButton(host: Element | null = document.querySelector(".topbar")) {
  if (!host || host.querySelector(".pf-btn")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pf-btn";
  b.innerHTML = USER_ICON;
  b.setAttribute("aria-label", pt("profile.open"));
  b.title = pt("profile.open");
  b.addEventListener("click", () => void open());
  const lang = host.querySelector(".langsw");
  if (lang) host.insertBefore(b, lang); else host.append(b);

  const m = /[#&]code=([^&]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, "", location.pathname + location.search);
    let code: string | undefined;
    try { code = decodeURIComponent(m[1]!); } catch { code = undefined; }
    if (code) void open(code);
  }
}
