// The EN | FR switch in the top bar (game, replay and about pages). Choosing a language saves it, drops a ?lang=
// parameter (it would win over the saved choice) and reloads: every page renders its strings once, at load.
import { getLang, LANGS, saveLang, t, type Lang } from "./index.ts";
import "./i18n.css";

export function mountLangSwitch(host: Element | null = document.querySelector(".topbar")) {
  if (!host || host.querySelector(".langsw")) return;
  const box = document.createElement("div");
  box.className = "langsw";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", t("lang.group"));
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.type = "button";
    b.lang = l;
    b.textContent = l.toUpperCase();
    b.setAttribute("aria-label", t(`lang.${l}`));
    b.setAttribute("aria-pressed", String(l === getLang()));
    b.onclick = () => switchTo(l);
    box.append(b);
  }
  host.append(box);
}

function switchTo(l: Lang) {
  if (l === getLang()) return;
  saveLang(l);
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  if (url.href === location.href) location.reload(); else location.assign(url.href);
}
