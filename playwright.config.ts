import { defineConfig, devices } from "@playwright/test";
// The API's "today" is the day after the fixture day: the pages still open 2026-12-01 (?date=, ?today=; the API accepts
// picks up to today + 1), and the fixture day is a past day, so the training bank (past days only) has its 5 plays.
export default defineConfig({
  testDir: "tests/e2e",
  use: { ...devices["Pixel 7"], baseURL: "http://localhost:5173", reducedMotion: "reduce" }, // animations off: fast, deterministic
  webServer: [
    { command: "npm run dev", port: 8787, env: { PLAYMAKER_CONTENT: "tests/fixtures/content", PLAYMAKER_TODAY: "2026-12-02" }, reuseExistingServer: false },
    { command: "npm run dev:app", port: 5173, reuseExistingServer: false },
  ],
});
