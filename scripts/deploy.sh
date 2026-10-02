#!/usr/bin/env bash
# Deploys the api and web stacks and publishes the web app, from the main checkout
# (supply-checkout-7ew7). The commands in docs/infrastructure.md and docs/web-app.md, in one
# place and in the right order.
#
#   npm run deploy -- api            the api, realtime and observability stacks
#   npm run deploy -- web            the web stack, then check the live router
#   npm run deploy -- app            build the web app, publish it to app., check the router
#   npm run deploy -- all            web, then api, then app (the order they depend on)
#
# Options: --env <name> (default prod), --profile <AWS profile> (default supply-prod),
# --yes (don't ask before each deploy; CDK still asks about IAM and security group changes).
#
# It deploys only from main, with nothing uncommitted and nothing unpushed or unpulled, so
# what goes out is what's on origin/main. It signs in to AWS SSO if the session has expired,
# installs dependencies, shows each stack's diff and asks before deploying it. Stacks are
# chosen by kind (`supply-checkout-<env>-*-api`), so no region is named here; the kinds come
# from scripts/deploy-stacks.mjs, which the release pipeline (.github/workflows/deploy.yml)
# uses too. Until the backup setup has made /supply-checkout/<env>/backup/copy-vault-arn, it
# passes `-c backupCopy=false` (docs/backups.md). Only the owner deploys to prod (CLAUDE.md);
# this is the break-glass path once the pipeline deploys releases.
set -euo pipefail

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

env_name=prod
profile=supply-prod
yes=false
targets=()
while (($#)); do
  case "$1" in
    --env) env_name="${2:?--env needs a name}"; shift 2 ;;
    --profile) profile="${2:?--profile needs a name}"; shift 2 ;;
    --yes) yes=true; shift ;;
    -h|--help) usage 0 ;;
    api|web|app) targets+=("$1"); shift ;;
    all) targets+=(web api app); shift ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done
((${#targets[@]})) || usage

# Each target once, in dependency order: web (the router and RUM parameters the api's
# alarms and the app's config read), api, then app
ordered=()
for t in web api app; do
  for want in "${targets[@]}"; do [[ "$want" == "$t" ]] && { ordered+=("$t"); break; }; done
done

root="$(git rev-parse --show-toplevel)"
cd "$root"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
confirm() {
  $yes && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

# --- what goes out is origin/main --------------------------------------------
say "Checking the checkout"
branch="$(git branch --show-current)"
if [[ "$branch" != main ]]; then echo "Deploy from main, not $branch." >&2; exit 1; fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then echo "Commit or discard your changes first: git status" >&2; exit 1; fi
git fetch -q origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "main isn't origin/main: run git pull (and push nothing to main by hand)." >&2
  exit 1
fi
echo "Deploying $(git log -1 --format='%h %s') to $env_name as $profile: ${ordered[*]}"

# --- AWS sign-in ----------------------------------------------------------------
say "Checking the AWS session"
if ! aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1; then
  aws sso login --profile "$profile"
fi

# --- dependencies ---------------------------------------------------------------
installed=""
install() { # each folder once per run
  [[ " $installed " == *" $1 "* ]] && return 0
  say "Installing dependencies in $1"
  (cd "$root/$1" && npm ci --no-audit --no-fund --loglevel=error)
  installed+=" $1"
}

# --- CDK --------------------------------------------------------------------------
cdk_context=(-c "envName=$env_name")
if ! aws ssm get-parameter --profile "$profile" --name "/supply-checkout/$env_name/backup/copy-vault-arn" >/dev/null 2>&1; then
  cdk_context+=(-c backupCopy=false)
fi

# Shows the diff for the stacks, asks, and deploys only them (not the stacks they depend on).
# Sets `deployed`; a failed diff or deploy stops the script (set -e).
deployed=false
deploy_stacks() {
  deployed=false
  install backend
  install infra
  say "Changes to ${*}"
  (cd "$root/infra" && npx cdk diff "$@" --profile "$profile" "${cdk_context[@]}")
  if ! confirm "Deploy ${*}?"; then echo "Skipped."; return 0; fi
  (cd "$root/infra" && npx cdk deploy "$@" --exclusively --require-approval broadening --profile "$profile" "${cdk_context[@]}")
  deployed=true
}

check_router() {
  say "Checking the live router"
  npm run -s publish:web -- check-router --env "$env_name" --profile "$profile"
}

# A group's stack patterns, from the module the deploy workflow uses too, into `stacks`
stacks=()
group_stacks() {
  local out
  out="$(node "$root/scripts/deploy-stacks.mjs" "$1" --env "$env_name")"
  read -r -a stacks <<< "$out"
}

for target in "${ordered[@]}"; do
  case "$target" in
    web)
      group_stacks web
      deploy_stacks "${stacks[@]}"
      if $deployed; then check_router; fi
      ;;
    api)
      group_stacks stateless
      deploy_stacks "${stacks[@]}"
      ;;
    app)
      install .
      say "Building the web app"
      npm run -s build:web
      if confirm "Publish this build to app. in $env_name and make it live?"; then
        npm run -s publish:web -- publish --channel app --dir dist/web --env "$env_name" --profile "$profile"
        check_router
      else
        echo "Skipped."
      fi
      ;;
  esac
done

say "Done: ${ordered[*]}"
