import { expect, it, vi } from "vitest";
import { CARD_W, shareFileName, shareScore, streakLabel, tileColor, tileLayout } from "../src/shareImage.ts";

it("tile colours follow the square thresholds", () => {
  expect([100, 99, 50, 49, 0].map(tileColor)).toEqual(["#06d6a0", "#ffd166", "#ffd166", "#8d99ae", "#8d99ae"]);
});

it("tiles are centred, equal, inside the card and do not overlap", () => {
  const t = tileLayout(5);
  expect(t).toHaveLength(5);
  const left = t[0]!.x, right = CARD_W - (t[4]!.x + t[4]!.w);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  for (let i = 1; i < t.length; i++) {
    expect(t[i]!.x).toBeGreaterThan(t[i - 1]!.x + t[i - 1]!.w);
    expect(t[i]!.w).toBe(t[0]!.w);
  }
  const many = tileLayout(12);
  expect(many[0]!.x).toBeGreaterThanOrEqual(0);
  expect(many[11]!.x + many[11]!.w).toBeLessThanOrEqual(CARD_W);
  expect(tileLayout(0)).toEqual([]);
});

it("labels", () => {
  expect(streakLabel(0)).toBe("");
  expect(streakLabel(1)).toBe("STREAK 1 DAY");
  expect(streakLabel(4)).toBe("STREAK 4 DAYS");
  expect(shareFileName(42)).toBe("playmaker-day-42.png");
});

it("shares the image when files are supported, else text, else clipboard", async () => {
  const file = { name: "x.png" } as File;
  const share = vi.fn(async (_d: ShareData) => {});
  expect(await shareScore({ share, canShare: () => true }, "t", file)).toBe("image");
  expect(share).toHaveBeenLastCalledWith({ files: [file], text: "t" });
  expect(await shareScore({ share, canShare: () => false }, "t", file)).toBe("text");
  expect(share).toHaveBeenLastCalledWith({ text: "t" });
  expect(await shareScore({ share, canShare: () => true }, "t", null)).toBe("text");
  expect(await shareScore({ share, canShare: () => { throw new Error("x"); } }, "t", file)).toBe("text");
  const writeText = vi.fn(async (_t: string) => {});
  expect(await shareScore({ clipboard: { writeText } }, "t", file)).toBe("copied");
  expect(writeText).toHaveBeenCalledWith("t");
  expect(await shareScore({}, "t", file)).toBe("none");
});
