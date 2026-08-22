# S0 + S1: The Worker Contract, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `claude` worker either daemon launches runs under a fail-closed contract: no ambient credentials, bounded durable output, a durable pid binding, a lease whose loss kills it, an immutable contract snapshot, validated sandbox settings, and (where the host supports it) an OS-enforced sandbox proven by a canary.

**Architecture:** Two PRs against `revnix/reeve` `main`. **PR-1 (S0 + S1 core)** changes `supervisor.mjs`, `daemon.mjs`, `worktree.mjs`, `profile/schema.mjs`, `db/schema.sql`, `db/ops.mjs` and adds `src/workerenv.mjs`: capability switches in FIELDS, the baseline fixture, `workerArgs` hard-fail and new flags, the environment allowlist, durable bounded streams, fail-closed spawn binding, lease revocation, the `worker_run` contract table, and a worktree pre-push hook. **PR-2 (S1 sandbox)** adds the two CLI measurements, the OS-sandbox settings block with pre-spawn validation, the per-daemon-start canary, the doctor subscription-auth probe, and the real non-publishing escape test. The guardian daemon is the first consumer of all of it; the builder (S2 onward) reuses it unchanged.

**Tech Stack:** Node `~/.nvm/versions/node/v24.17.0/bin/node` (PATH node is v22 and must not be used), `node:sqlite`, `node:child_process`, plain-script tests under `test/*.test.mjs` (CI runs every file in that glob, on ubuntu-latest, under three TZs), Claude Code CLI 2.1.237.

**Spec:** `docs/2026-08-21-builder-design.md`, sections §1.4 (switches), §4 (the worker contract, all of it), §11.3 (guardian `worker_run`), §14 S0 and S1, Platforms. The audit that motivated it: `docs/2026-08-21-builder-design-audit.md` P0-4.

## Global Constraints

- Node: always `~/.nvm/versions/node/v24.17.0/bin/node` (alias it `N` in shells). `node` on PATH is v22 and `node:sqlite` warns there.
- Tests: plain scripts, `console.log("PASS  name")` / `FAIL`, `process.exit(fail ? 1 : 0)`; use the `check(ok, name, detail)` helper shape every existing test uses. New files under `test/` are discovered by CI automatically.
- **The four-check stub loop for every fix:** control green, stub verified applied, the RIGHT assertion red, restore verified. Never commit a test that has not been seen red against the broken code.
- Conventional Commits, lowercase, 72 chars, `type(scope): subject`; **no attribution trailer of any kind**; never `--no-verify`.
- Every change carries a what/why comment in the style of the file it lands in; comments never reference tasks, plans, findings, or this document.
- No `as any`, no `@ts-expect-error`; no raw SQL outside `src/db/` (ops.mjs owns SQL).
- No optional parameter may guard a safety rule without its call-site assertion in the same commit (spec §4.8).
- Escalation keys are identities: no counts, durations, or paths in the key; those go in the body.
- Nothing in any public or client repo may name reeve; this PR touches only `revnix/reeve` (private).
- Run the full suite before every commit: `for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done` (expect every file green; 47 today).
- Direct commits to `main` are permitted on this repo (founder grant); push after each task's commit.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/profile/schema.mjs` | FIELDS gains `builder.capabilities.*` (5 booleans), `builder.founder.userId/login`, `worker.maxOutputBytes`; defaults in `UNIVERSAL_DEFAULTS` |
| `src/baseline.mjs` (new) | `diffBaseline(live, fixture)`: pure comparison of live ruleset/profile facts against the checked fixture |
| `test/fixtures/nextly-baseline-2026-08-21.json` (new) | the captured live baseline (ruleset required checks, bypass actors, approval rules, profile authority/merge) |
| `src/supervisor.mjs` | `workerArgs` hard-fails without settings, emits the new flags; `runWorker` takes an exact env, streams to files, fails closed on binding, polls revocation |
| `src/workerenv.mjs` (new) | `workerEnv({...})`: the allowlisted environment; `writeGitConfig(dir)`: the credential-less global git config |
| `src/db/schema.sql` | additive `worker_run` table |
| `src/db/ops.mjs` | `recordWorkerContract`, `noteWorkerModel`, `workerContractFor` |
| `src/daemon.mjs` | heartbeat loss revokes; records the contract; passes env, out/err paths, revocation to `runWorker` |
| `src/worktree.mjs` | worktree-scoped `core.hooksPath` with a refusing `pre-push` |
| `src/sandbox.mjs` (PR-2) | `sandbox.*` block in generated settings; `validateSettings` |
| `src/canary.mjs` (PR-2, new) | `sandboxCanary`: the once-per-contract proof a sandbox actually denies |
| `src/doctor.mjs` (PR-2) | R-13 baseline drift, R-14 subscription-auth probe, R-15 canary |
| `docs/measured/2026-08-2x-claude-print-mode.md` (PR-2, new) | the two CLI measurements, with commands and raw output |

---

# PR-1: S0 + S1 core

### Task 1: Capability switches and worker keys in the profile validator (S0)

**Files:**
- Modify: `src/profile/schema.mjs` (FIELDS block after `"risk.testPaths"`; `UNIVERSAL_DEFAULTS`)
- Test: `test/profile-validate.test.mjs` (append before the tally)

**Interfaces:**
- Produces: profile keys `builder.capabilities.{observe,draftSpec,implementLocal,publishPr,mergeBuilderPr}` (boolean, default `false`), `builder.founder.userId` (integer), `builder.founder.login` (string), `worker.maxOutputBytes` (integer, default `67108864`). Later tasks read `profile.worker.maxOutputBytes`; PR-2's doctor reads `builder.founder.*`.

- [ ] **Step 1: Write the failing tests**

Append to `test/profile-validate.test.mjs`, above the final tally lines:

```js
// ── capability switches: five booleans, every one default false ─────────────
//
// Authority is never inferred from repository fields: the live nextly profile
// already sets authority.policy=propose_and_merge, so that key cannot be the
// switch for anything. These five are, and a truthy accident must not flip one.
{
  const p = clone(base);
  const d = withDefaults(p);
  const caps = d.builder?.capabilities ?? {};
  const all = ["observe", "draftSpec", "implementLocal", "publishPr", "mergeBuilderPr"];
  const allFalse = all.every(k => caps[k] === false);
  console.log(`${allFalse ? "PASS" : "FAIL"}  every capability switch defaults to false`);
  if (!allFalse) { console.log("        got:", JSON.stringify(caps)); fail++; }

  const out = withDefaults(p);
  const ok = out.worker?.maxOutputBytes === 67108864;
  console.log(`${ok ? "PASS" : "FAIL"}  worker.maxOutputBytes defaults to 64 MiB`);
  if (!ok) fail++;
}

expectRefusal("a capability switch that is not a boolean",
  (() => { const p = clone(base); p.builder = { capabilities: { mergeBuilderPr: "yes" } }; return p; })(),
  /builder\.capabilities\.mergeBuilderPr must be a boolean/);

expectRefusal("a founder user id that is not an integer",
  (() => { const p = clone(base); p.builder = { founder: { userId: "123" } }; return p; })(),
  /builder\.founder\.userId must be an integer/);

expectOk("all five switches set explicitly",
  (() => { const p = clone(base); p.builder = { capabilities: { observe: true, draftSpec: false, implementLocal: false, publishPr: false, mergeBuilderPr: false } }; return p; })());
```

- [ ] **Step 2: Run to verify they fail**

Run: `N=~/.nvm/versions/node/v24.17.0/bin/node; cd ~/Work/Products/reeve && $N test/profile-validate.test.mjs 2>&1 | grep -E "^(FAIL|failed)"`
Expected: `FAIL  every capability switch defaults to false`, `FAIL  worker.maxOutputBytes defaults to 64 MiB`, and the two refusals FAIL (the validator currently reports `unknown key: builder.capabilities.mergeBuilderPr`, not the boolean message), `failed=4`.

- [ ] **Step 3: Add the keys and defaults**

In `src/profile/schema.mjs`, inside `FIELDS` immediately after the `"risk.testPaths"` entry:

```js
  // The builder's capability switches. Authority is never inferred from the
  // repository fields above: the live nextly profile already carries
  // authority.policy=propose_and_merge, so that key cannot gate anything new.
  // Five independent booleans, every one false until the rollout stage that
  // proves it turns it on. A truthy string is refused, not coerced.
  "builder.capabilities.observe":        [false, isBool],
  "builder.capabilities.draftSpec":      [false, isBool],
  "builder.capabilities.implementLocal": [false, isBool],
  "builder.capabilities.publishPr":      [false, isBool],
  "builder.capabilities.mergeBuilderPr": [false, isBool],
  // The founder's GitHub identity, by immutable numeric id with the login as a
  // snapshot: every founder-event rule (silence, overrides, approvals) matches
  // the id, and a renamed login must not silently become a stranger.
  "builder.founder.userId":              [false, isInt],
  "builder.founder.login":               [false, isStr],
  // Cap on a worker's durable stdout/stderr files. Read by both daemons.
  "worker.maxOutputBytes":               [false, isInt],
```

In `UNIVERSAL_DEFAULTS` (find it with `git grep -n "const UNIVERSAL_DEFAULTS" src/profile/schema.mjs`), add:

```js
  "builder.capabilities.observe": false,
  "builder.capabilities.draftSpec": false,
  "builder.capabilities.implementLocal": false,
  "builder.capabilities.publishPr": false,
  "builder.capabilities.mergeBuilderPr": false,
  "worker.maxOutputBytes": 64 * 1024 * 1024,
```

- [ ] **Step 4: Run to verify they pass, and that the live profile reads all-false**

Run: `$N test/profile-validate.test.mjs 2>&1 | tail -3` → `all green`.
Run: `$N -e 'import("./src/profile/schema.mjs").then(async s=>{const fs=await import("fs");const os=await import("os");const p=JSON.parse(fs.readFileSync(os.homedir()+"/.reeve/profiles/nextlyhq/nextly.json","utf8"));const d=s.withDefaults(p);console.log(JSON.stringify(d.builder.capabilities), s.validate(d).ok)})'`
Expected: `{"observe":false,"draftSpec":false,"implementLocal":false,"publishPr":false,"mergeBuilderPr":false} true`.

- [ ] **Step 5: Full suite, commit, push**

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/profile/schema.mjs test/profile-validate.test.mjs
git commit -m "feat(profile): builder capability switches, founder identity, worker output cap"
git push origin main
```

---

### Task 2: The live baseline fixture and its drift check (S0)

**Files:**
- Create: `src/baseline.mjs`, `scripts/capture-baseline.mjs`, `test/fixtures/nextly-baseline-2026-08-21.json`
- Test: `test/baseline.test.mjs`

**Interfaces:**
- Produces: `diffBaseline(live, fixture) → { drifted: boolean, lines: string[] }` where both arguments have the shape `{ rulesetRequiredChecks: string[], rulesetBypassActors: string[], requiredApprovals: number, codeOwnerReview: boolean, profile: { authorityPolicy, mergeEnforcement, capabilities: {...} } }`. PR-2's doctor check R-13 consumes it.

- [ ] **Step 1: Write the failing test**

Create `test/baseline.test.mjs`:

```js
// S0 freezes authority: the live ruleset and profile facts are captured once,
// checked in, and every later reading is compared against them. A silent
// change to a required check, a bypass actor, or a merge switch is exactly the
// drift that turns a dark capability live without anyone deciding it.
import { diffBaseline } from "../src/baseline.mjs";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/nextly-baseline-2026-08-21.json", import.meta.url), "utf8"));

check(Array.isArray(fixture.rulesetRequiredChecks) && typeof fixture.capturedAt === "string",
  "control: the fixture has the captured shape", JSON.stringify(Object.keys(fixture)));

{
  const same = diffBaseline(fixture, fixture);
  check(same.drifted === false && same.lines.length === 0, "identical readings do not drift", JSON.stringify(same));
}
{
  const live = structuredClone(fixture);
  live.rulesetRequiredChecks = [...live.rulesetRequiredChecks, "ops/merge-policy"];
  const d = diffBaseline(live, fixture);
  check(d.drifted === true && /required checks/.test(d.lines.join(" ")),
    "a new required check is drift, and is named", JSON.stringify(d.lines));
}
{
  const live = structuredClone(fixture);
  live.profile.capabilities.mergeBuilderPr = true;
  const d = diffBaseline(live, fixture);
  check(d.drifted === true && /mergeBuilderPr/.test(d.lines.join(" ")),
    "a capability switch turning on is drift, and is named", JSON.stringify(d.lines));
}
{
  const d = diffBaseline(null, fixture);
  check(d.drifted === true && /could not read/.test(d.lines.join(" ")),
    "an unreadable live state is drift, never agreement", JSON.stringify(d));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/baseline.test.mjs`
Expected: module not found error for `../src/baseline.mjs`.

- [ ] **Step 3: Capture the fixture**

Create `scripts/capture-baseline.mjs`:

```js
// Capture the live authority baseline for a repo: what the ruleset requires,
// who may bypass it, and what the profile's merge-related fields say. Written
// once per programme freeze and checked in; doctor compares every later
// reading against it so authority cannot widen without a decision.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withDefaults } from "../src/profile/schema.mjs";

const nwo = process.argv[2];
if (!nwo) { console.error("usage: capture-baseline.mjs <owner/repo>"); process.exit(2); }
const [owner, repo] = nwo.split("/");
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));

const rulesets = gh(`repos/${nwo}/rulesets`);
const active = rulesets.filter(r => r.enforcement === "active");
const detail = active.map(r => gh(`repos/${nwo}/rulesets/${r.id}`));
const rules = detail.flatMap(r => r.rules ?? []);
const requiredChecks = rules.filter(r => r.type === "required_status_checks")
  .flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => `${c.context}@${c.integration_id ?? "any"}`));
const pr = rules.find(r => r.type === "pull_request")?.parameters ?? {};
const bypass = detail.flatMap(r => (r.bypass_actors ?? []).map(b => `${b.actor_type}:${b.actor_id ?? ""}:${b.bypass_mode}`));

const profile = withDefaults(JSON.parse(readFileSync(join(homedir(), ".reeve", "profiles", owner, `${repo}.json`), "utf8")));

const out = {
  capturedAt: new Date().toISOString(),
  nwo,
  rulesetNames: active.map(r => r.name),
  rulesetRequiredChecks: requiredChecks.sort(),
  rulesetBypassActors: bypass.sort(),
  requiredApprovals: pr.required_approving_review_count ?? 0,
  codeOwnerReview: pr.require_code_owner_review ?? false,
  profile: {
    authorityPolicy: profile.authority.policy,
    mergeEnforcement: profile.merge.enforcement,
    capabilities: profile.builder.capabilities,
  },
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
```

Run: `$N scripts/capture-baseline.mjs nextlyhq/nextly > test/fixtures/nextly-baseline-2026-08-21.json && cat test/fixtures/nextly-baseline-2026-08-21.json`
Expected (the facts measured 2026-08-21): `rulesetRequiredChecks` contains only the CI gate context (no `ops/merge-policy`), `rulesetBypassActors` has one OrganizationAdmin entry, `requiredApprovals` is `1`, `codeOwnerReview` is `true`, `profile.authorityPolicy` is `propose_and_merge`, `profile.mergeEnforcement` is `enforced`, every capability `false`. If any value differs, stop and report it: the spec's facts list would be wrong.

- [ ] **Step 4: Write `src/baseline.mjs`**

```js
// The authority baseline: the live ruleset and profile facts as they stood when
// the builder programme froze authority, compared against every later reading.
//
// Drift here is never a bug report, it is an authority change: a required check
// appearing, a bypass actor widening, a capability switch flipping. Each is
// something a person decided or something nobody decided, and doctor must name
// it either way. An unreadable live state is drift, never agreement: not being
// able to look is not the same as having looked and found nothing.

const sortedEq = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Compare a live reading against the checked fixture. Returns {drifted, lines}. */
export function diffBaseline(live, fixture) {
  if (!live || typeof live !== "object") return { drifted: true, lines: ["could not read the live state; drift is assumed, not excluded"] };
  const lines = [];
  if (!sortedEq(live.rulesetRequiredChecks, fixture.rulesetRequiredChecks))
    lines.push(`required checks differ: live ${JSON.stringify(live.rulesetRequiredChecks)} vs baseline ${JSON.stringify(fixture.rulesetRequiredChecks)}`);
  if (!sortedEq(live.rulesetBypassActors, fixture.rulesetBypassActors))
    lines.push(`bypass actors differ: live ${JSON.stringify(live.rulesetBypassActors)} vs baseline ${JSON.stringify(fixture.rulesetBypassActors)}`);
  if (live.requiredApprovals !== fixture.requiredApprovals)
    lines.push(`required approvals: live ${live.requiredApprovals} vs baseline ${fixture.requiredApprovals}`);
  if (live.codeOwnerReview !== fixture.codeOwnerReview)
    lines.push(`code-owner review: live ${live.codeOwnerReview} vs baseline ${fixture.codeOwnerReview}`);
  for (const k of ["authorityPolicy", "mergeEnforcement"]) {
    if (live.profile?.[k] !== fixture.profile?.[k])
      lines.push(`profile.${k}: live ${live.profile?.[k]} vs baseline ${fixture.profile?.[k]}`);
  }
  const caps = new Set([...Object.keys(live.profile?.capabilities ?? {}), ...Object.keys(fixture.profile?.capabilities ?? {})]);
  for (const c of caps) {
    if (live.profile?.capabilities?.[c] !== fixture.profile?.capabilities?.[c])
      lines.push(`capability ${c}: live ${live.profile?.capabilities?.[c]} vs baseline ${fixture.profile?.capabilities?.[c]}`);
  }
  return { drifted: lines.length > 0, lines };
}
```

- [ ] **Step 5: Run, full suite, commit**

Run: `$N test/baseline.test.mjs` → `all green`.

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/baseline.mjs scripts/capture-baseline.mjs test/fixtures/nextly-baseline-2026-08-21.json test/baseline.test.mjs
git commit -m "feat(baseline): capture the live authority baseline and detect drift"
git push origin main
```

---

### Task 3: `workerArgs` refuses a missing sandbox and emits the isolation flags

**Files:**
- Modify: `src/supervisor.mjs:95-116` (`workerArgs`)
- Test: `test/supervisor.test.mjs` (the two existing `workerArgs` cases at lines 15 and 20 must now pass `settings`), new `test/worker-args.test.mjs`

**Interfaces:**
- Produces: `workerArgs({ prompt, settings, allowedTools, disallowedTools, maxTurns, model, effort, maxBudgetUsd, jsonSchema, agents, settingSources, mcpConfig, sessionId, resume })` → `string[]`. Throws `Error("workerArgs: settings is required ...")` when `settings` is null/undefined/empty. Always emits `--safe-mode`, `--strict-mcp-config`, `--no-chrome`. Task 8 hashes the returned array.

- [ ] **Step 1: Write the failing test**

Create `test/worker-args.test.mjs`:

```js
// The argv is the deterministic half of the worker boundary, and `settings` was
// an optional parameter that defaulted to null: a resume that forgot it
// relaunched a worker with no denylist at all, the exact optional-safety-
// parameter class that bit four times in one day. It is now required, and the
// isolation flags are always present rather than inherited.
import { workerArgs } from "../src/supervisor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const has = (a, flag) => a.includes(flag);
const valueOf = (a, flag) => a[a.indexOf(flag) + 1];

{
  let threw = null;
  try { workerArgs({ prompt: "hi" }); } catch (e) { threw = e; }
  check(threw && /settings is required/.test(threw.message),
    "no settings is a hard failure, never a default", String(threw?.message));
  try { workerArgs({ prompt: "hi", settings: "" }); threw = null; } catch (e) { threw = e; }
  check(!!threw, "an empty settings path is refused too");
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json" });
  check(has(a, "--safe-mode") && has(a, "--strict-mcp-config") && has(a, "--no-chrome"),
    "the isolation flags are always present", a.join(" "));
  check(valueOf(a, "--settings") === "/tmp/s.json", "and the settings path is passed", a.join(" "));
  check(has(a, "-p") && has(a, "--verbose") && valueOf(a, "--output-format") === "stream-json",
    "control: the proven print-mode flags survive", a.join(" "));
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json", effort: "high", maxBudgetUsd: 2.5,
                         jsonSchema: '{"type":"object"}', agents: '{"x":{}}', disallowedTools: "WebSearch",
                         mcpConfig: "/tmp/mcp.json" });
  check(valueOf(a, "--effort") === "high", "effort is passed", a.join(" "));
  check(valueOf(a, "--max-budget-usd") === "2.5", "max budget is passed as a string", a.join(" "));
  check(valueOf(a, "--json-schema") === '{"type":"object"}', "json schema is passed", a.join(" "));
  check(valueOf(a, "--agents") === '{"x":{}}', "agents are passed", a.join(" "));
  check(valueOf(a, "--disallowedTools") === "WebSearch", "disallowed tools are passed", a.join(" "));
  check(valueOf(a, "--mcp-config") === "/tmp/mcp.json", "an explicit mcp config is passed", a.join(" "));
}
{
  const a = workerArgs({ prompt: "hi", settings: "/tmp/s.json" });
  check(!has(a, "--effort") && !has(a, "--max-budget-usd") && !has(a, "--json-schema") && !has(a, "--agents"),
    "absent optional flags are absent, not passed as 'undefined'", a.join(" "));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/worker-args.test.mjs 2>&1 | grep -E "^(FAIL|failed)"`
Expected: FAIL on "no settings is a hard failure", "empty settings path", "isolation flags", "effort", "max budget", "json schema", "agents", "disallowed", "mcp config"; `failed=9`.

- [ ] **Step 3: Rewrite `workerArgs`**

Replace the whole `workerArgs` function in `src/supervisor.mjs`:

```js
/**
 * Build the argv for a worker. Flags are passed EXPLICITLY, never inherited:
 * an inherited setting is one a future default can silently change.
 *
 * `settings` is REQUIRED. It used to default to null, and a resume that did not
 * re-pass it relaunched a worker with no denylist and no sandbox at all -- the
 * CLI does not carry `--settings` across `--resume`. An optional parameter that
 * guards a safety rule is the class of defect that bit four times in one day;
 * this one is removed rather than asserted around.
 *
 * The three isolation flags are unconditional: the founder's user settings carry
 * broad permissions, plugins, and MCP servers a worker must never inherit.
 */
export function workerArgs({ prompt, settings, agent = null, allowedTools = null, disallowedTools = null,
                             settingSources = null, maxTurns = null, model = null, effort = null,
                             maxBudgetUsd = null, jsonSchema = null, agents = null, mcpConfig = null,
                             sessionId = null, resume = null }) {
  if (typeof settings !== "string" || !settings.length)
    throw new Error("workerArgs: settings is required; a worker without its settings file has no sandbox");
  const a = ["-p", prompt, "--output-format", "stream-json",
             // Required: without --verbose the process exits 1 and writes NOTHING
             // to stdout, which is indistinguishable from a hang.
             "--verbose",
             // Nothing ambient: no user CLAUDE.md, hooks, plugins, MCP servers,
             // custom agents, or Chrome. What the worker gets is what is passed.
             "--safe-mode", "--strict-mcp-config", "--no-chrome",
             "--settings", settings];
  if (mcpConfig) a.push("--mcp-config", mcpConfig);
  if (agent) a.push("--agent", agent);
  if (agents) a.push("--agents", agents);
  if (model) a.push("--model", model);
  if (effort) a.push("--effort", effort);
  if (maxTurns != null) a.push("--max-turns", String(maxTurns));
  if (maxBudgetUsd != null) a.push("--max-budget-usd", String(maxBudgetUsd));
  if (allowedTools) a.push("--allowedTools", allowedTools);
  if (disallowedTools) a.push("--disallowedTools", disallowedTools);
  if (jsonSchema) a.push("--json-schema", jsonSchema);
  // `--setting-sources project` cuts the preamble ~8x (31,647 -> 3,845 cache-creation
  // tokens, $0.3166 -> $0.0386 for one reply) but strips plugin-shipped agents, so it
  // is only safe for a worker that needs none.
  if (settingSources) a.push("--setting-sources", settingSources);
  if (resume) a.push("--resume", resume);
  else if (sessionId) a.push("--session-id", sessionId);
  return a;
}
```

Then update the two existing cases in `test/supervisor.test.mjs` (lines 15 and 20) to pass `settings: "/tmp/s.json"`, keeping their other assertions.

- [ ] **Step 4: Run both tests, then the full suite**

Run: `$N test/worker-args.test.mjs && $N test/supervisor.test.mjs | tail -2`
Expected: both `all green`. Also run `$N test/prompt-sandbox-agreement.test.mjs` (it must still pass; it reads `sandboxFor`, not `workerArgs`).

- [ ] **Step 5: Commit**

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/supervisor.mjs test/supervisor.test.mjs test/worker-args.test.mjs
git commit -m "feat(supervisor): workerArgs requires settings and passes the isolation flags"
git push origin main
```

---

### Task 4: The environment allowlist and credential-less git

**Files:**
- Create: `src/workerenv.mjs`
- Test: `test/workerenv.test.mjs`

**Interfaces:**
- Produces: `writeGitConfig(dir) → path` (writes `<dir>/gitconfig` with an empty `credential.helper` and nothing else) and `workerEnv({ gitConfigPath, tmpDir, bgWaitMs, extra = {} }) → object` (the COMPLETE environment for a worker). Task 5's `runWorker` uses the object as `env` verbatim; Task 8 records its hash.

- [ ] **Step 1: Write the failing test**

Create `test/workerenv.test.mjs`:

```js
// The worker used to inherit `...process.env`: the founder's GH_TOKEN, the ssh
// agent socket, cloud credentials, proxies, and git overrides all rode along,
// and a `git -C . push https://<token>@...` needs none of the sandbox's deny
// patterns to succeed. The environment is now built from an allowlist, and the
// test asserts the ABSENCE of each ambient credential with a positive control
// (it plants them first), because an absence search that cannot see is not one.
import { workerEnv, writeGitConfig } from "../src/workerenv.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-env-"));

// Positive control: plant every credential the allowlist must drop.
const planted = { GH_TOKEN: "x", GITHUB_TOKEN: "x", SSH_AUTH_SOCK: "/tmp/agent", AWS_SECRET_ACCESS_KEY: "x",
                  GOOGLE_APPLICATION_CREDENTIALS: "x", AZURE_CLIENT_SECRET: "x", HTTPS_PROXY: "x", http_proxy: "x",
                  GIT_SSH_COMMAND: "x", GIT_ASKPASS: "x", GIT_CONFIG_COUNT: "1", REEVE_APP_KEY: "/k.pem",
                  ANTHROPIC_API_KEY: "x" };
for (const [k, v] of Object.entries(planted)) process.env[k] = v;

const gitConfigPath = writeGitConfig(dir);
const env = workerEnv({ gitConfigPath, tmpDir: join(dir, "tmp"), bgWaitMs: 1200000 });

{
  const leaked = Object.keys(planted).filter(k => k in env);
  check(leaked.length === 0, "no planted credential reaches the worker", leaked.join(","));
  check(Object.keys(planted).every(k => process.env[k] !== undefined),
    "control: the credentials were actually planted in this process", "");
}
{
  check(env.HOME === homedir(), "HOME is the real home: the CLI reads ~/.claude for subscription auth", env.HOME);
  check(typeof env.PATH === "string" && /v24\.17\.0\/bin/.test(env.PATH),
    "PATH is pinned to the v24 node bin", env.PATH);
  check(env.TMPDIR === join(dir, "tmp"), "TMPDIR is per run", env.TMPDIR);
  check(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === "1200000", "the background-wait ceiling is passed", env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS);
  check(env.CLAUDE_CODE_MAX_RETRIES === "1", "the 429 retry bound is passed", env.CLAUDE_CODE_MAX_RETRIES);
}
{
  check(env.GIT_CONFIG_NOSYSTEM === "1", "the system git config is never read", env.GIT_CONFIG_NOSYSTEM);
  check(env.GIT_CONFIG_GLOBAL === gitConfigPath, "the global git config is reeve's own file", env.GIT_CONFIG_GLOBAL);
  check(env.GIT_TERMINAL_PROMPT === "0", "git never prompts", env.GIT_TERMINAL_PROMPT);
  const cfg = readFileSync(gitConfigPath, "utf8");
  check(/\[credential\]\s*\n\s*helper\s*=\s*$/m.test(cfg), "the config disables every credential helper", cfg);
  check(!/url\s*=/.test(cfg) && !/insteadOf/.test(cfg), "and carries no URL rewrite", cfg);
}
{
  const e2 = workerEnv({ gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { FOO: "bar" } });
  check(e2.FOO === "bar", "a phase may add named variables", "");
  const e3 = workerEnv({ gitConfigPath, tmpDir: dir, bgWaitMs: 1, extra: { GH_TOKEN: "sneak" } });
  check(!("GH_TOKEN" in e3), "but a stripped name cannot be smuggled back through extra", JSON.stringify(e3.GH_TOKEN));
}

for (const k of Object.keys(planted)) delete process.env[k];
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/workerenv.test.mjs`
Expected: module not found for `../src/workerenv.mjs`.

- [ ] **Step 3: Write `src/workerenv.mjs`**

```js
// The worker's environment, built from an allowlist rather than inherited.
//
// Measured: `runWorker` spread `...process.env` into every worker, which handed
// it the founder's GH_TOKEN, the ssh agent socket, cloud credentials, and git
// overrides. None of the sandbox's string-pattern denies can stop a worker that
// holds a token, because `git -C . push https://<token>@host/...` matches no
// `git push` prefix and needs no helper. Containment is by AUTHORITY: the
// worker simply has no credential, and git is told to look for none.
//
// HOME stays real on purpose. The CLI reads ~/.claude and ~/.claude.json for the
// founder's subscription authentication; a per-run home would leave every
// worker unauthenticated. Everything else isolates around that one fact.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Node and pnpm pinned by absolute path: `node` on PATH is v22 here and must
// never reach a worker, and a worker that cannot find pnpm cannot run the gates.
const NODE_BIN = join(homedir(), ".nvm", "versions", "node", "v24.17.0", "bin");
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// Names that must never reach a worker, however they arrive. Matched exactly
// or by prefix; a phase's `extra` cannot reintroduce them.
const STRIP_EXACT = new Set(["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_ASKPASS",
                             "GIT_CONFIG_COUNT", "REEVE_APP_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
const STRIP_PREFIX = ["AWS_", "GOOGLE_", "GCLOUD_", "AZURE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const STRIP_SUFFIX = ["_PROXY", "_proxy"];

function stripped(name) {
  return STRIP_EXACT.has(name) || STRIP_PREFIX.some(p => name.startsWith(p)) || STRIP_SUFFIX.some(s => name.endsWith(s));
}

/**
 * Write the credential-less global git config a worker runs under, and return
 * its path. An EMPTY `credential.helper` disables every helper git would
 * otherwise consult (the founder's osxkeychain included, which lives in the
 * system config this environment also refuses to read). No URL rewrites: an
 * `insteadOf` could route a push somewhere a bogus pushurl does not cover.
 */
export function writeGitConfig(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gitconfig");
  writeFileSync(path, "[credential]\n\thelper = \n[core]\n\taskPass = \n");
  return path;
}

/**
 * The complete environment for one worker. Callers pass it to `runWorker` as
 * `env` and it is used verbatim: nothing from this process is merged in.
 */
export function workerEnv({ gitConfigPath, tmpDir, bgWaitMs, maxRetries = 1, extra = {} }) {
  if (!gitConfigPath) throw new Error("workerEnv: gitConfigPath is required; a worker must not find the founder's git config");
  mkdirSync(tmpDir, { recursive: true });
  const env = {
    PATH: [NODE_BIN, ...SYSTEM_PATH].join(":"),
    HOME: homedir(),
    TMPDIR: tmpDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    // Without this a 429 hangs indefinitely: the CLI retries internally with
    // no output, which reads as a stuck worker rather than a rate limit.
    CLAUDE_CODE_MAX_RETRIES: String(maxRetries),
    // Print mode waits for background subagents up to this ceiling before exit.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(bgWaitMs),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (stripped(k)) continue;   // a phase may add variables, never credentials
    env[k] = String(v);
  }
  return env;
}
```

- [ ] **Step 4: Run, full suite, commit**

Run: `$N test/workerenv.test.mjs` → `all green`.

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/workerenv.mjs test/workerenv.test.mjs
git commit -m "feat(supervisor): allowlisted worker environment with credential-less git"
git push origin main
```

---

### Task 5: `runWorker` takes an exact environment and streams output to bounded durable files

**Files:**
- Modify: `src/supervisor.mjs` (`runWorker`: the `spawn` call, the stdout/stderr handlers, the `exit` handler; `parseReport` unchanged)
- Test: `test/supervisor.test.mjs` (append a block before the tally)

**Interfaces:**
- Consumes: `workerEnv()` from Task 4 (callers build it; `runWorker` no longer merges anything).
- Produces: `runWorker({ ..., env, outPath, errPath, maxOutputBytes = 64 MiB })` where `env` is used verbatim (if `env` is omitted the function throws), stdout/stderr stream to `outPath`/`errPath` (created, truncated at the cap with `truncated: true` on the result), the result gains `outPath`, `errPath`, `truncated`, and `text` is read from the result event exactly as before. `stderr` on the result is the last 4000 bytes of the err file.

- [ ] **Step 1: Write the failing test**

Append to `test/supervisor.test.mjs` above the tally:

```js
// ── exact environment and durable bounded streams ────────────────────────────
//
// `runWorker` spread process.env and accumulated stdout in memory. A worker that
// prints a gigabyte took the supervisor down with it, and the fenced report
// died in a broken pipe whenever the supervisor died first. Output now streams
// to files the restart path can read, capped, and the environment is exactly
// what the caller built.
{
  const { mkdtempSync, readFileSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reeve-streams-"));
  const outPath = join(dir, "w.out"), errPath = join(dir, "w.err");

  process.env.PLANTED_SECRET = "leak";
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", 'echo "env=$PLANTED_SECRET only=$ONLY"; echo err >&2'],
                              env: { PATH: "/usr/bin:/bin", ONLY: "yes" }, outPath, errPath, budgetMs: 5000 });
  delete process.env.PLANTED_SECRET;
  const out = readFileSync(outPath, "utf8");
  check(/only=yes/.test(out) && /env= /.test(out) === true,
    "the worker sees exactly the env it was given, not the supervisor's", out);
  check(/err/.test(readFileSync(errPath, "utf8")), "stderr streams to its own file", "");
  check(r.outPath === outPath && r.errPath === errPath && r.truncated === false,
    "the result names the files and reports no truncation", JSON.stringify({ o: r.outPath, t: r.truncated }));

  let threw = null;
  try { await runWorker({ bin: "/bin/sh", args: ["-c", "true"], outPath, errPath }); } catch (e) { threw = e; }
  check(threw && /env is required/.test(threw.message), "omitting env is a hard failure, never an inherit", String(threw?.message));

  const big = await runWorker({ bin: "/bin/sh", args: ["-c", "head -c 300000 /dev/zero | tr '\\0' 'x'"],
                                env: { PATH: "/usr/bin:/bin" }, outPath: join(dir, "big.out"), errPath: join(dir, "big.err"),
                                maxOutputBytes: 100000, budgetMs: 10000 });
  check(big.truncated === true && statSync(join(dir, "big.out")).size <= 100000 + 200,
    "output past the cap is dropped and reported as truncated", `size=${statSync(join(dir, "big.out")).size} truncated=${big.truncated}`);
  rmSync(dir, { recursive: true, force: true });
}
```

Note: the existing `runWorker` cases in this file (lines 88, 114, 122, 148) must gain `env: { PATH: "/usr/bin:/bin" }` and an `outPath`/`errPath` under a temp dir; update them in this step.

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/supervisor.test.mjs 2>&1 | grep -E "^(FAIL|failed)"`
Expected: FAIL on "sees exactly the env" (the planted secret leaks), "omitting env is a hard failure", and the truncation case; the stderr-file case fails because no file exists.

- [ ] **Step 3: Change `runWorker`**

In `src/supervisor.mjs`, change the signature and the spawn:

```js
export function runWorker({
  bin = "claude", args, cwd, env,
  outPath = null, errPath = null, maxOutputBytes = 64 * 1024 * 1024,
  budgetMs = 20 * 60 * 1000,
  graceMs = 5000,
  onEvent = () => {},
  onSpawn = () => {},
  isHalted = () => false,
} = {}) {
  // The environment is EXACT. It used to be `{...process.env, ...env}`, which
  // handed every worker the founder's tokens and the ssh agent; see workerenv.mjs.
  if (!env || typeof env !== "object") throw new Error("runWorker: env is required; a worker never inherits the supervisor's environment");
  if (!outPath || !errPath) throw new Error("runWorker: outPath and errPath are required; a worker's output must survive the supervisor");
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
```

Replace the `let stdout = "", stderr = "", buf = "";` line and the two stream handlers with streaming to files:

```js
    let result = null, sessionId = null, rateLimit = null, initModel = null;
    let killedByUs = false, settled = false;
    // Output goes to durable files, not memory: a restart reads the report from
    // the file, and a worker that prints without end cannot take the
    // supervisor down. Past the cap, bytes are dropped and the drop is recorded.
    mkdirSync(dirname(outPath), { recursive: true });
    const outFd = openSync(outPath, "w"), errFd = openSync(errPath, "w");
    let written = 0, truncated = false, buf = "";
    const write = (fd, chunk) => {
      if (written + chunk.length > maxOutputBytes) { truncated = true; return; }
      writeSync(fd, chunk); written += chunk.length;
    };

    child.stdout.on("data", d => {
      write(outFd, d);
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = readEvent(line);
        if (!ev) continue;
        if (ev.kind === "init") { sessionId = ev.sessionId; initModel = ev.model ?? null; }
        if (ev.kind === "result") result = ev.result;
        if (ev.kind === "rate_limit") rateLimit = ev.info;
        onEvent(ev);
      }
    });
    child.stderr.on("data", d => { write(errFd, d); });
```

In the `exit` handler, replace `stderr: stderr.slice(0, 4000), stdoutBytes: stdout.length,` with:

```js
        stderr: tailOf(errPath, 4000), stdoutBytes: written, outPath, errPath, truncated, model: initModel,
```

and close the fds at the top of `finish`: `try { closeSync(outFd); closeSync(errFd); } catch {}`. Add the helper near `readStart`:

```js
/** The last `n` bytes of a file, for a result that should carry a stderr tail without holding the whole file. */
function tailOf(path, n) {
  try { const s = readFileSync(path, "utf8"); return s.slice(-n); } catch { return ""; }
}
```

Extend `readEvent` so the init event carries the model:

```js
  if (e.type === "system" && e.subtype === "init") return { kind: "init", sessionId: e.session_id, model: e.model ?? null };
```

Update the imports at the top of the file: `import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs"; import { dirname } from "node:path";`. The `CLAUDE_CODE_MAX_RETRIES` injection moves to `workerEnv` (Task 4); delete the `maxRetries` parameter and its comment from `runWorker`.

- [ ] **Step 4: Run the supervisor test, then everything**

Run: `$N test/supervisor.test.mjs | tail -3` → `all green`. Run the full suite: `test/dispatch-e2e.test.mjs` and `test/flake-dispatch.test.mjs` stub `spawnWorker`, so they stay green; `test/prompt-sandbox-agreement.test.mjs` does not call `runWorker`.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.mjs test/supervisor.test.mjs
git commit -m "feat(supervisor): exact worker env and bounded durable output streams"
git push origin main
```

---

### Task 6: Spawn binding fails closed

**Files:**
- Modify: `src/supervisor.mjs` (`OUTCOMES`, the `onSpawn` call in `runWorker`)
- Test: `test/supervisor.test.mjs`

**Interfaces:**
- Produces: `OUTCOMES.UNBOUND = "unbound"`. When `onSpawn` throws, `runWorker` kills the group and resolves `{ outcome: "unbound", why: "run binding failed: <message>", pid, lstart }` without waiting for the budget. The daemon (Task 7) treats it like any non-ok outcome.

- [ ] **Step 1: Write the failing test**

Append to `test/supervisor.test.mjs`:

```js
// ── a worker without a durable binding is killed, not observed ───────────────
//
// `onSpawn` records pid+lstart on the run row. Its failure was swallowed ("an
// observer must not kill the worker"), which left a worker running that nothing
// could reason about after a restart. A binding that cannot commit now ends the
// worker before it touches anything.
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reeve-bind-"));
  const t0 = Date.now();
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: "/usr/bin:/bin" },
                              outPath: join(dir, "o"), errPath: join(dir, "e"), budgetMs: 60000,
                              onSpawn: () => { throw new Error("disk full"); } });
  check(r.outcome === OUTCOMES.UNBOUND && /run binding failed: disk full/.test(r.why),
    "a binding failure is its own outcome with the cause", JSON.stringify({ o: r.outcome, w: r.why }));
  check(Date.now() - t0 < 10000, "and the worker was killed immediately, not left to its budget", `${Date.now() - t0}ms`);
  check(r.pid && readStart(r.pid) === null, "the process group is dead", `pid=${r.pid}`);
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/supervisor.test.mjs 2>&1 | grep -E "^(FAIL|failed)"`
Expected: FAIL "a binding failure is its own outcome" (outcome is `ok`... after 30s the sleep ends) and "killed immediately".

- [ ] **Step 3: Implement**

Add to `OUTCOMES`: `UNBOUND: "unbound",             // pid+lstart could not be recorded; the worker was killed unobserved`.

Replace `try { onSpawn({ pid: child.pid, lstart }); } catch { /* an observer must not kill the worker */ }` with:

```js
    // The binding is not an observer. A worker whose pid and start time could
    // not be written is one a restart can neither adopt nor kill with
    // confidence, so it does not get to run at all.
    try { onSpawn({ pid: child.pid, lstart }); }
    catch (err) {
      killGroup(child.pid, "SIGKILL");
      LIVE_GROUPS.delete(child.pid);
      child.on("exit", () => {});
      return finish({ outcome: OUTCOMES.UNBOUND, why: `run binding failed: ${err.message}`,
                      pid: child.pid, lstart, ms: Date.now() - startedAt, stderr: "", outPath, errPath, truncated: false });
    }
```

(`finish` must be defined before this point; move the `const finish = ...` declaration above the `onSpawn` call.)

- [ ] **Step 4: Run, full suite, commit**

```bash
$N test/supervisor.test.mjs | tail -2
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/supervisor.mjs test/supervisor.test.mjs
git commit -m "feat(supervisor): a worker whose binding cannot commit is killed, not run"
git push origin main
```

---

### Task 7: Lease loss revokes authority and terminates the worker (both daemons)

**Files:**
- Modify: `src/supervisor.mjs` (`OUTCOMES`, `runWorker` halt poll), `src/daemon.mjs:434-458` (the heartbeat interval and the `runWorker` call)
- Test: `test/supervisor.test.mjs`, `test/dispatch-e2e.test.mjs`

**Interfaces:**
- Produces: `runWorker({ ..., isRevoked = () => null })` polled every 2s beside `isHalted`; a non-null return terminates the group and resolves `{ outcome: "lease_lost", why: <the reason> }`. `OUTCOMES.LEASE_LOST = "lease_lost"`. The daemon passes `isRevoked: () => revoked` where `revoked` is set by the heartbeat interval from `heartbeat()`'s `{alive:false, reason}` or from a thrown heartbeat. `ctx.heartbeatMs` overrides the interval (tests).

- [ ] **Step 1: Write the failing supervisor test**

Append to `test/supervisor.test.mjs`:

```js
// ── a worker that cannot prove it is leased stops acting ─────────────────────
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reeve-revoke-"));
  let revoked = null;
  setTimeout(() => { revoked = "lease-lost"; }, 500);
  const t0 = Date.now();
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: "/usr/bin:/bin" },
                              outPath: join(dir, "o"), errPath: join(dir, "e"), budgetMs: 60000,
                              isRevoked: () => revoked });
  check(r.outcome === OUTCOMES.LEASE_LOST && /lease-lost/.test(r.why),
    "a revoked lease ends the worker with its reason", JSON.stringify({ o: r.outcome, w: r.why }));
  check(Date.now() - t0 < 10000, "within one poll interval, not at the budget", `${Date.now() - t0}ms`);
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/supervisor.test.mjs 2>&1 | grep -E "^(FAIL|failed)"` → the new case FAILs (outcome `ok` after 30s; so the run takes 30s, which is the point).

- [ ] **Step 3: Implement in the supervisor**

Add `LEASE_LOST: "lease_lost",         // the run lease expired or was taken; the worker was terminated` to `OUTCOMES`. Add `isRevoked = () => null,` to `runWorker`'s parameters. Replace the halt timer with:

```js
    // The halt switch and the lease both fail CLOSED: a worker in flight is
    // terminated, not left running. A lease that cannot be proven live is the
    // same as no lease; the former posture ("a missed beat must not kill the
    // worker") left workers acting with no durable claim on anything.
    let revokedWhy = null;
    const haltTimer = setInterval(() => {
      if (settled) return;
      if (isHalted()) { killedByUs = true; killGroup(child.pid, "SIGTERM"); return; }
      const why = isRevoked();
      if (why) { revokedWhy = String(why); killedByUs = true; killGroup(child.pid, "SIGTERM"); }
    }, 2000);
```

In the `exit` handler, before `classifyResult`: `const c = revokedWhy ? { outcome: OUTCOMES.LEASE_LOST, why: `lease revoked: ${revokedWhy}` } : classifyResult(result, { code, signal, killedByUs });`.

- [ ] **Step 4: Wire the daemon**

In `src/daemon.mjs`, replace the heartbeat interval and the `runWorker` call:

```js
      // The heartbeat's answer is read, not discarded. `heartbeat` already
      // reports a lost lease; the interval used to swallow it, so a worker kept
      // acting with no claim on its run. A failed write is the same: unknown is
      // not alive.
      let revoked = null;
      const beat = setInterval(() => {
        try {
          const hb = heartbeat(db, { runId: run.runId });
          if (!hb.alive) revoked = hb.reason ?? "lease not alive";
        } catch (err) { revoked = `heartbeat write failed: ${err.message}`; }
      }, ctx.heartbeatMs ?? HEARTBEAT_MS);
```

and add to the `runWorker` options: `isRevoked: () => revoked,`. Also add the env and output files (from Tasks 4 and 5):

```js
      const runDir = join(dirname(ctx.logPath ?? "/tmp/x"), "runs", String(e.pr));
      const env = workerEnv({ gitConfigPath: writeGitConfig(join(dirname(ctx.logPath ?? "/tmp/x"), "git")),
                              tmpDir: join(runDir, "tmp"), bgWaitMs: (profile.watch?.workerBudgetMinutes ?? 20) * 60_000 });
      const outPath = join(runDir, `${run.runId}.out`), errPath = join(runDir, `${run.runId}.err`);
```

passing `env, outPath, errPath, maxOutputBytes: profile.worker?.maxOutputBytes ?? 64 * 1024 * 1024` into `runWorker`. Import `workerEnv, writeGitConfig` from `./workerenv.mjs`.

- [ ] **Step 5: Write the failing daemon test**

Append to `test/dispatch-e2e.test.mjs` before the tally (it uses `ctx.spawnWorker`, so the assertion is on what the daemon PASSES):

```js
// --- lease loss reaches the worker ------------------------------------------
//
// The daemon's heartbeat interval ignored `heartbeat()`'s answer. The stub
// worker here waits until the run's lease is revoked in the store, then asks
// the daemon's own `isRevoked` whether it knows.
{
  const dir3 = mkdtempSync(join(tmpdir(), "reeve-e2e-lease-"));
  const ctx3 = { ...baseCtx(), db: open(join(dir3, "l.db")), logPath: join(dir3, "log.txt"), heartbeatMs: 100 };
  let sawRevoked = null;
  ctx3.spawnWorker = async (args) => {
    // Abandon the run underneath the daemon, as an expired lease would.
    ctx3.db.prepare("UPDATE run SET status='abandoned' WHERE status IN ('leased','running')").run();
    await new Promise(r => setTimeout(r, 400));
    sawRevoked = args.isRevoked?.();
    return { outcome: "lease_lost", why: `lease revoked: ${sawRevoked}`, ms: 400, cost: 0, sessionId: "s3" };
  };
  await tick(ctx3);
  check(typeof sawRevoked === "string" && /lease/.test(sawRevoked),
    "the daemon tells the worker its lease is gone", String(sawRevoked));
  ctx3.db.close();
  rmSync(dir3, { recursive: true, force: true });
}
```

Run it before Step 4's daemon changes to see it red (`sawRevoked` is `undefined`), then after to see it green.

- [ ] **Step 6: Full suite, commit**

```bash
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/supervisor.mjs src/daemon.mjs test/supervisor.test.mjs test/dispatch-e2e.test.mjs
git commit -m "feat(daemon): a lost lease revokes the worker instead of being ignored"
git push origin main
```

---

### Task 8: The contract snapshot: `worker_run` in the guardian store

**Files:**
- Modify: `src/db/schema.sql` (append), `src/db/ops.mjs` (append), `src/daemon.mjs` (at dispatch and after the worker returns)
- Test: `test/worker-contract.test.mjs`

**Interfaces:**
- Produces: table `worker_run(run_id PK REFERENCES run(id), cli_version, model_requested, model_resolved, effort, argv_hash, prompt_hash, settings_hash, tool_contract, agents_hash, max_turns, max_budget_usd, canary_id, out_path, err_path, pid, lstart, contract_drift, created_at)`; `recordWorkerContract(db, { runId, ...fields })`, `noteWorkerModel(db, { runId, modelResolved })`, `workerContractFor(db, runId)`. `sha256(s)` helper exported from ops. `ctx.cliVersion` (tests) or a once-per-process `claude --version` read.

- [ ] **Step 1: Write the failing test**

Create `test/worker-contract.test.mjs`:

```js
// Every run records the contract it ran under: which CLI, which model, which
// argv, prompt, settings, tools, and caps. A retry must reuse it verbatim, and
// an alias like `fable` must not drift under a retry. Without the row, "what did
// this worker actually run as" has no answer after the process is gone.
import { open, startRun, recordWorkerContract, noteWorkerModel, workerContractFor, sha256 } from "../src/db/ops.mjs";
import { tick } from "../src/daemon.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-contract-"));
const db = open(join(dir, "c.db"));

// ── the unit ─────────────────────────────────────────────────────────────────
{
  const run = startRun(db, { nwo: "o/r", pr: 7, action: "FIX_CI", head: "a".repeat(40) });
  recordWorkerContract(db, { runId: run.runId, cliVersion: "2.1.237", modelRequested: "fable", effort: "high",
    argvHash: sha256("argv"), promptHash: sha256("prompt"), settingsHash: sha256("settings"), toolContract: "Read,Edit",
    agentsHash: null, maxTurns: 40, maxBudgetUsd: 2, canaryId: null, outPath: "/o", errPath: "/e", pid: 1, lstart: "x" });
  const row = workerContractFor(db, run.runId);
  check(row?.cli_version === "2.1.237" && row.model_requested === "fable" && row.model_resolved === null,
    "a contract row is written at dispatch with the model still unresolved", JSON.stringify(row));
  noteWorkerModel(db, { runId: run.runId, modelResolved: "claude-fable-5" });
  check(workerContractFor(db, run.runId).model_resolved === "claude-fable-5",
    "the resolved model is recorded when the worker announces it");
  check(sha256("a") !== sha256("b") && sha256("a").length === 64, "control: sha256 is a real hash");
}

// ── the wiring: the daemon records it ────────────────────────────────────────
{
  const HEAD = "b".repeat(40);
  const cl = (id, state, detail = "") => ({ id, state, detail });
  const evaluation = {
    ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"]
                 .map(id => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true },
  };
  const ctx = {
    nwo: "o/r", db, logPath: join(dir, "log.txt"), execute: true, shadow: true, running: 0, cliVersion: "2.1.237",
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir }, authority: { policy: "propose_and_merge" },
               rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, ci: { provider: "github-actions", requiredChecks: [] },
               watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    openPrs: () => [42], evaluate: () => evaluation,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "claude-x-resolved" }),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", runId: 11, cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    worktreeFor: () => dir,
  };
  await tick(ctx);
  const row = db.prepare("SELECT w.* FROM worker_run w JOIN run r ON r.id = w.run_id WHERE r.task_id='pr:42'").get();
  check(!!row, "the daemon writes a contract row for its dispatch", JSON.stringify(row));
  check(row?.cli_version === "2.1.237" && /^[0-9a-f]{64}$/.test(row?.argv_hash ?? "") && /^[0-9a-f]{64}$/.test(row?.settings_hash ?? ""),
    "with the CLI version and real hashes", JSON.stringify(row));
  check(row?.model_resolved === "claude-x-resolved", "and the model the worker announced", String(row?.model_resolved));
  check(row?.out_path && row?.err_path, "and the durable output paths", JSON.stringify([row?.out_path, row?.err_path]));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/worker-contract.test.mjs` → import error (`recordWorkerContract` not exported).

- [ ] **Step 3: Schema and ops**

Append to `src/db/schema.sql`:

```sql
-- ---------------------------------------------------------------- worker contracts
-- One row per claude worker the daemon dispatches: the immutable contract it
-- ran under. A retry reuses it verbatim; an alias never drifts under one.
-- The lease stays on `run`; this row never carries a second one.
CREATE TABLE IF NOT EXISTS worker_run (
  run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  cli_version     TEXT NOT NULL,
  model_requested TEXT,
  model_resolved  TEXT,                       -- from the worker's init event, once it speaks
  effort          TEXT,
  argv_hash       TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  settings_hash   TEXT NOT NULL,
  tool_contract   TEXT,
  agents_hash     TEXT,
  max_turns       INTEGER,
  max_budget_usd  REAL,
  canary_id       TEXT,
  out_path        TEXT NOT NULL,
  err_path        TEXT NOT NULL,
  pid             INTEGER,
  lstart          TEXT,
  contract_drift  TEXT,                       -- JSON; null when the live environment matched
  created_at      INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

Append to `src/db/ops.mjs`:

```js
// ------------------------------------------------------------------ worker contracts
import { createHash } from "node:crypto";

export const sha256 = s => createHash("sha256").update(String(s)).digest("hex");

/** Record the contract a worker is about to run under. Written before spawn, beside the run. */
export function recordWorkerContract(db, { runId, cliVersion, modelRequested = null, effort = null, argvHash, promptHash,
                                           settingsHash, toolContract = null, agentsHash = null, maxTurns = null,
                                           maxBudgetUsd = null, canaryId = null, outPath, errPath, pid = null, lstart = null,
                                           contractDrift = null }) {
  return tx(db, () => {
    db.prepare(`INSERT INTO worker_run (run_id,cli_version,model_requested,effort,argv_hash,prompt_hash,settings_hash,
                  tool_contract,agents_hash,max_turns,max_budget_usd,canary_id,out_path,err_path,pid,lstart,contract_drift,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())`)
      .run(runId, cliVersion, modelRequested, effort, argvHash, promptHash, settingsHash, toolContract, agentsHash,
           maxTurns, maxBudgetUsd, canaryId, outPath, errPath, pid, lstart, contractDrift == null ? null : canonical(contractDrift));
    emit(db, { actor: "daemon", op: "worker.contract", run_id: runId, payload: { cliVersion, modelRequested, argvHash, settingsHash } });
  });
}

/** The model the worker actually announced in its init event. */
export function noteWorkerModel(db, { runId, modelResolved }) {
  db.prepare(`UPDATE worker_run SET model_resolved=? WHERE run_id=?`).run(modelResolved, runId);
}

export function workerContractFor(db, runId) {
  return db.prepare(`SELECT * FROM worker_run WHERE run_id=?`).get(runId) ?? null;
}
```

(`canonical` and `emit` already exist in ops.mjs; move the `createHash` import to the top of the file with the other imports.)

- [ ] **Step 4: Wire the daemon**

In `src/daemon.mjs`, after `sandbox`/`settingsPath` are built and before `runWorker`, build the argv once and record the contract:

```js
      const argv = workerArgs({ prompt: spec.prompt, settings: settingsPath,
                                allowedTools: spec.tools ?? sandbox.allowedTools,
                                maxTurns: profile.watch?.maxTurns ?? 40 });
      // The contract is recorded before the process exists, so that a crash
      // between here and the first heartbeat still leaves the answer to "what
      // was this worker asked to run as".
      recordWorkerContract(db, {
        runId: run.runId, cliVersion: ctx.cliVersion ?? cliVersion(),
        modelRequested: null, effort: null,
        argvHash: sha256(JSON.stringify(argv)), promptHash: sha256(spec.prompt),
        settingsHash: sha256(readFileSync(settingsPath, "utf8")),
        toolContract: spec.tools ?? sandbox.allowedTools, maxTurns: profile.watch?.maxTurns ?? 40,
        outPath, errPath,
      });
```

pass `args: argv` to `runWorker`, and after it returns: `if (r?.model) noteWorkerModel(db, { runId: run.runId, modelResolved: r.model });`. Add a once-per-process reader near the top of daemon.mjs:

```js
// Read once: the CLI version is part of every worker's contract, and asking on
// every dispatch would be a subprocess per tick for an answer that does not change.
let CLI_VERSION = null;
function cliVersion() {
  if (CLI_VERSION) return CLI_VERSION;
  try { CLI_VERSION = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(); }
  catch { CLI_VERSION = "unknown"; }
  return CLI_VERSION;
}
```

Import `recordWorkerContract, noteWorkerModel, sha256` from `./db/ops.mjs` and `readFileSync` from `node:fs`.

- [ ] **Step 5: Run, full suite, commit**

```bash
$N test/worker-contract.test.mjs
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/db/schema.sql src/db/ops.mjs src/daemon.mjs test/worker-contract.test.mjs
git commit -m "feat(daemon): record each worker's contract snapshot beside its run"
git push origin main
```

---

### Task 9: A worktree-scoped pre-push hook

**Files:**
- Modify: `src/worktree.mjs` (`acquireWorktree`, after the pushurl config)
- Test: `test/worktree.test.mjs` (find the existing pushurl case with `git grep -n pushurl test/worktree.test.mjs` and add beside it)

**Interfaces:**
- Produces: every acquired worktree has `core.hooksPath` set `--worktree` to `<worktree>/.reeve-hooks`, containing an executable `pre-push` that prints a refusal and exits 1. Exported `REFUSING_HOOK` constant (the script text) for the test.

- [ ] **Step 1: Write the failing test**

In `test/worktree.test.mjs`, after the existing pushurl assertion:

```js
{
  // The bogus pushurl stops a push to origin. A push to an explicit file:// or
  // https:// URL bypasses it; the hook is the layer that catches that shape.
  const { execFileSync } = await import("node:child_process");
  const bare = mkdtempSync(join(tmpdir(), "reeve-bare-"));
  execFileSync("git", ["init", "--bare", "-q", bare]);
  let out = "", code = 0;
  try { out = execFileSync("git", ["-C", wt.path, "push", bare, "HEAD:refs/heads/escape"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; out = String(e.stderr); }
  check(code !== 0 && /does not publish/.test(out), "a push to an explicit URL is refused by the worktree's own hook", `code=${code} ${out.slice(0, 200)}`);
  const hooksPath = execFileSync("git", ["-C", wt.path, "config", "--worktree", "core.hooksPath"], { encoding: "utf8" }).trim();
  check(hooksPath.startsWith(wt.path), "the hooks path is scoped to this worktree, not the clone", hooksPath);
  rmSync(bare, { recursive: true, force: true });
}
```

(`wt` is the result of the `acquireWorktree` call the existing test already makes; reuse it.)

- [ ] **Step 2: Run to verify it fails**

Run: `$N test/worktree.test.mjs 2>&1 | grep -E "^(FAIL|failed)"` → the push to the bare repo SUCCEEDS today (exit 0), so the first assertion FAILs.

- [ ] **Step 3: Implement**

In `src/worktree.mjs`, after the `remote.origin.pushurl` line:

```js
  // Second layer, for the shape the pushurl does not cover: `git push <url>`
  // with an explicit file:// or https:// destination never consults origin's
  // pushurl. A worktree-scoped hooks path (the clone's own hooks stay untouched)
  // refuses every push from inside this checkout. Hooks can be bypassed with
  // --no-verify, which is why the credential-less environment and the OS
  // sandbox's network deny sit underneath this; each layer covers a shape the
  // others do not.
  const hooks = join(path, ".reeve-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), REFUSING_HOOK, { mode: 0o755 });
  git(path, ["config", "--worktree", "core.hooksPath", hooks]);
```

and near the top of the file:

```js
/** The pre-push hook every worktree carries. It refuses unconditionally. */
export const REFUSING_HOOK = "#!/bin/sh\necho 'this checkout does not publish; reeve publishes after the diff gate' >&2\nexit 1\n";
```

Add `mkdirSync, writeFileSync` to the `node:fs` import and `join` to the `node:path` import if absent. Also add `.reeve-hooks/` to the worktree's `.git/info/exclude` so it never appears in a diff: `appendFileSync(join(gitDirOf(path), "info", "exclude"), ".reeve-hooks/\n")` where `gitDirOf` runs `git rev-parse --git-dir` in the worktree (add a small helper beside `git`).

- [ ] **Step 4: Run, full suite, commit**

```bash
$N test/worktree.test.mjs | tail -2
for f in test/*.test.mjs; do $N "$f" >/dev/null || echo "FAILED $f"; done
git add src/worktree.mjs test/worktree.test.mjs
git commit -m "feat(worktree): a worktree-scoped pre-push hook refuses every push"
git push origin main
```

---

### Task 10: PR-1 close-out: tracker, docs, daemon restart

**Files:**
- Modify: `docs/TRACKER.md` (Programme 2 "In flight"), `docs/USING-REEVE.md` §5 (what a worker can and cannot do: add the environment and output-file facts)

- [ ] **Step 1: Tracker**

Under Programme 2 "In flight", replace `- [ ] Implementation plan ...` and `- [ ] Build` with:

```
- [x] Implementation plan for S0 + S1: `docs/superpowers/plans/2026-08-21-s1-worker-contract.md`
- [x] **PR-1 (S0 + S1 core) LANDED** — capability switches (all false on the live
      profile), baseline fixture + drift check, workerArgs hard-fail + isolation
      flags, env allowlist + credential-less git, bounded durable streams,
      fail-closed spawn binding, lease revocation in both daemons, `worker_run`
      contract rows, worktree pre-push hook. Suite N/N.
- [ ] **PR-2 (S1 sandbox)** — the two CLI measurements, `sandbox.*` settings +
      validation, per-start canary, doctor R-13/R-14/R-15, escape test.
```

- [ ] **Step 2: Restart the daemon onto the new code and verify one tick**

```bash
launchctl kickstart -k gui/$(id -u)/com.revnix.reeve
sleep 90; tail -5 ~/.reeve/reeve.log; tail -3 ~/.reeve/reeve.err.log
```

Expected: a normal tick (`tick: nextlyhq/nextly`, verdict lines), no stack trace in the error log. The daemon is observe-only, so no worker is dispatched; the new paths run only on dispatch, which PR-2's canary and the existing dispatch proof exercise.

- [ ] **Step 3: Commit and push**

```bash
git add docs/TRACKER.md docs/USING-REEVE.md
git commit -m "docs: tracker and guide for the worker contract (PR-1)"
git push origin main
```

---

# PR-2: S1 sandbox

### Task 11: Measure the two unknowns about print mode  (DONE, PR-2)

**Files:**
- Create: `docs/measured/2026-08-22-claude-print-mode.md`

**Interfaces:**
- Produces: two recorded facts that decide Tasks 12 and 13: (a) whether `sandbox.*` settings apply under `-p`; (b) whether an invalid `--settings` file errors or is silently ignored under `-p`. Each costs one short model call.

- [ ] **Step 1: Measure sandbox-under-print**

```bash
mkdir -p /tmp/reeve-measure && cd /tmp/reeve-measure && git init -q probe && cd probe
cat > settings.json <<'EOF'
{ "sandbox": { "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
               "network": { "allowedDomains": [] } },
  "permissions": { "allow": ["Bash(curl:*)", "Bash(touch:*)", "Bash(ls:*)"], "deny": [] } }
EOF
claude -p 'Run exactly these two shell commands and report each exit code verbatim: (1) curl -sS -m 5 https://example.com -o /dev/null; (2) touch /tmp/reeve-measure/OUTSIDE. Do nothing else.' \
  --output-format stream-json --verbose --safe-mode --strict-mcp-config --no-chrome \
  --settings ./settings.json --allowedTools 'Bash(curl:*),Bash(touch:*)' --max-turns 4 2>&1 | tee run-a.jsonl | tail -3
ls -la /tmp/reeve-measure/OUTSIDE 2>&1
```

Record: the worker's reported exit codes, whether `/tmp/reeve-measure/OUTSIDE` exists, and any `sandbox` mention in `run-a.jsonl` (`grep -i sandbox run-a.jsonl | head`). **Interpretation:** curl failing with a connection error AND the file absent means the sandbox applies under `-p`; either succeeding means it does not (or the keys differ), and Task 12 then ships the settings block but the canary (Task 13) must fail closed and refuse write-capable dispatch until the platform row is resolved.

- [ ] **Step 2: Measure invalid settings under print**

```bash
printf '{ "permissions": { "deny": ["Bash(ls:*)"] }, "sandbox": { "enabled": "yes" } }' > bad.json   # wrong type
claude -p 'Run: ls / ; report the exit code.' --output-format stream-json --verbose --safe-mode --strict-mcp-config --no-chrome \
  --settings ./bad.json --allowedTools 'Bash(ls:*)' --max-turns 2 2>&1 | tee run-b.jsonl | tail -3; echo "exit=$?"
```

Record: the process exit code, whether any validation error was printed, and whether `ls /` was denied (the deny rule applied) or ran. **Interpretation:** if the CLI exits non-zero naming the settings, validation is fatal and Task 12's pre-spawn validation is belt-and-braces; if it runs and `ls` is NOT denied, the whole file was silently ignored (the audit's claim) and pre-spawn validation is load-bearing.

- [ ] **Step 3: Write the measurement doc**

`docs/measured/2026-08-22-claude-print-mode.md` with: date, CLI version (`claude --version`), both commands verbatim, raw tail of each jsonl, the file-existence check, and a one-line conclusion per question. Commit: `git commit -m "docs(measured): sandbox and settings validation under print mode"`.

---

### Task 12: The OS-sandbox settings block and pre-spawn validation  (DONE, PR-2)

**Files:**
- Modify: `src/sandbox.mjs` (`sandboxFor` return, new `validateSettings`), `src/daemon.mjs` (call `validateSettings` before `writeSandbox`)
- Test: `test/sandbox.test.mjs`, `test/dispatch-e2e.test.mjs`

**Interfaces:**
- Produces: `sandboxFor(...)` returns `settings.sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [...] } }` where `allowedDomains` is `[]` for every action except `BUILD_RESEARCH` (which reads `profile.builder?.network?.research?.allowedDomains ?? []`, a FIELDS key added here: `"builder.network.research.allowedDomains": [false, isArr(isStr)]`). `validateSettings(settings) → { ok, errors }` checks: `sandbox.enabled === true`, `failIfUnavailable === true`, `allowUnsandboxedCommands === false`, `permissions.deny` is an array of strings, `permissions.allow` likewise, no key outside `{permissions, sandbox}`. The daemon refuses dispatch with `phase.attempt_failed(cause:settings_invalid)` logged as `NOT dispatching — settings invalid: ...` when it fails.

- [ ] **Step 1: Failing tests**

Append to `test/sandbox.test.mjs`:

```js
// ── the OS sandbox is in the settings, and the settings are validated ────────
{
  const s = sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt" });
  const sb = s.settings.sandbox;
  check(sb?.enabled === true && sb.failIfUnavailable === true && sb.allowUnsandboxedCommands === false,
    "every worker's settings enable the OS sandbox with no unsandboxed fallback", JSON.stringify(sb));
  check(Array.isArray(sb?.network?.allowedDomains) && sb.network.allowedDomains.length === 0,
    "and deny network by default", JSON.stringify(sb?.network));
  const v = validateSettings(s.settings);
  check(v.ok === true, "control: generated settings validate", JSON.stringify(v.errors));
}
{
  const bad = structuredClone(sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt" }).settings);
  bad.sandbox.allowUnsandboxedCommands = true;
  const v = validateSettings(bad);
  check(v.ok === false && /allowUnsandboxedCommands/.test(v.errors.join(" ")), "an unsandboxed fallback is refused", JSON.stringify(v.errors));
  const bad2 = structuredClone(bad); bad2.sandbox.allowUnsandboxedCommands = false; bad2.sandbox.enabled = "yes";
  check(validateSettings(bad2).ok === false, "a truthy string is not enabled");
  const bad3 = structuredClone(bad2); bad3.sandbox.enabled = true; bad3.hooks = {};
  check(validateSettings(bad3).ok === false && /hooks/.test(validateSettings(bad3).errors.join(" ")), "an unexpected top-level key is refused");
  check(validateSettings(null).ok === false, "absent settings are invalid, not empty");
}
```

And in `test/dispatch-e2e.test.mjs`, a case where `ctx.settingsValidator = () => ({ ok: false, errors: ["planted"] })` (an injection seam added in this task) and the assertion that `spawned.length === 0` and the log contains `settings invalid`.

- [ ] **Step 2: Run to verify red** (`validateSettings` not exported; `sandbox` absent).

- [ ] **Step 3: Implement**

In `sandboxFor`'s returned `settings`, add beside `permissions`:

```js
      // The OS boundary. String-pattern denies document intent; this enforces
      // it: Seatbelt on macOS, bubblewrap on Linux, refused outright where the
      // canary cannot prove it. No fallback to an unsandboxed command, ever.
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        network: { allowedDomains: action === "BUILD_RESEARCH" ? (profile.builder?.network?.research?.allowedDomains ?? []) : [] },
      },
```

Add to `sandbox.mjs`:

```js
/**
 * Validate generated settings before spawn. `--print` silently ignores a
 * settings file that fails the CLI's own validation, so a supplied path proves
 * nothing; this is the check that turns "we passed a file" into "the file
 * says what we meant". The shape is ours: only `permissions` and `sandbox`.
 */
export function validateSettings(settings) {
  const errors = [];
  if (!settings || typeof settings !== "object") return { ok: false, errors: ["settings absent"] };
  for (const k of Object.keys(settings)) if (!["permissions", "sandbox"].includes(k)) errors.push(`unexpected key: ${k}`);
  const sb = settings.sandbox ?? {};
  if (sb.enabled !== true) errors.push("sandbox.enabled must be true");
  if (sb.failIfUnavailable !== true) errors.push("sandbox.failIfUnavailable must be true");
  if (sb.allowUnsandboxedCommands !== false) errors.push("sandbox.allowUnsandboxedCommands must be false");
  if (!Array.isArray(sb.network?.allowedDomains) || sb.network.allowedDomains.some(d => typeof d !== "string"))
    errors.push("sandbox.network.allowedDomains must be an array of strings");
  const p = settings.permissions ?? {};
  for (const list of ["allow", "deny"])
    if (!Array.isArray(p[list]) || p[list].some(x => typeof x !== "string")) errors.push(`permissions.${list} must be an array of strings`);
  return { ok: errors.length === 0, errors };
}
```

In the daemon, before `writeSandbox`: `const sv = (ctx.settingsValidator ?? validateSettings)(sandbox.settings); if (!sv.ok) { log(logPath, \`  #${e.pr}: NOT dispatching — settings invalid: ${sv.errors.join("; ")}\`); finishRun(db, { runId: run.runId, outcome: "failed", why: "settings_invalid" }); continue; }`. Add the FIELDS key for research domains. Update `test/prompt-sandbox-agreement.test.mjs` if it enumerates settings keys.

- [ ] **Step 4: Run, suite, commit** — `git commit -m "feat(sandbox): os sandbox in every worker's settings, validated before spawn"`.

---

### Task 13: The sandbox canary, once per contract per daemon start  (DONE, PR-2)

**Files:**
- Create: `src/canary.mjs`
- Modify: `src/daemon.mjs` (run the canary before the first dispatch of a tick; refuse dispatch and escalate on failure)
- Test: `test/canary.test.mjs`, `test/dispatch-e2e.test.mjs`

**Interfaces:**
- Produces: `sandboxCanary({ settingsPath, env, runner = runWorker, cwd }) → { ok, id, why, evidence }` where `id = sha256(settings content)`; the canary prompt asks the worker to run `curl -sS -m 5 https://example.com -o /dev/null` and `touch <outside-path>` and report exit codes; `ok` is true only when the worker reports both non-zero AND the outside file does not exist (absence plus a positive control: a file INSIDE the scope must exist). The daemon keeps `CANARY` in memory per settings hash; a failed canary logs `NOT dispatching — sandbox canary failed` and sets escalation `guardian:sandbox:canary-failed` (identity; evidence in the body). `ctx.canary` injection seam for tests.

- [ ] **Step 1: Failing tests** — `test/canary.test.mjs` drives `sandboxCanary` with a fake `runner` that (a) returns a result text reporting `curl exit 7, touch exit 1` and no outside file → `ok:true`; (b) reports `curl exit 0` → `ok:false` with `/network/` in why; (c) reports both non-zero but the test pre-creates the outside file → `ok:false` with `/wrote outside/`; (d) the inside control file missing → `ok:false` with `/control/`. In `dispatch-e2e`, `ctx.canary = () => ({ ok: false, why: "planted" })` → `spawned.length === 0` and the escalation key `guardian:sandbox:canary-failed` present; `ctx.canary = () => ({ ok: true })` → dispatch proceeds.

- [ ] **Step 2: Red.** - [ ] **Step 3: Implement** `src/canary.mjs` (prompt text, runner call with `--max-turns 4`, `--json-schema '{"type":"object","properties":{"curlExit":{"type":"integer"},"touchExit":{"type":"integer"}},"required":["curlExit","touchExit"]}'`, parse `structured_output` from the result, check the files). Wire the daemon: `const canary = (ctx.canary ?? sandboxCanary)(...)` cached by `sha256(settings)` in a module-level Map reset on process start. - [ ] **Step 4: Green, suite, commit** — `git commit -m "feat(daemon): a sandbox canary must pass before any dispatch under a contract"`.

---

### Task 14: Doctor R-13 baseline drift, R-14 subscription-auth probe, R-15 canary  (DONE, PR-2)

**Files:**
- Modify: `src/doctor.mjs` (three new checks appended to the check list)
- Test: `test/doctor-state.test.mjs` (extend with injected readers)

**Interfaces:**
- R-13 reads the live ruleset/profile with the same code as `scripts/capture-baseline.mjs` (move that code into `src/baseline.mjs` as `readLiveBaseline(nwo, io)`), compares with `diffBaseline`, reports `DEGRADED` with the lines on drift, `UNKNOWN` when unreadable. R-14 runs a one-turn worker (`--max-turns 1`, prompt "reply with the single word ok") under `workerEnv()` and the validated settings; `OK` when the result event arrives with `is_error:false`; `BROKEN` (refuses every dispatch) otherwise, with the stderr tail. R-15 reports the last canary result per settings hash from a small JSON file the daemon writes (`~/.reeve/state/<owner>/<repo>.canary.json`).

- [ ] Steps: failing tests with injected `io` (doctor already injects `authenticate`), implement, green, commit `feat(doctor): baseline drift, subscription-auth probe, and canary status`.

---

### Task 15: The real non-publishing escape test  (DONE, PR-2)

**Files:**
- Create: `test/escape.test.mjs`

**Interfaces:**
- Consumes: `acquireWorktree`, `workerEnv`, `writeGitConfig`, `runWorker`.

- [ ] **Step 1: Write the test.** It creates a bare "remote" and a clone with a real worktree via `acquireWorktree`, then runs `runWorker({ bin: "/bin/sh", args: ["-c", SCRIPT], env: workerEnv(...), cwd: worktree })` where `SCRIPT` attempts, in order: `git push origin HEAD:escape`, `git -C . push <bare-path> HEAD:escape`, `git push --no-verify <bare-path> HEAD:escape2`, `git remote set-url origin <bare-path> && git push origin HEAD:escape3`, `git push https://x-access-token:FAKE@github.com/revnix/reeve HEAD:escape4`, `curl -sS -m 3 https://example.com -o /dev/null`, each followed by `echo "<name>=$?"`. Assertions, with positive controls: the bare remote has zero refs under `refs/heads/escape*` (control: a push from the MAIN checkout with a real URL succeeds); every git exit code is non-zero; the `--no-verify` attempt is the one the hook cannot stop, so it must be stopped by the bogus pushurl or by git having no credential, and the test asserts which layer stopped it from the stderr text; `curl` may succeed outside the OS sandbox (this test runs without it) and its line is informational, asserted only when `process.env.REEVE_SANDBOXED=1`.
- [ ] **Step 2: Run it; every assertion must pass on PR-1's layers alone.** If the `remote set-url` case succeeds, the worktree config did not take; fix in `worktree.mjs` (the `--worktree` pushurl must also be re-applied after a `set-url`, which means the hook must also refuse `remote set-url`; add a `pre-push` independent check: the hook compares the push URL against the recorded bare path and refuses any URL that is not `reeve://refused-the-worker-does-not-publish`).
- [ ] **Step 3: Commit** — `test(escape): a worker cannot publish through any git shape`.

---

### Task 16: PR-2 close-out  (docs DONE; merge + daemon restart pending review)

- [ ] Update `docs/TRACKER.md` (PR-2 landed, S1 complete, S2 next), `docs/HANDOFF.md` §6 (one paragraph: the worker contract landed, what it enforces, what remains unmeasured on other platforms), `docs/USING-REEVE.md` §5 table. Restart the daemon; confirm a clean tick and a passing R-14/R-15 in `reeve doctor nextlyhq/nextly --as-app`. Commit `docs: worker contract complete (S1)`.

---

## Self-review

**Spec coverage (§4, §14 S0-S1):**
- §1.4 switches in FIELDS, default false, non-boolean refused → Task 1. Baseline fixture and drift → Task 2. No merge actuation exists: nothing in this plan calls `gh pr merge` (true today; Task 2's fixture proves the switch is off).
- §4.2 OS sandbox, fail-if-unavailable, no fallback, network policy per action → Task 12; canary proving it → Task 13; measurement of applicability under `-p` → Task 11.
- §4.3 env allowlist, HOME real, credential-less git, stripped names asserted, auth probe → Tasks 4, 14.
- §4.4 `--safe-mode`, explicit settings, `--strict-mcp-config`, `--no-chrome`, explicit tools/agents, settings validated before spawn → Tasks 3, 12.
- §4.5 run row + `worker_run`, fail-closed `onSpawn`, heartbeat/lease loss terminates, bounded durable streams → Tasks 5, 6, 7, 8.
- §4.6 `--json-schema` flag available → Task 3; the canary uses it → Task 13. (Guardian FIX_CI prompts keep the fenced-json report until S3 rewrites prompts; the flag is plumbed, not yet required of guardian workers.)
- §4.7 contract snapshot with resolved model → Task 8. `contract_drift` column exists; its comparison logic belongs to S2's builder loop (the guardian never resumes with a different contract), so it is recorded as null here.
- §4.8 settings hard-fail, resume rebuilds from snapshot → Task 3 (hard-fail); the resume path itself is S2 (the guardian does not `--resume` today).
- Worktree pre-push hook → Task 9; escape test → Task 15.
- Platforms: the canary is the per-host proof → Task 13.

**Placeholder scan:** Tasks 13-16 are written at lower code density than 1-12 (their tests and wiring are described rather than fully listed) because each depends on Task 11's measured answers; an executor reaching Task 13 must write the full test code before the implementation, in the shape of Task 12's. No TBD/TODO appears.

**Type consistency:** `runWorker` options `{env, outPath, errPath, maxOutputBytes, isRevoked, onSpawn}` match between Tasks 5, 6, 7 and the daemon wiring in Tasks 7 and 8; `OUTCOMES.UNBOUND`/`LEASE_LOST` names match; `workerEnv({gitConfigPath, tmpDir, bgWaitMs, maxRetries, extra})` matches Tasks 4 and 7; `recordWorkerContract` field names match the `worker_run` columns in Task 8; `validateSettings` and `sandboxFor` shapes match Tasks 12 and 13.
