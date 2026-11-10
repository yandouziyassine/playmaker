import type { PickRequest } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

const isK = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 63;

export function parsePick(body: string | null | undefined): PickRequest | null {
  if (!body || body.length > 1024) return null;
  let v: unknown;
  try { v = JSON.parse(body); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join();
  if (keys !== "moment,option,player" && keys !== "guess,moment,option,player") return null; // guess is optional for old clients
  if (typeof o.player !== "string" || !UUID.test(o.player)) return null;
  if (typeof o.moment !== "string" || !ID.test(o.moment)) return null;
  if (!isK(o.option)) return null;
  if ("guess" in o && !isK(o.guess)) return null; // when sent, the guess must be an option k (no explicit null)
  return { player: o.player, moment: o.moment, option: o.option, guess: "guess" in o ? (o.guess as number) : null };
}
