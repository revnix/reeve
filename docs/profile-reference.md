# Profile reference

GENERATED from `src/profile/schema.mjs`. Do not edit by hand: run
`node scripts/profile-reference.mjs`, which rewrites this file. A test in
`test/profile-validate.test.mjs` fails while it is stale, and
`node scripts/profile-reference.mjs --check` reports staleness without writing.

69 keys. 29 carry a description.

`requirement` is what an operator must AUTHOR, not the validator's raw flag:
the loader applies defaults before validating, so a `defaulted` key may be
omitted. Examples for every project kind are at the end.

A key with no description has no comment above or beside it in
`src/profile/schema.mjs` yet. Write one there and regenerate; there is nowhere
else to put it, which is the point.

## Index

| key | requirement | documented |
|---|---|---|
| `schemaVersion` | required | — |
| `project.kind` | required | — |
| `identity.key` | required | yes |
| `identity.prHost` | optional | yes |
| `identity.defaultBranch` | required | — |
| `identity.baseBranch` | optional | yes |
| `identity.visibility` | required | — |
| `identity.checkout` | optional | yes |
| `identity.worktreeRoot` | optional | — |
| `identity.cloneStrategy` | optional | — |
| `authority.permission` | required | — |
| `authority.policy` | required | — |
| `authority.profileLocation` | defaulted | — |
| `authority.forbiddenActions` | optional | — |
| `state.mode` | required | — |
| `state.location` | optional | — |
| `units` | required | — |
| `lanes` | optional | — |
| `ci.appSlug` | optional | yes |
| `ci.provider` | required | yes |
| `ci.requiredChecks` | optional | yes |
| `ci.reviewerStatusContexts` | optional | yes |
| `merge.method` | required | yes |
| `merge.deleteBranch` | optional | — |
| `merge.enforcement` | required | — |
| `reviewers` | optional | — |
| `rounds.softCap` | optional | — |
| `rounds.hardCap` | optional | — |
| `rounds.maxFixAttemptsPerFinding` | optional | — |
| `risk.sensitivePaths` | optional | yes |
| `risk.quarantinePaths` | optional | yes |
| `risk.forbiddenCommands` | optional | yes |
| `risk.testPaths` | optional | yes |
| `builder.capabilities.observe` | optional | yes |
| `builder.capabilities.draftSpec` | optional | — |
| `builder.capabilities.implementLocal` | optional | — |
| `builder.capabilities.publishPr` | optional | — |
| `builder.capabilities.mergeBuilderPr` | optional | — |
| `builder.founder.userId` | optional | yes |
| `builder.founder.login` | optional | — |
| `builder.cancel.drainMinutes` | optional | yes |
| `builder.budgets` | optional | yes |
| `worker.maxOutputBytes` | optional | yes |
| `worker.isolation` | optional | yes |
| `worker.dependencyPaths` | optional | yes |
| `builder.network.research.allowedDomains` | optional | yes |
| `notify.provider` | optional | yes |
| `notify.url` | optional | — |
| `notify.topic` | optional | — |
| `notify.credentialFile` | optional | — |
| `notify.desktop` | optional | yes |
| `watch.reviewActions` | optional | — |
| `watch.backupIntervalSeconds` | optional | — |
| `watch.maxOpenPrs` | optional | — |
| `watch.maxWorkers` | optional | — |
| `watch.workerBudgetMinutes` | optional | — |
| `watch.maxTurns` | optional | — |
| `watch.unknownEscalateSeconds` | optional | — |
| `watch.staleSeconds` | optional | yes |
| `watch.intervalSeconds` | optional | — |
| `tools.codeHealth` | optional | yes |
| `measured.review.window` | optional | yes |
| `measured.review.correctnessSharePct` | optional | — |
| `measured.review.dataIntegritySharePct` | optional | — |
| `measured.review.roundsSmall` | optional | yes |
| `measured.review.roundsLarge` | optional | yes |
| `measured.review.topCriticalReviewer` | optional | yes |
| `measured.review.topCriticalCount` | optional | — |
| `measured.review.totalCriticalCount` | optional | — |

## Keys

Only keys carrying a description appear below; the index above is complete.

### `identity.key`

**required**

owner/repo from the REMOTE, never the path

### `identity.prHost`

**optional**

4re: PRs and the checkout are different repos

### `identity.baseBranch`

**optional**

rext promotes feature -> stage -> main

### `identity.checkout`

**optional**

The main clone. A worktree is created FROM it, and it cannot be derived from worktreeRoot -- they are siblings by convention, not by rule.

### `ci.appSlug`

**optional**

Which App publishes this project's CI. Used to decide when the provider has FINISHED, which is the only honest way to call a required check absent -- other apps' suites were measured parking at queued indefinitely.

### `ci.provider`

**required**

"github-actions" | "none"

### `ci.requiredChecks`

**optional**

LITERAL names: matrix names expand at runtime

### `ci.reviewerStatusContexts`

**optional**

Commit-status contexts published by REVIEWERS. Excluded from check classification entirely: a rate-limited CodeRabbit reports state=success with the truth in the description, so a reviewer's status read as CI is a fail-open by construction. These rows still reach the review pipeline, which can say "refused"; classification only knows how to say "passing".

### `merge.method`

**required**

MEASURED from parent counts, not settings

### `risk.sensitivePaths`

**optional**

migrations, auth, secrets, release metadata

### `risk.quarantinePaths`

**optional**

never touched: prod dumps, other clients' creds

### `risk.forbiddenCommands`

**optional**

db:migrate:fresh, store submit, publish

### `risk.testPaths`

**optional**

Where this project's tests live, when the built-in globs do not fit it. A repair whose whole diff lands in here changed the exam rather than the code.

### `builder.capabilities.observe`

**optional**

The builder's capability switches. Authority is never inferred from the repository fields above: the live nextly profile already carries authority.policy=propose_and_merge, so that key cannot gate anything new. Five independent booleans, every one false until the rollout stage that proves it turns it on. A truthy string is refused, not coerced.

### `builder.founder.userId`

**optional**

The founder's GitHub identity, by immutable numeric id with the login as a snapshot: every founder-event rule (silence, overrides, approvals) matches the id, and a renamed login must not silently become a stranger.

### `builder.cancel.drainMinutes`

**optional**

How long a cancelling task's effects get to reconcile before `cancel --force` becomes available. A forced cancel is the one terminal transition whose external truth was never confirmed, so it must not be reachable before the reconcilers have had a window at all.

### `builder.budgets`

**optional**

Per-action budgets for the phases a worker is dispatched for.  ONE KEY, NOT EIGHTEEN, and that is a property of the validator rather than a style choice. `validate`'s unknown-key sweep waves through any leaf beneath a declared key -- `[...known].some(k => p.startsWith(k + "."))` -- so declaring `builder.budgets.BUILD_SIZE.budgetMinutes` and its siblings would make `builder.budgets.BUILD_NOPE.budgetMinutes` a leaf under a known prefix and accept it silently. The action names and the field names are refused INSIDE this validator or they are not refused at all.

### `worker.maxOutputBytes`

**optional**

Cap on a worker's durable stdout/stderr files. Read by both daemons.

### `worker.isolation`

**optional**

How a dispatched worker is isolated from the founder's account. "none" (default) means a shared account and a linked worktree: a worker could read a keychain credential the probe does not know about, or plant a hook in the checkout's shared git dir. "dedicated-user" asserts the founder has set up a separate OS user (its own empty keychain) and per-run standalone clones; ONLY then does a passing canary plus an empty keychain close dispatch.

### `worker.dependencyPaths`

**optional**

The dependency trees to copy into a run checkout, RELATIVE to the checkout. A worker has no network and no home cache, so a project whose dependencies this cannot infer from its languages has no other way to be given them -- and an override the loader REJECTS is not an override at all. (Codex #5-[9].)

### `builder.network.research.allowedDomains`

**optional**

The only network a worker's shell may reach, and only for research: the OS sandbox denies every domain for every other action. A bare host name, no scheme, no path: the runtime matches domains, and "https://x" matches nothing.

### `notify.provider`

**optional**

Read by the daemon and the watcher. Declared here because the validator refused a profile using them and `reeve doctor` exited before doing anything: code that reads undeclared config is config that drifts from its schema unnoticed. See daemon.mjs (maxWorkers, workerBudgetMinutes, maxTurns) and watcher.mjs (unknownEscalateSeconds). OFF until review ingest exists. With it on, reeve can dispatch review actions whose data model is incomplete -- see the gate in watcher.mjs. Where an escalation goes when nobody is watching the log. Only escalations are ever sent: an over-pushing channel gets muted, and a muted channel is worse than none.

### `notify.desktop`

**optional**

A native notification on the machine reeve runs on, alongside the phone rather than instead of it. The two exist for different moments: the phone for when nobody is at the desk, this for when somebody is. It also cannot be blocked by a remote server nobody can log into, which is the state the ntfy READ credential has been in since the beginning.

### `watch.staleSeconds`

**optional**

How old evidence may be before a clause refuses to answer from it. Defaulted rather than optional: an unset staleness bound is an INFINITE one, and a gate that will answer from evidence of any age is not a freshness gate.

### `tools.codeHealth`

**optional**

fallow is JS-only; Python needs ruff+vulture

### `measured.review.window`

**optional**

What this project's own review history measured, rendered into worker prompts by prompts.mjs. Lives in the profile because the numbers are ONE project's numbers: baked into the core they would speak with authority to every other project too. All optional -- a partial measurement renders only the bullets its figures support, and no measurement renders nothing.

### `measured.review.roundsSmall`

**optional**

avg review rounds at <=10 changed files

### `measured.review.roundsLarge`

**optional**

avg review rounds above ~10 files

### `measured.review.topCriticalReviewer`

**optional**

who actually files the criticals here

## Examples

One per project kind, GENERATED by applying the validator's own defaults to the
12 keys an operator must author. A test runs `validate()` over each, so an
example here is one the loader accepts rather than one that merely looks right.

Everything beyond those authored keys is what `withDefaults()` fills in, which is
why the two differ: the defaults are per project kind.

### `product`

```json
{
  "project": {
    "kind": "product"
  },
  "schemaVersion": 1,
  "identity": {
    "key": "acme/widget",
    "defaultBranch": "main",
    "visibility": "private"
  },
  "authority": {
    "permission": "admin",
    "policy": "owner",
    "profileLocation": "committed"
  },
  "state": {
    "mode": "in-repo"
  },
  "units": [
    {
      "id": "app",
      "root": ".",
      "language": "typescript"
    }
  ],
  "ci": {
    "provider": "github-actions"
  },
  "merge": {
    "method": "squash",
    "enforcement": "enforced"
  },
  "watch": {
    "staleSeconds": 900
  },
  "builder": {
    "capabilities": {
      "observe": false,
      "draftSpec": false,
      "implementLocal": false,
      "publishPr": false,
      "mergeBuilderPr": false
    },
    "cancel": {
      "drainMinutes": 30
    }
  },
  "worker": {
    "maxOutputBytes": 67108864,
    "isolation": "none"
  },
  "rounds": {
    "softCap": 5,
    "hardCap": 10,
    "maxFixAttemptsPerFinding": 1
  }
}
```

### `client`

```json
{
  "project": {
    "kind": "client"
  },
  "schemaVersion": 1,
  "identity": {
    "key": "acme/widget",
    "defaultBranch": "main",
    "visibility": "private"
  },
  "authority": {
    "permission": "admin",
    "policy": "owner",
    "profileLocation": "sidecar",
    "forbiddenActions": [
      "sign-cla",
      "bypass-ruleset",
      "force-push-shared",
      "resolve-others-threads"
    ]
  },
  "state": {
    "mode": "in-repo"
  },
  "units": [
    {
      "id": "app",
      "root": ".",
      "language": "typescript"
    }
  ],
  "ci": {
    "provider": "github-actions"
  },
  "merge": {
    "method": "squash",
    "enforcement": "enforced"
  },
  "watch": {
    "staleSeconds": 900
  },
  "builder": {
    "capabilities": {
      "observe": false,
      "draftSpec": false,
      "implementLocal": false,
      "publishPr": false,
      "mergeBuilderPr": false
    },
    "cancel": {
      "drainMinutes": 30
    }
  },
  "worker": {
    "maxOutputBytes": 67108864,
    "isolation": "none"
  },
  "rounds": {
    "softCap": 3,
    "hardCap": 5,
    "maxFixAttemptsPerFinding": 1
  }
}
```
