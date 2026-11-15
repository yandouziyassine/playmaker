import { buildResult } from "./result.ts";
import type { Deps } from "./types.ts";
import { parsePick, parseTrain } from "./validate.ts";

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

/** Training plays per network per day (answers are not stored, so this only limits scraping). */
export const RATE_TRAIN_PER_DAY = 600;

/** Training (endless play over the bank): only moments of past days, so a day's answers never leak before or on its
 * own day. Not stored and no crowd: first-answer-wins does not apply, the same moment can be answered again. */
export async function handleTrain(raw: string | null | undefined, ip: string, deps: Deps): Promise<Reply> {
  const req = parseTrain(raw);
  if (!req) return { status: 400, body: { error: "invalid request" } };
  const [answer, date] = await Promise.all([deps.answer(req.moment), deps.momentDate(req.moment)]);
  if (!answer || !date || date >= deps.today()) return { status: 404, body: { error: "unknown moment" } };
  const known = (k: number) => answer.options.some((o) => o.k === k);
  if (!known(req.option) || (req.guess !== null && !known(req.guess))) return { status: 400, body: { error: "invalid option" } };
  const n = await deps.store.bumpRate(`train#${deps.ipHash(ip)}#${deps.today()}`);
  if (n > RATE_TRAIN_PER_DAY) return { status: 429, body: { error: "daily limit reached" } };
  return { status: 200, body: buildResult(answer, req.option, {}, false, req.guess) };
}

/** GET /api/train/bank: the training bank, the moments of every day before today (oldest day first). */
export async function handleBank(deps: Deps): Promise<Reply> {
  const all = (await deps.bank?.()) ?? [];
  const today = deps.today();
  const moments = all.filter((m) => m.date < today).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((m) => m.id);
  return { status: 200, body: { moments } };
}
