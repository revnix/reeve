// The App's installation and token requests (#296). They go out with Node's
// `fetch`, which says only "fetch failed" and keeps why in its `cause`, and the
// daemon logged just that, 63 times in three days. A request that got no answer
// is asked once more, bounded as every other network call is (#282), and says
// why it failed. Every request here goes to a stand-in for `fetch`: none reaches
// GitHub.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authenticate } from "../src/github/app.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const REPO = "o/r";
/** A reeve home holding App credentials made for this test: an id and a key of its own. */
const home = () => {
  const dir = tempDir("reeve-app-token-");
  const creds = join(dir, "credentials");
  mkdirSync(creds, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(creds, "test-app.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  writeFileSync(join(creds, "merge-policy.env"), `APP_ID=1\nPRIVATE_KEY=${keyPath}\n`, { mode: 0o600 });
  return dir;
};
/** GitHub's answer: a status and a body. */
const answer = (/** @type {number} */ status, /** @type {unknown} */ body) => ({ answer: () => new Response(JSON.stringify(body), { status }) });
/** No answer: what `fetch` throws, "fetch failed" and why in its cause. */
const unanswered = (/** @type {string} */ code, /** @type {string} */ message) =>
  ({ throws: () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) }) });
const INSTALLATION = answer(200, { id: 7, account: { login: "o" }, app_slug: "merge-policy", permissions: {}, repository_selection: "selected" });
const TOKEN = answer(201, { token: "test-token", expires_at: "2026-10-01T00:00:00Z", permissions: {} });

/**
 * Authenticate as the App, with `fetch` answering each request as `answers`
 * says, in turn, the last for every request after. The requests made, and the
 * result, or what it threw.
 * @param {({ answer: () => Response } | { throws: () => unknown })[]} answers
 */
async function authenticateWith(answers) {
  const was = process.env.REEVE_HOME;
  process.env.REEVE_HOME = home();
  /** @type {{ url: string, init: any }[]} */ const asked = [];
  /** @type {number[]} */ const paused = [];
  const fetched = mock.method(globalThis, "fetch", async (/** @type {any} */ url, /** @type {any} */ init) => {
    const a = answers[Math.min(asked.length, answers.length - 1)];
    asked.push({ url: String(url), init });
    if ("throws" in a) throw a.throws();
    return a.answer();
  });
  try {
    /** @type {any} */ let result;
    try { result = await authenticate(REPO, "merge-policy", /** @type {any} */ ({ pause: async (/** @type {number} */ ms) => { paused.push(ms); } })); }
    catch (e) { result = { ok: false, threw: String(/** @type {Error} */ (e).message) }; }
    return { asked, result, paused };
  } finally {
    fetched.mock.restore();
    if (was === undefined) delete process.env.REEVE_HOME; else process.env.REEVE_HOME = was;
  }
}

test("control: the App authenticates where GitHub answers", async () => {
  const { asked, result } = await authenticateWith([INSTALLATION, TOKEN]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.token, "test-token");
  assert.deepEqual(asked.map((a) => a.url), ["https://api.github.com/repos/o/r/installation", "https://api.github.com/app/installations/7/access_tokens"]);
});

test("a request that got no answer is asked once more, and the answer it then gets is used", async () => {
  const { asked, result, paused } = await authenticateWith([INSTALLATION, unanswered("ECONNRESET", "read ECONNRESET"), TOKEN]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.token, "test-token");
  assert.equal(asked.length, 3, "the token asked for twice");
  assert.ok(paused.length === 1 && paused[0] > 0, `a moment later, not at once: ${JSON.stringify(paused)}`);
});

test("a request that got no answer twice fails, saying why, rather than throwing", async () => {
  const { asked, result } = await authenticateWith([unanswered("ENOTFOUND", "getaddrinfo ENOTFOUND api.github.com")]);
  assert.equal(result.threw, undefined, `it threw: ${result.threw}`);
  assert.equal(result.ok, false);
  assert.match(String(result.why), /getaddrinfo ENOTFOUND api\.github\.com/, "why, from the error's cause");
  assert.match(String(result.why), /asked twice/);
  assert.doesNotMatch(String(result.why), /no installation/, "not taken for an answer that there's none");
  assert.equal(asked.length, 2, "asked once more, and no more");
});

test("a connection that failed at each address GitHub has says why at each", async () => {
  const refused = (/** @type {string} */ at) => Object.assign(new Error(`connect ECONNREFUSED ${at}:443`), { code: "ECONNREFUSED" });
  const each = { throws: () => Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([refused("192.0.2.1"), refused("2001:db8::1")]) }) };
  const { result } = await authenticateWith([each]);
  assert.match(String(result.why), /connect ECONNREFUSED 192\.0\.2\.1:443; connect ECONNREFUSED 2001:db8::1:443/);
});

test("an answer, whatever its status, isn't asked for again", async () => {
  const { asked, result } = await authenticateWith([answer(404, { message: "Not Found" })]);
  assert.equal(result.ok, false);
  assert.match(String(result.why), /HTTP 404: /);
  assert.equal(asked.length, 1);
});

test("each request is bounded, as the daemon's other network calls are", async () => {
  const { asked } = await authenticateWith([INSTALLATION, TOKEN]);
  assert.ok(asked.length && asked.every((a) => a.init?.signal instanceof AbortSignal), "each carries a signal that ends it");
});

test("a request stopped at its bound says so", async () => {
  const stopped = { throws: () => new DOMException("The operation was aborted due to timeout", "TimeoutError") };
  const { result } = await authenticateWith([stopped]);
  assert.equal(result.threw, undefined, `it threw: ${result.threw}`);
  assert.match(String(result.why), /didn't answer within 60 seconds/);
});
