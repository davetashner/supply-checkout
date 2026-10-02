#!/usr/bin/env bash
# Prints one hash of what a cloud assembly would deploy (the deploy workflow's plan/apply check,
# supply-checkout-pbp.27): its templates, asset manifests (the Lambda code's hashes) and
# manifest.json, each with its name. tree.json and *.metadata.json describe the constructs, not
# what deploys, so they're left out. Two synths of one commit into the same folder give the same
# hash (CI checks that); into folders at different depths they don't, because the Lambda source
# maps hold paths relative to the output, which is why every deploy job synthesizes into
# infra/cdk.out of a fresh checkout.
#
#   bash scripts/assembly-hash.sh <cdk.out directory>
set -euo pipefail
dir="${1:?usage: assembly-hash.sh <cdk.out directory>}"
cd "$dir"
[[ -f manifest.json ]] || { echo "assembly-hash: no manifest.json in $dir" >&2; exit 1; }
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
find . -maxdepth 1 -type f \( -name '*.template.json' -o -name '*.assets.json' -o -name manifest.json \) -print0 \
  | LC_ALL=C sort -z | xargs -0 "${sum[@]}" | "${sum[@]}" | cut -d' ' -f1
