import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { root: ".", include: ["api/test/**/*.test.ts", "app/test/**/*.test.ts", "tests/*.test.ts"] },
});
