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

## What this file does NOT establish

Only S3-A and the first task of S3-B have been executed. The rows above are what executing
those found. **S3-C, S3-D, S3-E and S3-F have never been run against the code**, and they
consume the same three interfaces that were wrong in S3-B's table. Their consumed-name tables
should be assumed stale in the same way and verified the same way, one row at a time, before
their first task. Absence from this list means not yet checked, never checked and correct.
