import { getDay, getIndex, getMoment, localDate, type Day } from "./api.ts";
import { playDay, playMoment, Tour } from "./round.ts";
import { shareText, square } from "./share.ts";
import { shareCardFile, shareFileName, shareScore } from "./shareImage.ts";
import { computeStats, kindLabel, KINDS, proReads, zoneLabel, ZONES, toRecord, type Bucket } from "./stats.ts";
import { optionLabel } from "./text.ts";
import { dayNotebook, lessonsFor, notebookFromRecords, weakestSkill, type Lesson, type NotebookEntry } from "./lessons.ts";
import { History, TrainStore, type TrainState } from "./storage.ts";
import { bankSummary, describe, getBank, momentZone, nextId, recordPlay, syncBank, trainPick } from "./training.ts";
import { icon, setIconText } from "./design/icons.ts";
import { startPreview } from "./preview.ts";
import { getLang, initLang, localizeDom, num, pct, t, tn } from "./i18n/index.ts";
import { mountLangSwitch } from "./i18n/ui.ts";
import { mountProfileButton } from "./profile/button.ts";
import { markPendingDay, pickQueue, registerSW, startFlushing, warmOffline } from "./offline/index.ts";

initLang(); // ?lang=, saved choice, browser language; sets <html lang>
localizeDom();
mountLangSwitch();
mountProfileButton(); // nickname + player code (no account): app/src/profile
registerSW(); // offline play (production builds; see app/src/offline/register.ts)
prefetch3DOnIntent();

/** The three.js 3D view is a ~140 kB (gzip) lazy chunk: nothing loads it on page load. Its download starts when the
 *  visitor shows intent (pointer over, touch or keyboard focus on the 3D toggle), so a tap finds it (nearly) ready. */
function prefetch3DOnIntent() {
  const evs = ["pointerover", "touchstart", "focusin"] as const;
  const go = (e: Event) => {
    if (!(e.target instanceof Element) || !e.target.closest(".v3d-toggle")) return;
    for (const ev of evs) document.removeEventListener(ev, go, true);
    import("./view3d/view.ts").catch(() => { /* toggle.ts reports a failure when the visitor turns 3D on */ });
  };
  for (const ev of evs) document.addEventListener(ev, go, { capture: true, passive: true });
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const history = new History(localStorage);
const params = new URLSearchParams(location.search);
// let: the static demo maps today onto its fixed set of days before start() reads them (app/src/demo.ts)
let realToday = params.get("today") ?? localDate();
let date = params.get("date") ?? realToday;

const TOUR_FLAG = "pm.tour";

let stopPreview = () => {};
function show(id: "intro" | "game" | "done") {
  for (const s of ["intro", "game", "done"]) $(s).hidden = s !== id;
  document.body.dataset.screen = id;
  if (id !== "intro") stopPreview();
  if (id === "game") $("archive").hidden = true;
  window.scrollTo({ top: 0 });
}

function untilTomorrow(): string {
  const now = new Date(); const next = new Date(now); next.setHours(24, 0, 0, 0);
  const min = Math.max(0, Math.round((next.getTime() - now.getTime()) / 60000));
  return t("time.hm", { h: Math.floor(min / 60), m: String(min % 60).padStart(2, "0") });
}

async function renderArchive() {
  const box = $("archive");
  try {
    const idx = await getIndex();
    const played = history.days();
    const past = idx.days.filter((d) => d.date <= realToday && d.date !== date).slice(-14).reverse();
    if (!past.length) { box.hidden = true; return; }
    box.hidden = false;
    const list = $("archive-list"); list.innerHTML = "";
    for (const d of past) {
      const a = document.createElement("a");
      a.href = `?date=${d.date}`;
      const pts = played[d.date];
      a.append(el("b", "", `#${d.day_number}`), el("span", "", d.date));
      a.append(el("span", "pts", pts ? `${pts.reduce((x, y) => x + y, 0)}/${pts.length * 100}` : t("archive.play")));
      list.append(a);
    }
  } catch { box.hidden = true; }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const pctText = (x: number | null) => (x == null ? "–" : pct(x));
const tierOf = (v: number) => (v >= 80 ? "top" : v >= 50 ? "mid" : "low");

function statBars(title: string, rows: [string, Bucket][]) {
  const box = el("div", "sbars");
  box.append(el("p", "label", title));
  for (const [name, b] of rows) {
    const row = el("div", "sbar");
    const track = el("span", "track"), fill = el("span", `fill ${b.avg == null ? "" : tierOf(b.avg)}`);
    fill.style.width = `${b.avg ?? 0}%`; track.append(fill);
    const val = el("span", "val", b.avg == null ? "–" : `${b.avg}`);
    if (b.n) val.append(el("small", "", ` (${b.n})`));
    row.append(el("span", "name", name), track, val);
    row.setAttribute("aria-label", b.avg == null ? t("stats.barEmpty", { name }) : t("stats.bar", { name, avg: b.avg, n: b.n }));
    box.append(row);
  }
  return box;
}

// The stats card's stylesheet is not render-blocking (the intro paints from the inlined critical CSS): it is fetched
// from the start, in parallel, and a card is only inserted once it has loaded, so the card never shows unstyled.
const statsCss = import("./stats.css").catch(() => { /* offline or failed: the card still renders */ });

/** "Your stats": full card on the done screen, compact one on the intro. Built from local history only. */
function renderStats(host: HTMLElement, compact: boolean) {
  host.querySelector(".stats")?.remove();
  const s = computeStats(history.days(), history.moments());
  if (!s.games) return;
  const streak = history.streak(realToday);
  void statsCss.then(() => {
    host.querySelector(".stats")?.remove(); // callbacks run in call order: the latest render wins, one card per host
    const card = buildStats(s, compact, streak);
    // intro: three tiles above the call to action (it sits at the bottom of the screen, so nothing moves)
    const anchor = compact ? host.querySelector(".kickoff") : null;
    if (anchor) anchor.before(card); else host.append(card);
  });
}

function buildStats(s: ReturnType<typeof computeStats>, compact: boolean, streak = 0): HTMLElement {
  const card = el("section", compact ? "stats compact" : "card stats");
  card.setAttribute("aria-label", t("stats.title"));
  const head = el("div", compact ? "shead sr-only" : "shead");
  head.append(el("h2", "", t("stats.title")), el("span", "fine", tn("stats.games", s.games)));
  const tiles = el("div", "stiles");
  const tile = (v: string, k: string, accent = "") => { const t = el("div", `stat stile ${accent}`); t.append(el("b", "", v), el("span", "", k)); tiles.append(t); };
  if (compact) {
    tile(`${streak}`, tn("done.streakTile", streak));
    tile(s.bestDay ? `${s.bestDay.total}` : "–", t("stats.bestDay"));
    tile(pctText(s.proRead), t("stats.proReads"), "pro");
  } else {
    tile(pctText(s.proRead), t("stats.proReads"), "pro"); // games are in the header
    tile(s.avgDay == null ? "–" : `${s.avgDay}`, t("stats.avgDay"));
    tile(s.bestDay ? `${s.bestDay.total}` : "–", t("stats.bestDay"));
    tile(pctText(s.perfect), t("stats.scored100"), "top");
    tile(pctText(s.proInstinct), t("stats.likePro"));
    tile(pctText(s.aiAgree), t("stats.sameAi"), "ai");
  }
  card.append(head, tiles);
  if (!compact && s.moments) {
    card.append(
      statBars(t("stats.byZone"), ZONES.map((z) => [zoneLabel(z), s.byZone[z]])),
      statBars(t("stats.byKind"), KINDS.map((k) => [kindLabel(k), s.byKind[k]])),
    );
  }
  if (s.insight) card.append(el("p", "insight", s.insight));
  return card;
}

/** The lessons of the day being played, per answered moment (in memory: a reopened day rebuilds its notebook from
 *  the stored rule ids, with the generic tips). */
const dayLessons: { date: string; perMoment: Lesson[][] } = { date: "", perMoment: [] };

/** "Coach's notebook" on the done screen: the day's 2-3 most useful lessons and the weakest skill over all history. */
function renderNotebook(host: HTMLElement) {
  host.querySelector(".notebook")?.remove();
  const recs = history.moments()[date];
  const live = dayLessons.date === date && dayLessons.perMoment.length > 0;
  const aware = live || (Array.isArray(recs) && recs.some((r) => r && Array.isArray(r.lessons)));
  if (!aware) return; // a day played before the notebook existed
  const entries: NotebookEntry[] = live ? dayNotebook(dayLessons.perMoment) : notebookFromRecords(recs);
  const box = el("section", "card notebook");
  box.setAttribute("aria-labelledby", "notebook-h");
  const h = el("h2", "", t("notebook.h2")); h.id = "notebook-h";
  const head = el("div", "nbhead"); head.append(icon("coach"), h);
  box.append(head);
  if (!entries.length) box.append(el("p", "fine nbclean", t("notebook.clean")));
  else {
    box.append(el("p", "fine nblead", t("notebook.lead")));
    const ol = el("ol", "nblist");
    for (const { lesson: l, count } of entries) {
      const li = el("li", `nbentry skill-${l.skill}`);
      const top = el("p", "nbtop");
      top.append(el("span", "lskill", t(`skill.${l.skill}`)));
      if (count > 1) top.append(el("span", "nbcount tnum", t("notebook.times", { n: count })));
      li.append(top, el("p", "ltitle", l.title), el("p", "lbody", l.body));
      ol.append(li);
    }
    box.append(ol);
  }
  const weak = weakestSkill(history.moments());
  if (weak) {
    const p = el("p", "nbweak");
    p.append(icon("target"), el("span", "", tn("notebook.weakest", weak.of, { skill: t(`skill.${weak.skill}`), k: weak.n })));
    box.append(p);
  }
  const anchor = host.querySelector("#share");
  if (anchor) anchor.before(box); else host.append(box);
}

let savedUrl = "";
function finish(day: Day, pts: number[]) {
  show("done");
  const total = pts.reduce((a, b) => a + b, 0);
  const streak = history.streak(realToday);
  $("done-eyebrow").textContent = t("done.eyebrow", { n: day.day_number });
  $("total").textContent = `${total}`;
  $("outof").textContent = t("done.outOf", { max: pts.length * 100 });
  // the result squares: the emoji string (same as the share text) as the accessible text, numbered tiles for the eye
  const sq = $("squares");
  sq.replaceChildren(el("span", "sr-only", pts.map(square).join(" ")));
  const tiles = $("tiles");
  tiles.replaceChildren(...pts.map((p, i) => { const e = el("span", `tile ${p >= 100 ? "top" : p >= 50 ? "mid" : "low"}`, String(p)); e.style.animationDelay = `${i * 70}ms`; return e; }));
  markPendingDay(tiles, tiles, pickQueue.pending(date).map((p) => p.index)); // answers given offline: scored later
  const recs = history.moments()[date];
  const reads = proReads(recs); // from the per-moment records (null for days played before question 2)
  const statTile = (id: string, value: string | null, label: string) => {
    const e = $(id); e.hidden = value === null;
    e.replaceChildren(...(value === null ? [] : [el("b", "", value), document.createTextNode(" "), el("span", "", label)]));
  };
  statTile("reads", reads ? `${reads.right}/${reads.of}` : null, t("stats.proReads"));
  const known = Array.isArray(recs) ? recs.filter((r) => r && typeof r.same_as_ai === "boolean") : [];
  statTile("sameai", known.length ? `${known.filter((r) => r.same_as_ai).length}/${known.length}` : null, t("stats.sameAi"));
  statTile("streak", `${streak}`, tn("done.streakTile", streak));
  $("next-in").textContent = date === realToday ? `${t("done.nextIn", { time: untilTomorrow() })} · ` : "";
  const text = `${shareText(day.day_number, pts, reads)}
${location.origin}`;
  const btn = $<HTMLButtonElement>("share");
  setIconText(btn, "share", t("done.share"));
  // the PNG is rendered up front: share() must run within the tap's user activation
  let file: File | null = null;
  let save = document.getElementById("save-image") as HTMLAnchorElement | null;
  if (!save) {
    save = el("a", "quiet saveimg");
    setIconText(save, "download", t("done.saveImage"));
    save.id = "save-image"; save.hidden = true;
    btn.after(save);
  }
  const link = save;
  void shareCardFile({ dayNumber: day.day_number, points: pts, streak, site: location.host }).then((f) => {
    file = f;
    if (!f) return;
    if (savedUrl) URL.revokeObjectURL(savedUrl);
    savedUrl = URL.createObjectURL(f);
    link.href = savedUrl; link.download = shareFileName(day.day_number); link.hidden = false;
  });
  btn.onclick = async () => {
    try {
      const how = await shareScore(navigator, text, file);
      if (how === "copied") setIconText(btn, "check", t("done.copied"));
    } catch { /* cancelled */ }
  };
  try { renderNotebook($("done")); } catch { /* the notebook is a bonus */ }
  renderStats($("done"), false);
  setupTraining($("done"));
  void renderArchive();
}

async function start() {
  if (import.meta.env.VITE_DEMO === "1" && !params.get("today")) {
    const demo = await import("./demo.ts");
    try { realToday = demo.demoDate(localDate(), await demo.getDemoInfo()); date = params.get("date") ?? realToday; } catch { /* keep the real date */ }
  }
  const seen = history.flag("pm.howto");
  $<HTMLDetailsElement>("howto").open = !seen;
  $("howto").addEventListener("toggle", () => history.setFlag("pm.howto"));
  const play = $<HTMLButtonElement>("play");
  let day: Day;
  try { day = await getDay(date); } catch {
    $("intro-text").textContent = t("intro.noDay");
    play.hidden = true;
    setupTraining($("intro")); // no daily game today: training may still have a bank
    $("preview").hidden = true; // shown from the first paint (index.html) for a shift-free intro; nothing to show here
    void renderArchive();
    return;
  }
  $("day-label").textContent = `${t("intro.eyebrow", { n: day.day_number, k: day.moments.length })}${date !== realToday ? ` · ${date}` : ""}`;
  try {
    $("date-label").textContent = new Intl.DateTimeFormat(getLang(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
      .format(new Date(`${date}T00:00:00Z`)).replace(/\./g, "");
  } catch { /* no Intl: no date */ }
  current = day;
  // the service worker caches the day and its five moments: opened online, the day can be finished offline
  warmOffline([`content/days/${date}.json`, ...day.moments.map((id) => `content/moments/${id}.json`)]);
  const done = history.days()[date];
  if (done) return finish(day, done);
  play.disabled = false; play.removeAttribute("aria-busy");
  setIconText(play, "arrowRight", t("intro.play"), true);
  stopPreview = startPreview($("preview"), $<HTMLCanvasElement>("preview-pitch"), $("preview-cap"), date);
  renderStats($("intro"), true);
  setupTraining($("intro"));
  void renderArchive();
  if (day.moments[0]) getMoment(day.moments[0]).catch(() => {}); // warm the first moment: Play starts without a fetch
  play.onclick = async () => {
    history.setFlag("pm.howto");
    show("game");
    // guided first moment: first visit only (no day played, never finished or skipped); ?tour=0 turns it off
    const tourOn = !history.flag(TOUR_FLAG) && params.get("tour") !== "0" && !Object.keys(history.days()).length;
    dayLessons.date = date; dayLessons.perMoment = [];
    const tour = tourOn ? new Tour($("tour"), () => (!$("next").hidden ? $("next") : $("pitch")), () => history.setFlag(TOUR_FLAG)) : null;
    const pts = await playDay(
      {
        canvas: $<HTMLCanvasElement>("pitch"), title: $("title"), dots: $("dots"), hint: $("hint"), actions: $("actions"),
        list: $("list"), reveal: $("reveal"), next: $<HTMLButtonElement>("next"), tour, score: $("score"), count: $("count"),
      },
      day,
      history.player(),
      (mo, res) => {
        try { history.record(date, toRecord(mo, res)); } catch { /* stats are best effort */ }
        try { dayLessons.perMoment.push(lessonsFor(mo, res, (k) => optionLabel(mo, k))); } catch { /* notebook: best effort */ }
      },
      (mo, option, guess, index) => pickQueue.enqueue({ player: history.player(), moment: mo.id, option, guess, date, index }),
    );
    for (const [k, p] of scoredEarly) if (k.startsWith(`${date}#`)) pts[Number(k.slice(date.length + 1))] = p; // back online mid-day
    history.finish(date, pts, date === realToday);
    finish(day, pts);
  };
}

// Answers given offline are sent when the network is back; their points then replace the day's placeholders (0) and
// their per-moment record is added, so the done screen, the share text and the stats become right.
let current: Day | null = null;
const scoredEarly = new Map<string, number>(); // "date#index" -> points, scored while that day is still being played
startFlushing(async (q, res) => {
  const d = history.days()[q.date];
  if (d && q.index < d.length) { d[q.index] = res.points; history.finish(q.date, d, false); }
  else scoredEarly.set(`${q.date}#${q.index}`, res.points);
  try { history.record(q.date, toRecord(await getMoment(q.moment), res)); } catch { /* stats are best effort */ }
}, () => {
  const pts = history.days()[date];
  if (current && pts && document.body.dataset.screen === "done") finish(current, pts);
});

// ---------- training: endless play over the whole bank (app/src/training.ts) ----------
const trainStore = new TrainStore(localStorage);
let bank: Promise<string[]> | null = null;
const getBankOnce = () => (bank ??= getBank().catch((e) => { bank = null; throw e; }));

/** The training entry (intro: the button under the call to action; done screen: the bank card's button) and, once
 *  something was played, the bank card. The bank is fetched when the page is idle (its size goes on the button). */
function setupTraining(host: HTMLElement) {
  $<HTMLButtonElement>("train").onclick = () => void startTraining();
  const later = (f: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(f, { timeout: 2500 }) : setTimeout(f, 1200));
  later(() => {
    getBankOnce().then((ids) => {
      if (!ids.length) return;
      $("train-label").textContent = t("train.entryN", { n: num(ids.length) });
      renderBank(host, trainStore.load(), ids);
    }).catch(() => { /* offline or no training API: the button still tries when tapped */ });
  });
}

/** "Training bank" card: seen x of the bank, average best, best run, best and weakest zone, and a way back in. On the
 *  done screen it is shown even before the first training play (the intro's button is not there). */
function renderBank(host: HTMLElement, st: TrainState, ids: string[]) {
  host.querySelector(".bank")?.remove();
  const intro = host.id === "intro";
  if (!st.plays && intro) return;
  const box = el("section", "card bank stats");
  box.setAttribute("aria-label", t("train.bankTitle"));
  if (st.plays) {
    const sum = bankSummary(st, ids);
    const head = el("div", "shead");
    head.append(el("h2", "", t("train.bankTitle")), el("span", "fine tnum", `${t("train.plays")} ${st.plays}`));
    const tiles = el("div", "stiles");
    const tile = (v: string, k: string, cls = "") => { const d = el("div", `stat stile ${cls}`); d.append(el("b", "", v), el("span", "", k)); tiles.append(d); };
    tile(`${num(sum.seen)}/${num(sum.size)}`, t("train.seen"));
    tile(sum.avgBest == null ? "–" : `${sum.avgBest}`, t("train.avgBest"), "ai");
    tile(`${st.bestRun}`, t("train.bestRun"), "top");
    box.append(head, tiles);
    if (sum.bestZone && sum.worstZone) box.append(el("p", "fine bankzones", t("train.zones", { best: zoneLabel(sum.bestZone), worst: zoneLabel(sum.worstZone) })));
  }
  if (!intro) {
    const go = el("button", "ghost bankgo");
    setIconText(go, "target", t("train.entryN", { n: num(ids.length) }));
    go.onclick = () => void startTraining();
    box.append(go);
  }
  const anchor = intro ? host.querySelector(".introtop") : $("next-in").parentElement;
  void statsCss.then(() => { host.querySelector(".bank")?.remove(); if (anchor) anchor.after(box); else host.append(box); });
}

async function startTraining() {
  history.setFlag("pm.howto");
  show("game");
  document.body.dataset.mode = "train";
  const hud = $("trainhud"), bar = $("trainbar"), next = $<HTMLButtonElement>("next"), hint = $("hint");
  hud.hidden = false; bar.hidden = false;
  $("train-end").onclick = () => location.reload(); // back to the intro / full-time screen as it was
  let ids: string[];
  try { ids = await getBankOnce(); } catch { hint.textContent = t("train.failed"); return; }
  let st = syncBank(trainStore.load(), ids);
  trainStore.save(st);
  if (!ids.length) { hint.textContent = t("train.empty"); return; }
  // the zone filter: from the moments' own positions (the carrier at the release); nothing is known before loading one
  const zone = $<HTMLSelectElement>("train-zone");
  zone.replaceChildren(...(["all", ...ZONES] as const).map((z) => { const o = el("option", "", z === "all" ? t("train.zoneAll") : zoneLabel(z)); o.value = z; return o; }));
  zone.value = st.zone;
  let wake: (() => void) | null = null;
  zone.onchange = () => { st = { ...st, zone: zone.value as TrainState["zone"] }; trainStore.save(st); wake?.(); };
  const drawHud = () => {
    const item = (cls: string, k: string, v: string) => { const s = el("span", cls, k); s.append(el("b", "", v)); return s; };
    hud.replaceChildren(
      item("", t("train.plays"), `${st.plays}`),
      item("", t("train.avg"), st.plays ? `${Math.round(st.sum / st.plays)}` : "–"),
      item("run", t("train.run"), `${st.run}`),
    );
  };
  drawHud();
  const count = $("count");
  const ui = {
    canvas: $<HTMLCanvasElement>("pitch"), title: $("title"), dots: $("dots"), hint, actions: $("actions"),
    list: $("list"), reveal: $("reveal"), next, tour: null, score: $("score"), count,
    training: true, pick: (mo: { id: string }, option: number, guess: number | null) => trainPick(mo.id, option, guess),
  };
  const seen = new Set<string>(); // lesson ids shown in this session
  const skip = new Set<string>(); // other zones' plays met while looking for one of the chosen zone (they keep their turn)
  for (;;) {
    const found = nextId(st, Math.random, skip);
    st = found.state;
    if (!found.id || skip.size > 60) { // nothing left for this filter in this round
      hint.textContent = t(st.zone === "all" ? "train.empty" : "train.filterEmpty");
      next.hidden = true;
      await new Promise<void>((r) => (wake = r));
      wake = null; skip.clear();
      continue;
    }
    const id = found.id;
    let mo;
    try { hint.textContent = t("train.loading"); mo = await getMoment(id); } catch { hint.textContent = t("train.failed"); return; }
    if (st.zone !== "all" && momentZone(mo) !== st.zone) { skip.add(id); continue; }
    skip.clear();
    count.textContent = t("train.play", { n: st.plays + 1 });
    let res;
    try { res = await playMoment(ui, mo, history.player(), 0, 0, [], undefined, seen); } catch { hint.textContent = t("train.failed"); return; }
    if (res) { st = recordPlay(st, id, res.points, describe(mo, res)); trainStore.save(st); drawHud(); }
    next.hidden = false;
    setIconText(next, "arrowRight", t("train.next"), true);
    next.focus();
    await new Promise<void>((r) => (next.onclick = () => r()));
  }
}

void start();
