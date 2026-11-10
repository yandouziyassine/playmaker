// Strings of the offline layer (kept here, not in app/src/i18n, so this module stays self-contained).
import { getLang, type Lang } from "../i18n/index.ts";

const EN = {
  savedTitle: "Offline",
  saved: "Your answer is saved and will be scored when you're back online.",
  savedPick: "Your pick: {pick}",
  pendingDone: "{n} answer(s) saved offline: scored when you're back online.",
  pendingDone1: "1 answer saved offline: scored when you're back online.",
  update: "New version available",
  reload: "Reload",
  dismiss: "Later",
} as const;
type OfflineKey = keyof typeof EN;
const FR: Record<OfflineKey, string> = {
  savedTitle: "Hors ligne",
  saved: "Ta réponse est enregistrée : elle sera notée dès que tu seras de nouveau en ligne.",
  savedPick: "Ton choix : {pick}",
  pendingDone: "{n} réponses enregistrées hors ligne : notées dès ton retour en ligne.",
  pendingDone1: "1 réponse enregistrée hors ligne : notée dès ton retour en ligne.",
  update: "Nouvelle version disponible",
  reload: "Recharger",
  dismiss: "Plus tard",
};
export const OFFLINE_TEXT: Record<Lang, Record<OfflineKey, string>> = { en: EN, fr: FR };

export function ot(key: OfflineKey, params: Record<string, string | number> = {}, lang: Lang = getLang()): string {
  const s = (OFFLINE_TEXT[lang] ?? EN)[key];
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export const pendingText = (n: number, lang: Lang = getLang()) => (n === 1 ? ot("pendingDone1", {}, lang) : ot("pendingDone", { n }, lang));
