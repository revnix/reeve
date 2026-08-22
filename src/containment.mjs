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
import { sandboxCanary, canaryIdFor, readCanaryState, writeCanaryState } from "./canary.mjs";

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
export async function measureContainment({
  cliVersion, sandbox, permissionsDeny, canaryPaths, bin, env,
  stateDir, nwo, platform = process.platform,
  canary = null, keychain = null, cache = new Map(), now = () => Date.now(),
}) {
  const reasons = [];

  if (platform !== "darwin") reasons.push(`the OS sandbox is unmeasured on ${platform}; only macOS has been measured`);

  const kc = typeof keychain === "function" ? await keychain() : keychain ?? probeKeychain({ platform });
  if (!kc.measured) reasons.push(`keychain unmeasured: ${kc.why}`);
  else if (kc.items.length) reasons.push(kc.why);

  let cn = null;
  const id = cliVersion && sandbox ? canaryIdFor({ cliVersion, sandbox }) : null;
  if (canary && typeof canary !== "function") cn = canary;
  else if (id && cache.get(id)?.ok) cn = cache.get(id);
  else if (!id) cn = { ok: false, id: null, why: "no CLI version or sandbox block to run a canary under" };
  else {
    const run = typeof canary === "function" ? canary : sandboxCanary;
    cn = await run({ cliVersion, sandbox, permissionsDeny, ...canaryPaths, bin, env });
    cn = { ...cn, at: now() };
    cache.set(id, cn);
    if (stateDir && nwo) { try { writeCanaryState(stateDir, nwo, { id: cn.id, cliVersion, ok: cn.ok, why: cn.why, at: cn.at, evidence: cn.evidence ?? null }); } catch { /* the verdict stands without the doctor's copy */ } }
  }
  if (!cn.ok) reasons.push(`sandbox canary ${cn.id ? cn.id + " " : ""}failed: ${cn.why}`);

  return {
    credentialRead: reasons.length ? "open" : "closed",
    why: reasons.length ? reasons.join("; ") : `canary ${cn.id} passed and the keychain holds no GitHub credential`,
    canary: cn, keychain: kc, platform, at: now(),
  };
}

export { readCanaryState };
