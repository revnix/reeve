# Founder action: give the Merge Policy App access to nextly-ops

**Time needed: about 2 minutes. All clicks, no terminal.**

---

## What this is, in plain words

reeve's builder will open its **spec PRs** (the design documents you approve)
in the private repo `nextlyhq/nextly-ops`. It does this as the GitHub App
called **Merge Policy**, never as your personal account.

Right now that App can only see one repository: `nextlyhq/nextly`. It cannot
see `nextly-ops` at all (every probe returns 404). Until you add `nextly-ops`
to the App's repository list, reeve cannot push a spec branch, open a spec PR,
or read Codex's review of it.

Everything below was measured on 2026-08-21:

| Fact | Value |
|---|---|
| App name | **Merge Policy** (slug `merge-policy`) |
| App ID | 4660593 |
| Installation | 155196718, on the **nextlyhq** organization |
| Repository access mode | "Only select repositories" |
| Currently selected | `nextlyhq/nextly` only |
| Repo to add | `nextlyhq/nextly-ops` (confirmed **private**) |

**When it is needed:** before the spec-PR machinery lands (the builder rollout
PR that opens the first spec PR). Nothing before that needs it. reeve will also
escalate a reminder at exactly the moment it becomes the blocker, so doing it
now simply removes a future interruption.

---

## The steps, one by one

1. **Open this link** (you must be logged in to GitHub as the nextlyhq org
   owner):

   https://github.com/organizations/nextlyhq/settings/installations/155196718

   You should see a page titled with the **Merge Policy** app and its
   installation settings.

   *If the link asks for something you cannot see:* go to the nextlyhq
   organization page, then **Settings** (org settings, not repo settings), then
   **Third-party Access → GitHub Apps** in the left sidebar, then click
   **Configure** next to **Merge Policy**.

2. Scroll to the **Repository access** section. It will show
   **"Only select repositories"** already chosen, with `nextlyhq/nextly` in the
   list. Leave that choice exactly as it is. Do NOT switch to
   "All repositories".

3. Click the **Select repositories** dropdown, type `nextly-ops`, and click
   **nextlyhq/nextly-ops** when it appears.

4. The list should now show **two** repositories: `nextly` and `nextly-ops`.

5. Click **Save**.

That is the whole task. No permission prompts should appear: adding a
repository reuses the permissions the App already has, it does not grant new
ones.

---

## How to verify it worked

Either of these, whichever is easier:

**Option A, zero effort:** tell Claude / reeve "I did the App install" and it
will run the probe and confirm.

**Option B, one paste in a terminal:**

```sh
~/.nvm/versions/node/v24.17.0/bin/node -e '
import(process.env.HOME + "/Work/Products/reeve/src/github/app.mjs").then(async m => {
  const jwt = m.mintAppJwt(m.loadAppCredentials());
  const tok = await fetch("https://api.github.com/app/installations/155196718/access_tokens",
    { method: "POST", headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json", "User-Agent": "reeve" } }).then(r => r.json());
  const repos = await fetch("https://api.github.com/installation/repositories",
    { headers: { Authorization: "Bearer " + tok.token, Accept: "application/vnd.github+json", "User-Agent": "reeve" } }).then(r => r.json());
  console.log("App now reaches:", repos.repositories.map(r => r.full_name).join(", "));
})'
```

Success looks like:

```
App now reaches: nextlyhq/nextly, nextlyhq/nextly-ops
```

If `nextly-ops` is missing from that line, the Save did not take: reopen the
link in step 1 and check the Repository access list again.

(Once the builder ships, `reeve builder doctor` performs this same check
automatically and reports it on one line.)

---

## What this unblocks, and what it does not

**Unblocks:** reeve pushing spec branches (`specs/bt-<id>/...`), opening spec
PRs on nextly-ops, posting the Codex review request on them, and reading the
review results, all under the App's identity.

**Does not change:** anything on `nextlyhq/nextly`, anything about the
guardian daemon, any permission the App holds, or anything in the ledger. The
App still cannot bypass branch protection anywhere, which is the point of
using it.

**Undo, if ever needed:** same page, remove `nextly-ops` from the list, Save.
