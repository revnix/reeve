# The six Stage-3 plans

These specify the sixteen S3 tasks. They are committed **as written on 2026-08-27**, not
corrected in place, so that what an executor was told stays readable beside what turned out
to be true.

**Read this file before executing any of them.**

## Why they are here

They previously existed in one working directory: no history, no backup, no review. Three of
their stated premises were found wrong on 2026-08-30 while executing against them, and a
fourth was found wrong only under test. A specification that can rot with nothing to show the
rot is the failure this repository keeps paying for, so they are versioned like anything else.

`MASTER-PLAN.md`, `S3-DESIGN-BRIEF.md`, the handoffs and the trackers were already here; only
the stage plans were not.

## Known-wrong statements, measured against the code

Each row was verified by running the command in the last column, not by reading. Every one
fails **closed and silently** if the plan is followed literally, which is why they are listed
rather than left to be rediscovered.

| plan | says | actually | how it was established |
|---|---|---|---|
| S3-B consumed table | `capabilitiesFrom` returns bare names (`{observe, …}`) | returns FULL key strings (`builder.capabilities.observe`), and `{}` for a profile that declares none, because absence is deliberately preserved | `grep -n 'export function capabilitiesFrom' -A10 src/build/capabilities.mjs` |
| S3-B consumed table | `registryProjects` lives in `src/build/registry.mjs` | that name is a local alias at `bin/reeve:138` for `loadRegistry`, which lives in `src/build/registryio.mjs`. `registry.mjs` exports no such symbol | `git grep -n registryProjects -- src bin` |
| S3-B consumed table | `registryIo({ home, fetch }) -> io` | `registryIo(home, project, entry, { fetchRepoId, spawn, connect })` — bound to ONE registry entry, not to the home | `grep -n 'export function registryIo' src/build/registryio.mjs` |
| S3-DESIGN-BRIEF §2.2 T2 | `io` carries **eight** members | it carries **nine**. `lsTree` is omitted from the brief, and `resolveClaims` treats it as a hard precondition — an eight-member `io` refuses every filing | compare `grep -oE 'io\.[a-zA-Z]+' src/build/registry.mjs \| sort -u` against `registryIo`'s returned object |
| S3-B Task 1 | stubbing the grammar turns **three** assertions red | the test file **aborts** at the first one: the id is undefined and binding it throws inside `node:sqlite`, so the run produces 10 assertion lines against the control's 14 and four assertions never run. In the log that is indistinguishable from those four passing | run the file against the stub the task names and compare `grep -c '^PASS\|^FAIL'` against the control run |

**The correct reader for a capability is `capabilityOn(profile, name)`**, which accepts either
key form and **throws** on a name the schema does not declare. `capabilitiesFrom(p)[k]`
returns `undefined` for an unknown key, and every gate in this system reads `!== true`, so a
typo there is refused rather than reported — fail-closed, and therefore invisible.

## Cross-plan contradictions, found in review of this pull request

The table above came from **executing** S3-A and the first tasks of S3-B. These came from
reviewing the plans against **each other**, which is a thing that could not happen while they
lived in one directory. Each was re-measured here before being recorded; the count columns are
the measurement, and every read was taken with a positive control so an unreadable file could
not report as a clean zero.

A plan that consumes a name its predecessor never produces fails at **module linking** — the
first test aborts before reaching an assertion, so the failure arrives as a stack trace in a
task whose own logic was never exercised.

| plans | the contradiction | measured |
|---|---|---|
| S3-C → S3-D | S3-D imports `AGENT_DEFS`; S3-C produces `AGENTS` and `agentsJson`. Neither name appears in the other document | `AGENTS`: 5 in S3-C, **0** in S3-D · `AGENT_DEFS`: **0** in S3-C, 8 in S3-D · `agentsJson`: 12 in S3-C, **0** in S3-D |
| S3-C → S3-D | S3-D's tests import `specFor` and drive dispatch from a `PHASE_SPECS` table. S3-C defines neither, and its `dispatchPhase` takes a fully constructed dispatch rather than consulting a registry | `PHASE_SPECS`: **0** in S3-C, 32 in S3-D · `specFor`: **0** in S3-C, 17 in S3-D |
| S3-B → S3-C | S3-B produces `writeArtifact({dir, phase, bytes}) -> {path, sha256, bytes}`. S3-C's consumed table writes `writeArtifact(dir, phase, bytes) -> {sha, path}`, and its crash drill calls it positionally and reads `.sha` | S3-B `:1141`; S3-C `:40`, and positional calls at `:2446`, `:2456` |
| S3-C → S3-E | S3-C creates builder provider leases with `runRef` as `<task>:<phase>`; S3-E matches `run_ref` against the task id alone, so a capacity-blocked task is never found and `WAITING_FOR_QUOTA` is never shown | S3-C `:1853` writes `bt:1:SIZING`; S3-E `:608` matches `run_ref='bt:q'` |
| S3-A → S3-E | `NEEDS_SWITCH` stores bare capability names and the lookup reads `capabilities.observe`, but `capabilitiesFrom` returns dotted keys — so every lookup is `undefined` and an enabled task renders as `WAITING_FOR_CAPABILITY` | same root as row 1 of the table above; the reader to use is `capabilityOn` |
| S3-A → S3-E | `reeve task dash` passes the registry loader's result straight to `dashModel`, which calls `projects.map(...)`. `loadRegistry` returns `{projects, registry, error}` — an object — so the call throws `TypeError` every time | `src/build/registryio.mjs:205-212`, verified against the merged code |
| — S3-F | V4's fan-out control runs `sh "$R/probe.sh"`, and nothing in the plan or the repository ever writes that file. `\|\| true` masks the missing-file failure, so the error log is parsed as the unsandboxed control and V4 produces a measurement of nothing | `probe.sh` appears 3 times in S3-F; exactly one is the execution at `:1131`, and none is a write |

**The S3-E `run_ref` row is the one to read twice.** S3-E's own fixture inserts the bare task
id, so its test passes against a lease shaped the way the test wrote it and would fail against
a lease shaped the way S3-C writes it. A fixture that describes a system which does not exist
is this repository's most expensive recurring defect, and it is here in a plan rather than in
code, which is the cheapest place it has ever been caught.

## Findings that are arguments rather than measurements

These came from the same review and are recorded unverified, because checking them requires
code that does not exist yet. They are **not** corroborated, and they are listed so the task
that reaches them starts by testing the claim rather than discovering it.

- **S3-C, P1.** Making `dispatch` fire-and-forget lets the surrounding `finally` release the
  provider lease while the detached worker is still running, so later ticks admit workers past
  the measured concurrency limit. The detached lifecycle would need to heartbeat and release
  only when the worker settles.
- **S3-C.** The adoption stub drops `lease_expires_at > now`, leaving `if (stillOurs)`, which
  adopts every live pid. The only worker present is one that is expected to be adopted, so the
  assertions stay green and the stub cannot exercise the kill-versus-adopt boundary. This is
  the same shape as the S3-B Task 1 row above, and it is the third instance in these documents
  of a mandatory stub loop that cannot fail.
- **S3-D.** The RESEARCH step declares `researchFindings` without calling it from
  `reviewArtifact`, computing the artifact sha, or converting the inherited `{ok, why,
  findings}` into the `{ok, refusal, findings, sha}` the assertions above it require.

## What this file does NOT establish

Only S3-A and the first task of S3-B have been executed. The rows above are what executing
those found. **S3-C, S3-D, S3-E and S3-F have never been run against the code**, and they
consume the same three interfaces that were wrong in S3-B's table. Their consumed-name tables
should be assumed stale in the same way and verified the same way, one row at a time, before
their first task. Absence from this list means not yet checked, never checked and correct.

The review that produced the second table read the plans against each other; it did **not**
execute them. A contradiction between two documents is cheap to see and was found. A plan
that is self-consistent and wrong about the CODE is not visible that way, and only S3-A and
the first tasks of S3-B have been checked that way so far.
