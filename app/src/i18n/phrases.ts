// The coach's explanation phrases arrive in English (server answer files, and the client port of coach/explain.py).
// For French, each known template of the PHRASES table is matched with a regex built from the English template and
// rewritten with the French one; numbers get French decimals ("6,2") and "%" its narrow no-break space. A phrase
// that matches no template is returned unchanged (English) rather than guessed.
import { getLang, NNBSP, type Lang } from "./index.ts";

/** [English template, French template]; placeholders as in coach/explain.ts PHRASES ({v}, {gain}, {loss}, {xg}, {keep}, {pct}). */
export const PHRASE_FR: readonly (readonly [string, string])[] = [
  // pass features
  ["long pass ({v} m)", "passe longue ({v} m)"],
  ["short pass ({v} m)", "passe courte ({v} m)"],
  ["{v} m forward", "{v} m vers l’avant"],
  ["{v} m backward", "{v} m vers l’arrière"],
  ["{v}° off straight ahead", "{v}° d’écart avec l’axe du but"],
  ["no defender in the lane", "aucun défenseur sur la trajectoire"],
  ["1 defender in the lane", "1 défenseur sur la trajectoire"],
  ["{v} defenders in the lane", "{v} défenseurs sur la trajectoire"],
  ["receiver has {v} m of space", "le receveur a {v} m d’espace"],
  ["nearest defender {v} m from the passer", "défenseur le plus proche à {v} m du passeur"],
  ["{v} % pitch control at the receiver", "{v} % de contrôle du terrain au receveur"],
  ["receiver {v} m into the opponent half", "receveur {v} m dans la moitié adverse"],
  ["receiver {v} m inside his own half", "receveur {v} m dans sa propre moitié"],
  ["receiver {v} m from goal", "receveur à {v} m du but"],
  // shot features
  ["shot from {v} m", "tir à {v} m"],
  ["{v}° of goal mouth visible", "{v}° d’ouverture sur le but"],
  ["no defender in the shot cone", "aucun défenseur dans l’angle de tir"],
  ["1 defender in the shot cone", "1 défenseur dans l’angle de tir"],
  ["{v} defenders in the shot cone", "{v} défenseurs dans l’angle de tir"],
  // value phrases
  ["{gain} xG if it arrives, {loss} if lost there", "{gain} xG si elle arrive, {loss} si le ballon est perdu là"],
  ["{pct} % pitch control where the carry ends", "{pct} % de contrôle du terrain au bout de la conduite"],
  ["{gain} xG if kept, {loss} if lost there", "{gain} xG si le ballon est conservé, {loss} s’il est perdu là"],
  ["{xg} xG for the shot, {keep} if the ball is kept here", "{xg} xG pour le tir, {keep} si le ballon est gardé ici"],
];

const NUM = "([-+]?\\d+(?:\\.\\d+)?)";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Rule { re: RegExp; names: string[]; fr: string }
const RULES: Rule[] = PHRASE_FR.map(([enT, frT]) => {
  const names: string[] = [];
  const src = enT.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return escape(part);
    names.push(m[1]!);
    return NUM;
  }).join("");
  return { re: new RegExp(`^${src}$`), names, fr: frT };
});

/** "6.2" -> "6,2", "+0.021" -> "+0,021" (signs and digits kept as the coach printed them). */
const frNumber = (s: string) => s.replace(".", ",");

/** The phrase in `lang`: French via the template table, English (or anything unknown) unchanged. */
export function translatePhrase(text: string, lang: Lang = getLang()): string {
  if (lang !== "fr") return text;
  const s = text.trim();
  for (const r of RULES) {
    const m = r.re.exec(s);
    if (!m) continue;
    const vals: Record<string, string> = {};
    r.names.forEach((n, i) => { vals[n] = frNumber(m[i + 1]!); });
    return r.fr.replace(/\{(\w+)\}/g, (_, n: string) => vals[n] ?? "").replace(/ %/g, `${NNBSP}%`);
  }
  return text;
}
