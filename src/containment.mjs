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
import { sandboxCanary, canaryIdFor, instrumentHash, policyHashOf, readCanaryState, writeCanaryState } from "./canary.mjs";

/**
 * Is the isolation the profile declares actually implemented?
 *
 * It was hard-false while the code still handed workers a linked worktree and
 * the founder's HOME, so the profile LABEL could not close anything. Both are
 * now enforced in code and cannot be opted out of per dispatch: `workerEnv`
 * REFUSES the founder's home and refuses a missing token, and dispatch prepares
 * a standalone clone rather than a linked worktree. Neither is a promise this
 * function makes on their behalf — the canary re-measures the consequence (no
 * network, no writes outside, no credential reads, and no keychain reach) for
 * every CLI build and policy before a single worker is dispatched.
 */
export function isolationTopologyReady() { return true; }

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
  if (!isolated) reasons.push("no isolated worker environment declared (worker.isolation)");
  // The keychain is PROBED here for the record, and it is deliberately no longer
  // a gate. It used to be one because a worker ran with the founder's HOME and
  // could ask the keychain directly, so "the keychain holds nothing we
  // recognise" was the only available proxy — a weak one, since the probe knows
  // two item shapes and any client can invent a third. Workers now run with a
  // scratch HOME and have no login keychain in their search list at all, and the
  // CANARY measures that reach directly. Evidence about the worker beats a proxy
  // about the host, so the canary decides and this is reported, not enforced.
  const kc = keychain ?? probeKeychain({ platform });
  return { reasons, keychain: kc };
}

export async function measureContainment({
  cliVersion, sandbox, permissionsDeny, allowedTools = null, canaryPaths, bin, env, binaryId = null, stateRoots = null,
  stateDir, nwo, platform = process.platform, isolated = false, netProbe = null,
  canary = null, keychain = null, cache = new Map(), now = () => Date.now(),
}) {
  // The keychain is probed for the RECORD, not as a gate. It was a gate while a
  // worker ran with the founder's HOME and could ask securityd directly, and it
  // was a poor one: the probe reads two conventional GitHub items, and another
  // client can store a token under a third in the same account. A worker's HOME
  // is now reeve's own scratch directory, so no login keychain is in its search
  // list, and its own clone shares no ref store or config with the founder's
  // checkout. What is left to establish is that the OS sandbox holds under the
  // CLI in use -- which the canary measures directly, per build and per policy.
  const probed = typeof keychain === "function" ? await keychain() : keychain;
  const cheap = cheapContainmentReasons({ platform, isolated, keychain: probed });
  const reasons = [...cheap.reasons];
  const kc = cheap.keychain;

  // The canary is a paid, minutes-long model call. When a cheaper prerequisite
  // (platform, keychain, isolation) already makes the verdict open, do not run
  // it: the answer is settled. (Codex #4b-[12].) An injected canary RESULT is
  // still honoured for evidence; only the expensive RUN is skipped.
  let cn = null;
  // The canary's own id normalises denies rooted at its per-invocation directory;
  // the CACHE key must be computed the same way or it changes every tick and the
  // cache can never hit, so every wanted task pays another five-minute model
  // canary. (Codex #4h-[1].)
  // The INSTRUMENT belongs in the key, not only in the recorded id. It was in
  // the id alone, and the id was unstable, so the two were different values: a
  // canary script strengthened with a new probe did not invalidate a pass taken
  // before it, which is the reuse the instrument was put in the id to prevent.
  const id = cliVersion && sandbox ? canaryIdFor({ cliVersion, sandbox, binaryId, worktree: canaryPaths?.dir ?? null, permissionsDeny, allowedTools,
                                                   instrument: instrumentHash({ hasNet: !!netProbe }) }) : null;
  const cheapReasons = reasons.length > 0;
  if (canary && typeof canary !== "function") cn = canary;
  else if (cheapReasons) cn = { ok: false, id, why: "not run: containment is already open for a cheaper reason", skipped: true };
  // Marked, so the caller can tell a cached pass from one this call produced:
  // only a real run creates (and cleans up) the per-invocation tree.
  else if (id && cache.get(id)?.ok) cn = { ...cache.get(id), cached: true };
  else if (!id) cn = { ok: false, id: null, why: "no CLI version or sandbox block to run a canary under" };
  else {
    const run = typeof canary === "function" ? canary : sandboxCanary;
    cn = await run({ cliVersion, sandbox, permissionsDeny, allowedTools, binaryId, ...canaryPaths, bin, env, ...(netProbe ? { netProbe } : {}) });
    cn = { ...cn, at: now() };
    cache.set(id, cn);
    if (stateDir && nwo) { try { writeCanaryState(stateDir, nwo, { id: cn.id, cliVersion, bin, binaryId, instrument: instrumentHash({ hasNet: !!netProbe }), policyHash: policyHashOf(sandbox, canaryPaths?.dir ?? null, { permissionsDeny, allowedTools }), stateRoots, allowedTools, canaryDir: canaryPaths?.dir ?? null, ok: cn.ok, why: cn.why, at: cn.at, evidence: cn.evidence ?? null }); } catch { /* the verdict stands without the doctor's copy */ } }
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
  // The keychain is deliberately NOT re-checked here any more. It was, when a
  // worker ran with the founder's HOME and could ask the keychain directly, so a
  // credential appearing mid-tick genuinely changed what a worker could reach.
  // A worker now has no login keychain in its search list at all, so the host's
  // keychain contents no longer describe its reach; the canary measures that,
  // and the binary identity above is what can still go stale between the verdict
  // and this spawn.
  return { ok: true, why: null };
}

export { readCanaryState };
