// containment — what this host can actually promise about a worker, measured.
//
// workerenv.mjs declares what the ENVIRONMENT alone can promise (nothing, with
// a real HOME). This module answers the question the daemon asks before any
// dispatch under --execute: is the founder's credential unreachable from a
// worker on THIS host, under THIS CLI, with THIS sandbox block? Two measured
// facts decide it, and both are re-measured rather than remembered:
//
//   · the sandbox canary (canary.mjs): the OS boundary denies network, outside
//     writes and credential-file reads, with positive controls;
//   · the keychain probe (below): no GitHub credential sits in the login
//     keychain. Measured 2026-08-22: the runtime's Seatbelt profile hard-allows
//     securityd, so `git -c credential.helper=osxkeychain credential fill` and
//     `GH_CONFIG_DIR=<anything writable> gh auth token` both return the
//     founder's token INSIDE the sandbox. No setting closes that; only an empty
//     keychain (a dedicated worker user, or gh logged in with
//     --insecure-storage and the git item removed) does.
//
// Anything unmeasured is open. A platform whose sandbox was never measured is
// open. A probe that cannot run is open. Closed is a conclusion, never a default.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { sandboxCanary, canaryIdFor, policyHashOf, readCanaryState, writeCanaryState } from "./canary.mjs";

/**
 * Is the dedicated-user dispatch topology actually in place? A separate OS user
 * (its own empty keychain) and a per-run standalone clone (its own git dir) are
 * PR-3; until they exist, production dispatch still runs a linked worktree as
 * this user, so the profile LABEL worker.isolation="dedicated-user" must not
 * close containment or read OK in the doctor. Hard-false until PR-3 replaces it
 * with a real check (euid differs from the checkout owner; the worktree is a
 * standalone clone). (Codex #4c-[9], #4d-[14].)
 */
export function isolationTopologyReady() { return false; }

/**
 * The identity of an executable: its real path and modification time. A CLI
 * replaced in place keeps its path but not its mtime, so a canary that passed
 * under the old bytes is not credited to the new ones.
 */
export function binaryIdentity(bin) {
  try { const real = realpathSync(bin); const st = statSync(real); return `${real}@${st.mtimeMs}`; }
  catch { return bin; }
}

/**
 * Keychain items that hand a worker the founder's GitHub credential.
 * Metadata only: `security find-*` without `-g`/`-w` prints the item's
 * attributes and never the secret. Exit 0 means the item exists.
 */
export const GITHUB_KEYCHAIN_ITEMS = [
  // git-credential-osxkeychain stores an internet password for the host.
  { kind: "inet", args: ["find-internet-password", "-s", "github.com"], label: "internet password for github.com (git credential-osxkeychain)" },
  // gh stores a generic password under its own service name.
  { kind: "genp", args: ["find-generic-password", "-s", "gh:github.com"], label: "generic password gh:github.com (gh keyring)" },
];

/**
 * Which GitHub credentials the login keychain holds, by metadata.
 * `{ measured, items, why }`: `measured` is false when the probe could not
 * run (not macOS, no `security` binary, a probe that errored), and a probe
 * that could not run never reports an empty keychain.
 */
export function probeKeychain({ platform = process.platform, exec = spawnSync } = {}) {
  if (platform !== "darwin") return { measured: false, items: [], why: `keychain probe is only measured on macOS (this is ${platform})` };
  const items = [];
  for (const it of GITHUB_KEYCHAIN_ITEMS) {
    let r;
    try { r = exec("security", it.args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (err) { return { measured: false, items, why: `security ${it.args[0]} could not run: ${err.message}` }; }
    if (r.error) return { measured: false, items, why: `security ${it.args[0]} could not run: ${r.error.message}` };
    // 0: found. 44 (errSecItemNotFound): absent. Anything else is not an answer.
    if (r.status === 0) items.push(it.label);
    else if (r.status !== 44) return { measured: false, items, why: `security ${it.args[0]} exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}` };
  }
  return { measured: true, items, why: items.length ? `the login keychain holds: ${items.join("; ")}` : null };
}

/**
 * The verdict for a (host, CLI, sandbox block). `canary` may be injected (a
 * result object, or an async function returning one); `keychain` likewise.
 * The canary result is persisted for `reeve doctor`; a cached result is
 * reused only under the same id, and only while it passed: a failure is
 * re-measured every time it is asked for, so a transient failure does not
 * refuse dispatch until a restart.
 */
/**
 * The reasons containment is open that cost nothing to establish: the platform,
 * the keychain, and whether an isolated worker is actually in place. A caller
 * checks these BEFORE preparing a canary (directories, a git config, an env),
 * because on a host where the verdict is already open that preparation is pure
 * litter — a new tmp tree every tick that nothing ever cleans up.
 * (Codex #4e-[9].)
 */
export function cheapContainmentReasons({ platform = process.platform, isolated = false, keychain = null } = {}) {
  const reasons = [];
  if (platform !== "darwin") reasons.push(`the OS sandbox is unmeasured on ${platform}; only macOS has been measured`);
  const kc = keychain ?? probeKeychain({ platform });
  if (!kc.measured) reasons.push(`keychain unmeasured: ${kc.why}`);
  else if (kc.items.length) reasons.push(kc.why);
  if (!isolated) reasons.push("no isolated worker environment declared (worker.isolation): a shared account cannot be certified free of credentials and a linked worktree shares the checkout's git dir");
  return { reasons, keychain: kc };
}

export async function measureContainment({
  cliVersion, sandbox, permissionsDeny, canaryPaths, bin, env, binaryId = null, stateRoots = null,
  stateDir, nwo, platform = process.platform, isolated = false, netProbe = null,
  canary = null, keychain = null, cache = new Map(), now = () => Date.now(),
}) {
  // The keychain probe and the shared-account/linked-worktree topology are why
  // a canary pass is NECESSARY but not SUFFICIENT. The probe reads only the two
  // conventional GitHub items; another client can store a token elsewhere in the
  // SAME account, and a linked worktree shares the founder's git dir (refs AND
  // config), so a closed worker could still plant a hook the daemon later runs.
  // Both are answered by the same thing: an ISOLATED worker (its own OS user
  // with an empty keychain, its own clone), declared in the profile once the
  // founder has set it up. Until then a found credential still hard-fails, but an
  // empty probe never CLOSES on its own.
  const probed = typeof keychain === "function" ? await keychain() : keychain;
  const cheap = cheapContainmentReasons({ platform, isolated, keychain: probed });
  const reasons = [...cheap.reasons];
  const kc = cheap.keychain;

  // The canary is a paid, minutes-long model call. When a cheaper prerequisite
  // (platform, keychain, isolation) already makes the verdict open, do not run
  // it: the answer is settled. (Codex #4b-[12].) An injected canary RESULT is
  // still honoured for evidence; only the expensive RUN is skipped.
  let cn = null;
  const id = cliVersion && sandbox ? canaryIdFor({ cliVersion, sandbox, binaryId }) : null;
  const cheapReasons = reasons.length > 0;
  if (canary && typeof canary !== "function") cn = canary;
  else if (cheapReasons) cn = { ok: false, id, why: "not run: containment is already open for a cheaper reason", skipped: true };
  else if (id && cache.get(id)?.ok) cn = cache.get(id);
  else if (!id) cn = { ok: false, id: null, why: "no CLI version or sandbox block to run a canary under" };
  else {
    const run = typeof canary === "function" ? canary : sandboxCanary;
    cn = await run({ cliVersion, sandbox, permissionsDeny, binaryId, ...canaryPaths, bin, env, ...(netProbe ? { netProbe } : {}) });
    cn = { ...cn, at: now() };
    cache.set(id, cn);
    if (stateDir && nwo) { try { writeCanaryState(stateDir, nwo, { id: cn.id, cliVersion, bin, binaryId, policyHash: policyHashOf(sandbox, canaryPaths?.dir ?? null), stateRoots, canaryDir: canaryPaths?.dir ?? null, ok: cn.ok, why: cn.why, at: cn.at, evidence: cn.evidence ?? null }); } catch { /* the verdict stands without the doctor's copy */ } }
  }
  // A skipped canary adds no reason of its own (the cheaper reasons already stand);
  // a run-or-injected canary that failed does.
  if (!cn.ok && !cn.skipped) reasons.push(`sandbox canary ${cn.id ? cn.id + " " : ""}failed: ${cn.why}`);

  return {
    credentialRead: reasons.length ? "open" : "closed",
    why: reasons.length ? reasons.join("; ") : `canary ${cn.id} passed, an isolated worker is declared, and the keychain holds no GitHub credential`,
    canary: cn, keychain: kc, platform, isolated, binaryId, at: now(),
  };
}

/**
 * Re-check, immediately before a spawn, the two facts a per-tick verdict cannot
 * keep fresh: the CLI binary identity and the keychain. The canary is bound to a
 * binary identity (its id), so a swapped executable must not run under an old
 * pass; and a credential added after the probe must reopen the gate before the
 * next worker, not after the tick. (Codex #4c-[11], #4c-[12].) Cheap: no model
 * call, just a stat and two metadata reads.
 */
export async function revalidateContainment(verdict, { bin, binaryIdentity, keychain = null, platform = process.platform } = {}) {
  if (!verdict || verdict.credentialRead !== "closed") return { ok: false, why: "containment was not closed" };
  const nowId = binaryIdentity(bin);
  if (verdict.binaryId && nowId !== verdict.binaryId)
    return { ok: false, why: `the CLI binary changed since containment was measured (${verdict.binaryId} -> ${nowId}); re-measuring before dispatch` };
  // Awaited: the same injection contract as the initial measurement, where an
  // async probe is legitimate. Reading a pending Promise's `.measured` gave
  // undefined and refused every otherwise-eligible worker. (Codex #4e-[4].)
  const kc = typeof keychain === "function" ? await keychain() : keychain ?? probeKeychain({ platform });
  if (!kc || !kc.measured) return { ok: false, why: `keychain became unmeasurable since the verdict: ${kc?.why ?? "no result"}` };
  if (kc.items.length) return { ok: false, why: `a GitHub credential appeared since the verdict: ${kc.why}` };
  return { ok: true, why: null };
}

export { readCanaryState };
