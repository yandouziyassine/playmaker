import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  use: { ...devices["Pixel 7"], baseURL: "http://localhost:5173", reducedMotion: "reduce" }, // animations off: fast, deterministic
  webServer: [
    { command: "npm run dev", port: 8787, env: { PLAYMAKER_CONTENT: "tests/fixtures/content", PLAYMAKER_TODAY: "2026-12-01" }, reuseExistingServer: false },
    { command: "npm run dev:app", port: 5173, reuseExistingServer: false },
  ],
});
