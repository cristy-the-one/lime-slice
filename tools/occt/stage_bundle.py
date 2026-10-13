#!/usr/bin/env python3
"""Copy OCCT shared libraries and the LGPL notices into a bundle directory.

Static archives are not copied. On macOS, install names are rewritten to
@rpath so a library next to its neighbours can be replaced. On Linux, each
shared library's runpath is set to $ORIGIN. The libraries depend on each
other by soname, and a runpath is not searched for a dependency's own
dependencies. linuxdeploy runs ldd on every shared object under usr/lib;
without $ORIGIN it reports the sibling soname as missing and the AppImage
build stops. The libraries stay shared objects so they can be replaced.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
from pathlib import Path

NOTICE_DIR = Path(__file__).resolve().parents[2] / "third_party" / "occt"
NOTICES = ("NOTICE.md", "LICENSE_LGPL_21.txt", "OCCT_LGPL_EXCEPTION.txt")


def is_shared(path: Path) -> bool:
    name = path.name
    if name.endswith(".a") or name.endswith(".lib"):
        return False
    if ".so" in name or name.endswith(".dylib") or name.endswith(".dll"):
        return name.startswith("libTK") or name.startswith("TK")
    return False


def collect(prefix: Path) -> list[Path]:
    found: list[Path] = []
    for folder in (prefix / "lib", prefix / "bin"):
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            if is_shared(path):
                found.append(path)
    return found


def is_elf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) == b"\x7fELF"
    except OSError:
        return False


def rewrite_linux(lib_dir: Path) -> None:
    patchelf = shutil.which("patchelf")
    if patchelf is None:
        raise SystemExit("patchelf is required to set $ORIGIN on Linux OCCT libraries")
    patched = 0
    for path in sorted(lib_dir.iterdir()):
        if path.is_symlink() or not is_elf(path):
            continue
        subprocess.run([patchelf, "--set-rpath", "$ORIGIN", str(path)], check=True)
        printed = subprocess.run(
            [patchelf, "--print-rpath", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        runpath = printed.stdout.strip()
        if runpath != "$ORIGIN":
            raise SystemExit(f"{path.name} runpath is {runpath!r}, expected $ORIGIN")
        patched += 1
    if patched == 0:
        raise SystemExit(f"no ELF shared libraries to patch in {lib_dir}")


def rewrite_macho(lib_dir: Path) -> None:
    libs = [path for path in lib_dir.iterdir() if path.suffix == ".dylib" and not path.is_symlink()]
    names = {path.name for path in libs}
    for path in libs:
        subprocess.run(["install_name_tool", "-id", f"@rpath/{path.name}", str(path)], check=True)
        listed = subprocess.run(["otool", "-L", str(path)], check=True, capture_output=True, text=True)
        for line in listed.stdout.splitlines()[1:]:
            dep = line.strip().split(" ", 1)[0]
            base = os.path.basename(dep)
            if base in names and dep != f"@rpath/{base}":
                subprocess.run(
                    ["install_name_tool", "-change", dep, f"@rpath/{base}", str(path)],
                    check=True,
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args()
    libs = collect(args.prefix.resolve())
    if not any("TKernel" in path.name for path in libs):
        raise SystemExit(f"no shared TKernel library under {args.prefix}")
    dest = args.dest.resolve()
    lib_dir = dest / "lib"
    if dest.exists():
        shutil.rmtree(dest)
    lib_dir.mkdir(parents=True)
    for path in libs:
        target = lib_dir / path.name
        if path.is_symlink():
            target.symlink_to(os.readlink(path))
        else:
            shutil.copy2(path, target)
    if platform.system() == "Darwin":
        rewrite_macho(lib_dir)
    elif platform.system() == "Linux":
        rewrite_linux(lib_dir)
    for name in NOTICES:
        shutil.copy2(NOTICE_DIR / name, dest / name)
    copied = sorted(path.name for path in lib_dir.iterdir())
    print(f"staged {len(copied)} shared libraries in {lib_dir}", flush=True)


if __name__ == "__main__":
    main()
