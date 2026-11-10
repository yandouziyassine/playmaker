// app/test/keyboard.test.ts: keyboard play on the pitch (round.ts choose() uses stepOption)
import { expect, it } from "vitest";
import { stepOption } from "../src/pitch.ts";

const order = [4, 0, 7, 2];
it("arrow keys start at either end and wrap around", () => {
  expect(stepOption(order, undefined, 1)).toBe(4);
  expect(stepOption(order, undefined, -1)).toBe(2);
  expect(stepOption(order, 4, 1)).toBe(0);
  expect(stepOption(order, 2, 1)).toBe(4);
  expect(stepOption(order, 4, -1)).toBe(2);
});
it("Tab stops past either end so focus can leave the pitch", () => {
  expect(stepOption(order, undefined, 1, false)).toBe(4);
  expect(stepOption(order, undefined, -1, false)).toBeNull();
  expect(stepOption(order, 7, 1, false)).toBe(2);
  expect(stepOption(order, 2, 1, false)).toBeNull();
  expect(stepOption(order, 4, -1, false)).toBeNull();
  expect(stepOption([], undefined, 1)).toBeNull();
});
