#!/usr/bin/env bash
# Tests for scripts/assume-aws-role.sh, run with: npm run test:scripts
#
# Each case runs the script against fake `aws` and `curl`, so nothing touches AWS or GitHub. The
# account ID, role ID and keys are fake, and built at run time so none sits in the repository.
# SHOW_ALL=1 prints every case's output.
#
# Scenario files, in $FAKE:
#   fail_with   `aws sts …` fails with this STS error code (once per line, then succeeds)
#   newline     the session token STS returns has a newline in it
#   calls       every aws and curl call, appended by the fakes
#
# check() evals its condition later, so its single-quoted $out, $calls and $envfile are meant.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/assume-aws-role.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

account="$(printf '%012d' 4242)"
role_id="AROA$(printf 'X%.0s' {1..17})"
export FAKE="$tmp/fake" ACCOUNT="$account" ROLE_ID="$role_id"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE/calls"
if [[ -s "$FAKE/fail_with" ]]; then
  code="$(head -1 "$FAKE/fail_with")"
  sed -i.bak 1d "$FAKE/fail_with"
  echo "An error occurred ($code) when calling the AssumeRole operation: User: arn:aws:sts::$ACCOUNT:assumed-role/x/y is not authorized on arn:aws:iam::$ACCOUNT:role/z" >&2
  exit 254
fi
session=$(sed -n 's/.*--role-session-name \([^ ]*\).*/\1/p' <<< "$*")
token="FakeSessionToken0123456789+/="
[[ -e "$FAKE/newline" ]] && token='Fake\nAWS_EXTRA=1'
cat <<JSON
{"Credentials":{"AccessKeyId":"FAKEKEYID0001","SecretAccessKey":"FakeSecretKey0123456789/abc","SessionToken":"$token","Expiration":"2026-10-08T12:00:00Z"},
 "AssumedRoleUser":{"AssumedRoleId":"$ROLE_ID:$session","Arn":"arn:aws:sts::$ACCOUNT:assumed-role/supply-checkout-prod-journeys/$session"}}
JSON
FAKE
cat > "$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls"
for arg in "$@"; do [[ "$arg" == @* ]] && cp "${arg#@}" "$FAKE/header"; done
echo '{"value":"fake.oidc.jwt-value"}'
FAKE
chmod +x "$tmp/bin/aws" "$tmp/bin/curl"

failures=0
run() {
  local mode="$1"; shift
  rm -rf "$FAKE"; mkdir -p "$FAKE"; : > "$FAKE/calls"
  envfile="$tmp/github-env"; : > "$envfile"
  set +e
  out="$(env -i PATH="$tmp/bin:$PATH" HOME="$HOME" FAKE="$FAKE" ACCOUNT="$ACCOUNT" ROLE_ID="$ROLE_ID" RUNNER_TEMP="$tmp" RETRY_DELAY=0 \
    GITHUB_ENV="$envfile" ROLE_ARN="arn:aws:iam::$account:role/supply-checkout-prod-journeys" SESSION_NAME="journeys-1-1" AWS_REGION="us-east-1" \
    ACTIONS_ID_TOKEN_REQUEST_URL="https://token.example.test/?api-version=2" ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token-value" \
    "$@" bash "$script" "$mode" 2>&1)"
  rc=$?
  set -e
  calls="$(cat "$FAKE/calls")"
}
# Lines a reader sees: the mask commands aren't shown in a run's log
visible() { grep -v '^::add-mask::' <<< "$out" || true; }
check() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    [[ -n "${SHOW_ALL:-}" ]] && printf 'ok   %s\n%s\n' "$name" "$out"
  else
    failures=$((failures + 1))
    printf 'FAIL %s: %s\n--- output\n%s\n--- calls\n%s\n--- GITHUB_ENV\n%s\n' "$name" "$cond" "$out" "$calls" "$(cat "$envfile")"
  fi
  return 0
}
masked() { grep -qxF "::add-mask::$1" <<< "$out"; }
quiet() { ! visible | grep -qE "AROA|ASIA|AKIA|FAKEKEYID|FakeSecret|FakeSession|fake\.oidc|$account"; }

run web-identity
check "web-identity: signs in" '[[ $rc -eq 0 ]]'
check "web-identity: masks the account first" '[[ "$(head -1 <<< "$out")" == "::add-mask::$account" ]]'
check "web-identity: masks the token, keys, role ID and ARN" 'masked fake.oidc.jwt-value && masked FAKEKEYID0001 && masked FakeSecretKey0123456789/abc && masked "FakeSessionToken0123456789+/=" && masked "$role_id:journeys-1-1" && masked "$role_id" && masked "arn:aws:sts::$account:assumed-role/supply-checkout-prod-journeys/journeys-1-1"'
check "web-identity: prints nothing that names the account or role" 'quiet && [[ "$(visible)" == "Signed in to AWS as the role (session journeys-1-1, us-east-1)" ]]'
check "web-identity: exports the credentials and region" '[[ "$(cat "$envfile")" == $'"'"'AWS_ACCESS_KEY_ID=FAKEKEYID0001\nAWS_SECRET_ACCESS_KEY=FakeSecretKey0123456789/abc\nAWS_SESSION_TOKEN=FakeSessionToken0123456789+/=\nAWS_REGION=us-east-1\nAWS_DEFAULT_REGION=us-east-1'"'"' ]]'
check "web-identity: asks GitHub for the sts.amazonaws.com audience, the request token in a header file" 'grep -q "curl .*https://token.example.test/?api-version=2&audience=sts.amazonaws.com" <<< "$calls" && ! grep -q request-token-value <<< "$calls" && grep -qx "Authorization: bearer request-token-value" "$FAKE/header"'
check "web-identity: the OIDC token goes to STS from a file" 'grep -qE "^aws sts assume-role-with-web-identity --web-identity-token file://[^ ]+/token --role-arn arn:aws:iam::$account:role/supply-checkout-prod-journeys --role-session-name journeys-1-1 --region us-east-1 --output json$" <<< "$calls" && ! grep -q fake.oidc <<< "$calls"'
check "web-identity: leaves no temporary files" '[[ -z "$(ls -A "$tmp" | grep assume-role || true)" ]]'

run chain DURATION=900
check "chain: assumes the role with the job's credentials, no OIDC token" '[[ $rc -eq 0 ]] && ! grep -q curl <<< "$calls" && grep -qE "^aws sts assume-role --role-arn [^ ]+ --role-session-name journeys-1-1 --duration-seconds 900 --region us-east-1 --output json$" <<< "$calls"'
check "chain: quiet" 'quiet && masked "$role_id"'

run web-identity ROLE_ARN="arn:aws:iam::$account:user/someone"
check "a role ARN only, and never printed" '[[ $rc -ne 0 ]] && grep -q "ROLE_ARN isn.t an IAM role.s ARN" <<< "$out" && ! grep -q "$account" <<< "$out" && [[ -z "$calls" && ! -s "$envfile" ]]'
run web-identity SESSION_NAME="bad name"
check "a valid session name" '[[ $rc -ne 0 ]] && grep -q "SESSION_NAME" <<< "$out" && [[ -z "$calls" ]]'
run web-identity AWS_REGION="nowhere"
check "a region" '[[ $rc -ne 0 ]] && grep -q "AWS_REGION" <<< "$out"'
run web-identity DURATION="1h"
check "a duration in seconds" '[[ $rc -ne 0 ]] && grep -q "DURATION" <<< "$out"'
run frobnicate
check "usage" '[[ $rc -ne 0 ]] && grep -q "usage" <<< "$out"'
run web-identity GITHUB_ENV=
check "only in GitHub Actions" '[[ $rc -ne 0 ]] && grep -q "GITHUB_ENV" <<< "$out"'
run web-identity ACTIONS_ID_TOKEN_REQUEST_TOKEN=
check "web-identity needs id-token: write" '[[ $rc -ne 0 ]] && grep -q "id-token: write" <<< "$out" && [[ -z "$calls" ]]'

# STS's refusal is reported by its code alone (its message names ARNs), and isn't retried.
# run() resets $FAKE, so the scenario goes in through a wrapper on PATH
cat > "$tmp/bin/with-fail" <<'FAKE'
#!/usr/bin/env bash
printf '%b' "$FAIL_WITH" > "$FAKE/fail_with"
[[ -n "${NEWLINE:-}" ]] && touch "$FAKE/newline"
exec "$@"
FAKE
chmod +x "$tmp/bin/with-fail"
script_real="$script"
script="$tmp/wrapped.sh"
printf '#!/usr/bin/env bash\nexec with-fail bash %q "$@"\n' "$script_real" > "$script"

run web-identity FAIL_WITH='AccessDenied\n'
check "a refusal: its code only, tried once" '[[ $rc -ne 0 ]] && grep -q "couldn.t assume the role (AccessDenied)" <<< "$out" && ! grep -q "$account" <<< "$(visible)" && [[ $(grep -c "^aws " <<< "$calls") -eq 1 && ! -s "$envfile" ]]'
run web-identity FAIL_WITH='Throttling\n'
check "a throttle is retried" '[[ $rc -eq 0 && $(grep -c "^aws " <<< "$calls") -eq 2 ]]'
run web-identity FAIL_WITH='Throttling\nThrottling\nThrottling\n'
check "three failures give up" '[[ $rc -ne 0 && $(grep -c "^aws " <<< "$calls") -eq 3 ]] && grep -q "(Throttling)" <<< "$out"'
run web-identity FAIL_WITH= NEWLINE=1
check "credentials that could add a variable are refused" '[[ $rc -ne 0 ]] && grep -q "unexpected characters" <<< "$out" && [[ ! -s "$envfile" ]]'

if [[ $failures -gt 0 ]]; then
  echo "assume-aws-role.test.sh: $failures failed"
  exit 1
fi
echo "assume-aws-role.test.sh: all passed"
