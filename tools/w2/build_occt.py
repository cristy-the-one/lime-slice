#!/usr/bin/env python3
"""Temporary OCCT build for the Delabella investigation.

Not the product install. tools/occt/install.py stays the Release 7.9.2 build
the app ships. This script can build 7.9.2 RelWithDebInfo (PDBs, same /MD CRT
as the Rust tests) or 8.0.2 Release, and can log the face Delabella is meshing.
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

RELEASES = {
    "7.9.2": {
        "tag": "V7_9_2",
        "sha256": "3cd080d3fc33ba0c6c157e110afe3e015859524c4694dbb09812ec9d61595639",
    },
    "8.0.2": {
        "tag": "V8_0_2",
        "sha256": "4b3ecaa559cd4f772a8a763668ca692bf79a36b05c41e8871139eb8d4625de9c",
    },
}

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
    "TKDESTEP",
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

FACE_LOG_HELPER = r"""
#include <cstdio>
#include <cstdlib>
#include <GeomAbs_SurfaceType.hxx>
#include <TopExp_Explorer.hxx>

namespace
{
void limeFaceLog(const char* theLine)
{
  const char* aPath = std::getenv("LIME_OCCT_MESH_LOG");
  if (aPath == nullptr || aPath[0] == '\0' || theLine == nullptr)
  {
    return;
  }
  FILE* aFile = std::fopen(aPath, "a");
  if (aFile == nullptr)
  {
    return;
  }
  std::fputs(theLine, aFile);
  std::fputc('\n', aFile);
  std::fflush(aFile);
  std::fclose(aFile);
}

const char* limeSurfaceName(GeomAbs_SurfaceType theType)
{
  switch (theType)
  {
    case GeomAbs_Plane:
      return "plane";
    case GeomAbs_Cylinder:
      return "cylinder";
    case GeomAbs_Cone:
      return "cone";
    case GeomAbs_Sphere:
      return "sphere";
    case GeomAbs_Torus:
      return "torus";
    case GeomAbs_BezierSurface:
      return "bezier";
    case GeomAbs_BSplineSurface:
      return "bspline";
    case GeomAbs_SurfaceOfRevolution:
      return "revolution";
    case GeomAbs_SurfaceOfExtrusion:
      return "extrusion";
    case GeomAbs_OffsetSurface:
      return "offset";
    case GeomAbs_OtherSurface:
      return "other";
    default:
      return "unknown";
  }
}
} // namespace
"""

FACE_LOG_CALL = r"""    {
      const TopoDS_Face& aLimeFace = aDFace->GetFace();
      int aLimeWires = static_cast<int>(aDFace->WiresNb());
      int aLimeEdges = 0;
      for (TopExp_Explorer aLimeIt(aLimeFace, TopAbs_EDGE); aLimeIt.More(); aLimeIt.Next())
      {
        ++aLimeEdges;
      }
      const char* aLimeType = "none";
      if (!aDFace->GetSurface().IsNull())
      {
        aLimeType = limeSurfaceName(aDFace->GetSurface()->GetType());
      }
      char aLimeLine[256];
      std::snprintf(aLimeLine,
                    sizeof(aLimeLine),
                    "FACE_BEGIN index=%d type=%s wires=%d holes=%d edges=%d",
                    static_cast<int>(theFaceIndex),
                    aLimeType,
                    aLimeWires,
                    aLimeWires > 0 ? aLimeWires - 1 : 0,
                    aLimeEdges);
      limeFaceLog(aLimeLine);
    }
    aMeshingAlgo->Perform(aDFace, myParameters, theRange);
    {
      char aLimeLine[64];
      std::snprintf(aLimeLine, sizeof(aLimeLine), "FACE_END index=%d", static_cast<int>(theFaceIndex));
      limeFaceLog(aLimeLine);
    }
"""


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


def face_discret(source: Path) -> Path | None:
    found = list(source.rglob("BRepMesh_FaceDiscret.cxx"))
    return found[0] if found else None


def patch_face_log(source: Path) -> None:
    path = face_discret(source)
    if path is None:
        raise SystemExit(f"no BRepMesh_FaceDiscret.cxx under {source}")
    text = path.read_text(encoding="utf-8")
    if "limeFaceLog" in text:
        print(f"face log already in {path}", flush=True)
        return
    anchor = "aMeshingAlgo->Perform(aDFace, myParameters, theRange);"
    if anchor not in text:
        raise SystemExit(f"{path} has no Perform anchor to patch")
    process = "BRepMesh_FaceDiscret::process("
    at = text.find(process)
    if at < 0:
        raise SystemExit(f"{path} has no process() to patch")
    # Keep the return type that sits on the same line as the name.
    line_at = text.rfind("\n", 0, at) + 1
    text = text[:line_at] + FACE_LOG_HELPER + "\n" + text[line_at:]
    text = text.replace(anchor, FACE_LOG_CALL, 1)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"patched face log into {path}", flush=True)


def download(dest: Path, url: str, sha256: str) -> None:
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
        print(f"reusing {dest}", flush=True)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "lime-slice-w2-occt"})
    with urllib.request.urlopen(req) as response, dest.open("wb") as out:
        shutil.copyfileobj(response, out)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != sha256:
        dest.unlink()
        raise SystemExit(f"OCCT archive hash is {digest}, expected {sha256}")


def windows_generator() -> list[str]:
    listed = subprocess.run(
        ["cmake", "--help"], check=True, capture_output=True, text=True
    ).stdout
    for name in ("Visual Studio 18 2026", "Visual Studio 17 2022"):
        if name in listed:
            return ["-G", name, "-A", "x64"]
    raise SystemExit("cmake lists neither Visual Studio 18 2026 nor Visual Studio 17 2022")


def cmake_configure(source: Path, build: Path, prefix: Path, config: str) -> None:
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
    if system == "Windows":
        cmd[1:1] = windows_generator()
        if config == "RelWithDebInfo":
            # Program Database, optimizations on, release CRT (/MD). Matches the Rust test's /MD.
            cmd.append("-DCMAKE_CXX_FLAGS_RELWITHDEBINFO=/Zi /O2 /Ob1 /DNDEBUG")
            cmd.append("-DCMAKE_C_FLAGS_RELWITHDEBINFO=/Zi /O2 /Ob1 /DNDEBUG")
            cmd.append("-DCMAKE_SHARED_LINKER_FLAGS_RELWITHDEBINFO=/DEBUG /INCREMENTAL:NO")
            cmd.append("-DCMAKE_EXE_LINKER_FLAGS_RELWITHDEBINFO=/DEBUG /INCREMENTAL:NO")
    else:
        cmd.append(f"-DCMAKE_BUILD_TYPE={config}")
        if shutil.which("ninja"):
            cmd[1:1] = ["-G", "Ninja"]
        else:
            cmd[1:1] = ["-G", "Unix Makefiles"]
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def cmake_build(build: Path, config: str) -> None:
    jobs = os.environ.get("W2_OCCT_JOBS", "2")
    cmd = ["cmake", "--build", str(build), "--parallel", jobs]
    if platform.system() == "Windows":
        cmd.extend(["--config", config])
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    install = ["cmake", "--install", str(build)]
    if platform.system() == "Windows":
        install.extend(["--config", config])
    print(" ".join(install), flush=True)
    subprocess.run(install, check=True)


def copy_pdbs(build: Path, prefix: Path) -> None:
    dest = prefix / "bin"
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for pdb in build.rglob("*.pdb"):
        if pdb.name.endswith(".pdb"):
            shutil.copy2(pdb, dest / pdb.name)
            copied += 1
    print(f"copied {copied} pdbs into {dest}", flush=True)
    mesh = dest / "TKMesh.pdb"
    if not mesh.exists():
        raise SystemExit(f"TKMesh.pdb was not produced; looked under {build}")


def already(prefix: Path, version: str, config: str, face_log: bool) -> bool:
    marker = prefix / "lime-occt-build.txt"
    if shared_marker(prefix) is None or not marker.exists():
        return False
    text = marker.read_text(encoding="utf-8")
    if version not in text or config not in text:
        return False
    if face_log and "facelog" not in text:
        return False
    if config == "RelWithDebInfo" and not (prefix / "bin" / "TKMesh.pdb").exists():
        return False
    print(f"OCCT {version} {config} already installed at {prefix}", flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--version", choices=sorted(RELEASES), required=True)
    parser.add_argument("--config", choices=("Release", "RelWithDebInfo", "Debug"), required=True)
    parser.add_argument("--face-log", action="store_true")
    args = parser.parse_args()
    prefix = args.prefix.resolve()
    if already(prefix, args.version, args.config, args.face_log):
        return
    if shutil.which("cmake") is None:
        raise SystemExit("cmake is required to build OCCT")
    spec = RELEASES[args.version]
    tag = spec["tag"]
    work = prefix.parent / f"occt-src-{tag}-{args.config}"
    archive = work / f"OCCT-{tag}.tar.gz"
    # GitHub unpacks V7_9_2 as OCCT-7_9_2 and V8_0_2 as OCCT-8_0_2.
    source = work / f"OCCT-{tag[1:]}"
    build = work / "build"
    url = f"https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/{tag}.tar.gz"
    download(archive, url, spec["sha256"])
    if not source.exists():
        print(f"extracting {archive} -> {source}", flush=True)
        work.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(work)
    if not source.exists():
        raise SystemExit(f"unpacked source is not at {source}")
    if args.face_log:
        patch_face_log(source)
    if build.exists():
        shutil.rmtree(build)
    if prefix.exists():
        shutil.rmtree(prefix)
    prefix.mkdir(parents=True, exist_ok=True)
    cmake_configure(source, build, prefix, args.config)
    cmake_build(build, args.config)
    if args.config == "RelWithDebInfo":
        copy_pdbs(build, prefix)
    note = f"{args.version} {args.config}" + (" facelog" if args.face_log else "")
    (prefix / "lime-occt-build.txt").write_text(note + "\n", encoding="utf-8")
    (prefix / "lime-occt-source.txt").write_text(str(source) + "\n", encoding="utf-8")
    print(f"OCCT_READY {note} prefix={prefix}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as err:
        sys.exit(err.returncode)
