// The Lab's strings: its own en / fr dictionaries (app/src/i18n/lab.*.ts), kept out of the shared ones so the game
// bundle does not carry them. tl() / tln() work like t() / tn() with typed LabKey keys; shared keys (rp.*) still use t().
import { localizeDom, t, translator, type Key, type Lang } from "../i18n/index.ts";
import { labEn, type LabKey } from "../i18n/lab.en.ts";
import { labFr } from "../i18n/lab.fr.ts";

export type { LabKey };
export const LAB_DICTS: Record<Lang, Record<LabKey, string>> = { en: labEn, fr: labFr };
export const { t: tl, tn: tln } = translator<LabKey>(LAB_DICTS);

const isLabKey = (k: string): k is LabKey => k in labEn;

/** localizeDom() for lab.html: data-i18n* keys are Lab keys, or shared ones. */
export const localizeLab = (root: ParentNode = document) => localizeDom(root, (k) => (isLabKey(k) ? tl(k) : t(k as Key)));
