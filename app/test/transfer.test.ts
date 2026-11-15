import { describe, expect, it } from "vitest";
import {
  CodeError, cleanName, codeLink, crc32, decode, encode, extractCode, fromB64url, importCode, merge, snapshot, toB64url,
  type KVStore,
} from "../src/profile/transfer";

class Mem implements KVStore {
  m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) { for (const [k, v] of Object.entries(init)) this.m.set(k, v); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const rec = (id: string, points = 50) => ({ id, points, among_best: false, pro_instinct: false, same_as_ai: false, kind: "pass", zone: "middle", league: "x", outcome: "kept" });

describe("player codes", () => {
  it("crc32 matches the IEEE reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("base64url round-trips arbitrary bytes", () => {
    const b = new Uint8Array(70000).map((_, i) => (i * 37) & 255);
    expect([...fromB64url(toB64url(b))]).toEqual([...b]);
    expect(toB64url(b)).not.toMatch(/[+/=]/);
  });

  it("snapshot keeps pm.* keys only and never the device id", () => {
    const kv = new Mem({ "pm.player": "abc", "pm.days": "{}", "other": "x", "pm.name": "Zizou" });
    expect(snapshot(kv)).toEqual({ "pm.days": "{}", "pm.name": "Zizou" });
  });

  it("encode -> decode round-trips and the code is compact", async () => {
    const moments: Record<string, unknown[]> = {};
    for (let d = 1; d <= 30; d++) moments[`2026-11-${String(d).padStart(2, "0")}`] = [1, 2, 3, 4, 5].map((i) => rec(`m${d}-${i}`, i * 20));
    const snap = { "pm.days": JSON.stringify({ "2026-11-01": [100, 80, 0, 45, 100] }), "pm.moments": JSON.stringify(moments) };
    const code = await encode(snap);
    expect(code).toMatch(/^PM1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(JSON.stringify(snap).length / 3);
    expect(await decode(code)).toEqual(snap);
  });

  it("rejects typos, other versions and garbage with a reason", async () => {
    const code = await encode({ "pm.days": "{}" });
    const [v, c, p] = code.split(".");
    const flip = p!.slice(0, -2) + (p!.at(-2) === "A" ? "B" : "A") + p!.at(-1);
    await expect(decode(`${v}.${c}.${flip}`)).rejects.toBeInstanceOf(CodeError);
    await expect(decode(`PM9.${c}.${p}`)).rejects.toMatchObject({ reason: "version" });
    await expect(decode("hello")).rejects.toMatchObject({ reason: "format" });
  });

  it("accepts a pasted link and stray whitespace", async () => {
    const code = await encode({ "pm.days": "{}" });
    const link = codeLink("https://playmaker-game.github.io/?x=1#old", code);
    expect(link.startsWith("https://playmaker-game.github.io/?x=1#code=")).toBe(true);
    expect(extractCode(`  ${link}\n`)).toBe(code);
    expect(await decode(code.slice(0, 10) + "\n " + code.slice(10))).toEqual({ "pm.days": "{}" });
  });

  it("drops non-pm keys and the device id from an imported code", async () => {
    const code = await encode({ "pm.days": "{}", "pm.player": "evil", "x": "y" } as Record<string, string>);
    expect(await decode(code)).toEqual({ "pm.days": "{}" });
  });

  it("merge: unions days, live days and moment records; longer day wins; device flags stay", () => {
    const local = {
      "pm.days": JSON.stringify({ a: [1, 2], b: [9] }),
      "pm.live": JSON.stringify(["b"]),
      "pm.moments": JSON.stringify({ b: [rec("x")] }),
      "pm.flag.tour": "1",
    };
    const incoming = {
      "pm.days": JSON.stringify({ a: [5, 5, 5], c: [7] }),
      "pm.live": JSON.stringify(["a", "c"]),
      "pm.moments": JSON.stringify({ b: [rec("x", 99), rec("y")], c: [rec("z")] }),
      "pm.flag.tour": "0",
      "pm.name": "Pirlo",
    };
    const out = merge(local, incoming);
    expect(JSON.parse(out["pm.days"]!)).toEqual({ a: [5, 5, 5], b: [9], c: [7] });
    expect(JSON.parse(out["pm.live"]!)).toEqual(["a", "b", "c"]);
    const mo = JSON.parse(out["pm.moments"]!);
    expect(mo.b.map((r: { id: string }) => r.id)).toEqual(["x", "y"]);
    expect(mo.b[0].points).toBe(50); // the device's own record of a moment is kept
    expect(mo.c).toHaveLength(1);
    expect(out["pm.flag.tour"]).toBeUndefined();
    expect(out["pm.name"]).toBe("Pirlo");
  });

  it("merge survives corrupt local values", () => {
    const out = merge({ "pm.days": "not json", "pm.moments": "[]" }, { "pm.days": JSON.stringify({ a: [1] }), "pm.moments": JSON.stringify({ a: [rec("q")] }) });
    expect(JSON.parse(out["pm.days"]!)).toEqual({ a: [1] });
    expect(JSON.parse(out["pm.moments"]!).a).toHaveLength(1);
  });

  it("importCode writes the merge and summarises it", async () => {
    const phone = new Mem({ "pm.player": "phone", "pm.days": JSON.stringify({ a: [100] }) });
    const laptop = new Mem({ "pm.player": "laptop", "pm.days": JSON.stringify({ b: [1, 2, 3, 4, 5] }), "pm.moments": JSON.stringify({ b: [rec("1"), rec("2")] }) });
    const sum = await importCode(phone, await encode(snapshot(laptop)));
    expect(sum).toEqual({ days: 1, moments: 2, written: 2 });
    expect(JSON.parse(phone.getItem("pm.days")!)).toEqual({ a: [100], b: [1, 2, 3, 4, 5] });
    expect(phone.getItem("pm.player")).toBe("phone");
  });

  it("cleanName trims, strips markup and caps length", () => {
    expect(cleanName("  <b>Kylian</b>\n  Mbappé  ")).toBe("bKylian/b Mbappé");
    expect(cleanName("x".repeat(40))).toHaveLength(20);
  });
});
