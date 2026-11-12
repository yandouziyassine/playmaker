import { getDay, getIndex, getMoment, localDate, type Day } from "./api.ts";
import { playDay, Tour } from "./round.ts";
import { shareText, square } from "./share.ts";
import { shareCardFile, shareFileName, shareScore } from "./shareImage.ts";
import { computeStats, kindLabel, KINDS, proReads, zoneLabel, ZONES, toRecord, type Bucket } from "./stats.ts";
import { readsText } from "./text.ts";
import { History } from "./storage.ts";
import { icon, setIconText } from "./design/icons.ts";
import { startPreview } from "./preview.ts";
import { initLang, localizeDom, pct, t, tn } from "./i18n/index.ts";
import { mountLangSwitch } from "./i18n/ui.ts";
import { markPendingDay, pickQueue, registerSW, startFlushing, warmOffline } from "./offline/index.ts";

initLang(); // ?lang=, saved choice, browser language; sets <html lang>
localizeDom();
mountLangSwitch();
registerSW(); // offline play (production builds; see app/src/offline/register.ts)

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
  void statsCss.then(() => {
    host.querySelector(".stats")?.remove(); // callbacks run in call order: the latest render wins, one card per host
    const card = buildStats(s, compact);
    const anchor = compact ? host.querySelector("#play") : null;
    if (anchor) anchor.after(card); else host.append(card);
  });
}

function buildStats(s: ReturnType<typeof computeStats>, compact: boolean): HTMLElement {
  const card = el("section", `card stats${compact ? " compact" : ""}`);
  card.setAttribute("aria-label", t("stats.title"));
  const head = el("div", "shead");
  head.append(el("h2", "", t("stats.title")), el("span", "fine", tn("stats.games", s.games)));
  const tiles = el("div", "stiles");
  const tile = (v: string, k: string, accent = "") => { const t = el("div", `stat stile ${accent}`); t.append(el("b", "", v), el("span", "", k)); tiles.append(t); };
  if (compact) {
    tile(s.avgDay == null ? "–" : `${s.avgDay}`, t("stats.avgDay"));
    tile(s.bestDay ? `${s.bestDay.total}` : "–", t("stats.bestDay"));
    tile(pctText(s.perfect), t("stats.perfect"), "top");
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

let savedUrl = "";
function finish(day: Day, pts: number[]) {
  show("done");
  const total = pts.reduce((a, b) => a + b, 0);
  const streak = history.streak(realToday);
  $("total").textContent = `${total}`;
  // the result squares: styled tiles for the eye, the emoji string (same as the share text) as the accessible text
  const sq = $("squares");
  const tiles = el("span", "tiles"); tiles.setAttribute("aria-hidden", "true");
  pts.forEach((p, i) => { const t = el("span", `tile ${p >= 100 ? "top" : p >= 50 ? "mid" : "low"}`); t.style.animationDelay = `${i * 70}ms`; tiles.append(t); });
  sq.replaceChildren(el("span", "sr-only", pts.map(square).join(" ")), tiles);
  markPendingDay(sq, tiles, pickQueue.pending(date).map((p) => p.index)); // answers given offline: scored later
  const reads = proReads(history.moments()[date]); // from the per-moment records (null for days played before question 2)
  if (reads) setIconText($("reads"), "eye", readsText(reads.right, reads.of)); else $("reads").textContent = "";
  $("reads").hidden = !reads;
  setIconText($("streak"), "flame", tn("done.streak", streak));
  $("next-in").textContent = date === realToday ? t("done.nextIn", { time: untilTomorrow() }) : "";
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
  renderStats($("done"), false);
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
    void renderArchive();
    return;
  }
  $("day-label").textContent = `${t("day.label", { n: day.day_number })}${date !== realToday ? ` · ${date}` : ""}`;
  current = day;
  // the service worker caches the day and its five moments: opened online, the day can be finished offline
  warmOffline([`content/days/${date}.json`, ...day.moments.map((id) => `content/moments/${id}.json`)]);
  const done = history.days()[date];
  if (done) return finish(day, done);
  play.disabled = false; play.removeAttribute("aria-busy");
  play.replaceChildren(icon("play"), t("intro.play"));
  play.classList.add("with-icon");
  stopPreview = startPreview($("preview"), $<HTMLCanvasElement>("preview-pitch"), $("preview-cap"), date);
  renderStats($("intro"), true);
  void renderArchive();
  if (day.moments[0]) getMoment(day.moments[0]).catch(() => {}); // warm the first moment: Play starts without a fetch
  play.onclick = async () => {
    history.setFlag("pm.howto");
    show("game");
    // guided first moment: first visit only (no day played, never finished or skipped); ?tour=0 turns it off
    const tourOn = !history.flag(TOUR_FLAG) && params.get("tour") !== "0" && !Object.keys(history.days()).length;
    const tour = tourOn ? new Tour($("tour"), () => (!$("next").hidden ? $("next") : $("pitch")), () => history.setFlag(TOUR_FLAG)) : null;
    const pts = await playDay(
      {
        canvas: $<HTMLCanvasElement>("pitch"), title: $("title"), dots: $("dots"), hint: $("hint"), actions: $("actions"),
        list: $("list"), reveal: $("reveal"), next: $<HTMLButtonElement>("next"), tour,
      },
      day,
      history.player(),
      (mo, res) => { try { history.record(date, toRecord(mo, res)); } catch { /* stats are best effort */ } },
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

void start();
