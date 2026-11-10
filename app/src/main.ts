import { getDay, localDate } from "./api.ts";
import { playDay } from "./round.ts";
import { shareText } from "./share.ts";
import { History } from "./storage.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const history = new History(localStorage);
const today = new URLSearchParams(location.search).get("date") ?? localDate();

async function start() {
  const intro = $("intro"), game = $("game"), done = $("done");
  try {
    const day = await getDay(today);
    const played = history.days()[today];
    if (played) return finish(day.day_number, played);
    $<HTMLButtonElement>("play").onclick = async () => {
      intro.hidden = true; game.hidden = false;
      const pts = await playDay({ canvas: $("pitch"), title: $("title"), actions: $("actions"), reveal: $("reveal"), next: $<HTMLButtonElement>("next") }, day, history.player());
      history.finish(today, pts); finish(day.day_number, pts);
    };
  } catch { $("intro-text").textContent = "No challenge today yet. Come back tomorrow."; }
  function finish(n: number, pts: number[]) {
    intro.hidden = true; game.hidden = true; done.hidden = false;
    const text = shareText(n, pts);
    $("score").textContent = text; $("streak").textContent = `Streak: ${history.streak(today)} day(s)`;
    $<HTMLButtonElement>("share").onclick = async () => {
      try { if (navigator.share) await navigator.share({ text }); else await navigator.clipboard.writeText(text); $("share").textContent = "Copied"; } catch { /* user cancelled */ }
    };
  }
}
start();
