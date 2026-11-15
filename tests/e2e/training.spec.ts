import { expect, test } from "@playwright/test";
// Training: endless play over the bank (the fixture API's "today" is 2026-12-02, so its one day, 2026-12-01, is in the
// past: a bank of 5 plays). Scored by POST /api/train, kept apart from the daily game.

test("training: three plays from the bank with a running HUD; the daily game is untouched", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  const train = page.locator("#train");
  await expect(train).toHaveText("Training · 5 plays", { timeout: 15_000 }); // the size comes from the content
  await train.click();
  const confirm = page.getByRole("button", { name: "Confirm" });
  const hud = page.locator("#trainhud");
  await expect(hud).toBeVisible();
  await expect(page.locator("#dots")).toBeHidden();
  for (let i = 0; i < 3; i++) {
    await expect(page.locator("#count")).toHaveText(`Play ${i + 1}`, { timeout: 15_000 });
    await expect(confirm).toBeDisabled({ timeout: 15_000 });
    await expect(page.locator("#hint")).toContainText("What would you do?");
    for (let q = 0; q < 2; q++) {
      await page.getByText("Choose from a list").click();
      await page.locator(".opt").first().click();
      await confirm.click();
    }
    await expect(page.locator("#score")).toContainText("/100 points");
    await expect(page.locator("#reveal")).toContainText("AI coach");
    await expect(hud).toContainText(new RegExp(`Plays\s*${i + 1}`));
    await expect(page.locator("#next")).toHaveText("Next play");
    await page.locator("#next").click();
  }
  await expect(page.locator("#count")).toHaveText("Play 4", { timeout: 15_000 });
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem("pm.train") ?? "{}"));
  expect(st.plays).toBe(3);
  expect(new Set(st.order.slice(0, st.pos)).size).toBe(3); // three different plays, none repeated
  expect(Object.keys(st.recs)).toHaveLength(3);
  expect(await page.evaluate(() => localStorage.getItem("pm.days"))).toBeNull(); // no daily history, no streak
  // back on the intro, the bank card shows the progress
  await page.getByRole("button", { name: "End training" }).click();
  await expect(page.locator(".bank")).toContainText("3/5");
});
