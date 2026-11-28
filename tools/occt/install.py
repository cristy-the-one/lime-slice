#!/usr/bin/env python3
"""Build Open CASCADE Technology as shared libraries: 7.9.2 (the default) or 8.0.2.

The build type is Shared. A static archive for TKernel is a failed install.
TKDESTEP is in the toolkit list so Model mode can read a solid. CMake pulls
TKV3d and TKService for it. FreeType and OpenGL stay off. See docs/step-modeler.md.
8.0.2 is the preview of docs/plan-occt-8.md; the release stays on 7.9.2 until O4.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

DEFAULT_VERSION = "7.9.2"

# Options both versions read. USE_VTK is off by default in 8.0 and stays passed.
COMMON_OPTIONS = [
    "-DBUILD_LIBRARY_TYPE=Shared",
    "-DBUILD_SHARED_LIBS=ON",
    "-DINSTALL_DIR_LAYOUT=Unix",
    "-DUSE_FREETYPE=OFF",
    "-DUSE_TCL=OFF",
    "-DUSE_TK=OFF",
    "-DUSE_OPENGL=OFF",
    "-DUSE_GLES2=OFF",
    "-DUSE_XLIB=OFF",
    "-DUSE_TBB=OFF",
    "-DUSE_VTK=OFF",
    "-DUSE_FREEIMAGE=OFF",
    "-DUSE_RAPIDJSON=OFF",
    "-DUSE_FFMPEG=OFF",
    "-DUSE_OPENVR=OFF",
    "-DUSE_DRACO=OFF",
    "-DBUILD_DOC_Overview=OFF",
]

# One row per version: the source archive's tag, SHA-256 and folder, and the
# options that version's CMake reads. 8.0 no longer reads BUILD_Inspector,
# BUILD_SAMPLES_QT, BUILD_SAMPLES_MFC or BUILD_MODULE_DETools (docs/plan-occt-8.md,
# section 4), so its row leaves them out and CMake prints no "not used" warning.
VERSIONS = {
    "7.9.2": {
        "tag": "V7_9_2",
        "sha256": "3cd080d3fc33ba0c6c157e110afe3e015859524c4694dbb09812ec9d61595639",
        "folder": "OCCT-7_9_2",
        "options": COMMON_OPTIONS
        + [
            "-DBUILD_Inspector=OFF",
            "-DBUILD_SAMPLES_QT=OFF",
            "-DBUILD_SAMPLES_MFC=OFF",
            "-DBUILD_USE_PCH=OFF",
            "-DBUILD_RELEASE_DISABLE_EXCEPTIONS=OFF",
            "-DBUILD_MODULE_UwpSample=OFF",
        ],
        "modules_off": [
            "ApplicationFramework",
            "DataExchange",
            "DETools",
            "Draw",
            "FoundationClasses",
            "ModelingAlgorithms",
            "ModelingData",
            "Visualization",
        ],
    },
    "8.0.2": {
        "tag": "V8_0_2",
        "sha256": "4b3ecaa559cd4f772a8a763668ca692bf79a36b05c41e8871139eb8d4625de9c",
        "folder": "OCCT-8_0_2",
        "options": COMMON_OPTIONS
        + [
            "-DBUILD_USE_PCH=OFF",
            # Default ON in 8.0. Off keeps Standard_Failure checks in Release, as on 7.9.2.
            "-DBUILD_RELEASE_DISABLE_EXCEPTIONS=OFF",
            "-DBUILD_MODULE_UwpSample=OFF",
        ],
        "modules_off": [
            "ApplicationFramework",
            "DataExchange",
            "Draw",
            "FoundationClasses",
            "ModelingAlgorithms",
            "ModelingData",
            "Visualization",
        ],
    },
}

# Modeling toolkits used by later edits, plus TKDESTEP for Model mode.
# Dependencies are pulled by CMake. Draw stays off. FreeType, Tcl, and OpenGL
# stay off; TKV3d and TKService still build. Both versions have every one.
TOOLKITS = [
    "TKernel",
    "TKMath",
    "TKG2d",
    "TKG3d",
    "TKGeomBase",
    "TKBRep",
    "TKGeomAlgo",
    "TKTopAlgo",
    "TKPrim",
    "TKBO",
    "TKBool",
    "TKHLR",
    "TKFillet",
    "TKOffset",
    "TKFeat",
    "TKMesh",
    "TKShHealing",
    # STEP read. CMake pulls TKXCAF, TKV3d and TKService. FreeType and OpenGL
    # stay off; those toolkits build without them.
    "TKDESTEP",
]

# Bump when a change to how this script builds would change an install but not
# the row's options (the generator, the compiler choice, a step after install).
RECIPE = 1

# The stamp lime-occt-version.txt reads "<version>" on its first line and
# "build <fingerprint>" on its second. Installs made before the version table
# have the first line only. They were built with exactly this 7.9.2 row, so
# a bare "7.9.2" stamp stands for this fingerprint and is reused. A change to
# the 7.9.2 row or to RECIPE changes the fingerprint and rebuilds them.
PRE_TABLE_FINGERPRINT = {
    "7.9.2": "edf28d73f8c5142c4c0618ebf835d1442e7fbd4d9821d63653546d926652dc9c",
}

STAMP = "lime-occt-version.txt"


def fingerprint(version: str) -> str:
    row = VERSIONS[version]
    data = {
        "version": version,
        "tag": row["tag"],
        "sha256": row["sha256"],
        "options": row["options"],
        "modules_off": row["modules_off"],
        "toolkits": TOOLKITS,
        "recipe": RECIPE,
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def archive_url(tag: str) -> str:
    return f"https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/{tag}.tar.gz"


def shared_marker(prefix: Path) -> Path | None:
    lib = prefix / "lib"
    bin_dir = prefix / "bin"
    for path in (
        lib / "libTKernel.so",
        lib / "libTKernel.dylib",
        bin_dir / "TKernel.dll",
        lib / "TKernel.dll",
    ):
        if path.exists():
            return path
    return None


def toolkit_library(prefix: Path, toolkit: str) -> Path | None:
    lib = prefix / "lib"
    bin_dir = prefix / "bin"
    for path in (
        lib / f"lib{toolkit}.so",
        lib / f"lib{toolkit}.dylib",
        bin_dir / f"{toolkit}.dll",
        lib / f"{toolkit}.dll",
    ):
        if path.exists():
            return path
    return None


def download(url: str, dest: Path, sha256: str) -> None:
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
        print(f"reusing {dest}", flush=True)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "lime-slice-occt-install"})
    with urllib.request.urlopen(req) as response, dest.open("wb") as out:
        shutil.copyfileobj(response, out)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != sha256:
        dest.unlink()
        raise SystemExit(f"OCCT archive hash is {digest}, expected {sha256}")


def windows_generator() -> list[str]:
    # windows-latest is Visual Studio 2026. An older image still lists 2022.
    listed = subprocess.run(
        ["cmake", "--help"], check=True, capture_output=True, text=True
    ).stdout
    for name in ("Visual Studio 18 2026", "Visual Studio 17 2022"):
        if name in listed:
            return ["-G", name, "-A", "x64"]
    raise SystemExit("cmake lists neither Visual Studio 18 2026 nor Visual Studio 17 2022")


def cmake_configure(version: str, source: Path, build: Path, prefix: Path) -> None:
    row = VERSIONS[version]
    system = platform.system()
    options = list(row["options"])
    # separate_arguments() in OCCT's CMake splits this string on spaces.
    # It goes after INSTALL_DIR_LAYOUT, where 7.9.2's command line always had it.
    options.insert(3, "-DBUILD_ADDITIONAL_TOOLKITS=" + " ".join(TOOLKITS))
    cmd = [
        "cmake",
        "-S",
        str(source),
        "-B",
        str(build),
        f"-DCMAKE_INSTALL_PREFIX={prefix}",
        *options,
    ]
    for module in row["modules_off"]:
        cmd.append(f"-DBUILD_MODULE_{module}=OFF")
    arch = os.environ.get("CMAKE_OSX_ARCHITECTURES", "").strip()
    if arch:
        cmd.append(f"-DCMAKE_OSX_ARCHITECTURES={arch}")
    if system == "Windows":
        cmd[1:1] = windows_generator()
    else:
        cmd.append("-DCMAKE_BUILD_TYPE=Release")
        if system == "Linux":
            gcc = shutil.which("gcc")
            gxx = shutil.which("g++")
            if gcc and gxx:
                cmd.append(f"-DCMAKE_C_COMPILER={gcc}")
                cmd.append(f"-DCMAKE_CXX_COMPILER={gxx}")
        if shutil.which("ninja"):
            cmd[1:1] = ["-G", "Ninja"]
        else:
            cmd[1:1] = ["-G", "Unix Makefiles"]
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def cmake_build(build: Path) -> None:
    cmd = ["cmake", "--build", str(build), "--parallel"]
    if platform.system() == "Windows":
        cmd.extend(["--config", "Release"])
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    install = ["cmake", "--install", str(build)]
    if platform.system() == "Windows":
        install.extend(["--config", "Release"])
    print(" ".join(install), flush=True)
    subprocess.run(install, check=True)


def refuse_static(version: str, prefix: Path) -> None:
    marker = shared_marker(prefix)
    if marker is None:
        raise SystemExit(f"OCCT install at {prefix} has no shared TKernel library")
    static = [prefix / "lib" / "libTKernel.a", prefix / "lib" / "TKernel.a"]
    found = [path for path in static if path.exists()]
    if found:
        raise SystemExit(f"OCCT install produced a static archive: {found[0]}")
    kind = "DLL" if marker.suffix.lower() == ".dll" else "shared library"
    print(f"OCCT {version} {kind}: {marker}", flush=True)


def check_layout(version: str, prefix: Path) -> None:
    """The layout build.rs reads: headers in include/opencascade, with
    Standard_VersionInfo.hxx (its probe) and a Standard_Version.hxx that names
    this version, and one shared library per toolkit under its own name."""
    include = prefix / "include" / "opencascade"
    probe = include / "Standard_VersionInfo.hxx"
    if not probe.exists():
        raise SystemExit(f"OCCT {version} install has no {probe}")
    header = include / "Standard_Version.hxx"
    expected = f'#define OCC_VERSION_COMPLETE "{version}"'
    if not header.exists() or expected not in header.read_text(errors="replace"):
        raise SystemExit(f"{header} does not say {expected}")
    missing = [tk for tk in TOOLKITS if toolkit_library(prefix, tk) is None]
    if missing:
        raise SystemExit(f"OCCT {version} install has no shared library for {', '.join(missing)}")
    print(f"OCCT {version} layout: {include}, {len(TOOLKITS)} toolkits", flush=True)


def read_stamp(prefix: Path) -> tuple[str, str | None] | None:
    path = prefix / STAMP
    if not path.exists():
        return None
    lines = path.read_text().split()
    if not lines:
        return None
    build = lines[2] if len(lines) >= 3 and lines[1] == "build" else None
    return lines[0], build


def write_stamp(version: str, prefix: Path) -> None:
    (prefix / STAMP).write_text(f"{version}\nbuild {fingerprint(version)}\n")


def installed(version: str, prefix: Path) -> bool:
    """True when prefix holds a shared install built from this version's row."""
    if shared_marker(prefix) is None or toolkit_library(prefix, "TKDESTEP") is None:
        return False
    if list(prefix.glob("lib/libTKernel.a")):
        return False
    stamp = read_stamp(prefix)
    if stamp is None or stamp[0] != version:
        return False
    built = stamp[1] or PRE_TABLE_FINGERPRINT.get(version)
    return built == fingerprint(version)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--version", choices=sorted(VERSIONS), default=DEFAULT_VERSION)
    args = parser.parse_args()
    version = args.version
    row = VERSIONS[version]
    prefix = args.prefix.resolve()
    if installed(version, prefix):
        print(f"OCCT {version} already installed at {prefix}", flush=True)
        check_layout(version, prefix)
        write_stamp(version, prefix)
        return
    stamp = read_stamp(prefix)
    if stamp is not None and stamp[0] != version:
        raise SystemExit(f"{prefix} holds OCCT {stamp[0]}; give OCCT {version} its own prefix")
    if stamp is not None:
        # The same version from another build of this script, such as a cache
        # restored by key prefix. Start clean, so no file of the old build stays.
        print(f"OCCT {version} at {prefix} is another build; removing it", flush=True)
        shutil.rmtree(prefix)
    if shutil.which("cmake") is None:
        raise SystemExit("cmake is required to build OCCT")
    work = prefix.parent / f"occt-build-{version}"
    archive = work / f"OCCT-{row['tag']}.tar.gz"
    # The GitHub archive unpacks to OCCT-<major>_<minor>_<patch>.
    source = work / row["folder"]
    build = work / "build"
    download(archive_url(row["tag"]), archive, row["sha256"])
    if not source.exists():
        print(f"extracting {archive}", flush=True)
        work.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(work)
    if build.exists():
        shutil.rmtree(build)
    prefix.mkdir(parents=True, exist_ok=True)
    cmake_configure(version, source, build, prefix)
    cmake_build(build)
    refuse_static(version, prefix)
    check_layout(version, prefix)
    write_stamp(version, prefix)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as err:
        sys.exit(err.returncode)
