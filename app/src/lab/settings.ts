// Detector settings of the Lab: which model (speed / accuracy trade-off) and how a picture is tiled. Pure data plus a
// localStorage-backed store; the UI (main.ts) reads/writes it through getSettings / setSettings.

export type ModelId = "lite0" | "lite2";

export type ModelInfo = {
  /** Self-hosted file next to lab.html (app/public/lab/). */
  path: string;
  /** Model input size (square), the resolution a tile is resized to. */
  input: number;
  /** Approximate file size (MB) and CPU time per pass on a laptop (ms), for the UI. */
  mb: number; msPerPass: number;
  label: string;
};

/** Both are EfficientDet-Lite (COCO), Apache-2.0, see app/public/lab/MODEL_LICENSE.txt. */
export const MODELS: Record<ModelId, ModelInfo> = {
  lite0: { path: "lab/efficientdet_lite0.tflite", input: 320, mb: 7.3, msPerPass: 75, label: "Fast (EfficientDet-Lite0, 7 MB)" },
  lite2: { path: "lab/efficientdet_lite2.tflite", input: 448, mb: 12.1, msPerPass: 250, label: "Accurate (EfficientDet-Lite2, 12 MB)" },
};

export type DetectorSettings = {
  model: ModelId;
  /**
   * Tile side in source pixels for the people pass (0 = the legacy 3 x 2 grid of the whole picture). A tile close to the
   * model input keeps a 30 px player at ~30 px instead of shrinking him; smaller tiles = more passes.
   */
  tile: number;
  /** Overlap between neighbouring tiles (fraction of the tile side), so a player cut by one tile is whole in the next. */
  overlap: number;
  /** Minimum "person" score for detections found in a tile (the full-frame pass keeps MIN_SCORE). */
  tileMinScore: number;
};

/**
 * Tiling tuned per model: a tile close to the model input (320 / 448 px). Applied by setSettings when the model changes, so
 * switching to Lite2 in the UI no longer keeps Lite0's 384 px tiles and threshold.
 * Lite0, tileMinScore 0.25 vs 0.3 on the benchmark: recall 69.9 % vs 63.3 %, precision 85.9 % vs 88.3 % (F1 0.77 vs 0.74).
 * Lite2, tileMinScore 0.25 vs 0.3 (docs/cv-robustness.md): randomised set (148 frames) recall 35.4 % vs 32.6 %, precision
 * 79.4 % vs 82.1 % (F1 0.489 vs 0.467); original 60 frames recall 83.8 % vs 80.1 %, precision 91.0 % vs 94.0 % (F1 0.873 vs 0.865).
 */
export const MODEL_PRESETS: Record<ModelId, Omit<DetectorSettings, "model">> = {
  lite0: { tile: 384, overlap: 0.25, tileMinScore: 0.25 },
  lite2: { tile: 448, overlap: 0.25, tileMinScore: 0.25 },
};
export const presetFor = (model: ModelId): DetectorSettings => ({ model, ...MODEL_PRESETS[model] });

export const DEFAULT_SETTINGS: DetectorSettings = presetFor("lite0");
/** The pipeline as it was before the benchmark (full frame + 3 x 2 grid). */
export const LEGACY_SETTINGS: DetectorSettings = { model: "lite0", tile: 0, overlap: 0.2, tileMinScore: 0.3 };

const KEY = "lab.detector";
let current: DetectorSettings | null = null;

export function getSettings(): DetectorSettings {
  if (current) return current;
  current = { ...DEFAULT_SETTINGS };
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (raw) current = sanitise({ ...current, ...JSON.parse(raw) });
  } catch { /* private mode, bad JSON: defaults */ }
  return current;
}

/** A model change without explicit tiling values takes that model's preset (MODEL_PRESETS); explicit values win. */
export function setSettings(patch: Partial<DetectorSettings>): DetectorSettings {
  const prev = getSettings();
  const base = patch.model && patch.model !== prev.model && patch.model in MODELS ? presetFor(patch.model) : prev;
  current = sanitise({ ...base, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
  return current;
}

export function sanitise(s: DetectorSettings): DetectorSettings {
  return {
    model: s.model in MODELS ? s.model : DEFAULT_SETTINGS.model,
    tile: Number.isFinite(s.tile) && s.tile >= 0 ? Math.round(s.tile) : DEFAULT_SETTINGS.tile,
    overlap: Number.isFinite(s.overlap) ? Math.min(0.6, Math.max(0, s.overlap)) : DEFAULT_SETTINGS.overlap,
    tileMinScore: Number.isFinite(s.tileMinScore) ? Math.min(0.9, Math.max(0.05, s.tileMinScore)) : DEFAULT_SETTINGS.tileMinScore,
  };
}

/** Rough cost of one tiled detection: number of model passes (full frame + tiles + the ball pass is extra). */
export function passesFor(w: number, h: number, s: DetectorSettings): number {
  if (s.tile <= 0) return 1 + 6;
  const n = (len: number) => Math.max(1, Math.ceil((len - s.tile * s.overlap) / (s.tile * (1 - s.overlap))));
  return 1 + n(w) * n(h);
}
