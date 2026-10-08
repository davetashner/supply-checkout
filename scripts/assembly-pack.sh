#!/usr/bin/env bash
# Carries a cloud assembly from the deploy workflow's synth job, which runs the release commit's
# code with no AWS access and no OIDC token, to its plan job, which holds the production OIDC
# token and runs none of it (supply-checkout-pbp.39). Artifacts of a public repository are public,
# and the assembly names the account in nearly every ARN, so the account ID is swapped for a
# placeholder on the way out and put back on the way in. The swap is exact both ways, so the
# unpacked assembly is byte for byte what the synth wrote, and scripts/assembly-hash.sh gives the
# same hash for it as for an apply job's own synth.
#
#   bash scripts/assembly-pack.sh pack   <cdk.out> <out dir> <account ID>
#   bash scripts/assembly-pack.sh unpack <packed dir> <new cdk.out> <account ID>
#
# pack    copies the assembly's top-level files (templates, asset manifests, manifest.json and the
#         rest; not the asset folders: cdk diff --method template reads none of them) to <out dir>
#         with the account ID replaced. It refuses an assembly that already holds the placeholder,
#         one whose top-level entries aren't plain files or folders with plain names, and a packed
#         copy where any 12-digit number is still standing alone (another account's ID, say),
#         since that would be public.
# unpack  is for the plan job, so it treats the packed files as untrusted data: it refuses
#         anything but plain files with plain names (a manifest.json among them) and files that
#         already hold the account ID, and writes <new cdk.out> with the placeholder replaced.
#
# Prints nothing that names the account.
set -euo pipefail

PLACEHOLDER="__SUPPLY_CHECKOUT_DEPLOY_ACCOUNT__"
die() { echo "assembly-pack: $*" >&2; exit 1; }

mode="${1:-}"
src="${2:-}"
dest="${3:-}"
account="${4:-}"
if [[ ! ( "$mode" == pack || "$mode" == unpack ) || -z "$src" || -z "$dest" ]]; then
  die "usage: assembly-pack.sh pack|unpack <from> <to> <account ID>"
fi
[[ "$account" =~ ^[0-9]{12}$ ]] || die "the account ID isn't 12 digits"
[[ -d "$src" ]] || die "no folder $src"
[[ ! -e "$dest" ]] || die "$dest already exists"

name_ok() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$ ]]; }

if [[ "$mode" == pack ]]; then
  [[ -f "$src/manifest.json" ]] || die "no manifest.json in $src"
  mkdir -p "$dest"
  for path in "$src"/* "$src"/.[!.]*; do
    [[ -e "$path" || -L "$path" ]] || continue
    name="${path##*/}"
    name_ok "$name" || die "unexpected name in the assembly: $name"
    if [[ -L "$path" ]]; then die "the assembly has a symbolic link: $name"; fi
    if [[ -d "$path" ]]; then continue; fi
    [[ -f "$path" ]] || die "the assembly has something that isn't a file or folder: $name"
    if grep -qF "$PLACEHOLDER" "$path"; then die "$name already holds the placeholder"; fi
    sed "s/$account/$PLACEHOLDER/g" "$path" > "$dest/$name"
    if grep -qF "$account" "$dest/$name"; then die "$name still names the account"; fi
    # A 12-digit number standing alone looks like an account ID (hashes are hex, so their digit
    # runs sit between letters); none may reach a public artifact
    if grep -qE '(^|[^0-9A-Za-z])[0-9]{12}([^0-9A-Za-z]|$)' "$dest/$name"; then
      die "$name holds another 12-digit number that looks like an account ID; it can't be uploaded"
    fi
  done
  echo "Packed $(find "$dest" -type f | wc -l | tr -d ' ') files, the account ID replaced"
  exit 0
fi

# unpack
[[ -f "$src/manifest.json" && ! -L "$src/manifest.json" ]] || die "no manifest.json in $src"
mkdir -p "$dest"
for path in "$src"/* "$src"/.[!.]*; do
  [[ -e "$path" || -L "$path" ]] || continue
  name="${path##*/}"
  name_ok "$name" || die "unexpected name in the packed assembly: $name"
  [[ -f "$path" && ! -L "$path" ]] || die "the packed assembly has something that isn't a plain file: $name"
  if grep -qF "$account" "$path"; then die "$name already names the account: not something pack made"; fi
  sed "s/$PLACEHOLDER/$account/g" "$path" > "$dest/$name"
done
echo "Unpacked $(find "$dest" -type f | wc -l | tr -d ' ') files"
