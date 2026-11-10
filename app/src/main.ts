import { getDay, getIndex, localDate, type Day } from "./api.ts";
import { playDay } from "./round.ts";
import { shareText, square } from "./share.ts";
import { History } from "./storage.ts";

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

function finish(day: Day, pts: number[]) {
  show("done");
  const total = pts.reduce((a, b) => a + b, 0);
  $("total").textContent = `${total}`;
  $("squares").textContent = pts.map(square).join(" ");
  $("streak").textContent = `🔥 Streak: ${history.streak(realToday)} day${history.streak(realToday) === 1 ? "" : "s"}`;
  $("next-in").textContent = date === realToday ? `Next five in ${untilTomorrow()}` : "";
  const text = shareText(day.day_number, pts);
  const btn = $<HTMLButtonElement>("share");
  btn.textContent = "Share my score";
  btn.onclick = async () => {
    try {
      if (navigator.share) await navigator.share({ text: `${text}\n${location.origin}` });
      else { await navigator.clipboard.writeText(`${text}\n${location.origin}`); btn.textContent = "Copied ✓"; }
    } catch { /* cancelled */ }
  };
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
  void renderArchive();
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
    );
    history.finish(date, pts, date === realToday);
    finish(day, pts);
  };
}

void start();
