// The resume-work skill's rules (.agents/skills/resume-work/scripts/lib.mjs).
//
// The skill's three scripts fetch from GitHub and git and print. Every decision
// they make is one of these functions: whether a flag exists, whether a check
// passed, whose move a pull request is, which task is ready, what a checkpoint
// says, and who won a claim. So each is tested here against the shapes GitHub
// and git return, with no network. Each rule below was a real defect first; its
// stub in test/stub-manifest.mjs puts the defect back.
import { parseArgs, postOnce, postComment, classifyChecks, triagePullRequest, closersByIssue,
         completePhase, sortTasks, nextSteps, formatCheckpoint, parseCheckpoint, describeCheckpoint,
         stashedOn, claimOutcome, unreleasedClaim, CLAIM, RELEASE } from "../.agents/skills/resume-work/scripts/lib.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── arguments ────────────────────────────────────────────────────────────────
// `claim.mjs --issue 150 --relase` used to claim the task, because only the
// spelled-right flag was looked for and everything else was ignored.
{
  const spec = { "--issue": "value", "--repo": "value", "--release": "switch" };
  const typo = parseArgs(["--issue", "150", "--relase"], spec);
  check(Boolean(typo.error?.includes("--relase")), "a misspelled flag is refused, not ignored", JSON.stringify(typo));
  const ok = parseArgs(["--issue", "150", "--release"], spec);
  check(ok.values?.issue === "150" && ok.values?.release === true, "control: known flags parse", JSON.stringify(ok));
  check(Boolean(parseArgs(["--issue"], spec).error), "a flag missing its value is refused");
  check(Boolean(parseArgs(["--issue", "1", "--issue", "2"], spec).error), "a flag given twice is refused");
  check(Boolean(parseArgs(["constructor"], spec).error), "a name every object has is not a flag");
}

// ── posting a comment once ───────────────────────────────────────────────────
// gh used to retry the POST itself, up to six times, before the read-back that
// was meant to stop a duplicate ever ran.
{
  const stored = [], calls = [];
  const run = (args, opts = {}) => {
    calls.push({ args, opts });
    if (args.includes("POST")) {
      stored.push(args.find((a) => a.startsWith("body=")).slice("body=".length));
      throw new Error("connection reset after the request was sent");
    }
    return stored.map((body, id) => JSON.stringify({ id, body, who: "tester", at: "2026-09-24T00:00:00Z" })).join("\n");
  };
  let threw = null;
  try { postComment("o/r", 7, "hello", { run, wait: () => {} }); } catch (err) { threw = err; }
  const posts = calls.filter((c) => c.args.includes("POST"));
  check(posts.length === 1 && stored.length === 1 && !threw,
    "a comment whose response was lost is not posted again", `posts=${posts.length} threw=${threw?.message}`);
  check(posts.length > 0 && posts.every((c) => c.opts.once === true),
    "the comment POST asks gh not to retry it", JSON.stringify(posts.map((c) => c.opts)));
}
{
  let tries = 0, stored = 0;
  postOnce(() => { tries++; if (tries < 3) throw new Error("reset before sending"); stored++; }, () => stored > 0);
  check(tries === 3 && stored === 1, "control: a POST that never arrived is tried again", `tries=${tries}`);
  let threw = false;
  try { postOnce(() => { throw new Error("down"); }, () => false, { attempts: 3 }); } catch { threw = true; }
  check(threw, "a POST that keeps failing is reported, not swallowed");
}

// ── checks ───────────────────────────────────────────────────────────────────
// STALE and EXPECTED were in neither list, so a pull request whose only check was
// one of them read as "checks passing" and waiting for a person.
const run = (conclusion) => ({ __typename: "CheckRun", name: `run-${conclusion}`, status: "COMPLETED", conclusion });
const status = (state) => ({ __typename: "StatusContext", context: `status-${state}`, state });
const rollup = (...nodes) => ({ totalCount: nodes.length, nodes });
{
  const stale = classifyChecks(rollup(run("STALE")));
  check(stale.failing.length === 1 && stale.unfinished === 0, "a STALE check is failing, not unfinished", JSON.stringify(stale));
  const expected = classifyChecks(rollup(status("EXPECTED")));
  check(expected.unfinished === 1 && expected.failing.length === 0, "an EXPECTED status is unfinished, not passing", JSON.stringify(expected));
  const unknown = classifyChecks(rollup(run("SOMETHING_NEW")));
  check(unknown.unfinished === 1, "a state nobody listed is unfinished, not passing", JSON.stringify(unknown));
  const running = classifyChecks(rollup({ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }));
  check(running.unfinished === 1, "control: a running check is unfinished", JSON.stringify(running));
  const green = classifyChecks(rollup(run("SUCCESS"), run("NEUTRAL"), run("SKIPPED"), status("SUCCESS")));
  check(green.failing.length === 0 && green.unfinished === 0, "control: SUCCESS, NEUTRAL and SKIPPED pass", JSON.stringify(green));
}

// ── whose move a pull request is ─────────────────────────────────────────────
// A review that requested changes only in its body leaves no thread, and was read
// as the pull request waiting for someone else.
const pr = (over = {}) => ({
  number: 1, title: "t", isDraft: false, author: { login: "me" }, reviewDecision: null, mergeable: "MERGEABLE",
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: rollup(run("SUCCESS")) } } }] }, ...over });
const withChecks = (contexts) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } });
{
  const asked = triagePullRequest(pr({ reviewDecision: "CHANGES_REQUESTED" }), "me");
  check(asked.needsMe && !asked.needsPerson, "a pull request with changes requested is its author's move", JSON.stringify(asked));
  const green = triagePullRequest(pr(), "me");
  check(!green.needsMe && green.needsPerson && green.notes.includes("checks passing"),
    "control: a green pull request with nothing open waits for a person", JSON.stringify(green));
  const partial = triagePullRequest(pr(withChecks({ totalCount: 101, nodes: Array(100).fill(run("SUCCESS")) })), "me");
  check(!partial.needsPerson && !partial.notes.includes("checks passing"),
    "a pull request whose checks weren't all read is not called passing", JSON.stringify(partial.notes));
  const stale = triagePullRequest(pr(withChecks(rollup(run("STALE")))), "me");
  check(stale.needsMe && !stale.needsPerson, "a pull request with a STALE check is its author's move", JSON.stringify(stale));
  const draft = triagePullRequest(pr({ isDraft: true }), "me");
  check(draft.needsMe && !draft.needsPerson, "an authored draft stays its author's move", JSON.stringify(draft));
  const manyThreads = triagePullRequest(pr({ reviewThreads: { totalCount: 130, nodes: Array(100).fill({ isResolved: true }) } }), "me");
  check(manyThreads.needsMe && !manyThreads.needsPerson,
    "a pull request whose review threads weren't all read stays its author's move", JSON.stringify(manyThreads));
  const theirs = triagePullRequest(pr({ author: { login: "someone" }, reviewDecision: "CHANGES_REQUESTED" }), "me");
  check(!theirs.needsMe && !theirs.needsPerson, "control: someone else's pull request is neither", JSON.stringify(theirs));
}

// ── which task is ready ──────────────────────────────────────────────────────
// Closing references used to come from a second query. When it failed, a task
// that an open pull request already covers came back ready, to be claimed twice.
{
  const prs = [{ number: 189, closingIssuesReferences: { nodes: [
    { number: 150, repository: { nameWithOwner: "revnix/reeve" } },
    { number: 150, repository: { nameWithOwner: "someone/else" } }] } }];
  const closers = closersByIssue(prs, "revnix/reeve");
  const task = (number, title, state = "OPEN", holders = []) =>
    ({ number, title, state, assignees: { nodes: holders.map((login) => ({ login })) } });
  const phases = [{ number: 148, subIssues: { nodes: [
    task(150, "covered by a pull request"), task(153, "ready"), task(152, "held", "OPEN", ["me"]),
    task(149, "done", "CLOSED"), task(154, "blocked")] } }];
  const s = sortTasks(phases, closers, (n) => (n === 154 ? 1 : 0));
  const nums = (rows) => rows.map((r) => r.number).join(",");
  check(nums(s.inReview) === "150" && !s.ready.some((r) => r.number === 150),
    "a task an open pull request will close is in review, not ready", JSON.stringify(s));
  check(nums(s.ready) === "153" && nums(s.inProgress) === "152",
    "control: held, ready, blocked and closed tasks sort apart", JSON.stringify(s));
  check(JSON.stringify(closers.get(150)) === "[189]",
    "a reference to another repository's issue closes nothing here", JSON.stringify([...closers]));
}

// A phase's sub-issues come a page at a time. Tasks past the first page used to
// vanish from every section, so the snapshot could say nothing was ready.
{
  const t = (number) => ({ number, title: `task ${number}`, state: "OPEN", assignees: { nodes: [] } });
  const first = Array.from({ length: 100 }, (_, i) => t(i + 1));
  const all = Array.from({ length: 150 }, (_, i) => t(i + 1));
  const asked = [];
  const big = completePhase({ number: 9, subIssues: { totalCount: 150, nodes: first } }, (n) => { asked.push(n); return all; });
  check(big.subIssues.nodes.length === 150 && asked.join() === "9", "a phase with more than 100 tasks is read in full",
    `read ${big.subIssues.nodes.length}, asked for ${asked.join() || "nothing"}`);
  const small = { number: 8, subIssues: { totalCount: 2, nodes: [t(1), t(2)] } };
  check(completePhase(small, () => { throw new Error("should not be asked"); }) === small,
    "control: a phase that fits one page is used as it is");
}

// What to do next. A held task used to be suggested beside a pull request that
// still needed its author, which is two next steps where the order allows one.
{
  const held = [{ number: 152 }], ready = [{ number: 153, title: "ready" }];
  const busy = nextSteps({ needsMe: ["PR #189: changes requested"], held, ready, needsPerson: [] });
  check(busy.length === 1 && busy[0].includes("#189"),
    "while a pull request needs its author, no task is suggested alongside it", JSON.stringify(busy));
  const holding = nextSteps({ needsMe: [], held, ready, needsPerson: [7] });
  check(holding[0].includes("#152") && !holding.some((l) => l.includes("#153")) && holding[1]?.includes("#7"),
    "control: with nothing to fix, the held task comes next, and waiting pull requests are still listed", JSON.stringify(holding));
  const idle = nextSteps({ needsMe: [], held: [], ready, needsPerson: [] });
  check(idle.length === 1 && idle[0].includes("#153"), "control: with nothing held, the first ready task", JSON.stringify(idle));
}

// ── checkpoints ──────────────────────────────────────────────────────────────
// The snapshot printed a checkpoint only when it had `next`, which is optional,
// and then printed only `next` and `blockers`.
{
  const body = formatCheckpoint({ branch: "task/x", head: "abc1234", done: "wrote the parser",
                                  remaining: "tests\nand docs", validation: "not run", blockers: "none" });
  const cp = parseCheckpoint(body);
  check(cp?.remaining === "tests\nand docs" && cp?.done === "wrote the parser" && cp?.branch === "task/x",
    "a checkpoint survives the round trip, a value over several lines included", JSON.stringify(cp));
  const shown = describeCheckpoint(cp, "2026-09-24T16:36:00Z").join("\n");
  check(shown.includes("wrote the parser") && shown.includes("and docs") && shown.includes("task/x @ abc1234"),
    "a checkpoint without next still shows done and remaining", shown);
  const older = parseCheckpoint("<!-- checkpoint v1 -->\nbranch:      a\nhead:        b\ndone:        c\n" +
    "remaining:   d\nvalidation:  not run\nblockers:    none\nnext:        e");
  check(older?.next === "e" && older?.done === "c", "control: a checkpoint written before this change still reads", JSON.stringify(older));
  check(parseCheckpoint("an ordinary comment") === null, "control: an ordinary comment is not a checkpoint");
}

// ── stashed work ─────────────────────────────────────────────────────────────
// After `git stash` the tree is clean, so a checkpoint was allowed while the
// task's edits sat in a stash that exists on one machine only.
{
  const subjects = ["WIP on task/x: abc1234 half done", "On task/x: before rebase",
                    "On task/xy: a different branch", "WIP on main: 1234567 other work"];
  const found = stashedOn("task/x", subjects);
  check(found.length === 2, "work stashed on the task's branch is found", JSON.stringify(found));
  check(stashedOn("task/z", subjects).length === 0, "control: stashes made on other branches are not the task's");
}

// ── claims ───────────────────────────────────────────────────────────────────
// Two defects. A loser under another account kept its assignment, so it looked
// like it held the task. And a claim whose author had been unassigned by hand
// beat every later claim for good.
{
  const claim = (session, who) => ({ id: session, who, body: `${CLAIM}session=${session} -->\nClaimed by @${who}` });
  const release = (who) => ({ id: "released", who, body: `${RELEASE}\nReleased by @${who}` });
  const race = [claim("aaaa", "alice"), claim("bbbb", "bob")];
  const bob = claimOutcome(race, { session: "bbbb", me: "bob", assignees: ["alice", "bob"] });
  check(!bob.won && bob.unassign && bob.winnerLogin === "alice",
    "the loser of a race against another account gives up its assignment", JSON.stringify(bob));
  const alice = claimOutcome(race, { session: "aaaa", me: "alice", assignees: ["alice", "bob"] });
  check(alice.won, "control: the earliest claim wins", JSON.stringify(alice));
  const same = claimOutcome([claim("aaaa", "me"), claim("bbbb", "me")], { session: "bbbb", me: "me", assignees: ["me"] });
  check(!same.won && !same.unassign && same.mine?.id === "bbbb",
    "a loser under the winner's account keeps the shared assignment", JSON.stringify(same));
  const handUnassigned = claimOutcome([claim("aaaa", "carol"), claim("bbbb", "me")], { session: "bbbb", me: "me", assignees: ["me"] });
  check(handUnassigned.won, "a claim whose author is no longer assigned does not win", JSON.stringify(handUnassigned));
  const afterRelease = claimOutcome([claim("aaaa", "me"), release("me"), claim("bbbb", "me")], { session: "bbbb", me: "me", assignees: ["me"] });
  check(afterRelease.won, "control: a claim after a release wins", JSON.stringify(afterRelease));
  const releasedByOther = claimOutcome([claim("aaaa", "alice"), release("bob"), claim("bbbb", "bob")],
    { session: "bbbb", me: "bob", assignees: ["alice", "bob"] });
  check(!releasedByOther.won && releasedByOther.winnerLogin === "alice",
    "a release ends only its author's claims", JSON.stringify(releasedByOther));
  check(unreleasedClaim([claim("aaaa", "me")], "me") && !unreleasedClaim([claim("aaaa", "me"), release("me")], "me"),
    "a claim its author hasn't released is found, so a halfway release can be finished");
  check(!unreleasedClaim([claim("aaaa", "alice")], "me"), "control: someone else's claim is not ours to release");
  const unconfirmed = claimOutcome([claim("bbbb", "me")], { session: "bbbb", me: "me", assignees: [] });
  check(!unconfirmed.won && unconfirmed.unassign && unconfirmed.winnerSession === null,
    "a claim that can't be confirmed holds nothing", JSON.stringify(unconfirmed));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
