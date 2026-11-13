// Social preview card (Open Graph / Twitter, 1200 x 630) -> app/public/og.png. The pitch is the game's own 2D renderer:
// the intro preview canvas (app/src/preview.ts + pitch.ts) captured on its release frame, then laid into an HTML card.
// Dev servers must be running (`PLAYMAKER_TODAY=2026-12-01 npm run dev` on 8787 and `npx vite` on 5173).
// Usage: node scripts/showcase/og.mjs [out=app/public/og.png] [date]
import { chromium } from "@playwright/test";

const [out = "app/public/og.png", date = "2026-12-01"] = process.argv.slice(2);
const browser = await chromium.launch();

// 1. the real moment, drawn by the game at 3x for a crisp card
const game = await browser.newPage({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 3 });
await game.goto(`http://localhost:5173/?date=${date}&today=${date}&tour=0`);
await game.evaluate(() => localStorage.clear());
await game.reload();
const canvas = game.locator("#preview-pitch:not(.skeleton)");
await canvas.waitFor({ timeout: 20000 });
await game.waitForTimeout(4500); // the lead-up loops, then holds the release frame with the options
const pitch = (await canvas.screenshot()).toString("base64");

// 2. the card
const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await card.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; background: radial-gradient(120% 140% at 85% 50%, #123a24 0%, #07170e 60%);
    color: #f1faee; font-family: system-ui, "Segoe UI", Roboto, sans-serif; display: grid; grid-template-columns: 520px 1fr;
    align-items: center; gap: 40px; padding: 0 56px 0 64px; }
  .brand { font: 800 92px/1 "Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif; letter-spacing: 0.01em; }
  .brand b { color: #ef476f; font-weight: inherit; }
  .line { margin-top: 28px; font-size: 38px; line-height: 1.22; font-weight: 650; text-wrap: balance; }
  .line em { font-style: normal; color: #4cc9f0; }
  .url { margin-top: 34px; font-size: 22px; color: #b2c9bb; letter-spacing: 0.01em; }
  .pitch { width: 100%; height: 470px; object-fit: cover; object-position: 8% 50%; border-radius: 22px; box-shadow: 0 18px 48px rgba(0,0,0,.45); display: block; }
</style></head><body>
  <div>
    <div class="brand">PLAY<b>MAKER</b></div>
    <p class="line">Five real pro moments a day. <em>Pick the pass,</em> beat the AI coach, read the pro.</p>
    <p class="url">A daily football game · free in your browser</p>
  </div>
  <img class="pitch" src="data:image/png;base64,${pitch}" alt="">
</body></html>`);
await card.waitForTimeout(200);
await card.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
