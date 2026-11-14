import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MODEL_PRESETS, MODELS, getSettings, presetFor, setSettings } from "../src/lab/settings.ts";

// Per-model tiling presets, tuned on the benchmark (scripts/cv-bench/run.mjs, robust.mjs; docs/cv-robustness.md).
describe("model presets", () => {
  it("cover every model with a tile no smaller than the model input's neighbourhood", () => {
    for (const id of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
      const p = MODEL_PRESETS[id];
      expect(p.tile).toBeGreaterThanOrEqual(MODELS[id].input);
      expect(p.tileMinScore).toBeGreaterThan(0.05);
      expect(p.tileMinScore).toBeLessThan(0.9);
    }
    expect(DEFAULT_SETTINGS).toEqual(presetFor("lite0"));
  });
  it("a model switch takes the model's preset; explicit values and same-model patches keep the tiling", () => {
    expect(getSettings().model).toBe("lite0");
    expect(setSettings({ model: "lite2" })).toEqual(presetFor("lite2"));
    expect(setSettings({ tileMinScore: 0.4 }).tileMinScore).toBe(0.4);
    expect(setSettings({ model: "lite2" }).tileMinScore).toBe(0.4); // same model: untouched
    expect(setSettings({ model: "lite0", tile: 512 })).toEqual({ ...presetFor("lite0"), tile: 512 });
    expect(setSettings({ model: "lite2" }).tile).toBe(MODEL_PRESETS.lite2.tile);
    setSettings(presetFor("lite0"));
  });
});
