#!/usr/bin/env bash
# Lands a pull request the way this repo expects, then tidies up:
#   1. brings the branch up to date with main if it's behind, again if it
#      falls behind while CI runs, and stops if it has conflicts
#   2. waits for CI, and prints the failing job's log if it fails
#   3. squash-merges and deletes the remote branch, or, if main's ruleset
#      blocks it (a missing approval, say), names the rule and stops
#   4. removes the local worktree and branch, and pulls main
#   5. closes every bead named in a "Closes <bead-id>" line of the PR body
#   6. says whether .beads/issues.jsonl needs refreshing
#
# Exits non-zero whenever the PR ends up not merged, and says why. A PR that
# someone else already merged still gets steps 4 to 6.
#
# Usage: npm run land -- <pr-number>     (or scripts/land-pr.sh <pr-number>)
set -euo pipefail

# Run from a temporary copy: this script removes worktrees and pulls main,
# either of which can change or delete the file bash is still reading.
if [ -z "${LAND_PR_COPY:-}" ]; then
  copy="$(mktemp)"; cp "$0" "$copy"
  LAND_PR_COPY="$copy" exec bash "$copy" "$@"
fi

# Whatever path the script takes out, it fails unless the PR was merged.
merged=""
finish() {
  local rc=$?
  rm -f "$LAND_PR_COPY"
  if [ -z "$merged" ]; then
    printf '\nPR #%s was not merged.\n' "${pr:-?}"
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap finish EXIT

pr="${1:?usage: scripts/land-pr.sh <pr-number>}"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd "$main"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '%s\n' "$@"; exit 1; }

view() { gh pr view "$pr" --json "$1" -q ".$1"; }
branch="$(view headRefName)"
body="$(view body)"

# How long to keep asking while GitHub reports the merge state as UNKNOWN,
# which it does for a while after main moves (another PR merging, say).
unknown_poll=5 unknown_tries=36   # 3 minutes

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

wait_for_ci() {
  say "Waiting for CI on #$pr ($branch)"
  until gh pr checks "$pr" 2>/dev/null | grep -q 'CI passed'; do sleep 10; done
  if ! gh pr checks "$pr" --watch --interval 15 >/dev/null; then
    gh pr checks "$pr" || true
    run="$(gh run list --branch "$branch" --workflow CI -L 1 --json databaseId -q '.[0].databaseId')"
    say "CI failed. Failing steps from run $run:"
    gh run view "$run" --log-failed | tail -80
    exit 1
  fi
}

# BLOCKED with green CI means a ruleset rule other than the status check is
# unmet, usually a missing approval. Name the rules and say how to approve.
explain_blocked() {
  local approvals rules authors
  approvals="$(gh pr view "$pr" --json reviews -q '[.reviews[] | select(.state == "APPROVED")] | length')"
  say "PR #$pr is blocked: CI passed, but main's ruleset won't let it merge yet."
  if rules="$(gh api 'repos/{owner}/{repo}/rules/branches/main' --jq '
      .[] | select(.type == "pull_request") | .parameters |
      (if (.required_approving_review_count // 0) > 0 then "- required_approving_review_count: \(.required_approving_review_count) approving review(s) needed" else empty end),
      (if .require_extra_approval_for_unattributed_changes then "- require_extra_approval_for_unattributed_changes: a PR with commits not attributed to a person (release-please commits are by github-actions[bot]) needs a human approval" else empty end),
      (if .require_code_owner_review then "- require_code_owner_review: a code owner must approve" else empty end),
      (if .require_last_push_approval then "- require_last_push_approval: someone other than the last pusher must approve" else empty end),
      (if .required_review_thread_resolution then "- required_review_thread_resolution: every review conversation must be resolved" else empty end)
    ' 2>/dev/null)"; then
    if [ -n "$rules" ]; then
      echo "main's pull_request rule requires:"
      printf '%s\n' "$rules"
    fi
  else
    echo "Couldn't read main's rules. See them with: gh api repos/{owner}/{repo}/rules/branches/main"
  fi
  authors="$(gh pr view "$pr" --json commits -q '[.commits[].authors[].login | select(. != "")] | unique | join(", ")' 2>/dev/null || true)"
  [ -z "$authors" ] || echo "Commit authors on this PR: $authors"
  if [ "${approvals:-0}" -eq 0 ]; then
    echo "It has no approving review. Approve it (you can't approve your own PR), then run this again:"
    echo "  gh pr review $pr --approve"
    echo "  npm run land -- $pr"
  else
    echo "It has $approvals approving review(s), so something else is blocking it. Check unresolved conversations and code scanning alerts on:"
    echo "  $(view url)"
  fi
  exit 1
}

state="$(view state)"
case "$state" in
  MERGED) echo "PR #$pr is already merged." ;;
  OPEN) ;;
  *) fail "PR #$pr is $state." ;;
esac

if [ "$state" = "OPEN" ]; then
  # main can move while CI runs, so after each green run check again and, if
  # the branch has fallen behind, update it and wait for CI once more.
  max_updates=3 updates=0
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
    say "Squash-merging #$pr"
    # gh can report failure after a successful merge (deleting a local branch
    # that a worktree has checked out), so trust the PR's state instead.
    out="$(gh pr merge "$pr" --squash --delete-branch 2>&1)" || true
    if [ "$(view state)" != "MERGED" ]; then
      printf '%s\n' "$out"
      [ "$(merge_state)" != "BLOCKED" ] || explain_blocked
      fail "Merge failed."
    fi
  fi
fi
merged=1
echo "Merged as $(gh pr view "$pr" --json mergeCommit -q '.mergeCommit.oid[0:7]')"

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

if ! node scripts/export-beads.mjs --check >/dev/null; then
  say "The committed beads export is out of date. Refresh it in your next PR with: npm run beads:export"
fi
