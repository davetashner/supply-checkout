#!/usr/bin/env bash
# Tests for scripts/deploy-diff.sh, run with: npm run test:scripts
# A fake `cdk` prints a canned diff, so nothing touches AWS. check() evals its condition later,
# so its single-quoted $rc, $out and paths are meant.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/cdk" <<'FAKE'
#!/usr/bin/env bash
echo "cdk $*" >> "$FAKE_CALLS"
cat "$FAKE_DIFF"
exit "${FAKE_STATUS:-0}"
FAKE
chmod +x "$tmp/cdk"

failures=0
run() { # name, diff text, [status]
  export FAKE_DIFF="$tmp/$1.in" FAKE_CALLS="$tmp/$1.calls" FAKE_STATUS="${3:-0}"
  printf '%s\n' "$2" > "$FAKE_DIFF"
  : > "$FAKE_CALLS"
  export RUNNER_TEMP="$tmp/$1" GITHUB_OUTPUT="$tmp/$1.output" GITHUB_STEP_SUMMARY="$tmp/$1.summary" ENV_NAME=prod CDK="$tmp/cdk"
  mkdir -p "$RUNNER_TEMP"; : > "$GITHUB_OUTPUT"; : > "$GITHUB_STEP_SUMMARY"
  set +e
  out="$(bash "$here/deploy-diff.sh" stateful "Stateful stacks" 2>&1)"
  rc=$?
  set -e
}
check() { # name, description, condition
  if eval "$3"; then return 0; fi
  failures=$((failures + 1))
  printf 'FAIL %s: %s\n--- output\n%s\n' "$1" "$2" "$out"
}

run changed $'Stack supply-checkout-prod-r-data\n[~] AWS::IAM::Role R RABC\n  "arn:aws:iam::123456789012:root"\n\n✨  Number of stacks with differences: 1' # public-safety: allow (a fake ID)
check changed "diffs the stateful stacks only, read-only, from cdk.out" 'grep -qF -- "cdk diff --app cdk.out --no-lookups --exclusively --method template --no-color --no-notices supply-checkout-prod-*-domain supply-checkout-prod-*-data supply-checkout-prod-*-identity supply-checkout-prod-*-email supply-checkout-prod-*-backup supply-checkout-prod-*-audit" "$tmp/changed.calls"'
check changed "says it changed, and scrubs the account ID from the log, the file and the summary" '[[ $rc == 0 ]] && grep -qx changed=true "$GITHUB_OUTPUT" && [[ "$out" != *123456789012* ]] && ! grep -q 123456789012 "$RUNNER_TEMP/diff-stateful.txt" "$GITHUB_STEP_SUMMARY" && grep -q "iam::<account>:root" "$GITHUB_STEP_SUMMARY" && grep -q "## Stateful stacks" "$GITHUB_STEP_SUMMARY"'

run same $'Stack supply-checkout-prod-r-data\nThere were no differences\n\n✨  Number of stacks with differences: 0'
check same "says nothing changed" '[[ $rc == 0 ]] && grep -qx changed=false "$GITHUB_OUTPUT"'

run failed $'Error: Need to perform AWS calls for account 123456789012' 1 # public-safety: allow (a fake ID)
check failed "fails when cdk diff fails, still scrubbed, with no output" '[[ $rc == 1 ]] && [[ "$out" == *"cdk diff failed"* ]] && [[ "$out" != *123456789012* ]] && [[ ! -s "$GITHUB_OUTPUT" ]]'

run garbled $'something else'
check garbled "fails on output without the count" '[[ $rc == 1 ]] && [[ "$out" == *"didn'"'"'t say how many"* ]]'

# --- assembly-hash.sh -------------------------------------------------------------
asm() { mkdir -p "$1"; printf '{"version":"1"}' > "$1/manifest.json"; printf '{"Resources":{}}' > "$1/a.template.json"; printf '{"files":{}}' > "$1/a.assets.json"; printf '{"tree":1}' > "$1/tree.json"; }
hash_of() { bash "$here/assembly-hash.sh" "$1"; }
asm "$tmp/asm1"; asm "$tmp/asm2"
out="$(hash_of "$tmp/asm1")"
check hash "the same assembly in another folder has the same hash" '[[ "$out" =~ ^[0-9a-f]{64}$ && "$out" == "$(hash_of "$tmp/asm2")" ]]'
printf '{"tree":2}' > "$tmp/asm2/tree.json"; printf '{}' > "$tmp/asm2/x.metadata.json"
check hash "tree.json and metadata don't count" '[[ "$out" == "$(hash_of "$tmp/asm2")" ]]'
printf '{"version":"2"}' > "$tmp/asm2/manifest.json"
check hash "manifest.json counts" '[[ "$out" != "$(hash_of "$tmp/asm2")" ]]'
asm "$tmp/asm3"; printf '{"files":{"x":1}}' > "$tmp/asm3/a.assets.json"
check hash "an asset manifest counts" '[[ "$out" != "$(hash_of "$tmp/asm3")" ]]'
asm "$tmp/asm4"; printf '{"Resources":{"B":{}}}' > "$tmp/asm4/a.template.json"
check hash "a template counts" '[[ "$out" != "$(hash_of "$tmp/asm4")" ]]'
asm "$tmp/asm5"; mv "$tmp/asm5/a.template.json" "$tmp/asm5/b.template.json"
check hash "a renamed template counts" '[[ "$out" != "$(hash_of "$tmp/asm5")" ]]'
mkdir -p "$tmp/empty"
check hash "a folder without manifest.json fails" '! hash_of "$tmp/empty" 2>/dev/null'

if ((failures)); then echo "$failures deploy-diff.sh and assembly-hash.sh check(s) failed"; exit 1; fi
echo "deploy-diff.sh and assembly-hash.sh: all checks passed"
