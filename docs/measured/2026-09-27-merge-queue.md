# Measured: how GitHub's merge queue treats reeve's required check

Date: 2026-09-27. Repository: `nextlyhq/merge-queue-sandbox`, public, made for
this measurement (#163). The Merge Policy app is installed on it.

`main`'s ruleset:
- requires a pull request, merged by squash, with no approval;
- requires two checks: `test` from GitHub Actions (App 15368), which runs on
  `pull_request` and `merge_group`, and `ops/merge-policy` from the Merge
  Policy app (App 4660593);
- requires a merge queue: squash, grouped all green, and a check timeout of 10
  minutes.

Pull requests were queued with GraphQL's `enqueuePullRequest`. `ops/merge-policy`
was published by hand as the app, as an enforcing reeve would publish it.

| Step | What GitHub did |
|---|---|
| A pull request with `test` passing and no `ops/merge-policy` | `mergeStateStatus` BLOCKED. reeve read the base's rules as requiring `ops/merge-policy`, with `rule merge_queue` among what it doesn't evaluate. |
| `ops/merge-policy` passing on the pull request's head | `mergeStateStatus` CLEAN. A required queue doesn't make a pull request BLOCKED. |
| Queued (14:55:26 UTC) | Within 28 seconds it built a commit, 149edfc, on the branch `gh-readonly-queue/main/pr-1-<base sha>`. `mergeQueue.entries` and the pull request's `mergeQueueEntry` showed the entry `AWAITING_CHECKS`, with that commit as `headCommit`. `test` ran on it and passed. The pull request stayed CLEAN. |
| Nothing published on the queue's commit | At 15:06:13 GitHub removed the entry, with the reason `checks_timed_out`. That's 10 minutes 47 seconds after queuing. The pull request stayed open and CLEAN, and the queue's branch was deleted. The pass on the pull request's head counted for nothing there. |
| Queued again. `ops/merge-policy` passed on the new queue commit, 56e3345, at 15:06:53 | Merged at 15:07:27, 34 seconds later. `main`'s head became 56e3345, the queue's commit itself. |
| A second pull request queued. `ops/merge-policy` failed on its queue commit, 6ff3054, at 15:08:17 | Removed at 15:08:49, with the reason `failed_checks`. The pull request stayed open. |

## With reeve publishing, enforcing, from #163's branch

`reeve run nextlyhq/merge-queue-sandbox --enforce --interval 60`, with the queue's
check timeout raised to 30 minutes.

| Step | What happened |
|---|---|
| Queued at 22:19:04 UTC, while reeve published a settling UNKNOWN on the queue's commit as `action_required` | Removed at 22:20:50, with the reason `failed_checks`, 31 seconds after that publication. A queue reads any settled result that isn't success as a failure. |
| After the fix, queued at 22:23:37. On the queue's commit, 9bf42da, reeve published its settling UNKNOWN as in progress, at 22:26:54 and 22:28:12 | The queue waited. |
| reeve's verdict on 9bf42da was PASS, published at 22:29:29 | Merged at 22:29:43, 14 seconds later. `main`'s head became 9bf42da. |
| On 2026-09-28, from `main` at 2a8692d: pull request #4 passed at its head at 00:40:39 and was queued at 00:40:50. The ruleset's own `test` passed on its queue commit, 4bfe2c3, at 00:41:16 | An unresolved review thread was added at 00:41:26. The ruleset doesn't require resolved conversations, so only reeve reads it. |
| reeve judged 4bfe2c3 BLOCK, and published `ops/merge-policy` as a failure there at 00:42:04 | Removed at 00:42:34, with the reason `failed_checks`. The pull request stayed open. |

A pull request on a branch named `mp/…`, reeve's builders' prefix, is judged as a
builder's, whose holds are read from the builder hub. With no hub on this machine,
the first attempt, #3, was UNKNOWN for that reason. Renaming its branch closed it,
as GitHub reads a renamed head branch as deleted, so #4 used the new name.

## What followed

- **The queue commit is what merges.** A required check has to pass on it, and a
  pass on the pull request's head doesn't count there. So reeve judges each
  queue entry's own commit, and publishes on it.
- **The queue commit's verdict:**
  - The pull request's own facts carry over: its reviews, threads, findings and
    holds.
  - CI is read on the queue's commit, and settled apart from the pull request's
    head.
  - The base is judged at the queue's base commit.
- **Only a queue commit judged whole is published on.** A check there speaks for
  every pull request the queue put on it, so reeve publishes only when each was
  judged this tick, without error, at the head the queue holds it at (the
  entry's `pullRequest.headRefOid`). Otherwise it publishes nothing there, and
  takes back a PASS standing there. A HALT is checked before each publication,
  and again after the last.
- **A merge queue on the base isn't a requirement only a person can settle.**
  GitHub reports a pull request whose required checks pass as CLEAN under a
  required queue. So when such a base reports BLOCKED, the queue isn't the
  reason, and reeve counts `merge_queue` among the rules that can't stop a merge.
- **What a queue reads as a failure.** Any settled result on the queue's commit
  that isn't success removes the entry. So there, an UNKNOWN that waiting or
  reading again settles is published as in progress. A block, a pass, and an
  UNKNOWN only a person can settle are settled there as anywhere.
- **Timing.** Nextly's queue waits 60 minutes for checks. A daemon that polls every
  5 minutes, and settles CI over three readings, answers within about 15 minutes of
  the queue's own checks finishing. The sandbox's 10 minutes is too short for that,
  so its timeout goes up for the end-to-end test.
