export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY_ID = "pm.player", KEY_DAYS = "pm.days";

export class History {
  private fallbackId: string | null = null;
  constructor(private kv: KV) {}
  private get(k: string) { try { return this.kv.getItem(k); } catch { return null; } }
  private set(k: string, v: string) { try { this.kv.setItem(k, v); } catch { /* private mode: keep in memory only */ } }
  player(): string {
    const id = this.get(KEY_ID) ?? this.fallbackId ?? crypto.randomUUID();
    this.fallbackId = id; this.set(KEY_ID, id); return id;
  }
  days(): Record<string, number[]> { try { return JSON.parse(this.get(KEY_DAYS) ?? "{}"); } catch { return {}; } }
  finish(date: string, points: number[]) { const d = this.days(); d[date] = points; this.set(KEY_DAYS, JSON.stringify(d)); }
  streak(today: string): number {
    const d = this.days(); let n = 0; let t = Date.parse(today + "T00:00:00Z");
    while (d[new Date(t).toISOString().slice(0, 10)]) { n++; t -= 86400000; }
    return n;
  }
}
