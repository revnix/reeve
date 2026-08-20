// Where a worker runs is decided by identity.worktreeRoot, and every profile
// written so far set it RELATIVELY ("../nextly-worktrees"). A relative path is
// meaningless to a daemon: launchd starts it in WorkingDirectory, so
// "../nextly-worktrees" resolved to a directory that does not exist, while the
// real one lives under nextly-workspace/. With --execute on, every dispatch
// would have failed with a raw ENOENT from spawn.
//
// Worse is the fallback. `?? process.cwd()` meant that with no worktreeRoot at
// all, a worker sent to fix a nextly pull request would have run inside the
// reeve checkout -- the same defect shape as the launchd agent watching the
// wrong repository, and fail-OPEN rather than fail-closed.
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { resolveWorktree } from "../src/daemon.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const real = mkdtempSync(join(tmpdir(), "reeve-wt-"));

const base = {
  schemaVersion: 1,
  project: { kind: "product" },
  identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
  state: { mode: "in-repo" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
            commands: { test: { cmd: "pnpm test", state: "present" } } }],
  ci: { provider: "github-actions", requiredChecks: [] },
  merge: { method: "squash", enforcement: "enforced" },
};
const withRoot = v => { const p = structuredClone(base); p.identity.worktreeRoot = v; return p; };

// --- the schema -------------------------------------------------------------
{
  const r = validate(withDefaults(withRoot(real)));
  check(r.ok, "control: an absolute worktreeRoot validates", r.errors?.join(" | "));
}
{
  const r = validate(withDefaults(withRoot("../nextly-worktrees")));
  const hit = !r.ok && r.errors.some(e => /worktreeRoot.*absolute/i.test(e));
  check(hit, "a relative worktreeRoot is refused",
    r.ok ? "it PASSED" : r.errors.join(" | "));
}
{
  // Absent is allowed by the schema; the refusal to dispatch happens below.
  const r = validate(withDefaults(structuredClone(base)));
  check(r.ok, "an absent worktreeRoot still validates", r.errors?.join(" | "));
}

// --- the dispatch-time resolution -------------------------------------------
{
  const r = resolveWorktree({}, withRoot(real), { pr: 1 });
  check(r.path === real, "control: an existing absolute root resolves to itself", JSON.stringify(r));
}
{
  const r = resolveWorktree({}, structuredClone(base), { pr: 1 });
  check(r.path === null && /worktreeRoot/.test(r.why ?? ""),
    "no worktreeRoot refuses rather than falling back to the daemon's cwd", JSON.stringify(r));
}
{
  const r = resolveWorktree({}, withRoot("../nextly-worktrees"), { pr: 1 });
  check(r.path === null && /relative/i.test(r.why ?? ""), "a relative root refuses", JSON.stringify(r));
}
{
  const r = resolveWorktree({}, withRoot(join(real, "nope")), { pr: 1 });
  check(r.path === null && /exist/i.test(r.why ?? ""), "a root that does not exist refuses", JSON.stringify(r));
}
{
  // An explicit per-PR override still wins, because that is how the worktree
  // lifecycle will hand a dedicated directory to each worker.
  const r = resolveWorktree({ worktreeFor: () => real }, structuredClone(base), { pr: 1 });
  check(r.path === real, "an explicit per-PR worktree overrides the profile", JSON.stringify(r));
}

rmSync(real, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
