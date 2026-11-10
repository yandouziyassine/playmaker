// Visual review: full-resolution phone screenshots of each game state (dev servers must be running).
// Usage: node scripts/review-shots.mjs <out-dir> [date]
import { chromium, devices } from "@playwright/test";
const [out = "shots", date = "2026-12-01"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ ...devices["Pixel 7"] });
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
await page.goto(`http://localhost:5173/?date=${date}&today=${date}`);
await shot("1-intro");
await page.getByRole("button", { name: "Play today's five" }).click();
await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 20000 });
await shot("2-choose");
await page.getByText("Choose from a list").click();
await page.locator(".opt").nth(2).click();
await shot("3-selected");
await page.getByRole("button", { name: "Confirm" }).click();
await page.locator("#reveal").waitFor();
await page.waitForTimeout(1200);
await shot("4-reveal-arrows");
await page.waitForTimeout(4000);
await shot("5-after-replay");
await page.waitForTimeout(4500);
await page.getByRole("button", { name: "Show every option's score" }).click();
await shot("6-all-scores");
await browser.close();
console.log("shots in", out);
