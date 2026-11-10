// Small-phone layout review: screenshots of the three pages at 360x640 and 390x844 (dev servers must be running:
// `npm run dev` with PLAYMAKER_TODAY=2026-12-01 on 8787 and `npx vite` on 5173). Also reports horizontal overflow.
// Usage: node scripts/phone-shots.mjs <out-dir> [date]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
const [out = "shots-phone", date = "2026-12-01"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sizes = [[360, 640], [390, 844]];
const browser = await chromium.launch();
const problems = [];
for (const [w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const shot = async (name) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${w}x${h} ${name}: horizontal overflow ${overflow}px`);
    await page.screenshot({ path: `${out}/${w}x${h}-${name}.png`, fullPage: true });
  };
  // daily game: intro, choosing (list open, one selected), reveal, done
  await page.goto(`http://localhost:5173/?date=${date}&today=${date}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await shot("game-1-intro");
  await page.getByRole("button", { name: "Play today's five" }).click();
  for (let i = 0; i < 5; i++) {
    const confirm = page.getByRole("button", { name: "Confirm" });
    await confirm.waitFor({ timeout: 20000 });
    await page.getByText("Choose from a list").click();
    await page.locator(".opt").nth(1).click();
    if (i === 0) await shot("game-2-choosing");
    await confirm.click();
    await page.getByText("Choose from a list").click();
    await page.locator(".opt").first().click();
    await confirm.click();
    await page.locator("#reveal").waitFor();
    await page.locator("#next").waitFor();
    if (i === 0) await shot("game-3-reveal");
    await page.locator("#next").click();
  }
  await page.locator("#done").waitFor();
  await shot("game-4-done");
  // free play: loaded and paused, then the coach panel
  await page.goto("http://localhost:5173/replay.html");
  await page.locator("#play:not([disabled])").waitFor({ timeout: 30000 });
  await shot("replay-1-paused");
  await page.locator("#ask:not([disabled])").click().catch(() => {});
  await page.waitForTimeout(500);
  await shot("replay-2-coach");
  // lab: synthetic scene
  await page.goto("http://localhost:5173/lab.html");
  await shot("lab-1-start");
  await page.getByRole("button", { name: "Try a synthetic scene" }).click();
  await page.locator("#work").waitFor();
  await page.waitForTimeout(1500);
  await shot("lab-2-synthetic");
  await page.goto("http://localhost:5173/about.html");
  await shot("about");
  await ctx.close();
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "no horizontal overflow");
console.log("shots in", out);
