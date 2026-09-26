#!/usr/bin/env bash
# Refreshes the committed beads export (.beads/issues.jsonl) through a chore PR:
#   1. runs npm run beads:export in a fresh worktree off origin/main
#   2. if the export changed, commits it (signed off), pushes, opens a
#      "chore: refresh the beads export" PR and lands it with npm run land
#   3. otherwise says there's nothing to do
# The worktree is removed on every path. Run it after a batch of merges.
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

# Everything runs inside beads_pr(), which bash reads in full before running it:
# npm run land pulls main, which can rewrite this file mid-run.
beads_pr() {
  # Globals, not locals: the EXIT trap runs after beads_pr() returns
  pr="" url="" root="" wt="" branch=""
  root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  cd "$root"
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
