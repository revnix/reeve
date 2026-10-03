import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("every stub entry opens before its name so no entry is lost", () => {
  const lines = readFileSync(new URL("./stub-manifest.mjs", import.meta.url), "utf8").split("\n")
    .filter(line => line.trim() && !line.trim().startsWith("//"));
  const names = lines.flatMap((line, index) => /^    name:/.test(line) ? [index] : []);
  assert.ok(names.length > 0, "the manifest has entries to check");
  for (const index of names)
    assert.equal(lines[index - 1], "  {", `${lines[index].trim()} must open its own entry`);
});
