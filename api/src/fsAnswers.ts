import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "./memoryStore.ts";
import type { Answer, Deps } from "./types.ts";

export function fsDeps(root: string): Deps {
  const dates = new Map<string, string>();
  const dir = path.join(root, "public", "days");
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
    const day = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const m of day.moments) dates.set(m, f.replace(/\.json$/, ""));
  }
  return {
    store: new MemoryStore(),
    async answer(m) {
      const f = path.join(root, "answers", `${m}.json`);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Answer) : null;
    },
    async momentDate(m) { return dates.get(m) ?? null; },
    today: () => process.env.PLAYMAKER_TODAY ?? new Date().toISOString().slice(0, 10),
    ipHash: (ip) => createHash("sha256").update("dev-salt" + ip).digest("hex").slice(0, 16),
  };
}
