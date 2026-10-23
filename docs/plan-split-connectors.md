# Plan: split a solid into printable parts

Status: plan, for review. Written 2026-10-22 against `main` at v3.7.0 (`5d1e7e9`). Revised 2026-10-23 after review (section 18 lists what changed and why). No code in this change.

A long or tall solid can be cut into parts that fit a printer, printed separately, and put back together. Connectors and shaped joints are available on every cut. Each one is off until the user turns it on. A plain planar cut, with no peg and no step, is a complete use of the feature.

The printer the parts are for need not be the one this app slices for. The use case that sets the direction is a resin printer, a Formlabs machine, whose build volume is too short for the parts: the parts are cut here, exported, printed in PreForm, and assembled by hand. FDM on the plate is the first target to ship, and the op's format carries the target printer from the first milestone, so resin is data and an export, not a rewrite.

## 1. Goal

A person, or an MCP client, can:

1. Choose the **target printer**: the plate's printer by default, or any printer in the library, including an export-only resin printer this app does not slice for.
2. Cut a solid with one or more planes, typed or dragged, and with **Fit the printer** when the part is larger than the target's build volume.
3. Shape any cut with a profile: straight, lap, zig-zag, tongue-and-groove, dovetail, or a sketch. Every size on that profile is typed or dragged, and the history row rebuilds from those sizes.
4. Add connectors on a cut: a separate dowel pin, a fused plug and hole, a hole for bought hardware, a rectangular key, or a discrete dovetail. Type, count, size, depth, placement, and clearance are each adjustable. Zero connectors is valid.
5. Number the parts on their cut faces, put them on the plate when the target is the plate's printer, or export them (STL, 3MF, or a STEP assembly) when it is not, and edit the whole thing later from one history row.

The existing Split tool stays as it is. Shortcut `D`, the rail button, and `{kind: "split", origin, normal}` are unchanged. This feature is a different op, `partition`, opened from the Features menu.

### Non-goals

- No new rail button and no new shortcut. `MODEL_TOOLS` in `src/model-drag.ts` does not grow. The stress command test is the pattern (`src/sim/study.test.ts`).
- No edit to `crates/lime-slice-core`, the G-code writer, or a slice cache key. Golden G-code stays byte-identical.
- No resin slicing. A resin target gets exported pieces; PreForm (or the printer's own slicer) orients, supports, and slices them.
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

### Floors come from the target's process

Every floor in the table below is written for FDM, where it scales with the nozzle and the layer height. A resin printer has neither, so the floors are one record per process, and the table reads the record of the target printer (D11):

| Floor | FDM | Resin (SLA/MSLA) |
|---|---|---|
| Feature width `f` (stands in for "nozzle" in the formulas below) | `profile.nozzleDiameter`, 0.4 mm on the built-in printers | 0.5 mm, a starting value for an unsupported wall in a tough resin, until the resin coupon |
| Layer `l` (stands in for "layer height") | the preset's `layerHeight`, 0.2 mm in `src/app/state.ts` | 0.1 mm, the coarsest common resin layer, so the depth floors stay conservative |
| Thin-wall floor | `2 × f`, the one `model_check` already uses (0.8 mm at 0.4 mm) | `2 × f` (1.0 mm) |
| Clearance | the filament row of the clearance table | the resin row of the clearance table |

So "4 × nozzle" in a row below means `4 × f`: 1.6 mm at 0.4 mm FDM, 2.0 mm on resin. The resin column is labelled **Starting fit** in the same way and for the same reason as the clearances, until a resin coupon is printed.

The bed is the target printer's build volume (D11), not always the plate's. Lime 220 is 220 × 220 × 250 mm (`src/ui/machine-library.ts`). On a belt printer the axis along the belt is unbounded, so only the belt's width and the gantry's height limit a part.

| Default | Value | Why this is a sound default | How to turn it off or override it |
|---|---|---|---|
| Cut profile | Straight | A plane adds no material, keeps the parent's volume, and leaves a flat face. `build_split` and `tests/kernel.rs` already lock that path. | Profile menu on that cut: Lap, Zig-zag, Tongue, Dovetail, or Sketch. |
| Connectors | Off | A connector that does not fit the section would thin a wall. Off cannot do that, and a plain cut has to be possible. | **Connectors** on that cut. Count 0 is the same switch. |
| Target printer | The plate's printer | Cutting for the printer on the plate is the common case and needs no choice. | **Print on** menu: any printer in the library, including an export-only resin printer. |
| Connector type, once on | Dowel: a hole in both pieces and a separate pin | The pin prints upright as its own small part, with layers along its length, so it does not snap at a joint face. The pieces can lie in any orientation, because neither carries anything that sticks out. Pins are all the same, so they need no pairing. This is the connector PrusaSlicer's, Bambu Studio's, and Orca's cut tools offer. Resin is brittle, which favours a separate pin even more. | Type menu: Plug (a peg fused to one piece), Hardware hole, Key, or Dovetail. |
| Radius | `max(3, 4 × nozzle)` mm → 3 mm at 0.4 mm | Four nozzle widths is the floor a unit test locks, so the pin is more than a single perimeter. 3 mm is the grip size the coupon prints. Below the floor the field refuses. | Type or drag Radius. |
| Count | Fit: as many as the section holds at a pitch of `4 × diameter` | A fixed count of 4 misses a short part and crowds a thin one. Fit places one when one fits, and more only while the wall floor holds. | Type Count. That cut leaves Fit and uses the typed number. 0 turns connectors off. |
| Placement | One row through the section's centre, along U | The centre is inside a convex section. The inset keeps the wall floor. | Drag a connector. That connector becomes fixed millimetres. **Refit** puts the cut back on Fit. |
| Margin | `max(radius + clearance + 2 × nozzle, 3)` mm → 3.95 mm for PLA at 0.4 mm | The hole is the pin's radius plus the clearance, and the thin-wall floor stays outside it. Radius plus the floor alone left a 0.65 mm wall (found in milestone 1). | Type or drag Margin. |
| Depth | `min(allowance, max(4, 8 × layerHeight))` mm → 4 mm at 0.2 mm layers | Eight layer heights is the floor the test locks. 4 mm is what the coupon grips. Allowance is half the piece's thickness along the normal, minus the end gap, minus the wall floor. Under four layer heights the connector is left out and named. | Type or drag Depth. |
| Clearance | Each side, from the material table below. PLA snug is 0.15 mm | The hole is larger than the pin by this gap on the radius. It is tied to the target's material and, on FDM, to a 0.4 mm nozzle with XY compensation at 0. It is a starting fit, not a measured one, until M6. | Fit menu: Snug, Loose, Press, or a typed Clearance. |
| Hole across the layers | Teardrop top on FDM when the hole's axis lies within 45° of horizontal | A round hole printed on its side sags at the top, where it bridges, and the pin no longer fits. A teardrop, the round hole with a 45° roof, prints without that sag. Resin does not bridge, so a resin hole stays round. | **Hole shape**: Round or Teardrop. |
| End gap | `max(0.4, 2 × layerHeight)` mm → 0.4 mm | A hole is deeper than what goes in it by two layer heights, so the pin does not bottom out. The test locks the formula. | Type End gap, including 0. |
| Plug side | Positive side of the cut normal | Matches Split, which keeps the negative side on the original object. One side holds every plug on that cut, so pairs stay obvious. Dowels have no side. | **Plug side** flips it. |
| Opening cuts | Fit the printer when the part does not fit the target; none when it does | An oversized part cannot print as one piece. The proposal is straight cuts, connectors off. A part that fits gains no cut by itself. | **Clear cuts**, or delete and drag rows. Apply with an empty list is refused. Nothing is cut until Apply. |
| Bed margin | FDM: brim width when adhesion is brim (5 mm in `state`), else 5 mm. Resin: 10 mm | FDM: the piece stays inside the volume, with room for a brim. Resin: the printer's slicer adds supports and a raft under a tilted part, which takes height and width the piece itself does not show. | Type Margin from the edge of the volume. |
| Max pieces | 12, hard stop 24 | A 2 m bar on a 220 mm bed with the margin is under 12. The hard stop bounds the boolean count and the 60 s kernel budget. | Type Max pieces, from 2 to 24. |
| Cut position, when adding one by hand | Middle of the part along the chosen axis | The same place Split opens. It is inside `split_reject`'s margin (2 %, at least 0.25 mm, and the 0.25 mm piece floor). | Type At X, At Y, or At Z, or drag the plane. |
| Tilt | 0° / 0° | An untilted plane is the bed-aligned cut. Split opens untilted for the same reason. | Tilt A and Tilt B, typed or on the ring, clamped at ±85° as Split is. |
| Lap depth | `max(8, 6 × nozzle)` mm → 8 mm | Six nozzle widths is the floor. 8 mm is the glue overlap the coupon prints. | Type or drag Depth on that lap. |
| Lap height | Half the section along V, and each shoulder at least `max(3 × layerHeight, 2 × nozzle)` | Half keeps both shoulders printable. A part too thin for two shoulders refuses the lap and says to use Straight. | Type or drag Height. |
| Zig-zag pitch | `max(10, 8 × nozzle)` mm → 10 mm | Eight nozzle widths keeps each tooth printable. The tooth width is half the pitch. | Type or drag Pitch, or type a tooth count and the pitch follows. |
| Zig-zag depth | `max(3, 6 × layerHeight)` mm → 3 mm | Six layers so the tooth is a real step, not one layer. | Type or drag Depth. |
| Zig-zag angle | 0° from the normal | Flanks are square to the bed when the joint is horizontal, so they are vertical walls. | Type or drag Angle. |
| Tongue width | `max(6, 6 × nozzle)` mm → 6 mm | Same printability floor as a pin's diameter. | Type or drag Width. |
| Tongue depth | `max(3, 6 × layerHeight)` mm → 3 mm | Same layer rule as a tooth. | Type or drag Depth. |
| Dovetail width | `max(8, 8 × nozzle)` mm at the wide end | The narrow neck must stay at least two nozzle widths. A width and angle that pinch the neck are refused. | Type or drag Width. |
| Dovetail angle | 20° from the normal | A mild flank locks against pull-apart and still leaves a printable neck at the default width. The coupon slides this angle at the default clearance. | Type or drag Angle. |
| Dovetail slide | Along U, the long direction of the cut | With the joint horizontal, the undercut is in the bed plane. A slide along the normal would be an overhang. | Slide menu: U or V. W is refused. |
| Sketch profile | A straight line across the section | The sketch starts valid and equal to Straight, so Apply is safe before any edit. | Draw in the sketch. Choosing Straight drops the sketch from the op. |
| Orientation (FDM plate) | Keep the orientation the cuts were planned in | Fit the printer sized each piece for that orientation. Standing a long piece on its cut face makes it tall and narrow: weak on the bed, slow, and with layers across its length, so it is weakest in bending, the across-layers failure the stress estimate names. | **Joint down** stands a piece on its cut face. It is per piece, in the piece list. |
| Orientation (resin) | None. The export keeps the pieces as cut | PreForm orients and supports a resin part itself. This app cannot know the tilt the resin slicer will pick. | Orient in PreForm. The export note says to keep supports off the cut faces (section 10). |
| Lay out on the bed | On for the plate's printer; off for an export | Overlapping parts will not print. The gap is `ARRANGE_GAP_MM` (2 mm), the same gap Arrange uses. An export has no plate. | **Lay out on the bed** off. The parts stay stacked, and the readout says to Arrange, as Split does today. |
| Part numbers | On | The engraved index is the assembly order along the cut. The font is the stroke font `textStrokes` already uses. | **Part numbers** off. |
| Number height | `max(4, 8 × f)` mm → 4 mm | Eight feature widths so the strokes survive. | Type Height on the label. |
| Number depth | `max(0.4, 2 × l)` mm → 0.4 mm | Two layers. Shallow enough to leave the wall, deep enough to read. | Type Depth on the label. |
| Number face | The cut face, clear of connectors and inside the margin; a side face only when the cut face has no room | The cut face is hidden once the parts are assembled, so the number marks nothing a person sees. Both mating faces carry their number, side by side when assembled, so the pair is obvious. A recessed number does not touch the fit. | Drag the number to another face. |

### Clearance table

Clearance is the gap on each side. The hole radius is the pin's radius plus this number. The diameter is larger by twice the number. The panel shows both: "0.15 mm each side (0.30 mm on the diameter)."

| Material | Snug | Loose | Press |
|---|---|---|---|
| PLA | 0.15 | 0.25 | 0.05 |
| PETG | 0.20 | 0.30 | 0.10 |
| ABS | 0.20 | 0.30 | 0.10 |
| Resin, tough or standard (Formlabs Tough 2000 is the first) | 0.10 | 0.20 | 0.05 |
| Anything else, including TPU and flexible resins | — | — | — |

PLA, PETG, and ABS match the filament ids already in `src/ui/machine-library.ts`. The resin row is read for an export-only resin printer (D11). Snug is the fit the coupon is built to confirm: the parts stay together and come apart by hand. Loose is for a joint that must slide. Press is for a joint that must not. TPU, a flexible resin, and any unnamed material do not get a row. Turning connectors on says "No fit for this material. Type a clearance, or leave connectors off." and leaves the field empty until a number is typed.

PLA snug starts at 0.15 mm, not 0.10 mm. At 0.10 mm a side, a hole printed on its side, which the default orientation makes common, is already tight before it sags. The coupon settles the number. Resin parts grow slightly where the light bleeds past the edge, so the resin row is not the FDM row.

Clearance does not scale with the feature width. Hole error at a given setting is not proportional to the nozzle. The minimum sizes above do scale with the feature width. The layer changes Depth, End gap, and the number depth. It does not change Clearance.

XY hole compensation (`xyHoleCompensationMm` in `src/xy-comp.ts`, default 0) is a slice setting. It is not baked into the solid. When it is not 0, the note says "XY hole compensation is N mm. It changes the hole again when slicing. Clearance here is the solid." Elephant's foot is the same: a warning, not a change to the B-rep. Baking either one into the solid would make the part depend on a slicer setting and would put this feature on the slice path.

### The coupon that retires "Starting fit"

One printed bar, 80 × 20 × 10 mm, cut in the middle, with dowel holes of the default radius and depth and a set of pins, repeated at 0.05, 0.10, 0.15, 0.20, and 0.25 mm clearance, in the plate's filament, nozzle 0.4 mm, layers 0.2 mm, XY compensation 0. The bar is printed lying down, so its holes are teardrops across the layers, as the default orientation makes them. A second bar carries the default lap, the default tongue, and the default dovetail. M6 generates both bars as solids. A person prints them. The clearance that snug actually was replaces the PLA snug cell, the label **Starting fit** comes off that cell, and the test expects the new number. Until that print, the sentence stays.

The resin coupon is the same two bars, exported for the Formlabs printer in Tough 2000, with round holes. It retires **Starting fit** on the resin row and on the resin floors in section 2.

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
| MCP | `model_probe`, `model_apply`, `model_edit` in `mcp/schema.ts`; the op-kind list on `model_apply` and `guide {kind}` (#405); the `model` tool group in `mcp/groups.ts`; the token budgets in `mcp/schema.test.ts` | The same op the panel writes. The new kind is one name on `model_apply`'s list and one entry behind `guide {kind}`. |
| Export | `export_3mf`, `model_export_step`, the File menu's STL and 3MF export | Pieces for a printer this app does not slice for. |
| Machine library | `src/ui/machine-library.ts`, `PrinterRecord` | The target printer's build volume and process (D11). |
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

The file stores `connectors.types[]`. The first panel edits a single type per cut. A later milestone can show two rows, a dowel and a key, without a format change. An empty list and `"on": false` are the same plain cut.

### D5. Placement is fractional until the user drags

A Fit connector stores its position as fractions of the section's box in U and V. Replay applies the fractions to the new section, so an edit above the cut keeps the connectors centred. Dragging a connector stores absolute millimetres in the cut frame and marks it fixed. A fixed connector that lands outside the section, or inside the wall floor, is left out and named. It is not moved quietly.

### D6. The kernel cuts. The planner only proposes

`src/modeling/partition.ts` is pure TypeScript. It places planes, profiles, and connectors, and it returns warnings. The panel and `model_probe` with `plan: true` both call it. The kernel builds the solids and checks them. On Apply, the op stores the connectors that were actually built (`placed`), so a replay builds those and does not discover a new set. **Refit** clears `placed` and runs the planner again.

### D7. Pieces stay paired because the ids are in the op

A connector id is `c{cut}-{index}`. A dowel is a hole in both pieces, coaxial, and one pin object per cut with the count on it; the pins are identical, so they need no pairing. A plug is fused to one piece and its socket is cut from the mate. The kernel refuses a spec that names a plug without its socket, or a dowel hole without its mate. Piece order is along W of the first cut, negative to positive, then along the next cut. Part numbers follow that order.

### D8. One object keeps the plate id

The piece on the negative side of the first cut keeps the parent's plate id, tree, and `sim`. The other pieces are new plate objects and new trees, rooted as pieces of this node. Paint, seam paint, reinforcement, and support edits on a new piece start empty, as they do for a Split piece. The kept object's study is stale because the solid's fingerprint changed. The readout says so. The other pieces have no study.

### D9. Edit replaces every piece of this partition

Today, editing a Split leaves the old second piece on the plate and `olderSplitNote` explains it. That would separate a pin's hole from its mate, or a plug from its socket. Update rebuilds every piece of this node in the same Prepare undo step as the edit. Later steps on a piece are replayed when that piece's index still exists. A step that no longer builds is kept in the tree and the row says why, and the piece on the plate is the partition's new solid. The user's later hole is not deleted from the history.

### D10. The menu, not the rail

**Split to print…** is a menu item in `#modelFeatureMenu`, after Stress. Command id `model-split-print`, group Model, no `keys`, keywords `split cut connector peg dowel bed resin export`. The `?` sheet lists a command only when it has a shortcut, so this one stays off that sheet. Choosing it opens the tool card in the Model dock, the slot Split's card uses, and Apply closes it. It is not `data-tool` and not a lasting dock section.

### D11. The op names its target printer and its process

A cut is for a printer. The op stores `target: { printer, process, volumeMm }`: the library id, `"fdm"` or `"resin"`, and the build volume at the time of Apply, so a replay cuts the same pieces after the library changes. Absent means the plate's printer. Fit the printer, the floors (section 2), the clearance row, the orientation rule, and the bed margin all read `target`.

A resin printer is an export-only record in the machine library: a name, a build volume, `process: "resin"`, and a default resin. It cannot be chosen as the plate's printer and is not sent to the slicer. The first record is the printer this feature is for, a Formlabs Form 4 (confirmed on its About screen, 2026-10-23): id `formlabs-form-4`, build volume 200 × 125 × 210 mm as Formlabs gives it, default resin Tough 2000.

A belt printer's volume is its belt width and its gantry height; the axis along the belt has no limit. The same rule belongs in Check, which today calls a long part on the IR3 V2 "Too large"; that is a separate fix.

### D12. A target this app does not slice for gets an export

When `target.process` is not the plate's, or the user chooses **Export**, Apply leaves the pieces in Model, in place, and the card offers the export: one file per piece (STL or 3MF), one 3MF with every piece named, or one STEP assembly. PreForm imports all three, and it keeps a STEP assembly as an assembly. The pins are exported as one more part. Piece names carry the part number and the source name: `cover-1.stl`, `cover-2.stl`, `cover-pins.stl`. No support, tilt, or hollowing is added; the resin slicer does those. The export note says to keep supports off the cut faces, which carry the fit and the number.

For reassembly, Model already keeps the pieces where they were cut. **Explode** spreads them along each cut's normal by a typed gap and shows each number on its cut face. It is a view, not an op, and it changes nothing that is saved.

## 5. Defining the cuts

### By typing

Each cut is a row. The row has At X, At Y, or At Z, the number in model space, and Tilt A and Tilt B. On a local workplane the axes are U, V, and W, as Split's are (`docs/local-workplane.md`). **Face** aims the plane at the picked flat face plus an offset, and then the cut is stored as origin and normal, so a replay does not depend on face numbers. A curved face is refused with Split's sentence: "Pick a flat face. This one is curved."

Every number accepts an expression. The text is stored on `exprs` and stripped before the engine call.

### By the mouse

Dragging the plane moves At X, At Y, or At Z along the normal, the same mapping as Split (`src/model-drag.ts`). Ctrl snaps to whole millimetres. The heads-up field types the number. Tab moves to Tilt A, then Tilt B. The plane's outline is the only thing that lights for that handle.

Adding a cut drops a plane at the middle of the remaining largest piece. Deleting a cut removes its profile and its connectors with it.

### Fit the printer

The planner reads the part's box in the print frame and the target's build volume (D11). On the plate's printer the button reads **Fit the bed**; for an export target it reads **Fit the printer**.

1. Usable length along an axis is the volume minus twice the margin, minus whatever a plug or a profile sticks out of the piece along that axis. On a belt printer the axis along the belt is unlimited.
2. When the part fits, the proposal is an empty list and the note says it fits.
3. When it does not, the longest axis that exceeds the usable length is cut into the fewest equal pieces that fit. Positions are then nudged so each plane sits inside `split_reject`'s margin. A part that still exceeds another axis is cut again, parallel to that axis.
4. Above Max pieces, the note says how many it would take and adds none. The user raises Max pieces or cuts by hand.
5. The list is a proposal. Apply is what cuts. **Clear cuts** removes the proposal.

A 500 mm bar on a Lime 220, margin 5 mm, usable 210 mm, is three pieces. The same bar on the IR3 V2's belt, lying along the belt, is one piece. A part 400 mm tall for a 210 mm-tall resin volume with a 10 mm margin, usable 190 mm, is three pieces cut across its height. Those three examples are unit tests.

For a resin target the planner does not know the tilt PreForm will choose, so it fits each piece upright in the volume, less the margin. Tilting a piece makes its box larger, and supports add height, so the margin is an allowance, not a promise. A piece within 15 % of the usable height is named in the note: "Piece 2 is 178 mm tall. Tilted in PreForm it may not fit; a fourth cut would leave room."

### Several cuts

The op stores `cuts[]` in order. Parallel cuts slice a bar into a chain. Meeting straight cuts slice it into a grid. The preview tints each piece. The piece list under the fields names them in assembly order.

## 6. Cut profiles

The profile is the shape of the whole joint. Connectors are separate features sitting on that joint. A lap with connectors off is valid. A straight cut with dowels is valid. Both off is the plain cut.

The profile menu is per cut. Its parameters are on that cut, typed or dragged, stored on the op, and rebuilt on edit.

### Straight

The splitter tool is the plane face `build_split` already builds. No extra size.

### Lap

A step in the (V, W) plane. Depth is the overlap along W. Height is where the step sits along V, measured from the section's low side. The shoulders have to clear the layer and nozzle floors in the defaults table. The side menu chooses which piece carries the overlap.

Drag Height and the step line moves along V. Drag Depth and the overlap moves along W. Each handle lights only that segment of the profile ghost.

### Zig-zag

A square wave along U, swept so the teeth run the length of the joint. Pitch is centre to centre. Depth is the tooth height along W. Angle leans the flanks; 0° is square. A tooth narrower than two nozzle widths at its tip is refused. Drag Pitch along U. Drag Depth along W. Drag Angle on the flank.

### Tongue and groove

A ridge along U. Width is the tongue along V. Depth is how far it stands along W. It stops Margin short of each end of the section so it does not break out of the sides. The groove is the tongue grown by Clearance on each side and by End gap at the bottom. The same Clearance field as a dowel, so a cut has one fit.

### Dovetail

The tongue's tip is wider than its root by Angle from W. Slide is U or V. The neck check uses the nozzle floor. With the piece lying as planned, the undercut lies in the bed plane. Slide along W is refused because that undercut would be vertical.

### Sketch

**Sketch** opens the sketch card on the profile plane: the sketch's U is the cut's V, and the sketch's V is the cut's W. The user draws an open chain. The in-house solver and the driving dimensions are the typed sizes. The mouse is the sketch's existing draw and drag. The chain has to reach past both sides of the section. The kernel extends the ends to the box and sweeps the chain along the cut's U. A chain that crosses itself is refused with the profile sentence already used for sketches: "The profile crosses itself."

The sketch is stored on the cut as `sketch`, the same kind of payload an extrude stores, and every engine request drops it. Choosing Straight removes `sketch` from the op. Edit of a sketch cut reopens the sketch card with the chain, then the partition panel.

`featureStrip()` keeps its four features: Extrude, Revolve, Loft, Sweep. The profile sketch uses the sketch card's draw tools and dimensions. The partition's Apply sits on the tool card, and it is the primary button. The status title stays within 40 characters ("Lap joint" , "Sketch profile"). The How popover carries the steps. No new shortcut is added to the sketch.

## 7. How the solid is cut

The cut is a B-rep in `lime-model-occt`. There is no mesh boolean behind it.

For each cut the kernel builds a tool:

- Straight: the finite plane face `build_split` builds, large enough to clear the bounding box.
- Any other profile: the profile wire swept with `BRepPrimAPI_MakePrism` along U, as a shell.

One `BRepAlgoAPI_Splitter` call takes the solid and every tool. `SetNonDestructive` is on, as in `build_split`. Each resulting solid is classified by which side of each cut its centre of mass lies on. That side vector orders the pieces. Each solid is its own piece: two solids on the same side of every cut, such as the arms of a U cut across, do not touch, and fusing them would not make one solid. Each is passed through `as_solid`. `ShapeFix_Solid` closes a shell that came back open. `BRepCheck_Analyzer` has to accept each piece. A piece that is not one closed solid fails the op and the parent is unchanged.

The splitter sews the section into each piece, so the cut face is part of the solid. A straight cut square to a box's sides produces two solids of six faces each: four split sides, one end, and the cap. A cut through all six faces of a cube gives seven faces a half. That face count is a test. A profiled cut's cap is the swept profile, and its area matches the section area within 1e-4 mm² on a box.

Connectors run after the split, on the pieces:

- A dowel hole is a cylinder of the pin's radius plus clearance, as deep as half the pin plus the end gap, cut with `BRepAlgoAPI_Cut` from both pieces, coaxial. The pin is its own solid, `BRepPrimAPI_MakeCylinder` with a 0.5 mm chamfer at each end so it starts into the hole, one per cut, with its count stored on the op.
- A plug is `BRepPrimAPI_MakeCylinder`. It is started 0.001 mm inside the face so the fuse overlaps, the same overlap `faceExtrude` uses, then fused with `BRepAlgoAPI_Fuse`. Its socket is a cylinder of radius plus clearance, longer by the end gap, cut with `BRepAlgoAPI_Cut`.
- A hardware hole is a dowel hole with no pin made, sized from a typed diameter and depth, for a bought metal pin or a magnet.
- On an FDM target, a hole whose axis lies within 45° of horizontal in the print orientation is a teardrop: the round section with a 45° roof, built as the cylinder fused with a prism.
- A key or a dovetail is a prism of its trapezoid or rectangle, fused on one side and cut, grown by clearance, on the other.
- A part number is a shallow cut of the stroke boxes from `textStrokes`.

Volume, for a straight cut with no connectors, sums to the parent within 1e-6 mm³ on a box, and within 1e-4 mm³ on a curved solid. With connectors, the test computes the box by hand: parent, plus each plug cylinder, minus each socket or dowel-hole cylinder; the pins are counted as their own solids. A cylinder's volume is π r² h and Open CASCADE's cylinder is exact; the test uses 1e-6 mm³. The radii are read back from `Geom_CylindricalSurface`, and each hole radius minus the pin or plug radius equals Clearance within 1e-9 mm.

A mesh, or a STEP with surfaces and no closed solid, is refused with "Split to print needs a solid." Measure still works. Separate shells stays available for a mesh.

The plate mesh of each piece is the tessellation at the plate's chord (`STEP_TOLERANCE_DEFAULT` 0.05 mm), written with `encodeStl`, the same path an edited solid uses. The B-rep is the precision authority. The mesh is what the slicer reads, and section 14 says how both are checked.

Preview while a straight plane is dragging is the GPU clip Split already uses, plus a client ghost of the profile and the connectors from the planner. No kernel call runs on mouse move. After 300 ms (`PROBE_WAIT_MS`) the probe mesh replaces the ghost. Apply reuses the probe's shape when the key matches, as other tools do.

## 8. Connectors

Connectors are optional per cut. The switch defaults off. Turning it on adds one connector spec, the dowel row from section 2, which the user then edits.

| Type | Sizes | What is built |
|---|---|---|
| Dowel | Radius, Depth (the pin's full length), Clearance, End gap, Hole shape | A hole in each piece and a separate pin, chamfered, exported or placed on the plate with the pieces. |
| Plug | Radius, Depth, Clearance, End gap, Hole shape | Cylinder fused to the plug side, larger cylinder cut from the mate. |
| Hardware hole | Diameter, Depth, Clearance | A hole in each piece for a bought pin or magnet; nothing is made to go in it. |
| Key | Width along U, Height along V, Depth along W, Clearance | A rectangular prism pair. |
| Dovetail | Width, Angle, Depth, Slide, Clearance | One sliding trapezoid pair. The edge dovetail is the profile; this is a single key. |

Plug, Hardware hole, Key, and Dovetail use the sizes in section 2 the moment that type is chosen. Each size is still editable and each can be cleared by switching the type or by turning connectors off.

The connector axis is W. Placement prefers the region of the joint whose normal is W, so on a lap the connector sits on the overlap, not on the riser. On an FDM target, a plug dragged onto a flank steeper than the support angle (45°) warns "This plug leans more than 45°. It will need support." A dowel has no such warning, because its pin prints on its own.

## 9. Pairing, thin walls, warnings

The planner places connectors in the cut frame:

1. Inset the section polygon by Margin.
2. For Fit, walk a row through the centroid along U at the pitch, and keep a centre that lies in the inset.
3. Reject a pair whose socket comes within the wall floor of the outline, of another socket, or of a hole in the section.
4. A typed count that does not fit keeps the ones that do and names the rest.

The kernel repeats the inside test on the real solid. A connector whose tool misses the piece, or whose result fails `BRepCheck_Analyzer`, is dropped. The reply lists `placed` and `dropped`. Apply stores `placed`. The panel says "Cut 2: 2 of 4 dowels fit." and offers **Use 2**, which writes that count. Apply is allowed with the connectors that fit. A cut whose every connector was dropped becomes a plain cut, and the note says so.

Warnings are one sentence, the same sentence in the panel and in the MCP:

- "Cut 2: dowel 3 would leave a wall of 0.6 mm, under 0.8 mm. It was left out."
- "Cut 1: 2 of 4 dowels fit."
- "This part is 480 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed."
- "No fit for this material. Type a clearance, or leave connectors off."
- "XY hole compensation is 0.1 mm. It changes the hole again when slicing. Clearance here is the solid."
- "Part 2 has no room for a number."
- "A shaped cut has to be parallel to the other shaped cuts."
- "This lap is thinner than two shoulders. Use a straight cut."

A warning that leaves a valid plain cut does not block Apply. A refusal (no solid, plane outside the part, self-crossing sketch, slide along W, over the 60 s budget) blocks Apply and leaves the solid unchanged.

## 10. Print orientation and part numbers

Model pose keeps each piece where it was cut, so in Model the parts still sit together. The plate orientation is separate.

**FDM, on the plate.** Each piece keeps the orientation the cuts were planned in, the parent's plate orientation, because Fit the bed sized every piece for it. A piece stood on its cut face would be tall and narrow, slow, weak on the bed, and weakest in bending, with layers across its length; the stress estimate names that failure "across layers". A plug in that orientation would stand with layers across its axis and snap at its base, which is why the default connector is a dowel.

**Joint down** is the opt-in, per piece, in the piece list. It puts that piece's larger joint face on the bed; a piece with a plug has its plug side up. The note says when the piece is then taller than the volume, and Apply refuses that piece's flip.

A shaped joint that touches the bed only on its teeth, with Joint down on, gets the note "The teeth touch the bed."

**Resin, exported.** The export keeps every piece as cut, in model space. PreForm tilts and supports it. The export note says: "Keep supports off the cut faces. They carry the fit and the part number." The pins are one more part in the export.

**Lay out on the bed** runs `arrangedObjects` with `ARRANGE_GAP_MM` on the plate's printer, as Arrange does, once the pieces have plate meshes: on the MCP that is the `model_commit` that first puts them on the plate (milestone 3). Off leaves the pieces sharing one spot, and the readout uses Split's sentence about Arrange. Dowel pins go on the plate as one more object, standing upright.

Part numbers are engraved, not a separate object. The string is the index, "1", "2", "3". Height and Depth are the label fields. The default face is the cut face (section 2), so the number is hidden once the parts are assembled, and both mating faces of a cut carry their numbers side by side. A drag moves it. A later rename of the plate object does not change the engraved digit, because the digit is geometry. The note under the checkbox says that. **Part numbers** off stores no text and cuts no digits.

These choices are fields of the op (`orient`, `arrange`, `labels`, `target`). Edit shows them again. They are not slicer settings.

## 11. History

The row label comes from the stored op, in the part's own frame, as Split's labels do:

- "Split to print, 3 parts"
- "Split to print, 3 parts, dowels"
- "Split to print, lap, 2 parts"
- "Split to print, sketch, 2 parts"
- "Split to print for Form 4, 3 parts" (an export target names its printer)

The pencil reopens this panel on the parent solid, the solid before the op, with the planes, the profiles, the connectors, and the checkboxes filled from the op. Update replaces the node and rebuilds the piece objects (D9). Undo returns the parent and removes the pieces, in the one Prepare step the Model visit already uses for an edit.

The node stores `pieces: (string | null)[]`, the engine keys of the trees of pieces 2, 3, … in assembly order (piece 1 is the node's own solid), and `pins: string | null`, the key of the pins object when a cut has dowels. A null is a piece no tree holds, such as a piece whose plate object was not saved; the list still counts the parts, so the row's label survives a save. The file writes each key as that piece's plate object id, or null. `piece` stays the Split field. A `pieces` list on a split, or a `piece` on a partition, is a damaged tree. The engine takes the keys as `pieceKeys` on `apply` and on an edited step's `edit` (`docs/step-modeler.md`); a key per piece Max pieces allows is sent, since the count is known only once the kernel has cut.

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
  "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220, 220, 250] },
  "orient": "keep",
  "arrange": true,
  "labels": { "on": true, "face": "cut", "height": 4, "depth": 0.4 },
  "bedMarginMm": 5,
  "maxPieces": 12
}
```

`orient` is `"keep"` or a per-piece list of `"keep"` and `"joint"`. A resin target stores `"target": { "printer": "formlabs-form-4", "process": "resin", "volumeMm": [200, 125, 210] }`, `"arrange": false`, and a 10 mm margin; the id and the volume are the Form 4 record's (D11).

A lap cut stores `"profile": { "kind": "lap", "depth": 8, "height": 5, "side": "positive" }`. A sketch cut stores `"profile": { "kind": "sketch", "sketch": { "v": 1 } }` and the engine sees the solved chain, not `sketch`. Connectors on:

```json
"connectors": {
  "on": true,
  "types": [
    {
      "type": "dowel",
      "radius": 3,
      "depth": 8,
      "clearance": 0.15,
      "endGap": 0.4,
      "hole": "teardrop",
      "count": 2,
      "margin": 5,
      "place": "fit"
    }
  ]
}
```

For a dowel, Depth is the pin's whole length and each piece's hole takes half of it plus the end gap. A plug stores `"type": "plug"` and `"side"`. Absent fields mean the section 2 default. A saved file from before this op has no `partition`, and it opens unchanged.

## 12. UI

**Split to print…** is in the Features menu. The command palette entry has no shortcut. The rail's Split button stays Split.

The card is a left-aligned form in the Model dock. The fields scroll. Apply is the primary button and stays pinned, with Cancel. The status title is short. The steps sit in How.

Rows, top to bottom: **Print on** (the target printer, the plate's printer first), the fit note, the cut list, the selected cut's plane, its profile, its connectors, then the piece list with orientation and numbers. **Fit the bed** (or **Fit the printer** for an export target) and **Clear cuts** sit on the cut list. **Connectors** is a checkbox on the selected cut. With it off, the connector fields are hidden, not merely disabled, so a plain cut shows a plain card.

For an export target, the foot reads **Apply** and then **Export…**, which opens the save dialog with STL per piece, one 3MF, or one STEP assembly, and the export note about supports. **Explode** sits beside the piece list in Model, with its gap.

Typing and dragging both write the same fields. The heads-up input is the existing one. Ctrl snaps. Expressions show the ƒ mark.

Hover, drag, or focus lights only the dimension that handle changes, in that axis's colour, with one dimension line. The knob tooltip hides while the dimension is up. The matching field takes the ring. A count, a checkbox, and Max pieces have no edge; they light the field and leave the solid alone.

One name per size:

| Name | What it is |
|---|---|
| Width X, Depth Y, Height Z | The part's own box, in the fit note only. |
| At X, At Y, At Z | Where an axis-aligned plane sits. |
| Tilt A, Tilt B | The plane's tilt, as Split names them. |
| Radius | A dowel pin, a plug, or a round corner. |
| Diameter | A hardware hole, typed to the bought part's size. |
| Width | Along U. Tongue, key, dovetail. |
| Height | Along V. Lap step, key's other side, number height. |
| Depth | Along the cut normal. A dowel pin's whole length, a plug, lap overlap, tooth, tongue, number depth. |
| Pitch | Centre to centre along U. |
| Angle | Degrees from the cut normal. |
| Clearance | Gap on each side. |
| Margin | Inset from the section outline. |
| End gap | How much deeper a hole is than what goes in it. |

Width X, Depth Y, and Height Z are not reused for a connector. Depth on a connector is along the cut, and the field's full name in the accessible description says so ("Depth, along the cut, 4 millimetres").

No new shortcut. Split's `D` stays. X, Y, Z, and F stay Scale, the front view, and Lay flat.

On a short window the card is the same drawer the other Model tools use. On the phone it is the same menu item in the top strip, opening the sheet. No separate layout.

## 13. MCP

The panel and the tools write the same op. A field that exists in the card exists in the guide's schema for the kind. A tool that changes the solid is the same call Apply makes.

No new tool. Since #405, `model_apply` lists its op kinds by name and `guide {kind}` returns a kind's full schema, so `partition` is one more name in that list and one more entry behind `guide {kind: "partition"}`. The default tool list is about 14,900 of its 16,000-token budget (`mcp/schema.test.ts`); a new tool would spend much of what is left, and the planner fits on the probe. Everything here is in the `model` tool group (`mcp/groups.ts`).

| Tool | What it does |
|---|---|
| `model_probe` | Accepts `{kind: "partition", ...}`. With `plan: true` it runs only the planner: the proposed cuts, the placed and dropped connectors, the fit against the target, and the warning sentences, with no kernel call and no mesh. Without it, it also cuts and returns volume and box per piece, `placed`, `dropped`, and the sentences. The solid is unchanged either way. |
| `model_apply` | The same op, after a probe or with `probe: true`. One undo step. Then `model_commit`, as for any other edit. |
| `model_edit` | Replaces the node from the same op the pencil writes. A split to print is always cut again, never matched to an earlier branch with the same numbers, since that branch's pieces went to the edit that replaced it (D9). `model_undo` above the node takes its pieces off the plate and `model_redo` brings them back, as a join's tool. |
| `model_history` | The row label. `model_goto`, `model_undo`, `model_redo`, `model_drop`, and `model_rename` work because the node is an ordinary step. |

| `export_3mf`, `model_export_step` | Take the piece objects of a partition (and its pins) to write one 3MF or one STEP assembly for an export target. Per-piece STL is the existing mesh export per object. |

`lime://guide/model` gains a short sequence: plan (`model_probe` with `plan: true`), probe, apply, commit, export, and the plain-cut op with connectors off. A `plan_run` can chain them (#405). Replies stay small. The mesh stays in the engine for the app.

A client that sends `connectors: {on: false}` and `"profile": {kind: "straight"}` gets the plain cut. Omitting those fields is the same, because absent means the default, and the default connector state is off.

## 14. Tests and precision

Precision is the B-rep, not the triangles.

| Check | Tolerance | Where |
|---|---|---|
| Straight cut of a box, volumes sum to the parent | 1e-6 mm³ | `crates/lime-model-occt/tests/partition.rs` |
| Curved solid, volumes sum | 1e-4 mm³ | the same |
| Dowel holes and pins, plug and socket on a box, against π r² h | 1e-6 mm³ | the same |
| Hole radius − pin or plug radius = Clearance | 1e-9 mm | radii from `Geom_CylindricalSurface` |
| A horizontal FDM hole is a teardrop with a 45° roof; a resin hole stays round | 1e-6 mm | the same |
| Lap step face at the typed Height | 1e-6 mm | plane of that face |
| Each piece is one solid, `BRepCheck_Analyzer` valid, every edge shared by two faces | exact | the same |
| A box cut square to its sides has six faces a half; a cube cut through all six faces has seven | exact | the same |
| Two planes through a tube's hole give four pieces: the middle slab is two bands that do not touch | exact | the same |
| Each placed id has its two holes, or one plug and one socket, coaxial | 1e-6 mm | the same |
| Tessellation at chord 0.05 mm has no free edge longer than the chord | chord | mesh check on the kernel mesh |
| Planner: 500 mm bar, 220 mm bed, 5 mm margin → three pieces | exact positions | `src/modeling/partition.test.ts` |
| Planner: the same bar along the IR3 V2's belt → one piece | exact | the same |
| Planner: 400 mm tall part, 210 mm resin height, 10 mm margin → three pieces across the height | exact positions | the same |
| Planner: a thin section drops the connector and keeps the cut | the warning sentence | the same |
| Planner: two connectors cannot sit closer than the wall floor | exact | the same |
| Defaults table formulas at nozzle 0.4 and 0.8, layer 0.2 and 0.28, and on the resin floors | exact | the same |
| Orientation: an FDM piece keeps the parent's plate orientation unless Joint down is set for it | exact matrix | the same |
| Part numbers land on the cut face, both mates of a cut, clear of connectors | the face id | the kernel test |
| Export: one STEP assembly of a partition holds every piece and the pins, named in assembly order | names and solid count | `mcp/` export test |
| `partition` is not in `MODEL_TOOLS`; the command has no keys | exact | beside the stress checks |
| Reader: a v4 file without the op is unchanged; `piece` still only on `split` | exact | `src/model-tree-file` test |
| Slice request of a plate that holds pieces has no new field | exact JSON | a unit test on the request builder |
| Golden G-code | byte-identical | `mcp/golden.test.ts`, `tools/golden.sh`, untouched |

The existing Split tests (`tests/kernel.rs`, `e2e/model-split-plane.spec.ts`) pass on every milestone. An implementation that diffs `crates/lime-slice-core` has left this plan.

The coupon bars are generated by the planner in M6 and checked against the same volume and clearance tests. The physical print is recorded by editing the clearance table and dropping **Starting fit** from the cells that were printed. That edit is a later change, with the measured number in the commit message.

## 15. Milestones

Each milestone leaves the app usable, leaves Split as it is, and leaves the golden G-code byte-identical.

1. **Planner.** `src/modeling/partition.ts` and its test: `target` with the FDM and resin floors, cuts, Fit the printer (the belt and resin examples included), profiles' sizes, connector placement, warnings. No kernel and no UI.
2. **Straight kernel cut.** `partition` with plane tools only, watertight pieces, volume tests. No plate change yet.
3. **History and plate.** One row, `pieces` keys, piece objects, pose kept and plate orientation kept, MCP probe (with `plan`) and apply for a straight plain cut. Edit round-trips. Connectors and profiles beyond straight are refused with a sentence. A resin target is refused too until 3b's export. `labels` is stored only when it is typed, since no number is cut yet: a default `{on: true}` stored now would cut numbers into old pieces on a 3b replay. The app has no panel yet; its history row reads the op, and the pencil says to use the MCP's `model_edit`.
3b. **Resin target and export.** The export-only Form 4 record, **Print on**, part numbers on the cut faces, export as STL per piece, one 3MF, or one STEP assembly, the support note, and Explode. After 3b, a tall part can be cut, exported, printed in PreForm, and assembled: the use case this feature is for.
4. **Panel.** The menu item, the card, typed and dragged planes, hover on the plane only, Playwright. No shortcut, rail unchanged. (3b's controls get their Playwright here.)
5. **Dowels and plugs.** Dowel holes and pins, the plug and its socket, the hardware hole, teardrops on FDM, pairing, thin-wall warnings, **Use N**. Key and dovetail still refused.
6. **Fit table.** Material clearances including the resin row, the Starting fit sentence, XY compensation warning, the FDM and resin coupon solids generated and checked. The prints are the human step after this milestone.
7. **Bed.** Joint down per piece, lay out, pins placed upright, with the orientations in the tests.
8. **Lap and tongue.** Profile parameters, drag handles, volume and face tests.
9. **Zig-zag and dovetail.** Including the discrete dovetail key, which shares the prism builder.
10. **Sketch profile.** Sketch card, solver dimensions, sweep, edit reopens the chain.
11. **Measured fits.** After the coupons are printed, update the table and the resin floors and retire Starting fit on the printed cells.

## 16. Open decisions

The plan is written to the recommendation in each row. Review can change any of them before implementation.

| # | Decision | Recommendation |
|---|---|---|
| 1 | Menu name | **Split to print…** It says why the cut exists. The rail's Split stays the single plane. |
| 2 | Cuts proposed when the tool opens on a part that does not fit | Prefill straight cuts, connectors off, and wait for Apply. **Clear cuts** is the opt-out. A part that fits opens with an empty list. |
| 3 | Clearance before the coupon is printed | Ship the table with the sentence **Starting fit**. Connectors are already off, so the number is used only after the user opts in. An empty field would block that path. |
| 4 | Orientation | Keep the orientation the cuts were planned in. **Joint down** per piece is the opt-in. A resin export keeps the pieces as cut for PreForm to orient. (Revised in review; was "Printable joint" on by default.) |
| 5 | Editing a partition | Rebuild every piece of that row in one undo step. Leaving the old piece, as Split does, would separate a pin's hole from its mate. |
| 6 | Shaped cuts at an angle | Refuse them. Straight cuts may meet. A swept profile needs one sweep direction. |
| 7 | Several connector types on one cut | The file stores a list. The first panel edits one type. Two types on one cut can wait for milestone 9. |
| 8 | Loose parts that go into both pieces | Yes for dowel pins, which are the default connector: identical, printed upright, orientation-free, and kinder to brittle resin. No loose key or dovetail; those stay fused to one piece. (Revised in review; was "leave loose parts out".) |
| 9 | Part numbers | Engrave them with the stroke font, on the cut face by default, so they are hidden once assembled and pair the mating faces. The object name stays editable and is not the assembly mark. (Revised in review; was a side face.) |
| 10 | Which piece keeps the plate id and the stress study | The negative side of the first cut. The study goes stale with the fingerprint. Other pieces get no study. |
| 11 | Belt printers | The axis along the belt is unbounded; only the belt's width and the gantry's height limit a part. A long part is what the IR3 V2 is for. Check's "Too large" on a long belt part is the same mistake and a separate fix. (Revised in review; was Check's 250 mm cube.) |
| 12 | Project version | Stay at 4. The op is inside the tree the file already stores. An older app drops that tree and opens the meshes. |
| 13 | Custom sketch in the first milestones | After the named profiles (milestone 10). Straight through dovetail cover the joints Marius listed; the sketch is the escape hatch. |
| 14 | Max pieces | 12, editable up to 24. |
| 15 | Target printer | The op stores `target` (printer, process, volume) from milestone 1. Absent means the plate's printer. A resin printer is an export-only library record. |
| 16 | The Formlabs model | Form 4, 200 × 125 × 210 mm. Confirmed on the printer's About screen (2026-10-23). |
| 17 | Export format for PreForm | STL per piece, one 3MF, or one STEP assembly; PreForm imports all three and keeps a STEP assembly. The default is the STEP assembly, which keeps the B-rep and the names. |

## 17. Constraints

- **Licence.** New code is MIT, in `src/modeling/` and in `lime-model-occt`. Open CASCADE stays the dynamically linked library it is, under the exception in `third_party/occt/NOTICE.md`. No new native dependency. No PlaneGCS, SolveSpace, CGAL, or libigl.
- **Offline.** The clearance table, the fonts, and the coupon geometry are in the repo. Nothing is fetched at run time.
- **Slicer output.** No new `SliceRequest` field and no new G-code comment. The pieces reach the slicer as plate meshes through the path an edited solid already uses. `mcp/golden.test.ts` and `tools/golden.sh` stay byte-identical.
- **Desktop first.** The card is the Model dock. The phone gets the same menu item and the same sheet the other Model tools use.
- **Existing behaviour.** Split, its shortcut, its op, its tests, `MODEL_TOOLS`, the command key map, the project reader for older files, and the stress study's fingerprint rule all stay as they are.
- **MCP size.** No new tool. The tool list stays inside the token budgets in `mcp/schema.test.ts`.
- **No resin slicing.** An export-only printer never reaches the slicer, and the plate's printer menu does not list it.

## 18. Changes in review (2026-10-23)

The first draft was FDM-only and oriented every piece joint-down. Review changed nine things:

1. **Belt printers.** The axis along the belt is unbounded (D11, decision 11). The draft used Check's 250 mm cube, which would cut the long parts the IR3 V2 prints in one piece.
2. **Orientation.** Pieces keep the orientation the cuts were planned in; **Joint down** is per-piece opt-in (section 10, decision 4). Standing a long piece on its cut face made it tall, slow, poorly stuck, and weakest in bending, and stood a plug with layers across its axis.
3. **Dowel pins are the default connector** (section 8, decision 8). The draft's fused peg needed the joint-down orientation and snaps at its base. The plug stays as a type.
4. **Holes across the layers are teardrops on FDM**, and PLA snug starts at 0.15 mm a side, not 0.10 (section 2).
5. **Part numbers go on the cut face**, hidden after assembly and pairing the mates (section 2, decision 9).
6. **MCP fits #405.** No `model_partition_plan` tool: the planner is `model_probe` with `plan: true`, the kind is one name on `model_apply`'s list and one `guide {kind}` entry, and all of it is in the `model` group, inside the token budget (section 13).
7. **A target printer on the op** (D11). Cutting is for a printer, which need not be the plate's. The use case is a Formlabs resin printer whose volume is too short for the parts.
8. **Floors come from the process** (section 2). FDM floors scale with the nozzle and layer; resin gets its own floors, clearance row, and coupon, labelled Starting fit.
9. **Export and reassembly** (D12, milestone 3b). STL, 3MF, or a STEP assembly for PreForm, the support note, part numbers on the mating faces, and Explode in Model. Milestone 3b delivers the resin use case right after the straight cut and the history row.
