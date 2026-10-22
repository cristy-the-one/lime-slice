# Plan: split a solid into printable parts

Status: plan, for review. Written 2026-10-22 against `main` at v3.7.0 (`5d1e7e9`). No code in this change.

A long solid can be cut into parts that fit the bed, printed separately, and put back together. Connectors and shaped joints are available on every cut. Each one is off until the user turns it on. A plain planar cut, with no peg and no step, is a complete use of the feature.

## 1. Goal

A person, or an MCP client, can:

1. Cut a solid with one or more planes, typed or dragged, and with **Fit the bed** when the part is larger than the printer.
2. Shape any cut with a profile: straight, lap, zig-zag, tongue-and-groove, dovetail, or a sketch. Every size on that profile is typed or dragged, and the history row rebuilds from those sizes.
3. Add connectors on a cut: peg and hole, pin, rectangular key, or a discrete dovetail. Type, count, size, depth, placement, and clearance are each adjustable. Zero connectors is valid.
4. Lay the parts on the bed so the joint can be printed, with a number on each part, and edit the whole thing later from one history row.

The existing Split tool stays as it is. Shortcut `D`, the rail button, and `{kind: "split", origin, normal}` are unchanged. This feature is a different op, `partition`, opened from the Features menu.

### Non-goals

- No new rail button and no new shortcut. `MODEL_TOOLS` in `src/model-drag.ts` does not grow. The stress command test is the pattern (`src/sim/study.test.ts`).
- No edit to `crates/lime-slice-core`, the G-code writer, or a slice cache key. Golden G-code stays byte-identical.
- No mesh boolean and no new geometry library. The cut is Open CASCADE, which the modeler already links.
- No GPL or LGPL code added. The sketch solver stays the in-house one in `src/sketch/solve.ts`. PlaneGCS and SolveSpace stay out.
- No network. Clearances and profiles are data in the repo.
- No phone layout of its own. The menu item is the one the desktop uses.
- No change to project version. It stays 4.
- Separate shells (`replaceWithShells` in `src/plate.ts`) stays the mesh path. A mesh has no solid to cut.

## 2. Defaults are essential, and every one is optional

A default exists so the first Apply can produce a printable result. It earns its place by a rule tied to the nozzle, the layer height, the material, or the bed, and by a test that locks the rule. A number that is a judgement about fit, rather than a printability floor, is labelled **Starting fit** until the calibration coupon in milestone M6 has been printed and the table updated. The panel and the MCP use that sentence. They do not call a starting number a measurement.

Nothing in the list is mandatory. The control in the last column is how the user turns that default off or replaces it. Turning one thing off leaves the others alone. Connectors off, profile straight, and one plane is a plain cut.

The numbers live in one table in `src/modeling/partition.ts`. The panel, the MCP, and the unit test read that table. A second copy is a bug.

The plate's nozzle is `profile.nozzleDiameter` (0.4 mm on the built-in printers). The layer height is the preset's `layerHeight` (0.2 mm in `src/app/state.ts`). The bed is the active printer's build volume. Lime 220 is 220 × 220 × 250 mm (`src/ui/machine-library.ts`). The thin-wall floor is the one `model_check` already uses: twice the nozzle (0.8 mm at 0.4 mm).

| Default | Value | Why this is a sound default | How to turn it off or override it |
|---|---|---|---|
| Cut profile | Straight | A plane adds no material, keeps the parent's volume, and leaves a flat face. `build_split` and `tests/kernel.rs` already lock that path. | Profile menu on that cut: Lap, Zig-zag, Tongue, Dovetail, or Sketch. |
| Connectors | Off | A connector that does not fit the section would thin a wall. Off cannot do that, and a plain cut has to be possible. | **Connectors** on that cut. Count 0 is the same switch. |
| Connector type, once on | Peg and hole | The peg stands up and the hole drops into the bed. Both are round features the kernel already builds (`BRepPrimAPI_MakeCylinder`, the Hole tool). A dovetail undercuts; a peg does not. | Type menu: Pin, Key, or Dovetail. |
| Radius | `max(3, 4 × nozzle)` mm → 3 mm at 0.4 mm | Four nozzle widths is the floor a unit test locks, so the peg is more than a single perimeter. 3 mm is the grip size the coupon prints. Below the floor the field refuses. | Type or drag Radius. |
| Count | Fit: as many as the section holds at a pitch of `4 × diameter` | A fixed count of 4 misses a short part and crowds a thin one. Fit places one when one fits, and more only while the wall floor holds. | Type Count. That cut leaves Fit and uses the typed number. 0 turns connectors off. |
| Placement | One row through the section's centre, along U | The centre is inside a convex section. The inset keeps the wall floor. | Drag a peg. That peg becomes fixed millimetres. **Refit** puts the cut back on Fit. |
| Margin | `max(radius + 2 × nozzle, 3)` mm | The socket stays inside the outline by the thin-wall floor, plus the peg's own radius. | Type or drag Margin. |
| Depth | `min(allowance, max(4, 8 × layerHeight))` mm → 4 mm at 0.2 mm layers | Eight layer heights is the floor the test locks. 4 mm is what the coupon grips. Allowance is half the piece's thickness along the normal, minus the end gap, minus the wall floor. Under four layer heights the connector is left out and named. | Type or drag Depth. |
| Clearance | Each side, from the material table below. PLA snug is 0.10 mm | The hole is larger than the peg by this gap on the radius. It is tied to the filament on the plate and to a 0.4 mm nozzle with XY compensation at 0. It is a starting fit, not a measured one, until M6. | Fit menu: Snug, Loose, Press, or a typed Clearance. |
| End gap | `max(0.4, 2 × layerHeight)` mm → 0.4 mm | The socket is deeper than the peg by two layer heights, so the peg does not bottom out. The test locks the formula. | Type End gap, including 0. |
| Peg side | Positive side of the cut normal | Matches Split, which keeps the negative side on the original object. One side holds every peg on that cut, so pairs stay obvious. | **Peg side** flips it. |
| Opening cuts | Fit the bed when the part does not fit; none when it does | An oversized part cannot print as one piece. The proposal is straight cuts, connectors off. A part that fits the bed gains no cut by itself. | **Clear cuts**, or delete and drag rows. Apply with an empty list is refused. Nothing is cut until Apply. |
| Bed margin | Brim width when adhesion is brim (5 mm in `state`), else 5 mm | The piece, including a peg that sticks out, stays inside the volume Check uses, with room for a brim. | Type Margin from the bed edge. |
| Max pieces | 12, hard stop 24 | A 2 m bar on a 220 mm bed with the margin is under 12. The hard stop bounds the boolean count and the 60 s kernel budget. | Type Max pieces, from 2 to 24. |
| Cut position, when adding one by hand | Middle of the part along the chosen axis | The same place Split opens. It is inside `split_reject`'s margin (2 %, at least 0.25 mm, and the 0.25 mm piece floor). | Type At X, At Y, or At Z, or drag the plane. |
| Tilt | 0° / 0° | An untilted plane is the bed-aligned cut. Split opens untilted for the same reason. | Tilt A and Tilt B, typed or on the ring, clamped at ±85° as Split is. |
| Lap depth | `max(8, 6 × nozzle)` mm → 8 mm | Six nozzle widths is the floor. 8 mm is the glue overlap the coupon prints. | Type or drag Depth on that lap. |
| Lap height | Half the section along V, and each shoulder at least `max(3 × layerHeight, 2 × nozzle)` | Half keeps both shoulders printable. A part too thin for two shoulders refuses the lap and says to use Straight. | Type or drag Height. |
| Zig-zag pitch | `max(10, 8 × nozzle)` mm → 10 mm | Eight nozzle widths keeps each tooth printable. The tooth width is half the pitch. | Type or drag Pitch, or type a tooth count and the pitch follows. |
| Zig-zag depth | `max(3, 6 × layerHeight)` mm → 3 mm | Six layers so the tooth is a real step, not one layer. | Type or drag Depth. |
| Zig-zag angle | 0° from the normal | Flanks are square to the bed when the joint is horizontal, so they are vertical walls. | Type or drag Angle. |
| Tongue width | `max(6, 6 × nozzle)` mm → 6 mm | Same printability floor as a peg's diameter. | Type or drag Width. |
| Tongue depth | `max(3, 6 × layerHeight)` mm → 3 mm | Same layer rule as a tooth. | Type or drag Depth. |
| Dovetail width | `max(8, 8 × nozzle)` mm at the wide end | The narrow neck must stay at least two nozzle widths. A width and angle that pinch the neck are refused. | Type or drag Width. |
| Dovetail angle | 20° from the normal | A mild flank locks against pull-apart and still leaves a printable neck at the default width. The coupon slides this angle at the default clearance. | Type or drag Angle. |
| Dovetail slide | Along U, the long direction of the cut | With the joint horizontal, the undercut is in the bed plane. A slide along the normal would be an overhang. | Slide menu: U or V. W is refused. |
| Sketch profile | A straight line across the section | The sketch starts valid and equal to Straight, so Apply is safe before any edit. | Draw in the sketch. Choosing Straight drops the sketch from the op. |
| Printable joint | On | The female face goes on the bed and the male face points up, so a peg is a post and a hole opens onto the bed. A plain cut puts both flat faces down. | **Printable joint** off keeps the parent's plate orientation. One piece can be unchecked in the piece list. |
| Lay out on the bed | On | Overlapping parts will not print. The gap is `ARRANGE_GAP_MM` (2 mm), the same gap Arrange uses. | **Lay out on the bed** off. The parts stay stacked, and the readout says to Arrange, as Split does today. |
| Part numbers | On | The engraved index is the assembly order along the cut. The font is the stroke font `textStrokes` already uses. | **Part numbers** off. |
| Number height | `max(4, 8 × nozzle)` mm → 4 mm | Eight nozzle widths so the strokes survive. | Type Height on the label. |
| Number depth | `max(0.4, 2 × layerHeight)` mm → 0.4 mm | Two layer heights. Shallow enough to leave the wall, deep enough to read. | Type Depth on the label. |
| Number face | A side face when one exists, else the joint, clear of connectors | The joint stays the mating surface. A missing spot skips that number and names the part. | Drag the number to another face. |

### Clearance table

Clearance is the gap on each side. The hole radius is the peg radius plus this number. The diameter is larger by twice the number. The panel shows both: "0.10 mm each side (0.20 mm on the diameter)."

| Material | Snug | Loose | Press |
|---|---|---|---|
| PLA | 0.10 | 0.20 | 0.05 |
| PETG | 0.15 | 0.25 | 0.10 |
| ABS | 0.15 | 0.25 | 0.10 |
| Anything else, including TPU | — | — | — |

PLA, PETG, and ABS match the filament ids already in `src/ui/machine-library.ts`. Snug is the fit the coupon is built to confirm: the parts stay together and come apart by hand. Loose is for a joint that must slide. Press is for a joint that must not. TPU and any unnamed filament do not get a row. Turning connectors on says "No fit for this material. Type a clearance, or leave connectors off." and leaves the field empty until a number is typed.

Clearance does not scale with the nozzle. Hole error at a given slicer setting is not proportional to the nozzle. The minimum sizes above do scale with the nozzle. Layer height changes Depth, End gap, and the number depth. It does not change Clearance.

XY hole compensation (`xyHoleCompensationMm` in `src/xy-comp.ts`, default 0) is a slice setting. It is not baked into the solid. When it is not 0, the note says "XY hole compensation is N mm. It changes the hole again when slicing. Clearance here is the solid." Elephant's foot is the same: a warning, not a change to the B-rep. Baking either one into the solid would make the part depend on a slicer setting and would put this feature on the slice path.

### The coupon that retires "Starting fit"

One printed bar, 80 × 20 × 10 mm, cut in the middle, one peg of the default radius and depth, repeated at 0.05, 0.10, 0.15, 0.20, and 0.25 mm clearance, in the plate's filament, nozzle 0.4 mm, layers 0.2 mm, XY compensation 0. A second bar carries the default lap, the default tongue, and the default dovetail. M6 generates both bars as solids. A person prints them. The clearance that snug actually was replaces the PLA snug cell, the label **Starting fit** comes off that cell, and the test expects the new number. Until that print, the sentence stays.

## 3. What this builds on

| Piece | Where | What this uses it for |
|---|---|---|
| Plane split | `build_split` in `crates/lime-model-occt/cpp/kernel.cpp`, `BRepAlgoAPI_Splitter` | The straight cut. Same plane face, same `split_reject`, same 0.25 mm floor, same `as_solid`. |
| One other piece | `otherKey` on apply, `piece` on the node, `rebuildPiece` in `src/app/model.ts` | The pattern for a second tree. Partition carries a list, because a cut can make more than two parts. |
| Split panel | `src/model-plane.ts`, Split's X Y Z Face, Tilt A, Tilt B | Axis, position, tilt, and the plane drag. Face is not a profile; it is a way to aim the plane. |
| Sketch | `src/sketch/`, in-house solver in `src/sketch/solve.ts` | A custom profile. The kernel never reads `sketch`. The solved chain is what it sweeps. |
| Feature strip | `featureStrip` in `src/app/sketch.ts` | Left-aligned form, Apply as the primary button, How popover, title within 40 characters (`TITLE_LIMIT` in `src/sketch/hints.ts`). The partition panel follows those rules. It is not a fifth mode of the strip. |
| Heads-up number | `src/interact/hud.ts`, `src/modeling/expr.ts` | Typing a size while dragging, Tab to the next size, expressions, the ƒ mark. |
| Dimension highlight | `docs/ui-review-3-1.md`, `src/model-drag.ts` | Hover, drag, or focus lights only the dimension that handle changes. |
| Text | `textStrokes` in `src/modeling/text.ts` | Part numbers. No new font. |
| Thin walls | `src/modeling/thin.ts`, `model_check` | The wall floor around a socket. |
| Fit | `model_check`'s `buildVolumeMm` | The same volume Fit the bed uses. |
| Plate | `src/plate.ts`, `ARRANGE_GAP_MM`, `layFlatMatrix` in `src/mesh-place.ts` | Several objects, arrange, orientation. Model pose stays the assembly (`src/model-space.ts`). |
| History | `src/model-tree.ts`, `src/model-edit.ts`, `src/ui/model-history.ts` | One parametric row. Edit reopens the panel and replays. |
| Parameters | `parameters` on the project, `exprs` on the op | Any size can be `wallH / 2`. Stripped before the engine call. |
| Menu | `#modelFeatureMenu`, Stress at `#modelMenuStress` | Where the command lives. |
| MCP | `model_probe`, `model_apply`, `model_edit` in `mcp/schema.ts` | The same op the panel writes. |
| Stress | `sim` on the plate object, `docs/plan-stress-simulation.md` | Left in place on the object that keeps its id. A new solid makes that study stale by the fingerprint rule. This feature does not run a study and does not add a multi-body solve. |
| Deadline | 60 s kernel budget already in the modeler | A partition that runs past it stops, nothing changes, and the existing sentence is the error. |

Model space and the plate stay the two frames they are. Cuts, profiles, and connectors are stored in the solid's own frame, as every op is. `toSolidOp` turns a plane typed in model space into that frame. Profile sizes are scalars. The plate orientation is the print, and it is not a history op.

## 4. Decisions

### D1. A new op, `partition`

`{kind: "split"}` means one plane and two solids, and the reader allows `piece` only on that kind (`readSavedTree` in `src/model-tree-file.ts`). Overloading it would change a shipped op.

`partition` is one history node. The spec is the op. Edit reads it back. It is not a `group` of booleans: a group returns one solid, and this feature returns one solid per part.

An older app fails `readOpBody` on an unknown kind, `readSavedTree` returns null, and the part opens from its mesh with the damaged-tree notice. The meshes of the parts are ordinary plate meshes, so the print is still there.

### D2. The cut frame

Each cut has an origin and a unit normal W. U is an axis in the plane, the direction a profile is swept. V = W × U. U defaults to the longer side of the section. The user can swap U and V.

A profile is a curve in the (V, W) plane, swept along U past the part's bounding box by 1 mm. Straight is the line W = 0, which is the plane Split would use.

### D3. Straight cuts may meet. Shaped cuts are parallel

Fit the bed only emits parallel planes along one axis. A later cut the user turns becomes a shaped profile only when its normal matches the shaped cuts already in the list. A turned shaped cut is refused with "A shaped cut has to be parallel to the other shaped cuts." Straight cuts may meet at an angle. The splitter already classifies solids by which side of each plane their centre of mass is on.

### D4. Connectors are a list on the cut, and the first panel edits one

The file stores `connectors.types[]`. The first panel edits a single type per cut. A later milestone can show two rows, a peg and a pin, without a format change. An empty list and `"on": false` are the same plain cut.

### D5. Placement is fractional until the user drags

A Fit connector stores its position as fractions of the section's box in U and V. Replay applies the fractions to the new section, so an edit above the cut keeps the pegs centred. Dragging a peg stores absolute millimetres in the cut frame and marks that peg fixed. A fixed peg that lands outside the section, or inside the wall floor, is left out and named. It is not moved quietly.

### D6. The kernel cuts. The planner only proposes

`src/modeling/partition.ts` is pure TypeScript. It places planes, profiles, and connectors, and it returns warnings. The panel and `model_partition_plan` both call it. The kernel builds the solids and checks them. On Apply, the op stores the connectors that were actually built (`placed`), so a replay builds those and does not discover a new set. **Refit** clears `placed` and runs the planner again.

### D7. Pieces stay paired because the ids are in the op

A connector id is `c{cut}-{index}`. The peg is fused to one piece and the socket is cut from the mate. The kernel refuses a spec that names a peg without its socket. Piece order is along W of the first cut, negative to positive, then along the next cut. Part numbers follow that order.

### D8. One object keeps the plate id

The piece on the negative side of the first cut keeps the parent's plate id, tree, and `sim`. The other pieces are new plate objects and new trees, rooted as pieces of this node. Paint, seam paint, reinforcement, and support edits on a new piece start empty, as they do for a Split piece. The kept object's study is stale because the solid's fingerprint changed. The readout says so. The other pieces have no study.

### D9. Edit replaces every piece of this partition

Today, editing a Split leaves the old second piece on the plate and `olderSplitNote` explains it. That would desync a peg from its hole. Update rebuilds every piece of this node in the same Prepare undo step as the edit. Later steps on a piece are replayed when that piece's index still exists. A step that no longer builds is kept in the tree and the row says why, and the piece on the plate is the partition's new solid. The user's later hole is not deleted from the history.

### D10. The menu, not the rail

**Split to print…** is a menu item in `#modelFeatureMenu`, after Stress. Command id `model-split-print`, group Model, no `keys`, keywords `split cut connector peg bed`. The `?` sheet lists a command only when it has a shortcut, so this one stays off that sheet. Choosing it opens the tool card in the Model dock, the slot Split's card uses, and Apply closes it. It is not `data-tool` and not a lasting dock section.

## 5. Defining the cuts

### By typing

Each cut is a row. The row has At X, At Y, or At Z, the number in model space, and Tilt A and Tilt B. On a local workplane the axes are U, V, and W, as Split's are (`docs/local-workplane.md`). **Face** aims the plane at the picked flat face plus an offset, and then the cut is stored as origin and normal, so a replay does not depend on face numbers. A curved face is refused with Split's sentence: "Pick a flat face. This one is curved."

Every number accepts an expression. The text is stored on `exprs` and stripped before the engine call.

### By the mouse

Dragging the plane moves At X, At Y, or At Z along the normal, the same mapping as Split (`src/model-drag.ts`). Ctrl snaps to whole millimetres. The heads-up field types the number. Tab moves to Tilt A, then Tilt B. The plane's outline is the only thing that lights for that handle.

Adding a cut drops a plane at the middle of the remaining largest piece. Deleting a cut removes its profile and its connectors with it.

### Fit the bed

The planner reads the part's box in the print frame and the printer's build volume.

1. Usable length along an axis is the bed minus twice the bed margin, minus whatever a peg or a profile sticks out of the piece along that axis.
2. When the part fits, the proposal is an empty list and the note says it fits.
3. When it does not, the longest axis that exceeds the usable length is cut into the fewest equal pieces that fit. Positions are then nudged so each plane sits inside `split_reject`'s margin. A part that still exceeds another axis is cut again, parallel to that axis.
4. Above Max pieces, the note says how many it would take and adds none. The user raises Max pieces or cuts by hand.
5. The list is a proposal. Apply is what cuts. **Clear cuts** removes the proposal.

A 500 mm bar on a Lime 220, margin 5 mm, usable 210 mm, is three pieces. That example is a unit test.

### Several cuts

The op stores `cuts[]` in order. Parallel cuts slice a bar into a chain. Meeting straight cuts slice it into a grid. The preview tints each piece. The piece list under the fields names them in assembly order.

## 6. Cut profiles

The profile is the shape of the whole joint. Connectors are separate features sitting on that joint. A lap with connectors off is valid. A straight cut with pegs is valid. Both off is the plain cut.

The profile menu is per cut. Its parameters are on that cut, typed or dragged, stored on the op, and rebuilt on edit.

### Straight

The splitter tool is the plane face `build_split` already builds. No extra size.

### Lap

A step in the (V, W) plane. Depth is the overlap along W. Height is where the step sits along V, measured from the section's low side. The shoulders have to clear the layer and nozzle floors in the defaults table. The side menu chooses which piece carries the overlap.

Drag Height and the step line moves along V. Drag Depth and the overlap moves along W. Each handle lights only that segment of the profile ghost.

### Zig-zag

A square wave along U, swept so the teeth run the length of the joint. Pitch is centre to centre. Depth is the tooth height along W. Angle leans the flanks; 0° is square. A tooth narrower than two nozzle widths at its tip is refused. Drag Pitch along U. Drag Depth along W. Drag Angle on the flank.

### Tongue and groove

A ridge along U. Width is the tongue along V. Depth is how far it stands along W. It stops Margin short of each end of the section so it does not break out of the sides. The groove is the tongue grown by Clearance on each side and by End gap at the bottom. The same Clearance field as a peg, so a cut has one fit.

### Dovetail

The tongue's tip is wider than its root by Angle from W. Slide is U or V. The neck check uses the nozzle floor. With **Printable joint** on, the undercut lies in the bed plane. Slide along W is refused because that undercut would be vertical.

### Sketch

**Sketch** opens the sketch card on the profile plane: the sketch's U is the cut's V, and the sketch's V is the cut's W. The user draws an open chain. The in-house solver and the driving dimensions are the typed sizes. The mouse is the sketch's existing draw and drag. The chain has to reach past both sides of the section. The kernel extends the ends to the box and sweeps the chain along the cut's U. A chain that crosses itself is refused with the profile sentence already used for sketches: "The profile crosses itself."

The sketch is stored on the cut as `sketch`, the same kind of payload an extrude stores, and every engine request drops it. Choosing Straight removes `sketch` from the op. Edit of a sketch cut reopens the sketch card with the chain, then the partition panel.

`featureStrip()` keeps its four features: Extrude, Revolve, Loft, Sweep. The profile sketch uses the sketch card's draw tools and dimensions. The partition's Apply sits on the tool card, and it is the primary button. The status title stays within 40 characters ("Lap joint" , "Sketch profile"). The How popover carries the steps. No new shortcut is added to the sketch.

## 7. How the solid is cut

The cut is a B-rep in `lime-model-occt`. There is no mesh boolean behind it.

For each cut the kernel builds a tool:

- Straight: the finite plane face `build_split` builds, large enough to clear the bounding box.
- Any other profile: the profile wire swept with `BRepPrimAPI_MakePrism` along U, as a shell.

One `BRepAlgoAPI_Splitter` call takes the solid and every tool. `SetNonDestructive` is on, as in `build_split`. Each resulting solid is classified by which side of each cut its centre of mass lies on. Solids on the same side are fused, then passed through `as_solid`. `ShapeFix_Solid` closes a shell that came back open. `BRepCheck_Analyzer` has to accept each piece. A piece that is not one closed solid fails the op and the parent is unchanged.

The splitter sews the section into each piece, so the cut face is part of the solid. A straight cut of a box produces two solids of seven faces each: the original faces split, plus the cap. That face count is a test. A profiled cut's cap is the swept profile, and its area matches the section area within 1e-4 mm² on a box.

Connectors run after the split, on the pieces:

- A peg is `BRepPrimAPI_MakeCylinder`. It is started 0.001 mm inside the face so the fuse overlaps, the same overlap `faceExtrude` uses, then fused with `BRepAlgoAPI_Fuse`.
- The socket is a cylinder of radius plus clearance, longer by the end gap, cut with `BRepAlgoAPI_Cut`.
- A key or a dovetail is a prism of its trapezoid or rectangle, fused on one side and cut, grown by clearance, on the other.
- A part number is a shallow cut of the stroke boxes from `textStrokes`.

Volume, for a straight cut with no connectors, sums to the parent within 1e-6 mm³ on a box, and within 1e-4 mm³ on a curved solid. With connectors, the test computes the box by hand: parent, plus each peg cylinder, minus each socket cylinder. A cylinder's volume is π r² h and Open CASCADE's cylinder is exact; the test uses 1e-6 mm³. The radii are read back from `Geom_CylindricalSurface`, and the socket radius minus the peg radius equals Clearance within 1e-9 mm.

A mesh, or a STEP with surfaces and no closed solid, is refused with "Split to print needs a solid." Measure still works. Separate shells stays available for a mesh.

The plate mesh of each piece is the tessellation at the plate's chord (`STEP_TOLERANCE_DEFAULT` 0.05 mm), written with `encodeStl`, the same path an edited solid uses. The B-rep is the precision authority. The mesh is what the slicer reads, and section 14 says how both are checked.

Preview while a straight plane is dragging is the GPU clip Split already uses, plus a client ghost of the profile and the pegs from the planner. No kernel call runs on mouse move. After 300 ms (`PROBE_WAIT_MS`) the probe mesh replaces the ghost. Apply reuses the probe's shape when the key matches, as other tools do.

## 8. Connectors

Connectors are optional per cut. The switch defaults off. Turning it on adds one connector spec, the peg row from section 2, which the user then edits.

| Type | Sizes | What is built |
|---|---|---|
| Peg | Radius, Depth, Clearance, End gap | Cylinder fused to the peg side, larger cylinder cut from the mate. |
| Pin | Radius `max(1.5, 2 × nozzle)`, Depth `max(2, 4 × layerHeight)`, Clearance from the Press column | A short peg for location. The same builder as Peg. |
| Key | Width along U, Height along V, Depth along W, Clearance | A rectangular prism pair. |
| Dovetail | Width, Angle, Depth, Slide, Clearance | One sliding trapezoid pair. The edge dovetail is the profile; this is a single key. |

Pin, Key, and Dovetail use the sizes in section 2 the moment that type is chosen. Each size is still editable and each can be cleared by switching the type or by turning connectors off.

The peg axis is W. Placement prefers the region of the joint whose normal is W, so on a lap the peg sits on the overlap, not on the riser. A peg dragged onto a flank steeper than the support angle (45°) warns "This peg leans more than 45°. It will need support."

## 9. Pairing, thin walls, warnings

The planner places connectors in the cut frame:

1. Inset the section polygon by Margin.
2. For Fit, walk a row through the centroid along U at the pitch, and keep a centre that lies in the inset.
3. Reject a pair whose socket comes within the wall floor of the outline, of another socket, or of a hole in the section.
4. A typed count that does not fit keeps the ones that do and names the rest.

The kernel repeats the inside test on the real solid. A connector whose tool misses the piece, or whose result fails `BRepCheck_Analyzer`, is dropped. The reply lists `placed` and `dropped`. Apply stores `placed`. The panel says "Cut 2: 2 of 4 pegs fit." and offers **Use 2**, which writes that count. Apply is allowed with the pegs that fit. A cut whose every connector was dropped becomes a plain cut, and the note says so.

Warnings are one sentence, the same sentence in the panel and in the MCP:

- "Cut 2: peg 3 would leave a wall of 0.6 mm, under 0.8 mm. It was left out."
- "Cut 1: 2 of 4 pegs fit."
- "This part is 480 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed."
- "No fit for this material. Type a clearance, or leave connectors off."
- "XY hole compensation is 0.1 mm. It changes the hole again when slicing. Clearance here is the solid."
- "Part 2 has no room for a number."
- "A shaped cut has to be parallel to the other shaped cuts."
- "This lap is thinner than two shoulders. Use a straight cut."

A warning that leaves a valid plain cut does not block Apply. A refusal (no solid, plane outside the part, self-crossing sketch, slide along W, over the 60 s budget) blocks Apply and leaves the solid unchanged.

## 10. Print orientation and part numbers

Model pose keeps each piece where it was cut, so in Model the parts still sit together. The plate orientation is separate.

**Printable joint** on:

- A plain straight cut: both joint faces go onto the bed. The cut normal points to plate −Z, and the piece settles onto Z = 0.
- A cut with a peg, tongue, or male dovetail: the female piece's joint goes down, so the hole opens onto the bed. The male piece's joint points up, so the peg is a post. Both are rotations that put W horizontal; the sign is chosen from which side carries the peg.
- A piece with two joints: the larger joint wins, and the note names the face.
- A shaped joint that would touch the bed only on teeth: the note says "The teeth touch the bed." The user can uncheck that piece and lay a side face down.

**Printable joint** off: each piece keeps the parent's plate orientation. **Lay out on the bed** still runs unless it is off too.

**Lay out on the bed** runs `arrangedObjects` with `ARRANGE_GAP_MM`. Off leaves the pieces sharing one spot, and the readout uses Split's sentence about Arrange.

Part numbers are engraved, not a separate object. The string is the index, "1", "2", "3". Height and Depth are the label fields. The face is chosen by the table in section 2, and a drag moves it. A later rename of the plate object does not change the engraved digit, because the digit is geometry. The note under the checkbox says that. **Part numbers** off stores no text and cuts no digits.

Both choices are fields of the op (`orient`, `arrange`, `labels`). Edit shows them again. They are not slicer settings.

## 11. History

The row label comes from the stored op, in the part's own frame, as Split's labels do:

- "Split to print, 3 parts"
- "Split to print, 3 parts, pegs"
- "Split to print, lap, 2 parts"
- "Split to print, sketch, 2 parts"

The pencil reopens this panel on the parent solid, the solid before the op, with the planes, the profiles, the connectors, and the checkboxes filled from the op. Update replaces the node and rebuilds the piece objects (D9). Undo returns the parent and removes the pieces, in the one Prepare step the Model visit already uses for an edit.

The node stores `pieces: string[]`, the engine keys of the piece trees, in assembly order. `piece` stays the Split field. A `pieces` list on a split, or a `piece` on a partition, is a damaged tree.

Changing a parameter that this op's expressions use marks Rebuild, as it does for any other step. Rebuild replays from this node.

```json
{
  "kind": "partition",
  "cuts": [
    {
      "origin": [0, 0, 40],
      "normal": [0, 0, 1],
      "u": [1, 0, 0],
      "profile": { "kind": "straight" },
      "connectors": { "on": false }
    }
  ],
  "orient": "joint",
  "arrange": true,
  "labels": { "on": true, "height": 4, "depth": 0.4 },
  "bedMarginMm": 5,
  "maxPieces": 12
}
```

A lap cut stores `"profile": { "kind": "lap", "depth": 8, "height": 5, "side": "positive" }`. A sketch cut stores `"profile": { "kind": "sketch", "sketch": { "v": 1 } }` and the engine sees the solved chain, not `sketch`. Connectors on:

```json
"connectors": {
  "on": true,
  "types": [
    {
      "type": "peg",
      "radius": 3,
      "depth": 4,
      "clearance": 0.1,
      "endGap": 0.4,
      "count": 2,
      "margin": 5,
      "side": "positive",
      "place": "fit"
    }
  ]
}
```

Absent fields mean the section 2 default. A saved file from before this op has no `partition`, and it opens unchanged.

## 12. UI

**Split to print…** is in the Features menu. The command palette entry has no shortcut. The rail's Split button stays Split.

The card is a left-aligned form in the Model dock. The fields scroll. Apply is the primary button and stays pinned, with Cancel. The status title is short. The steps sit in How.

Rows, top to bottom: the fit note, the cut list, the selected cut's plane, its profile, its connectors, then the piece list with orientation and numbers. **Fit the bed** and **Clear cuts** sit on the cut list. **Connectors** is a checkbox on the selected cut. With it off, the connector fields are hidden, not merely disabled, so a plain cut shows a plain card.

Typing and dragging both write the same fields. The heads-up input is the existing one. Ctrl snaps. Expressions show the ƒ mark.

Hover, drag, or focus lights only the dimension that handle changes, in that axis's colour, with one dimension line. The knob tooltip hides while the dimension is up. The matching field takes the ring. A count, a checkbox, and Max pieces have no edge; they light the field and leave the solid alone.

One name per size:

| Name | What it is |
|---|---|
| Width X, Depth Y, Height Z | The part's own box, in the fit note only. |
| At X, At Y, At Z | Where an axis-aligned plane sits. |
| Tilt A, Tilt B | The plane's tilt, as Split names them. |
| Radius | A peg, a pin, or a round corner. |
| Width | Along U. Tongue, key, dovetail. |
| Height | Along V. Lap step, key's other side, number height. |
| Depth | Along the cut normal. Peg, lap overlap, tooth, tongue, number depth. |
| Pitch | Centre to centre along U. |
| Angle | Degrees from the cut normal. |
| Clearance | Gap on each side. |
| Margin | Inset from the section outline. |
| End gap | How much deeper the socket is than the peg. |

Width X, Depth Y, and Height Z are not reused for a connector. Depth on a connector is along the cut, and the field's full name in the accessible description says so ("Depth, along the cut, 4 millimetres").

No new shortcut. Split's `D` stays. X, Y, Z, and F stay Scale, the front view, and Lay flat.

On a short window the card is the same drawer the other Model tools use. On the phone it is the same menu item in the top strip, opening the sheet. No separate layout.

## 13. MCP

The panel and the tools write the same op. A field that exists in the card exists in the schema. A tool that changes the solid is the same call Apply makes.

| Tool | What it does |
|---|---|
| `model_partition_plan` | Runs the planner. Returns the proposed cuts, the placed and dropped connectors, the fit record `model_check` already returns, and the warning sentences. Does not cut and does not return a mesh. |
| `model_probe` | Accepts `{kind: "partition", ...}`. Returns volume and box per piece, `placed`, `dropped`, and the sentences. The solid is unchanged. |
| `model_apply` | The same op, after a probe or with `probe: true`. One undo step. Then `model_commit`, as for any other edit. |
| `model_edit` | Replaces the node from the same op the pencil writes. |
| `model_history` | The row label. `model_goto`, `model_undo`, `model_redo`, `model_drop`, and `model_rename` work because the node is an ordinary step. |

`lime://guide/model` gains a short sequence: plan, probe, apply, commit, and the plain-cut op with connectors off. Replies stay small. The mesh stays in the engine for the app.

A client that sends `connectors: {on: false}` and `"profile": {kind: "straight"}` gets the plain cut. Omitting those fields is the same, because absent means the default, and the default connector state is off.

## 14. Tests and precision

Precision is the B-rep, not the triangles.

| Check | Tolerance | Where |
|---|---|---|
| Straight cut of a box, volumes sum to the parent | 1e-6 mm³ | `crates/lime-model-occt/tests/partition.rs` |
| Curved solid, volumes sum | 1e-4 mm³ | the same |
| Peg and socket on a box, against π r² h | 1e-6 mm³ | the same |
| Socket radius − peg radius = Clearance | 1e-9 mm | radii from `Geom_CylindricalSurface` |
| Lap step face at the typed Height | 1e-6 mm | plane of that face |
| Each piece is one solid, `BRepCheck_Analyzer` valid, every edge shared by two faces | exact | the same |
| A box cut once has seven faces a half | exact | the same |
| Each placed id has one peg and one socket, coaxial | 1e-6 mm | the same |
| Tessellation at chord 0.05 mm has no free edge longer than the chord | chord | mesh check on the kernel mesh |
| Planner: 500 mm bar, 220 mm bed, 5 mm margin → three cuts | exact positions | `src/modeling/partition.test.ts` |
| Planner: a thin section drops the peg and keeps the cut | the warning sentence | the same |
| Planner: two pegs cannot sit closer than the wall floor | exact | the same |
| Defaults table formulas at nozzle 0.4 and 0.8, layer 0.2 and 0.28 | exact | the same |
| `partition` is not in `MODEL_TOOLS`; the command has no keys | exact | beside the stress checks |
| Reader: a v4 file without the op is unchanged; `piece` still only on `split` | exact | `src/model-tree-file` test |
| Slice request of a plate that holds pieces has no new field | exact JSON | a unit test on the request builder |
| Golden G-code | byte-identical | `mcp/golden.test.ts`, `tools/golden.sh`, untouched |

The existing Split tests (`tests/kernel.rs`, `e2e/model-split-plane.spec.ts`) pass on every milestone. An implementation that diffs `crates/lime-slice-core` has left this plan.

The coupon bars are generated by the planner in M6 and checked against the same volume and clearance tests. The physical print is recorded by editing the clearance table and dropping **Starting fit** from the cells that were printed. That edit is a later change, with the measured number in the commit message.

## 15. Milestones

Each milestone leaves the app usable, leaves Split as it is, and leaves the golden G-code byte-identical.

1. **Planner.** `src/modeling/partition.ts` and its test: cuts, fit, profiles' sizes, connector placement, warnings. No kernel and no UI.
2. **Straight kernel cut.** `partition` with plane tools only, watertight pieces, volume tests. No plate change yet.
3. **History and plate.** One row, `pieces` keys, piece objects, pose kept, MCP probe and apply for a straight plain cut. Edit round-trips. Connectors and profiles beyond straight are refused with a sentence.
4. **Panel.** The menu item, the card, typed and dragged planes, hover on the plane only, Playwright. No shortcut, rail unchanged.
5. **Pegs.** Peg and hole, pairing, thin-wall warnings, **Use N**. Pin, key, and dovetail still refused.
6. **Fit table.** Material clearances, the Starting fit sentence, XY compensation warning, both coupon solids generated and checked. The print itself is the human step after this milestone.
7. **Bed.** Printable joint, lay out, part numbers, with the male and female orientations in the tests.
8. **Lap and tongue.** Profile parameters, drag handles, volume and face tests.
9. **Zig-zag and dovetail.** Including the discrete dovetail key and the pin, which share the prism builder.
10. **Sketch profile.** Sketch card, solver dimensions, sweep, edit reopens the chain.
11. **Measured fits.** After the coupon is printed, update the table and retire Starting fit on the printed cells.

## 16. Open decisions

The plan is written to the recommendation in each row. Review can change any of them before implementation.

| # | Decision | Recommendation |
|---|---|---|
| 1 | Menu name | **Split to print…** It says why the cut exists. The rail's Split stays the single plane. |
| 2 | Cuts proposed when the tool opens on a part that does not fit | Prefill straight cuts, connectors off, and wait for Apply. **Clear cuts** is the opt-out. A part that fits opens with an empty list. |
| 3 | Clearance before the coupon is printed | Ship the table with the sentence **Starting fit**. Connectors are already off, so the number is used only after the user opts in. An empty field would block that path. |
| 4 | Joint on the bed | Female face down, male face up, both flat faces down when there is no peg. A peg cannot occupy the bed. The checkbox is **Printable joint**. |
| 5 | Editing a partition | Rebuild every piece of that row in one undo step. Leaving the old piece, as Split does, would separate a peg from its hole. |
| 6 | Shaped cuts at an angle | Refuse them. Straight cuts may meet. A swept profile needs one sweep direction. |
| 7 | Several connector types on one cut | The file stores a list. The first panel edits one type. Pins beside pegs can wait for milestone 9. |
| 8 | A loose key, a third piece that slides into both sides | Leave it out. A key fused to one piece and cut from the other covers the joint without another body to keep paired. |
| 9 | Part numbers | Engrave them with the stroke font. The object name stays editable and is not the assembly mark. |
| 10 | Which piece keeps the plate id and the stress study | The negative side of the first cut. The study goes stale with the fingerprint. Other pieces get no study. |
| 11 | Belt printers | Use the build volume Check already uses, including the Ideaformer IR3 V2's recorded volume. An unbounded belt axis would ignore the volume the rest of the app prints against. |
| 12 | Project version | Stay at 4. The op is inside the tree the file already stores. An older app drops that tree and opens the meshes. |
| 13 | Custom sketch in the first milestones | After the named profiles (milestone 10). Straight through dovetail cover the joints Marius listed; the sketch is the escape hatch. |
| 14 | Max pieces | 12, editable up to 24. |

## 17. Constraints

- **Licence.** New code is MIT, in `src/modeling/` and in `lime-model-occt`. Open CASCADE stays the dynamically linked library it is, under the exception in `third_party/occt/NOTICE.md`. No new native dependency. No PlaneGCS, SolveSpace, CGAL, or libigl.
- **Offline.** The clearance table, the fonts, and the coupon geometry are in the repo. Nothing is fetched at run time.
- **Slicer output.** No new `SliceRequest` field and no new G-code comment. The pieces reach the slicer as plate meshes through the path an edited solid already uses. `mcp/golden.test.ts` and `tools/golden.sh` stay byte-identical.
- **Desktop first.** The card is the Model dock. The phone gets the same menu item and the same sheet the other Model tools use.
- **Existing behaviour.** Split, its shortcut, its op, its tests, `MODEL_TOOLS`, the command key map, the project reader for older files, and the stress study's fingerprint rule all stay as they are.
