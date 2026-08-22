// worktree — where a worker is allowed to stand.
//
// reeve previously checked that a path existed and was absolute, and nothing
// more: not that it was a worktree, not that it belonged to this repository, not
// that it was on the pull request's branch, not that someone had left unsaved
// work in it. A worker would have been dropped into whatever happened to be
// there, and the daemon's default was the directory it was started in.
//
// The release side is ported from the old plugin's reaper. Its four refusals were
// each earned by destroying work at least once, and they are kept verbatim in
// spirit: uncommitted edits are invisible to a naive check; a branch with no
// upstream was never pushed; unpushed commits vanish with the directory; and the
// stash stack is SHARED across every worktree of a clone, so a non-empty stack
// may hold a stranger's work in progress.
//
// On any doubt this quarantines rather than deletes, and it always uses
// `git worktree remove` rather than `rm -rf`, which would leave git's own
// administrative files behind pointing at nothing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) { return { ok: false, out: "", err: reason(String(e.stderr || e.message)) }; }
}

/**
 * The line of git's stderr that says what actually went wrong.
 *
 * git narrates on stderr as it works, so the FIRST line is usually progress, not
 * the failure. Reporting it gave "Preparing worktree (resetting branch …)" as the
 * reason a worktree could not be created, when the real cause two lines down was
 * "cannot force update the branch … used by worktree at /tmp/…". A wrong reason
 * is worse than a vague one: it sends the reader somewhere else entirely.
 */
function reason(stderr) {
  const lines = stderr.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.find(l => /^(fatal|error):/i.test(l)) ?? lines.at(-1) ?? "git failed with no message";
}

/** The conventional directory for one pull request's work. */
export const pathFor = (root, pr) => join(root, `pr-${pr}`);

/**
 * Is this directory a worktree a worker may safely act in?
 *
 * Every answer is "no" unless git says otherwise. `head` is the revision reeve
 * pinned when it decided; the worktree may have ADVANCED past it, because that is
 * what a worker's own commit looks like, but it must still descend from it — a
 * head that does not is a different line of work.
 */
/** The pre-push hook every worktree carries. It refuses unconditionally. */
export const REFUSING_HOOK = "#!/bin/sh\necho 'this checkout does not publish; reeve publishes after the diff gate' >&2\nexit 1\n";

/**
 * Make a worktree PHYSICALLY unable to publish, on creation AND on reuse: a
 * daemon upgraded over a worktree from before the hook existed must not hand
 * that worktree back with only the older layer in place.
 */
function harden(repoRoot, path) {
  try { return hardenOrThrow(repoRoot, path); }
  catch (e) { return { ok: false, why: `could not harden the worktree: ${e.message}` }; }
}

function hardenOrThrow(repoRoot, path) {
  // Make the worktree PHYSICALLY unable to publish, rather than trusting a
  // permission pattern to refuse it.
  //
  // The permission layer matches command prefixes, and git accepts flags BEFORE
  // the subcommand: `git -C <path> push` does not match a `git push` rule. That
  // is not a gap to patch — it is the shape of the mechanism, and any deny
  // written as a subcommand pattern has the same hole. A worker exploited exactly
  // this and published its own fix, bypassing the diff gate entirely.
  //
  // A pushurl git cannot resolve fails the same way whatever the command spells,
  // and reeve pushes from the main checkout where the real URL still lives.
  // `--worktree`, not a plain config write. Worktrees SHARE the clone's config by
  // default, so setting this without it disables push for the main checkout and
  // every other worktree too — which is exactly what happened the first time and
  // broke the test's own setup two cases later.
  const ext = git(repoRoot, ["config", "extensions.worktreeConfig", "true"]);
  if (!ext.ok) throw new Error(`extensions.worktreeConfig: ${ext.err}`);
  const pu = git(path, ["config", "--worktree", "remote.origin.pushurl", "reeve://refused-the-worker-does-not-publish"]);
  if (!pu.ok) throw new Error(`pushurl: ${pu.err}`);

  // Second layer, for the shape the pushurl does not cover: `git push <url>`
  // with an explicit file:// or https:// destination never consults origin's
  // pushurl, and measured from a worktree it succeeded. A worktree-scoped
  // hooks path (the clone's own hooks stay untouched) refuses every push from
  // inside this checkout. The directory is a SIBLING of the worktree, not
  // inside it: inside, it is an untracked path that fails verification and
  // would need an exclude written into the clone's shared git dir. It is a
  // layer, not a boundary: `--no-verify`, `-c core.hooksPath=`, and a worker
  // rewriting the sibling file all walk around it (test/escape.test.mjs
  // records each as known-open). What closes those is the OS sandbox denying
  // writes outside the worktree and the network, which a later stage proves;
  // until then the daemon refuses to dispatch at all (workerenv.mjs CONTAINMENT).
  const hooks = `${path}.hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), REFUSING_HOOK, { mode: 0o755 });
  // `mode` applies only to a NEW file; an existing hook that lost its bit keeps
  // it lost, and git ignores a non-executable hook without failing the push.
  chmodSync(join(hooks, "pre-push"), 0o755);
  const hp = git(path, ["config", "--worktree", "core.hooksPath", hooks]);
  if (!hp.ok) throw new Error(`hooksPath: ${hp.err}`);
  // Read back, never assume: a config write that silently landed elsewhere
  // (a read-only shared config, a missing extension) is exactly the case
  // where a worker would be handed a worktree that can publish.
  const readPu = git(path, ["config", "--worktree", "remote.origin.pushurl"]);
  const readHp = git(path, ["config", "--worktree", "core.hooksPath"]);
  if (!readPu.ok || readPu.out !== "reeve://refused-the-worker-does-not-publish") throw new Error("pushurl did not read back");
  if (!readHp.ok || readHp.out !== hooks || !existsSync(join(hooks, "pre-push"))) throw new Error("hooksPath or hook did not read back");
  if ((statSync(join(hooks, "pre-push")).mode & 0o111) === 0) throw new Error("the hook is not executable");
  return { ok: true, why: null };
}

export function verifyWorktree({ path, branch, head = null }) {
  if (!path || !existsSync(path)) return { ok: false, why: `does not exist: ${path}` };

  // `--git-dir` inside a worktree resolves to .git/worktrees/<name>, while in the
  // main checkout it is plain .git. That difference is the check: a worker must
  // never run in the main clone, where its edits sit on top of whatever a human
  // was doing.
  const gd = git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!gd.ok) return { ok: false, why: `not a git worktree: ${path}` };
  if (!gd.out.includes("/worktrees/")) return { ok: false, why: `this is the main checkout, not a worktree: ${path}` };

  const br = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!br.ok) return { ok: false, why: `could not read the branch in ${path}` };
  if (branch && br.out !== branch) return { ok: false, why: `on branch ${br.out}, expected ${branch}` };

  const dirty = git(path, ["status", "--porcelain"]);
  if (!dirty.ok) return { ok: false, why: `could not read the status of ${path}` };
  if (dirty.out) return { ok: false, why: `uncommitted or unrelated changes present: ${dirty.out.split("\n").length} path(s)` };

  if (head) {
    const at = git(path, ["rev-parse", "HEAD"]);
    if (!at.ok) return { ok: false, why: `could not read HEAD in ${path}` };
    if (at.out !== head) {
      // merge-base --is-ancestor exits 0 when the pin is an ancestor of HEAD.
      const anc = git(path, ["merge-base", "--is-ancestor", head, "HEAD"]);
      if (!anc.ok) return { ok: false, why: `HEAD ${at.out.slice(0, 10)} does not descend from the pinned ${head.slice(0, 10)}` };
    }
  }

  return { ok: true, why: null };
}

/**
 * A verified worktree for this pull request, creating one if needed.
 *
 * Reuses an existing directory only when it verifies. A worktree that fails
 * verification is NOT repaired in place: whatever is in it belongs to someone,
 * and silently resetting it is how unsaved work disappears. It refuses and says
 * what is wrong, so a human decides.
 */
export function acquireWorktree({ repoRoot, root, pr, branch, head = null }) {
  const path = pathFor(root, pr);

  if (existsSync(path)) {
    const v = verifyWorktree({ path, branch, head });
    return v.ok
      ? (h => h.ok ? { ok: true, path, reused: true, why: null } : { ok: false, path, reused: true, why: h.why })(harden(repoRoot, path))
      : { ok: false, path, reused: true, why: `existing worktree unusable: ${v.why}` };
  }

  mkdirSync(root, { recursive: true });

  // Fetch the branch before checking it out. Without this a worktree can be
  // created on a stale local ref that resolves fine and is simply the wrong code.
  const fetched = git(repoRoot, ["fetch", "-q", "origin", branch]);
  if (!fetched.ok) return { ok: false, path: null, why: `could not fetch ${branch}: ${fetched.err}` };

  // A local branch may already exist and be stale, so track the remote ref
  // explicitly rather than relying on whatever the local name currently points at.
  const add = git(repoRoot, ["worktree", "add", "--force", "-B", branch, path, `origin/${branch}`]);
  if (!add.ok) return { ok: false, path: null, why: `could not create the worktree: ${add.err}` };

  const hardened = harden(repoRoot, path);
  if (!hardened.ok) return { ok: false, path, why: hardened.why };

  const v = verifyWorktree({ path, branch, head });
  if (!v.ok) return { ok: false, path, why: `created but did not verify: ${v.why}` };
  return { ok: true, path, reused: false, why: null };
}

/**
 * Give the worktree back, or quarantine it.
 *
 * Every refusal below has cost someone work before. Quarantine moves the
 * directory aside intact rather than deleting it, so the answer to "was there
 * anything in there?" stays answerable.
 */
export function releaseWorktree({ path, pr, quarantineRoot = null }) {
  if (!existsSync(path)) return { ok: true, why: "already gone", quarantined: false };

  // Resolved BEFORE the move: once the directory is gone, git can no longer be
  // asked from inside it where its main checkout is.
  const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoRoot = common.ok ? dirname(common.out) : null;

  const quarantine = () => {
    const q = quarantineRoot ?? join(dirname(path), "_quarantine");
    mkdirSync(q, { recursive: true });
    // Stamped so two quarantines of the same PR cannot collide and overwrite.
    const dest = join(q, `${basename(path)}.${process.hrtime.bigint().toString(36)}`);
    renameSync(path, dest);
    // Moving the directory does not tell git anything. Without this prune, git
    // still believes the branch is checked out at the old path and refuses to
    // create the next worktree for it -- so one quarantine would wedge every
    // later attempt on that branch. Found by the test, not by reading.
    if (repoRoot) git(repoRoot, ["worktree", "prune"]);
    return dest;
  };

  const refuse = why => ({ ok: false, why, quarantined: true, path: quarantine() });

  const dirty = git(path, ["status", "--porcelain"]);
  if (!dirty.ok) return refuse("could not read the worktree's status");
  if (dirty.out) return refuse(`uncommitted changes: ${dirty.out.split("\n").length} path(s)`);

  const upstream = git(path, ["rev-parse", "--abbrev-ref", "@{u}"]);
  if (!upstream.ok) return refuse("no upstream — this branch was never pushed");

  const unpushed = git(path, ["log", "@{u}..", "--oneline"]);
  if (!unpushed.ok) return refuse("could not compare against the upstream");
  if (unpushed.out) return refuse(`unpushed commit(s): ${unpushed.out.split("\n").length}`);

  // The stash stack belongs to the CLONE, not to this worktree, so a non-empty
  // stack may hold work someone left in a different one entirely.
  const stash = git(path, ["stash", "list"]);
  if (!stash.ok) return refuse("could not read the stash stack");
  if (stash.out) return refuse("the stash stack is not empty, and it is shared across every worktree of this clone");

  if (!repoRoot) return refuse("could not locate the main checkout");

  // `git worktree remove`, never rm -rf: the latter leaves administrative files
  // in .git/worktrees pointing at a directory that no longer exists.
  const removed = git(repoRoot, ["worktree", "remove", path]);
  if (!removed.ok) return refuse(`git refused to remove the worktree: ${removed.err}`);
  git(repoRoot, ["worktree", "prune"]);
  // The hook directory is a sibling the worktree's removal does not cover.
  rmSync(`${path}.hooks`, { recursive: true, force: true });
  return { ok: true, why: null, quarantined: false };
}

/**
 * Publish the worker's commits, refusing if the remote moved underneath.
 *
 * A plain push is already compare-and-swap — git refuses a non-fast-forward — and
 * the remote head is checked first so that "someone else pushed while the worker
 * worked" is reported as that, rather than as an opaque rejection. Force is never
 * used: a worker's fix is never worth discarding somebody else's commit.
 */
export function pushWorktree({ path, branch, expectedRemote = null, repoRoot = null }) {
  // From the MAIN checkout: the worktree's pushurl is deliberately unresolvable,
  // so that a worker cannot publish whatever spelling it reaches for. reeve holds
  // the real remote, which is the whole point — the actor and the only claim the
  // action was allowed must not be the same party.
  const from = repoRoot ?? (() => {
    const c = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return c.ok ? dirname(c.out) : null;
  })();
  if (!from) return { ok: false, why: "could not locate the main checkout to publish from" };

  if (expectedRemote) {
    const ls = git(from, ["ls-remote", "origin", `refs/heads/${branch}`]);
    if (!ls.ok) return { ok: false, why: `could not read the remote head: ${ls.err}` };
    const now = ls.out.split(/\s+/)[0] ?? "";
    if (now && now !== expectedRemote)
      return { ok: false, why: `the remote moved while the worker ran: expected ${expectedRemote.slice(0, 10)}, found ${now.slice(0, 10)}` };
  }

  // The worktree's branch by name, read from the main checkout's ref store, which
  // both share. Never force: a worker's fix is not worth another party's commit.
  //
  // `core.hooksPath=/dev/null` on THIS command, so no hook runs during reeve's
  // own publish. A worker in a linked worktree can write `core.hooksPath` into
  // the shared git config; without this, that worker-controlled hook would run
  // here, unsandboxed, as the daemon user. Defense in depth beneath the dispatch
  // gate, which already refuses a worker that is not in its own isolated clone.
  const pushed = git(from, ["-c", "core.hooksPath=/dev/null", "push", "origin", `${branch}:${branch}`]);
  if (!pushed.ok) return { ok: false, why: `push refused: ${pushed.err}` };
  return { ok: true, why: null };
}
