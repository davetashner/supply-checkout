#!/usr/bin/env bash
# Tests for scripts/land-pr.sh, run with: npm run test:scripts
#
# Each case runs land-pr.sh in a throwaway git repo (with a bare "origin", a
# feature branch and its worktree) against a fake `gh` that answers from a
# scenario directory, so nothing touches GitHub. `sleep`, `bd`, `node` and
# `npm` are stubbed too. Needs git and jq. SHOW_ALL=1 prints every case's output, not
# just the failing ones.
#
# Scenario files, in $FAKE:
#   pr.json          the PR as `gh pr view --json` sees it
#   seq.<field>      values for <field>, one per line, one taken per read that
#                    asks for it; the last line then sticks
#   checks_rc        exit code of `gh pr checks --watch` (default 0)
#   rules.json       what `gh api .../rules/branches/main` returns
#   merge_ok         if present, `gh pr merge` marks the PR merged
#   merge_sets       if present, a jq expression `gh pr merge` applies to
#                    pr.json instead (for the merge queue cases)
#   seq.queue        JSON objects, one per line, merged into pr.json by each
#                    `gh api graphql` read (the merge queue status); the last
#                    one then sticks
#   export_stale     if present, `node scripts/export-beads.mjs --check` exits 1
#   export_error     if present, it exits 2 (bd failed)
#   page_fails       if present, `node scripts/backlog-page.mjs` fails
#   page_hash        the data hash the page build writes (default h1)
#   beads_pr_rc      exit code of `npm run -s beads:pr` (default 0)
#   hold             while present, `gh pr checks --watch` blocks (it touches
#                    `holding` first), to keep a land running
#   real_sleep       if present, `sleep` really waits a moment
#   ln_lost_race     if present, the next `ln` fails once without creating
#                    anything, as if another land's lock was released just
#                    after `ln` found it
#   calls            every gh, bd, sleep, backlog-page and npm call, appended by
#                    the fakes; npm's line also says whether the land lock was
#                    held and whether LAND_SKIP_BACKLOG was set
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
    if [[ " $* " == *" --watch "* ]] && [ -e "$FAKE/hold" ]; then
      touch "$FAKE/holding"
      while [ -e "$FAKE/hold" ]; do /bin/sleep 0.1; done
    fi
    if [[ " $* " == *" --watch "* ]]; then exit "$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)"; fi
    if [ "$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)" = 0 ]; then
      printf 'CI passed\tpass\t1m\thttps://example.invalid\n'
    else
      printf 'CI passed\tfail\t1m\thttps://example.invalid\nTests\tfail\t1m\thttps://example.invalid\n'
    fi ;;
  "pr update-branch") echo "Updated branch" ;;
  "pr merge")
    if [ -e "$FAKE/merge_sets" ]; then
      jq "$(cat "$FAKE/merge_sets")" "$pr_json" > "$pr_json.new" && mv "$pr_json.new" "$pr_json"
      echo "! The merge strategy for main is set by the merge queue"
    elif [ -e "$FAKE/merge_ok" ]; then set_field state MERGED; else
      echo "X Pull request is not mergeable: the base branch policy prohibits the merge." >&2; exit 1; fi ;;
  "run list") echo 999 ;;
  "run view") echo "Tests  Run tests  expected 1 to equal 2" ;;
  "api graphql")
    expr="."
    while [ $# -gt 0 ]; do case "$1" in --jq) expr="$2"; shift 2 ;; *) shift ;; esac; done
    file="$FAKE/seq.queue"
    if [ -s "$file" ]; then
      jq --argjson v "$(head -1 "$file")" '. + $v' "$pr_json" > "$pr_json.new" && mv "$pr_json.new" "$pr_json"
      if [ "$(wc -l < "$file")" -gt 1 ]; then tail -n +2 "$file" > "$file.new" && mv "$file.new" "$file"; fi
    fi
    jq '{data: {repository: {pullRequest: {state, mergeQueueEntry, autoMergeRequest}}}}' "$pr_json" | jq -r "$expr" ;;
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
[ ! -e "$FAKE/real_sleep" ] || /bin/sleep 0.1
EOF
cat > "$tmp/bin/ln" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE:-}" ] && [ -e "$FAKE/ln_lost_race" ]; then rm "$FAKE/ln_lost_race"; exit 1; fi
exec /bin/ln "$@"
EOF
cat > "$tmp/bin/node" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  scripts/export-beads.mjs)
    [ ! -e "$FAKE/export_error" ] || exit 2
    [ ! -e "$FAKE/export_stale" ] ;;
  scripts/backlog-page.mjs)
    echo "node $*" >> "$FAKE/calls"
    [ ! -e "$FAKE/page_fails" ] || { echo "bd: database not found" >&2; exit 1; }
    mkdir -p dist/backlog
    echo "<html>" > dist/backlog/index.html
    cat "$FAKE/page_hash" 2>/dev/null > dist/backlog/.hash || echo h1 > dist/backlog/.hash
    echo "Wrote the backlog page (1 beads): $PWD/dist/backlog/index.html" ;;
  *) echo "fake node: unexpected: node $*" >&2; exit 2 ;;
esac
EOF
cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
lock="$(git rev-parse --path-format=absolute --git-common-dir)/land-pr.lock"
echo "npm $* (lock $([ -e "$lock" ] && echo held || echo free), skip=${LAND_SKIP_BACKLOG:-})" >> "$FAKE/calls"
case "$*" in
  "run -s beads:pr") echo "Opened https://github.com/example/repo/pull/77"; exit "$(cat "$FAKE/beads_pr_rc" 2>/dev/null || echo 0)" ;;
  *) echo "fake npm: unexpected: npm $*" >&2; exit 2 ;;
esac
EOF
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
# Turns on the merge queue in main's ruleset; gh pr merge then just enqueues
queue_on() {
  echo '[{"type": "pull_request"}, {"type": "merge_queue", "parameters": {"merge_method": "SQUASH"}}]' > "$FAKE/rules.json"
  echo '.' > "$FAKE/merge_sets"
}

land() {
  rc=0
  out="$(cd "$repo" && bash "$script" 42 2>&1)" || rc=$?
}
lock_file() { printf '%s\n' "$repo/.git/land-pr.lock"; }
unlocked() { [ ! -e "$(lock_file)" ]; }
# Waits up to 20s for a command to succeed
wait_until() {
  local _
  for _ in $(seq 200); do "$@" && return 0; /bin/sleep 0.1; done
  return 1
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
called_in() { grep -qF -- "$2" "$1/calls"; }
not_called_in() { ! called_in "$@"; }
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
check "says nothing about an up-to-date export" not_says "beads export"
check "releases the lock" unlocked
check "doesn't wait for a lock" not_says "Waiting for the land"
done_case

echo "two lands at once run one after the other"
scenario concurrent
fake_a="$FAKE" fake_b="$tmp/concurrent/fake-b"
mkdir -p "$fake_b"
git -C "$repo" worktree add -q .claude/worktrees/feat/y -b feat/y
jq '.headRefName = "feat/y" | .body = "Closes supply-checkout-def\n"' "$fake_a/pr.json" > "$fake_b/pr.json"
touch "$fake_b/merge_ok" "$fake_b/calls" "$fake_b/real_sleep" "$fake_a/hold"
(cd "$repo/.claude/worktrees/feat/x" && FAKE="$fake_a" bash "$script" 42 > "$fake_a/out" 2>&1 && echo 0 > "$fake_a/rc" || echo $? > "$fake_a/rc") &
check "the first land takes the lock and runs" wait_until test -e "$fake_a/holding"
check "the lock names the PR" grep -qx "pr=42" "$(lock_file)"
check "the lock has the PID" grep -qE "^pid=[0-9]+$" "$(lock_file)"
check "the lock has the start time" grep -qE "^started=[0-9]{4}-[0-9]{2}-[0-9]{2} " "$(lock_file)"
(cd "$repo/.claude/worktrees/feat/y" && FAKE="$fake_b" bash "$script" 43 > "$fake_b/out" 2>&1 && echo 0 > "$fake_b/rc" || echo $? > "$fake_b/rc") &
check "the second land waits" wait_until grep -qE "Waiting for the land of #42 \(pid [0-9]+, started [0-9-]+ [0-9:]+\)" "$fake_b/out"
/bin/sleep 0.5
check "the second land doesn't start while the first runs" not_called_in "$fake_b" "gh pr checks"
check "the first land hasn't merged yet" not_called_in "$fake_a" "gh pr merge"
rm "$fake_a/hold"
wait
check "the first land exits 0" [ "$(cat "$fake_a/rc")" = 0 ]
check "the second land exits 0" [ "$(cat "$fake_b/rc")" = 0 ]
check "the second land takes the lock after" grep -qF "Took the lock for #43" "$fake_b/out"
check "the second land merges" called_in "$fake_b" "gh pr merge 43 --squash --delete-branch"
check "says it's waiting once" [ "$(grep -c "Waiting for the land" "$fake_b/out")" -eq 1 ]
check "releases the lock" unlocked
out="$(cat "$fake_a/out" "$fake_b/out")" rc=0
done_case

echo "the other land's lock goes just after ln finds it"
scenario lock-released-meanwhile
touch "$FAKE/ln_lost_race"
land
check "exits 0" exits 0
check "merges" called "gh pr merge 42"
check "doesn't say it took a lock over" not_says "Taking over"
check "releases the lock" unlocked
done_case

echo "a crashed land's lock"
scenario stale-lock
bash -c 'exit 0' & dead=$!; wait "$dead"
printf 'pid=%s\npr=41\nstarted=2026-01-01 00:00:00\n' "$dead" > "$(lock_file)"
land
check "exits 0" exits 0
check "takes the lock over" says "Taking over the lock from the land of #41 (pid $dead), which is no longer running."
check "doesn't wait" not_says "Waiting for the land"
check "merges" called "gh pr merge 42"
check "releases the lock" unlocked
done_case

echo "a lock whose PID now belongs to something else"
scenario reused-pid
/bin/sleep 30 & other=$!
printf 'pid=%s\npr=41\nstarted=2026-01-01 00:00:00\n' "$other" > "$(lock_file)"
land
kill "$other" 2>/dev/null || true; wait "$other" 2>/dev/null || true
check "exits 0" exits 0
check "takes the lock over" says "Taking over the lock from the land of #41 (pid $other)"
check "releases the lock" unlocked
done_case

echo "killed while holding the lock"
scenario killed
touch "$FAKE/hold"
(cd "$repo" && bash "$script" 42 > "$FAKE/out" 2>&1 && echo 0 > "$FAKE/rc" || echo $? > "$FAKE/rc") &
check "takes the lock" wait_until test -e "$FAKE/holding"
kill -TERM "$(sed -n 's/^pid=//p' "$(lock_file)")"
# bash runs its trap once the command it's waiting on returns
rm "$FAKE/hold"
wait
out="$(cat "$FAKE/out")" rc="$(cat "$FAKE/rc")"
check "exits non-zero" fails
check "says it wasn't merged" says "PR #42 was not merged."
check "releases the lock" unlocked
done_case

republish="then run: npm run backlog:published"
last_line() { [ "$(tail -1 <<< "$out")" = "$1" ]; }
last_says() { grep -qF -- "$1" <<< "$(tail -1 <<< "$out")"; }

echo "backlog page: rebuilt, and never published"
scenario page-new
land
check "exits 0" exits 0
check "rebuilds the page" called "node scripts/backlog-page.mjs"
check "ends asking to republish it" last_says "/dist/backlog/index.html to the backlog artifact, $republish"
check "doesn't run beads:pr for a current export" not_called "beads:pr"
done_case

echo "backlog page: rebuilt, and unchanged since it was published"
scenario page-published
mkdir -p "$repo/dist/backlog" && echo h1 > "$repo/dist/backlog/.published"
land
check "exits 0" exits 0
check "rebuilds the page" called "node scripts/backlog-page.mjs"
check "says it's unchanged" last_line "The backlog page is unchanged since it was last published."
check "doesn't ask to republish it" not_says "$republish"
done_case

echo "backlog page: rebuilt, and changed since it was published"
scenario page-changed
mkdir -p "$repo/dist/backlog" && echo h0 > "$repo/dist/backlog/.published"
land
check "exits 0" exits 0
check "ends asking to republish it" last_says "$republish"
done_case

echo "backlog page: the build fails"
scenario page-fails
touch "$FAKE/page_fails"
mkdir -p "$repo/dist/backlog" && echo old > "$repo/dist/backlog/.hash"
land
check "exits 0" exits 0
check "says it couldn't rebuild it" says "Couldn't rebuild the backlog page"
check "prints the error" says "bd: database not found"
check "doesn't ask to republish the old page" not_says "$republish"
done_case

echo "beads export is stale"
scenario export-stale
touch "$FAKE/export_stale"
land
check "exits 0" exits 0
check "says it's refreshing it" says "The beads export is stale: refreshing it with npm run beads:pr"
check "runs beads:pr after releasing the land lock" called "npm run -s beads:pr (lock free"
check "tells the export's land to skip the backlog" called "npm run -s beads:pr (lock free, skip=1)"
check "runs it once" [ "$(count "beads:pr")" -eq 1 ]
check "rebuilds the page after" [ "$(grep -n -e beads:pr -e backlog-page "$FAKE/calls" | tail -1 | grep -c backlog-page)" -eq 1 ]
check "ends asking to republish the page" last_says "$republish"
check "releases the lock" unlocked
done_case

echo "beads export is stale, and its PR doesn't land"
scenario export-pr-fails
touch "$FAKE/export_stale"
echo 1 > "$FAKE/beads_pr_rc"
land
check "exits 0: #42 is merged" exits 0
check "says the export PR didn't land" says "#42 merged, but the beads export PR didn't land (see above)."
check "doesn't say #42 wasn't merged" not_says "was not merged"
check "still rebuilds the page" called "node scripts/backlog-page.mjs"
check "still ends asking to republish the page" last_says "$republish"
done_case

echo "beads export is stale after landing the export's own PR"
scenario export-own-pr
touch "$FAKE/export_stale"
pr '.headRefName = "chore/beads-export-20260927-120000" | .body = "Refreshes the export."'
land
check "exits 0" exits 0
check "doesn't run beads:pr again" not_called "beads:pr"
check "says the export is stale again" says "The beads export is stale again; refresh it with: npm run beads:pr"
check "rebuilds the page" called "node scripts/backlog-page.mjs"
done_case

echo "beads export can't be checked"
scenario export-error
touch "$FAKE/export_error"
land
check "exits 0" exits 0
check "says it couldn't check" says "Couldn't check the beads export"
check "doesn't run beads:pr" not_called "beads:pr"
done_case

echo "LAND_SKIP_BACKLOG=1"
scenario skip-backlog
touch "$FAKE/export_stale"
rc=0
out="$(cd "$repo" && LAND_SKIP_BACKLOG=1 bash "$script" 42 2>&1)" || rc=$?
check "exits 0" exits 0
check "merges" called "gh pr merge 42"
check "doesn't run beads:pr" not_called "beads:pr"
check "doesn't rebuild the page" not_called "backlog-page"
check "says so" says "LAND_SKIP_BACKLOG is set"
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
check "doesn't rebuild the backlog page" not_called "backlog-page"
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
check "rebuilds the backlog page" called "node scripts/backlog-page.mjs"
done_case

echo "already merged while another land holds the lock"
scenario merged-while-locked
pr '.state = "MERGED" | .mergeStateStatus = "UNKNOWN"'
touch "$FAKE/real_sleep"
# This test script's own PID passes for a running land
printf 'pid=%s\npr=41\nstarted=2026-01-01 00:00:00\n' "$$" > "$(lock_file)"
(cd "$repo" && bash "$script" 42 > "$FAKE/out" 2>&1 && echo 0 > "$FAKE/rc" || echo $? > "$FAKE/rc") &
land_pid=$!
check "finishes without waiting for the lock" wait_until test -e "$FAKE/rc"
kill "$land_pid" 2>/dev/null || true; wait "$land_pid" 2>/dev/null || true
out="$(cat "$FAKE/out")" rc="$(cat "$FAKE/rc" 2>/dev/null || echo 1)"
check "exits 0" exits 0
check "cleans up" cleaned_up
check "leaves the other land's lock" grep -qx "pr=41" "$(lock_file)"
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
check "doesn't use a merge queue" not_says "merge queue"
done_case

echo "behind main every time"
scenario always-behind
pr '.mergeStateStatus = "BEHIND"'
land
check "exits non-zero" fails
check "updates ten times" [ "$(count "gh pr update-branch")" -eq 10 ]
check "says it's still behind" says "still behind main after 10 updates"
check "releases the lock" unlocked
done_case

echo "conflicts"
scenario dirty
pr '.mergeStateStatus = "DIRTY"'
land
check "exits non-zero" fails
check "says to rebase" says "has conflicts with main"
check "releases the lock" unlocked
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
check "releases the lock" unlocked
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

echo "merge queue: queued, then merged"
scenario queue
queue_on
git -C "$repo" push -q origin feat/x
seq_of queue '{"mergeQueueEntry": {"position": 2, "state": "QUEUED"}}' \
  '{"mergeQueueEntry": {"position": 2, "state": "QUEUED"}}' \
  '{"mergeQueueEntry": {"position": 1, "state": "AWAITING_CHECKS"}}' \
  '{"state": "MERGED", "mergeQueueEntry": null}'
land
check "exits 0" exits 0
check "says main has a merge queue" says "main has a merge queue"
check "waits for the PR's CI first" called "gh pr checks 42 --watch"
check "enqueues with gh pr merge" called "gh pr merge 42 --squash"
check "doesn't pass --delete-branch" not_called "--delete-branch"
check "doesn't update the branch" not_called "gh pr update-branch"
check "reports the queue position" says "In the merge queue: position 2, QUEUED"
check "reports it only when it changes" [ "$(grep -c "position 2, QUEUED" <<< "$out")" -eq 1 ]
check "reports the next position" says "In the merge queue: position 1, AWAITING_CHECKS"
check "reports the merge commit" says "Merged as abcdef1"
check "removes the worktree and branch" cleaned_up
check "deletes the remote branch" bash -c "! git -C '$tmp/queue/origin.git' rev-parse -q --verify refs/heads/feat/x"
check "closes the Closes bead" called "bd close supply-checkout-abc --reason Completed in PR #42"
done_case

echo "merge queue: behind main"
scenario queue-behind
queue_on
pr '.mergeStateStatus = "BEHIND"'
seq_of queue '{"state": "MERGED"}'
land
check "exits 0" exits 0
check "leaves updating to the queue" not_called "gh pr update-branch"
check "enqueues" called "gh pr merge 42 --squash"
done_case

echo "merge queue: the queue's CI fails"
scenario queue-fails
queue_on
seq_of queue '{"mergeQueueEntry": {"position": 1, "state": "AWAITING_CHECKS"}}' '{"mergeQueueEntry": null}'
land
check "exits non-zero" fails
check "says it left the queue" says "left the merge queue without merging"
check "looks up the merge group run" called "gh run list --workflow CI --event merge_group"
check "prints the failing log" says "expected 1 to equal 2"
check "leaves the worktree and branch" untouched
check "closes no beads" not_called "bd close"
done_case

echo "merge queue: auto-merge on, but an approval is missing"
scenario queue-needs-approval
queue_on
pr '.mergeStateStatus = "BLOCKED"'
echo '.autoMergeRequest = {"enabledAt": "2026-01-01T00:00:00Z"}' > "$FAKE/merge_sets"
land
check "exits non-zero" fails
check "says it hasn't joined the queue" says "hasn't joined the merge queue"
check "gives the approve command" says "gh pr review 42 --approve"
check "waits a minute first" [ "$(count "sleep 15")" -eq 4 ]
check "leaves the worktree and branch" untouched
done_case

echo "merge queue: gh can't enqueue it"
scenario queue-rejected
queue_on
rm "$FAKE/merge_sets" "$FAKE/merge_ok"
land
check "exits non-zero" fails
check "prints gh's error" says "base branch policy prohibits the merge"
check "says it didn't join the queue" says "didn't join the merge queue"
done_case

echo "merge queue: the PR's own CI fails"
scenario queue-ci-fails
queue_on
echo 1 > "$FAKE/checks_rc"
land
check "exits non-zero" fails
check "prints the failing log" says "expected 1 to equal 2"
check "doesn't enqueue" not_called "gh pr merge"
done_case

echo "merge queue: conflicts"
scenario queue-dirty
queue_on
pr '.mergeStateStatus = "DIRTY"'
land
check "exits non-zero" fails
check "says to rebase" says "has conflicts with main"
check "doesn't wait for CI" not_called "gh pr checks"
done_case

echo "merge queue: still queued after an hour"
scenario queue-slow
queue_on
pr '.mergeQueueEntry = {"position": 3, "state": "QUEUED"}'
land
check "exits non-zero" fails
check "says it's still queued" says "still in the merge queue after 60 minutes"
check "polls for an hour" [ "$(count "sleep 15")" -eq 239 ]
check "leaves the worktree and branch" untouched
done_case

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "All land-pr checks passed"
