// Gameplay clip for the README: one moment (lead-up, pick, pro guess, reveal and the real replay) recorded with Playwright
// at Pixel 7 size, then cut and turned into an animated WebP with ffmpeg (falls back to the raw .webm without ffmpeg).
// Dev servers must be running (`PLAYMAKER_TODAY=2026-12-01 npm run dev` on 8787 and `npx vite` on 5173).
// Usage: node scripts/showcase/clip.mjs [out=docs/img/clip.webp] [date]
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const [out = "docs/img/clip.webp", date = "2026-12-01"] = process.argv.slice(2);
const dir = mkdtempSync(path.join(tmpdir(), "pm-clip-"));
const size = { width: 412, height: 780 };
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["Pixel 7"], viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size } });
await ctx.addInitScript(() => { if (!sessionStorage.getItem("clip")) { localStorage.clear(); sessionStorage.setItem("clip", "1"); } });
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(`http://localhost:5173/?date=${date}&today=${date}&tour=0`);
await page.getByRole("button", { name: "Play today's five" }).waitFor();
await page.waitForTimeout(600);
const start = (Date.now() - t0) / 1000; // cut everything before the Play tap
await page.getByRole("button", { name: "Play today's five" }).click();
await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 20000 });
await page.waitForTimeout(3300); // the 3 s lead-up
// keyboard play (arrows move the selection on the pitch): stop on the wanted receiver, or after a full turn
const choose = async (re, wait) => {
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("ArrowRight");
    if (re.test(await page.locator(".actions .choice").textContent())) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(wait);
  await page.keyboard.press("Enter");
};
await choose(/#14 /, 700); // what would you do
await page.waitForTimeout(400);
await choose(/#19 /, 500); // what did the pro do
await page.locator("#reveal").waitFor();
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(5000); // the arrows, then the real 6 s after the pass
await page.evaluate(() => window.scrollTo({ top: 520, behavior: "smooth" }));
await page.waitForTimeout(1300);
const end = (Date.now() - t0) / 1000;
const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();

try {
  // 1.6x speed, 15 fps, 360 px wide, looping animated WebP
  const dur = (end - start).toFixed(2);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", start.toFixed(2), "-t", dur, "-i", webm,
    "-vf", "setpts=PTS/1.6,fps=15,scale=360:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "62", "-compression_level", "6", "-loop", "0", "-an", out]);
} catch (e) {
  console.warn("ffmpeg failed or missing, keeping the .webm:", e.message);
  copyFileSync(webm, out.replace(/\.\w+$/, ".webm"));
}
console.log("wrote", out, (statSync(out).size / 1024).toFixed(0), "kB", `(${((end - start) / 1.6).toFixed(1)} s)`);
