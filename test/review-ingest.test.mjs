// PR-2 of the review-ingest plan: the WRITE half, in shadow. Nothing consumes
// these rows yet, so the only things that can be wrong here are silent ones —
// which is precisely why each is asserted.
//
// The three properties, each from a measured behaviour of the real reviewers:
//
//   Re-polling unchanged data writes NOTHING. reeve reads the same PR every few
//   minutes forever; an ingest that appended on every poll would bury the real
//   history under thousands of identical rows within a day.
//
//   An EDIT appends a generation. CodeRabbit rewrites its own history — the
//   summary comment is a living document, inline findings are retro-edited to
//   record resolution, and a status was edited to "Review rate limited" twenty
//   seconds before a review landed for the same head. Under a key of id alone
//   every one of those was a silent no-op that lost the earlier text.
//
//   A truncated read is INCOMPLETE, never empty. reviewThreads(first:100)
//   reported "zero unresolved" four times in a row while threads were open.
import { observe, ingest, noteHead, resolveAbbrev, hashOf, normalizeLogin } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "nextlyhq/nextly";
const NOW = 1_800_000_000;
const dir = mkdtempSync(join(tmpdir(), "reeve-ingest-"));
const db = open(join(dir, "s.db"));

const obs = (over = {}) => ({
  source: "coderabbitai", external_id: "comment:1", kind: "issue_comment",
  head_sha: null, event_at: NOW, edited_at: NOW,
  payload: { login: "coderabbitai", body: "Actionable comments posted: 3" }, ...over,
});

// ── re-polling is free ───────────────────────────────────────────────────────
{
  const first = ingest(db, NWO, 1, [obs()], { at: NOW });
  check(first.inserted === 1 && first.generations === 0,
    "control: a first observation lands", JSON.stringify(first));

  const second = ingest(db, NWO, 1, [obs()], { at: NOW + 180 });
  check(second.inserted === 0 && second.generations === 0 && second.unchanged === 1,
    "re-polling the SAME content writes nothing at all", JSON.stringify(second));

  const rows = db.prepare("SELECT COUNT(*) n FROM inbox WHERE pr_number = 1").get().n;
  check(rows === 1, "so the table holds one row, not one per tick forever", String(rows));
}

// ── an edit is a generation ──────────────────────────────────────────────────
{
  const edited = obs({ payload: { login: "coderabbitai", body: "Review rate limited" },
                       edited_at: NOW + 3600 });
  const r = ingest(db, NWO, 1, [edited], { at: NOW + 3600 });
  check(r.generations === 1 && r.inserted === 0,
    "an edit to the same object appends a generation", JSON.stringify(r));

  const gens = db.prepare(
    "SELECT generation, payload FROM inbox WHERE external_id = 'comment:1' ORDER BY generation").all();
  check(gens.length === 2 && gens[0].generation === 1 && gens[1].generation === 2,
    "both generations survive, numbered in order", JSON.stringify(gens.map(g => g.generation)));
  check(/posted: 3/.test(gens[0].payload) && /rate limited/.test(gens[1].payload),
    "and the ORIGINAL text is still readable — the rewrite did not erase it",
    gens.map(g => g.payload.slice(0, 40)).join(" | "));

  // Reverting to the earlier text is not a third generation: that content is
  // already on record, and re-recording it would invent an event.
  const back = ingest(db, NWO, 1, [obs()], { at: NOW + 7200 });
  check(back.unchanged === 1 && back.generations === 0,
    "reverting to text already on record is not a new generation", JSON.stringify(back));
}

// ── two observations of one object in a single batch ─────────────────────────
{
  const a = obs({ external_id: "comment:9", payload: { body: "one" } });
  const b = obs({ external_id: "comment:9", payload: { body: "two" } });
  const r = ingest(db, NWO, 2, [a, b], { at: NOW });
  const gens = db.prepare(
    "SELECT generation FROM inbox WHERE external_id='comment:9' ORDER BY generation").all().map(x => x.generation);
  check(r.inserted === 1 && r.generations === 1 && gens.join(",") === "1,2",
    "two versions in ONE batch take distinct generations, not both 1",
    `${JSON.stringify(r)} gens=${gens.join(",")}`);
}

// ── the batch is atomic ──────────────────────────────────────────────────────
{
  const before = db.prepare("SELECT COUNT(*) n FROM inbox").get().n;
  // kind is NOT NULL; a null one must abort the whole batch, not land half of it.
  try {
    ingest(db, NWO, 3, [obs({ external_id: "comment:ok" }), obs({ external_id: "comment:bad", kind: null })],
      { at: NOW });
    check(false, "a batch with a bad row should have thrown");
  } catch {
    const after = db.prepare("SELECT COUNT(*) n FROM inbox").get().n;
    check(after === before,
      "a batch that fails part-way lands NOTHING — a half-ingested PR is a race",
      `before=${before} after=${after}`);
  }
}

// ── head_seen: the watermark ─────────────────────────────────────────────────
{
  const sha = "a".repeat(40), other = "b".repeat(40);
  check(noteHead(db, NWO, 1, sha, NOW) === true, "control: a new head is recorded");
  check(noteHead(db, NWO, 1, sha, NOW + 9999) === false,
    "seeing it again does not re-record it");

  const row = db.prepare("SELECT first_seen_at FROM head_seen WHERE sha = ?").get(sha);
  check(row.first_seen_at === NOW,
    "and first_seen_at is when it was FIRST seen — refreshing it would make every head look newly pushed",
    String(row.first_seen_at));

  check(noteHead(db, NWO, 1, "abc", NOW) === false, "a non-sha is refused");
  noteHead(db, NWO, 1, other, NOW);

  // Abbreviated shas from comment bodies resolve against what reeve has seen.
  check(resolveAbbrev(db, NWO, 1, "aaaaaaa") === sha,
    "an abbreviated sha resolves to the full head reeve pinned");
  check(resolveAbbrev(db, NWO, 1, "fffffff") === null,
    "an unknown prefix resolves to nothing, never to a guess");
  check(resolveAbbrev(db, NWO, 1, "abcd") === null,
    "and a prefix shorter than seven hex is refused");

  // Ambiguity must never resolve. A review bound to the wrong revision is a
  // stale review counted as covering the current one.
  const c1 = "c".repeat(40), c2 = "c".repeat(39) + "d";
  noteHead(db, NWO, 4, c1, NOW); noteHead(db, NWO, 4, c2, NOW);
  check(resolveAbbrev(db, NWO, 4, "c".repeat(10)) === null,
    "an AMBIGUOUS prefix resolves to nothing, not to the likelier head");
  check(resolveAbbrev(db, NWO, 4, "c".repeat(39) + "d") === c2,
    "while a prefix long enough to be unique still resolves");

  // Scoped per PR: the same abbreviation on another PR is not this PR's head.
  check(resolveAbbrev(db, NWO, 99, "aaaaaaa") === null,
    "and resolution is scoped to the pull request that saw the head");
}

// ── observe(): a truncated read is INCOMPLETE ────────────────────────────────
{
  const page = (n, hasNext) => JSON.stringify({ data: { repository: { pullRequest: {
    reviewThreads: { totalCount: 4, pageInfo: { hasNextPage: hasNext, endCursor: "X" },
      nodes: Array.from({ length: n }, (_, i) => ({ id: `PRRT_${i}`, isResolved: false,
        isOutdated: false, path: "a.ts", line: 1,
        comments: { nodes: [{ databaseId: i, author: { login: "coderabbitai" },
                              body: "finding", createdAt: "2026-08-21T00:00:00Z" }] } })) } } } } });

  // Control: a complete read is complete.
  const good = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: page(4, false) };
    return { ok: true, out: "[]" };
  } });
  check(good.incomplete === false, "control: a full read is not incomplete", JSON.stringify(good.incomplete));
  check(good.observations.length === 4, "and yields every thread", String(good.observations.length));

  // A page that says 4 exist but hands back 2, with no next page: truncated.
  const short = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: page(2, false) };
    return { ok: true, out: "[]" };
  } });
  check(short.incomplete === true,
    "a read that saw fewer threads than exist is INCOMPLETE, not empty",
    JSON.stringify({ incomplete: short.incomplete, seen: short.observations.length }));

  // A failed surface is incomplete even though the others answered.
  const partial = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: page(4, false) };
    if (String(args[0]).includes("/reviews")) return { ok: false, err: "HTTP 502" };
    return { ok: true, out: "[]" };
  } });
  check(partial.incomplete === true,
    "one failed surface makes the whole observation incomplete", JSON.stringify(partial.incomplete));
}

// ── observe(): the REST surfaces are paginated too ───────────────────────────
//
// The threads surface above has been paginated since it was written. The two REST
// surfaces beside it were not, and a single page of 100 is not a safe ceiling for
// either: every inline reply mints a 0-byte COMMENTED review — nine at one commit
// on #1124 — so review OBJECTS outnumber real rounds by an order of magnitude and
// a busy pull request passes 100 having had five rounds. A short read that reports
// success is how a body-only critical goes unseen behind a projection calling
// itself complete.
{
  const emptyThreads = JSON.stringify({ data: { repository: { pullRequest: {
    reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } });
  const rev = i => ({ id: i, user: { login: "codex" }, state: "COMMENTED",
                      commit_id: "a".repeat(40), body: `finding ${i}`,
                      submitted_at: "2026-08-21T00:00:00Z" });
  // Two full pages then a short one: 250 reviews, which one request cannot carry.
  const paged = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: emptyThreads };
    const path = args[0];
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    if (/\/pulls\/1\/reviews/.test(path)) {
      const n = page === 1 || page === 2 ? 100 : page === 3 ? 50 : 0;
      return { ok: true, out: JSON.stringify(Array.from({ length: n }, (_, i) => rev(page * 1000 + i))) };
    }
    return { ok: true, out: "[]" };
  } });
  check(paged.observations.filter(o => o.kind === "review").length === 250,
    "every page of the review surface is read, not just the first hundred",
    String(paged.observations.filter(o => o.kind === "review").length));
  check(paged.incomplete === false, "and a read that reached the end is complete",
    JSON.stringify(paged.incomplete));

  // A page that FAILS mid-way must not return what it has as though that were all.
  const broke = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: emptyThreads };
    const path = args[0];
    if (/\/pulls\/1\/reviews/.test(path)) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      if (page === 1) return { ok: true, out: JSON.stringify(Array.from({ length: 100 }, (_, i) => rev(i))) };
      return { ok: false, out: "", err: "boom" };
    }
    return { ok: true, out: "[]" };
  } });
  check(broke.incomplete === true,
    "a page that fails part-way through marks the read incomplete, not short",
    JSON.stringify(broke.incomplete));

  // The same reader serves the comment surface, because fixing one of two sites is
  // a near miss that has already happened here.
  const comments = observe(NWO, 1, { gh: args => {
    if (args[0] === "graphql") return { ok: true, out: emptyThreads };
    const path = args[0];
    if (/\/issues\/1\/comments/.test(path)) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      const n = page === 1 ? 100 : page === 2 ? 5 : 0;
      return { ok: true, out: JSON.stringify(Array.from({ length: n },
        (_, i) => ({ id: page * 1000 + i, user: { login: "codex" }, body: "c",
                     created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:00:00Z" }))) };
    }
    return { ok: true, out: "[]" };
  } });
  check(comments.observations.filter(o => o.kind === "issue_comment").length === 105,
    "and the comment surface is paginated by the same reader",
    String(comments.observations.filter(o => o.kind === "issue_comment").length));
}

// ── observe(): the shapes that only exist in the real data ───────────────────
{
  const r = observe(NWO, 1, { gh: args => {
    const a = String(args[0]);
    if (args[0] === "graphql") return { ok: true, out: JSON.stringify({ data: { repository: {
      pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } }) };
    if (a.includes("/reviews")) return { ok: true, out: JSON.stringify([
      { id: 7, user: { login: "chatgpt-codex-connector" }, state: "COMMENTED",
        commit_id: "f".repeat(40), body: "P1 finding", submitted_at: "2026-08-21T00:00:00Z" }]) };
    if (a.includes("/reactions")) return { ok: true, out: JSON.stringify([
      { user: { login: "chatgpt-codex-connector" }, content: "+1", created_at: "2026-08-21T00:00:00Z" }]) };
    return { ok: true, out: "[]" };
  } });

  const review = r.observations.find(o => o.kind === "review");
  check(review?.head_sha === "f".repeat(40),
    "a review binds to the FULL forty-hex commit_id — only bodies abbreviate",
    review?.head_sha);

  const reaction = r.observations.find(o => o.kind === "reaction");
  check(reaction && reaction.head_sha === null,
    "Codex's push-triggered clean pass is a reaction that binds to NO revision",
    JSON.stringify(reaction?.payload));
  check(reaction.external_id === "reaction:chatgpt-codex-connector:+1",
    "keyed by (user, emoji) because GitHub allows exactly one of those per item",
    reaction.external_id);
}

// ── the hash is content, not identity ────────────────────────────────────────
{
  check(hashOf({ a: 1, b: 2 }) === hashOf({ b: 2, a: 1 }),
    "key order does not change the hash — canonical JSON, so a re-poll is stable");
  check(hashOf({ a: 1 }) !== hashOf({ a: 2 }), "but the content does");
}

// ── one reviewer, one spelling ───────────────────────────────────────────────
//
// The same App answers to two names depending on which API is asked: REST says
// `coderabbitai[bot]`, GraphQL says `coderabbitai`. Measured on nextly #1128 --
// 71 observations of TWO reviewers arrived under FOUR sources, so half the
// evidence for each would never have matched a roster, which spells them bare.
// Nothing would have errored; the derivation would simply have seen half.
{
  check(normalizeLogin("coderabbitai[bot]") === "coderabbitai",
    "a REST bot login normalises to the bare name a roster uses");
  check(normalizeLogin("coderabbitai") === "coderabbitai",
    "and a GraphQL login is already bare");
  check(normalizeLogin("mobeenabdullah") === "mobeenabdullah",
    "a human login is untouched — a username cannot contain a bracket");
  check(normalizeLogin(undefined) === "unknown", "and a missing author is 'unknown', not a crash");

  // The property that actually matters: both surfaces land under ONE source.
  const r = observe(NWO, 5, { gh: args => {
    const a = String(args[0]);
    if (args[0] === "graphql") return { ok: true, out: JSON.stringify({ data: { repository: {
      pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [
        { id: "PRRT_1", isResolved: false, isOutdated: false, path: "a.ts", line: 1,
          comments: { nodes: [{ databaseId: 1, author: { login: "coderabbitai" },
                                body: "finding", createdAt: "2026-08-21T00:00:00Z" }] } }] } } } } }) };
    if (a.includes("/reviews")) return { ok: true, out: JSON.stringify([
      { id: 1, user: { login: "coderabbitai[bot]" }, state: "COMMENTED",
        commit_id: "a".repeat(40), body: "x", submitted_at: "2026-08-21T00:00:00Z" }]) };
    return { ok: true, out: "[]" };
  } });
  const sources = [...new Set(r.observations.map(o => o.source))];
  check(sources.length === 1 && sources[0] === "coderabbitai",
    "a REST review and a GraphQL thread from one bot land under ONE source",
    JSON.stringify(sources));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
