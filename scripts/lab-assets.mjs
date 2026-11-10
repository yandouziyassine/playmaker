// Fetches (or verifies) the self-hosted EfficientDet-Lite0 model for the Lab page.
// The MediaPipe wasm runtime is NOT copied: it is ~15 MB per build (29 MB for both builds), so lab/detector.ts
// loads it from the jsDelivr CDN pinned to the installed @mediapipe/tasks-vision version.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";
const OUT = "app/public/lab/efficientdet_lite0.tflite";
const SHA256 = "4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993";
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (existsSync(OUT) && sha(readFileSync(OUT)) === SHA256) {
  console.log(`ok: ${OUT} (sha256 matches)`);
} else {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SHA256) throw new Error("sha256 mismatch: the published model changed, check it and update SHA256");
  writeFileSync(OUT, buf);
  console.log(`downloaded ${OUT} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
