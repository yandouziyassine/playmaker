// Visual review: full-resolution phone screenshots of each game state (dev servers must be running).
// Usage: node scripts/review-shots.mjs <out-dir> [date]
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";
const [out = "shots", date = "2026-12-01"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ ...devices["Pixel 7"] });
const shot = (name, fullPage = true) => page.screenshot({ path: `${out}/${name}.png`, fullPage });
await page.goto(`http://localhost:5173/?date=${date}&today=${date}`);
await page.waitForTimeout(1500);
await shot("1-intro");
await page.getByRole("button", { name: "Play today's five" }).click();
await page.waitForTimeout(300);
await shot("1b-loading", false);
await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 20000 });
await shot("2-choose", false);
await page.getByText("Choose from a list").click();
await page.locator(".opt").nth(2).click();
await shot("3-selected", false);
await page.getByRole("button", { name: "Confirm" }).click();
await page.getByText("Choose from a list").click();
await page.locator(".opt").first().click();
await shot("3b-question2", false);
await page.getByRole("button", { name: "Confirm" }).click();
await page.locator("#reveal").waitFor();
await page.waitForTimeout(1200);
await shot("4-reveal-arrows");
await page.waitForTimeout(4000);
await shot("5-after-replay");
await page.waitForTimeout(4500);
await page.getByRole("button", { name: /every option/i }).click();
await shot("6-all-scores");
for (let i = 1; i < 5; i++) {
  await page.locator("#next").click();
  const confirm = page.getByRole("button", { name: "Confirm" });
  await confirm.waitFor({ timeout: 20000 });
  await page.getByText("Choose from a list").click(); await page.locator(".opt").first().click(); await confirm.click();
  await page.getByText("Choose from a list").click(); await page.locator(".opt").first().click(); await confirm.click();
  await page.locator("#next:not([hidden])").waitFor({ timeout: 30000 });
}
await page.locator("#next").click();
await page.locator("#done").waitFor();
await page.waitForTimeout(800);
await shot("7-done");
await browser.close();
console.log("shots in", out);
