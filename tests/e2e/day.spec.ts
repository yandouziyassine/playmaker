import { expect, test } from "@playwright/test";

test("plays a full day and shows a share card", async ({ page }) => {
  await page.goto("/?date=2026-12-01");
  await page.getByRole("button", { name: "Play today's five" }).click();
  for (let i = 0; i < 5; i++) {
    await expect(page.locator("#title")).toContainText(`${i + 1}/5`);
    const carry = page.getByRole("button", { name: "Carry forward" });
    await carry.waitFor({ timeout: 10_000 });
    await carry.click();
    await expect(page.locator("#reveal")).toContainText("points");
    await expect(page.locator("#reveal")).toContainText("model opinion");
    await page.locator("#next").click();
  }
  await expect(page.locator("#score")).toContainText("Playmaker #1");
  await expect(page.locator("#score")).toContainText("/500");
  await page.reload();
  await expect(page.locator("#done")).toBeVisible();
});

test("public content never exposes answers", async ({ request }) => {
  expect((await request.get("http://localhost:8787/content/../answers/x.json")).status()).toBe(404);
  const day = await (await request.get("http://localhost:8787/content/days/2026-12-01.json")).json();
  const mo = await (await request.get(`http://localhost:8787/content/moments/${day.moments[0]}.json`)).text();
  for (const k of ["points", "pro_pick", "share_top", "reasons"]) expect(mo).not.toContain(`"${k}"`);
});
