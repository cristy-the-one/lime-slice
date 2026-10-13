# STEP editing, the kernel crate

`docs/step-modeler-evaluation.md` is the decision. This note is the contract for the first change: a kernel crate that dynamically links Open CASCADE Technology 7.9.2. Model mode, picking, measure, and the edits themselves are later changes. `crates/lime-slice-core` is not part of this work.

## What this change is

`crates/lime-model` is the swap point. `Kernel` is the trait. `open()` loads a session.

`OCCT_ROOT` selects the install. When it is set, the build links `TKernel` with `cargo:rustc-link-lib=dylib` and `open()` returns the string from `OCCT_Version_String_Complete()`. When it is unset, the C++ compiler is not run and `open()` returns an error. A static archive of `TKernel` fails the build.

The core, the `lime-slice` CLI, and the Tauri shell do not depend on this crate. Opening the app and slicing a file stay on the path they have today. Truck remains the reader of an unedited STEP file. An edited solid, when that exists, will tessellate into the existing `sourcePos` / `encodeStl` path.

`tools/occt/install.py` compiles tag `V7_9_2` as shared libraries. The pin, the archive URL, and the SHA-256 are in `third_party/occt/NOTICE.md`. The toolkit list is the modeling set through `TKMesh` and `TKShHealing`, plus `TKDESTEP` so Model mode can read a solid. CMake pulls `TKXCAF`, `TKV3d`, and `TKService` for that reader. FreeType and OpenGL stay off, and those toolkits build without them. STEP write is still a later change.

`tools/occt/stage_bundle.py` copies those shared libraries and the three notice files. The release workflow stages them at `src-tauri/resources/occt` and passes `src-tauri/tauri.occt.json`, which bundles that directory as `occt/`. A local `tauri build` does not pass that overlay and does not need OCCT. The staged directory is gitignored.

## How the libraries are linked

The link is dynamic on every platform.

- Linux: `libTKernel.so`, rpath `$ORIGIN`.
- macOS: `libTKernel.dylib`, install name `@rpath`, rpath `@executable_path` and `@executable_path/../Resources/occt/lib`.
- Windows: import library `TKernel.lib` at link time, `TKernel.dll` at run time.

`LIME_REQUIRE_OCCT=1` makes a missing library a test failure. The test reads the dynamic imports of its own executable (`ldd`, `otool -L`, or the PE import table) and requires `TKernel` there. CI runs that test on Ubuntu, inside the existing Rust job, and on `windows-latest` and `macos-latest`. The Ubuntu job is one of the required checks. The other two are not, so a merge waits for them on purpose.

The notices shipped beside the libraries are `third_party/occt/LICENSE_LGPL_21.txt`, `OCCT_LGPL_EXCEPTION.txt`, and `NOTICE.md`. The source offer is the official archive plus `tools/occt/install.py`, for at least three years after a release that includes the libraries. The rest of Lime Slice stays MIT. No GPL code is linked. SolveSpace is not a dependency.

The Intel macOS installer is the existing cross compile from the Apple silicon runner. That job builds the OCCT dylibs with `CMAKE_OSX_ARCHITECTURES=x86_64` and stages them. The native macOS CI job is arm64. The shell still does not link OCCT, so a missing dylib cannot stop the app from starting.

## Model mode

The fourth workspace tab is Model. It is not selected when the app opens. Shortcut `4`. Shift+4 stays the By layer strategy.

`crates/lime-model-occt` is a cdylib. It links the modeling toolkits and, when `libTKDESTEP` is present, the STEP reader. `crates/lime-model-load` dlopens that library. The CLI and the Tauri shell depend on the loader only, so a missing bridge cannot stop the app from starting. The shell looks beside the executable and in `occt/lib` under the resource directory. `LIME_OCCT_BRIDGE` overrides the path.

Model mode sends the open STEP file to `POST /api/model` (or the `model_solid` command). The reply is the solid's tessellation, volume, face areas, and edge polylines. A click selects one face or edge and reports its area or length. Shift-click adds or removes a pick. Exactly two picks report the distance. Escape, or a click on empty space, clears the selection. Edits open from the toolbar and run on Apply. The ghost in the view is a local preview, not a kernel result. A mesh file says that measure reads a STEP solid. Nothing is invented when the bridge is missing.

The release workflow builds the cdylib after staging the Open CASCADE libraries and copies it into `src-tauri/resources/occt/lib`, next to those libraries. The cdylib's rpath is `$ORIGIN` on Linux and `@loader_path` on macOS.

## Booleans and a plane split

Model mode can fuse, cut, or intersect the open solid with a box, cylinder, or sphere, and it can split the solid with a horizontal plane. The numbers are millimetres in the solid's own frame. A kernel failure is the readout, and the solid is left as it was. There is no mesh boolean behind it.

A successful edit replaces `sourcePos` with the settled tessellation, writes that mesh with `encodeStl`, and renames the file to `.stl`, so truck is not asked to read the edited solid. The pose stays. Support paint, seam paint, and support edits on that object are cleared, because they named the old surface. Undo restores the solid, that mesh, and the paint. A split keeps the piece on the negative side of the plane and adds the other piece in the parent's place, with the same pose, so the two halves are not parked side by side. Both settle onto the bed, so the plate lists them as overlapping and offers Arrange. The plane starts at mid-height and stays clear of the faces, so a cut on a thin plate cannot leave a sliver. The second piece is a mesh until a later change can store its B-rep.

## Fillet, chamfer, hole, and scale

Model mode can fillet or chamfer the picked edge, cut a cylindrical hole, and scale the solid by one factor. The blend size, the hole radius, and the hole depth are millimetres. The hole starts at the origin fields and runs straight down. Scale is about the solid's centre. A kernel failure is the readout, and the solid is left as it was. There is no mesh fallback.

A successful edit uses the same commit as a boolean: settled tessellation, `encodeStl`, and a `.stl` name. Pose stays, except that a scale sets the plate's `partScale` back to 1 so the part is not scaled twice. Undo restores the solid, the mesh, the paint, and that placement scale.

## STEP save

Model mode writes the open solid as AP214 IS, a manifold solid B-rep, through `STEPControl_Writer`. The STEP button downloads that file. The same bytes are kept on the plate object as optional `brep`, in the same shape as `mesh`: name, base64, length, and hash.

`.lime` stays version 2. A one-object file with `brep` is version 2 so the field is not dropped. A file without it still opens, including one saved before this field existed. A damaged `brep` fails the open. An older app ignores the key, slices the mesh, and drops `brep` on the next save. Duplicate copies the bytes. The second piece of a split stays a mesh.

Opening Model reloads `brep` when the object has one, so an edited solid is not stuck as a mesh. The STL is what the slicer reads. Opening Model still does not replace `sourcePos`.

## What this change is not

- No change to `tools/golden_ab.sh` or to slicer output.
- The slicer core does not link Open CASCADE. Truck still reads an unedited STEP file for slicing.

## Review questions

1. Is dlopen of `lime-model-occt`, with the shell depending only on `lime-model-load`, the right way to keep startup free of the libraries?
2. Is reading STEP in Model mode, while FreeType and OpenGL stay off, acceptable given that `TKDESTEP` pulls `TKV3d` and `TKService`?
3. Is a stub compile when `OCCT_ROOT` is unset the right default for a local slicer build?
