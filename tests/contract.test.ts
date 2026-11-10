import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, it } from "vitest";

const root = "tests/fixtures/content";
const ajv = new Ajv2020({ allErrors: true });
const schema = (n: string) => ajv.compile(JSON.parse(fs.readFileSync(path.join(root, "schemas", `${n}.schema.json`), "utf8")));
const files = (dir: string) => fs.readdirSync(path.join(root, dir)).map((f) => JSON.parse(fs.readFileSync(path.join(root, dir, f), "utf8")));

it("fixture content matches the release schemas", () => {
  for (const [name, dir] of [["day", "public/days"], ["moment", "public/moments"], ["answer", "answers"]] as const) {
    const v = schema(name);
    for (const f of files(dir)) expect(v(f), JSON.stringify(v.errors)).toBe(true);
  }
});
