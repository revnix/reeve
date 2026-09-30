// Every call the daemon makes over the network is bounded (#282): a `gh` or
// `git` that never answers, on a connection lost while the host slept say, is
// a read that failed, never a stopped daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./fixtures/temp.mjs";

/** A folder holding a `gh` and a `git` that never answer. */
function silent() {
  const dir = tempDir("reeve-net-silent-");
  for (const name of ["gh", "git"]) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/**
 * `src` run as a module in a node of its own, with those first on its PATH and
 * a bound of 300 milliseconds. Its answer, or `stopped` where it gave none in
 * fifteen seconds.
 * @param {string} src
 */
function within(src) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${silent()}:${process.env.PATH}`, REEVE_NET_TIMEOUT_MS: "300" },
  });
  return { stopped: r.signal !== null || r.error?.code === "ETIMEDOUT", out: r.stdout.trim(), err: r.stderr.trim() };
}

/** The module at `path` under src/, as an import can name it. @param {string} path */
const mod = (path) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);

test("the daemon's read of a pull request's state is bounded, so a gh that never answers can't stop it", () => {
  const r = within(`const m = await import(${mod("daemon.mjs")}); console.log(JSON.stringify(m.prStateOf("o/r", 42)));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.equal(r.out, "null", "and a state it couldn't read is no state");
});

test("the daemon's list of open pull requests is bounded, so a gh that never answers can't stop it", () => {
  const r = within(`const m = await import(${mod("daemon.mjs")}); console.log(JSON.stringify(m.openPrs("o/r")));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.equal(r.out, "null", "and a list it couldn't read is no list, not an empty one");
});

test("the reconciler's reads are bounded, a git that never answers included", () => {
  const r = within(`const m = await import(${mod("github/reconciler.mjs")}); console.log(JSON.stringify(m.pinHead("o/r", "main")));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.match(r.out, /"ok":false.*didn't answer within 0\.3 seconds, so it was stopped/);
});

test("the pull request reads are bounded, so a gh that never answers can't stop the daemon", () => {
  const r = within(`const m = await import(${mod("pr.mjs")}); console.log(JSON.stringify(m.readMergeQueue("o/r", "main")));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.match(r.out, /"ok":false.*didn't answer within 0\.3 seconds/);
});

test("the review reads are bounded, so a gh that never answers can't stop the daemon", () => {
  const r = within(`const m = await import(${mod("review/ingest.mjs")}); const o = m.observe("o/r", 42); console.log(JSON.stringify({ incomplete: o.incomplete, errors: o.errors ?? null }));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.match(r.out, /"incomplete":true/, "and a read it couldn't finish is said to be incomplete");
});

test("the CI root-cause reads are bounded, so a gh that never answers can't stop the daemon", () => {
  const r = within(`const m = await import(${mod("ci-rootcause.mjs")}); console.log(JSON.stringify(m.failingStep("o/r", 1)));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.match(r.out, /"ok":false.*didn't answer within 0\.3 seconds/);
});

test("the merge-health reads are bounded, so a gh that never answers can't stop the daemon", () => {
  const r = within(`const m = await import(${mod("status.mjs")}); console.log(JSON.stringify(m.cleanMergeRate("o/r", 20)));`);
  assert.equal(r.stopped, false, `it answered: ${r.err}`);
  assert.ok(r.out.length > 0, `and it said what it could: ${r.out}`);
});
