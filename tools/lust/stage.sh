#!/usr/bin/env bash
# Lays a lust build (tools/lust/install.sh) out for the installers, beside the MCP server.
# Usage: tools/lust/stage.sh <lust checkout> <dest>   (the installers use src-tauri/resources/mcp/lust)
#
# The layout is lust's own release package (lust-lang scripts/release.sh). lust finds lib/lust from its own
# executable, so nothing has to be set at run time:
#   bin/lust, bin/lust-core            the client recipe_run calls and the compiler daemon it starts
#   lib/lust/tcc/bin/tcc               the pinned tinycc, for parallel `tcc -c` (libtcc is linked into lust-core)
#   lib/lust/tcc/lib/tcc/              libtcc1.a and tcc's headers (Windows: also the import .def files)
#   lib/lust/library/                  std and adapter sources lust reads at run time
#   LICENSE-lust, COPYING-tinycc, LICENSE-mimalloc, SOURCES.txt
set -euo pipefail
src=${1:?usage: stage.sh <lust checkout> <dest>}
dest=${2:?usage: stage.sh <lust checkout> <dest>}
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
  echo "  built by lust-lang's scripts/build-tcc.sh (Linux) or scripts/build-tcc.ps1 (Windows, with its PE patch)."
  echo "  libtcc is linked into lust-core; relink it against another libtcc by rebuilding lust with LUST_TCC_HOME."
  echo "mimalloc (libmimalloc-sys $mimalloc_version), https://github.com/microsoft/mimalloc (MIT, LICENSE-mimalloc)."
} > "$dest/SOURCES.txt"
"$dest/bin/lust$exe" --version >&2
du -sh "$dest" >&2
