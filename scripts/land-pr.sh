#!/usr/bin/env bash
# Lands a pull request the way this repo expects, then tidies up:
#   1. brings the branch up to date with main if it's behind
#   2. waits for CI, and prints the failing job's log if it fails
#   3. squash-merges and deletes the remote branch
#   4. removes the local worktree and branch, and pulls main
#   5. closes every bead named in a "Closes <bead-id>" line of the PR body
#   6. says whether .beads/issues.jsonl needs refreshing
#
# Usage: npm run land -- <pr-number>     (or scripts/land-pr.sh <pr-number>)
set -euo pipefail

pr="${1:?usage: scripts/land-pr.sh <pr-number>}"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd "$main"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

view() { gh pr view "$pr" --json "$1" -q ".$1"; }
branch="$(view headRefName)"
body="$(view body)"

if [ "$(view state)" != "MERGED" ]; then
  [ "$(view state)" = "OPEN" ] || { echo "PR #$pr is $(view state)."; exit 1; }

  if [ "$(view mergeStateStatus)" = "BEHIND" ]; then
    say "Branch is behind main: updating it"
    gh pr update-branch "$pr"
    sleep 5
  fi

  say "Waiting for CI on #$pr ($branch)"
  until gh pr checks "$pr" 2>/dev/null | grep -q 'CI passed'; do sleep 10; done
  if ! gh pr checks "$pr" --watch --interval 15 >/dev/null; then
    gh pr checks "$pr" || true
    run="$(gh run list --branch "$branch" --workflow CI -L 1 --json databaseId -q '.[0].databaseId')"
    say "CI failed. Failing steps from run $run:"
    gh run view "$run" --log-failed | tail -80
    exit 1
  fi

  status="$(view mergeStateStatus)"
  if [ "$status" != "CLEAN" ]; then
    echo "PR #$pr can't be merged yet: merge state is $status."
    exit 1
  fi

  say "Squash-merging #$pr"
  gh pr merge "$pr" --squash --delete-branch >/dev/null 2>&1 || true
  [ "$(view state)" = "MERGED" ] || { echo "Merge failed."; exit 1; }
fi
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
