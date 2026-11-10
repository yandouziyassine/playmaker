// Tiny dependency-free i18n: two dictionaries (en, fr), t(key, params), plural forms, Intl number formatting and the
// language choice (?lang=fr|en, then the saved preference, then navigator.language, default en). The language is
// module state: it starts as "en" (unit tests, server-free code) and initLang() sets it once per page load.
import { en, type Key } from "./en.ts";
import { fr } from "./fr.ts";

export type Lang = "en" | "fr";
export type { Key };
export const LANGS: readonly Lang[] = ["en", "fr"];
export const DICTS: Record<Lang, Record<Key, string>> = { en, fr };
export const LANG_KEY = "pm.lang";
/** Narrow no-break space: French puts it between a number and "%". */
export const NNBSP = " ";
const LOCALE: Record<Lang, string> = { en: "en-US", fr: "fr-FR" };

let current: Lang = "en";
export const getLang = (): Lang => current;
export const setLang = (l: Lang) => { current = l; };

const isLang = (x: unknown): x is Lang => x === "en" || x === "fr";

export type Params = Record<string, string | number>;
/** The string for `key` in the current language, with {name} placeholders filled. */
export function t(key: Key, params?: Params, lang: Lang = current): string {
  const s = DICTS[lang][key] ?? en[key];
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** Plural keys come in pairs "<base>.one" / "<base>.other". French: 0 and 1 are singular; English: only 1. */
type PluralBase = { [K in Key]: K extends `${infer B}.one` ? (`${B}.other` extends Key ? B : never) : never }[Key];
export function tn(base: PluralBase, n: number, params: Params = {}, lang: Lang = current): string {
  const one = new Intl.PluralRules(LOCALE[lang]).select(n) === "one";
  return t(`${base}.${one ? "one" : "other"}` as Key, { n, ...params }, lang);
}

/** A number with exactly `nd` decimals in the current language ("6.2" / "6,2"); no grouping. */
export function num(x: number, nd = 0, lang: Lang = current): string {
  return new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: nd, maximumFractionDigits: nd, useGrouping: false }).format(x);
}

/** A share in [0, 1] as a whole percentage: "45 %" (en, plain space as the game always wrote it), "45 %" (fr, U+202F). */
export function pct(share: number, lang: Lang = current): string {
  return `${num(Math.round(share * 100), 0, lang)}${lang === "fr" ? NNBSP : " "}%`;
}

/** Signed expected goals: "+0.021 xG" / "+0,021 xG" (minus sign only when it does not round to 0). */
export function xg(x: number, lang: Lang = current): string {
  const r = Math.round(x * 1000) / 1000;
  return `${r < 0 ? "-" : "+"}${num(Math.abs(r), 3, lang)} xG`;
}

export interface LangSources { search?: string; stored?: string | null; navigatorLanguage?: string | null }
/** ?lang=fr|en wins, then the saved preference, then the browser language (fr* -> fr), else en. */
export function resolveLang({ search = "", stored = null, navigatorLanguage = null }: LangSources): Lang {
  const q = new URLSearchParams(search).get("lang")?.toLowerCase();
  if (isLang(q)) return q;
  if (isLang(stored)) return stored;
  if (navigatorLanguage && /^fr\b/i.test(navigatorLanguage)) return "fr";
  return "en";
}

const storage = (): Storage | null => { try { return localStorage; } catch { return null; } };

/** Reads the language for this page load, sets <html lang> and returns it. */
export function initLang(): Lang {
  let stored: string | null = null;
  try { stored = storage()?.getItem(LANG_KEY) ?? null; } catch { /* blocked storage */ }
  current = resolveLang({
    search: typeof location !== "undefined" ? location.search : "",
    stored,
    navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : null,
  });
  if (typeof document !== "undefined") document.documentElement.lang = current;
  return current;
}

/** Saves the preference (it outranks the browser language from now on). */
export function saveLang(l: Lang) { try { storage()?.setItem(LANG_KEY, l); } catch { /* memory only */ } }

/** Fills the page's static strings: data-i18n (text), data-i18n-html (trusted dictionary markup), data-i18n-aria
 *  (aria-label), data-i18n-content (meta content). */
export function localizeDom(root: ParentNode = document) {
  for (const e of root.querySelectorAll<HTMLElement>("[data-i18n]")) e.textContent = t(e.dataset.i18n as Key);
  for (const e of root.querySelectorAll<HTMLElement>("[data-i18n-html]")) e.innerHTML = t(e.dataset.i18nHtml as Key);
  for (const e of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) e.setAttribute("aria-label", t(e.dataset.i18nAria as Key));
  for (const e of root.querySelectorAll<HTMLElement>("[data-i18n-content]")) e.setAttribute("content", t(e.dataset.i18nContent as Key));
}
