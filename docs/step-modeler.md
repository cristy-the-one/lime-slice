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

With more than one object on the plate, the others are drawn grey behind the open solid, where they sit relative to it (`src/model-context.ts`). The open object's pose is undone, because the solid is drawn in its own CAD frame, and the others keep theirs. They are not part of any pick, snap, handle drag, framing, bed centring, or size readout, and no tool targets them. The canvas carries `data-context-count` and `data-context` (each object's id and world box) for tests.

The release workflow builds the cdylib after staging the Open CASCADE libraries and copies it into `src-tauri/resources/occt/lib`, next to those libraries. The cdylib's rpath is `$ORIGIN` on Linux and `@loader_path` on macOS.

## Booleans and a plane split

Model mode can fuse, cut, or intersect the open solid with a box, cylinder, or sphere, and it can split the solid with a horizontal plane. The numbers are millimetres in the solid's own frame. A kernel failure is the readout, and the solid is left as it was. There is no mesh boolean behind it.

A successful edit replaces `sourcePos` with the settled tessellation, writes that mesh with `encodeStl`, and renames the file to `.stl`, so truck is not asked to read the edited solid. The pose stays. Support paint, seam paint, and support edits on that object are cleared, because they named the old surface. Undo restores the solid, that mesh, and the paint. A split keeps the piece on the negative side of the plane and adds the other piece in the parent's place, with the same pose, so the two halves are not parked side by side. Both settle onto the bed, so the plate lists them as overlapping and offers Arrange. The plane starts at mid-height and stays clear of the faces, so a cut on a thin plate cannot leave a sliver. The second piece is a mesh until a later change can store its B-rep.

## Fillet, chamfer, hole, and scale

Model mode can fillet or chamfer the picked edge, cut a cylindrical hole, and scale the solid by one factor. The blend size, the hole radius, and the hole depth are millimetres. The hole starts at the origin fields and runs straight down. Scale is about the solid's centre. Fillet and chamfer stay disabled until an edge is picked, and the button's tip says how to pick one. While the numbers change, a debounced dry-run builds the fillet, chamfer, hole, or boolean on a copy and leaves the solid alone. The note says it works, or why not, and for a blend the largest size that did. Apply stays off until that check passes. Split and scale are judged from their numbers. The desktop shell runs every Model command off the UI thread. A kernel failure is the readout, and the solid is left as it was. There is no mesh fallback.

The session computes each thing once per shape (`Held` in `session.cpp`). A dry-run that works keeps the shape it built, keyed by the op, its numbers (`%.17g`), and the solid it ran on; an Apply with the same key commits that shape instead of building it again, and any edit, undo, redo, or open drops it. Each resulting shape's volume is integrated once, by the op that made it, and reused for the reply; a scale multiplies the volume by the factor cubed. Each shape keeps its reply per chord, so undo and redo of a shape the session holds return the reply it had. Cached replies on the undo and redo stacks stay within 64 MB, nearest first. `lime_model_occt::stats()` counts builds, volume integrations, and tessellations for `tests/probe_reuse.rs`.

A successful edit uses the same commit as a boolean: settled tessellation, `encodeStl`, and a `.stl` name. Pose stays, except that a scale sets the plate's `partScale` back to 1 so the part is not scaled twice. Undo restores the solid, the mesh, the paint, and that placement scale.

## History tree (engine)

The bridge also keeps Model history as a tree: one tree per plate object, one node per edit, and a new edit from an older node starts a branch instead of dropping the newer steps. The client owns node ids, labels, and which branch Redo follows. The engine keeps what is costly to rebuild. The client still uses the one-solid session and its linear undo until it moves to the tree; both run side by side and share the kernel code in `cpp/kernel.h`.

Every call is one JSON request through `lime_occt_tree` (`POST /api/model/tree`, or the `model_tree` command). `call` picks the operation. `key` names the tree, and node 0 is its root.

| `call` | Fields | Answer |
|---|---|---|
| `open` | `key`, one of `dataB64`, `stepPath`, or `box: [x, y, z]`; `chordMm`; optional `nodes: [{id, parent, op, fingerprint}]` (parents first) and `current` | The reply for `current` (default 0). Saved nodes are registered, not built. Opening an existing key replaces that tree. |
| `apply` | `key`, `parent`, `node`, `op`, `chordMm`; `otherKey` for a split | The new node's reply, plus `op` as stored (edge picks resolved) and, for a split, `other`. With `otherKey`, `other` is the root reply of a new tree under that key. Applying an existing node with the same parent, op, and `otherKey` is a jump to it; anything else on an existing id is refused. |
| `probe` | `key`, `node`, `op` | `{ok: true}`, or `{ok: false, error, maxMm?}` as the session's dry-run. A probe that works is kept, and an Apply of the same op on the same node commits it. |
| `goto` | `key`, `node`, `chordMm` | That node's reply. |
| `drop` | `key`, `node` | `{dropped, current}`. The node and everything under it go; the current node moves to the parent if it was inside. The root cannot be dropped. |
| `close` | `key` | `{ok: true}`. |
| `distance` | `key`, `node`, `aKind`, `aIndex`, `bKind`, `bIndex` | `{id, distanceMm}`. |
| `export` | `key`, `node` | `{bytesBase64, byteLength}`: AP214 STEP of that node. |

`op` is one of `{kind: "boolean", op, primitive, origin, size, radius, height, turn}`, `{kind: "hole", origin, axis, radius, depth}`, `{kind: "split", origin, normal}`, `{kind: "fillet" | "chamfer", edges, size}`, or `{kind: "scale", factor}`. A fresh fillet or chamfer may name edges by index. The stored op names each as `{index, mid, lengthMm}`, where `mid` is the point at the middle of the edge's parameter range. A rebuild takes the index when its midpoint and length still agree within 0.001 mm, else the one edge that matches them, else the node is broken.

A reply is the session's tessellation with `id` set to the node, plus `fingerprint: {volumeMm3, faces, edges}`, `replayed` (how many steps were rebuilt to answer it), and `held` (the nodes of this tree that keep a solid). A missing tree answers `{error: "unknown", missing: [0]}` and a missing node `{error: "unknown", missing: [id]}`, so the client sends the root and the ops again. A step that fails to rebuild, or rebuilds to a different fingerprint, answers `{error, broken: id}`; that node and everything under it lose their solids and stay unbuilt until it is dropped.

What is kept, per node:

- The solid, with its face and edge maps and the volume the op integrated. Each tree pins its root, its current node, and every eighth node on the path between them. The 24 most recently used other solids stay; older ones are evicted and rebuilt on demand from the nearest kept ancestor.
- The fingerprint, for as long as the node exists. Every rebuilt step is checked against it.
- The reply, per chord, for the 8 most recently viewed nodes across all trees. A jump to one of those does no kernel work.
- An edge's midpoint and length, computed the first time a fillet or chamfer asks.

What is skipped: a rebuild tessellates only the node asked for, never the steps on the way. A split's other piece is tessellated once, for the apply that made it. Jumps never send it again, and replaying the split never touches the piece's own tree. Jumping above a split leaves both pieces in place.

Every call holds the tree's lock for its whole run, so tree calls run one at a time; session calls do not wait for them. Booleans and the split run non-destructively, so building a child or a probe never changes its parent's tolerances. STEP reads and writes take one lock shared with the session, because Open CASCADE keeps their settings globally.

## Viewport handles

Every Model tool is both typed and dragged. Each number in the open tool's panel has a handle in the viewport, drawn in Prepare's gizmo style, and a drag writes the field as if it were typed. The ghost, the dry-run, and Apply follow, and a typed number moves the handle. Shift slows the pointer to a tenth for fine control, and Ctrl (Cmd on a Mac) snaps to the handle's step: 1 mm, 0.5 mm for a blend or hole radius, 0.1 for a scale factor, and 15° for a turn. A label by the pointer shows the value. The panel's scrub labels use the same keys.

| Tool | Handles |
| --- | --- |
| Boolean | X, Y, Z arrows on the primitive's origin, size knobs on a box's faces, radius and height knobs on a cylinder, a radius knob on a sphere, and three turn rings on a box or cylinder |
| Split | a Z arrow on the plane, held between the face margins |
| Fillet, Chamfer | a size knob out from the picked edge's middle |
| Hole | a dot that slides the origin over the solid, plus radius and depth knobs |
| Scale | a factor knob on the diagonal from the centre |
| Measure | two dots, A and B, that slide over the solid; the note reads the distance and ΔX, ΔY, ΔZ |

A box or cylinder turns about its centre by Turn X, then Y, then Z, in degrees; the kernel builds the primitive and applies the same rotation before the boolean. A sphere does not turn. Measure has no Apply. A hole that would miss the solid starts on the middle of its top. `src/model-drag.test.ts` fails if a toolbar tool has no handle, or if a number in its panel cannot be dragged.

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
