#!/usr/bin/env bash
# Fetches lust, the checker and compiler recipe_run uses: lust-lang's release package of the version in
# tools/lust/LUST_VERSION for this host, checked against the sha256 pinned in tools/lust/LUST_SHA256 and against the
# .sha256 file the release carries, then unpacked. Nothing is built: no Rust toolchain, no C compiler, no tinycc build.
# Usage: tools/lust/install.sh [dir]   (default ~/.lime-slice/lust-<version>). Prints the lust binary's path last;
#        its package folder (two levels up) is what tools/lust/stage.sh takes.
# Hosts: the three lust-lang packages: Windows x86_64 (Git Bash), Linux x86_64, macOS arm64. Intel macOS has none, so
# the Intel dmg ships without lust.
# A new lust: tools/lust/pin.sh <version> writes LUST_VERSION and LUST_SHA256 from that release.
# A lust of your own (an unreleased commit): build it there and name its binary in LIME_LUST; nothing here is needed.
# LUST_RELEASE_BASE names another place for the packages (a mirror, or file:///… for a package built locally), with
# the same v<version>/<package> layout as https://github.com/cristy-the-one/lust-lang/releases/download.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
version=$(tr -d '[:space:]' < "$here/LUST_VERSION")
case "$(uname -s)-$(uname -m)" in
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) key=x86_64-windows ext=zip exe=.exe ;;
  Linux-x86_64) key=x86_64-linux ext=tar.gz exe="" ;;
  Darwin-arm64) key=aarch64-macos ext=tar.gz exe="" ;;
  *) echo "install.sh: lust-lang has no release package for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
name="lust-$version-$key"
want=$(awk -v k="$key" '$1 == k { print $2 }' "$here/LUST_SHA256")
[ -n "$want" ] || { echo "install.sh: tools/lust/LUST_SHA256 has no line for $key (tools/lust/pin.sh $version writes it)" >&2; exit 1; }
dest=${1:-$HOME/.lime-slice/lust-$version}
lust="$dest/$name/bin/lust$exe"
# Under Git Bash the path printed is a Windows one (C:/...), which node and the workflows can open.
out() { if command -v cygpath > /dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
if [ -f "$lust" ] && [ -f "$dest/$name/.sha256-ok" ] && [ "$(cat "$dest/$name/.sha256-ok")" = "$want" ]; then
  out "$lust"
  exit 0
fi
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1 | tr -dc '0-9a-f'; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
base=${LUST_RELEASE_BASE:-https://github.com/cristy-the-one/lust-lang/releases/download}
mkdir -p "$dest"
archive="$dest/$name.$ext"
if [ ! -f "$archive" ] || [ "$(sha256 "$archive")" != "$want" ]; then
  curl -fsSL --retry 5 --retry-delay 5 -o "$archive.part" "$base/v$version/$name.$ext"
  mv "$archive.part" "$archive"
fi
got=$(sha256 "$archive")
if [ "$got" != "$want" ]; then
  echo "install.sh: $name.$ext has sha256 $got, tools/lust/LUST_SHA256 pins $want" >&2
  rm -f "$archive"
  exit 1
fi
# The release's own .sha256 must name the same package: a pin copied from another version or platform fails here.
curl -fsSL --retry 5 --retry-delay 5 -o "$archive.sha256" "$base/v$version/$name.$ext.sha256"
theirs=$(tr -d '\r' < "$archive.sha256" | awk -v f="$name.$ext" '$2 == f || $2 == "*" f { print $1 }')
if [ "$theirs" != "$want" ]; then
  echo "install.sh: the release's $name.$ext.sha256 says '${theirs:-nothing for that file}', tools/lust/LUST_SHA256 pins $want" >&2
  exit 1
fi
rm -rf "${dest:?}/$name"
case "$ext" in
  zip)
    # Git Bash's tar cannot read a zip; Windows' own bsdtar can.
    if command -v unzip > /dev/null; then unzip -q "$archive" -d "$dest"; else "$SYSTEMROOT/System32/tar.exe" -xf "$(cygpath -w "$archive")" -C "$(cygpath -w "$dest")"; fi
    ;;
  *) tar -xzf "$archive" -C "$dest" ;;
esac
for f in "bin/lust$exe" "bin/lust-core$exe" "lib/lust/tcc/bin/tcc$exe" "lib/lust/tcc/lib/tcc/libtcc1.a" "lib/lust/library" LICENSE tcc-COPYING; do
  [ -e "$dest/$name/$f" ] || { echo "install.sh: $archive did not unpack $name/$f" >&2; exit 1; }
done
chmod 755 "$dest/$name/bin/lust$exe" "$dest/$name/bin/lust-core$exe" "$dest/$name/lib/lust/tcc/bin/tcc$exe"
# The package says which lust it is: `lust --version` must name the pinned version.
said=$("$lust" --version)
case "$said" in
  *"$version"*) ;;
  *) echo "install.sh: $name answers '$said', not version $version" >&2; exit 1 ;;
esac
echo "$said" >&2
echo "$want" > "$dest/$name/.sha256-ok"
out "$lust"
