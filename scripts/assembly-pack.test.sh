#!/usr/bin/env bash
# Tests for scripts/assembly-pack.sh, run with: npm run test:scripts
# check() evals its condition later, so its single-quoted $rc, $out and paths are meant.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
account=123456789012 # public-safety: allow (a fake ID)

failures=0
out="" rc=0
run() { # pack|unpack, from, to, [account]
  set +e
  out="$(bash "$here/assembly-pack.sh" "$1" "$2" "$3" "${4:-$account}" 2>&1)"
  rc=$?
  set -e
}
check() { # name, description, condition
  if eval "$3"; then return 0; fi
  failures=$((failures + 1))
  printf 'FAIL %s: %s\n--- output\n%s\n' "$1" "$2" "$out"
}
asm() { # a small assembly naming the account, with an asset folder
  mkdir -p "$1/asset.abc"
  printf '{"version":"1","artifacts":{"s":{"environment":"aws://%s/us-east-1"}}}' "$account" > "$1/manifest.json"
  printf '{"Resources":{"R":{"Arn":"arn:aws:iam::%s:role/x","Hash":"a%sb"}}}' "$account" "$account" > "$1/s.template.json"
  printf '{"files":{"f":{"destinations":{"d":{"bucketName":"cdk-x-assets-%s-us-east-1"}}}}}' "$account" > "$1/s.assets.json"
  printf '{"version":"1"}' > "$1/cdk.out"
  printf 'code' > "$1/asset.abc/index.js"
}

asm "$tmp/a"
run pack "$tmp/a" "$tmp/a.packed"
check round-trip "packs" '[[ $rc == 0 && "$out" == *"Packed 4 files"* ]]'
check round-trip "the packed files don't name the account, and the asset folder stays behind" '! grep -rq "$account" "$tmp/a.packed" && grep -q __SUPPLY_CHECKOUT_DEPLOY_ACCOUNT__ "$tmp/a.packed/manifest.json" && [[ ! -e "$tmp/a.packed/asset.abc" ]]'
check round-trip "prints nothing that names the account" '[[ "$out" != *"$account"* ]]'
run unpack "$tmp/a.packed" "$tmp/a.out"
check round-trip "unpacks to the same bytes and the same hash" '[[ $rc == 0 ]] && for f in manifest.json s.template.json s.assets.json cdk.out; do cmp -s "$tmp/a/$f" "$tmp/a.out/$f" || exit 1; done && [[ "$(bash "$here/assembly-hash.sh" "$tmp/a")" == "$(bash "$here/assembly-hash.sh" "$tmp/a.out")" ]]'
run unpack "$tmp/a.packed" "$tmp/a.other" 210987654321 # public-safety: allow (a fake ID)
check round-trip "unpacking for another account gives another hash" '[[ $rc == 0 && "$(bash "$here/assembly-hash.sh" "$tmp/a")" != "$(bash "$here/assembly-hash.sh" "$tmp/a.other")" ]]'
run unpack "$tmp/a.packed" "$tmp/a.out"
check round-trip "refuses to write over a folder" '[[ $rc == 1 && "$out" == *"already exists"* ]]'

run pack "$tmp/a" "$tmp/x" 12345
check args "refuses an account ID that isn't 12 digits" '[[ $rc == 1 && "$out" == *"isn'"'"'t 12 digits"* ]]'
run pack "$tmp/missing" "$tmp/x"
check args "refuses a missing folder" '[[ $rc == 1 && "$out" == *"no folder"* ]]'
mkdir -p "$tmp/empty"
run pack "$tmp/empty" "$tmp/x"
check args "refuses an assembly without manifest.json" '[[ $rc == 1 && "$out" == *"no manifest.json"* ]]'

asm "$tmp/b"; printf '{"x":"__SUPPLY_CHECKOUT_DEPLOY_ACCOUNT__"}' > "$tmp/b/s.template.json"
run pack "$tmp/b" "$tmp/b.packed"
check placeholder "refuses an assembly that already holds the placeholder" '[[ $rc == 1 && "$out" == *"already holds the placeholder"* ]]'

asm "$tmp/c"; printf '{"Principal":"arn:aws:iam::210987654321:root"}' > "$tmp/c/s.template.json" # public-safety: allow (a fake ID)
run pack "$tmp/c" "$tmp/c.packed"
check other-account "refuses another 12-digit number standing alone" '[[ $rc == 1 && "$out" == *"another 12-digit number"* && "$out" != *210987654321* ]]' # public-safety: allow (a fake ID)

asm "$tmp/d"; ln -s manifest.json "$tmp/d/link.json"
run pack "$tmp/d" "$tmp/d.packed"
check symlink "pack refuses a symbolic link" '[[ $rc == 1 && "$out" == *"symbolic link"* ]]'

asm "$tmp/e"; run pack "$tmp/e" "$tmp/e.packed"; printf '{"arn":"%s"}' "$account" > "$tmp/e.packed/s.template.json"
run unpack "$tmp/e.packed" "$tmp/e.out"
check unpack "refuses a packed file that already names the account" '[[ $rc == 1 && "$out" == *"already names the account"* && "$out" != *"$account"* ]]'

asm "$tmp/f"; run pack "$tmp/f" "$tmp/f.packed"; mkdir "$tmp/f.packed/sub"
run unpack "$tmp/f.packed" "$tmp/f.out"
check unpack "refuses a folder in the packed assembly" '[[ $rc == 1 && "$out" == *"isn'"'"'t a plain file: sub"* ]]'

asm "$tmp/g"; run pack "$tmp/g" "$tmp/g.packed"; ln -s /etc/passwd "$tmp/g.packed/s.template.json.link"
run unpack "$tmp/g.packed" "$tmp/g.out"
check unpack "refuses a symbolic link in the packed assembly" '[[ $rc == 1 && "$out" == *"isn'"'"'t a plain file"* ]]'

asm "$tmp/h"; run pack "$tmp/h" "$tmp/h.packed"; printf '{}' > "$tmp/h.packed/-n"
run unpack "$tmp/h.packed" "$tmp/h.out"
check unpack "refuses an unexpected file name" '[[ $rc == 1 && "$out" == *"unexpected name"* ]]'

asm "$tmp/i"; run pack "$tmp/i" "$tmp/i.packed"; rm "$tmp/i.packed/manifest.json"
run unpack "$tmp/i.packed" "$tmp/i.out"
check unpack "refuses a packed assembly without manifest.json" '[[ $rc == 1 && "$out" == *"no manifest.json"* ]]'

if ((failures)); then
  echo "assembly-pack.test.sh: $failures failed"
  exit 1
fi
echo "assembly-pack.test.sh: all passed"
