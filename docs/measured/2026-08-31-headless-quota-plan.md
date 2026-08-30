# PLAN: does headless `claude -p` draw on the same allowance as an interactive session?

**Status: PLAN, not a measurement.** Nothing here has been run. It is written first
because the answer changes three decisions and a badly designed probe would answer a
different question convincingly.

Date written: 2026-08-31. Host: macOS (Darwin 25.6), founder account.
CLI 2.1.246 (`claude --version`, read 2026-08-31).

## Why this exists

`src/profile/schema.mjs:351` already states the gap, and states it honestly:

> Whether headless and interactive usage draw from one pool is account-specific and
> is MEASURED before it is chosen; the defaults are the design's stated interim
> values and carry no measurement date until a real run writes one.

So `builder.provider.concurrencyLimit` and `builder.provider.guardianReserved` are
**guesses wearing the appearance of settings**. `docs/2026-08-21-builder-design-audit.md:213`
says the same thing from the other direction and cites the CLI's headless
documentation.

## What is already known, and is NOT the question

Measured previously, or read from the code today:

| fact | where |
|---|---|
| a worker is `claude -p … --output-format stream-json --verbose` | `src/supervisor.mjs:132` |
| per-run cost and the full usage object are already captured | `src/supervisor.mjs:456-457` |
| authentication is `CLAUDE_CODE_OAUTH_TOKEN`, the subscription | `src/workerenv.mjs:23` |
| `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are STRIPPED, never passed | `src/workerenv.mjs:67` |
| one real dispatch cost $0.42 over 16 turns in 61s | `docs/measured/2026-08-23-three-real-dispatches.md` |

**Cost is not the unknown.** Reeve can already say what a run costs in dollars. The
unknown is whether spending that costs the founder *their own session*.

## The question, stated so it can only have one answer

> Does a headless `claude -p` invocation consume the same rate-limit allowance as the
> founder's interactive Claude Code session?

Three outcomes, each changing a different decision:

- **SHARED** — reeve competes with the founder. `guardianReserved` becomes load-bearing,
  and arming needs an opinion about *when* reeve may run.
- **SEPARATE** — the scheduler in S3 is solving a smaller problem than assumed, and
  arming `--execute` is materially safer than it looks today.
- **SHARED BUT GENEROUS** — the interim concurrency values can be raised off their guesses.

## THE CONSTRAINT THAT SHAPES EVERYTHING BELOW

**The CLI exposes no usage, quota, limits or billing subcommand.** Measured
2026-08-31 against 2.1.246: `claude --help` lists `agents, auth, auto-mode, doctor,
gateway, import, install, mcp, plugin, project, setup-token, ultrareview, update`,
and a case-insensitive search for a usage/limits/quota/billing command returns zero.
The only budget-shaped flag is `--max-budget-usd`, which BOUNDS a run rather than
reporting what remains.

So there is no machine-readable "remaining allowance" to sample. The measurement is
therefore **observational and needs the founder**, and that is a property of the
tooling rather than a shortcut being taken.

## What this does NOT require

**It does not require arming `--execute`.** A worker is `claude -p` with a settings
file; that invocation can be made directly, outside the daemon, with a throwaway
prompt in a scratch directory. No dispatch, no daemon change, no repository touched.

That ordering is deliberate. Arming should be decided USING this measurement, so the
measurement must not presuppose it.

## Design

### Fixture

```
~/reeve-quota-probe/          scratch, outside every repository
  settings.json               minimal; no tools granted beyond what a no-op needs
  PROMPT                      a fixed trivial prompt, identical on every run
```

The prompt must be trivial and CONSTANT. A prompt whose difficulty varies makes the
consumption vary, and the reading would then be about the prompt.

### Probes

1. **Control — the invocation works at all.** One headless run, exit code and
   `total_cost_usd` recorded. If this fails, everything after it is measuring a
   broken invocation, and the run stops here.
2. **The founder reads their interactive allowance BEFORE.** Recorded verbatim: what
   the session reports, and the wall-clock time of reading it.
3. **A bounded burst of headless runs**, sequential, count fixed in advance, each
   recording exit code, cost and turns.
4. **The founder reads their interactive allowance AFTER**, and the wall-clock time.
5. **A second control**, run last: one more headless invocation, to establish the
   headless path still works. A burst that exhausted a headless-only pool would
   otherwise be indistinguishable from one that exhausted a shared pool.

### What each outcome looks like

| observation | reading |
|---|---|
| interactive allowance moves by roughly the burst's size | SHARED |
| interactive allowance unchanged, headless runs all succeed | SEPARATE |
| interactive unchanged, headless runs start failing | SEPARATE, and the headless pool is the smaller one |
| both degrade together | SHARED |

### Controls this design needs, and why each

- **The trivial prompt is constant.** Otherwise the burst's cost is a property of the
  prompts and not of the pool.
- **A before AND an after reading of the interactive allowance.** One reading is a
  number, not a change.
- **The wall-clock time of both readings.** Allowances refill on a schedule; a
  movement across a refill boundary is not evidence of consumption.
- **The final headless control.** Without it, "the burst stopped working" cannot be
  told apart from "the burst exhausted the thing being measured".
- **The founder does nothing interactive during the burst.** Their own usage would
  move the number this is reading.

## WHAT IS NEEDED FROM THE FOUNDER

Three things, and only the first is a decision:

1. **Say when.** The burst must run in a window where no interactive session is being
   used, or the reading is contaminated.
2. **Read the interactive allowance twice** — before and after — and paste both
   verbatim. I cannot see it; it is in your session, not in any file I can read.
3. **Agree a burst size.** I would suggest starting SMALL: three runs of a trivial
   prompt. Enough to move a number if the pool is shared, cheap enough that a wrong
   guess about the pool costs almost nothing. It can be repeated larger if three
   moves nothing detectable.

## What is deliberately not in this plan

- **No arming.** Not needed, and it would confound the reading with dispatch behaviour.
- **No production repository.** The probe runs in a scratch directory with a throwaway
  prompt.
- **No conclusion about concurrency limits.** Those are a separate decision this
  measurement INFORMS; writing them here would be inventing the answer before the run.

## Honest limits of what this can establish

It measures ONE account on ONE day against ONE CLI build. It cannot establish that
the relationship is stable across builds or plan changes, and a later CLI could
change it silently. Anything written from it should carry the date and the version,
like every other document in this directory.

It also cannot distinguish "separate pools" from "shared pool with headroom so large
that three runs are invisible". A negative result at burst size three is weaker than
a positive one, and the honest response to a negative is a larger burst rather than a
conclusion.
