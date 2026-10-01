#!/usr/bin/env bash
# Tests for scripts/deploy.sh, run with: npm run test:scripts
#
# Each case runs deploy.sh in a throwaway git repo (with a bare "origin") against fake `aws`,
# `npm` and `npx`, so nothing touches AWS. SHOW_ALL=1 prints every case's output.
#
# Scenario files, in $FAKE:
#   sts_fails     `aws sts get-caller-identity` fails (the SSO session expired)
#   vault         the backup copy vault's SSM parameter exists
#   deploy_fails  `npx cdk deploy` fails
#   calls         every aws, npm and npx call, appended by the fakes
#
# check() evals its condition later, so its single-quoted $rc, $out and $calls are meant.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/deploy.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# Empty emails: this repo is public and its pre-commit hook rejects any address
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=

# --- fakes -------------------------------------------------------------------
mkdir -p "$tmp/bin"
cat > "$tmp/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE/calls"
case "$1 $2" in
  "sts get-caller-identity") [[ -e "$FAKE/sts_fails" ]] && exit 255; exit 0 ;;
  "sso login") exit 0 ;;
  "ssm get-parameter") [[ -e "$FAKE/vault" ]] && exit 0; exit 254 ;;
  *) echo "fake aws: unexpected: aws $*" >&2; exit 2 ;;
esac
FAKE
cat > "$tmp/bin/npm" <<'FAKE'
#!/usr/bin/env bash
echo "npm $* (in $(basename "$PWD"))" >> "$FAKE/calls"
FAKE
cat > "$tmp/bin/npx" <<'FAKE'
#!/usr/bin/env bash
echo "npx $* (in $(basename "$PWD"))" >> "$FAKE/calls"
[[ "$2" == deploy && -e "$FAKE/deploy_fails" ]] && exit 1
exit 0
FAKE
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# --- a checkout -----------------------------------------------------------------
new_repo() {
  rm -rf "$tmp/origin.git" "$tmp/repo"
  git init -q --bare -b main "$tmp/origin.git"
  git init -q -b main "$tmp/repo"
  mkdir -p "$tmp/repo/scripts" "$tmp/repo/backend" "$tmp/repo/infra"
  cp "$script" "$here/deploy-stacks.mjs" "$here/publish-web.mjs" "$tmp/repo/scripts/"
  (cd "$tmp/repo" && git add -A && git commit -qm init && git remote add origin "$tmp/origin.git" && git push -q origin main)
}

failures=0
run_case() { # name, answers on stdin, deploy.sh args...
  local name="$1"; shift
  export FAKE="$tmp/fake-$name"
  mkdir -p "$FAKE"
  : > "$FAKE/calls"
  set +e
  out="$(cd "$tmp/repo" && bash scripts/deploy.sh "$@" 2>&1 < "$FAKE/stdin")"
  rc=$?
  set -e
  calls="$(cat "$FAKE/calls")"
}
answers() { mkdir -p "$tmp/fake-$1"; printf '%s' "$2" > "$tmp/fake-$1/stdin"; }
check() { # name, description, condition
  if eval "$3"; then
    [[ -n "${SHOW_ALL:-}" ]] && printf 'ok   %s: %s\n%s\n' "$1" "$2" "$out"
    return 0
  fi
  failures=$((failures + 1))
  printf 'FAIL %s: %s\n--- output\n%s\n--- calls\n%s\n' "$1" "$2" "$out" "$calls"
}
has() { grep -qF -- "$1" <<< "$calls"; }
count() { grep -cF -- "$1" <<< "$calls" || true; }

new_repo

answers usage ""
run_case usage
check usage "no target shows the usage" '[[ $rc == 2 && "$out" == *"npm run deploy -- api"* ]]'

answers unknown ""
run_case unknown frobnicate
check unknown "an unknown target is refused" '[[ $rc == 2 && "$out" == *"Unknown argument: frobnicate"* ]]'

answers branch ""
(cd "$tmp/repo" && git switch -q -c feature)
run_case branch api --yes
(cd "$tmp/repo" && git switch -q main && git branch -q -D feature)
check branch "refuses another branch, before AWS" '[[ $rc == 1 && "$out" == *"Deploy from main, not feature."* && -z "$calls" ]]'

answers dirty ""
echo change >> "$tmp/repo/scripts/deploy.sh"
run_case dirty api --yes
(cd "$tmp/repo" && git checkout -q -- scripts/deploy.sh)
check dirty "refuses uncommitted changes" '[[ $rc == 1 && "$out" == *"Commit or discard"* && -z "$calls" ]]'

answers unpushed ""
(cd "$tmp/repo" && git commit -q --allow-empty -m local)
run_case unpushed api --yes
(cd "$tmp/repo" && git reset -q --hard origin/main)
check unpushed "refuses a main that isn't origin/main" '[[ $rc == 1 && "$out" == *"main isn'"'"'t origin/main"* && -z "$calls" ]]'

answers all ""
run_case all all app api --yes
check all "deploys web, then api, realtime and observability, then publishes the app, each once" '[[ $rc == 0 ]] && [[ "$(grep -E "cdk deploy|publish --channel" <<< "$calls" | sed -E "s/ --exclusively.*//; s/ --dir.*//")" == "npx cdk deploy supply-checkout-prod-*-web
npx cdk deploy supply-checkout-prod-*-api supply-checkout-prod-*-realtime supply-checkout-prod-*-observability
npm run -s publish:web -- publish --channel app" ]]'
check all "deploys only the named stacks, asking CDK about IAM, with backupCopy=false while there's no copy vault" 'has "--exclusively --require-approval broadening --profile supply-prod -c envName=prod -c backupCopy=false"'
check all "installs each folder's dependencies once" '[[ $(count "npm ci --no-audit --no-fund --loglevel=error (in backend)") == 1 && $(count "(in infra)") -ge 1 && $(count "npm ci --no-audit --no-fund --loglevel=error (in infra)") == 1 && $(count "npm ci --no-audit --no-fund --loglevel=error (in repo)") == 1 ]]'
check all "checks the router after the web stack and after publishing" '[[ $(count "publish:web -- check-router --env prod --profile supply-prod") == 2 ]]'
check all "builds the web app before publishing it" 'has "npm run -s build:web (in repo)"'
check all "doesn't sign in when the session is live" '! has "sso login"'

answers vault ""
touch "$tmp/fake-vault/vault"; touch "$tmp/fake-vault/sts_fails"
run_case vault api --env staging --profile supply-staging --yes
check vault "signs in when the session expired, and drops backupCopy=false once the vault exists" 'has "aws sso login --profile supply-staging" && has "-c envName=staging (in infra)" && ! has "backupCopy" && has "cdk deploy supply-checkout-staging-*-api"'

answers declined $'n\nn\n'
run_case declined web app
check declined "deploys and publishes nothing it's told no to, and checks no router" '[[ $rc == 0 ]] && has "cdk diff supply-checkout-prod-*-web" && ! has "cdk deploy" && ! has "publish --channel" && ! has "check-router"'

answers asked $'y\n'
run_case asked api
check asked "deploys when told yes" '[[ $rc == 0 ]] && has "cdk deploy supply-checkout-prod-*-api"'

answers failed ""
touch "$tmp/fake-failed/deploy_fails"
run_case failed web api --yes
check failed "stops at a failed deploy" '[[ $rc != 0 ]] && [[ $(count "cdk deploy") == 1 ]] && ! has "check-router" && ! has "*-api"'

if ((failures)); then echo "$failures deploy.sh check(s) failed"; exit 1; fi
echo "deploy.sh: all checks passed"
