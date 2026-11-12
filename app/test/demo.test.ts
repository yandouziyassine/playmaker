import { expect, it } from "vitest";
import { demoDate } from "../src/demo.ts";

it("maps any date onto the demo's days, cyclically", () => {
  const info = { start: "2026-12-01", days: 30 };
  expect(demoDate("2026-12-01", info)).toBe("2026-12-01");
  expect(demoDate("2026-12-30", info)).toBe("2026-12-30");
  expect(demoDate("2026-12-31", info)).toBe("2026-12-01");
  expect(demoDate("2026-11-30", info)).toBe("2026-12-30");
  expect(demoDate("2027-03-15", info)).toBe(demoDate("2027-03-15", info));
  expect(demoDate("2027-03-15", info) >= "2026-12-01" && demoDate("2027-03-15", info) <= "2026-12-30").toBe(true);
});
