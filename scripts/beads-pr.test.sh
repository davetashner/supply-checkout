#!/usr/bin/env bash
# Tests for scripts/beads-pr.sh, run with: npm run test:scripts
#
# Each case runs beads-pr.sh in a throwaway git repo (with a bare "origin"
# whose main has a .beads/issues.jsonl) against a fake `gh` and a fake `npm`,
# so nothing touches GitHub or the beads database. SHOW_ALL=1 prints every
# case's output, not just the failing ones.
#
# Scenario files, in $FAKE:
#   export       what `npm run beads:export` writes to .beads/issues.jsonl
#                (if missing, the export fails)
#   land_rc      exit code of `npm run land` (default 0)
#   open_prs     JSON array of open PRs (number, headRefName) that
#                `gh pr list` returns (default [])
#   calls        every gh and npm call, appended by the fakes
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/beads-pr.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# Empty emails: this repo is public and its pre-commit hook rejects any address
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=

# --- fakes -------------------------------------------------------------------
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE/calls"
case "$1 $2" in
  "pr create") echo "https://github.com/example/repo/pull/77" ;;
  "pr list")
    expr="."
    while [ $# -gt 0 ]; do case "$1" in -q|--jq) expr="$2"; shift 2 ;; *) shift ;; esac; done
    if [ -e "$FAKE/open_prs" ]; then jq -r "$expr" "$FAKE/open_prs"; else echo '[]' | jq -r "$expr"; fi ;;
  *) echo "fake gh: unexpected: gh $*" >&2; exit 2 ;;
esac
FAKE
cat > "$tmp/bin/npm" <<'FAKE'
#!/usr/bin/env bash
echo "npm $* (in $(basename "$PWD"))${LAND_SKIP_BACKLOG:+ skip=$LAND_SKIP_BACKLOG}" >> "$FAKE/calls"
case "$*" in
  "run -s beads:export")
    [ -e "$FAKE/export" ] || { echo "bd: database not found" >&2; exit 1; }
    cp "$FAKE/export" "$(git rev-parse --show-toplevel)/.beads/issues.jsonl"
    echo "Exported beads" ;;
  "run -s land -- "*) exit "$(cat "$FAKE/land_rc" 2>/dev/null || echo 0)" ;;
  *) echo "fake npm: unexpected: npm $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# --- harness -----------------------------------------------------------------
failures=0 out="" rc=0 repo="" origin=""

# Starts a case: a fresh clone whose main has a one-bead export
scenario() {
  local dir="$tmp/$1"
  mkdir -p "$dir/fake"
  export FAKE="$dir/fake"
  origin="$dir/origin.git" repo="$dir/repo"
  git init -q --bare -b main "$origin"
  git clone -q "$origin" "$repo" 2>/dev/null
  mkdir -p "$repo/.beads"
  echo '{"id":"supply-checkout-abc","status":"open"}' > "$repo/.beads/issues.jsonl"
  git -C "$repo" add .beads/issues.jsonl
  git -C "$repo" commit -q -m init
  git -C "$repo" push -q origin main
  cp "$repo/.beads/issues.jsonl" "$FAKE/export"
  touch "$FAKE/calls"
}
run_it() {
  rc=0
  out="$(cd "$repo" && bash "$script" 2>&1)" || rc=$?
}
check() { # description, then a command that must succeed
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else
    echo "  FAIL $desc"; failures=$((failures + 1)); SHOW_OUTPUT=1
  fi
}
says() { grep -qF -- "$1" <<< "$out"; }
called() { grep -qF -- "$1" "$FAKE/calls"; }
not_called() { ! called "$1"; }
exits() { [ "$rc" -eq "$1" ]; }
fails() { [ "$rc" -ne 0 ]; }
# No worktree or local branch left behind
tidy() {
  [ "$(git -C "$repo" worktree list | wc -l)" -eq 1 ] &&
    [ -z "$(git -C "$repo" branch --list 'chore/*')" ] &&
    [ ! -d "$repo/.claude/worktrees/chore" ]
}
pushed() { git -C "$origin" for-each-ref --format='%(refname:short)' 'refs/heads/chore/beads-export-*' | grep -q .; }
not_pushed() { ! pushed; }
pushed_commit() { git -C "$origin" log -1 --format=%B "$(git -C "$origin" for-each-ref --format='%(refname)' 'refs/heads/chore/beads-export-*')"; }
done_case() {
  if [ -n "${SHOW_OUTPUT:-}${SHOW_ALL:-}" ]; then printf '  --- output (exit %s) ---\n%s\n  ---\n' "$rc" "$out" | sed 's/^/  | /'; fi
  SHOW_OUTPUT=""
}

# --- cases -------------------------------------------------------------------
echo "export unchanged"
scenario unchanged
run_it
check "exits 0" exits 0
check "says there's nothing to do" says "already up to date. Nothing to do."
check "exports in the new worktree" called "npm run -s beads:export (in beads-export-"
check "opens no PR" not_called "gh pr create"
check "doesn't land" not_called "npm run -s land"
check "pushes nothing" not_pushed
check "removes the worktree and branch" tidy
done_case

echo "export changed"
scenario changed
echo '{"id":"supply-checkout-abc","status":"closed"}' > "$FAKE/export"
run_it
check "exits 0" exits 0
check "pushes a branch" pushed
check "commits the export" [ "$(git -C "$origin" show "$(git -C "$origin" for-each-ref --format='%(refname)' 'refs/heads/chore/*'):.beads/issues.jsonl")" = '{"id":"supply-checkout-abc","status":"closed"}' ]
check "titles the commit" grep -qx "chore: refresh the beads export" <<< "$(pushed_commit)"
check "signs off the commit" grep -q "^Signed-off-by: test" <<< "$(pushed_commit)"
check "adds the Co-Authored-By trailer" grep -qx "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" <<< "$(pushed_commit)"
check "opens the chore PR" called "gh pr create --base main --head chore/beads-export-"
check "with the chore title" called "--title chore: refresh the beads export"
check "lands it" called "npm run -s land -- 77"
check "removes the worktree and branch" tidy
done_case

echo "export changed, but land fails"
scenario land-fails
echo '{"id":"supply-checkout-abc","status":"closed"}' > "$FAKE/export"
echo 1 > "$FAKE/land_rc"
run_it
check "exits non-zero" fails
check "says how to retry" says "npm run land -- 77"
check "keeps the pushed branch for the PR" pushed
check "removes the worktree and local branch" tidy
done_case

echo "export fails"
scenario export-fails
rm "$FAKE/export"
run_it
check "exits non-zero" fails
check "prints the error" says "bd: database not found"
check "opens no PR" not_called "gh pr create"
check "removes the worktree and branch" tidy
done_case

echo "run by npm run land for a stale export"
scenario from-land
echo '{"id":"supply-checkout-abc","status":"closed"}' > "$FAKE/export"
rc=0
out="$(cd "$repo" && LAND_SKIP_BACKLOG=1 bash "$script" 2>&1)" || rc=$?
check "exits 0" exits 0
check "passes LAND_SKIP_BACKLOG on to its land" called "npm run -s land -- 77 (in repo) skip=1"
# land-pr.sh knows the export's own PR by this branch prefix, and doesn't
# run beads:pr again after landing it
check "pushes a chore/beads-export-* branch" pushed
done_case

echo "run from a worktree"
scenario from-worktree
git -C "$repo" worktree add -q .claude/worktrees/feat/x -b feat/x
echo '{"id":"supply-checkout-abc","status":"closed"}' > "$FAKE/export"
rc=0
out="$(cd "$repo/.claude/worktrees/feat/x" && bash "$script" 2>&1)" || rc=$?
check "exits 0" exits 0
check "lands from the main checkout" called "npm run -s land -- 77 (in repo)"
check "leaves the other worktree alone" [ -d "$repo/.claude/worktrees/feat/x" ]
done_case

echo "an export PR is already open"
scenario open-export
echo '[{"number": 12, "headRefName": "feat/other"}, {"number": 66, "headRefName": "chore/beads-export-20260927-101500"}, {"number": 61, "headRefName": "chore/beads-export-20260927-091500"}]' > "$FAKE/open_prs"
run_it
check "exits 0" exits 0
check "says it's landing the open one" says "Beads export PR #61 is already open"
check "lands the oldest open export PR" called "npm run -s land -- 61"
check "doesn't land another PR" not_called "npm run -s land -- 12"
check "then exports again off main" called "npm run -s beads:export (in beads-export-"
check "opens no PR when the export is then current" not_called "gh pr create"
check "removes the worktree and branch" tidy
done_case

echo "an export PR is already open, but it doesn't land"
scenario open-export-land-fails
echo '[{"number": 66, "headRefName": "chore/beads-export-20260927-101500"}]' > "$FAKE/open_prs"
echo '{"id":"supply-checkout-abc","status":"closed"}' > "$FAKE/export"
echo 1 > "$FAKE/land_rc"
run_it
check "exits non-zero" fails
check "says how to retry" says "npm run land -- 66"
check "opens no PR" not_called "gh pr create"
check "doesn't export" not_called "npm run -s beads:export"
check "pushes nothing" not_pushed
check "removes the worktree and branch" tidy
done_case

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "All beads-pr checks passed"
