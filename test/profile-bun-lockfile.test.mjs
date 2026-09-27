// bun 1.2 and later keep a text lockfile, bun.lock, where earlier versions kept
// the binary bun.lockb (measured in docs/measured/2026-09-27-workspace-membership.md).
// Detection knew only bun.lockb, so a project on today's bun had no package manager.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectPackageManager } from "../src/profile/detect.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** A folder holding the named files, each empty. */
const folder = (...files) => {
  const dir = tempDir("reeve-bun-lock-");
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
};

test("bun's text lockfile, bun.lock, names bun", () => {
  assert.deepEqual(detectPackageManager(folder("bun.lock")), { value: "bun", question: null });
  assert.deepEqual(detectPackageManager(folder("bun.lockb")), { value: "bun", question: null }, "control: the binary one still does");
});

test("bun's two lockfiles together name one package manager, not a question", () => {
  assert.deepEqual(detectPackageManager(folder("bun.lock", "bun.lockb")), { value: "bun", question: null });
  const two = detectPackageManager(folder("bun.lock", "package-lock.json"));
  assert.equal(two.value, null, "control: two managers' lockfiles are still a question");
  assert.deepEqual(two.question?.options, ["npm", "bun"]);
});
