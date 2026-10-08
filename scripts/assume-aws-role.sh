#!/usr/bin/env bash
# Signs a GitHub Actions job in to AWS as a role, printing nothing that names the account or the
# role (supply-checkout-o60.13). In place of aws-actions/configure-aws-credentials, which always
# logs "Authenticated as assumedRoleId AROA…:<session>": a role's unique ID can be mapped back to
# its account, and this repository's run logs are public.
#
#   ROLE_ARN=… SESSION_NAME=… AWS_REGION=… [DURATION=<seconds>] assume-aws-role.sh web-identity
#   ROLE_ARN=… SESSION_NAME=… AWS_REGION=… [DURATION=<seconds>] assume-aws-role.sh chain
#
# web-identity  exchanges the job's GitHub OIDC token (audience sts.amazonaws.com, as the action
#               asks for; the job needs `id-token: write`) with sts:AssumeRoleWithWebIdentity
# chain         assumes the role with the credentials the job already has (sts:AssumeRole), like
#               the action's role-chaining with role-skip-session-tagging: no session tags
#
# Before anything it could print, it masks (::add-mask::) the account ID in ROLE_ARN, then the
# OIDC token, and then the new session's key ID, secret key, session token, assumed role ID (and
# its AROA… part alone) and ARN. It writes AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# AWS_SESSION_TOKEN, AWS_REGION and AWS_DEFAULT_REGION to $GITHUB_ENV for the later steps. On a
# failure it prints only STS's error code, never its message (which can carry ARNs).
set -euo pipefail

die() { echo "::error::assume-aws-role: $*" >&2; exit 1; }

mode="${1:-}"
[[ "$mode" == web-identity || "$mode" == chain ]] || die "usage: assume-aws-role.sh web-identity|chain"
[[ -n "${GITHUB_ENV:-}" ]] || die "GITHUB_ENV isn't set: this runs only in GitHub Actions"
role="${ROLE_ARN:-}"
# The ARN itself is never printed, even when it's wrong
[[ "$role" =~ ^arn:aws:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]+$ && ${#role} -le 2048 ]] || die "ROLE_ARN isn't an IAM role's ARN"
echo "::add-mask::${BASH_REMATCH[1]}"
[[ "${SESSION_NAME:-}" =~ ^[A-Za-z0-9+=,.@-]{2,64}$ ]] || die "SESSION_NAME isn't a valid role session name"
[[ "${AWS_REGION:-}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION isn't a region"
duration=()
if [[ -n "${DURATION:-}" ]]; then
  [[ "$DURATION" =~ ^[0-9]{3,5}$ ]] || die "DURATION isn't a number of seconds"
  duration=(--duration-seconds "$DURATION")
fi

tmp="$(umask 077 && mktemp -d "${RUNNER_TEMP:-/tmp}/assume-role.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

if [[ "$mode" == web-identity ]]; then
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] || die "no OIDC token: the job needs the id-token: write permission"
  # The request token goes in a header file, not on the command line
  printf 'Authorization: bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" > "$tmp/header"
  curl -fsS --retry 3 --max-time 30 -H "@$tmp/header" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" > "$tmp/oidc.json" 2> "$tmp/curl.err" \
    || die "couldn't get the job's OIDC token from GitHub"
  token="$(jq -r '.value // empty' "$tmp/oidc.json")"
  [[ -n "$token" ]] || die "GitHub's OIDC token response had no token"
  echo "::add-mask::$token"
  printf '%s' "$token" > "$tmp/token"
  call=(sts assume-role-with-web-identity --web-identity-token "file://$tmp/token")
else
  call=(sts assume-role)
fi

ok=false
for attempt in 1 2 3; do
  if aws "${call[@]}" --role-arn "$role" --role-session-name "$SESSION_NAME" ${duration[@]+"${duration[@]}"} \
      --region "$AWS_REGION" --output json > "$tmp/out.json" 2> "$tmp/err"; then
    ok=true
    break
  fi
  # Retrying is pointless for a refusal
  if grep -qE 'AccessDenied|InvalidIdentityToken|ValidationError|MalformedPolicyDocument' "$tmp/err"; then break; fi
  if [[ "$attempt" -lt 3 ]]; then sleep $((attempt * ${RETRY_DELAY:-3})); fi
done
if [[ "$ok" != true ]]; then
  code="$(grep -oE 'An error occurred \([A-Za-z]+\)' "$tmp/err" | head -1 | grep -oE '\([A-Za-z]+\)' | tr -d '()' || true)"
  die "couldn't assume the role (${code:-no error code from STS})"
fi

field() { jq -r "$1 // empty" "$tmp/out.json"; }
key_id="$(field .Credentials.AccessKeyId)"
secret="$(field .Credentials.SecretAccessKey)"
session="$(field .Credentials.SessionToken)"
role_id="$(field .AssumedRoleUser.AssumedRoleId)"
assumed_arn="$(field .AssumedRoleUser.Arn)"
for v in "$key_id" "$secret" "$session" "$role_id" "${role_id%%:*}" "$assumed_arn"; do
  if [[ -n "$v" ]]; then echo "::add-mask::$v"; fi
done
[[ -n "$key_id" && -n "$secret" && -n "$session" ]] || die "STS's answer had no credentials"
# One line each, so nothing can add another variable to $GITHUB_ENV
for v in "$key_id" "$secret" "$session"; do
  [[ "$v" =~ ^[A-Za-z0-9+/=]+$ ]] || die "STS's credentials have unexpected characters"
done
{
  echo "AWS_ACCESS_KEY_ID=$key_id"
  echo "AWS_SECRET_ACCESS_KEY=$secret"
  echo "AWS_SESSION_TOKEN=$session"
  echo "AWS_REGION=$AWS_REGION"
  echo "AWS_DEFAULT_REGION=$AWS_REGION"
} >> "$GITHUB_ENV"
echo "Signed in to AWS as the role (session $SESSION_NAME, $AWS_REGION)"
