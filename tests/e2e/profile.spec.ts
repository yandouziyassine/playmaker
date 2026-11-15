import { expect, test } from "@playwright/test";

test("profile: nickname, player code, link import merges progress", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await page.evaluate(() => localStorage.setItem("pm.days", JSON.stringify({ "2026-11-30": [100, 80, 0, 45, 100] })));
  await page.getByRole("button", { name: "Profile" }).click();
  const dlg = page.locator("dialog.profile");
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("Nickname").fill("Pirlo");
  await dlg.getByLabel("Nickname").press("Tab");
  await expect(dlg.getByText("Saved.")).toBeVisible();
  await dlg.getByRole("button", { name: "Create my code" }).click();
  await expect(dlg.getByRole("button", { name: "Create my code" })).toHaveCount(0);
  const code = await dlg.locator("textarea.pf-code").first().inputValue();
  expect(code).toMatch(/^PM1\.[0-9a-f]{8}\./);

  // a bad code is refused with a reason
  await dlg.locator("#pf-import").fill("PM1.00000000.abc");
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(dlg.locator(".pf-msg.bad")).toContainText("damaged");

  // another device: empty storage, opened from the code link
  await page.evaluate(() => { localStorage.removeItem("pm.days"); localStorage.removeItem("pm.name"); });
  await page.goto(`/?date=2026-12-01&today=2026-12-01&tour=0&device=2#code=${encodeURIComponent(code)}`);
  await expect(dlg).toBeVisible({ timeout: 10_000 });
  await expect(dlg).toContainText("A player code came with this link");
  expect(new URL(page.url()).hash).toBe("");
  await dlg.getByRole("button", { name: "Import" }).click();
  await expect(dlg).toContainText("Imported and merged. Days: 1");
  expect(await page.evaluate(() => localStorage.getItem("pm.name"))).toBe("Pirlo");
});
