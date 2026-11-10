#!/usr/bin/env bash
# Lays lust's release package (tools/lust/install.sh) out for the installers, beside the MCP server.
# Usage: tools/lust/stage.sh <package folder> <dest> [zig]
#   <package folder>  the unpacked lust-<version>-<platform> folder: two levels up from the binary install.sh prints
#   <dest>            the installers use src-tauri/resources/mcp/lust
#   [zig]             the folder tools/lust/zig.sh prints
#
# The package already has the layout lust runs from (it finds lib/lust from its own executable, so nothing has to be
# set at run time), and it is copied as it is. This adds zig and the licence names the installers carry:
#   bin/lust, bin/lust-core            the client recipe_run calls and the compiler daemon it starts
#   lib/lust/tcc/bin/tcc               the pinned tinycc, for parallel `tcc -c` (libtcc is linked into lust-core)
#   lib/lust/tcc/lib/tcc/              libtcc1.a and tcc's headers (Windows: also the import .def files)
#   lib/lust/library/                  std and adapter sources lust reads at run time
#   zig/zig, zig/lib/                  zig cc for the optimised builds, when [zig] is given (see the end)
#   LICENSE-lust, COPYING-tinycc, LICENSE-mimalloc, LICENSE-zig, SOURCES.txt
set -euo pipefail
src=${1:?usage: stage.sh <package folder> <dest> [zig]}
dest=${2:?usage: stage.sh <package folder> <dest> [zig]}
zig=${3:-}
here=$(cd "$(dirname "$0")" && pwd)
exe=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe" ;; esac
for f in "bin/lust$exe" "bin/lust-core$exe" "lib/lust/tcc/bin/tcc$exe" "lib/lust/tcc/lib/tcc/libtcc1.a" "lib/lust/library" LICENSE tcc-COPYING mimalloc-LICENSE; do
  [ -e "$src/$f" ] || { echo "stage.sh: $src/$f is missing (is $src the folder tools/lust/install.sh unpacked?)" >&2; exit 1; }
done
version=$(tr -d '[:space:]' < "$here/LUST_VERSION")
package=$(basename "$src")
pinned=$(awk -v p="$package" 'index($3, p) == 1 { print $2 }' "$here/LUST_SHA256")
[ -n "$pinned" ] || { echo "stage.sh: tools/lust/LUST_SHA256 pins no package named $package" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$src/bin" "$src/lib" "$dest/"
chmod 755 "$dest/bin/lust$exe" "$dest/bin/lust-core$exe" "$dest/lib/lust/tcc/bin/tcc$exe"
cp "$src/LICENSE" "$dest/LICENSE-lust"
cp "$src/tcc-COPYING" "$dest/COPYING-tinycc"
cp "$src/mimalloc-LICENSE" "$dest/LICENSE-mimalloc"
{
  echo "lust $version, https://github.com/cristy-the-one/lust-lang (MIT, LICENSE-lust): its release package $package"
  echo "  of the tag v$version, sha256 $pinned (pinned in tools/lust/LUST_SHA256 of Lime Slice), as published, not rebuilt."
  echo "tinycc, https://github.com/TinyCC/tinycc (LGPL 2.1, COPYING-tinycc), at the commit lust-lang pins at that tag,"
  echo "  built by its scripts/build-tcc.sh (Linux, macOS) or scripts/build-tcc.ps1 (Windows, with its PE patch)."
  echo "  libtcc is linked into lust-core; relink it against another libtcc by rebuilding lust with LUST_TCC_HOME."
  echo "mimalloc, https://github.com/microsoft/mimalloc (MIT, LICENSE-mimalloc), linked into lust-core."
} > "$dest/SOURCES.txt"

# zig (tools/lust/zig.sh), for lust's optimised builds (`--opt=bg`): the zig binary and the part of its lib/ that
# `zig cc` reads for this host's own target. The libc sources and headers of other OS families, C++ (libcxx), the
# sanitizers and the docs go. The app and the MCP server find it at lust/zig/zig and fall back to tcc without it.
if [ -n "$zig" ]; then
  [ -f "$zig/zig$exe" ] || { echo "stage.sh: $zig/zig$exe is missing (run tools/lust/zig.sh first)" >&2; exit 1; }
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) keep_libc="mingw" keep_include="any-windows-any" ;;
    Darwin) keep_libc="darwin" keep_include="any-macos-any" ;;
    *) keep_libc="glibc" keep_include="generic-glibc any-linux-any x86-linux-any x86_64-linux-gnu" ;;
  esac
  mkdir -p "$dest/zig/lib/libc/include"
  cp "$zig/zig$exe" "$zig/LICENSE" "$dest/zig/"
  for f in "$zig"/lib/*; do
    case "$(basename "$f")" in libc|libcxx|libcxxabi|tsan|docs|init) continue ;; esac
    cp -r "$f" "$dest/zig/lib/"
  done
  for d in $keep_libc; do cp -r "$zig/lib/libc/$d" "$dest/zig/lib/libc/"; done
  for d in $keep_include; do cp -r "$zig/lib/libc/include/$d" "$dest/zig/lib/libc/include/"; done
  chmod 755 "$dest/zig/zig$exe"
  cp "$zig/LICENSE" "$dest/LICENSE-zig"
  {
    echo "zig $("$dest/zig/zig$exe" version), https://ziglang.org (MIT, LICENSE-zig), the official release for this host, sha256 in"
    echo "  Lime Slice's tools/lust/ZIG_SHA256; trimmed to this host's target by tools/lust/stage.sh. zig links LLVM, clang and"
    echo "  LLD (Apache 2.0 with LLVM exceptions). Its lib/ keeps their notices: zig/lib/libunwind/LICENSE.TXT, and the libc"
    echo "  it builds programs against: zig/lib/libc/mingw/COPYING (mingw-w64, Windows), zig/lib/libc/glibc/LICENSES (glibc,"
    echo "  LGPL 2.1, Linux), or Apple's libSystem stubs and headers (zig/lib/libc/darwin, macOS)."
  } >> "$dest/SOURCES.txt"
  # zig cc must answer from the staged copy alone.
  "$dest/zig/zig$exe" version > /dev/null
fi
"$dest/bin/lust$exe" --version >&2
du -sh "$dest" >&2
[ -z "$zig" ] || du -sh "$dest/zig" >&2
