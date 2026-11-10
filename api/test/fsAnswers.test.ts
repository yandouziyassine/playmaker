import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fsDeps } from "../src/fsAnswers.ts";

it("reads answers and the publication date of a moment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  fs.mkdirSync(path.join(root, "answers"), { recursive: true });
  fs.mkdirSync(path.join(root, "public", "days"), { recursive: true });
  fs.writeFileSync(path.join(root, "answers", "M1.json"), JSON.stringify({ id: "M1" }));
  fs.writeFileSync(path.join(root, "public", "days", "2026-12-01.json"), JSON.stringify({ moments: ["M1"] }));
  fs.writeFileSync(path.join(root, "public", "days", "index.json"), JSON.stringify({ days: [{ date: "2026-12-01", day_number: 1 }] }));
  const d = fsDeps(root);
  expect((await d.answer("M1"))?.id).toBe("M1");
  expect(await d.answer("M9")).toBeNull();
  expect(await d.momentDate("M1")).toBe("2026-12-01");
  expect(await d.momentDate("M9")).toBeNull();
});
