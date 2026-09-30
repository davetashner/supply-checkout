#!/usr/bin/env bash
# Refreshes the committed beads export (.beads/issues.jsonl) through a chore PR:
#   1. if a beads export PR this flow opened is already open (from an
#      earlier run whose land didn't finish, say), lands that one first with
#      npm run land instead of opening another, and stops if it doesn't land.
#      One with conflicts is closed instead: the export below replaces it.
#      Only a PR from this repo (not a fork), by the current gh user, titled
#      as below and changing only .beads/issues.jsonl counts; any other
#      chore/beads-export-* PR is skipped with a warning, never landed.
#   2. runs npm run beads:export in a fresh worktree off origin/main
#   3. if the export changed, commits it (signed off), pushes, opens a
#      "chore: refresh the beads export" PR and lands it with npm run land
#   4. otherwise says there's nothing to do
# The worktree is removed on every path. npm run land runs it after a merge
# whenever the export is stale (with LAND_SKIP_BACKLOG=1, which reaches the
# export PR's land), and the lead can run it by hand. land-pr.sh knows the
# export's own PR by its chore/beads-export-* branch.
#
# The beads database is local to the main checkout, so this can't run in CI.
#
# Usage: npm run beads:pr     (or scripts/beads-pr.sh)
set -euo pipefail

TITLE="chore: refresh the beads export"
TRAILER="Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Removes the export worktree and its local branch, on every path out. A
# pushed branch stays on origin for its PR.
# shellcheck disable=SC2317,SC2329 # the EXIT trap calls it
cleanup() {
  [ -n "${root:-}" ] || return 0
  cd "$root"
  if [ -d "$wt" ]; then git worktree remove --force "$wt" && echo "Removed worktree $wt"; fi
  git worktree prune
  git branch -D "$branch" >/dev/null 2>&1 || true
  [ ! -d .claude/worktrees ] || find .claude/worktrees -mindepth 1 -type d -empty -delete
}

# Lands an export PR that's already open (the oldest, if there are several)
# rather than opening a duplicate. Once it's merged, the export runs off the
# new main, so it only opens a PR for what that one missed. Landing merges
# with no review, so only a PR this flow could have opened qualifies.
land_open_export() {
  local me number cross author title files state
  me="$(gh api user --jq .login)" || return 1
  while IFS=$'\t' read -r number cross author title; do
    if [ "$cross" != "false" ] || [ "$author" != "$me" ] || [ "$title" != "$TITLE" ]; then
      echo "Warning: skipping PR #$number: its branch looks like a beads export, but it's not one this flow opened (from a fork, by another author, or another title)." >&2
      continue
    fi
    files="$(gh pr view "$number" --json files --jq '[.files[].path] | join(" ")')"
    if [ "$files" != ".beads/issues.jsonl" ]; then
      echo "Warning: skipping PR #$number: it changes more than .beads/issues.jsonl ($files)." >&2
      continue
    fi
    state="$(gh pr view "$number" --json mergeStateStatus --jq .mergeStateStatus)"
    if [ "$state" = "DIRTY" ]; then
      say "Beads export PR #$number has conflicts with main: closing it, a fresh export replaces it"
      gh pr close "$number" --delete-branch --comment "Closed by npm run beads:pr: this export conflicts with main, and a fresh export from the beads database replaces it."
      continue
    fi
    say "Beads export PR #$number is already open: landing it instead of opening another"
    if ! npm run -s land -- "$number"; then
      say "PR #$number didn't land. Once it can merge run: npm run land -- $number"
      return 1
    fi
    return 0
  done < <(gh pr list --state open --limit 100 --json number,headRefName,isCrossRepository,author,title \
    --jq '[.[] | select(.headRefName | startswith("chore/beads-export-"))] | sort_by(.number) | .[] | [.number, .isCrossRepository, .author.login, .title] | @tsv')
}

# Everything runs inside beads_pr(), which bash reads in full before running it:
# npm run land pulls main, which can rewrite this file mid-run.
beads_pr() {
  # Globals, not locals: the EXIT trap runs after beads_pr() returns
  pr="" url="" root="" wt="" branch=""
  root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  cd "$root"
  # When npm run land runs this, its LAND_PR_COPY would make the nested land
  # skip its own temporary copy and, on exit, delete the outer land's
  unset LAND_PR_COPY
  land_open_export || return 1

  branch="chore/beads-export-$(date +%Y%m%d-%H%M%S)"
  wt="$root/.claude/worktrees/$branch"

  say "Exporting beads into a worktree off origin/main"
  git fetch -q origin main
  git worktree add -q "$wt" -b "$branch" origin/main
  (cd "$wt" && npm run -s beads:export)

  if [ -z "$(git -C "$wt" status --porcelain -- .beads/issues.jsonl)" ]; then
    say "The beads export is already up to date. Nothing to do."
    return 0
  fi

  git -C "$wt" add .beads/issues.jsonl
  git -C "$wt" commit -q -s -m "$TITLE" -m "$TRAILER"
  git -C "$wt" push -q -u origin "$branch"

  say "Opening the PR"
  url="$(gh pr create --base main --head "$branch" --title "$TITLE" --body "Refreshes \`.beads/issues.jsonl\` from the local beads database (\`npm run beads:pr\`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)")"
  echo "$url"
  pr="${url##*/}"

  # land removes the worktree and branch once the PR merges; cleanup catches
  # anything it leaves behind
  if ! npm run -s land -- "$pr"; then
    say "PR #$pr didn't land. Its branch is pushed, so once it can merge run: npm run land -- $pr"
    return 1
  fi
}

trap cleanup EXIT
beads_pr "$@"; exit
