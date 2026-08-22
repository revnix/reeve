// checkout — a worker's own copy of the repository, sharing nothing.
//
// Until now a worker was given a LINKED worktree: its own working directory, but
// the clone's `.git` underneath it. That is one directory away from the founder's
// checkout and it shares two things that turned out to matter:
//
//   · the ref store — a worker could move any branch of the clone, including
//     main, with no network and no credential;
//   · the configuration — a worker could write `core.fsmonitor` or a
//     `filter.<name>.clean` entry, and the daemon's own `git status` would then
//     run that program, unsandboxed, as the daemon user.
//
// Both were closed by detection (a config fingerprint, refusing to run git in a
// checkout whose config moved). This closes them by CONSTRUCTION: a standalone
// clone has its own refs and its own config, so there is nothing shared to move
// or to poison. Detection stays as the second layer.
//
// Measured on nextlyhq/nextly, 2026-08-22, APFS:
//
//   git clone --no-hardlinks   2.4s   251 MB   own .git, committed content only
//   cp -Rc node_modules       15.2s    31 MB   copy-on-write, 1.2 GB apparent
//
// The clone deliberately carries only COMMITTED content: a `cp` of the founder's
// checkout would hand the worker their uncommitted work and every ignored file
// (a `.env` among them). That keeps those files OUT of the worker's checkout,
// which is not the same as keeping them out of its reach: measured 2026-08-22,
// the sandbox denies writes outside the checkout but not reads, so a worker
// could read them where they still live. The founder's clone is therefore
// deny-read in the worker's policy too (sandbox.mjs, sourceCheckoutOf), and the
// claim rests on both facts rather than on this one.
//
// Dependencies are the one thing a fresh clone lacks and a fixer cannot live
// without — the network is denied, so it cannot install them — and they are
// supplied by a copy-on-write clone of the directory the founder already has,
// which costs almost nothing because unmodified blocks are shared. The DAEMON
// copies them before the worker starts, so denying the source costs the worker
// nothing: measured on nextlyhq/nextly, every symlink in its node_modules is
// relative and resolves inside the tree, so the copy resolves within the run
// checkout.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT_NEUTRALISE, REFUSING_HOOK, recordConfig, reason } from "./gitguard.mjs";
import { writeFileSync, chmodSync } from "node:fs";

/** Every daemon git command in a worker-controlled directory carries the neutralisers. */
function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...GIT_NEUTRALISE, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  // `reason` picks git's own fatal line rather than the last thing it printed,
  // which is usually progress narration and sends the reader somewhere else.
  } catch (e) { return { ok: false, out: "", err: reason(e.stderr || e.message) }; }
}

/** The conventional directory for one run's checkout. Keyed by run, not by PR:
 * two runs for the same pull request must never share a directory. */
export const runPathFor = (root, pr, runId) => join(root, `run-${pr}-${runId}`);

/**
 * The dependency trees a fresh clone lacks, per language.
 *
 * IN-TREE paths only. A worker has no network and a scratch HOME, so a language
 * whose dependencies live under the home directory (Go's module cache, cargo's
 * registry, a pip cache) has nothing here to copy and its checks cannot resolve
 * anything. That is a real limit and it is REPORTED rather than hidden: naming
 * only node_modules and saying nothing left a fixer unable to run the tests it
 * was dispatched to fix, with no line anywhere saying why. (Codex #5-[5].)
 */
const DEPENDENCY_PATHS = {
  typescript: ["node_modules"],
  javascript: ["node_modules"],
  python: [".venv"],
};
const HOME_CACHED = { go: "~/go/pkg/mod", rust: "~/.cargo" };

/**
 * What to copy into a run checkout for this profile, and what cannot be copied.
 *
 * `worker.dependencyPaths` overrides the table entirely, for a project whose
 * dependencies live somewhere this does not know about.
 */
export function dependencyPathsFor(profile) {
  const declared = profile?.worker?.dependencyPaths;
  if (Array.isArray(declared)) return { paths: declared.filter(p => typeof p === "string" && p.length), unsupported: [] };
  const paths = new Set(), unsupported = new Set();
  for (const u of profile?.units ?? []) {
    const lang = String(u.language ?? "").toLowerCase();
    for (const d of DEPENDENCY_PATHS[lang] ?? []) paths.add(u.root && u.root !== "." ? join(u.root, d) : d);
    if (!DEPENDENCY_PATHS[lang] && HOME_CACHED[lang]) unsupported.add(`${lang} (${HOME_CACHED[lang]})`);
  }
  return { paths: [...paths], unsupported: [...unsupported] };
}

/**
 * Can this filesystem clone files copy-on-write?
 *
 * `cp -c` fails on anything but APFS (and cross-volume), which is a fact about
 * the host, not an error: the caller falls back to a plain copy and pays the
 * space. Measured once per process against the directory that will actually be
 * copied, because the answer is per-volume.
 */
export function canCloneFiles(nearPath) {
  const probe = join(nearPath, `.reeve-cow-probe-${process.pid}`);
  const copy = `${probe}.copy`;
  try {
    writeFileSync(probe, "probe\n");
    execFileSync("cp", ["-c", probe, copy], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch { return false; }
  finally { rmSync(probe, { force: true }); rmSync(copy, { force: true }); }
}

/**
 * Copy a dependency tree into the run's checkout, sharing blocks where the
 * filesystem allows it. Returns `{ ok, why, cow }`; `cow` says whether the cheap
 * path was taken, so the caller can report honestly rather than assume.
 */
export function copyDeps(from, to, { cow = null } = {}) {
  if (!existsSync(from)) return { ok: true, why: "nothing to copy", cow: false, skipped: true };
  const useCow = cow ?? canCloneFiles(from.replace(/\/[^/]+$/, "") || "/tmp");
  const args = useCow ? ["-Rc", from, to] : ["-R", from, to];
  try {
    execFileSync("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, why: null, cow: useCow };
  } catch (e) {
    // A failed copy-on-write copy is retried as a plain one: the host may be
    // APFS while this particular pair of paths crosses volumes.
    if (!useCow) return { ok: false, why: `could not copy dependencies: ${String(e.stderr || e.message).trim()}`, cow: false };
    try { execFileSync("cp", ["-R", from, to], { stdio: ["ignore", "ignore", "pipe"] }); return { ok: true, why: null, cow: false }; }
    catch (e2) { return { ok: false, why: `could not copy dependencies: ${String(e2.stderr || e2.message).trim()}`, cow: false }; }
  }
}

/**
 * A standalone checkout for one run.
 *
 * `head` is the revision reeve pinned when it decided. The clone is made from
 * the founder's local checkout (fast, and no credential is needed) but it is
 * VERIFIED against that revision: a local clone can only be as current as the
 * last fetch, and a worker sent to fix a pull request must stand on the commit
 * the decision was made about, not on whatever the checkout happened to hold.
 */
export function prepareRunCheckout({ repoRoot, root, pr, runId, branch, head = null, depsFrom = null, cow = null }) {
  const path = runPathFor(root, pr, runId);
  if (existsSync(path)) return { ok: false, path, why: `a checkout already exists at ${path}` };
  mkdirSync(root, { recursive: true });

  // Fetch first, so the clone can see a head the local checkout has not yet
  // heard of. A clone of a stale checkout is the wrong code, silently.
  //
  // With an EXPLICIT refspec, because the remote-tracking ref is what the clone
  // below reads and a bare `git fetch origin <branch>` only updates it when the
  // remote carries the conventional refspec. Naming it makes the guarantee this
  // depends on the one git is actually given.
  const fetched = git(repoRoot, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (!fetched.ok) return { ok: false, path: null, why: `could not fetch ${branch}: ${fetched.err}` };

  // NOT `--branch <branch>`. A pull request's branch lives in the founder's clone
  // as `origin/<branch>` and not as a local `refs/heads/<branch>` unless a human
  // happened to check it out, and `git clone --branch` asks the source for a
  // local head -- so every ordinary dispatch failed here with "Remote branch not
  // found in upstream origin". Every fixture had created the branch locally
  // first, which is why nothing caught it. (Codex #5-[1].)
  const cloned = git(repoRoot, ["clone", "--no-hardlinks", "-q", repoRoot, path]);
  if (!cloned.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not clone: ${cloned.err}` }; }

  // The remote-tracking ref by its full name, into a local branch of the same
  // name. `git clone` copies the source's `refs/heads/*` into the clone's
  // remote-tracking refs, so the PR branch is not among them and has to be
  // asked for by the name the source really holds it under.
  const branched = git(path, ["fetch", "--no-tags", "-q", repoRoot, `+refs/remotes/origin/${branch}:refs/heads/${branch}`]);
  if (!branched.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not bring ${branch} into the checkout: ${branched.err}` }; }
  const onBranch = git(path, ["checkout", "-q", branch]);
  if (!onBranch.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not check out ${branch}: ${onBranch.err}` }; }

  // The clone followed the local branch, which may lag the revision reeve
  // pinned; move it onto that revision explicitly and check it landed.
  if (head) {
    const at = git(path, ["reset", "--hard", "-q", head]);
    if (!at.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `could not stand on ${head.slice(0, 10)}: ${at.err}` }; }
    const now = git(path, ["rev-parse", "HEAD"]);
    if (!now.ok || now.out !== head) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: `checkout is at ${now.out || "?"}, not the pinned ${head.slice(0, 10)}` }; }
  }

  const h = hardenClone(path);
  if (!h.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: h.why }; }

  // `depsFrom` is a list of paths RELATIVE to the founder's checkout, copied to
  // the same place in the run's. A tree that is not there is not an error: a
  // project simply may not have one.
  let deps = { ok: true, cow: false, skipped: true, copied: [], why: "no dependency source given" };
  if (depsFrom?.length) {
    const copied = [];
    let anyCow = false;
    for (const rel of depsFrom) {
      const from = join(repoRoot, rel), to = join(path, rel);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(to), { recursive: true });
      const one = copyDeps(from, to, { cow });
      if (!one.ok) { rmSync(path, { recursive: true, force: true }); return { ok: false, path: null, why: one.why }; }
      if (!one.skipped) { copied.push(rel); anyCow = anyCow || one.cow; }
    }
    deps = { ok: true, cow: anyCow, skipped: copied.length === 0, copied, why: null };
  }

  return { ok: true, path, why: null, deps };
}

/**
 * The same two physical layers a linked worktree carried, applied to a clone:
 * a push URL git cannot resolve, and a hook that refuses every push. They are
 * belt and braces here rather than the boundary — the clone shares nothing, and
 * the OS sandbox denies the network — but a layer that costs nothing to keep is
 * kept.
 */
function hardenClone(path) {
  const pu = git(path, ["config", "--local", "remote.origin.pushurl", "reeve://refused-the-worker-does-not-publish"]);
  if (!pu.ok) return { ok: false, why: `pushurl: ${pu.err}` };
  const hooks = `${path}.hooks`;
  try {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), REFUSING_HOOK);
    chmodSync(join(hooks, "pre-push"), 0o755);
  } catch (e) { return { ok: false, why: `could not write the refusing hook: ${e.message}` }; }
  const hp = git(path, ["config", "--local", "core.hooksPath", hooks]);
  if (!hp.ok) return { ok: false, why: `hooksPath: ${hp.err}` };

  // Read back rather than trust the writes, and only then record the baseline
  // the config check compares against.
  const readPu = git(path, ["config", "--local", "remote.origin.pushurl"]);
  const readHp = git(path, ["config", "--local", "core.hooksPath"]);
  if (!readPu.ok || readPu.out !== "reeve://refused-the-worker-does-not-publish") return { ok: false, why: "pushurl did not read back" };
  if (!readHp.ok || readHp.out !== hooks || !existsSync(join(hooks, "pre-push"))) return { ok: false, why: "hooksPath or hook did not read back" };
  if ((statSync(join(hooks, "pre-push")).mode & 0o111) === 0) return { ok: false, why: "the hook is not executable" };
  if (!recordConfig(path)) return { ok: false, why: "the checkout's git configuration could not be recorded" };
  return { ok: true, why: null };
}

/**
 * Take the worker's commits OUT of its checkout without running git inside it.
 *
 * The clone is disposable, so nothing there is worth preserving — but the work
 * is, and it only exists in the clone. reeve FETCHES it into its own checkout
 * (a fetch reads the other repository's objects; it runs no hook and no filter
 * of theirs) and publishes from there, exactly as before: the worker is never
 * the party that publishes.
 */
export function fetchRunWork({ repoRoot, path, branch, into = null }) {
  const ref = into ?? `refs/reeve/run/${branch}`;
  const f = git(repoRoot, ["fetch", "--no-tags", "-q", path, `+${branch}:${ref}`]);
  if (!f.ok) return { ok: false, ref: null, why: `could not fetch the worker's branch: ${f.err}` };
  const at = git(repoRoot, ["rev-parse", ref]);
  if (!at.ok) return { ok: false, ref: null, why: `fetched but ${ref} does not resolve` };
  return { ok: true, ref, head: at.out, why: null };
}

/**
 * Publish the worker's work, from REEVE's checkout, never the worker's.
 *
 * The commits exist only in the run's clone, so they are fetched into reeve's
 * own repository first (a fetch reads the other repository's objects and runs
 * none of its hooks or filters) and pushed from there. The separation the
 * linked worktree gave by sharing a ref store is kept by moving the objects
 * explicitly: the worker still holds no credential and still cannot push.
 */
export function publishRunWork({ repoRoot, path, branch, expectedRemote = null }) {
  if (expectedRemote) {
    const ls = git(repoRoot, ["ls-remote", "origin", `refs/heads/${branch}`]);
    if (!ls.ok) return { ok: false, why: `could not read the remote head: ${ls.err}` };
    const now = ls.out.split(/\s+/)[0] ?? "";
    if (now && now !== expectedRemote)
      return { ok: false, why: `the remote moved while the worker ran: expected ${expectedRemote.slice(0, 10)}, found ${now.slice(0, 10)}` };
  }
  const fetched = fetchRunWork({ repoRoot, path, branch });
  if (!fetched.ok) return { ok: false, why: fetched.why };
  // A push of a ref that already equals the remote head succeeds and moves
  // nothing. Reporting that as a publish is how "published 3 file(s)" gets
  // logged for a worker that committed nothing at all.
  if (expectedRemote && fetched.head === expectedRemote)
    return { ok: false, why: "the worker committed nothing: the branch is exactly where it was" };
  // Never force: a worker's fix is not worth another party's commit.
  const pushed = git(repoRoot, ["push", "origin", `${fetched.ref}:refs/heads/${branch}`]);
  if (!pushed.ok) return { ok: false, why: `push refused: ${pushed.err}` };
  return { ok: true, why: null, head: fetched.head };
}

/**
 * Remove a run's checkout. A standalone clone holds nothing reeve has not
 * already fetched, so this is a deletion rather than the worktree reaper's
 * careful quarantine — but it refuses when the caller has not confirmed the
 * work was taken out, so a deletion can never be the thing that loses it.
 */
export function releaseRunCheckout(path, { workFetched = false, quarantineRoot = null } = {}) {
  if (!existsSync(path)) return { ok: true, why: "already gone", quarantined: false };
  if (!workFetched) {
    const q = quarantineRoot ?? `${path}.unfetched`;
    try { execFileSync("mv", [path, q]); return { ok: true, why: "kept: the worker's commits were never fetched", quarantined: true, path: q }; }
    catch (e) { return { ok: false, why: `could not preserve the checkout: ${e.message}`, quarantined: false }; }
  }
  rmSync(path, { recursive: true, force: true });
  rmSync(`${path}.hooks`, { recursive: true, force: true });
  rmSync(`${path}.cfg`, { force: true });
  return { ok: true, why: null, quarantined: false };
}
