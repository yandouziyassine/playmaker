import type { Store, StoredPick } from "./types.ts";

export class MemoryStore implements Store {
  private picks = new Map<string, StoredPick>();
  private count = new Map<string, Record<number, number>>();
  private rate = new Map<string, number>();
  async getPick(p: string, m: string) { return this.picks.get(`${p}|${m}`) ?? null; }
  async putPickIfAbsent(p: string, m: string, pick: StoredPick) {
    const k = `${p}|${m}`;
    if (this.picks.has(k)) return false;
    this.picks.set(k, pick);
    return true;
  }
  async addCount(m: string, o: number) { const c = this.count.get(m) ?? {}; c[o] = (c[o] ?? 0) + 1; this.count.set(m, c); }
  async counts(m: string) { return { ...(this.count.get(m) ?? {}) }; }
  async bumpRate(key: string) { const n = (this.rate.get(key) ?? 0) + 1; this.rate.set(key, n); return n; }
}
