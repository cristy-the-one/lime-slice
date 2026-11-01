#!/usr/bin/env bash
# Builds lust, the checker and compiler recipe_run uses, at the commit in tools/lust/LUST_REV.
# Usage: tools/lust/install.sh [dir]   (default ~/.lime-slice/lust). Prints the lust binary's path last.
# Linux, and Windows under Git Bash with Visual Studio's C++ tools (tcc is built with cl there); a developer shell is
# loaded when cl is not on PATH. tools/lust/stage.sh lays the build out for the installers.
# macOS is not supported yet: lust does not build there (tcc Mach-O). CI skips the recipe steps on macOS.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
rev=$(tr -d '[:space:]' < "$here/LUST_REV")
dest=${1:-$HOME/.lime-slice/lust}
repo=${LUST_REPO:-https://github.com/cristy-the-one/lust-lang.git}
if [ ! -d "$dest/.git" ]; then
  git clone -q "$repo" "$dest"
fi
if [ "$(git -C "$dest" rev-parse HEAD)" != "$rev" ]; then
  git -C "$dest" fetch -q origin "$rev" 2>/dev/null || git -C "$dest" fetch -q origin
  git -C "$dest" checkout -q --detach "$rev"
fi
exe=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    exe=".exe"
    # Outside a Visual Studio developer shell, take its environment from vcvars64.bat (found with vswhere).
    command -v cl.exe > /dev/null || . "$here/msvc-env.sh"
    # PowerShell 7 (pwsh), as lust's CI runs it: Windows PowerShell 5.1 hands build-tcc.ps1's cl arguments over as
    # one string ("D9002 ignoring unknown option '/nologo /O2 ...'").
    ps=pwsh
    command -v pwsh > /dev/null || ps=powershell.exe
    [ -f "$dest/third_party/tcc/lib/tcc.lib" ] || "$ps" -NoProfile -ExecutionPolicy Bypass -File "$dest/scripts/build-tcc.ps1" >&2
    # Git Bash's coreutils `link` comes before MSVC's link.exe on PATH, and rustc would call it.
    msvc_link=$(where.exe link.exe 2>/dev/null | tr -d '\r' | grep -vi '\\Git\\' | head -n 1 || true)
    if [ -z "$msvc_link" ]; then
      echo "MSVC link.exe is not on PATH: run this from a Visual Studio developer shell" >&2
      exit 1
    fi
    export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="$msvc_link"
    ;;
  Darwin)
    echo "lust does not build on macOS yet" >&2
    exit 2
    ;;
  *)
    [ -f "$dest/third_party/tcc/lib/libtcc.a" ] || "$dest/scripts/build-tcc.sh" >&2
    ;;
esac
(cd "$dest" && LUST_TCC_HOME="$dest/third_party/tcc" cargo build --release --locked --bins >&2)
"$dest/target/release/lust$exe" --version >&2
echo "$dest/target/release/lust$exe"
