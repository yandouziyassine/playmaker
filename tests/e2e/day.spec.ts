import { expect, test } from "@playwright/test";

test("plays a full day: select, confirm, reveal, recap", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01");
  await expect(page.locator("#howto")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Play today's five" }).click();
  for (let i = 0; i < 5; i++) {
    const confirm = page.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeDisabled({ timeout: 15_000 });
    await page.getByText("Choose from a list").click();
    await page.locator(".opt").first().click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const reveal = page.locator("#reveal");
    await expect(reveal).toContainText("points");
    await expect(reveal).toContainText("AI coach");
    await expect(reveal).toContainText("The pro");
    await expect(reveal).toContainText("model opinion");
    await expect(page.locator(".dot").nth(i)).not.toHaveClass(/now|todo/);
    await page.locator("#next").click();
  }
  await expect(page.locator("#total")).toHaveText(/^\d+$/);
  await expect(page.locator("#squares")).toHaveText(/^([🟩🟨⬜] ?){5}$/u);
  await expect(page.locator("#streak")).toContainText("Streak: 1 day");
  await page.reload();
  await expect(page.locator("#done")).toBeVisible();
  await expect(page.locator("#howto")).not.toHaveAttribute("open", "");
});

test("tapping a teammate on the pitch selects a pass", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01");
  await page.getByRole("button", { name: "Play today's five" }).click();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled({ timeout: 15_000 });
  const box = (await page.locator("#pitch").boundingBox())!;
  // sweep the canvas until a tap selects something
  let picked = false;
  for (let y = 0.1; y < 0.9 && !picked; y += 0.04) {
    for (let x = 0.1; x < 0.9 && !picked; x += 0.04) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      picked = await page.getByRole("button", { name: "Confirm" }).isEnabled();
    }
  }
  expect(picked).toBe(true);
  await expect(page.locator(".actions .choice")).not.toHaveText("Nothing selected");
});

test("public content never exposes answers", async ({ request }) => {
  expect((await request.get("http://localhost:8787/content/../answers/x.json")).status()).toBe(404);
  const day = await (await request.get("http://localhost:8787/content/days/2026-12-01.json")).json();
  const mo = await (await request.get(`http://localhost:8787/content/moments/${day.moments[0]}.json`)).text();
  for (const k of ["points", "pro_pick", "share_top", "reasons", "after"]) expect(mo).not.toContain(`"${k}"`);
});
