# Plan: split a solid into printable parts

Status: plan, for review. Written 2026-10-22 against `main` at v3.7.0 (`5d1e7e9`). Revised 2026-10-23 after review (section 18 lists what changed and why). Milestones 1 to 10 are built; sections 19 to 21 and 23 to 27 record what they changed.

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
| TPU (added in milestone 6, section 23) | 0.25 | 0.35 | 0.15 |
| Resin, tough or standard (Formlabs Tough 2000 is the first) | 0.10 | 0.20 | 0.05 |
| Anything else, including flexible resins | — | — | — |

PLA, PETG, ABS (ASA reads as ABS), and TPU match the filament ids already in `src/ui/machine-library.ts`. The resin row is read for an export-only resin printer (D11). Snug is the fit the coupon is built to confirm: the parts stay together and come apart by hand. Loose is for a joint that must slide. Press is for a joint that must not. A flexible resin and any unnamed material do not get a row. Turning connectors on says "No fit for this material. Type a clearance, or leave connectors off." and leaves the field empty until a number is typed.

Every cell carries its source, `starting` or `measured` (section 23). Every cell is `starting` until a coupon is printed.

PLA snug starts at 0.15 mm, not 0.10 mm. At 0.10 mm a side, a hole printed on its side, which the default orientation makes common, is already tight before it sags. The coupon settles the number. Resin parts grow slightly where the light bleeds past the edge, so the resin row is not the FDM row.

Clearance does not scale with the feature width. Hole error at a given setting is not proportional to the nozzle. The minimum sizes above do scale with the feature width. The layer changes Depth, End gap, and the number depth. It does not change Clearance.

XY hole compensation (`xyHoleCompensationMm` in `src/xy-comp.ts`, default 0) is a slice setting. It is not baked into the solid. When it is not 0, the note says "XY hole compensation is N mm. It changes the hole again when slicing. Clearance here is the solid." Elephant's foot is the same: a warning, not a change to the B-rep. Baking either one into the solid would make the part depend on a slicer setting and would put this feature on the slice path.

### The coupon that retires "Starting fit"

One printed bar, 80 × 20 × 10 mm, cut in the middle, with dowel holes of the default radius and depth and a set of pins, repeated at 0.05, 0.10, 0.15, 0.20, and 0.25 mm clearance, in the plate's filament, nozzle 0.4 mm, layers 0.2 mm, XY compensation 0. The bar is printed lying down, so its holes are teardrops across the layers, as the default orientation makes them. A second bar carries the default lap, the default tongue, and the default dovetail. M6 generates both bars as solids. A person prints them. The clearance that snug actually was replaces the PLA snug cell, the label **Starting fit** comes off that cell, and the test expects the new number. Until that print, the sentence stays.

The resin coupon is the same two bars, exported for the Formlabs printer in Tough 2000, with round holes. It retires **Starting fit** on the resin row and on the resin floors in section 2.

Milestone 6 built the dowel coupon in a different shape from this bar, and not the second bar: see section 23.

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

A connector id is `c{cut}-{index}`. A dowel is a hole in both pieces, coaxial, and a pin; the count is the cut's `placed` list, and every cut's pins are one pins object (section 21); the pins are identical, so they need no pairing. A plug is fused to one piece and its socket is cut from the mate. The kernel refuses a spec that names a plug without its socket, or a dowel hole without its mate. Piece order is along W of the first cut, negative to positive, then along the next cut. Part numbers follow that order.

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

When `target.process` is not the plate's, or the user chooses **Export**, Apply leaves the pieces in Model, in place, and the card offers the export: one STL per piece, one 3MF with every piece named, or one STEP file with every piece as a named solid. PreForm imports all three, and keeps a STEP assembly as an assembly (Formlabs support, "Opening a model in PreForm"), so the names identify the pieces there. The pins are exported as one more part. Piece names carry the part number and the source name: `cover-1.stl`, `cover-2.stl`, `cover-pins.stl`. No support, tilt, or hollowing is added; the resin slicer does those. The export note says to keep supports off the cut faces, which carry the fit and the number.

As built in 3b: the pieces of an export target are trees of their own, as an FDM target's are, held as objects off the plate. They are never plate objects, never committed, and never sent to the slicer: a commit, a slice, or a plate 3MF of a part whose step is past such a cut is refused with a sentence that says to export. The project saves them beside the op (section 20, `heldPieces`), so a reopen has them as they were cut; a file saved without them cuts the missing pieces again from the stored op, with its target and volume (D11), on a spare step. The STEP file names its pieces: the owner approved a named STEP assembly after 3b, and the kernel writes it through an XCAF document (`STEPCAFControl_Writer`), each piece a free shape with a `TDataStd_Name` of `<source>-<n>` in assembly order, the same names as the 3MF and the STL files (`pieceNames`). The schema (AP214), units and p-curve mode are those of the one-solid export, and the XCAF toolkits (`TKXCAF`, `TKLCAF`, `TKCAF`, and `STEPCAFControl` inside `TKDESTEP`) were already linked and shipped for the STEP reader, so it adds no library. The export request carries the names in `names`, an engine field the reply does not echo, and the engine refuses pieces without one name for each.

For reassembly, Model already keeps the pieces where they were cut. **Explode** spreads them along each cut's normal by a typed gap and shows each number on its cut face. It is a view, not an op, and it changes nothing that is saved.

## 5. Defining the cuts

### By typing

Each cut is a row. The row has At X, At Y, or At Z, the number in model space, and Tilt A and Tilt B. On a local workplane the axes are U, V, and W, as Split's are (`docs/local-workplane.md`). **Face** aims the plane at the picked flat face plus an offset, and then the cut is stored as origin and normal, so a replay does not depend on face numbers. A curved face is refused with Split's sentence: "Pick a flat face. This one is curved."

Every number accepts an expression. The text is stored on `exprs` and stripped before the engine call. (Milestone 4's card evaluates an expression into its number; keeping the text on the op waits until a parameter change can rebuild a split to print, which `refreshOp` does not yet do for this kind.)

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
| Hardware hole | Diameter, Depth, Clearance, End gap | A hole in each piece for a bought pin or magnet; nothing is made to go in it. Depth is the bought part's whole length, as a dowel pin's. |
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

**Lay out on the bed** places only the new pieces, with `ARRANGE_GAP_MM` on the plate's printer, around the objects already on the plate, which stay where they are (`arrangedObjects` with `keep`); the part's own first piece counts where its new mesh lands. It runs once the pieces have plate meshes: in the app that is the Apply that makes them, as a split's piece; on the MCP it is the `model_commit` that first puts them on the plate (milestone 3). An Update lays out only a part number that is new. Off leaves the pieces sharing one spot, and the readout uses Split's sentence about Arrange. Dowel pins go on the plate as one more object, standing upright.

Part numbers are engraved, not a separate object. The string is the index, "1", "2", "3". Height and Depth are the label fields. The strokes are `textStrokes`'s, 0.15 of the height wide as `compose.ts` draws text; the client builds them and the kernel places them, since only the kernel sees the cut faces. A label keeps the wall floor (`2 × f`) from the face's edge and from any hole in it. A side face is used only when no cut face of that piece has room. A new partition stores `labels: {on: true, face, height, depth}` in full; an op stored before 3b has no `labels` and cuts no number on a replay. The default face is the cut face (section 2), so the number is hidden once the parts are assembled, and both mating faces of a cut carry their numbers side by side. A drag moves it. A later rename of the plate object does not change the engraved digit, because the digit is geometry. The note under the checkbox says that. **Part numbers** off stores no text and cuts no digits.

These choices are fields of the op (`orient`, `arrange`, `labels`, `target`). Edit shows them again. They are not slicer settings.

## 11. History

The row label comes from the stored op, in the part's own frame, as Split's labels do:

- "Split to print, 3 parts"
- "Split to print, 3 parts, dowels"
- "Split to print, lap, 2 parts"
- "Split to print, sketch, 2 parts"
- "Split to print for Formlabs Form 4, 3 parts" (an export target names its printer, as the library names it)

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
  ],
  "placed": [
    { "id": "c1-1", "type": "dowel", "uvMm": [-12, 0], "fraction": [0.3, 0.5], "fixed": false },
    { "id": "c1-2", "type": "dowel", "uvMm": [12, 0], "fraction": [0.7, 0.5], "fixed": false }
  ]
}
```

`placed` is what the planner placed at Apply and the kernel built (D6); the tree stores only the ones that built, so a replay builds those. An op with connectors on also stores `"up": [x, y, z]`, the print's up in the solid's frame at Apply (the third row of the plate orientation), which a teardrop's roof and the pins follow.

For a dowel, Depth is the pin's whole length and each piece's hole takes half of it plus the end gap. A plug stores `"type": "plug"` and `"side"`. Absent fields mean the section 2 default. A saved file from before this op has no `partition`, and it opens unchanged.

## 12. UI

**Split to print…** is in the Features menu. The command palette entry has no shortcut. The rail's Split button stays Split.

The card is a left-aligned form in the Model dock. The fields scroll. Apply is the primary button and stays pinned, with Cancel. The status title is short. The steps sit in How.

Rows, top to bottom: **Print on** (the target printer, the plate's printer first), the fit note, the cut list, the selected cut's plane, its profile, its connectors, then the piece list with orientation and numbers. Each cut's row carries its own At X, At Y, or At Z (or Offset, for a face), so every plane on the view has the field it changes; the selected cut's plane has X, Y, Z, and Face, and Tilt A and Tilt B. **Add cut**, **Fit the bed** (or **Fit the printer** for an export target), and **Clear cuts** sit on the cut list. **Connectors** is a checkbox on the selected cut. With it off, the connector fields are hidden, not merely disabled, so a plain cut shows a plain card.

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

| `export_3mf`, `model_export_step` | `{object, name, pieces: true}` takes the pieces of the last split to print on the way to the part's step (and, from M5, its pins): one 3MF with each piece named `<name>-<n>`, or one STEP assembly of the pieces in that order, each named `<name>-<n>` as in the 3MF. There is no per-object mesh export tool, so per-piece STL is `export_3mf` with `stl: true`: one `<name>-<n>.stl` each. Every reply carries the support note. |

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
| Export: one STEP of a partition holds every piece (and, from M5, the pins) as a named solid in assembly order, and reads back, through an XCAF document, as free shapes named `<source>-<n>` with each piece's volume, and through the plain reader as the same solids; the 3MF and the STL files are named the same | solid count, names, volumes within 1e-3 mm³ | `tests/partition_export.rs`, `mcp/partition.test.ts`, `mcp/occt.test.ts` |
| Part numbers: both mates of a cut carry their number on the cut face; a number with no room on any cut face goes on a side face, and with none at all is left out with "Part N has no room for a number."; the volume lost is the number's area times its depth | exact on planar strokes (1e-6 mm³) | `tests/partition_export.rs` |
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
7. **Bed.** Joint down per piece and lay out, with the orientations in the tests. (Pins placed upright came with milestone 5, section 21.)
8. **Lap and tongue.** Profile parameters, drag handles, volume and face tests.
9. **Zig-zag and dovetail.** Including the discrete dovetail key, which shares the prism builder.
10. **Sketch profile.** Sketch card, solver dimensions, sweep, edit reopens the chain.
11. **Measured fits.** After the coupons are printed, update the table and the resin floors and retire Starting fit on the printed cells. Built in section 28 without the prints: a reviewed table and the flow that enters results.

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
| 17 | Export format for PreForm | STL per piece, one 3MF, or one STEP assembly of named solids; PreForm imports all three. The default is the STEP, which keeps the B-rep. Its solids are named `<source>-<n>` through the XCAF writer (D12), as the 3MF and STL files are. |

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

## 19. Changes in milestone 4 (2026-10-23)

Milestone 4 adds the card and closes what milestone 3 left open. It changed seven things:

1. **Lay out places only the new pieces** (section 10). `arrangedObjects` takes `keep`, the objects that stay; the others are placed around them in turn, where an added object would land. The app lays out at Apply, around the part's first piece where its new mesh lands; `model_commit` on the MCP does the same instead of the whole-plate Arrange, which moved objects the user had placed.
2. **D9's kept steps.** An edit's `keepBroken: true` (`docs/step-modeler.md`) keeps a rebuilt piece's first later step broken, with the rest under it, instead of keeping nothing; the piece shows its new root and the row says why. The next rebuild replays that kept branch too (`keptSteps`), so a step that missed the piece once is tried again, not lost. A Rust tree test, the MCP test, and Playwright cover it.
3. **Each cut's number is on its row** (section 12). Hover, drag, or focus lights only that plane and its own field, so every plane needs one: the rows carry At X, At Y, or At Z, and the selected cut's plane keeps X, Y, Z, Face, and the tilts. Every plane has an arrow; the selected one also has the tilt rings.
4. **Expressions evaluate; their text waits** (section 5). The card's fields take an expression as every Model field does, but the op does not store `exprs` yet: a parameter change cannot rebuild a split to print until `refreshOp` has a case for it.
5. **An edit through a join is refused.** A split to print in a tool's tree, reached through another part's History, says "Edit this split to print from the part it cut."; its own part edits it.
6. **Model Undo leaves the pieces on the plate**, as it leaves a split's piece (the owner's rule that jumping back before a Split keeps its piece); the visit's one Prepare step is what takes an Apply or an Update back whole. The MCP's `model_undo` still takes them off, as milestone 3 built it.
7. **The planes stop at the section.** Each cut's square is twice the part's furthest corner from it, in its plane, rather than Split's 1.45 times the part's largest side, so a long bar's cuts stay readable and the lit outline is that cut's own.

## 20. Milestone 3b as built, and what the card wires after milestone 4

3b ran beside milestone 4, so it is the engine, the library, the export, the MCP and the Explode view. The card (`src/split-print.ts`, `src/ui/split-print.ts`) is now on `main`; its 3b controls are a small follow-up. The op both write is `storedPartition` in `src/split-print.ts`, so a card Apply already stores `labels` in full and cuts part numbers, and `exportsPieces`, `exportedNote` and `exportedCommit` sit beside it for the card to use.

Built:

- **Resin target.** The kernel and the server cut a `target.process: "resin"` op. `model_probe` with `plan: true` takes `target: {printer: "formlabs-form-4"}` and fits the Form 4's volume, with the resin floors and the 10 mm margin; `arrange` is stored false and `orient` keep.
- **The Form 4.** `FORMLABS_FORM_4` in `src/ui/machine-library.ts` is an `ExportPrinterRecord`, marked `exportOnly: true`. It is not a `PrinterRecord`, so it is never in `printers`, `enginePrinter` cannot take it, and `selectIn` and `machine_select` refuse it with a sentence. `targetPrinters(library)` is the Print on list (the plate's printer first, the Form 4 last) and `printerTarget(row)` the op's `target`.
- **Pieces of an export target** are held off the plate (D12, as built), and saved with the project. `.lime` keeps them in `heldPieces`, a list beside `objects`, one row per piece: the part's plate object (`object`), the cut's step in its tree (`node`), and the part number (`index`, from 2) or `pins: true` for a dowelled cut's pins (section 21, item 5), with the piece's mesh (`mesh`, `meshSeatMm`) and its solid (`brep`), records as a plate object's are, compressed in version 4. The project version stays 4, and the cut's `pieces` and `pins` still say null, as the app wrote them before, so an older app ignores the key and opens the file as its own. A reopen holds each piece again under a fresh key, its tree opened in the engine from its saved solid when a STEP export first needs it, with no cut. A file 3.8.0 saved, with the op and not its pieces, cuts them again, and its pins with them, when Model shows the cut, on a spare step as `export_3mf` does (`partitionPieces`), and the next save keeps them. Model opens on such a cut when it is the part's latest step: the plate still holds the step before it.
- **Part numbers** (section 10). `partitionNumbers` in `src/modeling/partition.ts` builds the strokes; the kernel places and cuts them, and answers `numbers` and `notes`.
- **Export.** `export_3mf {object, name, pieces: true}` (one 3MF, or `stl: true` for one STL each) and `model_export_step {object, name, pieces: true}` (one STEP assembly of named solids), every reply with `SUPPORT_NOTE`. Names come from `pieceNames` in `src/modeling/partition-export.ts`. The 3MF writer now writes each zip entry's CRC-32: the slicer's own 3MF reader refused the file without it, and so would any reader that checks.
- **Explode.** In Model's View menu, shown when the open part has a split to print with pieces on screen. `data-explode` on `#model` is the gap, `data-explode-parts` each part's shift, and a tag over each piece shows its number. It saves nothing.

The card follow-up wires:

1. **Print on**, a menu of `targetPrinters(library)` by name, the plate's printer selected. Choosing one writes `target: printerTarget(row)` into the op the card applies; for an export-only row the fit button reads **Fit the printer** and the planner call (`fitPrinter`, `fillPartition`) already reads the target.
2. **Part numbers**, a checkbox, on by default (the stored op already says on). On writes `labels: {on: true, face: "cut", height, depth}` with `partitionDefaults(...).numberHeightMm` and `numberDepthMm` for the target's process; off writes `{on: false}`. The note under it says the digit is geometry and a rename does not change it. Show the apply reply's `notes` ("Part 2 has no room for a number.") in the card.
3. **Apply for an export target** in the app. Send `pieceKeys` as today, but hold each piece's tree in `modelTrees` without a plate object (do not `placePiece`), and have `commitModel` leave a part whose step is past such a cut off the plate with `exportedCommit`'s sentence (`src/split-print.ts`). Lay out (section 19, item 1) skips such pieces, since they never reach the plate. Then `members()` in `src/app/model-explode.ts` must also take those off-plate pieces, from their trees' meshes, since today it finds pieces by plate object.
4. **Export…**, the card's second button for an export target: a save dialog with STL per piece, one 3MF, or one STEP, built from `pieceNames`, `encode3mf(meshes, names)`, `encodeStl`, and `exportRequest(key, node, "step", pieces, names)` with `names` from `pieceNames`, with `SUPPORT_NOTE` beside it. The pins file joins `pieceNames` as `<source>-pins` in milestone 5.
5. **Playwright** for those controls, beside `e2e/model-split-print.spec.ts`.

Done in the card follow-up (`claude/partition-card-export`), all five, with these as built:

- **Print on** is `#modelPartTarget`, from `splitPrinters()` in `src/app/model.ts`. The plate's printer is the first row and writes no `target` (absent means the plate's, D11); every other row writes `printerTarget(row)`. A new target plans the cuts again only while `Card.edited` is false; typed, dragged, added or cleared cuts stay and only the note follows. For an export target the fit button reads Fit the printer and Lay out is hidden.
- **Part numbers** is `#modelPartNumbers`. Off stores `labels: {on: false}` alone: `storedPartition` no longer pads it with a face, height and depth. The kernel's `notes` show under the checkbox while the card checks, and in the card after an Apply.
- **Apply for an export target** holds each piece's tree through `putPieces(..., held)` and puts nothing on the plate. `commitModel` leaves such a part as the plate had it, and `exportedPart()` gives `exportedCommit`'s sentence to a slice (`runSlice`) and to the plate's 3MF (`export3mf`). After the Apply the card stays open on a summary with **Export…** and Close in the foot (`showSplitPrintDone`), since Apply otherwise closes it.
- **Explode** takes held pieces from their trees' meshes (`heldPiece`, `heldParts` in `src/app/model-explode.ts`). Held pieces are also drawn as grey context in Model, where they were cut, whether Explode is on or not.
- **Export…** is `exportPieceFiles` in `src/app/model.ts`, from the card's foot and from a partition row's menu. `src/ui/split-export.ts` is the dialog and `pieceFiles`, the one place the file names are made: milestone 5's `<source>-pins` is one more name there and one more mesh in `exportPieceFiles`. Saves go through `saveBytes` (`src/app/save-bytes.ts`), which File, Export 3MF and Model's STEP button now share: the desktop save dialog, or a download in the web build. The STEP request carries `names`.

Not done: in the desktop app STL per piece opens one save dialog per file, since `save_text_file` saves one file. A folder picker would need a new Tauri command.

## 21. Changes in milestone 5 (2026-10-23)

Milestone 5 builds dowels, plugs and hardware holes, and lifts milestone 3's refusal of `connectors.on` for those three; a key or a dovetail is still refused, with "Key and dovetail connectors are not built yet. They come with the zig-zag and dovetail profiles. Use a dowel, a plug, or a hardware hole." It changed nine things:

1. **The planner places on the mesh's section.** `sectionLoops` in `src/section-cap.ts` cuts the solid's mesh at each cut, in the cut's U and V, and `placeCut` in `src/modeling/partition.ts` runs `placeConnectors` on it for each type of the cut, numbering the ids along the cut. `storedPartition` (`src/split-print.ts`) takes the mesh and the plate's up and writes each cut's filled `types` and `placed`, so the card, `model_probe` with `plan: true` and an Apply all store the same placement (D6). The section is the largest outline and the holes inside it; a cut through two separate regions places on the larger one.
2. **The kernel builds each placed connector on the real pieces, then the numbers.** `build_joints` in kernel.cpp applies each fraction to the box of the section the split made (D5: the negative side's caps on that plane), finds the two pieces that meet at the centre, and cuts or fuses there. A connector whose centre is on no cut face of two pieces is dropped as `outside`; one whose cut does not take exactly its tool's volume from each piece, or whose result is not one valid, closed solid, is dropped as `breaks`, which is how a hole that would break through the outline shows on the real solid. The kernel has no wall measure of its own: the planner's wall floor is the thin-wall check. Numbers are engraved after the connectors, so a label keeps clear of every hole.
3. **The reply and the stored op.** Probe, apply and edit answer `connectors: {placed: [{id, at, teardrop}], dropped: [{id, reason, sentence}]}`, and the dropped sentences, then "Cut N: no dowel fits. It is a plain cut." for a cut whose every connector was dropped, come first in `notes`. The stored op keeps only the placed ones; a retried apply of the op as asked is still the same step.
4. **The teardrop is the cylinder fused with a prism, as section 7 says.** The prism is the kite of the two tangents from the apex `r√2` along the roof and the centre, so the hole keeps its `Geom_CylindricalSurface` and the roof is two planes at 45° to up. The roof follows `up` projected off the hole's axis; an axis within 45° of vertical, or a round hole asked for, stays round. Resin defaults to round, FDM to teardrop (`fillConnector`).
5. **The pins are one object for the whole cut, not one per cut.** D7 said one pin object per cut; one plate object is what section 10 and the node's `pins: string | null` say, so every placed dowel's pin is one solid in one compound, under `pinsKey` on apply and edit, rooted as `{kind: "piece", tree, node, pins: true}`. Each pin is a revolve of its chamfered outline, 0.5 mm at each end (less on a very small pin), standing along `up` in a row beside the part on the floor it stands on, so the pins object takes the part's plate orientation like a piece and stands upright on the plate; Lay out places it with the new pieces. For an export target the pins are held off the plate and export last, `<source>-pins`, in the STL set, the 3MF and the named STEP (`pieceNames(source, count, pins)`). Undo and redo, an Update and the MCP's edit take the pins with the pieces.
6. **Hardware holes have an end gap.** Section 8 listed Diameter, Depth and Clearance; with Depth the bought part's whole length, each hole is half of it plus the end gap, as a dowel's, so the type takes `endGap` too.
7. **The card.** Each cut has a **Connectors** checkbox below its plane; off hides every field. On shows Type, Radius or Diameter, Depth, Count (empty is Fit), Margin, End gap, Clearance (Snug, Loose, Press or Typed, with "Starting fit" and the per-side and on-diameter text, and the XY hole compensation note when it is not 0), Hole shape, and Plug side for a plug. The planner's sentences for the selected cut show under the fields, with **Use N** when a typed count does not fit. The ghost draws each placed connector's hole across its cut; once the kernel has checked the cut, it keeps only the ones the kernel built. The card's check asks for no preview mesh, so the probe does not replace the ghost with a cut mesh, as section 7 planned for the other tools.
8. **Dragging a connector is left for later.** Typed positions are the MCP's `place: "fixed"` with `at` in millimetres on the cut; the card places by Fit or a count. **Refit** waits for the drag.
9. **History rows** name the connectors that were built: "Split to print, 3 parts, dowels", "…, plugs", "…, holes", or "…, connectors" for mixed types. A cut whose every connector was dropped is a plain row.

## 22. Changes after 3.8.0: turn the part for an export target

The Telo cover is 680 × 97 × 150 mm. Cut for the Form 4 (200 × 125 × 210 mm, 10 mm margin, usable 180 × 105 × 190) with its 680 mm along the plate's Y, it took 7 pieces, since Y has 105 mm of room. It takes 4. It changed four things:

1. **Fit the printer may turn the part, for an export target only.** The pieces never reach the slicer: the owner orients them in PreForm. `fitPrinter` tries the six ways to set the part's axes against the volume's (a turn of 90° in plan, or the part stood on its side; no tilt) and keeps the one with the fewest pieces. A tie keeps the plate's orientation, then the longest axis against the longest. An FDM target, or a belt, is never turned: its pieces become plate objects in the orientation they were cut in, so its cuts and its sentences are unchanged.
2. **The cuts stay planes of the part's own frame.** The op stores them as before and the pieces are not rotated in the file. Only the fit test looks at a turned part. `model_probe` with `plan: true` and the card come from the same planner and give the same count.
3. **The card says which axis was matched**, as the first sentence: "Cut for the Formlabs Form 4 with the part's 680 mm along the volume's 210 mm height: 4 parts." It is left out when the plate's orientation already gives the fewest pieces. The per-cut sentences after it when the part is turned, they are replaced by "Three cuts are proposed.", since the first sentence already gives the spans. The tilt note is one sentence for all the pieces that share a height: "Pieces 1–4 are 170 mm tall. Tilted in PreForm they may not fit; a fourth cut would leave room."
4. **The margin and the tilt note are unchanged.** The 10 mm margin is still taken off each side of the volume. The tilt note reads the height of the part axis that stands up in the volume.

The minimum for the Telo is 4, whatever the turn: 680 mm over the longest usable length, 190 mm, is 3.58. Unit tests cover the Telo's 4 pieces (7 as an FDM part), a tie that keeps the plate's orientation, and the over-Max-pieces count; `mcp/partition.test.ts` and `e2e/model-split-print.spec.ts` cover the plan and the card.

## 23. Changes in milestone 6 (2026-10-27)

Milestone 6 is the fit table and the fit coupon. The coupon is generated and checked; printing it is the human step. It changed seven things:

1. **Each clearance cell has a source.** `CLEARANCE_TABLE` in `src/modeling/partition.ts` keeps its numbers and gains `source: {snug, loose, press}`, each `starting` or `measured`, with `startingFit` true while any cell is `starting`. `clearanceKey` names the row (ASA reads as ABS; resin ignores the material), `clearanceCell` gives a cell's number and source, and `measuredRow(row, fit, mm)` is the one function milestone 11 uses. TPU has a row now (0.25, 0.35, 0.15 mm), as the brief for this milestone asked; section 2 said TPU had none. Those three numbers are guesses, wider than the rigid filaments' since TPU gives, and the cells say `starting`. A flexible resin and an unnamed material still have no row, and still get "No fit for this material. Type a clearance, or leave connectors off."
2. **The card's Clearance sentence names its source.** `clearanceSentence(each, source)` is the one place it is made: "Starting fit. 0.15 mm each side (0.3 mm on the diameter).", "Measured. 0.12 mm each side (0.24 mm on the diameter).", or, for a number the user typed, "Typed. 0.2 mm each side (0.4 mm on the diameter)." A typed number had no source word before. The XY hole compensation sentence is unchanged and still follows it while `xyHoleCompensationMm` is not 0.
3. **The coupon is a plate of dowel holes, not the bar.** `fitCoupon` in `src/modeling/fit-coupon.ts` lays out one plate for one process and material: seven blind holes bored into its front face along +Y, at the table's Snug less 0.10, 0.05, then 0 to plus 0.20 mm in 0.05 mm steps (PETG: 0.10 to 0.40; resin: 0.00 to 0.30), for the dowel radius, length, end gap and hole shape the card has. A step that would leave a negative gap is left out. Each hole is the radius plus that step, a teardrop on FDM, with the plate printed lying down, as the plan's bar was, and round on resin. Under each hole its gap each side is engraved with the stroke font that engraves part numbers, `NUMBER_STROKE_FRACTION` wide and `numberDepthMm` deep ("0.15"; the font's dot has no length, so the planner makes it a square of the stroke's width). The labels sit under their holes, at least 2 mm from every hole's wall and the plate's edge by the wall floor. One chamfered pin of the same radius and length stands beside the plate, and prints upright. The plate is at least 10 mm thick, 115.6 × 10 × 16.7 mm for the default PETG dowel.
   - **Not built, and why.** The second bar (lap, tongue, dovetail) waits for those profiles in milestones 8 and 9. The plug and socket pair is not built: it is the same hole with a peg fused to a second plate, and the dowel coupon already measures the clearance both share. One pin, not a pin at each step: the pins are identical, so one tries every hole, and one solid is one STEP file that opens as one object.
4. **The kernel builds it.** `build_fit_coupon` in `kernel.cpp` reuses the connectors' `hole_tool` (the cylinder, with the 45° kite for a teardrop), `make_pin` and the label strokes' polygons, and cuts the holes, then the labels, each as one checked solid. `lime_tree_fit_coupon` is its C entry, and `fitCoupon` a stateless tree call that answers the plate and the pins each as a STEP file (`stepB64`), their volumes, and the volume the labels took. A hole that leaves the plate, or a coupon with no hole, is refused in a sentence.
5. **The card asks for it.** **Print a fit coupon…** sits under the Clearance note, with the connectors' fields. It centres the coupon on the card's current clearance (Snug, Loose, Press or a typed number) and uses the card's dowel. For the plate's printer the plate and its pin are added as two STEP plate objects, each one Model can open, and the selection stays where it was, so the card stays open on its cuts (`addMeshBytes` takes `quiet`). For an export target, the Form 4, the two STEP files are saved. The card shows what it did or the planner's refusal.
6. **The MCP asks for it.** `solid_new {coupon: {printer?, material?, radius?, depth?, hole?, startMm?}}` adds the two objects, or for `printer: "formlabs-form-4"` writes the two STEP files into the workspace and adds nothing to the plate. No new tool. `lime://guide/ops` says so in one line, and `solid_new` stays inside its token budget.
7. **Tests.** `src/modeling/partition.test.ts` (table lookups, the source flag, the sentences, `measuredRow`) and `src/modeling/fit-coupon.test.ts` (the steps, labels clear of the holes, the plate's walls, the request and reply, and the fixtures below); `crates/lime-model-occt/tests/fit_coupon.rs` builds the planner's layout for PETG and for resin and checks closed, valid solids, each hole's radius from its `Geom_CylindricalSurface` to 1e-9 mm against the label's gap, the roofs, the volume by hand to 1e-6 mm³, and the labels clear of the holes; `mcp/occt.test.ts` runs `solid_new {coupon}` on the real kernel; `e2e/model-split-print.spec.ts` covers the card against the engine's mock and `e2e/fit-coupon-real.spec.ts` against the real engine. The layouts the Rust test builds are `crates/lime-model-occt/tests/fit_coupon/*.json`, written by `LIME_WRITE_FIXTURES=1 node --experimental-strip-types src/modeling/fit-coupon.test.ts`, which fails when they drift from the planner.

### What milestone 11 needs

Printing is the human step: the owner prints the plate and its pin from the card or `solid_new {coupon}` in the plate's filament at nozzle 0.4 mm, layer 0.2 mm and XY hole compensation 0 (the card says so while it is not), and for the Form 4 in Tough 2000, and finds the hole the pin pushes into by hand and stays in. The label under it is the clearance each side. The data model takes that as it is:

- **The entry** is a process and material (a table key from `clearanceKey`), a fit (Snug, Loose or Press: the cell that step stands for) and the label's number in millimetres each side. A coupon that no step fitted is run again with `startMm` moved, since the labels are absolute.
- **The update** is `measuredRow(row, fit, mm)`: it sets the number, sets that cell's source to `measured`, and leaves the other cells `starting`. The card, `model_probe` and the MCP read the table, so "Starting fit." becomes "Measured." for that cell alone and the Starting fit label goes once every cell of a row is measured. The table stays code, as section 14 says: the edit is a later change that puts the measured number, the material and the printer in its commit message, and the unit test's expected rows change with it. A cell's `source` is the only new field the data model needs.
- **The resin floors** (`RESIN_FEATURE_MM`, `RESIN_LAYER_MM` and the resin bed margin) are not in the table. The resin coupon's other half, whether an unsupported 0.5 mm wall survives in Tough 2000, is not measured by this coupon, since its pin and holes are 3 mm. Milestone 11 either leaves those floors as starting values or adds a thin-wall row to the coupon first.

## 24. Changes in milestone 7 (2026-10-27)

Milestone 7 is the bed: Joint down per piece, and the lay out of the turned pieces. The op's `orient` was stored from milestone 1 and read by nothing; now it is wired end to end. It changed six things:

1. **A piece's joint is read from its own mesh** (`src/modeling/joint-down.ts`). `jointFaces` finds the triangles of the piece that lie on a cut plane (to 1e-3 mm, the float32 mesh's reach on a 500 mm part) and face along or against its normal, groups them by cut and side, and sums their area. The winding gives the outward side, so a piece on either side of a cut, a tilted cut and a piece between two cuts all read the same way, and no kernel call is needed. `jointDown` turns the piece so the **larger** cut face's outward normal is −Z: the matrix's third row is minus that normal. Equal faces go to the earlier cut. A piece with no cut face keeps, and says so.
2. **The turn about Z.** The matrix's first two rows put the piece's long way, the principal axis of its distinct vertices in the bed plane, along X; on a belt printer along Y. A piece that spreads alike every way (a cube, or a square bar's end) has no long way, and its own axes stand. Each distinct vertex counts once, since a triangulated square counts its diagonal twice and tilted the first version's bar 45°.
3. **What Joint down means on a belt.** The cut face goes on the belt, the plate's z = 0, as on a bed: the printer slices the plate in the belt's own frame, so no belt-specific matrix is needed. The piece's long way lies along the belt (plate Y), since the belt's length is unbounded and its width is not, and Lay out stacks the pieces along it: on a belt printer `arrangedObjects` is given a bed length of 10⁶ mm, so a piece never goes past the width and the pieces end on one another's far side. A piece wider than the belt is still the planner's concern (Fit the printer's belt axis), not this lay out's.
4. **The card.** Each piece row in the piece list has a menu, Keep or Joint down, once the kernel has checked the cut. The op stores `orient` as `"keep"` when no piece is set to joint, else one choice per part with part 1, the part itself, first. For an export target (the Form 4) the menus are not shown: the pieces stay as cut for PreForm (D4), and a note under the list says so; the card then stores no `orient`. The sentence after Apply says what was chosen: "Part 2 is joint down on cut 1, its larger cut face, 400 mm²." ("only" when the piece has one cut face.) An Update that changes a choice is a change, so it offers Update.
5. **Apply and Update turn the pieces in the step that makes them.** `orientPieces` (the app) and `settleOrients` (the MCP) run after the pieces are objects and before the lay out, so one Prepare undo takes pieces, turns and layout back together. The turned objects go into the lay out with the new ones, so an Update never leaves a turned piece on its neighbour. The part itself is piece 1: Joint down turns the part's own plate object. Its orientation from before is kept (`keptOrients`) so Keep, an Update or a step above the cut gives it back, and a new piece, and the pins, take that part's own orientation, not the turned one: the **pins stay upright**. On the MCP, `settleOrients` is idempotent and also runs on `model_undo`, `model_goto` and redo.
6. **The MCP.** `orient` is a field of the partition op on probe, apply and edit, as before: a list of words, which the parameter reader had read as expressions until `orient` as a list was added to its text fields. Apply and edit answer the sentences in `notes`. No new tool; the schema's `orient` line and the ops guide say how to use it.

Limits. A piece with a profiled cut (milestones 8 to 10) will have a joint face that is not flat; Joint down then uses the largest flat face on a cut plane, and the teeth note of section 10 is that milestone's. The plan's "taller than the volume" refusal (section 10) is not built: on the plate's printer the existing off-bed notes say it. The part's own Joint down is not laid out against objects that were on the plate before: the part keeps its place and the pieces go around it.

The profiled-cut limit above is answered in section 25.

Tests. `src/modeling/joint-down.test.ts`: the matrix for an axis cut, a tilted cut and a piece between two cuts (the normal goes to (0, 0, −1) to 1e-9, every corner of the face at the lowest z), the belt's Y, the choices; `src/plate.test.ts`: the belt's lay out; `mcp/occt.test.ts` on the real kernel: after apply and commit on the 500 mm bar each Joint down piece's cut face normal is (0, 0, −1) to 1e-9, the face is its lowest plane, the pieces stand on the bed 20 × 20 × 166.67 mm and none overlap, an edit to keep turns a piece back, and `model_undo` takes the pieces off; `e2e/model-split-print.spec.ts`: the menu, the stored `orient`, the turn, an Update and one Prepare undo, and the Form 4's note.

## 25. Changes in milestone 8 (2026-10-27)

Milestone 8 builds the lap and the tongue, the first shaped cuts, and lifts the profile refusal for those two. A zig-zag, a dovetail and a sketch are still refused ("Only straight cuts, laps and tongues are built yet. Leave the profile out, or make it straight, a lap or a tongue."). It changed eight things:

1. **A lap is a swept shell, as section 7 says.** The profile is the polyline (V, W) = (−far, 0), (step, 0), (step, a), (far, a), where `a` is the depth carried to the side that has the overlap, and it is swept along the cut's U with `BRepPrimAPI_MakePrism`. `BRepAlgoAPI_Splitter` takes that shell where it took the plane. The pieces are classified against the plane half way between the two flats, so a deep lap does not move a piece's centre of mass across the side it is on. Side `positive` (the default) carries the second flat to the positive side of the cut.
2. **A tongue is a key, not a swept shell.** It stops a margin short of each end of the section, so it is a finite prism and does not break out of the sides: the same prism builder milestone 9's discrete dovetail key will use. After the plain split it is fused onto the piece that carries it (started 0.001 mm inside that piece's face, as a plug is) and its groove, the tongue grown by the clearance on every side and by the end gap at the bottom, is cut from the mate. `side` names the piece that carries the tongue; the default is positive, as a plug's. A tongue the section does not hold is refused: "The tongue of cut 1 is outside the section, so it was not built."
3. **The planner resolves every size on the section at Apply.** `storedPartition` cuts the solid's mesh at the plane (`sectionLoops`) and stores millimetres from the cut's origin along its own U and V, so a replay builds the same joint after the settings change. A lap stores `depth`, `height` (from the section's low side; half when absent), `side` and `at`, where the step sits along V. A tongue stores `width`, `depth`, `side`, `clearance` (the cut's connector clearance, else the material's Snug; no row refuses with the fit sentence), `endGap`, its ends `u0` and `u1` (the section's U span less a margin of `max(3.95, width/2 + clearance + wall floor)`), and its middle `v`. A tongue the section cannot hold with its walls is refused: "Cut 1: the section is too small for a tongue 40 mm wide with 0.8 mm walls. Make it narrower, or cut straight." The planner's floors (`profileRefusals`) say the same sentence in the card and in the MCP.
4. **The card has a Profile section** under the plane: Straight, Lap or Tongue; Lap shows Depth, Height (empty is Half) and Side, Tongue shows Width, Depth and Side. The planner's defaults show as placeholders, the sentences show under the fields, and the pencil reads a stored lap or tongue back with its sizes. The stored op carries no profile for a straight cut.
5. **Joint down on a profiled cut takes the largest flat face on a cut plane.** `jointPlanes` gives a lap's two flats and a tongue's two planes (the cut plane and the plane of the tongue's end), each as its own cut, and `jointFaces` keys the faces by plane, so a piece's face on either flat is found, the larger wins, and equal faces go to the first plane, the cut's own. The real-kernel test checks the lap piece's flat on the cut plane goes to −Z to 1e-9.
6. **Connectors on a lap or a tongue are not built.** Section 6 asks for a connector on the overlap, which needs the connector's hole to start at the flat's own plane and the section of that flat; the card and the MCP say "Connectors on a lap or a tongue are not built yet. Turn them off, or cut straight." This is a limit of this milestone, not of the plan. Part numbers go on the first flat, the nominal plane, which both pieces have.
7. **Drag handles are not built.** Dragging Depth, Height or Width needs a handle on the ghost's profile, and the ghost draws the plane only; the typed fields stand. It is a follow-up to the ghost, not to the kernel.
8. **Tests.** `crates/lime-model-occt/tests/partition_profile.rs`: a lap on the 120 × 30 × 20 mm bar for each side, the volumes by hand to 1e-6 mm³ and summing to the parent, the flats at x = 60 and x = 66 with 300 mm² each, the riser at z = 10 with 6 × 30 mm², closed valid pieces; a tongue for each side, the tongue's end face (6 × 20 mm² at x = 57) and the groove's bottom (6.3 × 20.3 mm² at x = 56.6), the volume lost to the grown groove; the refusals. `src/split-print.test.ts` and `src/modeling/joint-down.test.ts` for the stored sizes, the card and the planes; `mcp/occt.test.ts` for the lap and the tongue on the 500 mm bar, with Joint down; `e2e/model-split-print.spec.ts` for the card.

## 26. Changes in milestone 9 (2026-10-27)

Milestone 9 builds the zig-zag and the dovetail profiles and the key and dovetail connectors, and lifts their refusal. The sketch profile is still refused ("Only straight, lap, tongue, zig-zag and dovetail profiles are built yet. Leave the profile out, or use one of them."). It changed six things:

1. **One prism builder.** `key_prism` in `kernel.cpp` is a trapezoid, square to a slide direction, standing from a point toward the mate and widening by a slope: the tongue (slope 0), the key (slope 0), and the dovetail (slope tan of its angle) are all this builder, and the groove is the same grown. `build_tongues` now builds the tongue and the dovetail profile with it, and `build_joints` the key and the dovetail connector. Milestone 8's tongue tests pass unchanged on it.
2. **The zig-zag is a swept shell, as section 6 says.** A square wave in (U, W) from where a period starts at the section's low U, swept along V and passed to the splitter with the plane's classification half way up the teeth. Each flank leans in by half of depth × tan(angle), so the tooth's tip is narrower than its base by depth × tan(angle), which is `profileRefusals`' tip. The side that carries the teeth is `side`. There is no clearance on a zig-zag: the teeth are the fit, so the pieces must be printed apart and sized for the printer's accuracy; a clearance would need the groove grown, as a tongue's is, and is a follow-up.
3. **The dovetail profile is a key as long as the section.** Section 7 said a profile is a swept shell; a dovetail needs a clearance to slide, so it is built as a key whose slide runs the whole section (`u0` to `u1` along its slide, `v` its middle across it) and whose groove is grown by the clearance square to a flank (clearance ÷ cos(angle) across it) and the end gap at the bottom. Slide along W is refused; slide along U or V. The planner refuses a dovetail wider than the section less its walls, and the kernel one with no neck.
4. **The key and dovetail connectors** are placed by the planner as before and built on the real pieces by `build_joints`: a key `width` along U and `height` along V, a dovetail `width` at its wide end and `angle`, sliding `u` or `v` for as long as it is wide; both `depth` from the cut and a groove grown by `clearance` and `endGap`. The positive piece carries them. Their `endGap` is a field now. A key or dovetail whose volume does not come off exactly (a tool that reaches past the piece) is left out and named, as a dowel is.
5. **The card.** Profile adds Zig-zag (Pitch, Depth, Angle) and Dovetail (Width, Depth, Angle, Slide); Connectors adds Key (Width, Height) and Dovetail (Width, Angle, Slide) types. Connectors on a shaped cut (a lap, tongue, zig-zag or dovetail profile) are still refused: "Connectors on a shaped cut are not built yet. Turn them off, or cut straight." Joint down takes the largest flat face on a cut plane of a zig-zag or a dovetail as it does of a lap and a tongue.
6. **Tests.** `tests/partition_profile.rs`: a zig-zag square and leaning (volumes by hand to 1e-6 mm³, three tooth tops of 5 × 20 mm² at x = 63, the tip 3.268 mm), a dovetail sliding along U and along V (the neck and wide end by hand, 1e-5 mm³, the end face 8 × 30 mm² at x = 57), the no-neck refusal; `tests/partition_joints.rs`: a key and a dovetail connector (volumes by hand to 1e-6 mm³), a key that breaks through; `src/split-print.test.ts` for the stored sizes and refusals; `mcp/occt.test.ts` on the real kernel for the zig-zag, the dovetail and the keys; `e2e/model-split-print.spec.ts` for both cards.

## 27. Changes in milestone 10 (2026-10-27)

Milestone 10 builds the sketch profile and lifts the last profile refusal: every kind in section 6 is built. A profile of no known kind is refused with "A cut's profile is straight, lap, tongue, zigzag, dovetail or sketch." It changed eight things:

1. **The sketch plane is the cut's U and W, as the zig-zag's.** Section 6 put the sketch's U on the cut's V and swept along U. The zig-zag (section 26) draws in (U, W) and sweeps along V, and this milestone does the same, so both swept profiles share one frame: the sketch's X is the cut's U, its Y the cut's normal W, and the chain is swept along V. The chain is stored in millimetres from the cut's origin, so moving or tilting the cut carries the chain with it. A sketched cut always stores its `u`: the card fixes it when the sketch first opens, and an MCP client may give it.
2. **The stored profile.** `{kind: "sketch", start: [u, w], chain: [{kind: "line", to}, {kind: "arc", through, to}], sketch}`. `start` and `chain` are what the kernel cuts along, in the shape of a loop's segments in the MCP (`loops`). `sketch` is the sketch the sketcher edits, with its constraints and its driving dimensions, which may be expressions as in any Model sketch. `withoutSketch` drops it from every engine call and `keepSketch` puts it back on the echo, as for an extrude. An op from the MCP has no `sketch`; the pencil then draws one from the chain (`sketchFromChain`), with no dimensions.
3. **The kernel.** `build_partition` builds the chain as a wire of edges and `GC_MakeArcOfCircle` arcs in (U, W), carries its two ends along U to the part's box, and sweeps it along V with `BRepPrimAPI_MakePrism`, as the zig-zag. The splitter takes the shell. A piece's side is not read against a plane: a piece that wraps a tall tooth can have its centre of mass inside the tooth. It is read from the piece's vertices off the chain, inside or outside the region on the chain's −W side. The chain's segments reach the kernel as one more array of numbers (`kChainStride`, five a segment) beside the profiles. The kernel refuses a chain that crosses itself ("The profile crosses itself.") and one that misses the part ("The sketch profile does not cross the part. Draw it from one side of the section to the other.").
4. **The planner checks the chain before Apply** (`src/modeling/sketch-profile.ts`), on the section the solid has at the cut and on the part cut across the profile plane through the middle of the section (`profileSlice`):
   - "The sketch has to cross the section: start it past one side of the part and end it past the other." The chain's two ends must lie past the section's two sides along U.
   - "The profile crosses itself." Section 6's sentence.
   - "The sketch leaves a wall 0.5 mm thick, under the 0.8 mm wall floor. Move the chain away from the edge, or widen the feature." Two places on the chain closer than the wall floor, inside the part, leave that wall when the chain between them goes more than twice the floor away, as the flanks of a narrow tooth do; a corner or a smooth arc does not. The same holds for a run of the chain closer than the floor to the part's outline, more than twice the floor from where it crosses the outline.
   The card and the MCP say the same sentence, after "Cut N: ".
5. **The card and the sketcher.** Profile adds Sketch. Choosing it opens the sketch editor on the cut's plane at once, with the line tool, and the card steps aside (`data-profile-sketch` on the dock). The reference is the part cut across the profile plane and the cut's own trace, drawn faint; they snap as solid edges do. The sketch card has the Draw, Edit and Constrain tools; in place of Make it names the profile ("Sketch profile", How has its steps), shows what the chain still needs, and its foot is Look around, Cancel and Use profile. Use profile, Finish, or Esc out of the sketch hands the sketch to the card; Cancel hands nothing back. `featureStrip()` keeps its four features: the profile is its own strip, and Extrude, Revolve, Loft, Sweep and Holes do nothing while it is drawn. The card's Profile row then reads "Sketch · 3 lines" with **Edit sketch**. The pencil on a sketched row opens the card and then the chain in the sketcher, as section 6 says. The history row is "Split to print, sketch, 2 parts".
6. **Joint down on a sketched cut** uses the plane of the chain's longest straight segment, swept along V (`jointPlanes`); equal lengths go to the first. A chain with no straight segment has no flat, and a piece set to joint keeps, with "Part 2 has no flat joint face: cut 1 is a sketch with no straight segment, so the part keeps its orientation."
7. **What waits.** Connectors on a sketched cut stay refused, as on every shaped cut. A parameter change still does not rebuild a split to print (section 19, item 4): a dimension typed as an expression is evaluated when the sketch is used, and the op stores the chain it gave. The ghost draws the plane, not the chain. The planner's slice is the part cut through the middle of the section along V, so a part whose outline changes along V is checked on that one slice; the kernel's cut is exact.
8. **Tests.** `crates/lime-model-occt/tests/partition_profile.rs`: a step and a half circle on the 120 × 30 × 20 mm bar, the volumes by hand (π r² / 2 for the arc) and summing to the parent to 1e-6 mm³; the cut faces on the chain (the flats at x = 60 and x = 66, 200 mm² each, the riser at y = 10, 120 mm², and the arc a cylinder of radius 5 to 1e-9 on the line x = 66, y = 15, on both pieces); a piece that wraps a tooth 50 mm tall on its own side; the refusals. `src/modeling/sketch-profile.test.ts` (reading, the three refusals, the flat, the chain to and from a sketch), `src/split-print.test.ts` (the stored chain and sketch, the engine's op without the sketch, the pencil's card, the row), `src/modeling/joint-down.test.ts` (the flat and the sentence), `mcp/partition.test.ts` (the refusals call no kernel), `mcp/occt.test.ts` (probe, apply, Joint down and edit of a sketch on the real kernel), and `e2e/model-split-print.spec.ts` (Sketch opens the sketcher on the cut, a drawn chain and Apply make the row, the pencil reopens the chain, a short chain is refused in both cards, and Explode).

## 28. Changes in milestone 11: measured fits, built without waiting for prints (2026-10-27)

The owner cannot print and measure the coupons yet, so milestone 11 is built with reasonable assumptions: the starting values are reviewed against published guidance, and the flow that takes a measured coupon is built and tested, ready for when prints happen. It changed four things:

1. **The starting values were reviewed.** Every cell is a gap each side, for a 0.4 mm nozzle (resin: the Form 4). Where guidance gives a range, the number is the middle of it. The cells stay `starting`; only a real measurement becomes `measured`.
2. **Coupon results are entered, and kept in the machine library.** `MachineLibrary.measuredFits` holds the cells a coupon fixed and, for resin, the thinnest wall that held. The card's **Enter coupon results…** and the MCP's `machine_set {fits}` write it through `measuredRow`.
3. **A reset puts the starting values back**, per row.
4. **"Starting fit." is retired cell by cell**, as section 23 said: a measured cell reads "Measured. 0.15 mm each side (0.3 mm on the diameter).", and a row with every cell measured is no longer a starting fit.

### The table, before and after

| Row | Snug before → after | Loose before → after | Press before → after | Basis |
|---|---|---|---|---|
| PLA | 0.15 → 0.15 | 0.25 → 0.25 | 0.05 → 0.05 | Confirmed. Snug sits between the Bambu peg-and-hole 0.10–0.15 and the sliding 0.15–0.25 (Sovol), Loose is the middle of 0.2–0.3, Press is the Bambu A1 Mini tight value. |
| PETG | 0.20 → 0.20 | 0.30 → 0.30 | 0.10 → 0.10 | Confirmed for a 0.4 mm nozzle: Sovol's PETG sliding range is 0.2–0.3 (Snug is its lower middle, Loose its top), Press is PLA's 0.05 plus the 0.05 PETG needs, and the middle of Sovol's press range 0.05–0.15. |
| ABS and ASA | 0.20 → 0.25 | 0.30 → 0.35 | 0.10 → 0.15 | Sovol's ASA sliding range 0.25–0.35 sits 0.05 above PETG's, and ABS shrinks more than PETG. |
| TPU | 0.25 → 0.20 | 0.35 → 0.30 | 0.15 → 0.05 | No published clearances. It shrinks little, so Snug and Loose follow PETG, and it gives, so a press needs little. The weakest row. |
| Standard resin (Form 4) | 0.10 → 0.10 | 0.20 → 0.25 | 0.05 → 0.05 | Formlabs prints a 0.4 mm drawn gap as 0.34 mm, so about 0.03 each side is lost; a "normal" fit of 0.254 mm appears in a Georgia Tech handout. Loose is the middle of the two. |

The coupon's steps follow, since they are the table's Snug less 0.10 to plus 0.20 mm: ABS and ASA 0.15–0.45, TPU 0.10–0.40.

### The sources

| Source | What it gives | Used for |
|---|---|---|
| Sovol, "FDM 3D Printing Tolerances & Clearances: How to Design Parts That Fit" (sovol3d.com/blogs/news) | 0.4 mm nozzle, each side: press 0.05–0.15, sliding 0.2–0.3, snap 0.3+; sliding by material PLA 0.15–0.25, PETG 0.2–0.3, ASA 0.25–0.35 | PLA, PETG, ABS and ASA, all three fits |
| Digital Fabrication Lab, UAL Creative Computing Institute, "Design the clearance and tolerance" (wiki.cci.arts.ac.uk) | Bambu H2D Pro, each side: press 0–0.05, peg and hole 0.1–0.15, general removable 0.15–0.2, free 0.2+. Ultimaker S7: press and peg 0.2, general 0.3. It states that tolerance is added to both sides | PLA Snug, Loose and Press; the spread between printers |
| "Press-Fit Tolerance Reference (PLA, Bambu A1 Mini)" (val.town stl-creator notes) | Tight fit 0.05 radial, semi-permanent 0.00, PETG about 0.05 more than PLA | PLA Press, the PETG offset |
| Zbotic, "3D Printing Tolerances: Designing Gaps for Press Fits, Threads, and Snap Fits" (zbotic.in) | Diametral: snug 0.1–0.2, sliding 0.3–0.5, snap assembly 0.2–0.3; shrinkage PLA 0.2–0.4 %, PETG 0.3–0.5 %, ABS 0.5–0.8 %, TPU very low | The ABS step up and the TPU shrinkage argument |
| Formlabs, Form 4 design guide (formlabs.com/white-papers/form-4-design-guide) | 0.4 mm minimum gap between parts that print together, printed as 0.34 mm on a Form 4; ±0.15 % on 1–30 mm features, floor ±0.02 mm; Standard resin has the elongation for interference fits | Resin Snug and Loose, the 0.03 mm each side |
| Georgia Tech, "Instructions for Resin SLA 3D Printing" (sites.gatech.edu) | 0 press, 0.127 tight, 0.254 normal, 0.508 loose, no printer named, side or diameter not stated | Resin, cross-check only |

What the sources do not give, and so is still a guess: any clearance for TPU, and any Form 4 clearance for Standard resin in particular (Formlabs publishes no press or sliding values). Neither Prusa nor Bambu publishes a per-material press-fit table; the Bambu numbers above are a university lab's on a Bambu printer. The IR3 V2 is a belt printer with its own XY behaviour, so the owner's first coupon on it is the real answer and replaces the PETG row.

### Stored ops keep their clearance

A stored partition op holds its connectors filled: `clearance` is a number in millimetres, not the word Snug (`storedPartition`). `fillPartition` returns a number as it is. So neither a changed table nor a measured entry reaches an op already applied or saved, and a replay cuts the same holes. Only a cut made after the change, Apply or an Update that fills the card again, uses the new defaults. `src/modeling/measured-fits.test.ts` fills an op stored with ABS's old 0.20 and checks it keeps it, and that a measurement entered after Apply leaves the stored 0.25 alone.

### Where the results are kept

In the machine library, `MachineLibrary.measuredFits`, an optional key like `materialCards`: absent until a result is entered, the library's version stays 3, and it is read defensively (a damaged file keeps only finite numbers of known rows). The library already holds the per-filament data (temperatures, flow, pressure advance, fan), lasts across projects and sessions, and is the one store the app and the MCP session both use, each with its own copy. It is keyed by the clearance table's row (material and process) and not by the filament record: the table's rows are materials, a fit measured on PETG is the same for the owner's other PETG spools, and the coupon is printed at their usual 0.4 mm setup. A `.lime` project does not carry it, so a shared project does not change another person's fits. The MCP session holds the library in memory and does not write it back to the app's browser store, so what is entered through `machine_set` lasts for that session; `machine_get {measuredFits}` reads it back, and the app's panel is where results are kept for good.

`partitionDefaults`, `fillPartition` and `fitCoupon` take it as `fits`, so there is no global state: the app's and the MCP's `partitionContext` pass the library's. The coupon centres on the measured Snug once one is entered.

### The card

Under the Clearance note, beside **Print a fit coupon…**, **Enter coupon results…** opens a panel:

- **Material** lists PLA, PETG, ABS / ASA, TPU and Standard resin (Form 4). It opens on the plate's filament, or resin for an export target.
- **Snug, Loose, Press** each list the labels engraved on a coupon centred on the row's starting Snug (PETG: 0.10 to 0.40 mm), "Not entered" and "Other…". Other is a number field for a coupon that was printed with `startMm` moved. A cell already measured shows its number.
- **Thinnest wall** shows for resin: the wall that survived, in millimetres.
- **Save results** writes a measured cell for each fit entered, and the card's Clearance sentence reads "Measured." at once. **Reset to starting values** drops the row. A fit left at "Not entered" is not touched.

### The resin floors

`RESIN_FEATURE_MM` (0.5) sets the resin feature floor the planner derives its wall, radius and tongue floors from. The fit coupon does not measure it, since its holes and pin are 3 mm (section 23). So the entry takes the thinnest wall that held as a separate field, and it becomes `resinFeatureMm`, which replaces 0.5 for every resin default. `RESIN_LAYER_MM` and the resin bed margin stay: a layer height is the printer's setting, and a margin is a property of the bed, neither a measurement of a coupon. A thin-wall row on the coupon is still the way to measure the floor from a print.

### The MCP

`machine_set {fits: {material, process?, snug?, loose?, press?, wallMm?}}` enters results, `{material, reset: true}` resets, and `dryRun` reports without writing. `process: "resin"` is the Form 4's Standard resin and takes `wallMm`. `machine_get` returns `measuredFits` once there are any. No new tool. The `fits` property is one line in `machine_set`'s schema, and `lime://guide/ops` gains one line beside the coupon's; the token budgets in `mcp/schema.test.ts` pass unchanged.

### Tests

`src/modeling/measured-fits.test.ts`: the new rows, the measured row over the table through `measuredRow`, the sentences, a stored op keeping its clearance, the library round trip (no key when there are none, and a damaged file), the reset, and the coupon centring on the measured Snug. `src/modeling/partition.test.ts` and `fit-coupon.test.ts` have the new numbers. `mcp/measured-fits.test.ts`: `machine_set {fits}` against the stand-in engine, a cut after it storing the measured clearance, the cut before it keeping 0.15, the refusals, the reset, and the schema and the guide. `e2e/model-split-fits.spec.ts` (mocked engine, `--repeat-each=3`): PETG Snug entered and read back as "Measured.", Other, the refusal, a cut made after entering results storing it, the reset, and the resin entry with its wall.

### When prints happen

Print the coupon (the card or `solid_new {coupon}`), find the hole the pin pushes into by hand and stays in, and enter its label in the panel, or `machine_set {fits}`. The row is then `measured` for that cell. The numbers in the table above are replaced in code only when a measured number should become the shipped default for everyone, as section 23 said; that is a later change with the printer, material and result in its commit message.

## 29. Follow-ups after milestone 10 (2026-10-27)

Four of the six items milestone 10 left are built; two are not. 

1. **Connectors on a lap, a zig-zag and a sketch** (built). A hole starts on a plane, and a shaped cut has several, so each connector now sits on a flat. A lap has two (the plane below the step, and the plane `depth` along W past it); a zig-zag a low flat and a tip per tooth; a sketch each straight segment of its chain whose normal is within 45 degrees of the cut's W (`shapedFlats` in `src/modeling/partition.ts`). The planner cuts each flat's plane through the solid, clips it to the flat's face (`clipSection`), and places on that section as a straight cut does. Each placed row stores `flat: {u, w, tilt}`, the plane's point and tilt in the cut's own U and W, with `uvMm` in the flat's own U and V and `fraction: null`; the cut's own numbers move with a pose, so the row does too. The kernel (`JointSpec.flat`, `build_joints`) builds the frame from that and drills along its normal. A typed count is per flat. A fixed point is a point of the cut seen along W and goes to the flat under it; one that is under none is left out with the usual sentence. **Tongue and dovetail cuts keep the refusal**, now worded "Connectors on a tongue or a dovetail cut are not built yet. Turn them off, or cut straight.": their face is the plane with the key's footprint taken out, so they need that footprint as a hole in the section, which is its own piece of work.
2. **Drag handles** (not built). The ghost draws the plane only; dragging a connector or a profile size needs the ghost to draw the profile and its flats, a picking layer for them, and the card's `at` fixed points written back on drop. That is a change to `src/model-view.ts`'s ghost and to the card's drag state, too large to land beside the kernel work; the typed fields stand, and the stored `flat` is what the drag will write against.
3. **The pins' name on reopen** (built). `read_step_named` now tells an assembly of components (`A`) from a simple shape (`S`). A named simple shape holding several solids is one piece under its name, so `<source>-pins` comes back as one piece; an assembly keeps the old rule. `crates/lime-model-occt/tests/partition_export.rs` round-trips a dowelled cut through STEP; with the old reader the pins' name came back empty.
4. **Folder picker** (built). The desktop command `save_files_to_folder` picks a folder once and writes every STL there, after checking every name and decoding every file. The web build downloads each piece as before.
5. **Smaller project files** (not built). A held piece stores its B-rep and its mesh, both gzipped (`src/project-codec.ts`). Dropping the mesh and meshing on open is the cheap win, but it changes how a project opens held pieces (`src/project.ts`, `src/app/project-io.ts`) and was not measured here, so it is left to a change that can show the sizes and the open cost together.
6. **The Pins tag** (built). A part tag slides inside the view's edge instead of being centred on a point outside it.

## 30. Polish after 4.2.0 (2026-10-28)

The two items section 29 left, and the tongue and dovetail connectors it still refused. Each was retested on `main` at 4.2.0 first: the card offered only each cut's arrow and the selected cut's tilt rings, a tongue or a dovetail with connectors on said "Connectors on a tongue or a dovetail cut are not built yet.", and a project of the owner's cover cut for the Form 4 was 11.3 MB.

1. **Drag handles.** The selected cut's joint and connectors have handles in the view, from the card's own list (`handles()` in `src/ui/split-print.ts`):
   - A lap, a zig-zag, a tongue and a dovetail have a **depth knob** on the cut's normal, at the joint's far side: past the plane on the side that carries a lap's second flat or a zig-zag's teeth, and on the other side for a tongue or a dovetail, which the positive piece pushes into the negative one. It sits on the section's top edge, not its middle, where the plane's own arrow stands. It writes the profile's Depth.
   - Each connector of the selected cut has a **dot** at its hole that slides across the cut. The dot is a new handle kind, `plane` (`src/model-drag.ts`, `src/model-view.ts`): it follows the pointer on the plane square to the cut's W through the hole and writes two fields, the cut's U and V, each snapped and rounded as an arrow's one field is. An arrow along U and one along V for each connector was tried first: three dowels on the 60 mm bar put six arrows within 30 pixels of each other at the view's first zoom. A drag writes every connector of that cut as fixed points (D5: `place: "fixed"` and `at`, in millimetres of the cut seen along W), the dragged one moved, and the count no longer applies. The planner puts each point on the flat under it, as it does a fixed point from the MCP; the marks carry which point each is (`ConnectorMark.source`), so a hole that moved to another flat keeps its handles. A point that leaves the section or the wall floor is left out and named, as D5 says; its handles stay while another connector of the cut is placed, so it can be dragged back.
   - Placed by hand, the card shows each connector's **U and V** as fields under the connector fields, with **Refit**, which puts the cut back on Fit. A typed count refits too. The pencil reopens a cut placed by hand with its points.
   - The heads-up field follows each handle: the depth, or the connector's U then V after Tab. Ctrl snaps to whole millimetres and Shift slows the pointer, as on every other Model handle; the brief asked for Shift to snap, which is what Ctrl-dragging an object does, but the tool handles all snap with Ctrl.
   - **Undo and Redo** step the card while it is open (`splitPrintHistory`, `splitPrintStep`): one step for each drag, together with what the heads-up field typed after it, and one for each typed number or menu. The solid's history waits until the card closes, as Place's and the workplane's do.
   - Not built: a ghost of the profile itself. The knob and the holes show where the joint reaches, and the probe's pieces show its shape once the kernel answers.
2. **Smaller Form 4 project files.** Measured on the owner's cover, cut for the Form 4 into four pieces (no dowel fitted its walls), saved from the app:

   | Record | Before | After |
   |---|---|---|
   | The part's STEP, which is also its root | 3,568,024 | 3,568,024 |
   | The three held pieces' meshes | 2,058,540 | 2,058,540 |
   | The three held pieces' solids | 5,644,532 | none |
   | The rest of the file | 13,070 | 12,479 |
   | **The file** | **11,284,166 bytes** | **5,639,043 bytes** |

   The solids were half the file and a reopen does not need them: a held piece draws, explodes and exports STL and 3MF from its mesh, and its solid is cut again from its part, deterministically from the stored op, when a call first needs it, such as a STEP export. So the app no longer writes `brep` on a held piece (`heldToSave`), and no longer asks the engine to write one at each save. A reopened held piece is marked unopened whether or not it has a solid (`adoptHeldPieces`), and the first call cuts every unopened piece and the pins of that cut in one partition on a spare step (`rebuildPiece`), not one cut each. Without more, the first STEP export after a reopen paid for that cut: on the cover it took 24.9 s, where the second took 2.7 s, the STEP write alone that a file with solids paid. The owner kept the small files and asked for the cut to start by itself:

   - **The background cut.** Once a project open has finished, `warmHeldPieces` starts one cut for each split to print whose held pieces have no solid, on its own: the open, the first slice and the preview do not wait for it, and nothing is shown for it. It is the same cut a call would make (`rebuildPiece`), so the engine serves it as it serves any Model call, beside slices.
   - **One job.** The cut under way is kept by `<part key>#<step>` (`pieceCuts`). An export, or any call on one of those pieces, waits for that job instead of starting a second, and an export shows its usual "Writing the pieces…" while it waits.
   - **Stale answers go nowhere.** The cut checks, when it answers, that the project is the one it started on (`session.docEpoch`), that the step still has the op it cut, and that each piece key is still that step's. If not, the trees it made that no tree here names any more are closed, nothing is marked open, and a waiting call asks again from the step as it is now. An Update of the split makes a new step with pieces of its own, so the background cut fills the old step's pieces, which Undo can still return to, and the export uses the new ones. Undo leaves the pieces as they are, so a cut under it stays good.
   - **The MCP.** `project_open` does not share this path: the MCP server never reads `heldPieces`, and its exports cut the pieces again on a spare step, as since 3b.
   - **Measured on the cover** (the scratch engine serving this branch, the project opened from memory four times):

     | What | Time |
     |---|---|
     | Open, until the plate has the part | 14.7 s |
     | Then until the solids are ready | 31.2 s more |
     | STEP export once they are ready | 2.2 s |
     | Open and go straight to Model: Model shows the split | 45.5 s after the open, while the cut runs |
     | STEP export as soon as the row is there | 2.4 s: the cut had finished |
     | A slice started right after the open, no background cut (the same file without `heldPieces`) | 21.8 s, 14.2 s |
     | The same slice with the background cut running | 10.7 s, 16.1 s |

     The slice times vary more between runs than between the two cases, so the cut does not delay a slice noticeably. Model showing the split took as long as it did before the background cut (about 46 s after the open), since both need the part's history built and share that build. A file 4.2.0 saved, with solids, opens as before: each piece opens from its own solid, and the next save drops them. An app before this one reads a held row with no `brep` too, since the field was optional, and cuts the piece again in the same way. The project version stays 4.
3. **Connectors on tongue and dovetail cuts.** A tongue's or a dovetail's face is the cut plane less its groove, so `shapedFlats` gives each two flats on the plane (`flat: {u: 0, w: 0, tilt: 0}`), one each side of the groove at its widest (`jointFootprint`: the key grown by the clearance, and for a dovetail its wide end, square to a flank, and the end gap below it), across V for a tongue or a dovetail sliding along U and across U for one sliding along V. The planner places on those as on a lap's flats, and the kernel already drilled on a flat, so only the refusal in `tree.rs` goes. A connector that would still reach the groove is left out by the kernel, since its cut no longer takes exactly its volume. When no connector fits beside the joint, the cut is refused with the widest circle the flats hold and what would fit (`noRoomSentence`): "Cut 1: no dowel fits beside the tongue. The flats beside it hold a circle 6.8 mm across at most. A dowel of radius 2.47 mm or less fits." The size is found by placing it, so it is one the planner accepts; when no printable size fits, the sentence names the narrower tongue or dovetail that leaves room for the connector as typed, and failing that says to cut straight.

Tests: `src/modeling/partition.test.ts` (the footprint, the flats, the widest circle), `src/split-print.test.ts` (dowels beside a tongue and both dovetails, the three refusal sentences, the points a drag writes, their marks, the pencil, Refit), `crates/lime-model-occt/tests/partition_flats.rs` (a dowel each side of a tongue and of a dovetail on the real kernel: closed valid pieces, the volumes by hand to 1e-6 mm³, each hole's axis from its `Geom_CylindricalSurface`; one that reaches the groove is left out), `mcp/occt.test.ts` (the refusal, then 2 mm dowels beside a tongue and a dovetail with their teardrop holes by volume, and an apply that stores them on the flats), and `e2e/model-split-print.spec.ts` (the depth knob, a dowel dragged and typed by hand, Refit, Undo and Redo, the pencil, the tongue's sentence and dowels, the save that keeps no solid, the background cut that runs once per open and that an export waits for, one a new file makes stale and discards, and an Update while it runs).

## 31. The cut's path in the view (2026-10-29)

The owner split a part with a zig-zag and called choosing it "pretty blind". On `main` at 4.3.0 the card's ghost was each cut's flat square and the two piece tints parted along that plane (`pieceRegions`), whatever the profile: a zig-zag, a lap and a sketch looked exactly like a straight cut until Apply, and section 30 left "a ghost of the profile itself" unbuilt. Now a shaped cut draws its path while it is edited.

**What the view draws.** The references agree on three things, and the view does all three:
- *The line the cut leaves on the part.* PrusaSlicer's and Bambu Studio's cut tool outline where the plane meets the object, and Fusion's Split Body and Onshape's Split show the result on the body, not only the tool. Here it is the profile swept through the part, met with the mesh (`traceContour` in `src/cut-trace.ts`): bold in the theme's text colour where it is seen (white on the dark stage, near black on the light one, so it reads over both tints), and faint through the part, as hidden edges show in a CAD view, so the teeth on the far side are there too.
- *The tool.* Fusion and Onshape draw the splitting surface itself. For a shaped cut the flat square gives way to the sheet the profile sweeps, folded along it, translucent with its folds in the accent colour, 4 % of the part's size past the path each way (`traceSheet`), so it stops near the part as the cuts' squares do.
- *The two pieces.* The slicers colour the upper and lower parts apart, Onshape previews the bodies a split makes. The tints already did, along the plane; now a piece bounded by a shaped cut keeps only its side of the profile, in the fragment shader (`traceShader` in `src/model-view.ts`, `CUT_TRACE_GLSL`), so the tints part along the teeth. A zig-zag is one period repeated, a lap a step, a sketch its chain (at most 64 points; a longer one is thinned for the shader, never for the line). Up to four shaped cuts bound one piece; past that it is tinted by the planes, which no layout the planner proposes reaches.

**The same cut as Apply.** The trace is not the card's numbers drawn as typed: `cutTraces` (`src/split-print.ts`) fills the op as Apply does (`fillPartition`), turns it into the solid's frame, and places the profile on that section as `storedPartition` stores it: a zig-zag's first low flat at the section's U edge (`u0`), a lap's step at its height along V. The unit test checks `u0` against the stored op, and that every point of the path is on the profile and on the part. Against the real kernel, a 120 × 70 × 50 box cut at X 60 with a 14 mm pitch, 8 mm deep, 20° zig-zag gave a 68 mm and a 60 mm piece, 221,086.61 and 198,909.11 mm³: the teeth on the negative piece, where the preview put them.

**Live.** It is drawn on the CPU from the mesh the view already has, with no kernel call, on every change the card makes: a typed size, a menu, a tilt, and each step of a drag. The path is kept by its trace and the mesh, so a redraw that moves nothing traces nothing. It is linear in the triangles: each is tested only against the flanks over its own span, and one wholly outside the profile's depth band is skipped. Measured on a 100,352-triangle sphere with a 14 mm, 8 mm deep zig-zag, a trace takes about 15 ms, beside about 11 ms for the section the planner already cuts on every change.

**What is not traced, and why.**
- *A tongue and a dovetail.* Their key is local: it stops at the section's ends along U (and a dovetail's groove widens under the plane), so a sweep across the part would draw a joint the kernel does not cut. They keep the plane, the depth knob and the probe's pieces. Drawing their key as a solid ghost is the follow-up if the owner wants it.
- *A profile the kernel refuses*, such as a zig-zag whose tooth has no tip ("Widen the pitch or lower the angle"): no path, the plane, and the card's sentence. Drawing a cut that will not be made would be the blind preview again, the other way round.
- *After Apply.* Nothing of the ghost stays (the spec checks it). The pieces are the kernel's solids, so their cut faces are the teeth themselves, drawn as geometry with their edges, and Explode and View's Colour by step already show them apart. An overlay on a face that already has that shape adds nothing, and a stale one would lie after an Update. This was not seen in a screenshot here: against the real engine, headless Chromium's page crashes a few seconds after the card's probe answers, on `main`'s build as well and for a straight cut too, so the real-kernel evidence stops at the card (see the PR).

Tests: `src/cut-trace.test.ts` (the profile at any A, a period both ways, a lap's step, the polyline clipped at its ends, the line on a bar and its length, the sheet, a posed part, a lap, each piece bound naming its cut) and `e2e/model-split-print.spec.ts` (a straight cut has no path; a zig-zag traces one, which a finer pitch lengthens before any kernel answer; angled teeth; a drag keeps it; a lap traces its step; a tongue draws its plane; Apply leaves no ghost).

## 32. As built: sliding a profile, and no paper-thin walls (2026-10-30)

The owner split a part with a zig-zag and was left with "paper thin half walls": a tooth's flank had landed a fraction of a millimetre inside one of the part's walls, so one piece kept a sliver of that wall standing the depth of the tooth. He asked for two things: a way to slide an automated profile along the cut without moving the cut, and, better, a rule that makes such a sliver impossible, "not refusing, but imposing that it cannot happen". Both are built. The planner does all of it (`src/modeling/profile-shift.ts`, called from `placeShaped` in `src/split-print.ts`); the kernel gained one path.

### What a shift is, per profile

`shift` is millimetres on the profile, stored on the op. 0, and absent, is exactly where the planner put the profile before shifts existed. The cut's plane, its origin and its tilts never move.

| Profile | What `shift` slides | How it is stored |
|---|---|---|
| Zig-zag | The teeth along U. It is a phase: taken modulo the pitch, so 12.5 on a 10 mm pitch cuts as 2.5. | `u0`, where a period starts, is the section's low U plus the phase. |
| Lap | The step along V, from where Height (or Half) puts it. The step is the only thing a lap can slide without moving the cut, so the lap's shift is an offset on top of Height; it is clamped so both shoulders keep their floor. | `at`, as before. |
| Tongue | The tongue across V, from the middle of the section. Along U it already runs the section less its margins, so there is nothing to slide that way. | `v`, as before. |
| Dovetail | The dovetail across its slide (across V for a slide along U, across U for a slide along V). | `v`, as before. |

The stored op keeps the shift as it was asked for: a typed number as typed (`shift: 12.5`), or Auto as the shift it chose with `shiftAuto: true`. A typed 0 stores no `shift`, so an op with no shift stores exactly what it stored before. A replay reads only `u0`, `at` and `v`, so a project saved before this change, which has none of these fields, builds the same solids.

### The no-thin-wall rule

**The floor.** The thinnest wall a split may leave is the process's wall floor and never under 0.8 mm (`sliverFloor`): two 0.4 mm beads on FDM, the narrowest wall a slicer fills with two perimeters and no gap fill; 1 mm on the Form 4 (twice its 0.5 mm feature). Under that the slicer prints a single bead or nothing, which is the "paper thin" the owner saw.

**How walls are read.** On the section the solid has at the cut, and for a zig-zag or a lap also on the section the profile's depth along the normal, where its far flats sit. Each line the profile cuts across the section (a flank of a zig-zag, a lap's riser, a tongue's or a dovetail's groove edges) is followed along its length; at every 0.4 mm along it, the material from the line to the nearest face or the next line on each side is that side's wall. A wall is thin only when it stays under the floor for more than twice the floor along the line (1.6 mm): a flank that meets a slanted or curved face makes a corner, which is a short wedge, not a wall. A line within 0.05 mm of a face inside the part (a hole's or a rib's, not the outline's) counts as a 0 mm wall, so the cut never lays a flank on a face. A tongue's or a dovetail's groove that leaves the material (breaks into a hole) counts as 0 there.

**Auto.** Auto tries the shifts (the zig-zag one pitch in 0.1 mm steps; the others every 0.1 mm of their room) and takes the one whose thinnest wall is thickest, counting everything at three floors (2.4 mm) or more as equal, and among those the one nearest 0. So a profile that already leaves every wall 2.4 mm or more stays exactly where it was (every existing test of a solid bar kept its numbers), and one that does not moves the least that gives its walls the most.

**When no shift clears every wall.** The profile is changed where it would leave the sliver, and the card says so in one sentence:
- *Zig-zag:* the pair of flanks around the thinnest wall is taken out, the pair that leaves the thicker walls, until every wall holds. Taking a pair out flattens a tooth onto the cut plane, or fills the gap between two teeth up to their tips; a tie flattens. "Cut 1: 1 tooth was flattened onto the cut plane so no wall is under 0.8 mm." The changed profile is stored as the zig-zag's `start` and `chain`, a polyline in (U, W) as a sketch's is, and the kernel cuts a zig-zag that has a `chain` along it with the sketch's path (`tree.rs`, `profile_numbers`; up to 16,000 segments, where a sketch keeps 200).
- *Tongue and dovetail:* a typed shift that would leave a thin wall moves to the nearest place that does not ("Cut 1: the tongue was moved 2.45 mm so no wall is under 0.8 mm.", on the bar with a hole below). When no place clears the whole length, it is shortened to the longest stretch that keeps its walls, at the place that gives the longest; a dovetail's stretch keeps one end of the section open so it can still slide in ("…was shortened to 40 mm…", with its length). One that has no stretch as long as its own width is left out of that cut, which is then straight: "Cut 1: the tongue has no place that keeps every wall at 0.8 mm, so the cut is straight."
- *Lap:* a typed step that would leave a thin wall moves to the nearest place that does not; a lap with no such place is left out, the cut straight, with the same kind of sentence. A lap has one step, so there is no part of it to change locally.
- A profile left out is stored as `{kind: "straight", wanted: {…}}`: the kernel cuts the plane, and the pencil reopens the card with the profile that was asked for.

The rule runs at every Apply and every probe, for the card and the MCP alike; it does not run on a replay, which builds what was stored.

**Auto is on by default for a new shaped cut in the card.** It costs no print time and changes nothing on a part that has no thin wall at the cut, so it is not a "costly default". The MCP keeps 0 when `shift` is absent, as the brief asked, and takes `shift: "auto"`; the rule itself applies to both, so an MCP zig-zag at shift 0 whose flank would leave a sliver gets that tooth flattened, with the sentence in `notes`. Old saved cuts keep their stored placement: the pencil reads an op with no shift as a typed 0, not as Auto.

### Measured

Synthetic parts only. "Kernel" is the real Open CASCADE pieces (`crates/lime-model-occt/tests/partition_shift.rs`, the thinnest slab between two faces square to the cut's U in either piece); "planner" is the rule's own reading.

| Part, profile | Before (shift 0, as `main` cuts it) | After | Source |
|---|---|---|---|
| Thin-walled box 120 × 30.9 × 20 mm, 1.2 mm walls, zig-zag 10 mm pitch, 3 mm deep | 0.3 mm: a flank 0.3 mm inside the far side wall | Auto slides 9.6 mm: 1.2 mm, the wall itself | kernel |
| The same box, typed shift 0 | 0.3 mm | that tooth flattened: 1.2 mm | kernel |
| Five ribs 1.2 mm thick, 6.2 mm apart, zig-zag 10 mm | 0.6 mm at Auto's best shift, 9.2 mm (every shift lays a flank in a rib) | one tooth flattened: 1.2 mm | kernel |
| Bar 120 × 30 × 20 with a hole along it 1.5 mm above the middle of the section, tongue 6 mm | the groove breaks into the hole (0 mm); the kernel's groove takes less than its own volume | Auto moves it 4.05 mm down: walls 2.4 mm, the groove whole by volume to 1e-6 mm³ | planner and kernel |
| The same bar, lap step typed 0.3 mm under the hole | 0.3 mm floor under the hole | Auto moves the step 0.4 mm up, into the hole, where it crosses only the 5 mm walls beside it: 8.4 mm | planner |
| Solid bar 60 mm across, zig-zag 7 mm pitch | 0.5 mm: the last tooth's sliver at the section's edge | Auto slides 5.5 mm: 2 mm at both edges | planner |

### The card

- **Shift** is a field beside the profile's sizes for a lap, a zig-zag, a tongue and a dovetail, with an **Auto** toggle after it. Empty is Auto: the placeholder reads "Auto 9.6", the shift Auto chose, and the toggle is pressed. Typing a number, or scrubbing its label, makes it manual and releases the toggle; emptying the field or pressing Auto goes back. It takes negative numbers, either way along the cut.
- **The arrow.** The selected cut's profile has an arrow on it, along the way it slides: on the tooth nearest the section's middle at the tips for a zig-zag, on the step at the section's edge for a lap, at the key's end for a tongue or a dovetail. Dragging it types the shift (a press that does not move leaves Auto on); Ctrl snaps to whole millimetres and Shift slows it, as every Model handle; the heads-up field follows it and takes a typed number. The path (section 31) and the probe's pieces follow while it moves, with no kernel call until the release. The arrow follows the typed number, so it moves smoothly past a whole pitch, while the cut takes its phase.
- **The note** under the profile says what was changed to keep the walls, in the planner's sentence without "Cut N:", and the thinnest wall at the cut when it is under three floors or something was changed ("Thinnest wall at the cut: 1.2 mm.").
- **Undo and Redo** step the card, as for every other handle: a drag and what the heads-up field typed after it is one step, the Auto toggle another. The pencil reads a stored Auto back as Auto and a typed shift as typed.

Decisions, with the reason:
1. A field plus an Auto toggle, not a slider: a shift is a length the user may want exact (to line a tooth up with a feature), and every other size in the card is a field; Fusion's and Onshape's pattern offsets are typed fields too.
2. Empty is Auto, as Height's empty is Half: one convention for "the planner chooses" across the card.
3. The arrow sits on the profile, not on the plane's own arrow: the plane arrow moves the cut, and the owner was explicit that the profile moves, not the cut. Its accent colour sets it apart from the axis-coloured cut arrows.
4. The guarantee changes the profile rather than refusing, and says what it changed in one sentence, in the same place the card puts every profile sentence.

### Deviations from the brief

- The guarantee also applies to an op with no `shift` (the MCP, a new Apply of a card cut with a typed 0): such an op builds byte for byte the solids it built before **unless** one of its flanks would leave a wall under the floor, in which case that tooth is flattened and the note says so. Byte-identical old projects are kept because a replay never re-runs the rule. Leaving the sliver for those calls would defeat "cannot happen".
- The planner still refuses sizes no place can hold at all (a tongue wider than the section less its walls), as before: the rule is about where a profile that fits sits, not about its size.
- Walls are read on the section at the cut and at the profile's depth. A part whose walls change shape within the profile's depth is read on those two sections; the kernel's cut is exact, the reading is not.
- A tongue's and a dovetail's walls are read on the cut plane, not along the groove's depth.
- A sketched profile has no shift: it is drawn where it goes, and milestone 10 already refuses a sketch that leaves a wall under the floor.

Tests: `src/modeling/profile-shift.test.ts` (the floor, the phase, the flanks, Auto's choice and its tie-break, walls along a line and the corner rule, the thin-walled box at shift 0 and on Auto, a typed shift, the op the card stores and the pencil reads back, an op with no shift, the ribs, the tongue and the lap beside a hole); `src/split-print.test.ts` and `src/cut-trace.test.ts` (Auto keeps every earlier placement on a solid bar, and moves the 7 mm zig-zag off the 0.5 mm sliver); `crates/lime-model-occt/tests/partition_shift.rs` (the real pieces of those parts, the thinnest wall before and after, volumes summing to the part); `mcp/occt.test.ts` (no shift, `shift: "auto"` and a typed shift through `model_probe` and `model_apply` on the real kernel); `e2e/model-split-print.spec.ts` (the field, Auto, the typed 0's sentence, the arrow's drag, the Auto toggle, Undo and Redo, Apply and the pencil).
