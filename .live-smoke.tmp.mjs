// Headless check of the Lab's live mode with Chromium's fake camera fed by a synthetic Y4M.
import { chromium } from "@playwright/test";

const SP = process.argv[2];
const y4m = process.argv[3];
const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (y4m) args.push(`--use-file-for-fake-video-capture=${y4m}`);
const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 }, permissions: ["camera"] });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console:", m.type(), m.text()); });
await page.goto("http://localhost:5173/lab.html?debug");
await page.click("#mode-live");
await page.screenshot({ path: `${SP}/live-0-mode.png` });
if (process.env.TILED) await page.check("#live-tiled");
await page.click("#cam-start");
await page.waitForFunction(() => /Live ·/.test(document.getElementById("status").textContent), null, { timeout: 60000 });
await page.waitForTimeout(3000);
console.log("status (uncalibrated):", await page.textContent("#status"));
await page.screenshot({ path: `${SP}/live-1-boxes.png`, fullPage: true });

// calibrate: freeze, tap the 4 default landmarks where the synthetic scene puts them (scene drawn at 1280 x 720, video 960 x 540)
await page.click("#recal");
const IDS = ["R-box-goal-far", "R-spot", "R-six-edge-near", "R-six-edge-far"];
for (let i = 0; i < 4; i++) await page.selectOption(`select[aria-label="Landmark for point ${i + 1}"]`, IDS[i]);
await page.locator("#img").scrollIntoViewIfNeeded();
page.on("framenavigated", () => console.log("NAVIGATED"));
const pts = await page.evaluate(async (IDS) => {
  const scene = await import("/src/lab/scene.ts");
  const lm = await import("/src/lab/landmarks.ts");
  const hm = await import("/src/lab/homography.ts");
  const H = scene.sceneHomography();
  const Z = 1.6;
  const hmMod = await import("/src/lab/homography.ts"), lmMod = await import("/src/lab/landmarks.ts");
  const cs = lmMod.DEFAULT_LANDMARKS.map((id) => hmMod.applyH(H, lmMod.landmark(id)));
  const cx = cs.reduce((a, p) => a + p.x, 0) / 4, cy = cs.reduce((a, p) => a + p.y, 0) / 4;
  const ox = Math.max(0, Math.min(scene.SCENE_W - scene.SCENE_W / Z, cx - scene.SCENE_W / 2 / Z));
  const oy = Math.max(0, Math.min(scene.SCENE_H - scene.SCENE_H / Z, cy - scene.SCENE_H / 2 / Z));
  const c = document.getElementById("img");
  const r = c.getBoundingClientRect();
  return IDS.map((id) => {
    const p = hm.applyH(H, lm.landmark(id));
    const x = (((p.x - ox) * Z) / scene.SCENE_W) * c.width, y = (((p.y - oy) * Z) / scene.SCENE_H) * c.height;
    return { x: r.left + (x * r.width) / c.width, y: r.top + (y * r.height) / c.height };
  });
}, IDS);
console.log("points:", JSON.stringify(pts.map((p) => [Math.round(p.x), Math.round(p.y)])));
for (const p of pts) { await page.mouse.click(p.x, p.y); console.log(" ->", await page.textContent("#calib-msg"), "| work hidden:", await page.locator("#work").isHidden()); }
console.log("calib:", await page.textContent("#calib-msg"));
await page.click("#freeze"); // resume
await page.waitForTimeout(+(process.env.WAIT ?? 6000));
console.log("status (calibrated):", await page.textContent("#status"));
console.log("stats:", (await page.locator(".stats").innerText()).replace(/\s+/g, " "));
console.log("coach-still:", await page.textContent("#coach-still"));
await page.screenshot({ path: `${SP}/live-2-calibrated.png`, fullPage: true });
await page.locator("#top").screenshot({ path: `${SP}/live-3-map.png` });

// freeze & ask the coach: tap players on the map until the coach answers
await page.click("#ask-coach");
const box = await page.locator("#top").boundingBox();
const W = await page.evaluate(() => document.getElementById("top").width);
const s = W / 113, k = box.width / W;
const players = await page.evaluate(() => window.__labLive.pos.map((p, i) => ({ p, team: window.__labState.labels[i] })));
console.log("players on map:", JSON.stringify(players.map((q) => q.p && [q.p.x.toFixed(1), q.p.y.toFixed(1), q.team])));
let ok = false;
for (const q of players) {
  if (!q.p || q.team === "other") continue;
  await page.mouse.click(box.x + (q.p.x + 52.5 + 4) * s * k, box.y + (34 + 4 - q.p.y) * s * k);
  await page.waitForTimeout(400);
  if (await page.locator("#coach-list li.rank-1").count()) { ok = true; break; }
  console.log("  coach msg:", await page.locator("#coach-list").innerText());
  await page.click("#clear-carrier");
}
await page.waitForTimeout(500);
console.log("coach answered:", ok);
console.log("coach list:", (await page.locator("#coach-list").innerText()).slice(0, 400));
console.log("coach-tag:", await page.textContent("#coach-tag"));
await page.screenshot({ path: `${SP}/live-4-coach.png`, fullPage: true });
await page.locator("#top").screenshot({ path: `${SP}/live-5-coach-map.png` });
const fpsLog = [];
await page.click("#freeze");
for (let i = 0; i < 5; i++) { await page.waitForTimeout(2000); fpsLog.push(await page.textContent("#status")); }
console.log("status over 10 s:", fpsLog.join(" || "));

// leaving live mode stops the camera
await page.click("#mode-picture");
const tracks = await page.evaluate(() => (document.getElementById("cam").srcObject ? "still attached" : "stopped"));
console.log("camera after leaving live:", tracks);
await browser.close();
