#!/usr/bin/env bash
# Tests for scripts/land-pr.sh, run with: npm run test:scripts
#
# Each case runs land-pr.sh in a throwaway git repo (with a bare "origin", a
# feature branch and its worktree) against a fake `gh` that answers from a
# scenario directory, so nothing touches GitHub. `sleep`, `bd` and `node` are
# stubbed too. Needs git and jq. SHOW_ALL=1 prints every case's output, not
# just the failing ones.
#
# Scenario files, in $FAKE:
#   pr.json          the PR as `gh pr view --json` sees it
#   seq.<field>      values for <field>, one per line, one taken per read that
#                    asks for it; the last line then sticks
#   checks_rc        exit code of `gh pr checks --watch` (default 0)
#   rules.json       what `gh api .../rules/branches/main` returns
#   merge_ok         if present, `gh pr merge` marks the PR merged
#   calls            every gh, bd and sleep call, appended by the fakes
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/land-pr.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# Empty emails: this repo is public and its pre-commit hook rejects any address
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=

# --- fakes -------------------------------------------------------------------
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$FAKE/calls"
pr_json="$FAKE/pr.json"
set_field() { # field value
  jq --arg v "$2" ".$1 = \$v" "$pr_json" > "$pr_json.new" && mv "$pr_json.new" "$pr_json"
}
# Takes the next value of each sequenced field this read asks for
advance() { # comma-separated fields
  local f file
  for f in ${1//,/ }; do
    file="$FAKE/seq.$f"
    [ -s "$file" ] || continue
    set_field "$f" "$(head -1 "$file")"
    if [ "$(wc -l < "$file")" -gt 1 ]; then tail -n +2 "$file" > "$file.new" && mv "$file.new" "$file"; fi
  done
}
case "$1 $2" in
  "pr view")
    fields="" expr="."
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in --json) fields="$2"; shift 2 ;; -q|--jq) expr="$2"; shift 2 ;; *) shift ;; esac
    done
    advance "$fields"
    jq -r "$expr" "$pr_json" ;;
  "pr checks")
    if [[ " $* " == *" --watch "* ]]; then exit "$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)"; fi
    if [ "$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)" = 0 ]; then
      printf 'CI passed\tpass\t1m\thttps://example.invalid\n'
    else
      printf 'CI passed\tfail\t1m\thttps://example.invalid\nTests\tfail\t1m\thttps://example.invalid\n'
    fi ;;
  "pr update-branch") echo "Updated branch" ;;
  "pr merge")
    if [ -e "$FAKE/merge_ok" ]; then set_field state MERGED; else
      echo "X Pull request is not mergeable: the base branch policy prohibits the merge." >&2; exit 1; fi ;;
  "run list") echo 999 ;;
  "run view") echo "Tests  Run tests  expected 1 to equal 2" ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    [ -e "$FAKE/rules.json" ] || { echo "HTTP 404" >&2; exit 1; }
    jq -r "$4" "$FAKE/rules.json" ;;
  *) echo "fake gh: unexpected: gh $*" >&2; exit 2 ;;
esac
EOF
cat > "$tmp/bin/bd" <<'EOF'
#!/usr/bin/env bash
echo "bd $*" >> "$FAKE/calls"
case "$1" in
  show) echo '[{"status": "open"}]' ;;
  close) echo "Closed $2" ;;
esac
EOF
cat > "$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE/calls"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/node"
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# --- harness -----------------------------------------------------------------
failures=0 name="" out="" rc=0 repo=""

# Starts a case: a fresh repo with branch feat/x checked out in a worktree,
# and a PR that is open, clean, green and mergeable unless the case says not.
scenario() {
  name="$1"
  local dir="$tmp/$name"
  mkdir -p "$dir/fake"
  export FAKE="$dir/fake"
  git init -q --bare -b main "$dir/origin.git"
  git clone -q "$dir/origin.git" "$dir/repo" 2>/dev/null
  repo="$dir/repo"
  git -C "$repo" commit -q --allow-empty -m init
  git -C "$repo" push -q origin main
  git -C "$repo" worktree add -q .claude/worktrees/feat/x -b feat/x
  cat > "$FAKE/pr.json" <<'EOF'
{"state": "OPEN", "mergeStateStatus": "CLEAN", "headRefName": "feat/x",
 "body": "Does a thing.\n\nCloses supply-checkout-abc\n",
 "reviews": [], "commits": [{"authors": [{"login": "someone"}]}],
 "url": "https://github.com/example/repo/pull/42", "mergeCommit": {"oid": "abcdef1234567"}}
EOF
  touch "$FAKE/merge_ok" "$FAKE/calls"
}
pr() { jq "$1" "$FAKE/pr.json" > "$FAKE/pr.new" && mv "$FAKE/pr.new" "$FAKE/pr.json"; }
seq_of() { local f="$1"; shift; printf '%s\n' "$@" > "$FAKE/seq.$f"; }

land() {
  rc=0
  out="$(cd "$repo" && bash "$script" 42 2>&1)" || rc=$?
}
check() { # description, then a command that must succeed
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else
    echo "  FAIL $desc"; failures=$((failures + 1)); SHOW_OUTPUT=1
  fi
}
says() { grep -qF -- "$1" <<< "$out"; }
not_says() { ! says "$1"; }
called() { grep -qF -- "$1" "$FAKE/calls"; }
not_called() { ! called "$1"; }
count() { grep -cF -- "$1" "$FAKE/calls" || true; }
exits() { [ "$rc" -eq "$1" ]; }
fails() { [ "$rc" -ne 0 ]; }
cleaned_up() { [ ! -d "$repo/.claude/worktrees/feat/x" ] && ! git -C "$repo" rev-parse -q --verify refs/heads/feat/x >/dev/null; }
untouched() { [ -d "$repo/.claude/worktrees/feat/x" ] && git -C "$repo" rev-parse -q --verify refs/heads/feat/x >/dev/null; }
done_case() {
  if [ -n "${SHOW_OUTPUT:-}${SHOW_ALL:-}" ]; then printf '  --- output (exit %s) ---\n%s\n  ---\n' "$rc" "$out" | sed 's/^/  | /'; fi
  SHOW_OUTPUT=""
}

# --- cases -------------------------------------------------------------------
echo "clean PR with green CI"
scenario clean
land
check "exits 0" exits 0
check "squash-merges" called "gh pr merge 42 --squash --delete-branch"
check "reports the merge commit" says "Merged as abcdef1"
check "removes the worktree and branch" cleaned_up
check "closes the Closes bead" called "bd close supply-checkout-abc --reason Completed in PR #42"
done_case

echo "blocked with green CI and no approval (release-please)"
scenario blocked
pr '.mergeStateStatus = "BLOCKED" | .commits = [{"authors": [{"login": "github-actions[bot]"}]}]'
cat > "$FAKE/rules.json" <<'EOF'
[{"type": "deletion"},
 {"type": "pull_request", "parameters": {"required_approving_review_count": 0,
   "require_extra_approval_for_unattributed_changes": true, "require_code_owner_review": false,
   "require_last_push_approval": false, "required_review_thread_resolution": false}},
 {"type": "required_status_checks"}]
EOF
land
check "exits non-zero" fails
check "doesn't try to merge" not_called "gh pr merge"
check "names the approval rule" says "require_extra_approval_for_unattributed_changes"
check "doesn't name rules that are off" not_says "require_code_owner_review"
check "names the bot author" says "github-actions[bot]"
check "gives the approve command" says "gh pr review 42 --approve"
check "says it wasn't merged" says "PR #42 was not merged."
check "leaves the worktree and branch" untouched
check "closes no beads" not_called "bd close"
done_case

echo "blocked with green CI and an approval"
scenario blocked-approved
pr '.mergeStateStatus = "BLOCKED" | .reviews = [{"state": "APPROVED"}]'
echo '[{"type": "pull_request", "parameters": {"required_review_thread_resolution": true}}]' > "$FAKE/rules.json"
land
check "exits non-zero" fails
check "names the rule that's on" says "required_review_thread_resolution"
check "doesn't ask for another approval" not_says "gh pr review 42 --approve"
check "points at the PR" says "https://github.com/example/repo/pull/42"
done_case

echo "blocked, and the rules can't be read"
scenario blocked-no-rules
pr '.mergeStateStatus = "BLOCKED"'
land
check "exits non-zero" fails
check "says how to see the rules" says "gh api repos/{owner}/{repo}/rules/branches/main"
check "still gives the approve command" says "gh pr review 42 --approve"
done_case

echo "UNKNOWN for a while, then clean"
scenario unknown-then-clean
seq_of mergeStateStatus UNKNOWN UNKNOWN UNKNOWN UNKNOWN UNKNOWN UNKNOWN UNKNOWN CLEAN
land
check "exits 0" exits 0
check "prints a progress line" says "merge state UNKNOWN). Checking every 5s for up to 3 minutes."
check "prints how long it has waited" says "still UNKNOWN after 30s"
check "merges" called "gh pr merge 42"
done_case

echo "UNKNOWN that never resolves"
scenario unknown-forever
pr '.mergeStateStatus = "UNKNOWN"'
land
check "exits non-zero" fails
check "gives up after 3 minutes of polling" [ "$(count "sleep 5")" -eq 36 ]
check "says why" says "still reports #42's merge state as UNKNOWN after 3 minutes"
check "doesn't try to merge" not_called "gh pr merge"
done_case

echo "already merged before land runs"
scenario already-merged
pr '.state = "MERGED" | .mergeStateStatus = "UNKNOWN"'
land
check "exits 0" exits 0
check "says it's already merged" says "PR #42 is already merged."
check "doesn't wait for CI or merge" not_called "gh pr checks"
check "reports the merge commit" says "Merged as abcdef1"
check "removes the worktree and branch" cleaned_up
check "closes the Closes bead" called "bd close supply-checkout-abc"
done_case

echo "merged by someone else while land waits"
scenario merged-meanwhile
seq_of state OPEN OPEN MERGED
seq_of mergeStateStatus BLOCKED UNKNOWN
land
check "exits 0" exits 0
check "says someone else merged it" says "merged by someone else while this was waiting"
check "doesn't merge it again" not_called "gh pr merge"
check "removes the worktree and branch" cleaned_up
check "closes the Closes bead" called "bd close supply-checkout-abc"
done_case

echo "behind main"
scenario behind
seq_of mergeStateStatus BEHIND CLEAN
land
check "exits 0" exits 0
check "updates the branch" called "gh pr update-branch 42"
check "merges" called "gh pr merge 42"
done_case

echo "behind main every time"
scenario always-behind
pr '.mergeStateStatus = "BEHIND"'
land
check "exits non-zero" fails
check "updates three times" [ "$(count "gh pr update-branch")" -eq 3 ]
check "says it's still behind" says "still behind main after 3 updates"
done_case

echo "conflicts"
scenario dirty
pr '.mergeStateStatus = "DIRTY"'
land
check "exits non-zero" fails
check "says to rebase" says "has conflicts with main"
done_case

echo "CI fails"
scenario ci-fails
pr '.mergeStateStatus = "BLOCKED"'
echo 1 > "$FAKE/checks_rc"
land
check "exits non-zero" fails
check "prints the failing log" says "expected 1 to equal 2"
check "doesn't try to merge" not_called "gh pr merge"
done_case

echo "merge rejected"
scenario merge-rejected
rm "$FAKE/merge_ok"
land
check "exits non-zero" fails
check "prints gh's error" says "base branch policy prohibits the merge"
check "says the merge failed" says "Merge failed."
check "leaves the worktree and branch" untouched
done_case

echo "closed PR"
scenario closed
pr '.state = "CLOSED"'
land
check "exits non-zero" fails
check "says it's closed" says "PR #42 is CLOSED."
done_case

echo "draft PR"
scenario draft
pr '.mergeStateStatus = "DRAFT"'
land
check "exits non-zero" fails
check "says how to mark it ready" says "gh pr ready 42"
done_case

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "All land-pr checks passed"
