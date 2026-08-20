// "Needs you" reached a local log file and nothing else. An unattended system
// whose only output is a file nobody is watching has not escalated anything.
//
// The push is deliberately narrow. The old ops notifier earned its shape by
// experience and its comment says so: push ONLY what is costing wall-clock right
// now, because an over-pushing channel gets muted within days and is then worse
// than nothing. Completions go to the store; only escalations go to the phone,
// and escalations are already deduplicated durably, so a standing cause is sent
// once rather than every tick.
//
// The payload is redacted because escalation text can carry a CI log slice, and a
// log slice can carry a token. A notification is the one place output leaves this
// machine.
import { buildAlert, redact, notify } from "../src/notify.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// --- redaction ----------------------------------------------------------------
{
  const cases = [
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "a GitHub personal token"],
    ["github_pat_11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOP", "a fine-grained PAT"],
    ["ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "an installation token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key header"],
    ["Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def", "a bearer token"],
  ];
  for (const [secret, what] of cases) {
    const out = redact(`the build failed: ${secret} was rejected`);
    check(!out.includes(secret), `${what} is redacted`, out);
    check(/redacted/i.test(out), "  and its removal is visible rather than silent", out);
  }
}
{
  // Control: ordinary text must survive, or redaction is just deletion.
  const msg = "required check(s) never reported: Lint / Typecheck / Test / Build";
  check(redact(msg) === msg, "control: ordinary escalation text passes through untouched", redact(msg));
}
{
  const long = "x".repeat(5000);
  const out = redact(long);
  check(out.length < 1000, "an enormous message is truncated — a phone is not a log viewer", String(out.length));
}

// --- the alert ----------------------------------------------------------------
{
  const a = buildAlert({ nwo: "o/r", escalations: [{ why: "#12: the branch conflicts with its base", count: 1 }] });
  check(a.title.includes("o/r"), "the alert names the repository, so several projects are distinguishable", a.title);
  check(a.message.includes("#12"), "and the pull request", a.message);
  check(a.priority === "high", "escalations go out at high priority — they are what is costing time", a.priority);
}
{
  const a = buildAlert({ nwo: "o/r", escalations: [
    { why: "the base branch is red", count: 4 },
    { why: "#12: conflicts", count: 1 }] });
  check((a.message.match(/\n/g) ?? []).length >= 1, "several causes arrive as ONE push, not several", a.message);
  check(/4/.test(a.message), "and a shared cause says how many PRs it holds up", a.message);
}
{
  check(buildAlert({ nwo: "o/r", escalations: [] }) === null,
    "nothing to say means no push at all — silence is the target state");
}

// --- sending ------------------------------------------------------------------
{
  // Not configured must be a no-op, never a crash and never a blocked tick.
  const r = notify({ profile: {}, alert: { title: "t", message: "m" } });
  check(r.ok === false && /not configured|no notify/i.test(r.why ?? ""),
    "with no notify configured it declines, and says so", JSON.stringify(r));
}
{
  // A missing credential is the same: decline, do not throw, do not send unauthenticated.
  const profile = { notify: { provider: "ntfy", url: "https://example.invalid", topic: "t",
                              credentialFile: "/nonexistent/creds" } };
  const r = notify({ profile, alert: { title: "t", message: "m" } });
  check(r.ok === false && /credential/i.test(r.why ?? ""),
    "a missing credential declines rather than sending unauthenticated", JSON.stringify(r));
}
{
  let sent = null;
  const profile = { notify: { provider: "ntfy", url: "https://example.invalid", topic: "reeve",
                              credentialFile: "/nonexistent/creds" } };
  const r = notify({ profile, alert: { title: "t", message: "m" }, post: a => { sent = a; return { ok: true }; },
                     readCredential: () => "user:pass" });
  check(r.ok && sent, "with a credential it sends", JSON.stringify(r));
  check(sent.url === "https://example.invalid/reeve", "to the configured topic", sent?.url);
  check(!JSON.stringify(sent).includes("user:pass") || sent.auth === "user:pass",
    "and the credential is passed as auth, not embedded in the body", JSON.stringify(sent.body));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
