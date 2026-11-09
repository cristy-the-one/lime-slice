#!/usr/bin/env bash
# Fetches the official zig release in tools/lust/ZIG_VERSION for this host, checks it against the sha256 pinned in
# tools/lust/ZIG_SHA256 (ziglang.org's download/index.json values), and unpacks it. lust's `--opt` builds use `zig cc`
# (lust-lang docs/opt.md); tools/lust/stage.sh puts a trimmed copy beside the bundled lust (mcp/lust/zig).
# Usage: tools/lust/zig.sh [dir]   (default ~/.lime-slice/zig-<version>). Prints the unpacked folder (zig and lib/) last.
# Hosts: Windows x86_64 (Git Bash), Linux x86_64, macOS arm64 and x86_64.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
version=$(tr -d '[:space:]' < "$here/ZIG_VERSION")
case "$(uname -s)-$(uname -m)" in
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) key=x86_64-windows ext=zip exe=.exe ;;
  Linux-x86_64) key=x86_64-linux ext=tar.xz exe="" ;;
  Darwin-arm64) key=aarch64-macos ext=tar.xz exe="" ;;
  Darwin-x86_64) key=x86_64-macos ext=tar.xz exe="" ;;
  *) echo "zig.sh: no pinned zig for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
name="zig-$key-$version"
want=$(awk -v k="$key" '$1 == k { print $2 }' "$here/ZIG_SHA256")
[ -n "$want" ] || { echo "zig.sh: tools/lust/ZIG_SHA256 has no line for $key" >&2; exit 1; }
dest=${1:-$HOME/.lime-slice/zig-$version}
if [ -f "$dest/$name/zig$exe" ] && [ -f "$dest/$name/.sha256-ok" ] && [ "$(cat "$dest/$name/.sha256-ok")" = "$want" ]; then
  echo "$dest/$name"
  exit 0
fi
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
mkdir -p "$dest"
archive="$dest/$name.$ext"
if [ ! -f "$archive" ] || [ "$(sha256 "$archive")" != "$want" ]; then
  curl -fsSL --retry 5 --retry-delay 5 -o "$archive.part" "https://ziglang.org/download/$version/$name.$ext"
  mv "$archive.part" "$archive"
fi
got=$(sha256 "$archive")
if [ "$got" != "$want" ]; then
  echo "zig.sh: $name.$ext has sha256 $got, tools/lust/ZIG_SHA256 pins $want" >&2
  rm -f "$archive"
  exit 1
fi
rm -rf "${dest:?}/$name"
case "$ext" in
  zip)
    # Git Bash's tar cannot read a zip; Windows' own bsdtar can.
    if command -v unzip > /dev/null; then unzip -q "$archive" -d "$dest"; else "$SYSTEMROOT/System32/tar.exe" -xf "$(cygpath -w "$archive")" -C "$(cygpath -w "$dest")"; fi
    ;;
  *) tar -xJf "$archive" -C "$dest" ;;
esac
[ -f "$dest/$name/zig$exe" ] || { echo "zig.sh: $archive did not unpack to $dest/$name" >&2; exit 1; }
echo "$want" > "$dest/$name/.sha256-ok"
"$dest/$name/zig$exe" version >&2
echo "$dest/$name"
