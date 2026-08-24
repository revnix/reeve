// App authentication. The fleet acts as the App, never as the founder.
//
// The whole merge boundary rests on this: an App installation is not an org
// admin, so it physically cannot use `protect-main`'s OrganizationAdmin bypass.
// Running as the founder's token is what made the previous gate decorative.
//
// Two tokens, and they are not interchangeable:
//   · a JWT signed with the private key authenticates the APP (list installations)
//   · an installation token authenticates the APP ON A REPO (everything else)
// The installation token expires in an hour, which is the point: a leaked one is
// narrow and short-lived where a leaked personal token is the whole account.

import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveHome } from "../home.mjs";

// A FUNCTION, not a constant. As a module-level constant this was evaluated
// at import -- before `bin/reeve` had resolved `--home` -- and it consulted
// `homedir()` rather than the reeve home at all, so no home setting of any
// kind reached the App credentials.
const credDir = () => join(resolveHome(), "credentials");

/** Load App credentials. The key is read from disk each time and never cached to disk elsewhere. */
export function loadAppCredentials(name = "merge-policy") {
  const envPath = join(credDir(), `${name}.env`);
  if (!existsSync(envPath)) return { ok: false, why: `no credentials at ${envPath}` };
  const env = Object.fromEntries(
    readFileSync(envPath, "utf8").split("\n").filter(Boolean).map(l => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
  if (!env.APP_ID) return { ok: false, why: `${envPath} has no APP_ID` };
  if (!env.PRIVATE_KEY || !existsSync(env.PRIVATE_KEY)) return { ok: false, why: `private key missing at ${env.PRIVATE_KEY}` };
  return { ok: true, appId: env.APP_ID, keyPath: env.PRIVATE_KEY };
}

const b64url = buf => Buffer.from(buf).toString("base64url");

/**
 * A short-lived JWT proving we hold the App's private key.
 * `iat` is backdated 60s because GitHub rejects a token whose clock is ahead of
 * theirs, and a laptop clock drifts.
 */
export function mintAppJwt({ appId, keyPath }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = b64url(signer.sign(readFileSync(keyPath, "utf8")));
  return `${header}.${payload}.${sig}`;
}

/** Call the API as the App itself, with a Bearer header gh cannot produce. */
async function apiAsApp(jwt, path, init = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "reeve", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, err: text.slice(0, 300) };
  return { ok: true, status: r.status, out: text };
}

/** Which installation covers this repo? */
export async function findInstallation(jwt, nwo) {
  const [owner, repo] = nwo.split("/");
  const r = await apiAsApp(jwt, `repos/${owner}/${repo}/installation`);
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}: ${r.err.split("\n")[0]}` };
  const inst = JSON.parse(r.out);
  return { ok: true, id: inst.id, account: inst.account?.login, permissions: inst.permissions, repositorySelection: inst.repository_selection };
}

/** An installation token: one hour, scoped to the repos the App is installed on. */
export async function mintInstallationToken(jwt, installationId) {
  const r = await apiAsApp(jwt, `app/installations/${installationId}/access_tokens`, { method: "POST" });
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}: ${r.err.split("\n")[0]}` };
  const j = JSON.parse(r.out);
  return { ok: true, token: j.token, expiresAt: j.expires_at, permissions: j.permissions };
}

/**
 * Everything the fleet does on GitHub goes through here, as the App.
 * The token is passed by environment and never written to disk or logged.
 */
export function apiAsInstallation(token, args) {
  try {
    const out = execFileSync("gh", ["api", ...args], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (e) { return { ok: false, out: "", err: String(e.stderr || e.message).trim() }; }
}

/** One call: credentials to a usable installation token. */
export async function authenticate(nwo, name = "merge-policy") {
  const cred = loadAppCredentials(name);
  if (!cred.ok) return cred;
  let jwt;
  try { jwt = mintAppJwt(cred); }
  catch (e) { return { ok: false, why: `could not sign a JWT with ${cred.keyPath}: ${e.message}` }; }
  const inst = await findInstallation(jwt, nwo);
  if (!inst.ok) return { ok: false, why: `no installation for ${nwo}: ${inst.why}` };
  const tok = await mintInstallationToken(jwt, inst.id);
  if (!tok.ok) return { ok: false, why: tok.why };
  return { ok: true, token: tok.token, expiresAt: tok.expiresAt, installationId: inst.id,
           account: inst.account, permissions: tok.permissions, repositorySelection: inst.repositorySelection };
}

/**
 * The permissions the design actually needs. Reported as a diff rather than a
 * boolean so a missing grant names itself.
 *
 * Administration is READ only, deliberately: reeve must never be able to edit
 * the rules that judge it.
 */
export const REQUIRED_PERMISSIONS = {
  checks: "write", statuses: "write", contents: "write",
  issues: "write", pull_requests: "write",
  actions: "read", administration: "read", metadata: "read",
};

export function checkPermissions(granted = {}) {
  const rank = { read: 1, write: 2, admin: 3 };
  const missing = [], excess = [];
  for (const [k, need] of Object.entries(REQUIRED_PERMISSIONS)) {
    const have = granted[k];
    if (!have || rank[have] < rank[need]) missing.push(`${k}: need ${need}, have ${have ?? "none"}`);
  }
  // An over-grant is a finding too: administration:write would let the fleet
  // rewrite its own gate.
  for (const [k, have] of Object.entries(granted)) {
    const need = REQUIRED_PERMISSIONS[k];
    if (!need) excess.push(`${k}: ${have} (not required)`);
    else if (rank[have] > rank[need]) excess.push(`${k}: ${have} exceeds the required ${need}`);
  }
  return { ok: missing.length === 0, missing, excess };
}
