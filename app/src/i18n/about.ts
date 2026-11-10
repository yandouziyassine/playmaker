// About page: both languages are in the HTML; show the picked one, title it and add the EN | FR switch.
import { getLang, initLang, localizeDom } from "./index.ts";
import { mountLangSwitch } from "./ui.ts";

initLang();
for (const m of document.querySelectorAll<HTMLElement>("main[data-lang]")) m.hidden = m.dataset.lang !== getLang();
localizeDom();
mountLangSwitch();
