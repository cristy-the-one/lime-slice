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

Model mode opens the object's STEP as the root of its history tree (`open` on `POST /api/model/tree`, or the `model_tree` command; see "History tree" below). The reply is the solid's tessellation, volume, face areas, and edge polylines. A STEP of surfaces with no closed solid replies `solid: false`: the readout says it can be measured but not edited, shows no volume, and every tool but Measure is off. A click selects one face or edge and reports its area or length. Shift-click adds or removes a pick. Exactly two picks report the distance. Escape, or a click on empty space, clears the selection. Edits open from the toolbar and run on Apply. The ghost in the view is a local preview, not a kernel result. A mesh file says that measure reads a STEP solid. Nothing is invented when the bridge is missing.

With more than one object on the plate, the others are drawn grey behind the open solid, where they sit relative to it (`src/model-context.ts`). The open object's pose is undone, because the solid is drawn in its own CAD frame, and the others keep theirs. They are not part of any pick, snap, handle drag, framing, bed centring, or size readout, and no tool targets them. The canvas carries `data-context-count` and `data-context` (each object's id and world box) for tests.

The release workflow builds the cdylib after staging the Open CASCADE libraries and copies it into `src-tauri/resources/occt/lib`, next to those libraries. The cdylib's rpath is `$ORIGIN` on Linux and `@loader_path` on macOS.

## Booleans and a plane split

Model mode can fuse, cut, or intersect the open solid with a box, cylinder, or sphere, and it can split the solid with a horizontal plane. The numbers are millimetres in the solid's own frame. A kernel failure is the readout, and the solid is left as it was. There is no mesh boolean behind it.

An edit is a new node in the object's tree; the plate takes it when it commits ("History tree (client)"). The plate's mesh for an edited node is the settled tessellation, written with `encodeStl` under a `.stl` name, so truck is not asked to read the edited solid. The pose stays. Support paint, seam paint, and support edits start empty on a node the plate has not held, because they named another surface; going back to a node the plate held puts its paint back. A split keeps the piece on the negative side of the plane and adds the other piece in the parent's place at once, with the same pose, so the two halves are not parked side by side. Both settle onto the bed, so the plate lists them as overlapping and offers Arrange. The plane starts at mid-height and stays clear of the faces, so a cut on a thin plate cannot leave a sliver. The second piece is the root of a tree of its own (the engine's `otherKey`), so selecting it opens it in Model with no STEP read, and it can be edited and split again. Undo above the split leaves the piece on the plate.

## Fillet, chamfer, hole, and scale

Model mode can fillet or chamfer the picked edge, cut a cylindrical hole, and scale the solid by one factor. The blend size, the hole radius, and the hole depth are millimetres. The hole starts at the origin fields and runs straight down. Scale is about the solid's centre. Fillet and chamfer stay disabled until an edge is picked, and the button's tip says how to pick one. While the numbers change, a dry-run builds the fillet, chamfer, hole, or boolean on a copy and leaves the solid alone. A number being typed or dragged waits 300 ms (`PROBE_WAIT_MS`, sized to typing speed so one number asks once); opening a tool, a pick, the end of a drag, and every other one-off change ask at once. Answers are kept by tree node and numbers (`probeKey`), since a node's shape never changes: undo back to a checked node enables Apply at once. Apply, undo, and redo ask nothing. The numbers just applied leave Apply off, since applying them again would change nothing. The note says it works, or why not, and for a blend the largest size that did. Apply stays off until that check passes. Split and scale are judged from their numbers. The desktop shell runs every Model command off the UI thread. A kernel failure is the readout, and the solid is left as it was. There is no mesh fallback.

A dry-run that works keeps the shape it built; an Apply of the same op on the same node commits that shape instead of building it again. Each resulting shape's volume is integrated once, by the op that made it, and reused for the reply; a scale multiplies the volume by the factor cubed. `lime_model_occt::stats()` counts builds, volume integrations, and tessellations for `tests/kernel.rs` and `tests/tree.rs`.

These edits commit as a boolean does. Pose stays, except that a scale sets the plate's `partScale` back to 1 so the part is not scaled twice; going back to a node the plate held puts its placement scale back.

## History tree (engine)

The bridge also keeps Model history as a tree: one tree per plate object, one node per edit, and a new edit from an older node starts a branch instead of dropping the newer steps. The client owns node ids, labels, and which branch Redo follows. The engine keeps what is costly to rebuild. The kernel operations are in `cpp/kernel.cpp`; the tree's nodes are built with them in `cpp/tree.cpp`.

Every call is one JSON request through `lime_occt_tree` (`POST /api/model/tree`, or the `model_tree` command). `call` picks the operation. `key` names the tree, and node 0 is its root.

| `call` | Fields | Answer |
|---|---|---|
| `open` | `key`, one of `dataB64`, `stepPath`, or `box: [x, y, z]`; `chordMm`; optional `nodes: [{id, parent, op, fingerprint}]` (parents first) and `current` | The reply for `current` (default 0). Saved nodes are registered, not built. Opening an existing key replaces that tree. |
| `apply` | `key`, `parent`, `node`, `op`, `chordMm`; `otherKey` for a split | The new node's reply, plus `op` as stored (edge picks resolved) and, for a split, `other`. With `otherKey`, `other` is the root reply of a new tree under that key. Applying an existing node with the same parent, op, and `otherKey` is a jump to it; anything else on an existing id is refused. |
| `probe` | `key`, `node`, `op` | `{ok: true}`, or `{ok: false, error, maxMm?}`: the edit was built on a copy, or why not and, for a blend, the largest size that fits. A probe that works is kept, and an Apply of the same op on the same node commits it. |
| `goto` | `key`, `node`, `chordMm` | That node's reply. |
| `drop` | `key`, `node` | `{dropped, current}`. The node and everything under it go; the current node moves to the parent if it was inside. The root cannot be dropped. |
| `close` | `key` | `{ok: true}`. |
| `distance` | `key`, `node`, `aKind`, `aIndex`, `bKind`, `bIndex` | `{id, distanceMm}`. |
| `export` | `key`, `node` | `{bytesBase64, byteLength}`: AP214 STEP of that node. |

`open` reads STEP so that facet shells that sew into closed solids open as solids, and surfaces that do not open for measuring only. On such a root every `apply` and `probe` answers the refusal ("This STEP file has surfaces but no closed solid, so it can be measured but not edited.") before anything is built.

`op` is one of `{kind: "boolean", op, primitive, origin, size, radius, height, turn}`, `{kind: "hole", origin, axis, radius, depth}`, `{kind: "split", origin, normal}`, `{kind: "fillet" | "chamfer", edges, size}`, or `{kind: "scale", factor}`. A fresh fillet or chamfer may name edges by index. The stored op names each as `{index, mid, lengthMm}`, where `mid` is the point at the middle of the edge's parameter range. A rebuild takes the index when its midpoint and length still agree within 0.001 mm, else the one edge that matches them, else the node is broken.

A reply is the node's tessellation with `id` set to the node, plus `solid` (false for surfaces with no closed solid), `fingerprint: {volumeMm3, faces, edges}`, `replayed` (how many steps were rebuilt to answer it), and `held` (the nodes of this tree that keep a solid). A missing tree answers `{error: "unknown", missing: [0]}` and a missing node `{error: "unknown", missing: [id]}`, so the client sends the root and the ops again. A step that fails to rebuild, or rebuilds to a different fingerprint, answers `{error, broken: id}`; that node and everything under it lose their solids and stay unbuilt until it is dropped.

What is kept, per node:

- The solid, with its face and edge maps and the volume the op integrated. Each tree pins its root, its current node, and every eighth node on the path between them. The 24 most recently used other solids stay; older ones are evicted and rebuilt on demand from the nearest kept ancestor.
- The fingerprint, for as long as the node exists. Every rebuilt step is checked against it.
- The reply, per chord, for the 8 most recently viewed nodes across all trees. A jump to one of those does no kernel work.
- An edge's midpoint and length, computed the first time a fillet or chamfer asks.

What is skipped: a rebuild tessellates only the node asked for, never the steps on the way. A split's other piece is tessellated once, for the apply that made it. Jumps never send it again, and replaying the split never touches the piece's own tree. Jumping above a split leaves both pieces in place.

Every call holds the tree's lock for its whole run, so tree calls run one at a time. Booleans and the split run non-destructively, so building a child or a probe never changes its parent's tolerances. STEP reads and writes take a lock of their own as well, because Open CASCADE keeps their settings globally.

## History tree (client)

`src/model-tree.ts` is the tree as data: nodes with their op, label, and fingerprint, `current` (what Model shows), `committed` (what the plate holds), and which child Redo follows. `src/app/model-trees.ts` keeps one tree per plate object, by the key the object carries as `modelTree`; the engine uses the same key.

- **Apply** sends `apply` with the shown node as `parent` and a fresh id, and shows the new node. From a node that has children it starts a new branch and Redo follows it; the old branch stays. Numbers already applied from this node jump to that step instead of building it again.
- **Undo** jumps to the parent and **Redo** to the child last applied or jumped through; the buttons, Ctrl+Z, and Ctrl+Y do this. At the root Undo is off, and Ctrl+Z in Model never reaches Prepare's history.
- **A jump** to one of the four nodes shown last draws the solid the client kept and asks the engine nothing. Any other jump asks `goto`.
- **The plate commits lazily.** Apply and jumps change only the tree and the view. The plate takes the shown node when Model closes, and before a slice, a G-code or 3MF export, a send to the printer, a project save, a switch to another object, a duplicate, or Arrange. Committing saves the paint, support edits, and placement scale of the node it leaves, and puts back those of the node it takes, if the plate held it before. A node the plate held keeps its mesh bytes, so going back to it gives the plate the same bytes, and a slice of them is found in the cache. Each Model visit that changed the plate is one Prepare step, and Prepare undo of it finds its node again by the mesh it restores, in any tree of that object. When the plate takes a node below a split whose piece a Prepare undo took off, the piece comes back.
- **A copy** of an edited object (Duplicate) gets a tree of its own, rooted in the STEP of the step it copies.
- **A forgetful engine** (a restarted `serve`) answers `{error: "unknown"}`. The client opens the tree again with the root STEP and every saved op, then asks once more. A split piece's tree comes back by running its split again on a spare node of its parent tree, which is then dropped.
- **A broken node** (`{error, broken}`) is marked with everything under it; the readout says the step cannot be rebuilt, and the client does not ask for it again.
- **Release.** A tree stays while a plate object or a Prepare step can reach it as Model would find it: by its key; by a step whose plate mesh the object holds, in a tree of that object (after a Prepare undo to before the object had a key); for an object with no key, by any tree with its mesh (a copy finding the step it copies); and from each of those, the tree a piece was split from and the pieces its splits made. Each time a Prepare step lands (which can push the oldest step out or clear the redo steps), the other trees are dropped here and closed in the engine. So a removed object's tree stays exactly as long as Prepare undo can bring the object back.

### Saved with the project

A project saves each plate object's tree as `modelTree`, next to its `brep` ("STEP save"):

```
modelTree: {
  nodes: [{ id, parent, op, name?, fingerprint, piece? }],   // root first, parents before children
  current, committed, nextId,
  rootStep: { name, bytesBase64?, byteLength, hash }
}
```

- `op` is the op as the engine stored it, so a fillet or chamfer keeps each edge as `{index, mid, lengthMm}` (a bare index only if the engine did not echo the op). Labels are not saved; they come from the ops, and the root's from the object's name.
- `rootStep` is written once per tree. When the file already holds those bytes (the object's own mesh or `brep`, another object's, or an earlier root, as for a copy), it is written without `bytesBase64` and read from the record with the same hash and length.
- A split piece's tree is saved with the STEP of its own root (written at save if Model has not written it), so it opens without the part it was cut from. A split names its piece by the piece's plate object id, and only while that object is on the plate and its tree is saved. If the engine cannot write the piece's root, that tree is not saved, a notice after the save names the part, and after a reopen its split no longer counts as having made a part.
- `fingerprint` is null for a step built on a reopened project's plate step (see below): the engine rebuilds it from the root without checking, and the client keeps the numbers of that first rebuild.
- Saved: the tree Model would resume for the object's mesh (by its key, or the object's other trees as after a Prepare undo), when it has a step, a name, or a piece that a saved split names. Not saved: engine keys, shapes, replies, broken marks, which child Redo follows, and the paint and meshes of steps the plate does not hold. Trees of objects that are no longer on the plate are not saved.

On open, each tree gets a fresh key (`freshTreeKey`), so a file opened twice, or two files one after another, never meet in the engine. Nothing is sent until Model needs a step. The plate's step opens from the object's `brep` alone, as a STEP file does, and the engine numbers it as its root (node 0) while the client keeps its own id; edits build on it. A call on any other step first opens the whole tree: `open` with the root STEP, every saved op, and `current` set to that step, which the engine rebuilds from the root and checks against its fingerprint. Calls made while that open is on its way wait for it, and share it. The solids and kernel answers kept from the STEP-read step are dropped then, since the engine's steps now come from the root. An STEP round trip can move a solid's volume (Telo test: 14893.28 mm³ read back for 14893.51 built), so steps built on the STEP-read solid are saved and sent with no fingerprint. A tree whose plate step is the root, or whose file has no `brep` (the engine could not write the plate's step), opens whole at once. After an engine restart, the plate's step opens from its STEP again if nothing was built on it, else the whole tree opens.

After a reopen no Prepare step from before the save exists, so Delete branch keeps the root, the branch with the plate's step or the shown step, and a split whose piece is on the plate. A tree the file cannot read (a missing parent, an unknown op, a plate step not in it, a damaged or missing root STEP) is left out: the part opens from its mesh and `brep`, and one notice names it.

## History panel

The open solid's tree is a panel at the bottom left of the Model canvas, under the open tool and above the size chip and the readout (`src/ui/model-history.ts`). `src/model-history.ts` is its layout as data: one row per node, oldest first, drawn as a git graph. The shown step's path runs down the main rail; a fork lists its side branches right under it, each in a column of its own. The shown step has a filled dot and a bold label, the steps Redo would walk are dimmed, a broken step has a warning icon with its message on hover or focus, and the root is the file name. While the view shows a step other than the one the plate holds, the plate's row has a "Plate" chip.

- **Labels** come from the op with the panel's number format: "Cut box 10×10×10", "Hole ⌀5 depth 8", "Fillet 3 edges r 1", "Split at Z 42", "Scale 200 %". A renamed step (double-click the label, or F2) shows its name, and the op stays in the tip. The name is saved with the project.
- **Moving.** A click or Enter shows that step. Up, Down, Home, and End move and show the step after a 200 ms pause (`JUMP_WAIT_MS`), so a run of presses asks the engine for the last one only. Left and Right switch to the next branch at the nearest fork, at the same depth or that branch's last step. A newer jump wins over one still on its way: the late reply is kept in the client's recent solids and not shown. A step already on its way is not asked for again. While a jump is on its way, Apply, Undo, Redo, and STEP are off. A press still in its pause when Model closes does nothing.
- **Rows do not move under the pointer or the keys.** While the pointer is over the panel or focus is in it, each fork keeps the branch it followed; when both leave, the shown step's path moves onto the main rail.
- **Delete branch** (the row's menu, or Delete) drops the step and everything under it, here and with the engine's `drop`. It is refused, with the reason in the menu and the readout (in the sheet at phone width), for the root, a branch that holds the shown step or the plate's step, a branch with a step the plate held before (a Prepare undo can put its mesh back), and a branch whose split made a part of its own. There is no undo for it, so it asks for no confirmation. Model never closes a tree because the plate's mesh is not in it: a Prepare undo or redo can bring one of its meshes back.
- **Keys.** Shift+H goes into the panel from anywhere in Model, opening it if needed, and back out; Esc leaves it. Shift+F10 or the menu key opens a row's menu. The list is a `tree` with `treeitem` rows (`aria-level` is the branch depth, a fork has `aria-expanded`, the shown step is `aria-selected`) and one row in the tab order. Branches never fold away, so a fork stays expanded, and Left and Right switch branches instead of folding them. The tree is `aria-busy` while an arrow press waits out its pause. Leaving the panel puts focus back where Shift+H came from, else on the canvas.
- **Collapsed** to its header ("History · 7") it stays collapsed for that browser (`localStorage`). At phone width it is a sheet over the canvas, opened from the History button in the Model toolbar.
- **Cost.** Rows are patched by node id when the tree value changes, and not built at all while the panel is collapsed, the sheet is closed, or Model is hidden. Drawing asks the engine nothing.

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

Model mode writes the open solid as AP214 IS, a manifold solid B-rep, through `STEPControl_Writer`. The STEP button downloads that file. The same bytes are kept on the plate object as optional `brep`, in the same shape as `mesh`: name, base64, length, and hash. An edit does not write them. The STEP of the node each plate object holds is written when it is needed: leaving Model (in the background), a project save, and the STEP button (which writes the shown node). A written STEP goes to every plate object and Prepare step whose mesh token (`meshTokenOf`) is that node's mesh, so a step captured before the write gets it too, and to the node, so the plate gets it back when it returns there. Prepare steps share each STEP buffer rather than copy it. A solid the engine can no longer write loses its `brep` at save rather than keep one from an older shape. Prepare history folds a Model visit that changed the plate into one step on leaving Model; the tree keeps the steps in between.

`.lime` stays version 2. A one-object file with `brep` or `modelTree` is version 2 so the field is not dropped. The tree's format is under "Saved with the project". A file without it still opens, including one saved before this field existed. A damaged `brep` fails the open. An older app ignores the keys, slices the mesh, and drops `brep` and `modelTree` on the next save. Duplicate copies the bytes. The second piece of a split gets its own `brep` when its STEP is written.

Opening Model reloads `brep` when the object has one, so an edited solid is not stuck as a mesh. The STL is what the slicer reads. Opening Model still does not replace `sourcePos`.

## What this change is not

- No change to `tools/golden_ab.sh` or to slicer output.
- The slicer core does not link Open CASCADE. Truck still reads an unedited STEP file for slicing.

## Review questions

1. Is dlopen of `lime-model-occt`, with the shell depending only on `lime-model-load`, the right way to keep startup free of the libraries?
2. Is reading STEP in Model mode, while FreeType and OpenGL stay off, acceptable given that `TKDESTEP` pulls `TKV3d` and `TKService`?
3. Is a stub compile when `OCCT_ROOT` is unset the right default for a local slicer build?
