# Setting up the merge-policy GitHub App

Ten minutes, once. Free on every plan, public and private repos alike.

## Why this exists

The fleet currently acts as **you**, and you are the org admin. `nextlyhq/nextly`'s
`protect-main` ruleset grants `OrganizationAdmin` a `bypass_mode: "always"`, so every rule
written against that repo is walked through by the fleet's own token. That is the complete
explanation for the documented merge gate having merged 0 of the last 10 PRs: it never needed
`--admin`, ordinary merges bypassed silently.

An App installation is **not** an org admin. Once the fleet acts as the App:

- Removing the admin bypass leaves *you* a break-glass path while the fleet physically cannot
  bypass. The gate becomes a mechanism rather than a promise.
- The verdict can be a **check run**, which a user token cannot create at all. Verified:
  `POST /repos/{o}/{r}/check-runs` with a user token returns
  `403 You must authenticate via a GitHub App.`
- Fleet actions stop being attributed to you. Today 23 of 38 claim events read as `mobeen`
  because the actor falls back to `$USER`.
- A leaked installation token is narrow and expires in an hour; a leaked personal token is your
  whole account.

## Naming

The App's name appears on check runs and comments **in public repositories**. Per the standing
rule, nothing in a public or client repo may name reeve or Revnix.

Suggested: **`Merge Policy`** (slug `merge-policy`). Alternatives: `Delivery Gate`, `Release
Guard`. Pick one and keep it; renaming later changes every check-run byline.

## Steps

1. Go to **https://github.com/organizations/nextlyhq/settings/apps/new**
   (org settings → Developer settings → GitHub Apps → New GitHub App).

2. **GitHub App name:** `Merge Policy`
   **Homepage URL:** `https://github.com/nextlyhq/nextly` (anything valid; unused)

3. **Webhook:** untick **Active**. Polling comes first; webhooks are a later phase and need a
   public endpoint.

4. **Repository permissions** — set exactly these, leave everything else `No access`:

   | Permission | Level | Why |
   |---|---|---|
   | Checks | **Read and write** | publish the verdict at an exact `head_sha` |
   | Commit statuses | **Read and write** | read other bots' statuses; fallback surface |
   | Contents | **Read and write** | push fix commits to PR branches |
   | Pull requests | **Read and write** | open, comment, resolve threads, merge |
   | Issues | **Read and write** | PR comments are issue comments |
   | Actions | **Read-only** | read workflow runs, jobs and annotations for CI root-cause |
   | Administration | **Read-only** | read branch protection and rulesets, so `doctor` can tell enforced from attested |
   | Metadata | Read-only | mandatory, auto-selected |

   Nothing else. In particular **not** Administration write: reeve must never be able to edit
   the rules that judge it.

5. **Where can this GitHub App be installed?** → *Only on this account*.

6. **Create GitHub App.** On the next screen:
   - note the **App ID** (a number, top of the page);
   - click **Generate a private key** and keep the `.pem` it downloads.

7. **Install App** (left sidebar) → *Only select repositories* → `nextlyhq/nextly` → Install.

8. Store the credentials **outside every repository**, mode 600:

   ```sh
   mkdir -p ~/.reeve/credentials && chmod 700 ~/.reeve/credentials
   mv ~/Downloads/merge-policy.*.private-key.pem ~/.reeve/credentials/merge-policy.pem
   chmod 600 ~/.reeve/credentials/merge-policy.pem
   printf 'APP_ID=%s\nPRIVATE_KEY=%s\n' "<the app id>" "$HOME/.reeve/credentials/merge-policy.pem" \
     > ~/.reeve/credentials/merge-policy.env
   chmod 600 ~/.reeve/credentials/merge-policy.env
   ```

   The `.pem` is the App's identity. It never enters a repo, a profile, or an environment
   variable that gets logged.

## Verifying

```sh
reeve doctor nextlyhq/nextly --as-app
```

It should report the installation id, the granted permissions, and that check-run creation
succeeds. Until then `doctor` runs as you and reports `R-01 BROKEN`, correctly.

## What follows, and what does not

Creating the App changes nothing on its own. It makes two later steps possible:

- publishing the verdict as a required check run, and
- removing `OrganizationAdmin` from `protect-main`'s bypass actors.

Neither happens until `main` is green and the verdict has run **non-required for a week**, so
we can see what it would have blocked before it blocks anything. Flipping the gate against
today's baseline would block everything in flight, and that is the moment a bypass gets
reopened and the programme dies.
