import { getDay, getIndex, getMoment, localDate, type Day } from "./api.ts";
import { playDay } from "./round.ts";
import { shareText, square } from "./share.ts";
import { shareCardFile, shareFileName, shareScore } from "./shareImage.ts";
import { computeStats, KIND_LABEL, KINDS, proReads, ZONE_LABEL, ZONES, toRecord, type Bucket } from "./stats.ts";
import { readsText } from "./text.ts";
import { History } from "./storage.ts";
import "./stats.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const history = new History(localStorage);
const params = new URLSearchParams(location.search);
const realToday = params.get("today") ?? localDate();
const date = params.get("date") ?? realToday;

function show(id: "intro" | "game" | "done") {
  for (const s of ["intro", "game", "done"]) $(s).hidden = s !== id;
  if (id === "game") $("archive").hidden = true;
  window.scrollTo({ top: 0 });
}

function untilTomorrow(): string {
  const now = new Date(); const next = new Date(now); next.setHours(24, 0, 0, 0);
  const min = Math.max(0, Math.round((next.getTime() - now.getTime()) / 60000));
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
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
      a.textContent = `#${d.day_number} · ${d.date}${pts ? ` · ${pts.reduce((x, y) => x + y, 0)} ${pts.map(square).join("")}` : ""}`;
      list.append(a);
    }
  } catch { box.hidden = true; }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const pctText = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
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
    row.setAttribute("aria-label", `${name}: ${b.avg == null ? "no moments yet" : `${b.avg} points on average over ${b.n} moments`}`);
    box.append(row);
  }
  return box;
}

/** "Your stats": full card on the done screen, compact one on the intro. Built from local history only. */
function renderStats(host: HTMLElement, compact: boolean) {
  host.querySelector(".stats")?.remove();
  const s = computeStats(history.days(), history.moments());
  if (!s.games) return;
  const card = el("section", `card stats${compact ? " compact" : ""}`);
  card.setAttribute("aria-label", "Your stats");
  const head = el("div", "shead");
  head.append(el("h2", "", "Your stats"), el("span", "fine", `${s.games} game${s.games === 1 ? "" : "s"}`));
  const tiles = el("div", "stiles");
  const tile = (v: string, k: string, accent = "") => { const t = el("div", `stile ${accent}`); t.append(el("b", "", v), el("span", "", k)); tiles.append(t); };
  if (compact) {
    tile(s.avgDay == null ? "–" : `${s.avgDay}`, "Avg day");
    tile(s.bestDay ? `${s.bestDay.total}` : "–", "Best day");
    tile(pctText(s.perfect), "Perfect picks", "top");
  } else {
    tile(s.proRead == null ? "–" : `${Math.round(s.proRead * 100)}%`, "Pro reads", "pro"); // games are in the header
    tile(s.avgDay == null ? "–" : `${s.avgDay}`, "Avg day");
    tile(s.bestDay ? `${s.bestDay.total}` : "–", "Best day");
    tile(pctText(s.perfect), "Scored 100", "top");
    tile(pctText(s.proInstinct), "Pro instinct");
    tile(pctText(s.aiAgree), "Same as AI", "ai");
  }
  card.append(head, tiles);
  if (!compact && s.moments) {
    card.append(
      statBars("Avg points by zone", ZONES.map((z) => [ZONE_LABEL[z], s.byZone[z]])),
      statBars("Avg points by pick", KINDS.map((k) => [KIND_LABEL[k], s.byKind[k]])),
    );
  }
  if (s.insight) card.append(el("p", "insight", s.insight));
  const anchor = compact ? host.querySelector("#play") : null;
  if (anchor) anchor.after(card); else host.append(card);
}

let savedUrl = "";
function finish(day: Day, pts: number[]) {
  show("done");
  const total = pts.reduce((a, b) => a + b, 0);
  const streak = history.streak(realToday);
  $("total").textContent = `${total}`;
  $("squares").textContent = pts.map(square).join(" ");
  const reads = proReads(history.moments()[date]); // from the per-moment records (null for days played before question 2)
  $("reads").textContent = reads ? readsText(reads.right, reads.of) : "";
  $("reads").hidden = !reads;
  $("streak").textContent = `🔥 Streak: ${streak} day${streak === 1 ? "" : "s"}`;
  $("next-in").textContent = date === realToday ? `Next five in ${untilTomorrow()}` : "";
  const text = `${shareText(day.day_number, pts, reads)}
${location.origin}`;
  const btn = $<HTMLButtonElement>("share");
  btn.textContent = "Share my score";
  // the PNG is rendered up front: share() must run within the tap's user activation
  let file: File | null = null;
  let save = document.getElementById("save-image") as HTMLAnchorElement | null;
  if (!save) {
    save = el("a", "saveimg", "Save image");
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
      if (how === "copied") btn.textContent = "Copied ✓";
    } catch { /* cancelled */ }
  };
  renderStats($("done"), false);
  void renderArchive();
}

async function start() {
  const seen = history.flag("pm.howto");
  $<HTMLDetailsElement>("howto").open = !seen;
  $("howto").addEventListener("toggle", () => history.setFlag("pm.howto"));
  let day: Day;
  try { day = await getDay(date); } catch {
    $("intro-text").textContent = "No challenge for this day. Come back tomorrow.";
    $<HTMLButtonElement>("play").hidden = true;
    void renderArchive();
    return;
  }
  $("day-label").textContent = `Day #${day.day_number}${date !== realToday ? ` · ${date}` : ""}`;
  const done = history.days()[date];
  if (done) return finish(day, done);
  renderStats($("intro"), true);
  void renderArchive();
  if (day.moments[0]) getMoment(day.moments[0]).catch(() => {}); // warm the first moment: Play starts without a fetch
  $<HTMLButtonElement>("play").onclick = async () => {
    history.setFlag("pm.howto");
    show("game");
    const pts = await playDay(
      {
        canvas: $<HTMLCanvasElement>("pitch"), title: $("title"), dots: $("dots"), hint: $("hint"), actions: $("actions"),
        list: $("list"), reveal: $("reveal"), next: $<HTMLButtonElement>("next"),
      },
      day,
      history.player(),
      (mo, res) => { try { history.record(date, toRecord(mo, res)); } catch { /* stats are best effort */ } },
    );
    history.finish(date, pts, date === realToday);
    finish(day, pts);
  };
}

void start();
