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

it("fitView: whole pitch when it fits, otherwise the width's scale cropped around the carrier", async () => {
  const { fitView, optionTargets, scale, toScreen } = await import("../src/pitch.ts");
  expect(fitView(390, 600, [0])).toEqual({ w: 390, h: 600 }); // tall enough: the whole pitch
  const v = fitView(390, 280, [-30, -28], [-10, 0, 52.5]);    // short reveal pitch, carrier deep in its half
  expect(scale(v)).toBeCloseTo((390 - 28) / 68);
  for (const x of [-30, -28]) { const y = toScreen([x, 0], v)[1]; expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(280); }
  // the view stays inside the pitch ends (plus the margin)
  const end = fitView(390, 280, [50], []);
  expect(toScreen([52.5, 0], end)[1]).toBeGreaterThanOrEqual(0);
  // tap targets use the same transform as the drawing
  const mo = { carrier: 0, players: [{ side: 0, shirt: 6, name: "A" }, { side: 0, shirt: 8, name: "B" }],
    lead_up: [[[-3000, 0], [-1000, 500]]], ball: [], options: [{ k: 0, kind: "pass", player: 1, to: [-1000, 500] }] } as never;
  expect(optionTargets(v, mo)[0]!.at).toEqual(toScreen([-10, 5], v));
});
