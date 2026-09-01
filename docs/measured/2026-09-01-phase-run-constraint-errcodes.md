# The three `phase_run` refusals are told apart by errcode, never by message

**Measured 2026-09-01** on node v24.17.0 (`~/.nvm/versions/node/v24.17.0/bin/node`)
against the schema `src/build/hub.sql` ships, at `main` = `eb0b181`.

## Why it was measured

`plans/2026-08-27-s3c-dispatch.md` Task 1 maps a failed insert to a caller's
refusal by matching SQLite's message:

```js
if (/UNIQUE constraint failed: index 'one_live_run'/.test(e.message))
  return { ok: false, reason: "live-run-exists" };
throw e;
```

`plans/README.md` recorded, unverified, that SQLite reports the constrained
columns rather than the index name. The code did not exist yet, so it could not
be checked. T6 is the task that writes it, so it was checked first.

## The probe

Run against a real hub, opened through `openHub` so the pragmas are the ones
the product sets — `PRAGMA foreign_keys` reads `1` here, and a probe on a
connection that left it `0` would answer a different question.

```js
import { openHub } from "./src/build/hubdb.mjs";
const db = openHub(hubPath);
const cols = "task,generation,phase,slice,attempt,status,started_at,heartbeat_at,lease_expires_at,out_path,err_path";
const ins = db.prepare(`INSERT INTO phase_run(${cols}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
const row = (t, a) => [t, 1, "RESEARCH", 0, a, "live", 1000, 1000, 1400, "/o", "/e"];

// no such task -- no `task` row for bt:nope
try { ins.run(...row("bt:nope", 1)); } catch (e) { report(e); }

// live-run-exists -- bt:a already has a live run at attempt 1
ins.run(...row("bt:a", 1));
try { ins.run(...row("bt:a", 2)); } catch (e) { report(e); }

// duplicate-attempt -- attempt 1 again, with the existing row SETTLED
db.exec("UPDATE phase_run SET status='succeeded' WHERE task='bt:a'");
try { ins.run(...row("bt:a", 1)); } catch (e) { report(e); }
```

## What it printed

```
foreign_keys pragma: {"foreign_keys":1}
FK message: "FOREIGN KEY constraint failed" errcode: 787
LIVE  : "UNIQUE constraint failed: phase_run.task" 2067
DUPATT: "UNIQUE constraint failed: phase_run.task, phase_run.generation, phase_run.phase, phase_run.slice, phase_run.attempt" 1555
```

| the fault | `message` | `errcode` |
|---|---|---|
| `no-such-task` | `FOREIGN KEY constraint failed` | 787 |
| `live-run-exists` | `UNIQUE constraint failed: phase_run.task` | 2067 |
| `duplicate-attempt` | `UNIQUE constraint failed: phase_run.task, phase_run.generation, phase_run.phase, phase_run.slice, phase_run.attempt` | 1555 |

## Three conclusions, in the order they matter

**The planned branch cannot fire.** No message names an index. A routine
refusal would have escaped `insertRun` as a raw SQLite error, and the tick
would have read a normal "another worker holds this task" as a hub fault.

**The message must not be matched at all, not even repaired.** The
primary-key text CONTAINS `phase_run.task` as a substring, so matching the
column — the repair anyone reaches for second — answers `live-run-exists` for
an attempt that was merely recorded twice. Those are opposite remedies: one
means wait or revoke, the other means the work is already recorded. The three
errcodes do not overlap and are a stable interface where the text is not.

**A first probe of mine said the errcode could not discriminate, and it was
wrong.** That probe re-inserted an attempt whose row was still `live`, which
violates the partial index AND the primary key at once; SQLite reports the
index, so both cases printed 2067 and the errcode looked useless. Measured one
constraint at a time it is not. The overlap case is real and answers 2067,
which is correct — a live run genuinely does exist — so the classifier needs no
special case, but the suite asserts that row explicitly. A mapping proven only
on inputs that break one rule at a time has never seen the overlap.

## Where it is used

`src/build/run.mjs` maps `787 → no-such-task`, `1555 → duplicate-attempt`,
`2067 → live-run-exists`. `test/phase-run.test.mjs` asserts all three plus the
overlap, and `test/stub-manifest.mjs` carries
`run-refusals-are-told-apart-by-errcode`, whose stub restores the plan's regex.
