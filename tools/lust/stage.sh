#!/usr/bin/env bash
# Lays a lust build (tools/lust/install.sh) out for the installers, beside the MCP server.
# Usage: tools/lust/stage.sh <lust checkout> <dest> [zig]   (the installers use src-tauri/resources/mcp/lust, and the
# folder tools/lust/zig.sh prints as [zig])
#
# The layout is lust's own release package (lust-lang scripts/release.sh). lust finds lib/lust from its own
# executable, so nothing has to be set at run time:
#   bin/lust, bin/lust-core            the client recipe_run calls and the compiler daemon it starts
#   lib/lust/tcc/bin/tcc               the pinned tinycc, for parallel `tcc -c` (libtcc is linked into lust-core)
#   lib/lust/tcc/lib/tcc/              libtcc1.a and tcc's headers (Windows: also the import .def files)
#   lib/lust/library/                  std and adapter sources lust reads at run time
#   zig/zig, zig/lib/                  zig cc for the optimised builds, when [zig] is given (see the end)
#   LICENSE-lust, COPYING-tinycc, LICENSE-mimalloc, LICENSE-zig, SOURCES.txt
set -euo pipefail
src=${1:?usage: stage.sh <lust checkout> <dest> [zig]}
dest=${2:?usage: stage.sh <lust checkout> <dest> [zig]}
zig=${3:-}
exe=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe" ;; esac
tcc=$src/third_party/tcc
for f in "$src/target/release/lust$exe" "$src/target/release/lust-core$exe" "$tcc/bin/tcc$exe" "$tcc/lib/tcc/libtcc1.a" "$src/third_party/tinycc/COPYING"; do
  [ -f "$f" ] || { echo "stage.sh: $f is missing (run tools/lust/install.sh first)" >&2; exit 1; }
done
mimalloc_version=$(grep -A1 '^name = "libmimalloc-sys"' "$src/Cargo.lock" | sed -n 's/^version = "\(.*\)"$/\1/p')
mimalloc_license=$(ls "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"libmimalloc-sys-$mimalloc_version/LICENSE.txt" 2>/dev/null | head -n 1 || true)
[ -n "$mimalloc_license" ] || { echo "stage.sh: libmimalloc-sys $mimalloc_version's LICENSE.txt is not in the cargo registry" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest/bin" "$dest/lib/lust/tcc/bin" "$dest/lib/lust/tcc/lib"
cp "$src/target/release/lust$exe" "$src/target/release/lust-core$exe" "$dest/bin/"
cp "$tcc/bin/tcc$exe" "$dest/lib/lust/tcc/bin/"
cp -r "$tcc/lib/tcc" "$dest/lib/lust/tcc/lib/"
cp -r "$src/library" "$dest/lib/lust/library"
chmod 755 "$dest/bin/lust$exe" "$dest/bin/lust-core$exe" "$dest/lib/lust/tcc/bin/tcc$exe"
cp "$src/LICENSE" "$dest/LICENSE-lust"
cp "$src/third_party/tinycc/COPYING" "$dest/COPYING-tinycc"
cp "$mimalloc_license" "$dest/LICENSE-mimalloc"
{
  echo "lust $(git -C "$src" rev-parse HEAD), https://github.com/cristy-the-one/lust-lang (MIT, LICENSE-lust)."
  echo "tinycc $(git -C "$src/third_party/tinycc" rev-parse HEAD), https://github.com/TinyCC/tinycc (LGPL 2.1, COPYING-tinycc),"
  echo "  built by lust-lang's scripts/build-tcc.sh (Linux, macOS) or scripts/build-tcc.ps1 (Windows, with its PE patch)."
  echo "  libtcc is linked into lust-core; relink it against another libtcc by rebuilding lust with LUST_TCC_HOME."
  echo "mimalloc (libmimalloc-sys $mimalloc_version), https://github.com/microsoft/mimalloc (MIT, LICENSE-mimalloc)."
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
