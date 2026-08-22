// Closed is a conclusion. Every input that is missing, unmeasured or failed
// leaves the credential read OPEN, and only a passing canary together with an
// empty keychain (of GitHub items) closes it.
import { probeKeychain, measureContainment, revalidateContainment, GITHUB_KEYCHAIN_ITEMS } from "../src/containment.mjs";
import { readCanaryState } from "../src/canary.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── the keychain probe ───────────────────────────────────────────────────────
const execWith = table => (cmd, args) => {
  const key = args[0] + " " + args[2];
  const status = table[key];
  if (status === undefined) throw new Error("unexpected probe " + key);
  return { status, stdout: "", stderr: status === 0 ? "" : "The specified item could not be found in the keychain." };
};
{
  const r = probeKeychain({ platform: "darwin", exec: execWith({ "find-internet-password github.com": 44, "find-generic-password gh:github.com": 44 }) });
  check(r.measured && r.items.length === 0 && r.why === null, "no items: measured, empty", JSON.stringify(r));
}
{
  const r = probeKeychain({ platform: "darwin", exec: execWith({ "find-internet-password github.com": 0, "find-generic-password gh:github.com": 0 }) });
  check(r.measured && r.items.length === 2 && /git credential-osxkeychain/.test(r.why) && /gh keyring/.test(r.why), "both items found, each named", JSON.stringify(r));
}
{
  const r = probeKeychain({ platform: "darwin", exec: execWith({ "find-internet-password github.com": 44, "find-generic-password gh:github.com": 0 }) });
  check(r.measured && r.items.length === 1 && /gh keyring/.test(r.items[0]), "one item found", JSON.stringify(r));
}
{
  const r = probeKeychain({ platform: "darwin", exec: execWith({ "find-internet-password github.com": 1, "find-generic-password gh:github.com": 44 }) });
  check(r.measured === false && /exited 1/.test(r.why), "an exit that is neither found nor not-found is unmeasured, never empty", JSON.stringify(r));
}
{
  const r = probeKeychain({ platform: "darwin", exec: () => ({ error: new Error("ENOENT"), status: null }) });
  check(r.measured === false && /could not run/.test(r.why), "a security binary that cannot run is unmeasured", JSON.stringify(r));
}
{
  const r = probeKeychain({ platform: "linux", exec: () => { throw new Error("must not be called"); } });
  check(r.measured === false && /only measured on macOS/.test(r.why), "off macOS the probe does not run and is unmeasured", JSON.stringify(r));
}
{
  // The probe never asks for the secret: no -g, no -w, no -a.
  check(GITHUB_KEYCHAIN_ITEMS.every(i => !i.args.includes("-w") && !i.args.includes("-g")), "the probe asks for metadata only", JSON.stringify(GITHUB_KEYCHAIN_ITEMS.map(i => i.args)));
}

// ── the verdict ─────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "reeve-containment-"));
const sandbox = { enabled: true, filesystem: { denyRead: ["~/.reeve"], allowWrite: ["/t"], allowRead: ["/t"] }, network: { allowedDomains: [] } };
const pass = { ok: true, id: "id1", why: null, evidence: {} };
const flunk = { ok: false, id: "id1", why: "wrote outside the worktree", evidence: {} };
const clean = { measured: true, items: [], why: null };
const dirty = { measured: true, items: ["generic password gh:github.com (gh keyring)"], why: "the login keychain holds: generic password gh:github.com (gh keyring)" };
const base = { cliVersion: "2.1.237", sandbox, permissionsDeny: [], canaryPaths: {}, bin: "/bin/sh", env: {}, stateDir: root, nwo: "o/r", platform: "darwin", isolated: true };
{
  const r = await measureContainment({ ...base, canary: pass, keychain: clean });
  check(r.credentialRead === "closed" && /passed/.test(r.why), "passing canary + empty keychain: closed", r.why);
}
{
  const r = await measureContainment({ ...base, canary: pass, keychain: dirty });
  check(r.credentialRead === "open" && /gh keyring/.test(r.why), "a GitHub item in the keychain keeps it open whatever the canary said", r.why);
}
{
  const r = await measureContainment({ ...base, isolated: false, canary: pass, keychain: clean });
  check(r.credentialRead === "open" && /no isolated worker/.test(r.why), "without a declared isolated worker, a passing canary and an empty keychain do NOT close it", r.why);
}
{
  const r = await measureContainment({ ...base, canary: flunk, keychain: clean });
  check(r.credentialRead === "open" && /canary .*failed: wrote outside/.test(r.why), "a failed canary keeps it open whatever the keychain said", r.why);
}
{
  const r = await measureContainment({ ...base, canary: pass, keychain: { measured: false, items: [], why: "security exited 1" } });
  check(r.credentialRead === "open" && /keychain unmeasured/.test(r.why), "an unmeasured keychain is open, not empty", r.why);
}
{
  const r = await measureContainment({ ...base, canary: pass, keychain: clean, platform: "linux" });
  check(r.credentialRead === "open" && /unmeasured on linux/.test(r.why), "an unmeasured platform is open even with both probes green", r.why);
}
{
  const r = await measureContainment({ ...base, cliVersion: null, canary: null, keychain: clean });
  check(r.credentialRead === "open" && /no CLI version/.test(r.why), "no CLI version: no canary can run, so open", r.why);
}
{
  // A canary FUNCTION is run, cached under its id while it passes, and its
  // result persisted for the doctor.
  let runs = 0;
  const cache = new Map();
  const fn = async () => { runs++; return { ...pass, id: "computed" }; };
  const r1 = await measureContainment({ ...base, canary: fn, keychain: clean, cache });
  const r2 = await measureContainment({ ...base, canary: fn, keychain: clean, cache });
  check(r1.credentialRead === "closed" && r2.credentialRead === "closed" && runs === 1, "a passing canary is measured once per id and reused", `runs=${runs}`);
  const state = readCanaryState(root, "o/r");
  check(state?.ok === true && state?.cliVersion === "2.1.237" && typeof state?.at === "number", "the result is persisted for the doctor", JSON.stringify(state));
  // A different CLI version is a different id: measured again.
  await measureContainment({ ...base, cliVersion: "9.9.9", canary: fn, keychain: clean, cache });
  check(runs === 2, "a new CLI version runs a new canary", `runs=${runs}`);
}
{
  // A FAILED canary is not cached: the next ask measures again.
  let runs = 0;
  const cache = new Map();
  const fn = async () => { runs++; return runs === 1 ? { ...flunk } : { ...pass }; };
  const r1 = await measureContainment({ ...base, canary: fn, keychain: clean, cache });
  const r2 = await measureContainment({ ...base, canary: fn, keychain: clean, cache });
  check(r1.credentialRead === "open" && r2.credentialRead === "closed" && runs === 2, "a failure is re-measured on the next ask; a later pass closes", `runs=${runs} r1=${r1.credentialRead} r2=${r2.credentialRead}`);
  const state = readCanaryState(root, "o/r");
  check(state?.ok === true, "and the persisted state follows the latest measurement", JSON.stringify(state));
}
{
  // The keychain is asked EVERY time: an item added after a closed verdict
  // reopens it on the next ask.
  let asks = 0;
  const kc = async () => { asks++; return asks === 1 ? clean : dirty; };
  const cache = new Map();
  const r1 = await measureContainment({ ...base, canary: pass, keychain: kc, cache });
  const r2 = await measureContainment({ ...base, canary: pass, keychain: kc, cache });
  check(r1.credentialRead === "closed" && r2.credentialRead === "open", "the keychain is re-probed on every ask", `${r1.credentialRead} -> ${r2.credentialRead}`);
}

// ── the cache key follows the canary's own normalisation ─────────────────────
//
// The canary normalises denies rooted at its per-invocation directory. If the
// CACHE key is computed without that, it changes every tick, never hits, and
// every wanted task pays another five-minute model canary.
{
  let runs = 0;
  const cache = new Map();
  const quarantined = dir => ({ ...sandbox, filesystem: { ...sandbox.filesystem, denyRead: ["~/.reeve", dir + "/secrets"] } });
  const fn = async () => { runs++; return { ok: true, id: "computed", why: null, evidence: {} }; };
  for (const dir of ["/wt/inv-a/run", "/wt/inv-b/run"]) {
    await measureContainment({ ...base, sandbox: quarantined(dir), canaryPaths: { dir }, canary: fn, keychain: clean, cache });
  }
  check(runs === 1, "two invocations with the same policy share one cache entry", `runs=${runs}`);
}

// ── the paid canary is skipped when a cheaper reason already opens it ─────────
{
  let ran = 0;
  const fn = async () => { ran++; return { ...pass, id: "computed" }; };
  // isolated:false is a cheap reason; the canary FUNCTION must not be called.
  const r = await measureContainment({ ...base, isolated: false, canary: fn, keychain: clean });
  check(r.credentialRead === "open" && ran === 0, "an already-open verdict does not spend a canary run", `ran=${ran}`);
  // With every cheap prerequisite met, the canary runs.
  const r2 = await measureContainment({ ...base, isolated: true, canary: fn, keychain: clean });
  check(r2.credentialRead === "closed" && ran === 1, "and it runs once every cheaper gate is clear", `ran=${ran}`);
}

// ── revalidateContainment: the cheap facts, re-checked before a spawn ─────────
{
  const bid = b => "/x@" + b;
  const idOf = bin => bin;   // a fake binaryIdentity: identity is the path itself
  const closed = { credentialRead: "closed", binaryId: "/x@1" };
  check((await revalidateContainment(closed, { bin: "/x@1", binaryIdentity: idOf, keychain: clean })).ok === true, "same binary + clean keychain revalidates ok");
  check((await revalidateContainment(closed, { bin: "/x@2", binaryIdentity: idOf, keychain: clean })).ok === false, "a changed binary identity refuses");
  const r = await revalidateContainment(closed, { bin: "/x@2", binaryIdentity: idOf, keychain: clean });
  check(/CLI binary changed/.test(r.why), "and says the binary changed", r.why);
  const rd = await revalidateContainment(closed, { bin: "/x@1", binaryIdentity: idOf, keychain: dirty });
  check(rd.ok === false && /credential appeared/.test(rd.why), "a credential that appeared refuses", rd.why);
  check((await revalidateContainment(closed, { bin: "/x@1", binaryIdentity: idOf, keychain: { measured: false, items: [], why: "no security" } })).ok === false, "an unmeasurable keychain refuses");
  check((await revalidateContainment({ credentialRead: "open" }, { bin: "/x@1", binaryIdentity: idOf, keychain: clean })).ok === false, "an open verdict is never revalidated as ok");
  // A verdict without a recorded binaryId cannot check the binary, but still checks the keychain.
  check((await revalidateContainment({ credentialRead: "closed" }, { bin: "/x@1", binaryIdentity: idOf, keychain: clean })).ok === true, "a verdict without a binaryId still passes on a clean keychain");
  // An ASYNC keychain injection is the same contract the initial measurement
  // supports; reading a pending Promise refused every eligible worker.
  check((await revalidateContainment(closed, { bin: "/x@1", binaryIdentity: idOf, keychain: async () => clean })).ok === true, "an async keychain probe is awaited, not read as a Promise");
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
