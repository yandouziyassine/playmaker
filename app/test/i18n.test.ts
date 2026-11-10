import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Moment, PickResult } from "../src/api.ts";
import { PHRASES, fmt, signed } from "../src/coach/explain.ts";
import { en } from "../src/i18n/en.ts";
import { fr } from "../src/i18n/fr.ts";
import { DICTS, NNBSP, num, pct, resolveLang, setLang, t, tn, xg, type Key } from "../src/i18n/index.ts";
import { CAMERA_MESSAGES } from "../src/lab/camera.ts";
import { LANDMARKS } from "../src/lab/landmarks.ts";
import { PHRASE_FR, translatePhrase } from "../src/i18n/phrases.ts";
import { arrowLabel } from "../src/replay/draw.ts";
import { optionLabel, proReadLine, verdict } from "../src/text.ts";
import { streakLabel } from "../src/shareImage.ts";

afterEach(() => setLang("en"));

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?([a-z]+)/g)].map((m) => m[0]).sort();

describe("dictionaries", () => {
  it("en and fr have the same keys, placeholders and markup", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(fr[k]), k).toEqual(placeholders(en[k]));
      if (k.endsWith(".html")) expect(tags(fr[k]), k).toEqual(tags(en[k]));
      else expect(fr[k], k).not.toMatch(/<[a-z]/);
      expect(fr[k].trim().length, k).toBeGreaterThan(0);
    }
  });
  it("French strings are translated (only names, codes and units may stay identical)", () => {
    const same = (Object.keys(en) as (keyof typeof en)[]).filter((k) => en[k] === fr[k]);
    expect(same.sort()).toEqual(["kind.pass", "lab.grp.centre", "lang.en", "lang.fr", "nav.code", "reveal.points", "rp.pause", "time.hm", "tour.aria", "v3d.2d", "v3d.3d"].sort()); // same word in both
  });
  it("French typography: no plain space before ? ! ; or :", () => {
    for (const [k, v] of Object.entries(fr)) expect(v.replace(/<[^>]+>/g, ""), k).not.toMatch(/ [?!;:]/);
  });
});

describe("t / tn", () => {
  it("fills placeholders in the current language", () => {
    expect(t("opt.pass", { shirt: 9, name: "B. Nine" })).toBe("Pass to #9 B. Nine");
    setLang("fr");
    expect(t("opt.pass", { shirt: 9, name: "B. Nine" })).toBe("Passe à #9 B. Nine");
    expect(t("opt.shot")).toBe("Tir");
  });
  it("plural forms: French 0 and 1 are singular", () => {
    expect([0, 1, 2].map((n) => tn("done.streak", n))).toEqual(["Streak: 0 days", "Streak: 1 day", "Streak: 2 days"]);
    setLang("fr");
    expect([0, 1, 2].map((n) => tn("done.streak", n))).toEqual([`Série : 0 jour`, `Série : 1 jour`, `Série : 2 jours`]);
  });
});

describe("number formatting", () => {
  it("percent: '45 %' in English, narrow no-break space in French", () => {
    expect(pct(0.45)).toBe("45 %");
    expect(pct(0.45, "fr")).toBe(`45${NNBSP}%`);
  });
  it("decimals: point in English, comma in French; signed xG", () => {
    expect(num(6.25, 1)).toBe("6.3");
    expect(num(6.2, 1, "fr")).toBe("6,2");
    expect(num(1234, 0, "fr")).toBe("1234");
    expect(xg(0.0214)).toBe("+0.021 xG");
    expect(xg(-0.0041, "fr")).toBe("-0,004 xG");
    expect(xg(-0.0001)).toBe("+0.000 xG");
  });
  it("English output of the existing helpers is unchanged", () => {
    expect(arrowLabel(0, { p: 0.9, score: 0.01 })).toBe("1 · 90 % · +0.010 xG");
    expect(streakLabel(1)).toBe("STREAK 1 DAY");
  });
});

describe("language choice", () => {
  it("?lang wins, then the saved choice, then the browser language, default en", () => {
    expect(resolveLang({})).toBe("en");
    expect(resolveLang({ navigatorLanguage: "fr-CA" })).toBe("fr");
    expect(resolveLang({ navigatorLanguage: "fr" })).toBe("fr");
    expect(resolveLang({ navigatorLanguage: "en-US" })).toBe("en");
    expect(resolveLang({ navigatorLanguage: "frisian" })).toBe("en"); // not a French tag
    expect(resolveLang({ stored: "en", navigatorLanguage: "fr-FR" })).toBe("en");
    expect(resolveLang({ stored: "fr", navigatorLanguage: "en-US" })).toBe("fr");
    expect(resolveLang({ search: "?lang=en", stored: "fr", navigatorLanguage: "fr-CA" })).toBe("en");
    expect(resolveLang({ search: "?date=2026-12-01&lang=FR" })).toBe("fr");
    expect(resolveLang({ search: "?lang=de", stored: "garbage", navigatorLanguage: "de-DE" })).toBe("en");
  });
});

describe("game texts in French", () => {
  const mo = {
    players: [{ side: 0, shirt: 10, name: "A. Ten" }, { side: 0, shirt: 9, name: "B. Nine" }],
    options: [
      { k: 0, kind: "pass", player: 1, to: [0, 0] },
      { k: 1, kind: "carry", angle: 0, to: [0, 0] },
      { k: 2, kind: "carry", angle: 60, to: [0, 0] },
      { k: 3, kind: "carry", angle: -30, to: [0, 0] },
      { k: 4, kind: "shot", to: [5250, 0] },
    ],
  } as unknown as Moment;
  it("option labels, verdicts and the pro read", () => {
    setLang("fr");
    expect([0, 1, 2, 3, 4].map((k) => optionLabel(mo, k))).toEqual([
      "Passe à #9 B. Nine", "Conduite vers l’avant", "Conduite large à gauche", "Conduite en diagonale à droite", "Tir",
    ]);
    expect(verdict({ ai_pick: 2, among_best: true, points: 100 } as PickResult, 2)).toBe("Même choix que l’entraîneur IA");
    expect(proReadLine(mo, { pro_pick: 0, guess: 4, guess_right: false } as PickResult)?.text).toBe("Le pro a joué : Passe à #9 B. Nine · ta lecture : Tir");
  });
});

describe("coach phrase translation", () => {
  it("translates the known templates with French numbers", () => {
    expect(translatePhrase("receiver has 6.2 m of space", "fr")).toBe("le receveur a 6,2 m d’espace");
    expect(translatePhrase("long pass (31 m)", "fr")).toBe("passe longue (31 m)");
    expect(translatePhrase("+0.021 xG if it arrives, -0.004 if lost there", "fr")).toBe("+0,021 xG si elle arrive, -0,004 si le ballon est perdu là");
    expect(translatePhrase("63 % pitch control where the carry ends", "fr")).toBe(`63${NNBSP}% de contrôle du terrain au bout de la conduite`);
    expect(translatePhrase("no defender in the lane", "fr")).toBe("aucun défenseur sur la trajectoire");
    expect(translatePhrase("2 defenders in the shot cone", "fr")).toBe("2 défenseurs dans l’angle de tir");
    expect(translatePhrase("receiver 3 m inside his own half", "fr")).toBe("receveur 3 m dans sa propre moitié");
    expect(translatePhrase("+0.120 xG for the shot, +0.010 if the ball is kept here", "fr")).toBe("+0,120 xG pour le tir, +0,010 si le ballon est gardé ici");
  });
  it("English and unknown phrases pass through unchanged", () => {
    expect(translatePhrase("receiver has 6.2 m of space", "en")).toBe("receiver has 6.2 m of space");
    expect(translatePhrase("a brand new phrase (12 m)", "fr")).toBe("a brand new phrase (12 m)");
    setLang("fr");
    expect(translatePhrase("shot from 18 m")).toBe("tir à 18 m");
  });
  it("covers every template of the coach's PHRASES table", () => {
    const templates: string[] = [];
    for (const table of [PHRASES.pass, PHRASES.shot])
      for (const spec of Object.values(table))
        for (const [k, v] of Object.entries(spec)) if (!["split", "scale", "nd"].includes(k)) templates.push(String(v));
    templates.push(...Object.values(PHRASES.value));
    expect(new Set(PHRASE_FR.map(([e]) => e))).toEqual(new Set(templates));
    for (const tpl of templates) {
      const sample = tpl.replace("{v}", fmt(12.34, 1)).replace("{pct}", fmt(57, 0))
        .replace("{gain}", signed(0.0213)).replace("{loss}", signed(-0.0042)).replace("{xg}", signed(0.11)).replace("{keep}", signed(0.004));
      const out = translatePhrase(sample, "fr");
      expect(out, tpl).not.toBe(sample);
      expect(out, tpl).not.toMatch(/\d\.\d/); // French decimals
    }
  });
  it("every dictionary is complete for both languages", () => {
    for (const d of Object.values(DICTS)) expect(Object.keys(d).length).toBe(Object.keys(en).length);
  });
});

describe("Lab in French", () => {
  it("every landmark has a full and a short name in both languages; short names fit the 360 px dropdown", () => {
    for (const l of LANDMARKS) for (const lang of ["en", "fr"] as const) {
      const full = DICTS[lang][`lab.lm.${l.id}` as Key], short = DICTS[lang][`lab.lms.${l.id}` as Key];
      expect(full, `${lang} ${l.id}`).toBeTruthy();
      expect(short, `${lang} ${l.id}`).toBeTruthy();
      expect(short.length, `${lang} ${l.id}: ${short}`).toBeLessThanOrEqual(30);
    }
    expect(Object.keys(en).filter((k) => k.startsWith("lab.lm.")).length).toBe(LANDMARKS.length);
    expect(Object.keys(en).filter((k) => k.startsWith("lab.lms.")).length).toBe(LANDMARKS.length);
    expect(en["lab.lm.R-box-goal-far"]).toBe(LANDMARKS.find((l) => l.id === "R-box-goal-far")!.label); // English unchanged
    expect(t("lab.lm.R-box-goal-far", undefined, "fr")).toBe("Surface de réparation droite : ligne de but, côté éloigné");
  });
  it("every data-i18n key of lab.html exists, and the Lab link no longer says 'in English'", () => {
    const html = readFileSync(new URL("../lab.html", import.meta.url), "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-html|-aria|-content)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) expect(Object.keys(en), k).toContain(k);
    expect(fr["more.lab"]).not.toMatch(/anglais/);
    expect(en["more.lab"]).not.toMatch(/English/);
  });
  it("Lab plurals, camera messages and coach labels follow the language", () => {
    expect(tn("lab.people", 1)).toBe("1 person");
    expect(tn("lab.coach.rest", 4, { mates: tn("lab.mates", 1), opps: tn("lab.opps", 3) })).toBe("4 other options ranked lower (1 teammate and 3 opponents on the map).");
    expect(CAMERA_MESSAGES.insecure).toMatch(/HTTPS/);
    setLang("fr");
    expect(tn("lab.people", 0)).toBe("0 personne");
    expect(CAMERA_MESSAGES.denied).toMatch(/^L’accès à la caméra a été refusé/);
    expect(t("lab.st.ball", { p: pct(0.83) })).toBe(`Ballon trouvé (83${NNBSP}%).`);
    expect(t("rp.carry", { dir: t("rp.left", { a: 30 }) })).toBe("Conduite à 30° à gauche");
  });
});
