// app/test/pitch.test.ts
import { expect, it } from "vitest";
import { toScreen, hitOption } from "../src/pitch.ts";
it("maps metres to a portrait canvas and finds the tapped option", () => {
  const view = { w: 390, h: 600 };
  const c = toScreen([0, 0], view);
  expect(c[0]).toBeCloseTo(195); expect(c[1]).toBeCloseTo(300);
  const opts = [{ k: 0, at: toScreen([10, 0], view) }, { k: 1, at: toScreen([-10, 5], view) }];
  expect(hitOption(opts, [opts[1]!.at[0] + 5, opts[1]!.at[1]], 30)).toBe(1);
  expect(hitOption(opts, [0, 0], 30)).toBeNull();
});
