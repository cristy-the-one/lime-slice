# Local workplane

A Creo-style U-V-W frame for Model mode. The local UV plane is the face you are working on. W points along its normal. Sketch-like placement — a hole, a box, a cylinder, a split, a boolean — is typed in that frame, with the origin at local (0, 0). W is the extrusion or the cut direction.

This note is the contract. The math is `src/workplane.ts`. The panel and the dock gizmo are the Workplane tool in Model. Nothing here changes the slicer. A part with no workplane, and the global frame the tool starts on, keep today's plate pose and today's G-code.

## What Model already has

Model is the fourth workspace tab (`docs/step-modeler.md`). It is not selected when the app opens. The open solid is a history tree: the client owns node ids and labels, and the Open CASCADE bridge keeps the solids. Tools are New solid, Boolean, Split, Fillet, Chamfer, Hole, Scale, Measure, and Place. Every number is both a field and a dock or feature handle (`src/model-drag.ts`). A dry-run checks a fillet, chamfer, hole, or boolean before Apply, and the note says why in plain words.

**Model space** (`src/model-space.ts`) is the one frame the view draws every object in. Each plate object has `modelPose`, a rigid pose from its own CAD frame into that space. Absent is identity. Tools take model-space numbers. `toSolidOp` turns a boolean, a hole, or a split into the solid's own frame before the engine sees it. Stored ops, replay, and `.lime` trees stay in the solid's frame, so moving a part in model space never renames a step and never changes a cut already made.

**The plate** is a different frame. `orient`, scale, and the bed offset place the mesh for slicing (`docs/part-frame.md`, `docs/plate-placement.md`). The engine slices in the part frame and adds the bed offset when it writes G-code. Place in Model does not touch that pose. A move on the plate in X or Y does not re-slice.

**A primitive** is an origin and a turn (degrees about X, then Y, then Z) in the frame the op is stored in. A box grows from its origin along +X, +Y, +Z. A cylinder's origin is the bottom centre and its height is +Z. A hole is an origin and an axis; with no face picked it drills straight down, −Z. A split is a pivot and a normal. Face mode uses the area-weighted middle of a flat face and refuses a curved one ("Pick a flat face. This one is curved.").

**STEP assemblies.** `load_step` (`crates/lime-slice-core/src/step.rs`) reads each instance's placement and transforms it into the root frame, then merges every closed solid into one mesh. The placement is applied on load. It is not kept as a second body. Model's per-object `modelPose` is the placement the plate object keeps after that. This feature does not split an assembly apart, and it does not change that mesh, so an unedited STEP slices as it does today.

## What the workplane adds

A workplane is a rigid frame in model space, on the plate object, not a kernel op and not a history node:

- **Origin**, the local (0, 0, 0), in model space.
- **Turn**, degrees about X, then Y, then Z, the same order a primitive uses. The columns of that rotation are U, V, and W.
- **Source**: Global, Bed, or Face. The source is how the frame was set. The numbers are what later tools read.

| Source | Frame |
| --- | --- |
| Global | U = X, V = Y, W = Z, origin at the model origin. This is the frame when the object has no workplane stored. |
| Bed | The same axes, origin at the middle of the part's footprint on the bed plane. The bed is the plane already drawn under the part, at its lowest point. W points up. |
| Face | Origin at the area-weighted middle of a picked flat face. W is the outward normal. U and V are the in-plane axes a split already uses (`inPlaneAxes` in `src/model-plane.ts`). A curved face is refused with the same sentence Split uses, and the frame stays where it was. |

The Workplane tool edits the origin and the turn. The fields and the dock gizmo write the same numbers: the U arrow moves the origin along U, and the three origin fields show where it landed; a turn ring and its field are one angle. Shift and Ctrl snap as they do on Place. The tool has no Apply. It moves as it goes, and its button reads Done. One drag, or a typed number once it rests, is one Prepare step.

The frame is drawn as a wire rectangle in the UV plane, lifted a fraction of a millimetre along W so it does not sit in the surface, and a short triad at the origin. The arrows and rings that move it sit on the dock, clear of the solid, in the axis colours Prepare already uses. While the tool is open, a picked face is tinted teal rather than the accent, so it is not the ordinary face selection.

## Where it plugs in

```
fields (local U, V, W) → model space → toSolidOp → solid frame → engine
```

The second arrow is the one this feature adds (`modelPoint`, `placePrimitive`). The third is unchanged. With the global frame the second arrow is the identity, value for value, so a boolean, a hole, and a split send the op they send today.

- **Hole, box, cylinder, and the other primitives.** The origin fields are local U, V, W. The turn is about the workplane axes, then the frame's own turn. W is the primitive's +Z: a cylinder stands along W, a box's height is W. A hole with no face picked drills along −W. A picked face still drills into that face. On the global frame −W is −Z, which is the hole Model already cuts.
- **Split.** X, Y, and Z stay those axes on the global frame. On any other frame they are U, V, and W: the number is the coordinate along that axis from the workplane origin, and the normal is that axis. Face mode is unchanged. The op stored is still only a pivot and a normal in the solid's frame.
- **Boolean with another object, fillet, chamfer, scale, measure, Place.** Unchanged. A join's tool is another object, placed by Place. A blend has no origin. Scale is about the solid's centre.

Moving or rotating the workplane carries those placements because they are stored as local numbers until Apply. The same U, V, W then resolve somewhere else in model space, and the ghost follows. Apply bakes the resolved op into the solid's frame, as every Model step already does, so a replay does not depend on the frame and a later move of the frame does not rewrite a step that has already been cut. The feature you are placing, and any tool whose numbers are still the ones you typed, moves with the frame.

**On the plate.** When the turn is not zero, leaving the gesture sets the object's `orient` so W points up: the mesh rotation is the inverse of the workplane turn, composed with `modelPose` when the part has been turned in model space. The placer already drops the mesh onto Z = 0 and centres it on the bed, so the origin of the placed part sits near the bottom centre of its box. Returning the turn to zero restores the orient from before that tilt, in the same Prepare step. That remembered orient lasts for the visit only. Undoing back onto a tilt remembers the orient being left, so the next return to zero can restore it. Opening a file whose frame is already tilted does not remember one, so choosing Global then leaves the part as it sits, and the panel says so. A global or bed frame, and a face whose normal is already +Z, do not write `orient`. A slice that never had a tilted workplane keeps its pose and its G-code bytes.

**Each body.** The workplane is stored on the plate object, omitted when it is the untouched global frame, so an older file and a version 1 file stay as they are. A duplicate takes the frame, shifted by the same model-space move as the copy. A split piece takes the parent's frame and the parent's `modelPose`, so each piece keeps the local frame and the placement it was cut with. A `.lime` file with a workplane is version 2; an older app ignores the key and drops it on the next save, and the mesh still slices.

## Staged plan

1. **Frame math.** Global, bed, and face. Local point and direction to model space. A primitive's origin and turn. The plate rotation that stands W up. No view, no engine.
2. **The tool.** Panel, dock gizmo, datum, face and bed and global, numeric fields kept in step with the drag. Teal pick while it is open. Prepare undo.
3. **Placement.** Hole, primitive boolean, and split read the frame. The global frame leaves their ops unchanged.
4. **The plate.** A tilted frame sets `orient` once per gesture. Save and reopen. Duplicate and split keep the frame.

The kernel, the slice request, and the G-code writer are not modified. Default G-code stays the bytes of a part that has no tilted workplane.
