#!/usr/bin/env python3
"""Copy OCCT shared libraries and the LGPL notices into a bundle directory.

Static archives are not copied. On macOS, install names are rewritten to
@rpath so a library next to its neighbours can be replaced.
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
    for name in NOTICES:
        shutil.copy2(NOTICE_DIR / name, dest / name)
    copied = sorted(path.name for path in lib_dir.iterdir())
    print(f"staged {len(copied)} shared libraries in {lib_dir}", flush=True)


if __name__ == "__main__":
    main()
