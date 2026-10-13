#!/usr/bin/env python3
"""Build Open CASCADE Technology 7.9.2 as shared libraries.

The build type is Shared. A static archive for TKernel is a failed install.
TKDESTEP is not in this set: it pulls the visualization toolkits, and those
join when STEP save is wired. See docs/step-modeler.md.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "7.9.2"
TAG = "V7_9_2"
URL = f"https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/{TAG}.tar.gz"
SHA256 = "3cd080d3fc33ba0c6c157e110afe3e015859524c4694dbb09812ec9d61595639"

# Modeling toolkits used by later edits. Dependencies are pulled by CMake.
# Draw, visualization, and data exchange stay off so this build does not need
# FreeType, Tcl, or OpenGL.
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
]

MODULES_OFF = [
    "ApplicationFramework",
    "DataExchange",
    "DETools",
    "Draw",
    "FoundationClasses",
    "ModelingAlgorithms",
    "ModelingData",
    "Visualization",
]


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


def download(dest: Path) -> None:
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == SHA256:
        print(f"reusing {dest}", flush=True)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {URL}", flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "lime-slice-occt-install"})
    with urllib.request.urlopen(req) as response, dest.open("wb") as out:
        shutil.copyfileobj(response, out)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != SHA256:
        dest.unlink()
        raise SystemExit(f"OCCT archive hash is {digest}, expected {SHA256}")


def cmake_configure(source: Path, build: Path, prefix: Path) -> None:
    system = platform.system()
    cmd = [
        "cmake",
        "-S",
        str(source),
        "-B",
        str(build),
        f"-DCMAKE_INSTALL_PREFIX={prefix}",
        "-DBUILD_LIBRARY_TYPE=Shared",
        "-DBUILD_SHARED_LIBS=ON",
        "-DINSTALL_DIR_LAYOUT=Unix",
        # separate_arguments() in OCCT's CMake splits this string on spaces.
        "-DBUILD_ADDITIONAL_TOOLKITS=" + " ".join(TOOLKITS),
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
        "-DBUILD_Inspector=OFF",
        "-DBUILD_SAMPLES_QT=OFF",
        "-DBUILD_SAMPLES_MFC=OFF",
        "-DBUILD_USE_PCH=OFF",
        "-DBUILD_RELEASE_DISABLE_EXCEPTIONS=OFF",
        "-DBUILD_MODULE_UwpSample=OFF",
    ]
    for module in MODULES_OFF:
        cmd.append(f"-DBUILD_MODULE_{module}=OFF")
    arch = os.environ.get("CMAKE_OSX_ARCHITECTURES", "").strip()
    if arch:
        cmd.append(f"-DCMAKE_OSX_ARCHITECTURES={arch}")
    if system == "Windows":
        cmd[1:1] = ["-G", "Visual Studio 17 2022", "-A", "x64"]
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


def refuse_static(prefix: Path) -> None:
    marker = shared_marker(prefix)
    if marker is None:
        raise SystemExit(f"OCCT install at {prefix} has no shared TKernel library")
    static = [prefix / "lib" / "libTKernel.a", prefix / "lib" / "TKernel.a"]
    found = [path for path in static if path.exists()]
    if found:
        raise SystemExit(f"OCCT install produced a static archive: {found[0]}")
    kind = "DLL" if marker.suffix.lower() == ".dll" else "shared library"
    print(f"OCCT {VERSION} {kind}: {marker}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    args = parser.parse_args()
    prefix = args.prefix.resolve()
    if shared_marker(prefix) is not None and not list(prefix.glob("lib/libTKernel.a")):
        print(f"OCCT {VERSION} already installed at {prefix}", flush=True)
        return
    if shutil.which("cmake") is None:
        raise SystemExit("cmake is required to build OCCT")
    work = prefix.parent / f"occt-build-{VERSION}"
    archive = work / f"OCCT-{TAG}.tar.gz"
    # The GitHub archive unpacks to OCCT-7_9_2.
    source = work / "OCCT-7_9_2"
    build = work / "build"
    download(archive)
    if not source.exists():
        print(f"extracting {archive}", flush=True)
        work.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(work)
    if build.exists():
        shutil.rmtree(build)
    prefix.mkdir(parents=True, exist_ok=True)
    cmake_configure(source, build, prefix)
    cmake_build(build)
    refuse_static(prefix)
    (prefix / "lime-occt-version.txt").write_text(VERSION + "\n")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as err:
        sys.exit(err.returncode)
