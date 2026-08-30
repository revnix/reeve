# PLAN for V6: the headless-versus-interactive subscription pool

**Status: PLAN, not a measurement.** Nothing here has been run. Written first because
the first version of it was wrong in eight ways, and a badly designed probe answers a
different question convincingly.

Date written: 2026-08-31. Host: macOS (Darwin 25.6), founder account.
CLI 2.1.246 (`claude --version`, read 2026-08-31).

This satisfies **V6** in `tasks/reeve-tasks/trackers/s3.md`, whose obligation is
assigned to **T16** in the builder lane. It is written here because arming waits on
the answer and T16 is far down the S3 chain; whether it lands as part of T16 or
separately is a coordination question, not a technical one.

## The question

> Does a headless `claude -p` worker consume the same allowance as the founder's
> interactive Claude Code session?

## WHAT THE FIRST DRAFT GOT WRONG, recorded because the errors are the design

**It did not reproduce the worker's credential.** `src/workerenv.mjs:131-149` REFUSES
a worker that would run under the founder's home, and REQUIRES an `oauthToken` which
it injects as `CLAUDE_CODE_OAUTH_TOKEN` — read from `~/.reeve/claude-token`. A bare
`claude -p` from the founder's shell authenticates from the ambient `~/.claude`
instead. That probe would have measured the interactive credential AGAINST ITSELF and
reported "shared" for a reason with nothing to do with pools.

**It had no interactive arm at all.** V6's corrected criterion (Q7, 2026-08-28) is
explicit: one arm is a REAL INTERACTIVE session with a headless-only run as its
control. The first draft read an allowance before and after a headless burst, which
cannot establish that the display responds to a comparable interactive prompt.

**It labelled an unchanged allowance `SEPARATE`** while the same document
acknowledged that a shared pool with headroom, or a display without resolution for
three small runs, produces exactly that observation. It contradicted itself in one
file, and the contradiction pointed at the outcome that makes arming look safe.

**It could not tell an acceleration limit from a pool limit.** A sequential burst can
start failing from rate limiting or a transient headless error while the interactive
allowance is untouched — the same observation it labelled `SEPARATE`. V6 retains a
jitter ramp for precisely this reason.

**It inferred concurrency from sequential probes.** Every invocation was sequential,
so the probe never exercised simultaneous workers and cannot inform
`concurrencyLimit`. The draft said a generous result would permit raising it, and
also said it reached no conclusion about concurrency. Both cannot be true.

**It made `guardianReserved` conditional on the interactive answer.** The guardian and
the builder BOTH dispatch headless workers and contend with each other
(`docs/2026-08-21-builder-design.md:564-571`, `src/build/providerdb.mjs:24-31`).
That reservation is load-bearing whatever the interactive answer is.

**It bounded the burst but not the runs.** A fixed count of invocations is not a
bounded spend when no invocation has a turn, wall-clock or dollar cap.

**It cited the wrong dispatch.** `docs/measured/2026-08-23-three-real-dispatches.md`
reports $0.758, $0.910 and $0.994; the $0.42 / 16-turn / 61-second run is in
`docs/TRACKER.md`.

## Design

### The fixture must be a real worker environment

Not a scratch directory and a settings file. The probe builds its environment through
`workerEnv()` itself — scratch HOME, the token from `~/.reeve/claude-token`, the
shims, the stripped variables — so that what is measured is the credential reeve
actually spends. Using the helper rather than reconstructing it is the point: a
reconstruction is a second inventory of the boundary and would drift from it.

### Two arms, and the interactive one is not optional

| arm | what runs | credential |
|---|---|---|
| **A: interactive** | the founder works a comparable prompt in a normal session | ambient `~/.claude` |
| **B: headless control** | the same prompt through `workerEnv()` | `~/.reeve/claude-token` |

Reading an allowance around arm B alone cannot establish that the display responds to
interactive work at all. Arm A calibrates the instrument; arm B is the question.

### Every invocation is capped

`--max-turns` and `--max-budget-usd` on each run, both recorded. `src/supervisor.mjs`
already passes both. A count of runs is not a bound.

### The ramp is jittered

Invocations are spaced with jitter rather than fired back to back, so an acceleration
limit is not read as a pool limit. Every non-zero exit records its reason, and
429/acceleration/transient failures are classified SEPARATELY from a refusal to serve.

### Outcomes, and what each may and may not conclude

| observation | reading | may NOT conclude |
|---|---|---|
| interactive allowance moves with arm B | **SHARED** | nothing about safe concurrency |
| interactive allowance unchanged | **INCONCLUSIVE** | not "separate" — a shared pool with headroom, or a display too coarse, gives the same picture |
| arm B fails while interactive is untouched | **INCONCLUSIVE until the health control below runs** | acceleration limiting, an expired token and a network outage all look identical here |
| both degrade together | **SHARED** | nothing about safe concurrency |

**No outcome permits raising `concurrencyLimit`.** Every invocation here is
sequential; simultaneous workers are never exercised.

**No outcome changes `guardianReserved`.** That reservation is about two daemons
contending for headless capacity and is independent of the interactive answer.

### A failure needs an INDEPENDENT control, not a repeat

Repeating the same headless invocation after a failure cannot distinguish an exhausted
headless pool from a persistent authentication, network or CLI fault: the second run
fails in both cases, and the first draft used exactly that repeat as its final control.
A control that fails for the same reason as the thing it controls is not a control.

So a failure in arm B triggers three probes, and each answers something the others
cannot:

1. **Is the CLI reachable at all?** A version query, which touches no allowance. A
   failure here says the fault is not about quota.
2. **Is the worker's credential still valid?** The cheapest authenticated call that
   does not consume the pool under test. A failure here says the token expired or was
   revoked, which is indistinguishable from exhaustion by exit code alone.
3. **Does it recover after a cooldown?** Recovery says acceleration limiting rather
   than a pool floor. Continued failure with 1 and 2 both healthy is the only shape
   that points at exhaustion.

**None of the three permits a `SEPARATE` reading on its own.** They exist to say what
the failure was NOT, which is the honest limit of a failure observed once.

### Where the result goes

`provider_state` columns with `measured_at`, per V6 — **not** profile keys, which
`FIELDS` would reject (D22).

## What this does NOT establish

- **Not a concurrency limit.** Sequential probes cannot expose concurrency- or
  acceleration-dependent throttling.
- **Not a stable relationship.** One account, one day, one CLI build. A later build
  could change it silently, so anything written from it carries the date and version.
- **Not "separate pools" from a negative.** An unchanged allowance is consistent with
  separate pools AND with a shared pool whose headroom exceeds the probe. The honest
  response to a negative is a calibrated larger burst, never a conclusion.
- **Not the builder's contention with the guardian.** Different question, different
  measurement, and the scheduler's reservation stands regardless.

## What is needed from the founder

1. **A quiet window**, with no other interactive use, or arm A contaminates itself.
2. **Two readings of the interactive allowance**, verbatim, with wall-clock times —
   allowances refill on a schedule and a movement across a boundary is not consumption.
3. **Agreement on the caps and the burst size** before anything runs.
