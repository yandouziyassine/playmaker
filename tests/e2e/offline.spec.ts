import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build, preview, type PreviewServer } from "vite";

// Offline play against a production build (the service worker is build-only): `vite build` into a temp dir and
// `vite preview` on :4173, which proxies /content and /api to the fixture API on :8787 (started by
// playwright.config.ts). ?sw=1 turns the worker on for localhost. The preview server is even shut down for the
// offline part, so the intro, the day and its moments can only come from the worker's caches.
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const PAGE = `${BASE}/?sw=1&date=2026-12-01&today=2026-12-01&tour=0`;
const OUT = path.join(os.tmpdir(), "playmaker-offline-e2e");

let server: PreviewServer | null = null;
const startPreview = async () => {
  server = await preview({ logLevel: "warn", build: { outDir: OUT }, preview: { port: PORT, strictPort: true } });
};

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await build({ logLevel: "warn", build: { outDir: OUT, emptyOutDir: true } });
  await startPreview();
});
test.afterAll(async () => { await server?.close(); });

const queued = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem("pm.pickq") ?? "[]") as unknown[]).length);

test("a day opened online can be reloaded and played offline; the answers are scored once back online", async ({ page, context }) => {
  test.setTimeout(120_000);
  const play = page.getByRole("button", { name: "Play today's five" });
  await page.goto(PAGE);
  await expect(play).toBeEnabled();
  // first visit: the worker installs, takes over and caches the day and its five moments (WARM message)
  await expect.poll(() => page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) return "no controller";
    const day = await caches.match("/content/days/2026-12-01.json");
    const moments = await (await caches.open("pm-moments-v1")).keys();
    return `${!!day} ${moments.length}`;
  }), { timeout: 30_000 }).toBe("true 5");

  // offline, and the server gone: everything below comes from the caches
  await server!.close(); server = null;
  await context.setOffline(true);
  await page.reload();
  await expect(play).toBeEnabled();
  await expect(page.locator("#day-label")).toContainText("1");

  await play.click();
  const confirm = page.getByRole("button", { name: "Confirm" });
  for (let q = 0; q < 2; q++) {
    await expect(confirm).toBeDisabled({ timeout: 15_000 });
    await page.getByText("Choose from a list").click();
    await page.locator(".opt").first().click();
    await confirm.click();
  }
  const reveal = page.locator("#reveal");
  await expect(reveal).toContainText("Offline");
  await expect(reveal).toContainText("scored when you're back online");
  await expect(page.locator(".dot").first()).toHaveClass(/pending/);
  await expect(page.locator("#next")).toBeVisible();
  expect(await queued(page)).toBe(1);

  // back online: the queued answer is sent ('online' event) and the queue empties
  await startPreview();
  await context.setOffline(false);
  await expect.poll(() => queued(page), { timeout: 20_000 }).toBe(0);
});
