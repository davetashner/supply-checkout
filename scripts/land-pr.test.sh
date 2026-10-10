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
#   checks_rc        exit code of `gh pr checks`, with or without --watch
#                    (default 0; 1 means a check failed, as gh does)
#   rules.json       what `gh api .../rules/branches/main` returns
#   merge_ok         if present, `gh pr merge` marks the PR merged
#   no_ci_check      if present, `gh pr checks` lists no CI passed check (as
#                    while a run waits for approval) and exits 8 (pending)
#   push_during_ci   if present, `gh pr checks --watch` moves the PR's head to
#                    a new commit, as a push while CI runs would
#   merge_eof        if present, the next `gh pr merge` fails with a transient
#                    API error, without merging, and removes the file
#   merge_lies       if present, `gh pr merge` marks the PR merged but still
#                    fails, as gh does when a step after the merge goes wrong
#   merge_sets       if present, a jq expression `gh pr merge` applies to
#                    pr.json instead (for the merge queue cases)
#   seq.queue        JSON objects, one per line, merged into pr.json by each
#                    `gh api graphql` read (the merge queue status); the last
#                    one then sticks
#   export_stale     if present, `node scripts/export-beads.mjs --check` exits 1
#   export_error     if present, it exits 2 (bd failed)
#   export_recent    if present, `node scripts/export-beads.mjs --due` exits 1
#                    (the committed export is less than a day old); otherwise
#                    it exits 0 (a refresh is due)
#   page_fails       if present, `node scripts/backlog-page.mjs` fails
#   beads_pr_rc      exit code of `npm run -s beads:pr` (default 0)
#   hold             while present, `gh pr checks --watch` blocks (it touches
#                    `holding` first), to keep a land running
#   real_sleep       if present, `sleep` really waits a moment
#   ln_lost_race     if present, the next `ln` fails once without creating
#                    anything, as if another land's lock was released just
#                    after `ln` found it
#   main_runs.json   main's ci.yml push runs, newest first, that `gh run list
#                    --workflow ci.yml` filters by --status, --commit and -L
#                    (default: one successful run on main's head)
#   seq.main_runs    JSON arrays, one per line, one taken per `gh run list
#                    --workflow ci.yml` call instead; the last one then sticks
#   main_head        main's head commit (default mainhead)
#   jobs.json        the jobs `gh run view <id> --json jobs` lists
#   deploy_runs.json deploy.yml's runs (default none)
#   deploy_list_fails if present, `gh run list --workflow deploy.yml` fails
#   calls            every gh, bd, sleep, backlog-page, export --due and npm call, appended by
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
    if [[ " $* " == *" --watch "* ]] && [ -e "$FAKE/push_during_ci" ]; then set_field headRefOid 2222222bbbbbbb; fi
    if [[ " $* " != *" --watch "* ]] && [ -e "$FAKE/no_ci_check" ]; then
      printf 'Tests\tpending\t0\thttps://example.invalid\n'; exit 8
    fi
    if [[ " $* " == *" --watch "* ]] && [ -e "$FAKE/hold" ]; then
      touch "$FAKE/holding"
      while [ -e "$FAKE/hold" ]; do /bin/sleep 0.1; done
    fi
    if [[ " $* " == *" --watch "* ]]; then exit "$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)"; fi
    # Like the real gh: exit 1 when a check failed (and 8 while one is pending).
    rc="$(cat "$FAKE/checks_rc" 2>/dev/null || echo 0)"
    if [ "$rc" = 0 ]; then
      printf 'CI passed\tpass\t1m\thttps://example.invalid\n'
    else
      printf 'CI passed\tfail\t1m\thttps://example.invalid\nTests\tfail\t1m\thttps://example.invalid\n'
    fi
    exit "$rc" ;;
  "pr update-branch") echo "Updated branch" ;;
  "pr merge")
    # Like the real gh: --match-head-commit refuses once the head has moved
    want="$(sed -n 's/.*--match-head-commit \([^ ]*\).*/\1/p' <<< "$*")"
    if [ -n "$want" ] && [ "$want" != "$(jq -r .headRefOid "$pr_json")" ]; then
      echo "X Head branch was modified. Review and try the merge again." >&2; exit 1
    elif [ -e "$FAKE/merge_eof" ]; then
      rm "$FAKE/merge_eof"
      echo "Post \"https://api.github.com/graphql\": EOF" >&2; exit 1
    elif [ -e "$FAKE/merge_lies" ]; then
      set_field state MERGED
      echo "failed to delete local branch feat/x: checked out in a worktree" >&2; exit 1
    elif [ -e "$FAKE/merge_sets" ]; then
      jq "$(cat "$FAKE/merge_sets")" "$pr_json" > "$pr_json.new" && mv "$pr_json.new" "$pr_json"
      echo "! The merge strategy for main is set by the merge queue"
    elif [ -e "$FAKE/merge_ok" ]; then set_field state MERGED; else
      echo "X Pull request is not mergeable: the base branch policy prohibits the merge." >&2; exit 1; fi ;;
  "run list")
    workflow="" status="" commit="" limit=20 expr="."
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --workflow) workflow="$2"; shift 2 ;; --status) status="$2"; shift 2 ;;
        --commit) commit="$2"; shift 2 ;; -L) limit="$2"; shift 2 ;;
        -q|--jq) expr="$2"; shift 2 ;; *) shift ;;
      esac
    done
    case "$workflow" in
      ci.yml)
        file="$FAKE/seq.main_runs"
        if [ -s "$file" ]; then
          runs="$(head -1 "$file")"
          if [ "$(wc -l < "$file")" -gt 1 ]; then tail -n +2 "$file" > "$file.new" && mv "$file.new" "$file"; fi
        elif [ -e "$FAKE/main_runs.json" ]; then runs="$(cat "$FAKE/main_runs.json")"
        else runs='[{"databaseId": 500, "status": "completed", "conclusion": "success", "headSha": "mainhead", "url": "https://example.invalid/runs/500"}]'; fi ;;
      deploy.yml)
        [ ! -e "$FAKE/deploy_list_fails" ] || { echo "HTTP 502" >&2; exit 1; }
        runs="$(cat "$FAKE/deploy_runs.json" 2>/dev/null || echo '[]')" ;;
      *) echo 999; exit 0 ;;
    esac
    jq -c --arg s "$status" --arg c "$commit" --argjson n "$limit" \
      '[.[] | select(($s == "" or .status == $s) and ($c == "" or .headSha == $c))] | .[:$n]' <<< "$runs" | jq -r "$expr" ;;
  "run view")
    if [[ " $* " == *" --json jobs "* ]]; then
      expr="$(sed -n 's/.* -q \(.*\)$/\1/p' <<< "$*")"
      jq -r "$expr" "$FAKE/jobs.json"
    else
      echo "Tests  Run tests  expected 1 to equal 2"
    fi ;;
  "api repos/{owner}/{repo}/branches/main") cat "$FAKE/main_head" 2>/dev/null || echo mainhead ;;
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
    if [ "${2:-}" = --due ]; then echo "node $*" >> "$FAKE/calls"; [ ! -e "$FAKE/export_recent" ]; exit; fi
    [ ! -e "$FAKE/export_error" ] || exit 2
    [ ! -e "$FAKE/export_stale" ] ;;
  scripts/backlog-page.mjs)
    echo "node $*" >> "$FAKE/calls"
    [ ! -e "$FAKE/page_fails" ] || { echo "bd: database not found" >&2; exit 1; }
    mkdir -p dist/backlog
    echo "<html>" > dist/backlog/index.html
    echo h1 > dist/backlog/.hash
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
{"state": "OPEN", "mergeStateStatus": "CLEAN", "headRefName": "feat/x", "headRefOid": "1111111aaaaaaa",
 "title": "feat: a thing", "mergedAt": "2026-10-10T18:00:00Z",
 "body": "Does a thing.\n\nCloses supply-checkout-abc\n",
 "reviews": [], "commits": [{"authors": [{"login": "someone"}]}],
 "url": "https://github.com/example/repo/pull/42", "mergeCommit": {"oid": "abcdef1234567"}}
EOF
  touch "$FAKE/merge_ok" "$FAKE/calls"
  cat > "$FAKE/jobs.json" <<'EOF'
{"jobs": [{"name": "Lint and validate HTML", "conclusion": "success"},
          {"name": "Tests (desktop-edge, web build)", "conclusion": "failure"},
          {"name": "CI passed", "conclusion": "failure"}, {"name": "Infra", "conclusion": "skipped"}]}
EOF
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
check "pins the merge to the commit CI passed on" called "--match-head-commit 1111111aaaaaaa"
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

last_says() { grep -qF -- "$1" <<< "$(tail -1 <<< "$out")"; }

echo "backlog page: rebuilt"
scenario page-built
land
check "exits 0" exits 0
check "rebuilds the page" called "node scripts/backlog-page.mjs"
check "ends with where it wrote the page" last_says "Wrote the backlog page (1 beads): "
check "doesn't ask to publish it" not_says "publish"
check "doesn't run beads:pr for a current export" not_called "beads:pr"
done_case

echo "backlog page: the build fails"
scenario page-fails
touch "$FAKE/page_fails"
mkdir -p "$repo/dist/backlog" && echo old > "$repo/dist/backlog/.hash"
land
check "exits 0" exits 0
check "says it couldn't rebuild it" says "Couldn't rebuild the backlog page"
check "prints the error" says "bd: database not found"
check "says how to rebuild it" says "Rebuild it with npm run backlog:page."
check "doesn't ask to publish it" not_says "publish"
done_case

echo "beads export is stale and the committed one is a day old: refreshes it"
scenario export-stale
touch "$FAKE/export_stale"
land
check "exits 0" exits 0
check "asks whether a refresh is due" called "node scripts/export-beads.mjs --due"
check "says it's refreshing it" says "The beads export is stale: refreshing it with npm run beads:pr"
check "runs beads:pr after releasing the land lock" called "npm run -s beads:pr (lock free"
check "tells the export's land to skip the backlog" called "npm run -s beads:pr (lock free, skip=1)"
check "runs it once" [ "$(count "beads:pr")" -eq 1 ]
check "rebuilds the page after" [ "$(grep -n -e beads:pr -e backlog-page "$FAKE/calls" | tail -1 | grep -c backlog-page)" -eq 1 ]
check "ends with where it wrote the page" last_says "Wrote the backlog page"
check "releases the lock" unlocked
done_case

echo "beads export is stale, but the committed one is less than a day old"
scenario export-recent
touch "$FAKE/export_stale" "$FAKE/export_recent"
land
check "exits 0" exits 0
check "asks whether a refresh is due" called "node scripts/export-beads.mjs --due"
check "doesn't run beads:pr" not_called "beads:pr"
check "says it's left for later" says "The beads export is stale, but the committed one is less than a day old"
check "still rebuilds the page" called "node scripts/backlog-page.mjs"
check "ends with where it wrote the page" last_says "Wrote the backlog page"
done_case

echo "beads export is current: doesn't ask whether a refresh is due"
scenario export-current
land
check "exits 0" exits 0
check "doesn't ask" not_called "export-beads.mjs --due"
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
check "ends saying the export PR didn't land" last_says "the beads export PR didn't land"
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

# main's rules as they are: code scanning plus the unattributed-changes approval
scanning_rules() {
  cat > "$FAKE/rules.json" <<'EOF'
[{"type": "pull_request", "parameters": {"required_approving_review_count": 0,
   "require_extra_approval_for_unattributed_changes": true}},
 {"type": "required_status_checks"},
 {"type": "code_scanning", "parameters": {"code_scanning_tools": [{"tool": "CodeQL",
   "security_alerts_threshold": "medium_or_higher", "alerts_threshold": "errors"}]}}]
EOF
}

echo "blocked by code scanning: CodeQL skipped (a beads-only PR)"
scenario blocked-codeql-skipped
scanning_rules
pr '.mergeStateStatus = "BLOCKED" | .statusCheckRollup = [
  {"name": "CI passed", "conclusion": "SUCCESS"}, {"name": "CodeQL", "conclusion": "SKIPPED"}]'
land
check "exits non-zero" fails
check "doesn't try to merge" not_called "gh pr merge"
check "names the code_scanning rule" says "code_scanning: main needs CodeQL results"
check "says the check was skipped" says "CodeQL check is skipped"
check "says what to do" says "codeql job in .github/workflows/ci.yml"
check "doesn't blame unattributed changes" not_says "require_extra_approval_for_unattributed_changes"
check "doesn't ask for an approval" not_says "gh pr review 42 --approve"
check "says an approval won't help" says "An approval won't help"
done_case

echo "blocked by code scanning: no CodeQL check at all"
scenario blocked-codeql-missing
scanning_rules
pr '.mergeStateStatus = "BLOCKED" | .statusCheckRollup = [{"name": "CI passed", "conclusion": "SUCCESS"}]'
land
check "exits non-zero" fails
check "says the check is missing" says "CodeQL check is missing"
check "doesn't blame unattributed changes" not_says "require_extra_approval_for_unattributed_changes"
done_case

echo "blocked by code scanning: CodeQL found alerts"
scenario blocked-codeql-failing
scanning_rules
pr '.mergeStateStatus = "BLOCKED" | .statusCheckRollup = [
  {"name": "CodeQL / CodeQL (actions)", "conclusion": "SUCCESS"}, {"name": "CodeQL", "conclusion": "FAILURE"}]'
land
check "exits non-zero" fails
check "says the check is failing" says "CodeQL check is failing"
check "points at the checks" says "https://github.com/example/repo/pull/42/checks"
done_case

echo "blocked with CodeQL green and a commit by no linked user"
scenario blocked-unattributed
scanning_rules
pr '.mergeStateStatus = "BLOCKED" | .commits = [{"authors": [{"login": "someone"}, {"login": "", "name": "test"}]}]
  | .statusCheckRollup = [{"name": "CodeQL / CodeQL (javascript-typescript)", "conclusion": "SUCCESS"},
                          {"name": "CodeQL", "conclusion": "SUCCESS"}]'
land
check "exits non-zero" fails
check "names the unattributed-changes rule" says "require_extra_approval_for_unattributed_changes"
check "doesn't name code scanning" not_says "code_scanning"
check "gives the approve command" says "gh pr review 42 --approve"
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
check "tries the merge 3 times" test "$(count "gh pr merge")" -eq 3
check "backs off between tries" called "sleep 10"
check "leaves the worktree and branch" untouched
check "releases the lock" unlocked
done_case

echo "merge fails once with a transient error, then succeeds"
scenario merge-transient
touch "$FAKE/merge_eof"
land
check "exits 0" exits 0
check "prints gh's error" says "api.github.com/graphql"
check "says it's retrying" says "Retrying the merge"
check "tries the merge twice" test "$(count "gh pr merge")" -eq 2
check "reports the merge commit" says "Merged as abcdef1"
check "removes the worktree and branch" cleaned_up
check "closes the Closes bead" called "bd close supply-checkout-abc"
done_case

echo "a push while CI runs"
scenario pushed-during-ci
touch "$FAKE/push_during_ci"
land
check "exits non-zero" fails
check "doesn't merge the untested commit" [ "$(jq -r .state "$FAKE/pr.json")" = OPEN ]
check "says the branch changed" says "feat/x changed after CI passed on 1111111"
check "doesn't retry" test "$(count "gh pr merge")" -eq 1
check "leaves the worktree and branch" untouched
check "releases the lock" unlocked
done_case

echo "the CI passed check never appears"
scenario no-ci-check
touch "$FAKE/no_ci_check"
land
check "exits non-zero" fails
check "says why" says "The CI passed check hasn't appeared on #42 after 30 minutes."
check "polls every 10s" called "sleep 10"
check "gives up after 180 polls" test "$(count "sleep 10")" -eq 180
check "doesn't try to merge" not_called "gh pr merge"
check "releases the lock" unlocked
done_case

echo "merge 'fails' but the PR merged"
scenario merge-lies
rm "$FAKE/merge_ok"
touch "$FAKE/merge_lies"
land
check "exits 0" exits 0
check "doesn't retry" test "$(count "gh pr merge")" -eq 1
check "doesn't say the merge failed" not_says "Merge failed."
check "reports the merge commit" says "Merged as abcdef1"
check "removes the worktree and branch" cleaned_up
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
check "pins the queued merge to the commit CI passed on" called "gh pr merge 42 --squash --match-head-commit 1111111aaaaaaa"
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

# --- main's CI and the release window (supply-checkout-pbp.46, pbp.47) --------
green_run='{"databaseId": 500, "status": "completed", "conclusion": "success", "headSha": "mainhead", "url": "https://example.invalid/runs/500"}'
red_run='{"databaseId": 400, "status": "completed", "conclusion": "failure", "headSha": "mainhead", "url": "https://example.invalid/runs/400"}'
older_red='{"databaseId": 400, "status": "completed", "conclusion": "failure", "headSha": "oldhead", "url": "https://example.invalid/runs/400"}'
going='{"databaseId": 501, "status": "in_progress", "conclusion": "", "headSha": "mainhead", "url": "https://example.invalid/runs/501"}'
fixed='{"databaseId": 501, "status": "completed", "conclusion": "success", "headSha": "mainhead", "url": "https://example.invalid/runs/501"}'
still_red='{"databaseId": 501, "status": "completed", "conclusion": "failure", "headSha": "mainhead", "url": "https://example.invalid/runs/501"}'
release_pr() {
  pr '.headRefName = "release-please--branches--main--components--supply-checkout" | .title = "chore(main): release 1.13.0"
    | .mergedAt = "2026-10-10T18:00:00Z" | .body = "Release notes"'
  git -C "$repo" worktree remove .claude/worktrees/feat/x
  git -C "$repo" branch -q -m feat/x release-please--branches--main--components--supply-checkout
}
release_file() { printf '%s\n' "$repo/.git/land-pr-release.lock"; }
hold_release() { # tag taken
  printf 'tag=%s\npr=40\ntaken=%s\n' "$1" "$2" > "$(release_file)"
}
land_with() {
  rc=0
  out="$(cd "$repo" && bash "$script" "$@" 2>&1)" || rc=$?
}

echo "main is red"
scenario main-red
echo "[$red_run]" > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "says main is red" says "main is red: #42 wasn't merged."
check "links the failed run" says "https://example.invalid/runs/400"
check "names the failing job" says "  - Tests (desktop-edge, web build)"
check "doesn't name passing or skipped jobs" not_says "  - Infra"
check "says how to land the fix" says "npm run land -- <fix-pr> --fixes-main"
check "doesn't wait for the PR's CI" not_called "gh pr checks"
check "doesn't merge" not_called "gh pr merge"
check "leaves the worktree and branch" untouched
check "releases the lock" unlocked
done_case

echo "main is red, and the PR is the fix (--fixes-main)"
scenario main-red-fix
echo "[$red_run]" > "$FAKE/main_runs.json"
land_with 42 --fixes-main
check "exits 0" exits 0
check "says it's landing anyway" says "--fixes-main says #42 is the fix: landing it anyway."
check "still names the failing job" says "  - Tests (desktop-edge, web build)"
check "merges" called "gh pr merge 42 --squash --delete-branch"
done_case

echo "main is red, and a newer run on its head passes"
scenario main-red-then-green
seq_of main_runs "[$going, $older_red]" "[$going, $older_red]" "[$going, $older_red]" "[$fixed, $older_red]"
land
check "exits 0" exits 0
check "waits for the newer run" says "a newer one on mainhea is still going: waiting for it."
check "polls every 30s" called "sleep 30"
check "says main passed" says "main's CI passed on mainhea."
check "merges" called "gh pr merge 42"
done_case

echo "main is red, and the newer run fails too"
scenario main-red-newer-red
seq_of main_runs "[$going, $older_red]" "[$going, $older_red]" "[$still_red, $older_red]" "[$still_red, $older_red]"
land
check "exits non-zero" fails
check "names the newer run" says "https://example.invalid/runs/501"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "main is red, and the newer run never finishes"
scenario main-red-newer-slow
echo "[$going, $older_red]" > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "waits 45 minutes" [ "$(count "sleep 30")" -eq 90 ]
check "names the red run" says "https://example.invalid/runs/400"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "main goes red while the PR's CI runs"
scenario main-red-during-ci
seq_of main_runs "[$green_run]" "[$red_run]"
land
check "exits non-zero" fails
check "waited for the PR's CI first" called "gh pr checks 42 --watch"
check "says main is red" says "main is red: #42 wasn't merged."
check "doesn't merge" not_called "gh pr merge"
check "releases the lock" unlocked
done_case

echo "main's runs can't be read"
scenario main-runs-unreadable
echo '[]' > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "says so" says "main has no completed CI run to go by"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "merge queue: main is red"
scenario queue-main-red
queue_on
echo "[$red_run]" > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "says main is red" says "main is red: #42 wasn't merged."
check "doesn't enqueue" not_called "gh pr merge"
done_case

echo "release PR: main green on its head"
scenario release
release_pr
touch "$FAKE/export_stale"
land
check "exits 0" exits 0
check "checks main's CI on its head" called "gh run list --workflow ci.yml --branch main --event push -L 1 --commit mainhead"
check "says main passed on the commit it tags" says "main's CI passed on mainhea, the commit release v1.13.0 will tag"
check "merges" called "gh pr merge 42 --squash --delete-branch"
check "opens the release window" says "Release window open for v1.13.0"
check "records the tag" grep -qx "tag=v1.13.0" "$(release_file)"
check "records the PR" grep -qx "pr=42" "$(release_file)"
check "records the merge time" grep -qx "taken=2026-10-10T18:00:00Z" "$(release_file)"
check "leaves the beads export for after the deploy" says "release v1.13.0's window is open: left for a land after its deploy"
check "doesn't run beads:pr" not_called "beads:pr"
check "releases the land lock" unlocked
done_case

echo "release PR: main's CI on its head is still going, then passes"
scenario release-wait
release_pr
seq_of main_runs "[$going, $older_red]" "[$fixed, $older_red]"
land
check "exits 0" exits 0
check "waits for it" says "Waiting up to 45 minutes for main's CI on mainhea"
check "merges" called "gh pr merge 42"
done_case

echo "release PR: main's CI failed on its head"
scenario release-red
release_pr
echo "[$red_run]" > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "says why" says "main's CI didn't pass on mainhea, the commit release v1.13.0 would tag"
check "names the failing job" says "  - Tests (desktop-edge, web build)"
check "doesn't merge" not_called "gh pr merge"
check "opens no release window" [ ! -e "$(release_file)" ]
done_case

echo "release PR: main's last green run isn't on its head"
scenario release-green-elsewhere
release_pr
echo '[{"databaseId": 500, "status": "completed", "conclusion": "success", "headSha": "oldhead", "url": "u"}]' > "$FAKE/main_runs.json"
land
check "exits non-zero" fails
check "says CI hasn't run on the commit it tags" says "main's CI hasn't run on mainhea, the commit release v1.13.0 would tag"
check "waits 45 minutes first" [ "$(count "sleep 30")" -eq 90 ]
check "doesn't merge" not_called "gh pr merge"
done_case

echo "release PR: --fixes-main doesn't apply"
scenario release-fixes-main
release_pr
land_with 42 --fixes-main
check "exits non-zero" fails
check "says so" says "#42 is a release PR: --fixes-main doesn't apply."
check "doesn't merge" not_called "gh pr merge"
done_case

echo "release PR: a title without a version"
scenario release-no-version
release_pr
pr '.title = "chore(main): release"'
land
check "exits non-zero" fails
check "says so" says "doesn't name a version"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "release window: its deploy is running"
scenario window-deploying
hold_release v1.13.0 2026-10-10T18:00:00Z
echo '[{"displayTitle": "Deploy v1.13.0", "status": "in_progress", "conclusion": "", "createdAt": "2026-10-10T18:20:00Z", "url": "https://example.invalid/deploy/7"}]' > "$FAKE/deploy_runs.json"
land
check "exits non-zero" fails
check "names the release" says "Release v1.13.0 (#40, merged 2026-10-10T18:00:00Z) is in its release window"
check "links its deploy run" says "Its deploy run is in_progress: https://example.invalid/deploy/7"
check "says how the lead clears it" says "npm run land -- --release-done"
check "doesn't wait for the PR's CI" not_called "gh pr checks"
check "doesn't merge" not_called "gh pr merge"
check "keeps the release lock" grep -qx "tag=v1.13.0" "$(release_file)"
check "releases the land lock" unlocked
done_case

echo "release window: no deploy yet, and older or dry runs don't count"
scenario window-no-deploy
hold_release v1.13.0 2026-10-10T18:00:00Z
echo '[{"displayTitle": "Deploy v1.13.0 (dry run)", "status": "completed", "conclusion": "success", "createdAt": "2026-10-10T18:05:00Z", "url": "d"},
       {"displayTitle": "Deploy v1.13.0", "status": "completed", "conclusion": "failure", "createdAt": "2026-10-10T17:00:00Z", "url": "e"},
       {"displayTitle": "Deploy v1.12.0", "status": "completed", "conclusion": "success", "createdAt": "2026-10-10T18:06:00Z", "url": "f"}]' > "$FAKE/deploy_runs.json"
land
check "exits non-zero" fails
check "says no deploy has started" says "No deploy run for v1.13.0 has started yet"
check "doesn't merge" not_called "gh pr merge"
check "keeps the release lock" test -e "$(release_file)"
done_case

echo "release window: its deploy finished (failed)"
scenario window-deployed
hold_release v1.13.0 2026-10-10T18:00:00Z
echo '[{"displayTitle": "Deploy v1.13.0", "status": "completed", "conclusion": "failure", "createdAt": "2026-10-10T18:20:00Z", "url": "https://example.invalid/deploy/7"}]' > "$FAKE/deploy_runs.json"
land
check "exits 0" exits 0
check "says the deploy finished" says "Release v1.13.0's deploy finished (failure): https://example.invalid/deploy/7"
check "clears the release lock" [ ! -e "$(release_file)" ]
check "merges" called "gh pr merge 42"
done_case

echo "release window: a new release PR once the last one deployed"
scenario window-next-release
hold_release v1.12.0 2026-10-09T18:00:00Z
echo '[{"displayTitle": "Deploy v1.12.0", "status": "completed", "conclusion": "success", "createdAt": "2026-10-09T18:20:00Z", "url": "u"}]' > "$FAKE/deploy_runs.json"
release_pr
land
check "exits 0" exits 0
check "merges" called "gh pr merge 42"
check "records the new release" grep -qx "tag=v1.13.0" "$(release_file)"
done_case

echo "release window: a new release PR while the last one deploys"
scenario window-release-blocked
hold_release v1.12.0 2026-10-09T18:00:00Z
release_pr
land
check "exits non-zero" fails
check "names the older release" says "Release v1.12.0 (#40"
check "doesn't merge" not_called "gh pr merge"
check "keeps the older lock" grep -qx "tag=v1.12.0" "$(release_file)"
done_case

echo "release window: deploy runs can't be listed"
scenario window-gh-fails
hold_release v1.13.0 2026-10-10T18:00:00Z
touch "$FAKE/deploy_list_fails"
land
check "exits non-zero" fails
check "says so" says "its deploy runs couldn't be listed"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "release window: an unreadable lock"
scenario window-garbled
printf 'tag=latest\n' > "$(release_file)"
land
check "exits non-zero" fails
check "says so" says "doesn't name a release tag and merge time"
check "doesn't merge" not_called "gh pr merge"
done_case

echo "release window: an already merged PR still cleans up"
scenario window-cleanup
hold_release v1.13.0 2026-10-10T18:00:00Z
pr '.state = "MERGED" | .mergeStateStatus = "UNKNOWN"'
land
check "exits 0" exits 0
check "cleans up" cleaned_up
check "keeps the release lock" test -e "$(release_file)"
done_case

echo "--release-done"
scenario release-done
hold_release v1.13.0 2026-10-10T18:00:00Z
land_with --release-done
check "exits 0" exits 0
check "says what it cleared" says "Cleared the release window for v1.13.0 (#40, merged 2026-10-10T18:00:00Z)."
check "clears it" [ ! -e "$(release_file)" ]
check "calls no gh" not_called "gh "
check "doesn't say a PR wasn't merged" not_says "was not merged"
done_case
land_with --release-done
check "says when none is open" says "No release window is open."
done_case

echo "bad arguments"
scenario bad-args
land_with 42 --fixes-mian
check "exits non-zero" fails
check "prints the usage" says "usage: scripts/land-pr.sh <pr-number> [--fixes-main]"
land_with --release-done 42
check "--release-done takes no PR" says "usage:"
land_with
check "needs a PR" says "usage:"
check "calls no gh" not_called "gh "
done_case

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "All land-pr checks passed"
