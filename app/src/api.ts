export interface Moment {
  id: string; league: string; home: string; away: string; attacking: "home" | "away"; minute: number; fps: number;
  carrier: number; players: { side: 0 | 1; shirt: number; name: string }[];
  lead_up: ([number, number] | null)[][]; ball: [number, number][];
  options: { k: number; kind: "pass" | "carry" | "shot"; player?: number; angle?: number; to: [number, number] }[];
  credit: string;
}
export interface Day { day_number: number; date: string; moments: string[] }
export interface PickResult {
  points: number; among_best: boolean; pro_instinct: boolean; ai_pick: number; pro_pick: number;
  outcome: { kind: "goal" | "shot" | "kept" | "lost"; net_xg_15s: number };
  reasons: Record<number, string[]>; crowd: Record<number, number> | null; repeat: boolean;
}
const json = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<T>; };
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const getDay = (date: string) => fetch(`/content/days/${date}.json`).then(json<Day>);
export const getMoment = (id: string) => fetch(`/content/moments/${id}.json`).then(json<Moment>);
export const postPick = (player: string, moment: string, option: number) =>
  fetch("/api/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ player, moment, option }) }).then(json<PickResult>);
