#!/usr/bin/env bash
# Shows one group of stacks' `cdk diff` in the deploy workflow (.github/workflows/deploy.yml,
# supply-checkout-pbp.27), from infra/ after `cdk synth` has written cdk.out:
#
#   bash <tools>/scripts/deploy-diff.sh <group> <title>
#
# <group> is a group in scripts/deploy-stacks.mjs (stateless, stateful). It diffs the deployed
# templates against cdk.out (--method template: reads only, so the read-only lookup role is
# enough; --no-lookups: no context lookups, whatever the assembly asks for), takes every
# account ID out (scripts/scrub-account-ids.sed), prints the result, keeps it in
# $RUNNER_TEMP/diff-<group>.txt for scripts/check-replacements.mjs, adds it to the job summary
# under <title>, and sets the step output `changed` to true or false. A failed diff, or
# output without CDK's "Number of stacks with differences" line, fails the step.
#
# Needs ENV_NAME, RUNNER_TEMP, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY; CDK (default
# ./node_modules/.bin/cdk, the locked local copy) is overridable for tests.
set -euo pipefail

group="${1:?usage: deploy-diff.sh <group> <title>}"
title="${2:?usage: deploy-diff.sh <group> <title>}"
tools="$(cd "$(dirname "$0")" && pwd)"
cdk="${CDK:-./node_modules/.bin/cdk}"
out="${RUNNER_TEMP:?}/diff-$group.txt"

patterns="$(node "$tools/deploy-stacks.mjs" "$group" --env "${ENV_NAME:?}")"
read -r -a stacks <<< "$patterns"

# The unscrubbed output never reaches the log or a file
set +e
"$cdk" diff --app cdk.out --no-lookups --exclusively --method template --no-color --no-notices "${stacks[@]}" 2>&1 \
  | sed -E -f "$tools/scrub-account-ids.sed" > "$out"
status=("${PIPESTATUS[@]}")
set -e
cat "$out"

{
  echo "## $title"
  echo
  echo '```diff'
  head -c 400000 "$out"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:?}"

if ((status[0] != 0 || status[1] != 0)); then
  echo "::error::cdk diff failed for the $group stacks"
  exit 1
fi
count="$(grep -oE 'Number of stacks with differences: [0-9]+' "$out" | tail -n 1 | grep -oE '[0-9]+$' || true)"
if [[ -z "$count" ]]; then
  echo "::error::cdk diff for the $group stacks didn't say how many stacks differ"
  exit 1
fi
if ((count > 0)); then changed=true; else changed=false; fi
echo "The $group stacks: $count with differences"
echo "changed=$changed" >> "${GITHUB_OUTPUT:?}"
