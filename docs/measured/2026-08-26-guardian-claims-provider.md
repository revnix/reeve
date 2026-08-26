# Measured: a guardian dispatch holds a provider lease, and gives it back

Date: 2026-08-26. node v24.17.0, macOS 15.6, sqlite via `node:sqlite`.

Section 14's S2 acceptance clause reads: *a guardian FIX_CI dispatch claims a
provider lease before launch and releases it on exit, observed as rows in
`provider_lease`.* This is that observation, taken on the real `tick` path.

## What was NOT real

**No model was called.** `spawnWorker` is a fixture that returns a successful
outcome, and no task in S2 may dispatch a real worker or run `reeve canary`.
`containment`, `capacity`, `openPrs`, `evaluate`, `resolveCause`,
`prepareCheckout`, `publish` and `oauthToken` are all injected — the real
ones consult GitHub, the keychain, or the host's load average, and an artefact
that quietly consults production is worse than none.

**What IS real**: `tick` itself, the decision that reaches FIX_CI, the durable
run, the provider claim, the dispatch gate, and the release in the `finally`.
The lease rows below were written and deleted by the daemon, not by the script.

The guardian was handed the **restricted** connection — `openHubAsGuest`, the
same one `bin/reeve` builds — not a privileged `openHub`. Observing the lease
over a connection the daemon never has would prove the scheduler works over
something other than the connection under test. The script keeps its own
privileged handle purely to read `provider_lease` back.

## The run

```
$ node ./acceptance-tmp.mjs
DURING dispatch: [{"owner":"guardian","status":"held","run_ref":"o/r#7:FIX_CI"}]
AFTER  dispatch: []
guardian held during: 1
rows remaining after: 0
```

`DURING` is read from inside `spawnWorker` — the instant the worker would be
launched. `AFTER` is read once `tick` has returned.

## What it establishes

- A lease exists, `held`, owned by `guardian`, at the moment of dispatch.
- It is scoped to the work: `run_ref` is `o/r#7:FIX_CI`, so two decisions on
  one pull request are two requests rather than one that collides with itself.
- Nothing survives the tick. The release runs in the `finally` every dispatched
  run passes through, so an outcome nobody anticipated cannot leave a lease
  behind to be counted against the limit until it expires.

Both halves are guarded rather than merely printed. `during` stays `null` if
the tick never reached `spawnWorker`, and printing `null` into a measured
document would record a non-observation as an observation; the script exits
nonzero instead. The same is true of a nonzero `after` count, which was the
easier half to leave unchecked — a broken cleanup would otherwise have exited 0
with the surviving rows printed directly above the claim that the lease was
released.

## One correction to the plan, found by running it

The plan's own acceptance fixture supplies `checks.caused` as
`[{ name: "build" }]`. `nextAction` reads that field as a list of check
**names**, and refuses to dispatch a fixer it cannot name — so the first run
escalated with *a check is failing but reeve could not name it: failing: build*,
before any provider claim, and reported `ACCEPTANCE FAILED: no guardian lease
was held during dispatch`.

That failure is indistinguishable from the one this document exists to rule out.
A fixture that cannot reach the mechanism reports the mechanism broken, and the
obvious response is to go looking at the mechanism. The field takes strings.

## Not covered here

The canary's lease. `containment` is injected, so the tick never measures it
and never takes the canary's claim; that path is covered by
`test/guardian-provider-lease.test.mjs` under an injected claim rather than by
this run. Saying so is the point — this artefact observes one of the two
dispatch sites, and a reader should not infer the other from it.
