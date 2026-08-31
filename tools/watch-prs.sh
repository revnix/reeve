#!/bin/bash
# Watch open pull requests for new review findings and for CI going red.
#
# In the repository rather than in a session's scratchpad, and that is the point.
# It used to live under whatever temporary directory the session that wrote it
# happened to own, and the handoff named that location as `<scratchpad>/…` -- a
# placeholder. So the one task that most needs this script, a fresh session with
# no watcher running, could not find it and had to rebuild a failure-sensitive
# thing from prose. Every lesson below was paid for once; recreating it from
# memory is how they get paid for twice.
#
# Usage:  tools/watch-prs.sh [PR ...]
#         tools/watch-prs.sh                # every open PR authored by you
#
# Environment:
#   WATCH_INTERVAL   seconds between ticks (default 900)
#   WATCH_TICKS      how many ticks before it stops (default 96, so 24h)
#   WATCH_STATE_DIR  where the state file lives (default a temp dir it makes)
#
# It reports on CHANGE, plus a HEARTBEAT every eighth tick, plus an ALARM when
# the probe itself fails. All three exist because of measured failures:
#
#  · change-only reporting makes a dead watcher and a quiet one identical;
#  · an empty snapshot from a transient `gh` failure differed from the stored
#    one, so a tick reported a change to nothing, stored the emptiness, found no
#    "OPEN" in it and EXITED -- an API blip reading as "the PR closed", ending
#    the watch with a line that looks like a clean stop;
#  · and a shell that does not word-split turns "28 29" into one bogus number,
#    so the list lives in a FILE read by redirect, never in an unquoted variable.
set -u

REPO="${WATCH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"
[ -n "$REPO" ] || { echo "watch-prs: cannot determine the repository; run inside a checkout or set WATCH_REPO" >&2; exit 1; }
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"

INTERVAL="${WATCH_INTERVAL:-900}"
TICKS="${WATCH_TICKS:-96}"
DIR="${WATCH_STATE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/watch-prs.XXXXXX")}"
mkdir -p "$DIR" || exit 1
STATE="$DIR/state"; LIST="$DIR/list"

# The list is written once and read by redirect on every tick.
if [ "$#" -gt 0 ]; then
  printf '%s\n' "$@" > "$LIST"
else
  # The initial enumeration obeys the same rule snapshot() states below: a failed
  # read is not an empty answer. Discarding the status here meant a rate limit or a
  # dropped connection produced an empty list, which then reported "nothing open to
  # watch" and exited 0 work later -- the watcher quietly declining to start at
  # precisely the moment it could not see, and no heartbeat afterwards to say so.
  #
  # RETRIED, because a watcher that gives up on one transient blip is not a watcher,
  # and the alternative is a human noticing hours later that nothing was watching.
  ok=0
  for attempt in 1 2 3; do
    if err=$(gh pr list --repo "$REPO" --author "@me" --state open --json number \
               -q '.[].number' 2>&1 >"$LIST"); then ok=1; break; fi
    echo "watch-prs: listing attempt $attempt failed: $err" >&2
    [ "$attempt" -lt 3 ] && sleep 5
  done
  # DISTINCT from "nothing open": exit 2 means the question was never answered.
  # Collapsing the two is what let an outage look like an idle queue.
  [ "$ok" = 1 ] || { echo "watch-prs: could not list pull requests in $REPO after 3 attempts; NOT starting" >&2; exit 2; }
fi
# An EMPTY list is two different facts and only one of them is "nothing open".
# Measured 2026-08-31: `gh pr list --author @me` on a repository that does not
# resolve exits ZERO with no rows, because --author routes through a search that
# reports no matches rather than an error; the same query WITHOUT --author exits 1.
# Transport, token and rate-limit failures do exit nonzero and the retry above
# catches them, but a renamed repository or a revoked grant arrives here looking
# exactly like an idle queue. So confirm the repository resolves before believing
# the emptiness. One extra read, and only on the path that would otherwise stop.
if [ ! -s "$LIST" ]; then
  if gh repo view "$REPO" --json name >/dev/null 2>&1; then
    echo "watch-prs: nothing open to watch in $REPO" >&2; exit 1
  fi
  echo "watch-prs: $REPO does not resolve, so 'nothing open' is unproven; NOT starting" >&2; exit 2
fi

snapshot() {
  local n="$1" threads ci
  threads=$(gh api graphql -f query="{repository(owner:\"$OWNER\",name:\"$NAME\"){pullRequest(number:$n){state reviewThreads(first:100){totalCount nodes{isResolved}}}}}" \
    --jq '.data.repository.pullRequest | "\(.state) open=\([.reviewThreads.nodes[]|select(.isResolved|not)]|length)/\(.reviewThreads.totalCount)"' 2>/dev/null)
  # Only a state the API actually REPORTED is usable. Anything else is a failed
  # probe and must never be recorded as a new fact. This is the whole reason the
  # watcher does not simply store what it read.
  case "$threads" in OPEN*|CLOSED*|MERGED*) ;; *) return 1 ;; esac
  ci=$(gh pr view "$n" --repo "$REPO" --json statusCheckRollup \
        -q '[.statusCheckRollup[]? | "\(.name // .context)=\(.conclusion // .state)"] | join(",")' 2>/dev/null) || return 1
  printf '%s ci=%s\n' "$threads" "$ci"
}

: > "$STATE"
STARTUP_FAILED=0
while read -r n; do
  if s=$(snapshot "$n"); then echo "$n $s" >> "$STATE"
  else echo "$n UNREADABLE" >> "$STATE"; STARTUP_FAILED=1; fi
done < "$LIST"
echo "watching $REPO PR(s) $(tr '\n' ' ' < "$LIST")every $((INTERVAL / 60)) min; change + heartbeat + failed-probe alarm"
echo "state: $STATE"
cat "$STATE"

# SEEDED from the startup probe, which is a probe like any other. Counting only
# scheduled ticks meant a startup failure was recorded as UNREADABLE and then
# forgotten, so the alarm needed a THIRD failed read and the watch stayed blind
# for two intervals while claiming a two-probe threshold. The first read is the
# one most likely to fail -- it runs before anything has warmed up.
MISSES="$STARTUP_FAILED"
# Arithmetic, not `seq`. MEASURED on darwin 25.6: `seq 1 0` prints "1 0" -- BSD
# seq counts DOWN when the second bound is lower, so `WATCH_TICKS=0` ran a tick
# and then slept for the full interval instead of doing nothing. GNU seq prints
# nothing for the same call. reeve has to run on macOS, Ubuntu and Windows, so a
# loop bound that means opposite things on two of them is not a loop bound.
i=0
while [ "$i" -lt "$TICKS" ]; do
  i=$((i + 1))
  sleep "$INTERVAL"
  NEW=""; ALIVE=0; FAILED=0
  while read -r n; do
    was=$(grep "^$n " "$STATE" | cut -d' ' -f2-)
    if now=$(snapshot "$n"); then
      [ "$now" != "$was" ] && { echo "[$(date -u +%H:%MZ)] PR #$n CHANGED"; echo "    was: $was"; echo "    now: $now"; }
      case "$now" in OPEN*) ALIVE=1 ;; esac
    else
      # Keep the LAST GOOD reading. Storing the failure would make the next tick
      # report a change back to reality, and would let a blip look like a close.
      FAILED=$((FAILED+1)); now="$was"; ALIVE=1
    fi
    NEW="$NEW$n $now
"
  done < "$LIST"
  printf '%s' "$NEW" > "$STATE"

  if [ "$FAILED" -gt 0 ]; then
    MISSES=$((MISSES+1))
    [ "$MISSES" -ge 2 ] && echo "[$(date -u +%H:%MZ)] ALARM: $MISSES consecutive ticks could not read $FAILED PR(s); this watch is BLIND, not quiet"
  else
    [ "$MISSES" -gt 0 ] && echo "[$(date -u +%H:%MZ)] probe recovered after $MISSES blind tick(s)"
    MISSES=0
  fi

  # Only a POSITIVELY read closed state stops the watch. Absence never does.
  if [ "$ALIVE" -eq 0 ]; then echo "[$(date -u +%H:%MZ)] every watched PR read as closed or merged; stopping"; exit 0; fi
  if [ $((i % 8)) -eq 0 ]; then echo "[$(date -u +%H:%MZ)] heartbeat: watching, $(tr '\n' ';' < "$STATE")"; fi
done
echo "watch window ended after $TICKS tick(s)"
