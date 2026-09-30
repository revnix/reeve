// A push stopped at the network bound (#284). Since #283 a push that doesn't
// answer is stopped, so it can't stop the daemon, but one the remote took, and
// answered late, was then reported as refused. The remote's head is read again,
// bounded too, and the push is said to be published, not published, or not known.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./fixtures/temp.mjs";

const g = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const commit = (/** @type {string} */ cwd, /** @type {string} */ file) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  g(cwd, "add", "-A");
  g(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
  return g(cwd, "rev-parse", "HEAD");
};

/** An origin with `main` at a first commit, the founder's clone of it, and a worker's clone with a fix on top. */
function repos() {
  const root = tempDir("reeve-push-bound-");
  const seed = join(root, "seed"), origin = join(root, "origin.git"), founder = join(root, "founder"), worker = join(root, "worker");
  mkdirSync(seed);
  g(seed, "init", "-q", "-b", "main");
  const was = commit(seed, "first.txt");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  execFileSync("git", ["clone", "-q", origin, founder]);
  execFileSync("git", ["clone", "-q", origin, worker]);
  const fix = commit(worker, "fix.txt");
  return { root, origin, founder, worker, was, fix };
}

/**
 * A `git` first on the PATH that is git, but for a push, which lands on the
 * remote where `lands` and then never answers, and for a read of the remote
 * after the first, which never answers where `rereads` is false.
 */
function lateGit(/** @type {string} */ root, { lands = true, rereads = true } = {}) {
  const dir = join(root, "bin");
  mkdirSync(dir);
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const count = join(root, "reads");
  writeFileSync(join(dir, "git"), `#!/bin/sh
for a in "$@"; do case "$a" in
  push) ${lands ? `${real} "$@" >/dev/null 2>&1;` : ""} exec sleep 30;;
  ls-remote) n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}; ${rereads ? "" : `[ $n -gt 1 ] && exec sleep 30;`} break;;
esac; done
exec ${real} "$@"
`);
  chmodSync(join(dir, "git"), 0o755);
  return dir;
}

/** `publishRunWork` of the worker's fix to `main`, expected at `expected`, in a node of its own, with `bin` first on its PATH and a bound of three seconds. */
function publish(/** @type {ReturnType<typeof repos>} */ r, /** @type {string} */ bin, /** @type {string | null} */ expected = r.was) {
  const mod = JSON.stringify(new URL("../src/checkout.mjs", import.meta.url).href);
  const src = `const m = await import(${mod});
    console.log(JSON.stringify(m.publishRunWork({ repoRoot: ${JSON.stringify(r.founder)}, path: ${JSON.stringify(r.worker)}, branch: "main", expectedRemote: ${JSON.stringify(expected)} })));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REEVE_NET_TIMEOUT_MS: "3000" } });
  let out = null;
  try { out = JSON.parse(p.stdout.trim()); } catch { /* said below */ }
  return { out, err: p.stderr.trim() };
}

test("a push the remote took, answering after the bound, is published", () => {
  const r = repos();
  const { out, err } = publish(r, lateGit(r.root, { lands: true }));
  assert.ok(out, `it answered: ${err}`);
  assert.equal(g(r.origin, "rev-parse", "main"), r.fix, "control: the push landed");
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.head, r.fix);
});

test("a push stopped at the bound, the remote still where it was, isn't known to be published or not, as it may yet land", () => {
  const r = repos();
  const { out, err } = publish(r, lateGit(r.root, { lands: false }));
  assert.ok(out, `it answered: ${err}`);
  assert.equal(g(r.origin, "rev-parse", "main"), r.was, "control: the push hadn't landed when the remote was read");
  assert.equal(out.ok, false);
  assert.equal(out.unknown, true, JSON.stringify(out));
  assert.match(String(out.why), /didn't answer within 3 seconds, and whether it landed isn't known: the remote was still at [0-9a-f]{10} when read again, and the push may yet land/);
  assert.doesNotMatch(String(out.why), /refused|not published/);
});

test("a push stopped at the bound, the remote unreadable after, isn't known to be published or not", () => {
  const r = repos();
  const { out, err } = publish(r, lateGit(r.root, { lands: false, rereads: false }));
  assert.ok(out, `it answered: ${err}`);
  assert.equal(out.ok, false);
  assert.equal(out.unknown, true, JSON.stringify(out));
  assert.match(String(out.why), /whether it landed isn't known/);
});

test("a push with no head expected, the remote taking it and answering after the bound, is published", () => {
  const r = repos();
  const { out, err } = publish(r, lateGit(r.root, { lands: true }), null);
  assert.ok(out, `it answered: ${err}`);
  assert.equal(g(r.origin, "rev-parse", "main"), r.fix, "control: the push landed");
  assert.equal(out.ok, true, JSON.stringify(out));
});
