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
  check(Date.now() - t0 < 10000, "and the worker was killed immediately, not left to its budget", `${Date.now() - t0}ms`);
  await new Promise(res => setTimeout(res, 300));
  check(r.pid && readStart(r.pid) === null, "the process group is dead", `pid=${r.pid}`);
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

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
