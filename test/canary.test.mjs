// The sandbox canary judges FILES, not the worker's account of itself.
//
// A fake runner plays the part of the sandboxed script: each case writes what
// a script under a particular boundary would have left behind, and the
// assertion is on the verdict the daemon draws from those files. The real
// boundary is measured in test/escape.test.mjs (under the runtime) and by the
// daemon at start (under the CLI); this file proves the judge.
import { sandboxCanary, canaryIdFor, canaryScript, writeCanaryState, readCanaryState, canaryStatePath, CANARY_SENTINEL } from "../src/canary.mjs";
import { sandboxFor } from "../src/sandbox.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-canary-"));
const profile = { identity: { key: "o/r", defaultBranch: "main" }, units: [] };
const block = sandboxFor({ profile, action: "FIX_CI", worktree: "/w", tmpDir: "/t" }).settings;
const base = {
  cliVersion: "2.1.237 (Claude Code)", sandbox: block.sandbox, permissionsDeny: block.permissions.deny,
  dir: join(root, "canary"), outsideDir: join(root, "outside"), tmpDir: join(root, "tmp"),
  // ~/.reeve is deny-read; the decoy must sit under it to be measurable. The
  // path is never written to in these tests except by the canary itself.
  decoyPath: join(homedir(), ".reeve", "canary", "test-decoy-" + process.pid + ".txt"),
  bin: "/bin/sh", env: { PATH: "/usr/bin:/bin" },
  // The host-reachability control is injected so tests never touch the network.
  netReachable: () => true,
};

// A runner that behaves like a sandboxed script under the given boundary.
// The Read-tool verdict is judged from the worker's EVENT STREAM (canary.out),
// so the fake runner writes a representative stream-json plus the corroborating
// file. readTool: "denied" (attempted + denied), "leak" (result carries the
// sentinel), "absent" (never attempted), "not-denied" (attempted, no denial).
const streamFor = (readTool) => {
  const lines = [];
  const readUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", id: "r1", input: { file_path: base.decoyPath } }] } };
  const resultOf = content => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content, is_error: /denied/i.test(content) }] } });
  if (readTool === "absent") return "";
  lines.push(JSON.stringify(readUse));
  if (readTool === "denied") lines.push(JSON.stringify(resultOf("Permission to read the file was denied.")));
  else if (readTool === "leak") lines.push(JSON.stringify(resultOf(CANARY_SENTINEL + "\nreeve canary decoy")));
  else if (readTool === "not-denied") lines.push(JSON.stringify(resultOf("(the file was read)")));
  return lines.join("\n") + "\n";
};
const runnerThat = ({ inside = true, tmp = true, outside = false, curl = false, decoy = false, symlink = false, results = true, outcome = "ok", readTool = "denied" } = {}) =>
  async ({ cwd, outPath }) => {
    const rec = [];
    if (inside) writeFileSync(join(cwd, "INSIDE"), ""); rec.push(`inside=${inside ? 0 : 1}`);
    if (tmp) writeFileSync(join(base.tmpDir, "TMP"), ""); rec.push(`tmp=${tmp ? 0 : 1}`);
    if (outside) writeFileSync(join(base.outsideDir, "OUTSIDE"), ""); rec.push(`outside=${outside ? 0 : 1}`);
    if (curl) writeFileSync(join(cwd, "curl-body"), "<html>"); rec.push(`curl=${curl ? 0 : 56}`);
    if (decoy) writeFileSync(join(cwd, "decoy-copy"), "x"); rec.push(`decoy=${decoy ? 0 : 1}`);
    if (symlink) writeFileSync(join(cwd, "decoy-copy2"), "x"); rec.push(`symlink=${symlink ? 0 : 1}`);
    if (results) writeFileSync(join(cwd, "canary-results.txt"), rec.join("\n") + "\n");
    if (outPath) writeFileSync(outPath, streamFor(readTool));
    if (readTool === "denied") writeFileSync(join(cwd, "read-tool-out"), "DENIED");
    else if (readTool === "leak") writeFileSync(join(cwd, "read-tool-out"), CANARY_SENTINEL + "\n");
    return { outcome, why: outcome === "ok" ? "completed" : "planted", ms: 1, cost: 0, sessionId: "c" };
  };

// ── the id ────────────────────────────────────────────────────────────────────
{
  const a = canaryIdFor({ cliVersion: "1", sandbox: block.sandbox });
  const b = canaryIdFor({ cliVersion: "1", sandbox: { ...block.sandbox, filesystem: { ...block.sandbox.filesystem, allowWrite: ["/other/tmp"], allowRead: ["/other/tmp"] } } });
  const c = canaryIdFor({ cliVersion: "2", sandbox: block.sandbox });
  const d = canaryIdFor({ cliVersion: "1", sandbox: { ...block.sandbox, allowUnsandboxedCommands: true } });
  check(a === b, "the id ignores the per-run tmp grant", `${a} ${b}`);
  check(a !== c, "and changes with the CLI version", `${a} ${c}`);
  check(a !== d, "and with any other part of the block", `${a} ${d}`);
  let threw = false; try { canaryIdFor({ cliVersion: "1" }); } catch { threw = true; }
  check(threw, "an id without a block is refused, not computed from nothing");
}

// ── the script leaves files for every probe ──────────────────────────────────
{
  const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: "/Users/x/.reeve/d.txt" });
  check(/touch \.\/INSIDE/.test(s) && /"\/t\/TMP"/.test(s) && /"\/o\/OUTSIDE"/.test(s) && /curl .* -o \.\/curl-body/.test(s) && /cp "\/Users\/x\/.reeve\/d.txt" \.\/decoy-copy/.test(s) && /decoy-copy2/.test(s),
    "every probe writes a file the daemon can stat", s);
  check(!/cat /.test(s), "and none of them prints a file's contents", s);
}

// ── verdicts ──────────────────────────────────────────────────────────────────
{
  const r = await sandboxCanary({ ...base, runner: runnerThat() });
  check(r.ok === true && r.why === null, "every denial held and both controls succeeded: ok", r.why);
  check(r.id === canaryIdFor({ cliVersion: base.cliVersion, sandbox: base.sandbox }), "the verdict carries the boundary's id");
  check(!existsSync(base.dir) && !existsSync(base.outsideDir) && !existsSync(base.decoyPath), "a passing canary cleans up after itself");
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ outside: true }) });
  check(r.ok === false && /wrote outside/.test(r.why), "a file outside the worktree fails it", r.why);
  check(existsSync(join(base.dir, "canary-results.txt")), "and the failing run's directory is kept for diagnosis");
  check(!existsSync(base.outsideDir) && !existsSync(base.decoyPath), "but the outside dir and the decoy are still removed");
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ curl: true }) });
  check(r.ok === false && /network/.test(r.why), "a reachable network fails it", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ decoy: true }) });
  check(r.ok === false && /deny-read/.test(r.why), "a copied decoy fails it", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ symlink: true }) });
  check(r.ok === false && /symlink/.test(r.why), "a decoy read through a symlink fails it", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ inside: false }) });
  check(r.ok === false && /control/.test(r.why), "a worker that could not write inside its own directory fails it (control)", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ tmp: false }) });
  check(r.ok === false && /tmp was not writable/.test(r.why), "an unwritable run tmp fails it (the carve-out is part of the contract)", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ results: false, outcome: "failed" }) });
  check(r.ok === false && /did not run to completion/.test(r.why) && /failed/.test(r.why), "no results file is a failure naming the worker's outcome", r.why);
}
{
  // The script's own exit codes are recorded but never decide: a script that
  // REPORTS the outside write as denied while the file exists is caught by
  // the file.
  const liar = async ({ cwd }) => {
    writeFileSync(join(cwd, "INSIDE"), ""); writeFileSync(join(base.tmpDir, "TMP"), "");
    writeFileSync(join(base.outsideDir, "OUTSIDE"), "");
    writeFileSync(join(cwd, "canary-results.txt"), "inside=0\ntmp=0\noutside=1\ncurl=56\ndecoy=1\nsymlink=1\n");
    return { outcome: "ok", why: "completed" };
  };
  const r = await sandboxCanary({ ...base, runner: liar });
  check(r.ok === false && /wrote outside/.test(r.why), "the file, not the reported exit code, is the evidence", r.why);
}
{
  // Worker failed AFTER the script proved the boundary: the files decide.
  const r = await sandboxCanary({ ...base, runner: runnerThat({ outcome: "timeout" }) });
  check(r.ok === true && r.evidence.outcome === "timeout", "a worker that timed out after leaving complete evidence still passes, with the outcome recorded", JSON.stringify(r.evidence.outcome));
}
{
  const r = await sandboxCanary({ ...base, decoyPath: join(root, "decoy.txt"), runner: runnerThat() });
  check(r.ok === false && /not under any deny-read path/.test(r.why), "a decoy outside every denied path is refused: the read probe could not fail", r.why);
}
{
  const r = await sandboxCanary({ ...base, outsideDir: join(base.dir, "inner"), runner: runnerThat() });
  check(r.ok === false && /outside the canary's own directory/.test(r.why), "an 'outside' dir inside the canary dir is refused", r.why);
}
{
  let seen = null;
  const r = await sandboxCanary({ ...base, runner: async (a) => { seen = a; return runnerThat()(a); } });
  check(r.ok && seen.args.includes("--settings") && seen.args.includes("--max-turns") && seen.cwd === base.dir && seen.env === base.env,
    "the canary runs through workerArgs with its settings, in its dir, under the env it was given", JSON.stringify({ cwd: seen.cwd }));
}
{
  const bad = { ...base, sandbox: { ...base.sandbox, allowUnsandboxedCommands: true } };
  let ran = false;
  const r = await sandboxCanary({ ...bad, runner: async (a) => { ran = true; return runnerThat()(a); } });
  check(r.ok === false && /settings invalid/.test(r.why) && !ran, "a block the validator refuses never launches a canary", r.why);
}

// ── the Read-tool boundary (separate from the OS sandbox) ────────────────────
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ readTool: "leak" }) });
  check(r.ok === false && /Read tool returned a file/.test(r.why), "the Read tool returning the decoy's sentinel fails it", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ readTool: "not-denied" }) });
  check(r.ok === false && /without a denial in the event stream/.test(r.why), "an attempted Read with no denial in the stream fails it", r.why);
}
{
  // The stream is authoritative: a worker that writes DENIED to the file but the
  // stream shows a Read that returned the sentinel is a LEAK, not a pass.
  const liar = async ({ cwd, outPath }) => {
    writeFileSync(join(cwd, "INSIDE"), ""); writeFileSync(join(base.tmpDir, "TMP"), "");
    writeFileSync(join(cwd, "canary-results.txt"), "inside=0\ntmp=0\noutside=1\ncurl=56\ndecoy=1\nsymlink=1\n");
    writeFileSync(join(cwd, "read-tool-out"), "DENIED");   // the model's self-report says denied
    writeFileSync(outPath, JSON.stringify({ type:"assistant", message:{ content:[{ type:"tool_use", name:"Read", id:"r1", input:{ file_path: base.decoyPath } }] } }) + "\n" +
                          JSON.stringify({ type:"user", message:{ content:[{ type:"tool_result", tool_use_id:"r1", content: CANARY_SENTINEL + " leaked" }] } }) + "\n");
    return { outcome: "ok", why: "completed" };
  };
  const r = await sandboxCanary({ ...base, runner: liar });
  check(r.ok === false && /Read tool returned a file/.test(r.why), "the event stream overrides a self-reported DENIED when the stream shows a leak", r.why);
}
{
  const r = await sandboxCanary({ ...base, runner: runnerThat({ readTool: "absent" }) });
  check(r.ok === false && /did not attempt the Read-tool probe/.test(r.why), "no attempted Read in the stream is a failure, not a pass", r.why);
}

// ── the network positive control ─────────────────────────────────────────────
{
  const r = await sandboxCanary({ ...base, netReachable: () => false, runner: runnerThat() });
  check(r.ok === false && /network denial unproven/.test(r.why) && /offline/.test(r.why), "a failed curl while the host is offline is inconclusive, not a pass", r.why);
}
{
  const r = await sandboxCanary({ ...base, netReachable: () => null, runner: runnerThat() });
  check(r.ok === false && /network denial unproven/.test(r.why) && /unknown/.test(r.why), "and unknown reachability is inconclusive too", r.why);
}
{
  const r = await sandboxCanary({ ...base, netReachable: () => { throw new Error("boom"); }, runner: runnerThat() });
  check(r.ok === false && /network denial unproven/.test(r.why), "a throwing reachability control is unknown, never a pass", r.why);
}

// ── the binary identity is part of the id ────────────────────────────────────
{
  const a = canaryIdFor({ cliVersion: "1", sandbox: block.sandbox, binaryId: "/x@1" });
  const b = canaryIdFor({ cliVersion: "1", sandbox: block.sandbox, binaryId: "/x@2" });
  check(a !== b, "a swapped binary (same version) is a different id", `${a} ${b}`);
  const r = await sandboxCanary({ ...base, binaryId: "/x@1", runner: runnerThat() });
  check(r.id === canaryIdFor({ cliVersion: base.cliVersion, sandbox: base.sandbox, binaryId: "/x@1" }), "and the canary carries the binary-aware id");
}

// ── the decoy must survive the probe ─────────────────────────────────────────
{
  const r = await sandboxCanary({ ...base, runner: async ({ cwd }) => {
    writeFileSync(join(cwd, "INSIDE"), ""); writeFileSync(join(base.tmpDir, "TMP"), "");
    writeFileSync(join(cwd, "canary-results.txt"), "inside=0\ntmp=0\noutside=1\ncurl=56\ndecoy=1\nsymlink=1\n");
    writeFileSync(join(cwd, "read-tool-out"), "DENIED");
    rmSync(base.decoyPath, { force: true });   // a concurrent daemon deleted the shared decoy
    return { outcome: "ok", why: "completed" };
  } });
  check(r.ok === false && /decoy vanished/.test(r.why), "a decoy deleted during the probe makes the read-denial unproven", r.why);
}

// ── the state path keeps owner and repo distinct ─────────────────────────────
{
  const a = canaryStatePath("/s", "foo-bar/baz");
  const b = canaryStatePath("/s", "foo/bar-baz");
  check(a !== b, "foo-bar/baz and foo/bar-baz do not collide", `${a} vs ${b}`);
}

// ── state for the doctor ──────────────────────────────────────────────────────
{
  const stateDir = join(root, "state");
  const p = writeCanaryState(stateDir, "o/r", { id: "abc", ok: true, at: 1 });
  check(existsSync(p) && readCanaryState(stateDir, "o/r")?.id === "abc", "the last canary result is persisted and read back", p);
  check(readCanaryState(stateDir, "o/none") === null, "and an absent state reads as null, never as a pass");
  writeFileSync(p, "{ not json");
  check(readCanaryState(stateDir, "o/r") === null, "a corrupt state reads as null");
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
