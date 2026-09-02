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
import { spawnSync } from "node:child_process";
import { openHub } from "../src/build/hubdb.mjs";
import { escalationKey } from "../src/build/announce.mjs";
import { machineProfile, machineProfilePath, pageStandingCauses,
         PAGES_PER_PASS } from "../src/build/paging.mjs";
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
const seedTasks = (db, n) => {
  const ins = db.prepare(`INSERT INTO task(
      id, project, repo_id, nwo_snapshot, title, phase, source_kind, source_key,
      repo_path, profile_path, profile_hash, default_branch, visibility,
      registry_version, created_at, updated_at)
    VALUES(?, 'alpha', 42, 'o/a', 'a task', 'ESCALATED', 'founder', ?, '/repo',
           '/p.json', 'ph-1', 'main', 'private', 1, ?, ?)`);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `bt:0PAGE${String(i).padStart(3, "0")}`;
    ins.run(id, `src-${id}`, NOW, NOW);
    ids.push(id);
  }
  return ids;
};
const CLI = fileURLToPath(new URL("../bin/reeve", import.meta.url));
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

// ── nothing retires, and the reason is the SURVEY rather than `examined` ────
//
// A cause becomes a clearing candidate by being ABSENT from the pass's map while
// standing in the hub. This pass builds that map FROM the hub, so the two sets
// are identical and no cause is ever a candidate -- clearing is unreachable by
// construction, not merely declined. `examined: null` is the second guard, and
// it only starts mattering if the survey ever stops being total.
//
// So the property worth asserting is the TOTALITY of the survey. A filtered
// survey -- for live projects only, say, or for unannounced rows -- would make
// every excluded cause a candidate, and `examined: null` is then the one thing
// between that and announcing "resolved" for something nobody looked at.
{
  const home = freshHome(), db = hubOf(home);
  raise(db, KEY, 1, NOW);
  const send = () => ({ ok: true, channels: [{ name: "t", ok: true, ref: "r" }] });
  pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE, send });
  const r = pageStandingCauses(db, { home, at: NOW + 150, isAlive: ALIVE, send });

  const rows = db.prepare("SELECT count(*) c FROM escalation").get().c;
  check(r.standing === rows && rows === 1,
    "the pass surveys EVERY standing row, so no cause can quietly become a clearing candidate",
    JSON.stringify({ surveyed: r.standing, rows }));
  check(r.cleared.length === 0, "and nothing is retired", JSON.stringify(r.cleared));
  check(rows === 1 && db.prepare("SELECT announced_count FROM escalation WHERE why=?").get(KEY).announced_count > 0,
    "control: the cause is standing AND already announced, which is exactly what a filter would exclude",
    JSON.stringify(db.prepare("SELECT why, announced_count FROM escalation").all()));
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

// ── delivering is not observing ────────────────────────────────────────────
//
// This pass re-reads rows another writer recorded. It has SEEN nothing: it has no
// evidence a cause is still true, only that nobody retired it. Recording that as
// a sighting moved `last_seen_at` forward on every heartbeat -- so a condition
// observed once read as continuously present, which is the single fact
// `last_seen_at` exists to carry -- and appended a row image per standing cause
// per pass, which at a heartbeat cadence is hundreds of events a day for a log
// that recorded one event.
{
  const home = freshHome(), db = hubOf(home);
  writeFileSync(machineProfilePath(home), JSON.stringify({ notify: { desktop: true } }));
  raise(db, KEY, 1, NOW);
  const send = () => ({ ok: true, channels: [{ name: "t", ok: true, ref: "r" }] });
  const row = () => db.prepare("SELECT last_seen_at, announced_count FROM escalation WHERE why=?").get(KEY);
  const events = () => db.prepare("SELECT count(*) c FROM hub_event WHERE kind='escalation.raised'").get().c;

  const before = { seen: row().last_seen_at, events: events() };
  for (let i = 1; i <= 5; i++)
    pageStandingCauses(db, { home, at: NOW + i * 150, isAlive: ALIVE, send });

  check(row().last_seen_at === before.seen,
    "five delivery passes do not move last_seen_at, because none of them saw the cause",
    JSON.stringify({ before: before.seen, after: row().last_seen_at }));
  check(events() - before.events === 1,
    "and append ONE event, for the announcement they actually made",
    JSON.stringify({ appended: events() - before.events, passes: 5 }));
  check(row().announced_count === 1,
    "control: the announcement bookkeeping still writes, so this is not simply an inert pass",
    JSON.stringify(row()));

  // AND A CHANGED COUNT STILL PAGES, so the silence above is about observation
  // rather than about delivery having stopped.
  raise(db, KEY, 4, NOW + 900);
  const seenAtRaise = row().last_seen_at;
  const r = pageStandingCauses(db, { home, at: NOW + 1050, isAlive: ALIVE, send });
  check(r.paged.length === 1, "control: a changed count is still delivered",
    JSON.stringify({ paged: r.paged.length }));
  check(row().last_seen_at === seenAtRaise,
    "and the writer that OBSERVED it is the one that set last_seen_at, not this pass",
    JSON.stringify({ raisedAt: seenAtRaise, after: row().last_seen_at }));
  db.close();
}

// ── a refused CHANNEL is reported, not just a missing profile ──────────────
//
// `deliverable` says only that a profile object loaded. A configured channel that
// REFUSES -- no credential, server down -- comes back in `declined`, and the loop
// once read presence instead of the verdict: it printed nothing, the page stayed
// owed, and it was retried every heartbeat with no line saying why.
{
  const home = freshHome(), db = hubOf(home);
  raise(db, KEY, 1, NOW);
  writeFileSync(machineProfilePath(home), JSON.stringify({ notify: {
    provider: "ntfy", url: "http://127.0.0.1:9", topic: "t",
    credentialFile: join(home, "no-such-credential") } }));
  const r = pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE });
  check(r.deliverable === true,
    "control: a profile IS loaded here, so presence alone would have reported success",
    JSON.stringify({ deliverable: r.deliverable, why: r.why }));
  check(r.declined.length === 1,
    "yet the send is DECLINED, which is the fact the log has to carry",
    JSON.stringify(r.declined));
  check(typeof r.declined[0]?.not_sent === "string" && r.declined[0].not_sent.length > 0,
    "and it carries a reason, so the line the loop prints can name the channel's failure",
    JSON.stringify(r.declined[0]?.not_sent));
  check(db.prepare("SELECT announced_count FROM escalation WHERE why=?").get(KEY).announced_count === 0,
    "control: and the page is still owed, so silence here would hide a retry loop",
    JSON.stringify(db.prepare("SELECT announced_count FROM escalation WHERE why=?").get(KEY)));
  db.close();
}

// ── `builder doctor` actually emits H-14, which the unit rows cannot show ───
//
// Every H-14 assertion above calls `hubFindings` directly and passes `paging`.
// All of them pass on a repository where the doctor ROUTE omits it -- and it did,
// so the row was written to fail on a machine that can page nobody and could not
// reach the one command that reports it. The finding existed, was tested, and was
// unmounted.
{
  const home = freshHome();
  hubOf(home).close();
  writeFileSync(join(home, "projects.json"), "{}");
  const r = spawnSync(process.execPath, [CLI, "builder", "doctor", "--home", home, "--json"],
    { encoding: "utf8", timeout: 60_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  let h14 = null, parsed = null;
  try { parsed = JSON.parse(r.stdout || "null"); } catch { parsed = null; }
  if (Array.isArray(parsed)) h14 = parsed.find(x => x.id === "H-14") ?? null;
  check(Array.isArray(parsed) && parsed.length > 0,
    "control: the command produced a findings array, so a missing H-14 is a missing ROW",
    out.slice(0, 200));
  check(h14 !== null, "`builder doctor` emits an H-14 row at all", out.slice(0, 300));
  check(h14?.severity === "fail",
    "and it FAILS on a machine with no notify profile, rather than reporting it unprobed",
    JSON.stringify(h14));
  check(/profile\.json/.test(h14?.action ?? ""),
    "naming where to write the profile", String(h14?.action));
}

// ── a block is not a channel ───────────────────────────────────────────────
//
// `{ "notify": {} }` parses, is an object, and configures nothing: `notify`
// builds no channels and declines every page. Treating the block's presence as
// deliverability made the doctor report a machine that can reach nobody as
// healthy -- the exact assurance H-14 exists to withhold.
{
  for (const [what, cfg] of [["an empty notify block", {}],
                             ["ntfy with no url", { provider: "ntfy", topic: "t" }],
                             ["ntfy with no topic", { provider: "ntfy", url: "http://x" }],
                             ["a provider nothing builds", { provider: "none" }]]) {
    const home = freshHome();
    writeFileSync(machineProfilePath(home), JSON.stringify({ notify: cfg }));
    const m = machineProfile(home);
    check(m.profile === null && /no usable channel/.test(m.why ?? ""),
      `${what} is not deliverable, so the doctor cannot report it as healthy`,
      JSON.stringify({ why: m.why }));
  }
  // CONTROLS: both shapes `notify` actually builds a channel from are accepted,
  // so this refuses configurations rather than refusing configuration.
  for (const [what, cfg] of [["desktop", { desktop: true }],
                             ["a complete ntfy", { provider: "ntfy", url: "http://x", topic: "t" }]]) {
    const home = freshHome();
    writeFileSync(machineProfilePath(home), JSON.stringify({ notify: cfg }));
    check(machineProfile(home).profile !== null,
      `control: ${what} IS deliverable, so the check bounds the config and not the file`,
      JSON.stringify(machineProfile(home).why));
  }
}

// ── one pass cannot block the heartbeat indefinitely ───────────────────────
//
// Sending is synchronous and each attempt can take the sender's own 8-second
// timeout. `build run` calls this inline before its sleep, so an unbounded
// backlog against a dead channel stalls the loop for as long as the backlog is
// deep -- past the 120-second singleton lease, at which point the daemon can lose
// the authority it is holding while it waits to finish paging. An alarm that
// costs a daemon its lease has cost more than it reported.
{
  const home = freshHome(), db = hubOf(home);
  writeFileSync(machineProfilePath(home), JSON.stringify({ notify: { desktop: true } }));
  const tasks = seedTasks(db, 8);
  check(tasks.length >= 6, "control: the fixture has enough tasks to exceed the bound",
    String(tasks.length));
  for (const [i, id] of tasks.entries())
    raise(db, `${id}:phase:blocked:RESEARCH`, 1, NOW + i);

  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true, ref: "r" }] }; };
  const first = pageStandingCauses(db, { home, at: NOW + 100, isAlive: ALIVE, send });
  check(sent.length === PAGES_PER_PASS,
    `one pass attempts at most ${PAGES_PER_PASS} sends, whatever the backlog`,
    JSON.stringify({ sent: sent.length, standing: first.standing }));
  check(first.standing > PAGES_PER_PASS,
    "control: there really were more causes than the bound, so the cap is what stopped it",
    JSON.stringify({ standing: first.standing, bound: PAGES_PER_PASS }));

  // NOTHING IS LOST. What was not attempted keeps announced_count unchanged and
  // is offered again -- the same mechanism that makes a refused page come back.
  const owed = db.prepare(
    "SELECT count(*) c FROM escalation WHERE announced_count <> count").get().c;
  check(owed > 0, "and what it did not attempt is still owed", String(owed));
  sent.length = 0;
  pageStandingCauses(db, { home, at: NOW + 250, isAlive: ALIVE, send });
  check(sent.length > 0, "so the next pass delivers more of the backlog", String(sent.length));
  db.close();
}

// ── a rendered action names the hub it is about ────────────────────────────
//
// The action is meant to be pasted. Pasted later, outside the daemon's
// environment, a bare `reeve task why bt:...` resolves the DEFAULT home -- so an
// operator whose daemon runs with `--home /custom` inspects a different hub, and
// the likeliest answer there is that the task does not exist. An alert that sends
// someone to the wrong store is worse than one carrying no command, because they
// will believe what they find.
{
  const home = freshHome(), db = hubOf(home);
  writeFileSync(machineProfilePath(home), JSON.stringify({ notify: { desktop: true } }));
  const task = seedTasks(db, 1)[0];
  raise(db, `${task}:phase:blocked:RESEARCH`, 1, NOW);
  const sent = [];
  const send = (a) => { sent.push(a); return { ok: true, channels: [{ name: "t", ok: true, ref: "r" }] }; };
  pageStandingCauses(db, { home, at: NOW, isAlive: ALIVE, send });
  const msg = sent[0]?.message ?? "";
  check(/--home /.test(msg) && msg.includes(home),
    "the action names the home the alert is about, so the pasted command reaches THIS hub",
    JSON.stringify(msg.split("\n").find(l => /->/.test(l)) ?? msg.slice(0, 120)));
}

// ── the wiring exists, which no unit test above can see ─────────────────────
//
// Every assertion so far calls `pageStandingCauses` directly. All of them pass
// on a repository where `bin/reeve` never invokes it -- which is precisely the
// state this change exists to end.
{
  const cli = readFileSync(CLI, "utf8");
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
