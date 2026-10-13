# STEP editing, the kernel crate

`docs/step-modeler-evaluation.md` is the decision. This note is the contract for the first change: a kernel crate that dynamically links Open CASCADE Technology 7.9.2. Model mode, picking, measure, and the edits themselves are later changes. `crates/lime-slice-core` is not part of this work.

## What this change is

`crates/lime-model` is the swap point. `Kernel` is the trait. `open()` loads a session.

`OCCT_ROOT` selects the install. When it is set, the build links `TKernel` with `cargo:rustc-link-lib=dylib` and `open()` returns the string from `OCCT_Version_String_Complete()`. When it is unset, the C++ compiler is not run and `open()` returns an error. A static archive of `TKernel` fails the build.

The core, the `lime-slice` CLI, and the Tauri shell do not depend on this crate. Opening the app and slicing a file stay on the path they have today. Truck remains the reader of an unedited STEP file. An edited solid, when that exists, will tessellate into the existing `sourcePos` / `encodeStl` path.

`tools/occt/install.py` compiles tag `V7_9_2` as shared libraries. The pin, the archive URL, and the SHA-256 are in `third_party/occt/NOTICE.md`. The toolkit list is the modeling set through `TKMesh` and `TKShHealing`. Draw, visualization, and data exchange are off, so this build does not need FreeType or OpenGL. `TKDESTEP` waits for STEP save: its dependency list pulls `TKV3d` and `TKService`.

`tools/occt/stage_bundle.py` copies those shared libraries and the three notice files. The release workflow stages them at `src-tauri/resources/occt` and passes `src-tauri/tauri.occt.json`, which bundles that directory as `occt/`. A local `tauri build` does not pass that overlay and does not need OCCT. The staged directory is gitignored.

## How the libraries are linked

The link is dynamic on every platform.

- Linux: `libTKernel.so`, rpath `$ORIGIN`.
- macOS: `libTKernel.dylib`, install name `@rpath`, rpath `@executable_path` and `@executable_path/../Resources/occt/lib`.
- Windows: import library `TKernel.lib` at link time, `TKernel.dll` at run time.

`LIME_REQUIRE_OCCT=1` makes a missing library a test failure. The test reads the dynamic imports of its own executable (`ldd`, `otool -L`, or the PE import table) and requires `TKernel` there. CI runs that test on Ubuntu, inside the existing Rust job, and on `windows-latest` and `macos-latest`. The Ubuntu job is one of the required checks. The other two are not, so a merge waits for them on purpose.

The notices shipped beside the libraries are `third_party/occt/LICENSE_LGPL_21.txt`, `OCCT_LGPL_EXCEPTION.txt`, and `NOTICE.md`. The source offer is the official archive plus `tools/occt/install.py`, for at least three years after a release that includes the libraries. The rest of Lime Slice stays MIT. No GPL code is linked. SolveSpace is not a dependency.

The Intel macOS installer is the existing cross compile from the Apple silicon runner. That job builds the OCCT dylibs with `CMAKE_OSX_ARCHITECTURES=x86_64` and stages them. The native macOS CI job is arm64. The shell still does not link OCCT, so a missing dylib cannot stop the app from starting.

## What this change is not

- No Model mode, and no face or edge picking.
- No measure, boolean, plane split, fillet, chamfer, hole, or scale.
- No STEP writer, and no `.lime` brep field.
- No change to `tools/golden_ab.sh` or to slicer output.
- The desktop shell does not load the libraries. They are staged for a later switch.

## Review questions

1. Is the shell staying unloaded, with the dynamic link proved only by `lime-model`'s test, the right split until Model mode exists?
2. Is deferring `TKDESTEP` until STEP save right, given the visualization libraries it pulls?
3. Is a stub compile when `OCCT_ROOT` is unset the right default for a local slicer build?
