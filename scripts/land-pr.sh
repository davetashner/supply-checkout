#!/usr/bin/env bash
# Lands a pull request the way this repo expects, then tidies up:
#   1. brings the branch up to date with main if it's behind, again if it
#      falls behind while CI runs, and stops if it has conflicts
#   2. waits for CI (up to 30 minutes for its CI passed check to appear),
#      and prints the failing job's log if it fails
#   3. squash-merges the commit CI passed on and deletes the remote branch
#      (retrying twice after a transient GitHub error), or, if main's ruleset blocks it (a missing
#      approval, say), names the rule and stops
#
#   When main's ruleset has a merge queue, steps 1 to 3 are instead: wait for
#   the PR's CI, add the PR to the queue, and wait while the queue runs the
#   full CI on top of main and merges it (or print the failing log if the
#   queue drops it). The queue keeps the branch current, so there's no update
#   loop.
#
#   4. removes the local worktree and branch, and pulls main
#   5. closes every bead named in a "Closes <bead-id>" line of the PR body
#   6. releases the land lock, and if .beads/issues.jsonl is stale, this isn't
#      the export's own PR, and the export committed on origin/main is a day
#      old or more (node scripts/export-beads.mjs --due), runs npm run
#      beads:pr, which opens the export PR and lands it with a land of its own.
#      So there's at most one export PR a day.
#   7. rebuilds the backlog page (the main checkout's dist/backlog/index.html,
#      which people open locally)
#   LAND_SKIP_BACKLOG=1 skips steps 6 and 7.
#
# Only one land runs at a time across every worktree and session: without a
# merge queue, two lands at once keep pushing each other's PRs behind main. A
# lock file in the shared .git directory holds the land's PID, PR number and
# start time; a second land waits for it, and a lock whose land is no longer
# running is taken over. A PR that's already merged (cleanup only) and the
# merge-queue path skip the lock: the queue serializes merges itself. The merge
# queue needs main's repo to be owned by an organization.
#
# Exits non-zero whenever the PR ends up not merged, and says why. A PR that
# someone else already merged still gets steps 4 to 7. Steps 6 and 7 never
# change the exit code: the PR is merged by then, and a failed export PR is
# reported, left open to land, and flagged again by the Stop hook
# (scripts/backlog-stop-hook.mjs) while the export stays stale and due.
#
# Two gates come before any merge (supply-checkout-pbp.46, pbp.47), checked
# once before waiting for the PR's CI and again right before merging:
#   - The release window. Landing a release-please PR records a release lock
#     (the tag, its PR and when it merged) next to the land lock. While it's
#     held, every land refuses, naming the release, until that tag's deploy.yml
#     run (titled "Deploy <tag>", started after the merge) has completed, with
#     success or failure; the land that sees it completed clears the lock. The
#     lead clears it by hand with --release-done (a release whose checks failed
#     never starts a deploy, say).
#   - main's CI. A PR is refused while main's latest completed ci.yml push run
#     didn't succeed, printing its failing jobs and link, unless the lead passes
#     --fixes-main for the PR that fixes main. If a newer run on main's head is
#     still going, the land waits for it (up to 45 minutes) first. A release PR
#     needs more: main's CI passed on main's head, the exact commit the release
#     will tag, waiting for that run up to 45 minutes; --fixes-main doesn't
#     apply to it.
#
# Usage: npm run land -- <pr-number> [--fixes-main]
#        npm run land -- --release-done   (clears the release window)
#        (or scripts/land-pr.sh with the same arguments)
set -euo pipefail

# Run from a temporary copy: this script removes worktrees and pulls main,
# either of which can change or delete the file bash is still reading.
if [ -z "${LAND_PR_COPY:-}" ]; then
  # The land-pr name lets a waiting land recognize a running one by its command
  copy="$(mktemp "${TMPDIR:-/tmp}/land-pr.XXXXXX")"; cp "$0" "$copy"
  LAND_PR_COPY="$copy" exec bash "$copy" "$@"
fi

# Whatever path the script takes out, it fails unless the PR was merged.
merged=""
finish() {
  local rc=$?
  rm -f "$LAND_PR_COPY"
  ! declare -F release_lock >/dev/null || release_lock
  if [ -z "$merged" ]; then
    printf '\nPR #%s was not merged.\n' "${pr:-?}"
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap finish EXIT
# Run finish on Ctrl-C and kill too, so the lock is released
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '%s\n' "$@"; exit 1; }
usage="usage: scripts/land-pr.sh <pr-number> [--fixes-main], or scripts/land-pr.sh --release-done"
pr="" fixes_main="" release_done=""
for arg in "$@"; do
  case "$arg" in
    --fixes-main) fixes_main=1 ;;
    --release-done) release_done=1 ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]] && [ -z "$pr" ]; then pr="$arg"; else fail "$usage"; fi ;;
  esac
done
if [ -n "$release_done" ]; then
  if [ -n "$pr$fixes_main" ]; then fail "$usage"; fi
elif [ -z "$pr" ]; then
  fail "$usage"
fi
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd "$main"

# The land lock (see the top). Waits while another land holds it.
lock="$(git rev-parse --path-format=absolute --git-common-dir)/land-pr.lock"
lock_poll=10 have_lock=""
# Prints nothing, and still succeeds, once the lock is gone: the holder can
# release it at any moment, and under set -e and pipefail a failed read here
# would end a waiting land.
lock_field() { { sed -n "s/^$1=//p" "$lock" 2>/dev/null || true; } | head -1; }
# A PID only counts as a land if that process is still running this script
land_running() { [ -n "$1" ] && ps -p "$1" -o command= 2>/dev/null | grep -q 'land-pr'; }
take_lock() {
  local pid mine="$lock.$$" waiting=""
  printf 'pid=%s\npr=%s\nstarted=%s\n' "$$" "$pr" "$(date '+%Y-%m-%d %H:%M:%S')" > "$mine"
  # ln fails if the lock exists, and never shows a half-written lock
  until ln "$mine" "$lock" 2>/dev/null; do
    pid="$(lock_field pid)"
    [ -n "$pid" ] || continue   # released just now
    if ! land_running "$pid"; then
      # Look again right before removing it, in case another land just took it
      if [ "$(lock_field pid)" = "$pid" ]; then
        echo "Taking over the lock from the land of #$(lock_field pr) (pid $pid), which is no longer running."
        rm -f "$lock"
      fi
      continue
    fi
    if [ "$pid" != "$waiting" ]; then
      echo "Waiting for the land of #$(lock_field pr) (pid $pid, started $(lock_field started))"
      waiting="$pid"
    fi
    sleep "$lock_poll"
  done
  rm -f "$mine"
  have_lock=1
  [ -z "$waiting" ] || echo "Took the lock for #$pr"
}
release_lock() {
  rm -f "$lock.$$"
  if [ -n "$have_lock" ] && [ "$(lock_field pid)" = "$$" ]; then rm -f "$lock"; fi
  have_lock=""
}

# The release lock (see the top), next to the land lock: tag=, pr= and taken=,
# the release PR's merge time from GitHub (UTC, as deploy runs' createdAt is).
release_file="$(git rev-parse --path-format=absolute --git-common-dir)/land-pr-release.lock"
release_field() { { sed -n "s/^$1=//p" "$release_file" 2>/dev/null || true; } | head -1; }
tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

if [ -n "$release_done" ]; then
  # Nothing to merge on this path, so finish mustn't say a PR wasn't merged
  merged=1
  if [ -e "$release_file" ]; then
    echo "Cleared the release window for $(release_field tag) (#$(release_field pr), merged $(release_field taken))."
    rm -f "$release_file"
  else
    echo "No release window is open."
  fi
  exit 0
fi

# Refuses while a release window is open, and clears it once the release's
# deploy run has completed. Fails closed: a lock it can't read, or deploy runs
# it can't list, refuse too.
check_release_window() {
  [ -e "$release_file" ] || return 0
  local tag rpr taken found st concl url
  tag="$(release_field tag)" rpr="$(release_field pr)" taken="$(release_field taken)"
  if ! [[ "$tag" =~ $tag_pattern ]] || [ -z "$taken" ]; then
    fail "The release lock ($release_file) doesn't name a release tag and merge time, so nothing lands until it's cleared." \
      "Once the release has deployed (or won't), clear it with: npm run land -- --release-done"
  fi
  # The deploy runs for the tag that started after the release merged: the
  # first completed one if any, else the first
  found="$(TAG="$tag" TAKEN="$taken" gh run list --workflow deploy.yml -L 100 \
      --json displayTitle,status,conclusion,createdAt,url -q '
      [.[] | select(.displayTitle == "Deploy " + env.TAG and .createdAt >= env.TAKEN)] | sort_by(.createdAt) |
      ((map(select(.status == "completed")) | first) // first) // empty |
      "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.url)"')" ||
    fail "Release $tag (#$rpr) holds the release window, and its deploy runs couldn't be listed (gh run list --workflow deploy.yml)." \
      "Nothing lands until its deploy has finished. Run this again, or once the release has deployed clear it with: npm run land -- --release-done"
  read -r st concl url <<< "$found"
  if [ "$st" = "completed" ]; then
    echo "Release $tag's deploy finished ($concl): $url"
    echo "Its release window is over: clearing the release lock."
    rm -f "$release_file"
    return 0
  fi
  say "Release $tag (#$rpr, merged $taken) is in its release window: nothing else merges until its deploy finishes."
  if [ -n "$st" ]; then echo "Its deploy run is $st: $url"
  else echo "No deploy run for $tag has started yet (the release workflow starts it once the release's checks pass)."; fi
  fail "Run this again once that deploy has finished. If the release won't deploy (its checks failed, say)," \
    "the lead clears the window with: npm run land -- --release-done"
}

# main's CI: its ci.yml push runs (supply-checkout-pbp.46)
main_ci_poll=30 main_ci_tries=90   # 45 minutes
# Prints "<status> <conclusion or -> <run id> <url>" for the newest push run of
# ci.yml on main that matches the extra gh run list arguments, or nothing
main_run() {
  gh run list --workflow ci.yml --branch main --event push -L 1 "$@" --json databaseId,status,conclusion,url -q '
    .[0] // empty | "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.databaseId) \(.url)"'
}
main_head() { gh api 'repos/{owner}/{repo}/branches/main' --jq .commit.sha; }
# Prints a red run's link and the jobs that didn't pass
show_red_run() { # conclusion run-id url
  echo "main's CI run ended $1: $3"
  echo "Jobs that didn't pass:"
  { gh run view "$2" --json jobs -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | .name' 2>/dev/null ||
    echo "(couldn't list them: gh run view $2)"; } | sed 's/^/  - /'
}
# Waits, up to the bound, for main's run on the given commit to complete, and
# prints it as main_run does (or nothing if none ever appeared)
wait_main_run() { # sha
  local run tries=0
  while :; do
    run="$(main_run --commit "$1")" || exit 1
    if [ "${run%% *}" = "completed" ] || [ "$tries" -ge "$main_ci_tries" ]; then break; fi
    if [ "$tries" -eq 0 ]; then
      echo "Waiting up to $(( main_ci_poll * main_ci_tries / 60 )) minutes for main's CI on ${1:0:7}${run:+: ${run##* }}" >&2
    fi
    sleep "$main_ci_poll"; tries=$((tries + 1))
  done
  printf '%s\n' "$run"
}

# Any PR but a release PR: main's latest completed push run must have passed
check_main_green() {
  local run st concl id url head newest
  run="$(main_run --status completed)" || fail "Couldn't read main's CI runs (gh run list --workflow ci.yml --branch main)."
  [ -n "$run" ] || fail "main has no completed CI run to go by (gh run list --workflow ci.yml --branch main --event push)."
  read -r st concl id url <<< "$run"
  [ "$concl" != "success" ] || return 0
  if [ -n "$fixes_main" ]; then
    say "main is red, and --fixes-main says #$pr is the fix: landing it anyway."
    show_red_run "$concl" "$id" "$url"
    return 0
  fi
  # A newer run on main's head (the fix, say) may still turn main green
  head="$(main_head)" || fail "Couldn't read main's head commit."
  newest="$(main_run --commit "$head")" || exit 1
  if [ -n "$newest" ] && [ "${newest%% *}" != "completed" ]; then
    say "main's latest completed CI run failed, and a newer one on ${head:0:7} is still going: waiting for it."
    newest="$(wait_main_run "$head")"
    if [ "$(cut -d' ' -f1-2 <<< "$newest")" = "completed success" ]; then
      echo "main's CI passed on ${head:0:7}."
      return 0
    fi
    if [ "${newest%% *}" = "completed" ]; then read -r st concl id url <<< "$newest"; fi
  fi
  say "main is red: #$pr wasn't merged."
  show_red_run "$concl" "$id" "$url"
  fail "Land the PR that fixes main first, with: npm run land -- <fix-pr> --fixes-main" \
    "then land #$pr once main's CI passes."
}

# A release PR: main's CI must have passed on main's head, the commit the
# release will tag (the release PR is up to date with it, as main's ruleset
# requires, so its squash merge sits right on it)
check_release_base() {
  local head run st concl id url
  head="$(main_head)" || fail "Couldn't read main's head commit."
  run="$(wait_main_run "$head")"
  [ -n "$run" ] || fail "main's CI hasn't run on ${head:0:7}, the commit release $release_tag would tag, after $(( main_ci_poll * main_ci_tries / 60 )) minutes." \
    "Release PRs merge only once main's CI passed on that commit. See: gh run list --workflow ci.yml --branch main"
  read -r st concl id url <<< "$run"
  if [ "$st" != "completed" ]; then
    fail "main's CI on ${head:0:7} is still $st after $(( main_ci_poll * main_ci_tries / 60 )) minutes: $url" \
      "Release PRs merge only once main's CI passed on the commit they release. Run this again when it has."
  fi
  if [ "$concl" != "success" ]; then
    say "main's CI didn't pass on ${head:0:7}, the commit release $release_tag would tag: #$pr wasn't merged."
    show_red_run "$concl" "$id" "$url"
    fail "Fix main first (npm run land -- <fix-pr> --fixes-main); release-please then updates this PR."
  fi
  echo "main's CI passed on ${head:0:7}, the commit release $release_tag will tag: $url"
}

# Both gates, before waiting for CI and again right before merging
check_gates() {
  check_release_window
  if [ -n "$is_release" ]; then check_release_base; else check_main_green; fi
}

view() { gh pr view "$pr" --json "$1" -q ".$1"; }
branch="$(view headRefName)"
body="$(view body)"
title="$(view title)"

# A release-please PR: its branch, or its title. Either counts, so a release
# PR is never treated as an ordinary one.
is_release="" release_tag=""
if [[ "$branch" == release-please--* ]] || [[ "$title" =~ ^chore\(main\):\ release\  ]]; then
  is_release=1
  if [[ "$title" =~ ^chore\(main\):\ release\ ([0-9][^ ]*)$ ]]; then release_tag="v${BASH_REMATCH[1]}"; fi
fi

# How long to keep asking while GitHub reports the merge state as UNKNOWN,
# which it does for a while after main moves (another PR merging, say).
unknown_poll=5 unknown_tries=36   # 3 minutes

# How many times to try the squash merge while the PR stays open and clean,
# waiting merge_backoff seconds longer before each retry (5s, then 10s)
max_merge_tries=3 merge_backoff=5

# Prints the PR's merge state, or MERGED / CLOSED once the PR is no longer open
# (a merged PR's merge state stays UNKNOWN forever). Progress goes to stderr.
merge_state() {
  local state status tries=0
  read_state() {
    local both
    both="$(gh pr view "$pr" --json state,mergeStateStatus -q '.state + " " + .mergeStateStatus')" || exit 1
    state="${both%% *}" status="${both#* }"
  }
  read_state
  while [ "$state" = "OPEN" ] && [ "$status" = "UNKNOWN" ] && [ "$tries" -lt "$unknown_tries" ]; do
    if [ "$tries" -eq 0 ]; then
      printf 'GitHub is still working out whether #%s can merge (merge state UNKNOWN). Checking every %ss for up to %s minutes.\n' \
        "$pr" "$unknown_poll" "$(( unknown_poll * unknown_tries / 60 ))" >&2
    elif [ $(( tries * unknown_poll % 30 )) -eq 0 ]; then
      printf '  still UNKNOWN after %ss\n' "$(( tries * unknown_poll ))" >&2
    fi
    sleep "$unknown_poll"; tries=$((tries + 1))
    read_state
  done
  if [ "$state" = "OPEN" ]; then printf '%s\n' "$status"; else printf '%s\n' "$state"; fi
}

# How long to wait for the CI passed check to show up at all. It never does
# while a run waits for approval (a first-time contributor's fork, say).
ci_appear_poll=10 ci_appear_tries=180   # 30 minutes

# Waits for CI and sets head_sha to the commit it ran on. The merge is pinned
# to that commit (--match-head-commit), so a push after CI can't be merged
# untested. It's read before the wait: checks are always for this commit or a
# newer one, and a newer one makes the pinned merge refuse, never merge.
head_sha=""
wait_for_ci() {
  say "Waiting for CI on #$pr ($branch)"
  head_sha="$(view headRefOid)"
  # gh pr checks exits 1 while a check fails and 8 while one is pending, and
  # under pipefail that exit code, not grep's, would decide the loop: a failed
  # CI would then keep this land (and the lock) waiting forever.
  local tries=0
  until { gh pr checks "$pr" 2>/dev/null || true; } | grep -q 'CI passed'; do
    if [ "$tries" -ge "$ci_appear_tries" ]; then
      gh pr checks "$pr" 2>&1 || true
      fail "" "The CI passed check hasn't appeared on #$pr after $(( ci_appear_poll * ci_appear_tries / 60 )) minutes." \
        "A run may be waiting for approval, or CI didn't start. Look at the PR's checks, then run this again."
    fi
    sleep "$ci_appear_poll"; tries=$((tries + 1))
  done
  if ! gh pr checks "$pr" --watch --interval 15 >/dev/null; then
    gh pr checks "$pr" || true
    run="$(gh run list --branch "$branch" --workflow CI -L 1 --json databaseId -q '.[0].databaseId')"
    say "CI failed. Failing steps from run $run:"
    gh run view "$run" --log-failed | tail -80
    exit 1
  fi
}

# BLOCKED with green CI means a ruleset rule other than the status check is
# unmet: a missing approval, or a code_scanning rule whose tool (CodeQL) hasn't
# reported on the PR or found alerts. Name the rules that apply and say what to do.
explain_blocked() {
  local approvals rules authors unattributed tools tool scan_state scan_blocked="" needs_approval=""
  approvals="$(gh pr view "$pr" --json reviews -q '[.reviews[] | select(.state == "APPROVED")] | length')"
  say "PR #$pr is blocked: CI passed, but main's ruleset won't let it merge yet."

  # A code_scanning rule needs each tool's results on the PR. The code scanning
  # check is named after the tool ("CodeQL"), and CI's jobs that produce them
  # are "CodeQL" too, or "CodeQL / CodeQL (<language>)". A skipped CI job leaves
  # no results, so a missing, skipped or failing check blocks the merge.
  tools="$(gh api 'repos/{owner}/{repo}/rules/branches/main' --jq '
      [.[] | select(.type == "code_scanning") | .parameters.code_scanning_tools[]?.tool] | unique | .[]' 2>/dev/null || true)"
  while IFS= read -r tool; do
    [ -n "$tool" ] || continue
    scan_state="$(TOOL="$tool" gh pr view "$pr" --json statusCheckRollup -q '
        [(.statusCheckRollup // [])[] | select((.name // "") == env.TOOL or ((.name // "") | startswith(env.TOOL + " / ")))
         | (.conclusion // .state // "" | ascii_upcase)] |
        if length == 0 then "missing"
        elif any(.[]; . == "SKIPPED") then "skipped"
        elif any(.[]; . == "" or . == "PENDING" or . == "QUEUED" or . == "IN_PROGRESS") then "pending"
        elif all(.[]; . == "SUCCESS" or . == "NEUTRAL") then "ok"
        else "failing" end' 2>/dev/null || echo unknown)"
    case "$scan_state" in
      ok) ;;
      missing|skipped)
        scan_blocked=1
        echo "- code_scanning: main needs $tool results on every PR, and this PR's $tool check is $scan_state."
        echo "  Make sure the codeql job in .github/workflows/ci.yml runs for this change (it must not skip),"
        echo "  push the fix or rerun CI, and land again once $tool has reported." ;;
      pending)
        scan_blocked=1
        echo "- code_scanning: main needs $tool results on every PR, and this PR's $tool check hasn't finished."
        echo "  Wait for it, then run: npm run land -- $pr" ;;
      *)
        scan_blocked=1
        echo "- code_scanning: main needs $tool results with no errors or medium-or-higher security alerts,"
        echo "  and this PR's $tool check is $scan_state. See its alerts and logs on the PR's checks:"
        echo "  $(view url)/checks" ;;
    esac
  done <<< "$tools"

  # The unattributed-changes rule only bites when a commit's author isn't a
  # linked GitHub user (no login) or is a bot, like release-please's commits.
  unattributed="$(gh pr view "$pr" --json commits -q '
      [.commits[].authors[] | select((.login // "") == "" or ((.login // "") | endswith("[bot]")))] | length > 0' 2>/dev/null || echo false)"
  if rules="$(gh api 'repos/{owner}/{repo}/rules/branches/main' --jq '
      .[] | select(.type == "pull_request") | .parameters |
      (if (.required_approving_review_count // 0) > 0 then "- required_approving_review_count: \(.required_approving_review_count) approving review(s) needed" else empty end),
      (if .require_extra_approval_for_unattributed_changes then "- require_extra_approval_for_unattributed_changes: a PR with commits not attributed to a person (release-please commits are by github-actions[bot]) needs a human approval" else empty end),
      (if .require_code_owner_review then "- require_code_owner_review: a code owner must approve" else empty end),
      (if .require_last_push_approval then "- require_last_push_approval: someone other than the last pusher must approve" else empty end),
      (if .required_review_thread_resolution then "- required_review_thread_resolution: every review conversation must be resolved" else empty end)
    ' 2>/dev/null)"; then
    if [ "$unattributed" != "true" ]; then
      rules="$(grep -v '^- require_extra_approval_for_unattributed_changes:' <<< "$rules" || true)"
    fi
    if [ -n "$rules" ]; then
      echo "main's pull_request rule requires:"
      printf '%s\n' "$rules"
      if grep -q 'approv' <<< "$rules"; then needs_approval=1; fi
    fi
  else
    echo "Couldn't read main's rules. See them with: gh api repos/{owner}/{repo}/rules/branches/main"
    needs_approval=1
  fi
  authors="$(gh pr view "$pr" --json commits -q '[.commits[].authors[].login | select(. != "")] | unique | join(", ")' 2>/dev/null || true)"
  [ -z "$authors" ] || echo "Commit authors on this PR: $authors"
  if [ -n "$scan_blocked" ] && [ -z "$needs_approval" ]; then
    echo "An approval won't help: fix the code scanning results above."
  elif [ "${approvals:-0}" -eq 0 ] && { [ -n "$needs_approval" ] || [ -z "$scan_blocked" ]; }; then
    echo "It has no approving review. Approve it (you can't approve your own PR), then run this again:"
    echo "  gh pr review $pr --approve"
    echo "  npm run land -- $pr"
  elif [ -z "$scan_blocked" ]; then
    echo "It has $approvals approving review(s), so something else is blocking it. Check unresolved conversations and code scanning alerts on:"
    echo "  $(view url)"
  fi
  exit 1
}

# main's ruleset has a merge_queue rule once the owner turns the queue on
has_merge_queue() {
  [ "$(gh api 'repos/{owner}/{repo}/rules/branches/main' --jq 'any(.[]; .type == "merge_queue")' 2>/dev/null)" = "true" ]
}

# How long to wait for the queue to merge the PR, and how long a PR may sit
# with auto-merge on but outside the queue (waiting on an approval, say)
queue_poll=15 queue_tries=240 outside_tries=4   # 1 hour; 1 minute

# Prints MERGED or CLOSED once the PR is no longer open, "QUEUED <position>
# <entry state>" while it's in the merge queue, AUTO while auto-merge is on but
# it isn't queued yet, and NONE otherwise.
queue_status() {
  # shellcheck disable=SC2016 # $owner and friends are GraphQL variables
  gh api graphql -F owner='{owner}' -F repo='{repo}' -F number="$pr" -f query='
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          state
          mergeQueueEntry { state position }
          autoMergeRequest { enabledAt }
        }
      }
    }' --jq '.data.repository.pullRequest |
      if .state != "OPEN" then .state
      elif .mergeQueueEntry then "QUEUED \(.mergeQueueEntry.position) \(.mergeQueueEntry.state)"
      elif .autoMergeRequest then "AUTO"
      else "NONE" end'
}

# The queue drops a PR when CI fails on its merge group (the PR on top of main
# and whatever is ahead of it in the queue)
queue_failed() {
  local run
  say "PR #$pr left the merge queue without merging, usually because CI failed on its merge group."
  run="$(gh run list --workflow CI --event merge_group -L 20 --json databaseId,headBranch \
    -q "[.[] | select(.headBranch | contains(\"/pr-$pr-\"))][0].databaseId // empty")"
  if [ -n "$run" ]; then
    say "Failing steps from run $run:"
    gh run view "$run" --log-failed | tail -80
  else
    echo "Find the run with: gh run list --workflow CI --event merge_group"
  fi
  exit 1
}

wait_for_queue() { # gh pr merge's output, printed if the PR never joins the queue
  local status last="" seen="" outside=0 tries=0 position entry
  while :; do
    status="$(queue_status)" || exit 1
    case "$status" in
      MERGED) return 0 ;;
      CLOSED) fail "PR #$pr was closed without merging." ;;
      QUEUED*)
        seen=1 outside=0
        if [ "$status" != "$last" ]; then
          read -r _ position entry <<< "$status"
          echo "In the merge queue: position $position, $entry"
        fi ;;
      *)
        [ -z "$seen" ] || queue_failed
        outside=$((outside + 1))
        if [ "$outside" -gt "$outside_tries" ]; then
          if [ "$status" = "AUTO" ]; then
            echo "Auto-merge is on for #$pr, but it hasn't joined the merge queue. It joins once nothing blocks it."
            explain_blocked
          fi
          printf '%s\n' "$1"
          [ "$(merge_state)" != "BLOCKED" ] || explain_blocked
          fail "PR #$pr didn't join the merge queue."
        fi ;;
    esac
    last="$status" tries=$((tries + 1))
    if [ "$tries" -ge "$queue_tries" ]; then
      fail "PR #$pr is still in the merge queue after $(( queue_poll * queue_tries / 60 )) minutes. It merges on its own when the queue's CI passes; run this again then to clean up."
    fi
    sleep "$queue_poll"
  done
}

state="$(view state)"
case "$state" in
  MERGED) echo "PR #$pr is already merged." ;;
  OPEN) ;;
  *) fail "PR #$pr is $state." ;;
esac

if [ "$state" = "OPEN" ]; then
  if [ -n "$is_release" ]; then
    [[ "$release_tag" =~ $tag_pattern ]] ||
      fail "#$pr looks like a release-please PR, but its title (\"$title\") doesn't name a version like \"chore(main): release 1.2.3\"."
    [ -z "$fixes_main" ] || fail "#$pr is a release PR: --fixes-main doesn't apply. A release merges only from a green main."
  fi
  # Fail fast, before the wait for CI; checked again right before merging
  check_gates
fi

if [ "$state" = "OPEN" ] && has_merge_queue; then
  say "main has a merge queue: it tests #$pr on top of main with the full CI, then merges it"
  status="$(merge_state)"
  case "$status" in
    MERGED) echo "PR #$pr was merged by someone else while this was waiting." ;;
    CLOSED) fail "PR #$pr was closed without merging." ;;
    DIRTY) fail "PR #$pr has conflicts with main. Rebase $branch onto origin/main, push, and run this again." ;;
    DRAFT) fail "PR #$pr is a draft. Mark it ready with: gh pr ready $pr" ;;
    UNKNOWN) fail "GitHub still reports #$pr's merge state as UNKNOWN after $(( unknown_poll * unknown_tries / 60 )) minutes. Run this again in a few minutes." ;;
  esac
  if [ "$status" != "MERGED" ]; then
    # The queue only takes a PR whose own checks passed
    wait_for_ci
    check_gates
    say "Adding #$pr to the merge queue"
    # The queue squash-merges (its ruleset setting). --delete-branch isn't
    # used: the branch is deleted below once the queue has merged it.
    out="$(gh pr merge "$pr" --squash --match-head-commit "$head_sha" 2>&1)" || true
    wait_for_queue "$out"
    if git push -q origin --delete "$branch" 2>/dev/null; then echo "Deleted remote branch $branch"; fi
  fi
elif [ "$state" = "OPEN" ]; then
  take_lock
  # main can move while CI runs, so after each green run check again and, if
  # the branch has fallen behind, update it and wait for CI once more.
  # Under the lock, main only moves when something merges outside this script.
  max_updates=10 updates=0
  status="$(merge_state)"
  while [ "$status" != "MERGED" ]; do
    case "$status" in
      CLOSED) fail "PR #$pr was closed without merging." ;;
      DIRTY) fail "PR #$pr has conflicts with main. Rebase $branch onto origin/main, push, and run this again." ;;
      UNKNOWN) fail "GitHub still reports #$pr's merge state as UNKNOWN after $(( unknown_poll * unknown_tries / 60 )) minutes. Run this again in a few minutes." ;;
      BEHIND)
        if [ "$updates" -ge "$max_updates" ]; then
          fail "PR #$pr is still behind main after $max_updates updates. Run this again once main is quiet."
        fi
        say "Branch is behind main: updating it"
        gh pr update-branch "$pr"
        updates=$((updates + 1))
        sleep 5 ;;
    esac
    wait_for_ci
    status="$(merge_state)"
    case "$status" in
      CLEAN) break ;;
      MERGED|CLOSED|BEHIND|DIRTY|UNKNOWN) ;;   # handled at the top of the loop
      BLOCKED) explain_blocked ;;
      DRAFT) fail "PR #$pr is a draft. Mark it ready with: gh pr ready $pr" ;;
      *) fail "PR #$pr can't be merged: merge state is $status." ;;
    esac
  done

  if [ "$status" = "MERGED" ]; then
    echo "PR #$pr was merged by someone else while this was waiting."
  else
    # Again, under the land lock: main or the release window may have changed while CI ran
    check_gates
    say "Squash-merging #$pr"
    # gh can report failure after a successful merge (deleting a local branch
    # that a worktree has checked out), so trust the PR's state instead. A
    # merge can also fail on a transient GitHub error (a GraphQL EOF, say):
    # while the PR is still open and clean, try again after a short backoff.
    merge_tries=0
    while :; do
      out="$(gh pr merge "$pr" --squash --delete-branch --match-head-commit "$head_sha" 2>&1)" || true
      merge_tries=$((merge_tries + 1))
      status="$(merge_state)"
      [ "$status" != "MERGED" ] || break
      printf '%s\n' "$out"
      if [ "$(view headRefOid)" != "$head_sha" ]; then
        fail "$branch changed after CI passed on ${head_sha:0:7}, so it wasn't merged. Run this again to wait for CI on the new commit."
      fi
      if [ "$status" = "CLEAN" ] && [ "$merge_tries" -lt "$max_merge_tries" ]; then
        echo "Retrying the merge in $(( merge_backoff * merge_tries ))s: #$pr is still open and clean (try $merge_tries of $max_merge_tries failed)."
        sleep "$(( merge_backoff * merge_tries ))"
        continue
      fi
      [ "$status" != "BLOCKED" ] || explain_blocked
      fail "Merge failed."
    done
  fi
fi
merged=1
echo "Merged as $(gh pr view "$pr" --json mergeCommit -q '.mergeCommit.oid[0:7]')"

# A release PR this land saw open opens the release window (see the top)
if [ -n "$is_release" ] && [ "$state" = "OPEN" ]; then
  taken="$(view mergedAt)"
  [ -n "$taken" ] && [ "$taken" != "null" ] || taken="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'tag=%s\npr=%s\ntaken=%s\n' "$release_tag" "$pr" "$taken" > "$release_file.$$"
  mv "$release_file.$$" "$release_file"
  say "Release window open for $release_tag: no other PR lands until its deploy (deploy.yml, \"Deploy $release_tag\") finishes."
  echo "If it won't deploy, clear it with: npm run land -- --release-done"
fi

say "Cleaning up"
wt="$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree /{p=$2} $0=="branch "b{print p}')"
if [ -n "$wt" ]; then
  if git worktree remove "$wt" 2>/dev/null; then echo "Removed worktree $wt"
  else echo "Kept worktree $wt: it has uncommitted changes. Remove it with: git worktree remove --force $wt"; fi
else
  echo "No worktree left for $branch"
fi
git worktree prune
# Drop the empty .claude/worktrees/<type>/ folders left behind
[ -d .claude/worktrees ] && find .claude/worktrees -mindepth 1 -type d -empty -delete
if git branch -D "$branch" >/dev/null 2>&1; then echo "Deleted local branch $branch"; else echo "No local branch $branch left"; fi
if [ "$(git branch --show-current)" = "main" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  git pull -q --ff-only origin main && echo "main is at $(git log --oneline -1)"
else
  echo "Skipped pulling main: the main checkout isn't on a clean main branch."
fi
git fetch -q --prune

ids="$(printf '%s\n' "$body" | grep -oE '^[Cc]loses[: ]+supply-checkout-[A-Za-z0-9.]+' | grep -oE 'supply-checkout-[A-Za-z0-9.]+' || true)"
if [ -n "$ids" ]; then
  say "Closing beads"
  for id in $ids; do
    if [ "$(bd show "$id" --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d["status"])' 2>/dev/null)" = "closed" ]; then
      echo "$id already closed"
    else
      bd close "$id" --reason "Completed in PR #$pr" | tail -1
    fi
  done
fi

# Keep both views of the backlog current (see CLAUDE.md): the committed
# export for machines, and the backlog page for people. LAND_SKIP_BACKLOG=1
# skips both. The beads:pr run below passes it on to the export PR's land,
# since this land rebuilds the page once that's done.
if [ -n "${LAND_SKIP_BACKLOG:-}" ]; then
  echo "LAND_SKIP_BACKLOG is set: left the beads export and the backlog page alone"
  exit 0
fi

# Release the land lock first: beads:pr lands its PR with a land of its own,
# which takes the lock, and would otherwise wait for this one forever.
release_lock

export_failed=""
export_rc=0
node scripts/export-beads.mjs --check >/dev/null 2>&1 || export_rc=$?
if [ "$export_rc" -eq 2 ]; then
  echo "Couldn't check the beads export (bd failed). Check it with: node scripts/export-beads.mjs --check"
elif [ "$export_rc" -ne 0 ]; then
  if [[ "$branch" == chore/beads-export-* ]]; then
    # Beads changed while the export's own PR landed: no loop, just say so
    echo "The beads export is stale again; refresh it with: npm run beads:pr"
  elif [ -e "$release_file" ]; then
    # Its land would be refused until the release has deployed
    echo "The beads export is stale, but release $(release_field tag)'s window is open: left for a land after its deploy (or run npm run beads:pr then)"
  elif ! node scripts/export-beads.mjs --due >/dev/null 2>&1; then
    # At most one export PR a day: the committed export is recent enough
    echo "The beads export is stale, but the committed one is less than a day old: left for a later land (or run npm run beads:pr)"
  else
    say "The beads export is stale: refreshing it with npm run beads:pr"
    # Not a failure of this land: #$pr is merged either way, and the Stop hook
    # keeps asking for beads:pr while the export stays stale
    LAND_SKIP_BACKLOG=1 npm run -s beads:pr || export_failed=1
  fi
fi

say "Rebuilding the backlog page"
node scripts/backlog-page.mjs ||
  echo "Couldn't rebuild the backlog page (see above). Rebuild it with npm run backlog:page."
if [ -n "$export_failed" ]; then
  echo
  echo "#$pr merged, but the beads export PR didn't land (see above). Once it can merge, land it, or run npm run beads:pr again."
fi
