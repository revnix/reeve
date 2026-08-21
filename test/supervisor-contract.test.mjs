// The worker contract at the supervisor: an exact environment, bounded durable
// output, a binding that fails closed, and a lease whose loss ends the worker.
//
// `runWorker` spread process.env and accumulated stdout in memory. A worker that
// prints a gigabyte took the supervisor down with it, the fenced report died in
// a broken pipe whenever the supervisor died first, and every worker inherited
// the founder's credentials. Output now streams to files the restart path can
// read, capped, and the environment is exactly what the caller built.
import { runWorker, readStart, OUTCOMES } from "../src/supervisor.mjs";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-contract-"));
const files = name => ({ outPath: join(dir, `${name}.out`), errPath: join(dir, `${name}.err`) });
const ENV = { PATH: "/usr/bin:/bin" };

// ── exact environment ────────────────────────────────────────────────────────
{
  process.env.PLANTED_SECRET = "leak";
  const f = files("env");
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", 'echo "env=[$PLANTED_SECRET] only=$ONLY"; echo err >&2'],
                              env: { ...ENV, ONLY: "yes" }, ...f, budgetMs: 5000 });
  delete process.env.PLANTED_SECRET;
  const out = readFileSync(f.outPath, "utf8");
  check(/only=yes/.test(out) && /env=\[\]/.test(out),
    "the worker sees exactly the env it was given, not the supervisor's", out);
  check(/err/.test(readFileSync(f.errPath, "utf8")), "stderr streams to its own file", "");
  check(r.outPath === f.outPath && r.errPath === f.errPath && r.truncated === false,
    "the result names the files and reports no truncation", JSON.stringify({ o: r.outPath, t: r.truncated }));
}
{
  let threw = null;
  try { await runWorker({ bin: "/bin/sh", args: ["-c", "true"], ...files("noenv") }); } catch (e) { threw = e; }
  check(threw && /env is required/.test(threw.message), "omitting env is a hard failure, never an inherit", String(threw?.message));
  threw = null;
  try { await runWorker({ bin: "/bin/sh", args: ["-c", "true"], env: ENV }); } catch (e) { threw = e; }
  check(threw && /outPath/.test(threw.message), "omitting the output files is a hard failure too", String(threw?.message));
}

// ── bounded durable streams ──────────────────────────────────────────────────
{
  const f = files("big");
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "head -c 300000 /dev/zero | tr '\\0' 'x'"],
                              env: ENV, ...f, maxOutputBytes: 100000, budgetMs: 10000 });
  const size = statSync(f.outPath).size;
  check(r.truncated === true && size <= 100000,
    "output past the cap is dropped and reported as truncated", `size=${size} truncated=${r.truncated}`);
  // A truncated record is an incomplete record. The in-memory parse may still
  // have seen a result event that the file no longer holds, and a store that
  // says OK beside a file that cannot show why is the absence-as-success this
  // system refuses.
  check(r.outcome === OUTCOMES.FAILED && /truncated/.test(r.why),
    "and a truncated worker is never classified OK", JSON.stringify({ o: r.outcome, w: r.why }));
}

// ── a worker without a durable binding is killed, not observed ───────────────
//
// `onSpawn` records pid+lstart on the run row. Its failure was swallowed ("an
// observer must not kill the worker"), which left a worker running that nothing
// could reason about after a restart. A binding that cannot commit now ends the
// worker before it touches anything.
{
  const t0 = Date.now();
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 30"], env: ENV, ...files("bind"), budgetMs: 60000,
                              onSpawn: () => { throw new Error("disk full"); } });
  check(r.outcome === OUTCOMES.UNBOUND && /run binding failed: disk full/.test(r.why),
    "a binding failure is its own outcome with the cause", JSON.stringify({ o: r.outcome, w: r.why }));
  // The resolve is synchronous, so elapsed time proves nothing; liveness does.
  // Polled with a ceiling rather than read after a fixed sleep, because a
  // loaded CI host reaps a SIGKILLed child when it gets to it.
  let dead = false;
  for (let i = 0; i < 50 && !dead; i++) { dead = readStart(r.pid) === null; if (!dead) await new Promise(res => setTimeout(res, 100)); }
  check(r.pid && dead, "the process group is dead within five seconds", `pid=${r.pid}`);
}

// ── a worker that cannot prove it is leased stops acting ─────────────────────
{
  let revoked = null;
  setTimeout(() => { revoked = "lease-lost"; }, 500);
  const t0 = Date.now();
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 30"], env: ENV, ...files("revoke"), budgetMs: 60000,
                              isRevoked: () => revoked });
  check(r.outcome === OUTCOMES.LEASE_LOST && /lease-lost/.test(r.why),
    "a revoked lease ends the worker with its reason", JSON.stringify({ o: r.outcome, w: r.why }));
  check(Date.now() - t0 < 10000, "within one poll interval, not at the budget", `${Date.now() - t0}ms`);
}


// ── a binary that cannot be spawned is CRASHED, never an uncaught error ──────
//
// Node emits the spawn error asynchronously and the child has no pid. A catch
// that killed "the group" of an undefined pid threw inside the executor, and
// the error event then had no listener: the daemon died, and launchd would
// have restarted it into the same death. Measured before the fix.
{
  let r = null, threw = null;
  try {
    r = await runWorker({ bin: "/nonexistent/claude", args: [], env: ENV, ...files("nobin"), budgetMs: 3000,
                          onSpawn: () => { throw new Error("bind"); } });
  } catch (e) { threw = e; }
  check(!threw && r?.outcome === OUTCOMES.CRASHED && /could not spawn/.test(r?.why ?? ""),
    "a missing binary resolves CRASHED even when the binding would have thrown", threw ? String(threw.message) : JSON.stringify({ o: r?.outcome, w: r?.why }));
}

// ── revocation that lands between the last poll and exit still counts ────────
//
// The poll runs every two seconds. A lease revoked 1.9 seconds before a normal
// exit was never seen, and a successful result was classified OK and could
// have been published under a lease the worker no longer held.
{
  let revoked = null;
  setTimeout(() => { revoked = "lost-late"; }, 100);
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 0.4"], env: ENV, ...files("late"), budgetMs: 10000,
                              isRevoked: () => revoked });
  check(r.outcome === OUTCOMES.LEASE_LOST && /lost-late/.test(r.why),
    "a revocation the poll never saw is still read at exit", JSON.stringify({ o: r.outcome, w: r.why }));
}


// ── an identity that cannot be read is not a binding ─────────────────────────
//
// pid+lstart is how a restart tells this worker from a stranger that inherited
// its pid. A worker whose start time `ps` could not read was still treated as
// bound, with an empty token recorded; after a crash that pid is any process.
{
  const r = await runWorker({ bin: "/bin/sh", args: ["-c", "sleep 30"], env: ENV, ...files("nolstart"), budgetMs: 60000,
                              readStart: () => null });
  check(r.outcome === OUTCOMES.UNBOUND && /start time/.test(r.why), "a worker whose start time cannot be read is UNBOUND and killed", JSON.stringify({ o: r.outcome, w: r.why }));
}


rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
