export interface Moment {
  id: string; league: string; home: string; away: string; attacking: "home" | "away"; minute: number; scoreline?: [number, number]; fps: number;
  carrier: number; players: { side: 0 | 1; shirt: number; name: string }[];
  lead_up: ([number, number] | null)[][]; ball: ([number, number] | null)[];
  options: { k: number; kind: "pass" | "carry" | "shot"; player?: number; angle?: number; to: [number, number] }[];
  credit: string;
}
export interface Reason { text: string; effect: -1 | 0 | 1 }
export interface Day { day_number: number; date: string; moments: string[] }
export interface PickResult {
  option: number; points: number; among_best: boolean; pro_instinct: boolean; ai_pick: number; pro_pick: number;
  outcome: { kind: "goal" | "shot" | "kept" | "lost"; net_xg_15s: number };
  reasons: Record<number, Reason[]>; crowd: Record<number, number> | null; repeat: boolean; all_points: Record<number, number>;
  after: { fps: number; frames: ([number, number] | null)[][]; ball: ([number, number] | null)[] } | null;
  /** Second question: the recorded guess of the pro's choice, and whether it was the real pass (null: no guess sent). */
  guess: number | null; guess_right: boolean | null;
}
export interface DayIndex { days: { date: string; day_number: number }[] }
export const getIndex = () => fetch("content/days/index.json").then(json<DayIndex>);
const json = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<T>; };
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const getDay = (date: string) => fetch(`content/days/${date}.json`).then(json<Day>);
const moments = new Map<string, Promise<Moment>>();
/** Memoised: main.ts warms the day's first moment while the intro is shown, playDay() then gets it without a wait. */
export const getMoment = (id: string): Promise<Moment> => {
  let p = moments.get(id);
  if (!p) {
    p = fetch(`content/moments/${id}.json`).then(json<Moment>);
    p.catch(() => moments.delete(id)); // a failed fetch can be retried
    moments.set(id, p);
  }
  return p;
};
/** `guess`: the answer to "What did the pro actually do?" (omitted from the body when null). */
export const postPick = (player: string, moment: string, option: number, guess: number | null): Promise<PickResult> =>
  import.meta.env.VITE_DEMO === "1"
    ? import("./demo.ts").then((d) => d.demoPick(moment, option, guess)) // static demo: scored in the browser
    : fetch("api/pick", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(guess === null ? { player, moment, option } : { player, moment, option, guess }),
  }).then(json<PickResult>);
