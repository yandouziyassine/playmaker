import type { PickRequest } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

export function parsePick(body: string | null | undefined): PickRequest | null {
  if (!body || body.length > 1024) return null;
  let v: unknown;
  try { v = JSON.parse(body); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== "moment,option,player") return null;
  if (typeof o.player !== "string" || !UUID.test(o.player)) return null;
  if (typeof o.moment !== "string" || !ID.test(o.moment)) return null;
  if (typeof o.option !== "number" || !Number.isInteger(o.option) || o.option < 0 || o.option > 63) return null;
  return { player: o.player, moment: o.moment, option: o.option };
}
