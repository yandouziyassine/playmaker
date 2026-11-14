import { expect, test } from "@playwright/test";
// tour=0: the guided first moment (coach-marks) is off here; tests/e2e/fr.spec.ts plays it.

test("plays a full day: both questions, reveal, recap", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await expect(page.locator("#howto")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Play today's five" }).click();
  for (let i = 0; i < 5; i++) {
    const confirm = page.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeDisabled({ timeout: 15_000 });
    await expect(page.locator("#hint")).toContainText("What would you do?");
    await page.getByText("Choose from a list").click();
    await page.locator(".opt").first().click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    // question 2: nothing revealed yet, passes only
    const reveal = page.locator("#reveal");
    await expect(page.locator("#hint")).toContainText("What did the pro actually do?");
    await expect(reveal).toBeHidden();
    await expect(confirm).toBeDisabled();
    await page.getByText("Choose from a list").click();
    for (const label of await page.locator(".opt").allTextContents()) expect(label).toMatch(/^Pass to /);
    await page.locator(".opt").first().click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(reveal.locator(".proread")).toHaveText(/^(You read the pro|The pro played Pass to .+)$/);
    await expect(reveal).toContainText("points");
    await expect(reveal).toContainText("AI coach");
    await expect(reveal).toContainText("The pro");
    await expect(reveal).toContainText("model opinion");
    const note = reveal.locator(".lesson"); // Coach's note: one lesson at most, when the pick was not the AI's
    expect(await note.count()).toBeLessThanOrEqual(1);
    if (await note.count()) {
      await expect(note).toContainText("Coach's note");
      const why = note.locator("details.lwhy");
      if (await why.count()) { await why.locator("summary").click(); await expect(why.locator("li").first()).toBeVisible(); }
    }
    await expect(page.locator(".dot").nth(i)).not.toHaveClass(/now|todo/);
    await page.locator("#next").click();
  }
  await expect(page.locator("#total")).toHaveText(/^\d+$/);
  await expect(page.locator("#squares")).toHaveText(/^([🟩🟨⬜] ?){5}$/u);
  await expect(page.locator("#reads")).toHaveText(/^Pro reads [0-5]\/5$/);
  await expect(page.locator("#streak")).toContainText("Streak: 1 day");
  // Coach's notebook: the day's lessons (or a clean day) and, once something was flagged, the skill to work on
  const notebook = page.locator("#done .notebook");
  await expect(notebook.locator("h2")).toHaveText("Coach's notebook");
  await expect(notebook.locator(".nbentry, .nbclean").first()).toBeVisible();
  expect(await notebook.locator(".nbentry").count()).toBeLessThanOrEqual(3);
  if (await notebook.locator(".nbentry").count()) await expect(notebook.locator(".nbweak")).toContainText("Skill to work on:");
  await page.reload();
  await expect(page.locator("#done")).toBeVisible();
  await expect(notebook.locator("h2")).toHaveText("Coach's notebook"); // rebuilt from the stored records
  await expect(page.locator("#reads")).toHaveText(/^Pro reads [0-5]\/5$/);
  await expect(page.locator("#howto")).not.toHaveAttribute("open", "");
});

test("tapping a teammate on the pitch selects a pass", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
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

test("launch day: the intro shows the product (sample moment preview)", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await expect(page.locator("#preview")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#preview-cap")).toContainText("sample moment");
});

test("public content never exposes answers", async ({ request }) => {
  expect((await request.get("http://localhost:8787/content/../answers/x.json")).status()).toBe(404);
  const day = await (await request.get("http://localhost:8787/content/days/2026-12-01.json")).json();
  const mo = await (await request.get(`http://localhost:8787/content/moments/${day.moments[0]}.json`)).text();
  for (const k of ["points", "pro_pick", "share_top", "reasons", "after"]) expect(mo).not.toContain(`"${k}"`);
});

test("in 3D, tapping a teammate selects a pass", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await page.getByRole("button", { name: "Play today's five" }).click();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled({ timeout: 15_000 });
  const toggle = page.locator(".v3d-toggle");
  await toggle.click();
  await expect(toggle).toHaveText(/2D|3D unavailable/, { timeout: 20_000 });
  test.skip((await toggle.textContent()) === "3D unavailable", "no WebGL in this browser");
  const host = page.locator(".v3d-host canvas");
  await expect(host).toBeVisible();
  const names = page.getByRole("button", { name: "Names" }); // name labels: off by default, a switch
  await expect(names).toHaveAttribute("aria-pressed", "false");
  await names.click();
  await expect(names).toHaveAttribute("aria-pressed", "true");
  await names.click();
  const box = (await host.boundingBox())!;
  let picked = false;
  for (let y = 0.35; y < 0.95 && !picked; y += 0.05) {
    for (let x = 0.05; x < 0.95 && !picked; x += 0.05) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      picked = await page.getByRole("button", { name: "Confirm" }).isEnabled();
    }
  }
  expect(picked).toBe(true);
  await expect(page.locator(".actions .choice")).not.toHaveText("Nothing selected");
});

test("keyboard play: arrows / Tab move the selection on the pitch, Enter confirms", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await page.getByRole("button", { name: "Play today's five" }).click();
  const confirm = page.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled({ timeout: 15_000 });
  const pitch = page.locator("#pitch");
  await expect(pitch).toBeFocused(); // focus continues on the pitch once the Play button is gone
  const labels = await page.locator(".opt").allTextContents(); // the list's order is the keyboard order
  const choice = page.locator(".actions .choice");
  await page.keyboard.press("ArrowRight");
  await expect(choice).toHaveText(labels[0]!);
  await expect(page.locator("#hint")).toContainText(`Selected: ${labels[0]}.`); // read out by the aria-live hint
  await page.keyboard.press("ArrowRight");
  await expect(choice).toHaveText(labels[1]!);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(choice).toHaveText(labels[labels.length - 1]!); // wraps
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect(choice).toHaveText(labels[1]!);
  await expect(pitch).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#hint")).toContainText("What did the pro actually do?");
  await expect(pitch).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(choice).toHaveText(/^Pass to /);
  await page.keyboard.press("Enter");
  await expect(page.locator("#reveal")).toContainText("points");
  await expect(page.locator("#next")).toBeFocused();
});
