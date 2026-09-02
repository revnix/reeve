// The pass that carries a standing escalation to a human, and the wiring that
// invokes it.
//
// The property under test is not that `announce` works -- `build-escalations`
// owns that -- but that anything CALLS it. Until this landed, every escalation
// the builder raised was written to the hub and delivered to nobody, and a
// system whose alarms reach no one is indistinguishable from a system with
// nothing to report.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHub } from "../src/build/hubdb.mjs";
import { escalationKey } from "../src/build/announce.mjs";
import { machineProfile, machineProfilePath, pageStandingCauses } from "../src/build/paging.mjs";
import { hubFindings } from "../src/doctor.mjs";

const dir = mkdtempSync(join(tmpdir(), "reeve-paging-"));
const NOW = 1_800_000_000;
const ALIVE = () => true;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log(`        ${detail}`); fail++; }
};

let seq = 0;
const freshHome = () => {
  const home = join(dir, `h${++seq}`);
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};
const hubOf = (home) => openHub(join(home, "state", "hub.db"));
const KEY = escalationKey({ kind: "backup:failed" });
const raise = (db, why, count, at) => db.prepare(
  `INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
   VALUES(?,?,?,?,0) ON CONFLICT(why) DO UPDATE SET count=excluded.count, last_seen_at=excluded.last_seen_at`)
  .run(why, count, at, at);

// ── a standing cause reaches a sender ───────────────────────────────────────
{
  const home = freshHome(), db = hubOf(home);
  raise(db, KEY, 1, NOW);
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true, ref: "r" }] }; };

  const first = pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE, send });
  check(sent.length === 1, "a cause already standing in the hub is announced by the pass",
    JSON.stringify({ sent: sent.length, paged: first.paged.length }));
  check(/backup:failed/.test(sent[0]?.message ?? ""),
    "and the alert names the cause", JSON.stringify(sent[0]?.message ?? null));
  check(first.standing === 1, "control: the pass reports what it surveyed, so an empty survey is visible",
    String(first.standing));

  // NOT ON EVERY PASS. This runs each heartbeat; announcing per tick is what
  // produced hundreds of pushes overnight for two conditions that never changed.
  pageStandingCauses(db, { home, at: NOW + 150, isAlive: ALIVE, send });
  pageStandingCauses(db, { home, at: NOW + 300, isAlive: ALIVE, send });
  check(sent.length === 1, "and an unchanged cause is not announced again on later passes",
    String(sent.length));

  // A CHANGED COUNT IS A CHANGED SITUATION: one store failing to back up and
  // four are not the same news.
  raise(db, KEY, 4, NOW + 450);
  pageStandingCauses(db, { home, at: NOW + 450, isAlive: ALIVE, send });
  check(sent.length === 2, "while a changed count announces again", String(sent.length));
  db.close();
}

// ── nothing retires, because this pass examines nothing ─────────────────────
//
// `examined` names the subjects a pass actually looked at. The builder tick
// refreshes gate state and evaluates no task, so it can vouch for none -- and
// retiring on that silence would announce "resolved" for something nobody
// looked at, then re-announce it on the next pass that did look.
{
  const home = freshHome(), db = hubOf(home);
  raise(db, KEY, 1, NOW);
  const send = () => ({ ok: true, channels: [{ name: "t", ok: true, ref: "r" }] });
  pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE, send });
  const r = pageStandingCauses(db, { home, at: NOW + 150, isAlive: ALIVE, send });
  check(r.cleared.length === 0, "a pass that examined nothing retires nothing",
    JSON.stringify(r.cleared));
  check(db.prepare("SELECT count(*) c FROM escalation").get().c === 1,
    "control: and the cause is still standing, so the absence of a clear is not an empty hub",
    JSON.stringify(db.prepare("SELECT count(*) c FROM escalation").get()));
  db.close();
}

// ── with no profile the alarm is HELD, not lost ─────────────────────────────
//
// A page whose sender refused leaves `announced_count` at 0, so the first pass
// after a profile is configured delivers it. Skipping the pass entirely would
// also skip the record that it could not be made.
{
  const home = freshHome(), db = hubOf(home);
  raise(db, KEY, 1, NOW);
  const held = pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE });
  check(held.deliverable === false, "with no machine profile the pass reports it cannot deliver",
    JSON.stringify({ deliverable: held.deliverable, why: held.why }));
  check(held.declined.length === 1, "and the cause is DECLINED rather than dropped",
    JSON.stringify(held.declined));
  check(db.prepare("SELECT announced_count FROM escalation WHERE why=?").get(KEY).announced_count === 0,
    "the row stays unannounced, so a profile configured later still pages it",
    JSON.stringify(db.prepare("SELECT announced_count FROM escalation WHERE why=?").get(KEY)));

  // AND THEN IT DOES. This is the property the whole shape exists for.
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true, ref: "r" }] }; };
  writeFileSync(machineProfilePath(home), JSON.stringify({ notify: { desktop: true } }));
  const after = pageStandingCauses(db, { home, at: NOW + 150, isAlive: ALIVE, send });
  check(sent.length === 1 && after.paged.length === 1,
    "a cause that could not be delivered is paged by the first pass that can",
    JSON.stringify({ sent: sent.length, paged: after.paged.length }));
  db.close();
}

// ── the reason there is no profile is never collapsed into its absence ──────
{
  const a = freshHome();
  check(/no machine notify profile at/.test(machineProfile(a).why ?? ""),
    "an absent profile says it is absent, and where it was looked for", machineProfile(a).why);

  const b = freshHome();
  writeFileSync(machineProfilePath(b), "{ not json");
  check(/not readable JSON/.test(machineProfile(b).why ?? ""),
    "an unreadable one says THAT, which is a different fix", machineProfile(b).why);

  const c = freshHome();
  writeFileSync(machineProfilePath(c), JSON.stringify({ something: 1 }));
  check(/carries no `notify` block/.test(machineProfile(c).why ?? ""),
    "and a profile with no notify block says that, which is a third", machineProfile(c).why);

  const d = freshHome();
  writeFileSync(machineProfilePath(d), JSON.stringify({ notify: { desktop: true } }));
  check(machineProfile(d).profile !== null && machineProfile(d).why === null,
    "control: a profile carrying a notify block is accepted, so this refuses shapes and not files",
    JSON.stringify(machineProfile(d)));
}

// ── the doctor says whether this machine can page at all ────────────────────
{
  const ddb = hubOf(freshHome());
  const rows = (paging) => hubFindings(ddb, {
    root: dir, now: NOW, snapshotFor: () => null, paging });
  const f = rows({ deliverable: false, standing: 3, why: "no profile", path: "/p/profile.json" })
    .find(r => r.id === "H-14");
  check(f?.severity === "fail", "H-14 FAILS when no alarm could reach anyone", JSON.stringify(f));
  check(/3 standing/.test(f?.title ?? ""),
    "and names how many causes are affected, so the gap is not abstract", String(f?.title));
  check(/profile\.json/.test(f?.action ?? ""), "and says where to write the profile", String(f?.action));

  const ok = rows({ deliverable: true, standing: 0, why: null, path: "/p/profile.json" })
    .find(r => r.id === "H-14");
  check(ok?.severity === "pass", "control: and PASSES when one is configured", JSON.stringify(ok));

  // NOT PROBED IS NOT A PASS, which is the whole convention of this surface.
  const un = rows(null).find(r => r.id === "H-14");
  check(un?.severity === "warn" && un?.classification === "unknown",
    "an unprobed paging state is reported as UNKNOWN rather than as healthy", JSON.stringify(un));
  ddb.close();
}

// ── the wiring exists, which no unit test above can see ─────────────────────
//
// Every assertion so far calls `pageStandingCauses` directly. All of them pass
// on a repository where `bin/reeve` never invokes it -- which is precisely the
// state this change exists to end.
{
  const cli = readFileSync(fileURLToPath(new URL("../bin/reeve", import.meta.url)), "utf8");
  check(/\bpageStandingCauses\b/.test(cli) && /build\/paging\.mjs/.test(cli),
    "bin/reeve imports pageStandingCauses from build/paging.mjs");
  const runRoute = cli.slice(cli.indexOf("const tick = await buildTick"));
  check(/pageStandingCauses\(db, \{ home: HOME \}\)/.test(runRoute.slice(0, 3000)),
    "and calls it in the heartbeat loop, after the tick",
    runRoute.slice(0, 200));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
