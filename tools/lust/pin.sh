#!/usr/bin/env bash
# Pins a lust-lang release: writes tools/lust/LUST_VERSION and tools/lust/LUST_SHA256 from the .sha256 files the
# release carries for its three packages (Windows x86_64, Linux x86_64, macOS arm64).
# Usage: tools/lust/pin.sh <version>   (0.3.0, not v0.3.0)
# Run it once when moving to a new lust, look at the diff, and commit both files. From then on install.sh takes only
# a package with these hashes, so a release whose assets are replaced later no longer installs.
# LUST_RELEASE_BASE names another place for the release, as in install.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
version=${1:?usage: pin.sh <version>}
version=${version#v}
base=${LUST_RELEASE_BASE:-https://github.com/cristy-the-one/lust-lang/releases/download}
tmp=$(mktemp)
trap 'rm -f "$tmp" "$tmp.one"' EXIT
for pair in x86_64-windows:zip x86_64-linux:tar.gz aarch64-macos:tar.gz; do
  key=${pair%%:*}
  file="lust-$version-$key.${pair##*:}"
  curl -fsSL --retry 5 --retry-delay 5 -o "$tmp.one" "$base/v$version/$file.sha256"
  hash=$(tr -d '\r' < "$tmp.one" | awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }')
  case "$hash" in
    *[!0-9a-f]*|"") echo "pin.sh: $file.sha256 has no sha256 for $file" >&2; exit 1 ;;
  esac
  [ ${#hash} = 64 ] || { echo "pin.sh: $file.sha256 has a hash of ${#hash} characters, not 64" >&2; exit 1; }
  echo "$key $hash $file" >> "$tmp"
done
printf '%s\n' "$version" > "$here/LUST_VERSION"
cp "$tmp" "$here/LUST_SHA256"
cat "$here/LUST_SHA256"
