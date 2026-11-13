// README screenshots at Pixel 7 size (412 x 915 CSS px), our own renders only (dev servers must be running:
// `PLAYMAKER_TODAY=2026-12-01 npm run dev` on 8787 and `npx vite` on 5173). Writes raw PNGs; scripts/showcase/optimise.mjs
// turns them into small WebPs for docs/img/.
// Usage: node scripts/showcase/shots.mjs <raw-out-dir> [date]
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";

const [out = "showcase-raw", date = "2026-12-01"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "dark" });
const page = await ctx.newPage();
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const game = `http://localhost:5173/?date=${date}&today=${date}&tour=0`;

// 1. intro with the live preview of a past moment
await page.goto(game);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator("#preview:not([hidden])").waitFor({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(4500); // let the preview reach the release frame with the options
await shot("1-intro");

// 2. choosing in 2D: one option selected on the pitch
await page.getByRole("button", { name: "Play today's five" }).click();
const confirm = page.getByRole("button", { name: "Confirm" });
await confirm.waitFor({ timeout: 20000 });
await page.waitForTimeout(3500); // the 3 s lead-up
await page.getByText("Choose from a list").click();
await page.locator(".opt").nth(1).click();
await page.getByText("Choose from a list").click().catch(() => {}); // close the list again
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await shot("2-choose");

// 4 (taken before confirming). 3D stadium camera on the same moment
const toggle = page.locator(".v3d-toggle");
await toggle.click();
await page.waitForTimeout(2500);
const has3d = (await toggle.textContent()) !== "3D unavailable";
if (has3d) {
  await page.locator('.v3d-mode[data-mode="stadium"]').click().catch(() => {});
  await page.waitForTimeout(2500); // the camera glides to the new pose
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("4-3d-stadium");
  await page.locator('.v3d-mode[data-mode="eyes"]').click().catch(() => {});
  await page.waitForTimeout(400);
  await toggle.click(); // back to 2D
  await page.waitForTimeout(800);
} else console.warn("no WebGL: 3D shot skipped");

// 3. the reveal
await page.getByText("Choose from a list").click();
await page.locator(".opt").nth(1).click();
await confirm.click();
await page.getByText("Choose from a list").click();
await page.locator(".opt").first().click();
await confirm.click();
await page.locator("#reveal").waitFor();
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, 420)); // pitch bottom with the score card and the You / AI / Pro rows
await page.waitForTimeout(300);
await shot("3-reveal");

// 5. the Lab on its synthetic scene: detect, auto-calibrate, top-down map
await page.goto("http://localhost:5173/lab.html");
await page.getByRole("button", { name: "Try a synthetic scene" }).click();
await page.locator("#work").waitFor();
await page.waitForFunction(() => /\d/.test(document.querySelector("#st-count")?.textContent ?? ""), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(800);
const auto = page.locator("#autocal");
await auto.click({ timeout: 5000 }).catch(() => {}); // calibrate from the painted lines, no taps
await page.waitForTimeout(1500);
await page.evaluate(() => { document.querySelector("#img")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -150); });
await page.waitForTimeout(300);
await shot("5-lab");
await page.evaluate(() => { document.querySelector("#top")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -60); });
await page.waitForTimeout(300);
await shot("5b-lab-map");

// 6. free play: a full match from above, paused, coach asked
await page.goto("http://localhost:5173/replay.html");
await page.locator("#play:not([disabled])").waitFor({ timeout: 30000 });
await page.locator("#play").click();
await page.waitForTimeout(4000);
await page.locator("#ask:not([disabled])").click().catch(() => {});
await page.waitForTimeout(1200);
await page.evaluate(() => window.scrollTo(0, 0));
await shot("6-free-play");

await browser.close();
console.log("raw shots in", out);
