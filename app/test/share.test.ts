// app/test/share.test.ts
import { expect, it } from "vitest";
import { shareText, square } from "../src/share.ts";
it("squares and spoiler-free share text", () => {
  expect([100, 60, 50, 49, 0].map(square).join("")).toBe("🟩🟨🟨⬜⬜");
  expect(shareText(42, [100, 60, 0, 100, 100])).toBe("⚽ Playmaker #42 · 360/500\n🟩🟨⬜🟩🟩");
});
