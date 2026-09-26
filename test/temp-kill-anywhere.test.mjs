// A test killed at any moment leaves no temporary folder behind (#231).
//
// test/fixtures/temp.mjs starts a watcher that removes a test's folders once
// the test is gone. Each case here runs a child, with TMPDIR set to an empty
// folder of its own, that kills itself outright at one moment of the helper's
// work: as the watcher starts, or as a folder comes to exist. The child swaps
// node's own function for one that runs it and then sends SIGKILL, so the kill
// lands at that moment every time rather than by a race. Then the watcher has
// a moment to do its work, and whatever is left in that folder is what the
// test left for good.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const helper = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "temp.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What a child leaves once it has killed itself at the `nth` call of
// `module`'s `fn`, while asking the helper for two folders. The folder the
// test makes for it is made here, apart from the helper, and removed after.
const leftAfterKill = async (module, fn, nth) => {
  const tmp = mkdtempSync(join(tmpdir(), "reeve-kill-"));
  try {
    const script = `import m from ${JSON.stringify(module)}; import { syncBuiltinESMExports } from "node:module";
      const real = m.${fn}; let calls = 0;
      m.${fn} = (...a) => { const r = real(...a); if (++calls === ${nth}) process.kill(process.pid, "SIGKILL"); return r; };
      syncBuiltinESMExports();
      const { tempDir } = await import(${JSON.stringify(helper)});
      tempDir("reeve-a-"); tempDir("reeve-b-");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, encoding: "utf8", timeout: 30_000 });
    // The watcher works once the child is gone, so give it a moment.
    for (let n = 0; n < 50 && readdirSync(tmp).length; n++) await sleep(100);
    return { signal: r.signal, left: readdirSync(tmp), stderr: r.stderr.slice(0, 300) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
};

const kills = process.platform === "win32" ? "Windows has no SIGKILL to send oneself" : false;

test("a test killed as the watcher starts, before any folder exists, leaves nothing", { skip: kills }, async () => {
  const r = await leftAfterKill("node:child_process", "spawn", 1);
  assert.equal(r.signal, "SIGKILL", JSON.stringify(r));
  assert.deepEqual(r.left, [], JSON.stringify(r));
});

test("a test killed the moment its first folder exists leaves nothing", { skip: kills }, async () => {
  for (const fn of ["mkdirSync", "mkdtempSync"]) {
    const r = await leftAfterKill("node:fs", fn, 1);
    assert.equal(r.signal, "SIGKILL", `${fn}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.left, [], `${fn}: ${JSON.stringify(r)}`);
  }
});

test("a test killed the moment a later folder exists leaves nothing", { skip: kills }, async () => {
  const r = await leftAfterKill("node:fs", "mkdtempSync", 2);
  assert.equal(r.signal, "SIGKILL", JSON.stringify(r));
  assert.deepEqual(r.left, [], JSON.stringify(r));
});
