// The profile schema: everything about a project the core must not assume.
//
// Every field here exists because a measured repo in this portfolio contradicted
// a hard-coded assumption in the previous system. The comment on each says which.
// A field with no such story does not belong here; it belongs in code.
//
// Validation is fail-closed. An unknown key, a bad enum, or a missing required
// field refuses the profile rather than falling back to a default, because a
// silently-defaulted profile is how a gate ends up judging the wrong thing.

export const SCHEMA_VERSION = 1;

/** Command state. A command that is declared but broken must not read as present. */
export const COMMAND_STATE = ["present", "absent", "broken", "advisory"];
// "broken": upkit-extension declares `eslint .` with eslint neither installed nor configured.
// "advisory": rext marks lint/test/security continue-on-error, so they report success regardless.

export const PROJECT_KIND = ["product", "client"];
// product: fast MVP, discovery loop active, higher autonomy ceiling.
// client:  quality and best practice always, lower ceiling, no artifacts committed.

export const AUTHORITY_POLICY = ["owner", "propose_and_merge", "propose_and_wait", "propose_only"];
// May sit BELOW the detected permission. Admin on ComfyUI is real, but its
// unreviewed-merge detector files a compliance issue, so CAN is not MAY.

export const PROFILE_LOCATION = ["committed", "sidecar"];
// sidecar is the default: 4 of 10 repos must carry no agent artifacts at all.

export const STATE_MODE = ["in-repo", "sibling", "hub"];
export const ENFORCEMENT = ["enforced", "attested"];
// attested: private repos on a free plan return HTTP 403 for both branch
// protection and rulesets, so no server rule is possible and the boundary
// degrades to a local gate plus a tamper-evident record.
export const REVIEWER_KIND = ["blocking", "advisory"];
export const MERGE_METHOD = ["squash", "merge", "rebase"];

/**
 * field: [required, validator, description]
 * Validators return null when valid, or a string explaining the refusal.
 */
const isStr = v => (typeof v === "string" && v.length ? null : "must be a non-empty string");
const isBool = v => (typeof v === "boolean" ? null : "must be a boolean");
const isInt = v => (Number.isInteger(v) ? null : "must be an integer");
const isArr = inner => v => {
  if (!Array.isArray(v)) return "must be an array";
  for (const [i, x] of v.entries()) { const e = inner(x); if (e) return `[${i}] ${e}`; }
  return null;
};
const oneOf = list => v => (list.includes(v) ? null : `must be one of ${list.join(" | ")}`);
// A path a daemon will hand to spawn() must not depend on who started the daemon.
// Every profile written before this check set worktreeRoot relatively, and under
// launchd "../nextly-worktrees" resolved from the daemon's WorkingDirectory to a
// directory that does not exist.
const isAbsPath = v => (typeof v === "string" && v.startsWith("/")
  ? null
  : "must be an absolute path: a relative one resolves against whatever directory the daemon was started in");
const optional = f => v => (v === undefined || v === null ? null : f(v));

const COMMAND = v => {
  if (typeof v !== "object" || v === null) return "must be an object";
  const e = oneOf(COMMAND_STATE)(v.state);
  if (e) return `state ${e}`;
  if (v.state === "present" && !v.cmd) return "state 'present' requires cmd";
  return null;
};

const UNIT = v => {
  if (typeof v !== "object" || v === null) return "must be an object";
  for (const k of ["id", "root", "language"]) { const e = isStr(v[k]); if (e) return `${k} ${e}`; }
  // packageManager is AUTO from the lockfile EXCEPT where two lockfiles disagree:
  // 21century tracks package-lock.json (nextly alpha.20) AND pnpm-lock.yaml (alpha.30).
  const e = optional(isStr)(v.packageManager); if (e) return `packageManager ${e}`;
  // toolPins is not optional in spirit: ruff 0.13.0 finds 14 errors on ranknaut
  // where 0.16.3 finds 151. An unpinned linter is a verdict that moves on its own.
  if (v.toolPins !== undefined && (typeof v.toolPins !== "object" || v.toolPins === null))
    return "toolPins must be an object of tool -> exact version";
  if (v.commands !== undefined) {
    if (typeof v.commands !== "object" || v.commands === null) return "commands must be an object";
    for (const [name, c] of Object.entries(v.commands)) { const ce = COMMAND(c); if (ce) return `commands.${name} ${ce}`; }
  }
  return null;
};

const REVIEWER = v => {
  if (typeof v !== "object" || v === null) return "must be an object";
  for (const k of ["login", "kind"]) { const e = isStr(v[k]); if (e) return `${k} ${e}`; }
  const e = oneOf(REVIEWER_KIND)(v.kind); if (e) return `kind ${e}`;
  // refusal is required on every reviewer: a rate-limited CodeRabbit reports
  // state=success, and an uninstalled Greptile reports nothing at all. Both are
  // byte-identical to "found no problems" unless something counts refusals.
  const r = isStr(v.refusal); if (r) return `refusal ${r} (required: absence must be distinguishable from approval)`;
  return null;
};

const LANE = v => {
  if (typeof v !== "object" || v === null) return "must be an object";
  const e = isStr(v.id); if (e) return `id ${e}`;
  // Territories are GLOBS, not regexes. The previous system used regexes over
  // packages/*, which matched 3 of 10 repos and left 32 of 93 tasks unroutable.
  const t = isArr(isStr)(v.territory); if (t) return `territory ${t}`;
  return null;
};

export const FIELDS = {
  schemaVersion:            [true,  isInt],
  "project.kind":           [true,  oneOf(PROJECT_KIND)],
  "identity.key":           [true,  isStr],            // owner/repo from the REMOTE, never the path
  "identity.prHost":        [false, isStr],            // 4re: PRs and the checkout are different repos
  "identity.defaultBranch": [true,  isStr],
  "identity.baseBranch":    [false, isStr],            // rext promotes feature -> stage -> main
  "identity.visibility":    [true,  oneOf(["public", "private"])],
  "identity.worktreeRoot":  [false, isAbsPath],
  "identity.cloneStrategy": [false, oneOf(["full", "blobless", "treeless", "shallow"])],

  "authority.permission":   [true,  oneOf(["admin", "write", "triage", "read"])],
  "authority.policy":       [true,  oneOf(AUTHORITY_POLICY)],
  "authority.profileLocation": [true, oneOf(PROFILE_LOCATION)],
  "authority.forbiddenActions": [false, isArr(isStr)],

  "state.mode":             [true,  oneOf(STATE_MODE)],
  "state.location":         [false, isStr],

  "units":                  [true,  isArr(UNIT)],
  "lanes":                  [false, isArr(LANE)],

  // Which App publishes this project's CI. Used to decide when the provider has
  // FINISHED, which is the only honest way to call a required check absent --
  // other apps' suites were measured parking at queued indefinitely.
  "ci.appSlug":            [false, isStr],
  "ci.provider":            [true,  isStr],            // "github-actions" | "none"
  "ci.requiredChecks":      [false, isArr(isStr)],     // LITERAL names: matrix names expand at runtime
  "ci.flakePatterns":       [false, isArr(isStr)],

  "merge.method":           [true,  oneOf(MERGE_METHOD)],  // MEASURED from parent counts, not settings
  "merge.deleteBranch":     [false, isBool],
  "merge.enforcement":      [true,  oneOf(ENFORCEMENT)],

  "reviewers":              [false, isArr(REVIEWER)],
  "rounds.softCap":         [false, isInt],
  "rounds.hardCap":         [false, isInt],
  "rounds.maxFixAttemptsPerFinding": [false, isInt],

  "risk.sensitivePaths":    [false, isArr(isStr)],     // migrations, auth, secrets, release metadata
  "risk.quarantinePaths":   [false, isArr(isStr)],     // never touched: prod dumps, other clients' creds
  "risk.forbiddenCommands": [false, isArr(isStr)],     // db:migrate:fresh, store submit, publish

  // Read by the daemon and the watcher. Declared here because the validator
  // refused a profile using them and `reeve doctor` exited before doing anything:
  // code that reads undeclared config is config that drifts from its schema
  // unnoticed. See daemon.mjs (maxWorkers, workerBudgetMinutes, maxTurns) and
  // watcher.mjs (unknownEscalateSeconds).
  "watch.maxWorkers":            [false, isInt],
  "watch.workerBudgetMinutes":   [false, isInt],
  "watch.maxTurns":              [false, isInt],
  "watch.unknownEscalateSeconds":[false, isInt],
  "watch.intervalSeconds":       [false, isInt],

  "tools.codeHealth":       [false, isArr(isStr)],     // fallow is JS-only; Python needs ruff+vulture
};

/** Defaults applied by project kind, so the mode is a table rather than a judgment. */
export const KIND_DEFAULTS = {
  product: {
    "rounds.softCap": 5, "rounds.hardCap": 10, "rounds.maxFixAttemptsPerFinding": 1,
    "authority.profileLocation": "committed",
  },
  client: {
    "rounds.softCap": 3, "rounds.hardCap": 5, "rounds.maxFixAttemptsPerFinding": 1,
    "authority.profileLocation": "sidecar",
    "authority.forbiddenActions": ["sign-cla", "bypass-ruleset", "force-push-shared", "resolve-others-threads"],
  },
};

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function flatten(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    // Arrays and leaves are terminal; only plain objects recurse.
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, p, out);
    else out.add(p);
  }
  return out;
}

/**
 * Validate a profile. Returns {ok, errors[], warnings[]}.
 * Refuses unknown keys: a typo that silently does nothing is how a lane ends up
 * with no territory and a gate ends up judging a check name that never reports.
 */
export function validate(profile) {
  const errors = [];
  const warnings = [];

  if (profile == null || typeof profile !== "object") return { ok: false, errors: ["profile is not an object"], warnings };
  if (profile.schemaVersion !== SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(profile.schemaVersion)}`);

  for (const [path, [required, check]] of Object.entries(FIELDS)) {
    const v = get(profile, path);
    if (v === undefined || v === null) {
      if (required) errors.push(`${path} is required`);
      continue;
    }
    const e = check(v);
    if (e) errors.push(`${path} ${e}`);
  }

  // Unknown keys are refused, not ignored.
  const known = new Set(Object.keys(FIELDS));
  const containers = new Set();
  for (const k of known) { const parts = k.split("."); for (let i = 1; i < parts.length; i++) containers.add(parts.slice(0, i).join(".")); }
  for (const p of flatten(profile)) {
    if (known.has(p)) continue;
    // A leaf under a known array/object field (units[0].id, reviewers[1].login) is fine.
    if ([...known].some(k => p.startsWith(k + "."))) continue;
    if (containers.has(p)) continue;
    errors.push(`unknown key: ${p}`);
  }

  // Cross-field rules that individual validators cannot see.
  const kind = get(profile, "project.kind");
  const loc = get(profile, "authority.profileLocation");
  const vis = get(profile, "identity.visibility");
  if (kind === "client" && loc === "committed")
    errors.push("project.kind 'client' forbids authority.profileLocation 'committed': no agent artifacts in a client repo");
  if (vis === "public" && loc === "committed")
    warnings.push("a committed profile in a public repo is visible to everyone; sidecar is the safer default");

  const perm = get(profile, "authority.permission");
  const pol = get(profile, "authority.policy");
  if (perm && pol) {
    const rank = { read: 0, triage: 1, write: 2, admin: 3 };
    const need = { propose_only: 0, propose_and_wait: 2, propose_and_merge: 3, owner: 3 };
    if (rank[perm] < need[pol])
      errors.push(`authority.policy '${pol}' needs at least ${Object.entries(rank).find(([, r]) => r === need[pol])?.[0]} permission, but permission is '${perm}'`);
  }

  const soft = get(profile, "rounds.softCap");
  const hard = get(profile, "rounds.hardCap");
  if (soft != null && hard != null && hard < soft)
    errors.push(`rounds.hardCap (${hard}) must be >= rounds.softCap (${soft})`);

  // A blocking reviewer that cannot be probed cannot gate anything.
  for (const r of get(profile, "reviewers") ?? []) {
    if (r.kind === "blocking" && !r.trigger)
      warnings.push(`reviewer ${r.login} is blocking but has no trigger: it can never be re-requested at a new head`);
  }

  if ((get(profile, "ci.provider") ?? "none") === "none" && (get(profile, "ci.requiredChecks") ?? []).length)
    errors.push("ci.requiredChecks is set but ci.provider is 'none'");

  for (const c of get(profile, "ci.requiredChecks") ?? []) {
    // Matrix job names expand at runtime, so a required context containing ${{ }}
    // can never be satisfied. Measured live: "Scaffold smoke (${{ matrix.os }})".
    if (c.includes("${{")) errors.push(`ci.requiredChecks contains an unexpanded matrix expression: ${c}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Apply kind defaults for fields the profile left unset. Never overrides. */
export function withDefaults(profile) {
  const kind = get(profile, "project.kind");
  const defaults = KIND_DEFAULTS[kind] ?? {};
  const out = structuredClone(profile);
  for (const [path, value] of Object.entries(defaults)) {
    if (get(out, path) !== undefined) continue;
    const parts = path.split(".");
    let node = out;
    for (const k of parts.slice(0, -1)) node = node[k] ??= {};
    node[parts.at(-1)] = value;
  }
  return out;
}
