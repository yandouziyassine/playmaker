import { expect, test } from "@playwright/test";
// French UI (?lang=fr), the guided first moment (coach-marks) and the EN | FR switch. Text matching normalises
// whitespace, so "Que ferais-tu ?" also matches the narrow no-break space the page uses before "?".

test("plays one moment in French with the guided first moment", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&lang=fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.locator("h1").first()).toContainText("Choisis la passe.");
  await expect(page.locator("#howto summary")).toHaveText("Comment jouer");
  await expect(page.getByRole("button", { name: "Français" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".more")).toContainText("Labo");
  await page.getByRole("button", { name: "Jouer les cinq du jour" }).click();

  const confirm = page.getByRole("button", { name: "Confirmer" });
  const tour = page.locator("#tour");
  await expect(confirm).toBeDisabled({ timeout: 15_000 });
  await expect(page.locator("#hint")).toContainText("Que ferais-tu ?");
  await expect(tour).toBeVisible();
  await expect(tour).toContainText("Astuce 1 sur 4");
  await expect(tour).toContainText("l’anneau jaune marque le porteur du ballon");
  await page.getByRole("button", { name: "Suivant" }).click();
  await expect(tour).toContainText("Touche un coéquipier pour faire une passe, un chevron jaune pour porter le ballon, ou le but pour tirer.");

  await page.getByText("Choisir dans une liste").click();
  const labels = await page.locator(".opt").allTextContents();
  for (const l of labels) expect(l).toMatch(/^(Passe à #\d+ .+|Conduite .+|Tir)$/);
  await page.locator(".opt").first().click();
  await expect(tour).toContainText("Appuie sur Confirmer");
  await confirm.click();
  await expect(tour).toBeHidden();

  await expect(page.locator("#hint")).toContainText("Qu’a vraiment fait le pro ?");
  await page.getByText("Choisir dans une liste").click();
  for (const l of await page.locator(".opt").allTextContents()) expect(l).toMatch(/^Passe à /);
  await page.locator(".opt").first().click();
  await confirm.click();

  const reveal = page.locator("#reveal");
  await expect(reveal.locator(".proread")).toHaveText(/^(Tu as lu le jeu du pro|Le pro a joué\s:\sPasse à .+ · ta lecture\s:\sPasse à .+)$/);
  await expect(reveal).toContainText("/100 points");
  await expect(reveal).toContainText("Entraîneur IA");
  await expect(reveal).toContainText("Le pro");
  await expect(reveal).toContainText("l’avis d’un modèle, pas la vérité");
  await expect(reveal.locator(".reasons li").first()).not.toContainText(/\b(pass|lane|receiver|if it arrives)\b/); // coach phrases in French
  const note = reveal.locator(".lesson"); // the first list option is never the AI's pick in this fixture moment
  await expect(note).toContainText("Note de l’entraîneur");
  await note.getByText("Pourquoi ?").click();
  await expect(note.locator(".lwhy li").first()).not.toContainText(/\b(pass|lane|receiver|your|the AI)\b/);
  await expect(page.locator("#hint .legend")).toContainText("Entraîneur IA");
  await expect(tour).toContainText("Bleu = l’entraîneur IA, jaune = le pro, blanc = toi.");
  await page.getByRole("button", { name: "Compris" }).click();
  await expect(tour).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("pm.tour"))).toBe("1");
  await expect(page.locator("#next")).toHaveText("Action suivante");
});

test("the tour can be skipped and never comes back", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01");
  await page.getByRole("button", { name: "Play today's five" }).click();
  const tour = page.locator("#tour");
  await expect(tour).toContainText("the yellow ring is the ball carrier", { timeout: 15_000 });
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(tour).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Play today's five" }).click();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled({ timeout: 15_000 });
  await expect(tour).toBeHidden();
});

test("the EN | FR switch saves the choice; the about page follows it", async ({ page }) => {
  await page.goto("/?date=2026-12-01&today=2026-12-01&tour=0");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Français" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("button", { name: "Jouer les cinq du jour" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pm.lang"))).toBe("fr");
  await page.goto("/about.html");
  await expect(page.locator("main:visible h1")).toContainText("Comment l’entraîneur IA te note");
  await page.goto("/replay.html");
  await expect(page.locator(".page")).toHaveText("Jeu libre");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator(".page")).toHaveText("Free play");
});

test("the Lab in French: strings, landmark names and the EN | FR switch", async ({ page }) => {
  await page.goto("/lab.html?lang=fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.locator("h1")).toContainText("D’une image télé à la tactique");
  await expect(page.locator(".topbar .page")).toHaveText("Labo");
  await expect(page.getByRole("button", { name: "Français" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".limits h2")).toHaveText("Limites, en toute franchise");
  await page.getByRole("button", { name: "Essayer une scène de synthèse" }).click();
  const point1 = page.getByRole("combobox", { name: "Repère du point 1" });
  await expect(point1).toBeVisible();
  await expect(point1).toHaveAttribute("title", /^Surface de réparation droite\s:\sligne de but, côté éloigné$/);
  await expect(page.locator("#calib-msg")).toContainText("Calibré");
  await page.getByRole("button", { name: "Calibrer automatiquement" }).click();
  await expect(page.locator("#status")).toContainText(/^Calibrage automatique en \d+\sms \(moitié droite\)\s:\sajustement bon/);
  await expect(page.locator("#calib-msg")).toContainText("Calibré");
  await expect(page.locator("#fit")).toContainText(/Ajustement|ajustement/);
  // video clip mode: its card, in French, and the picture pipeline put away
  await page.getByRole("button", { name: "Clip vidéo" }).click();
  await expect(page.getByRole("button", { name: "Clip vidéo" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#clip-card h2")).toHaveText("1 · Clip vidéo");
  await expect(page.locator("#clip-drop")).toContainText("Choisis ou dépose un clip vidéo");
  await expect(page.locator("#load-card")).toBeHidden();
  await expect(page.locator("#work")).toBeHidden();
  await expect(page.locator(".limits")).toContainText("Clip vidéo : seulement les 60 premières secondes");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator(".topbar .page")).toHaveText("Lab");
});
