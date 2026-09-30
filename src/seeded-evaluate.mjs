// @ts-check
// One seeded case's pull request, judged as the daemon judges one (#293): its
// head pinned, its reviews observed and folded, then evaluated, three times,
// since a check set settles over three readings. It runs in a process of its
// own, with a home of its own and a stand-in gh and git first on PATH, so it
// reaches neither GitHub nor the real reeve home. It prints the last verdict
// as JSON on stdout.
//
// SEEDED_CLOCK, when set, is the time in seconds the first reading is taken at,
// and each later one five minutes after, as ticks are. A recorded case is
// judged at the moment it stands for: a check's pass counts for a week, and a
// review goes stale.

const env = process.env;
const nwo = String(env.SEEDED_REPO);
const pr = Number(env.SEEDED_PR);
const TICK = 300;

// The clock is pinned before reeve's modules are loaded, so none reads the real one.
const { pinClock } = await import("./seeded.mjs");
const advance = env.SEEDED_CLOCK ? pinClock(Number(env.SEEDED_CLOCK)).advance : () => {};
const judgedAt = Math.floor(Date.now() / 1000);

const { readFileSync } = await import("node:fs");
const { prAnchor, evaluatePr } = await import("./pr.mjs");
const { observe, ingest, noteHead } = await import("./review/ingest.mjs");
const { derivePr } = await import("./review/derive.mjs");
const { open } = await import("./db/ops.mjs");
const { withDefaults, validate } = await import("./profile/schema.mjs");

const profile = withDefaults(JSON.parse(readFileSync(String(env.SEEDED_PROFILE), "utf8")));
const valid = validate(profile);
if (!valid.ok) {
  console.log(JSON.stringify({ ok: false, why: `the case's profile is invalid: ${valid.errors.join("; ")}` }));
  process.exit(0);
}
const db = open(String(env.SEEDED_STORE));
/** @type {any} */
let last = { ok: false, why: "never evaluated" };
for (let reading = 1; reading <= 3; reading++) {
  if (reading > 1) advance(TICK);
  const at = Math.floor(Date.now() / 1000);
  const anchor = prAnchor({ nwo, pr });
  if (!anchor.ok) { last = { ok: false, why: `the head couldn't be pinned: ${anchor.why}` }; continue; }
  noteHead(db, nwo, pr, anchor.head, at);
  const seen = observe(nwo, pr);
  ingest(db, nwo, pr, seen.observations, { at });
  derivePr(db, nwo, pr, profile, { at, head: anchor.head, complete: !seen.incomplete });
  const e = evaluatePr({ nwo, pr, profile, db, anchor, hold: null, io: { foldPrecedesEvaluation: true } });
  last = e.ok
    ? { ok: true, at: judgedAt, head: e.head, state: e.verdict.state, summary: e.verdict.summary,
        clauses: e.verdict.clauses.map((/** @type {any} */ c) => ({ id: c.id, state: c.state, detail: String(c.detail ?? "") })) }
    : { ok: false, why: e.why };
}
db.close();
console.log(JSON.stringify(last));
