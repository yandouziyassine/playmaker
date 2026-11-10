import { buildResult } from "./result.ts";
import type { Deps } from "./types.ts";
import { parsePick } from "./validate.ts";

export const RATE_PER_DAY = 50;
export interface Reply { status: number; body: any }

const plusDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export async function handlePick(raw: string | null | undefined, ip: string, deps: Deps): Promise<Reply> {
  const req = parsePick(raw);
  if (!req) return { status: 400, body: { error: "invalid request" } };
  const [answer, date] = await Promise.all([deps.answer(req.moment), deps.momentDate(req.moment)]);
  if (!answer || !date || date > plusDays(deps.today(), 1)) return { status: 404, body: { error: "unknown moment" } };
  const known = (k: number) => answer.options.some((o) => o.k === k);
  if (!known(req.option) || (req.guess !== null && !known(req.guess))) return { status: 400, body: { error: "invalid option" } };
  const prev = await deps.store.getPick(req.player, req.moment);
  if (prev) return { status: 200, body: buildResult(answer, prev.option, await deps.store.counts(req.moment), true, prev.guess ?? null) };
  const n = await deps.store.bumpRate(`${deps.ipHash(ip)}#${deps.today()}`);
  if (n > RATE_PER_DAY) return { status: 429, body: { error: "daily limit reached" } };
  const points = answer.options.find((o) => o.k === req.option)!.points;
  const fresh = await deps.store.putPickIfAbsent(req.player, req.moment, { option: req.option, points, at: new Date().toISOString(), guess: req.guess });
  if (fresh) await deps.store.addCount(req.moment, req.option);
  const stored = fresh ? { option: req.option, guess: req.guess } : (await deps.store.getPick(req.player, req.moment))!; // first answer wins, guess included
  return { status: 200, body: buildResult(answer, stored.option, await deps.store.counts(req.moment), !fresh, stored.guess ?? null) };
}
