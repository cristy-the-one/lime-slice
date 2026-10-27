# Plan: assemblies, the assembly view and the print layout

Status: plan, for review. Written 2026-10-27 against `main` at v4.0.0 (`907a7931`). Docs only: no code changes with this plan.

The source is the owner's MCP gaps list, items 18, 19 and 20 (the list itself is not in the repo):

- **18.** `model_place` does not move the object on the plate, because the plate re-centres objects. After a `model_place`, later edits read coordinates in the moved frame and refuse.
- **19.** There is no assembly or grouping between plate objects. Separate parts, such as a body and its hooks, cannot keep their relative positions or follow the variables. Hooks on a rim do not follow when `rimL` changes.
- **20.** Lifted objects, such as hooks sitting on a rim in an assembly view, are flagged as overlapping. There is no toggle between an assembly view and a print layout.

One idea answers all three. A part has two poses with two jobs: where it sits in the assembly, and where it lies on the bed to print. The app already stores both. Nothing ties either to the other parts, and nothing names which one a tool means. This plan adds the group that ties assembled poses together, a variable-driven way to set them, a view for each pose, and an interference check that belongs to the assembled one.

## 1. Goal

A person, or an MCP client, can:

1. Put several plate objects in one **assembly**, and give each part a pose relative to another part (a fixed offset, or later a mate), typed as numbers or as expressions of project variables.
2. Change a variable (`rimL`) and see every part that depends on it move in the assembly, with no hand edits.
3. Switch the 3D view between the **assembly view** (parts at their assembled poses) and the **print layout** (parts where they print), and slice and export from the print layout as today.
4. See real interference between parts in the assembly view, and not a false "overlaps" for a hook that sits on a rim.
5. Call `model_place` and know which pose it set, and type later Model edits in a frame that does not change when the part is moved.

### Non-goals

- No change to `crates/lime-slice-core`, the G-code writer, or any slice cache key. A part slices from its own frame and bed offset (`docs/part-frame.md`). Golden G-code stays byte-identical.
- No motion, no degrees of freedom, no mate solver. A pose is solved by walking a tree from a fixed root. There are no loops to satisfy.
- No new geometry library and no mesh boolean. Interference uses the mesh the plate holds and Open CASCADE, which the modeler links.
- No new rail button and no new shortcut (`MODEL_TOOLS` in `src/model-drag.ts` does not grow).
- No bill of materials, no assembly guide, no animation. Explode stays what it is.
- No new tool in the MCP unless section 5 shows it is unavoidable. It is not.
- No change to project version. It stays 4 (section 7).
- Sequential printing and the print order are not touched.

## 2. Current state

Read from `main`. Each row names where it lives.

### How the plate stores poses

`PlateObject` (`src/plate.ts`) carries two unrelated placements:

| Field | Frame it goes to | Who reads it |
|---|---|---|
| `orient` (a 3x3), `partScale`, `centered`, `offset` | The bed. `placeMesh` in `src/mesh-place.ts` turns the source about its bounds centre, lowers it onto Z = 0 (`settle`), then moves it by `offset`, or centres it on the bed when `centered`. | The slicer request, the preview, the bed warnings, Arrange, the 3MF export. |
| `modelPose` (an `Affine`, absent for identity) | Model space, the one frame Model draws every object in (`src/model-space.ts`). Absent means where the object's file put it. | Model's viewport and tools (`meshToModel`, `toSolidOp`), joins, Explode, the MCP's `bake`. **The plate never reads it** (the field's own doc comment). |

The mesh is also lowered to Z = 0 when it is read. `seat` is how far, so the CAD frame of a plate mesh is the mesh moved up by its seat (`meshToModel`, `seatLift`). A plate object therefore has three frames: the CAD frame (the part's own, what a solid's ops are stored in), model space (CAD frame by `modelPose`), and the bed (source by `orient`, lowered, then `offset`).

`modelPose` is already saved: `PlateFileObject.modelPose` in `.lime`, omitted for identity, and the MCP's `PlateObject.modelPose` (`mcp/session.ts`) keeps and writes it. Both session code paths copy it on duplicate and on a split's pieces (`addedSplit`, `replaceWithShells` in `src/plate.ts`).

### What each tool does

| Tool | What it writes | Notes |
|---|---|---|
| `model_place` (`modelPlace` in `mcp/session.ts`) | `modelPose` only: x, y, z and the Euler turns, replacing the pose. | Its schema text says "The bed moves at model_commit". It does not: `commitObject` replaces the mesh and never reads `modelPose`. This sentence is the root of item 18. |
| The app's Place tool (`placeMoved`, `putPose` in `src/app/model.ts`) | `modelPose` through `withModelPose`. | "Its plate pose, mesh, and slice stay as they are." Its own Undo stack (`placeUndo`). |
| `object_place` (`objectPlace`) | `orient`, `partScale`, `centered`, `offset`: centre, lay flat, turn, `z` lift, align to another object or the bed. | Bed frame, not Model. Not a Model edit (its own description says so). |
| Lay out, Arrange (`arrangedObjects`, `arrangeBoxes`, `parkClear` in `src/plate.ts`) | `centered: false` and a new `offset`. | Packs by XY box, left to right then a new row, a gap of `ARRANGE_GAP_MM`. With `keep` it places only the others. Spreads `...obj`, so `modelPose` survives. |
| The first object, `addedSolid` | `centered: true` for the first solid on an empty plate; `parkClear` for any other. | This is the "re-centre": `bedMove` in `src/mesh-place.ts` computes the centre from the placed bounds on every read while `centered` is true. |
| `commitModel` / `model_commit` (`commitObject`) | The object's `source`, `bytes`, `seatMm`, `brep`, `platedNode`. | Leaves `orient`, `offset`, `centered` and `modelPose` alone. A Split to print's pieces are laid out around the kept ones (`layOutPieces`). |

Findings that matter for the plan:

1. **`modelPose` is never overwritten by re-centring or Lay out.** Both only write the bed fields. The data the owner wants kept is kept. What fails is the surface: `model_place` says nothing about which pose it set, `plate_list` reports only the bed box (`placed`), and nothing shows the assembled position of a part. The first milestone proves this with a test before anything is built on it.
2. **Typed numbers in Model are model-space numbers.** `toSolidOp` turns them into the part's own frame with the inverse of `modelPose` before the engine sees them, so stored ops never depend on where an object sits. The cost is the second half of item 18: once `model_place` moves a part, `faces_find`, `model_probe` and `model_apply` read and refuse in the moved frame, and a number typed from the part's drawing is now outside the part.
3. **A join already stores a frozen relative pose.** `relativePose(target, tool)` is computed once at Apply (`joinOp` in `mcp/session.ts`, `JoinOp.relative` in `src/model-tree.ts`), so "moving either object later never moves a cut already made". This is the right behaviour for a boolean and the wrong one for an assembly, which must follow.
4. **The overlap warning is a 2D box test.** `boxesOverlapXY` and `overlapPairs` in `src/plate.ts`, the app's `#plateOverlap` row (`src/app/settings.ts`), and `overlaps()` in `mcp/session.ts` (the sentence "These parts overlap. Move one before slicing.") all compare XY boxes of the placed bounds and ignore Z. On the bed that is right, because two parts that share XY and both sit on the plate collide. It is wrong for a part lifted by `offset.z`, such as a hook sitting on a rim, which is what item 20 reports.
5. **Pieces already share a pose.** `addedSplit` gives a Split to print's piece its parent's `modelPose`, so the pieces sit assembled in model space; `replaceWithShells` gives each shell the pose that takes it back to where the parent stood; a multi-solid STEP opened as pieces (#425, `src/step-solids.ts`, `src/app/step-solids.ts`) keeps each solid where it sat. Explode (`src/app/model-explode.ts`, `src/model-explode.ts`) is a view of exactly this, for one cut. What is missing is the record that these objects belong together.
6. **Model draws every other object at its `modelPose`** as grey context (`contextParts` in `src/model-context.ts`); Prepare draws the bed (`bedParts`). So the two views exist, one per stage. There is no way to see assembled poses from Prepare, and no group that moves in either.

## 3. The model

### The assembly

An **assembly** is a named group of plate objects with one pose per member, relative to another member:

```
Assembly { id, name, members: Member[] }
Member   { object, parent: object | null, offset: [x, y, z], turn: [rx, ry, rz],
           exprs?: { offset?: [string|null x3], turn?: [string|null x3] } }
```

- Exactly one member per assembly has `parent: null`: the **root**. It is grounded: its pose is its own `modelPose` and nothing moves it but the user.
- Every other member's pose in the root's frame is its parent's pose times `(offset, turn)`, where the numbers are in the **parent's own part frame**. A hook five millimetres in from the rim end of the body is `offset: [rimL - 5, 0, bodyH]` of the body, wherever the body is.
- Each number may carry an expression (`exprs`), the same text the Model ops keep (`src/modeling/expr.ts`, `exprs` on the op, stripped before the engine call). It reads the project's `parameters` table (`src/modeling/params.ts`, `parameters` in `src/project.ts`), the table `model_params` writes.
- The graph is a tree. A member names one parent, so a loop cannot exist. A cycle of `parent` names is refused when it is written (the same check as `treeReaches` in `src/model-tree.ts` for joins).

**The solved pose is written to `modelPose`.** Solving walks the tree from the root and writes each member's `modelPose`. `modelPose` stays the single value every existing reader uses (Model, joins, Explode, the MCP), and it is saved with the object as now. The assembly is the constraint layer on top; it adds no second pose that code could read by mistake. This also means an older app, which knows `modelPose` and not assemblies, draws the same assembly (section 7).

### Two views, one bed

| View | Shows | Overlap check | Slicing and export |
|---|---|---|---|
| **Assembly view** | Every member at its `modelPose`: lifted, nested, touching, as designed. Objects outside any assembly at their `modelPose` too. | Interference, in 3D (section 6). Off by default, and never a warning the slicer cares about. | None. Nothing here reaches the G-code. A STEP assembly export reads this view. |
| **Print layout** | Every object at its bed pose (`orient`, `offset`, `centered`), as Prepare shows today. | XY boxes, as now. The slicer and the bed warnings read this. | Unchanged: slice, G-code, 3MF. |

A **member's print pose is its own.** It keeps `orient`, `offset` and `centered`, and Lay out, Arrange, Lay flat and `object_place` act on it as now. An assembly never forces two parts to print together. A hook that prints upright on its end and a body that prints flat each keep their orientation, and the assembly keeps them related.

**The assembly view is Prepare's 3D viewport drawing the objects at `modelPose`**, not a new stage. Model already draws that frame (it is its own space); the view toggle is the way to see it without opening a part. The toggle is view state: not in the undo stack, not in the `.lime` file, as `docs/plate-placement.md` keeps view state out.

**The bed warnings follow the view.** In the print layout the existing `#plateOverlap` row and `OVERLAP` note stay, and they mean what they meant. In the assembly view they are replaced by the interference result. A lifted hook is no longer flagged by the XY test, because that test is not run there.

### How Split to print and multi-solid STEP fit

Both already produce objects at assembled poses (finding 5), so each becomes an assembly with no new geometry:

- **Split to print.** On Apply (not on probe), the pieces and the part form one assembly: piece 1 is the root, and each other piece's pose is the identity relative to the root, since all of them were cut in the root's frame. Pins join it the same way. A cut edited later rebuilds the pieces and keeps the same assembly (the op already knows its pieces: `node.pieces`, `node.pins`). Explode is then one case of an assembly view with an opened gap. It keeps its own code, but its member list is the assembly's.
- **A multi-solid STEP opened as pieces** (#425). The first solid is the root; every other solid is a member at the identity relative to it. "Open as N pieces" keeps the assembly name from the STEP's product name.
- **Separate shells** (`replaceWithShells`) makes the same assembly of its shells, but it stays an opt-in: shells of a mesh are not designed parts.
- **A join** (`kind: "join"`) is not an assembly member by itself. A join fuses or cuts; a `keepTool` join leaves the tool on the plate and could offer "Make an assembly of these". That is a later option, not in this plan.

## 4. What item 18 should become

Three changes, in this order.

1. **Say what `model_place` does.** The reply names the pose it set and the part's box in model space, and states that the bed is unchanged, in one sentence: "Assembled pose set. The print layout is unchanged." The schema text drops "The bed moves at model_commit", which is false. `plate_list` rows gain `assembled`, the part's box under `modelPose` (section 5). A part moved by `model_place` and a part Lay out moved no longer look like the same thing.
2. **Poses survive re-centring, and the test says so.** A new unit test (`src/plate.test.ts` beside `arrangedObjects` tests) pins that `arrangedObjects`, `parkClear` and a `centered` read leave `modelPose` unchanged, and an MCP test pins it through `model_place`, `model_commit` and `plate_arrange`. If any path loses it, this milestone fixes that path. The plan does not claim a bug here, because the code reads right (finding 1); it requires proof, since the owner saw something.
3. **A stable part frame for Model edits.** Each object carries `frame: "model" | "part"`, in `PlateObject` and the project row, absent meaning `"model"`, which is today's behaviour. With `"part"`, `toSolidOp`, `fromSolidOp`, `typedPlane`, `faces_find`, `model_probe`, the section of `render_view` and every reply read and write numbers in the part's CAD frame, as the file's own coordinates, whatever `modelPose` is. The ghost and the viewport still draw at the pose. **A member of an assembly defaults to `"part"`**, since its pose is derived and can change under it when a variable does: a number typed from its drawing must not move when `rimL` does. A part outside every assembly keeps `"model"`, so no existing project, test or macro changes.
   - The switch is `model_place {frame}` and a two-way control in the Place tool's header. It is not a new tool.
   - Refusals name the frame: "This point is outside the part in the part frame. The part sits at (x, y, z) in the assembly." The old refusal named neither.
   - `model_describe` and `model_place` replies include `frame`, so a client never guesses.

Why not make `"part"` the default for everyone: it would change what every stored macro, recipe and MCP script means once a part is moved. D2 in section 9 asks the owner.

## 5. The MCP

No new tool. The model tools stay in the `model` group (`mcp/groups.ts`), and the changes are fields and reply keys on tools that exist.

| Tool | Change | Token note |
|---|---|---|
| `model_place` | New optional `to` (an object handle), `frame` (`part` or `model`), and `assembly` (a name). `x, y, z, turnX, turnY, turnZ` may be a number or a string expression. With `to`, the numbers are relative to that object's part frame and the call writes a `Member` for this object (creating the assembly, with `to` as root, if neither is in one). Without `to`, as today, and for a member the numbers set its offset from its parent. | Replaces one schema line and adds three short fields, under the 750-token per-tool budget in `mcp/schema.test.ts`. |
| `model_params` | A change re-solves every assembly that reads the changed name, and the reply lists the members that moved. | None. |
| `plate_list` | Each row gains `assembled` (the box under `modelPose`) and `assembly` (name, when a member). | Row keys only. |
| `model_check` | New optional `interference: true`. Reports each pair of parts in the same assembly that share volume: the mesh test's answer, then OCCT's volume when asked (`exact: true`). | One field pair on an existing tool. |
| `model_commit`, `plate_arrange` | Unchanged. `plate_arrange` gains an optional `assembly`, which lays out only that assembly's members, around the others. | One field. |
| `render_view` | One optional `view`: `assembly` or `print`. Absent keeps today's. (Its options are read in M5; if the existing parameters already carry a view, this reuses them.) | One field. |
| `guide` | Entries `assembly` and `place` under `guide {kind}`, written like the existing kind entries. | Guide text is read on demand, not in `tools/list`. |

The `object_place` description keeps "Not a Model edit" and points to `model_place` for the assembled pose.

An assembly is data in the session (`mcp/session.ts`) and in `.lime`; it is not a tool. `session_info` and `plate_list` show it.

The token budget test (`TOTAL_BUDGET` 16,000 and `TOOL_BUDGET` 750) stays as it is. If M4 pushes one tool over its budget, the extra field text moves into the guide, not the schema.

## 6. Interference

Interference is a statement about two parts at their assembled poses: they share volume. Touching faces do not count (as `OVERLAP_EPS_MM` keeps touching out of the 2D check).

1. **Cheap pass: boxes, then triangles.** For each pair in an assembly, test the 3D boxes of the posed meshes (`boxUnder`, `posedBounds` in `src/model-space.ts` already compute them). A pair with disjoint boxes is clear. For a pair whose boxes overlap, test triangle pairs through a bounding-volume tree built over each part's source mesh once and posed by the relative transform, in a new `src/interference.ts`, so no vertex is copied per pose. An intersecting triangle pair is a **crossing**. The pass answers `clear`, `touch` (boxes meet and no triangle crosses, which also covers a part nested wholly inside another) or `crossing`. It runs on the mesh the plate holds, in the page or in a worker, at a size the existing Prepare outline worker has already shown is fine.
2. **Exact pass: common volume.** For each `crossing` pair (and each `touch` of a part nested in another, which needs the solid), ask Open CASCADE for the common volume. The path already exists: a `join` with `op: "common"` and `relativePose` between the two parts' trees builds the intersection and `model_probe`'s metrics return its volume (as `partitionPieces` runs on a spare step and drops it). So the exact pass is a probe on a spare node of one tree, then a drop. No new kernel function. Result: `volumeMm3` and a box of the overlap. A common volume under 0.01 mm^3, or under 1e-6 of the smaller part's volume, is `touch`, since the kernel meshes and a coincident face can report slivers.
3. **Meshes without a solid** (an STL part): only the cheap pass runs, with the label "Mesh crossing, not measured".
4. **Where it shows.** In the app, the assembly view tints the two crossing parts and the objects list says "Hook 3 crosses Body: 14.2 mm^3". In the MCP, `model_check {interference: true}` returns the pairs. Neither blocks anything: an intentional interference fit (a press pin) is a design choice, and the only blocking check is the print layout's.

A pair of parts in different assemblies, or in none, is not checked in the assembly view. The cost grows with the pairs inside one group, not with the plate.

## 7. The project file

Stay at version 4. Nothing in the existing keys changes meaning.

- `assemblies`, an optional top-level array beside `objects` in the document `src/project.ts` writes (like `parameters`, `heldPieces`). Omitted when empty. Each row is `{id, name, members: [{object, parent, offset, turn, exprs?}]}` with `object` and `parent` the plate objects' ids.
- `frame` on an object row, omitted for `"model"`.
- Every member's solved pose is also written as that object's `modelPose`, as now.

How an older app reads such a file: it ignores `assemblies` and `frame`, as it ignores `heldPieces`, and opens every object at the `modelPose` saved with it. The assembled positions, the grey context in Model and the print layout are all the same. What it loses is the link: a variable change does nothing there, and the next save by that older app drops the `assemblies` key. A file saved by an older app and reopened by this one has no assemblies, and nothing is wrong with it. A row whose `object` is not in the file (an object removed by an older app) is dropped on read, and the member's children keep their solved poses as fixed ones.

A test in `src/project.test.ts` keeps a version-4 file with `assemblies`, reads it, and writes it identically; another reads a file without the key.

## 8. Milestones

Each one lands as its own PR, is usable, and has tests.

| # | Milestone | Usable result | Tests |
|---|---|---|---|
| M1 | **Say it and prove it** (item 18, parts 1 and 2). `model_place` reply and schema text, `plate_list.assembled`, and the survival tests. | A client sees which pose each call set, and the assembled box of every part. | `src/plate.test.ts` (re-centre, Lay out, Arrange keep `modelPose`); `mcp/part-a.test.ts` style session test: place, commit, arrange, list; `mcp/schema.test.ts` budgets. |
| M2 | **The assembly data.** `src/assembly.ts`: members, relative poses, expressions, the solve to `modelPose`, cycle refusal. Project key, read and write, old-file reads. No UI. | Pure and tested. Nothing visible yet. | New `src/assembly.test.ts` (chain, root move, rotation, expression, cycle, removed member), `src/project.test.ts` (round trip, older file), added to `tools/unit-tests.txt`. |
| M3 | **Variables reach poses** (item 19). A `parameters` change re-solves the assemblies that read it, in the app (the hook the Parameters panel and `refreshOp` in `src/param-rebuild.ts` use) and in `model_params`. | Change `rimL`, and the hooks move. | Unit test of the re-solve; MCP test: define `rimL`, place hooks by `rimL - 5`, set 120, read `plate_list.assembled`. |
| M4 | **The MCP surface.** `model_place {to, frame, assembly}`, expression strings, `plate_list.assembly`, `plate_arrange {assembly}`, the guide entries, and the part frame (item 18, part 3). | The owner's LED-cover scenario in one session: a body, hooks on its rim, `rimL` changed. | `mcp/assembly.test.ts` (new): place by relative offset, frame `part` keeps a typed face stable after a move, refusals name the frame; real-engine run for a solid body with a hook; schema budgets. |
| M5 | **The view toggle and grouping in the app** (item 20). Objects list groups by assembly, Prepare's viewport can show the assembly view, a group move in it, and the Place tool's frame control. `render_view {view}`. | The user sees the design assembled and the bed layout from one list, and a lifted hook is not flagged. | `e2e/assembly.spec.ts` (new, in `test:smoke`, `--repeat-each=3`): group two objects, toggle, check no overlap row for a lifted part, change a parameter, check the move; screenshots in the owner's dark 1440x1000 view. |
| M6 | **Interference, cheap pass** (`src/interference.ts`) and its display. | Crossing parts tinted in the assembly view; `model_check {interference: true}` answers. | `src/interference.test.ts` (clear, touch, crossing, nested, a large pair inside a time budget); e2e tint check. |
| M7 | **Interference, exact volume** through a spare `common` step. | "14.2 mm^3" on a crossing pair, and a touching pair reads clear. | Rust-backed MCP test with the real engine (`LIME_REQUIRE_OCCT=1`): a pin in a hole of the right and the wrong size; sliver threshold. |
| M8 | **Assemblies from Split to print and a multi-solid STEP.** Apply and Open-as-pieces make the assembly; Explode reads the assembly's members. | A cut part is one assembly the moment it is cut, and the hooks of a vendor STEP stay related. | `mcp/partition.test.ts`, `mcp/step-solids.test.ts`, `e2e/model-split-print.spec.ts` and `e2e/step-solids.spec.ts` extended; an old project reopens without an assembly. |
| M9 | **Print layout for an assembly and a STEP assembly export.** Lay out for one assembly, and `model_export_step` with `assembly: true` writing the members at their assembled poses as named solids (the XCAF path `pieceNames` already uses). | Print an assembly's parts laid out; hand the CAD user the assembly. | Export round trip test (`crates/lime-model-occt` step test, MCP test), `e2e` for Lay out. |

M1 is the quick one that closes the owner's confusion, and it should land first on its own. M2 to M4 are the owner's scenario for the MCP. M5 to M7 are the app. M8 and M9 follow.

### As built: M1

M1 landed with the part frame (section 4, change 3) in it, since the owner's item 18 needs it: saying which pose `model_place` set does not stop a later edit from refusing.

- **`model_place` says what it did.** The reply carries `pose: "assembled"`, `frame`, `assembledMm` (the part's box in model space, to 0.01 mm) and the sentence "Assembled pose set. The print layout is unchanged." The false schema text "The bed moves at model_commit" is gone.
- **`plate_list` reports both.** `bboxMm` is still the print layout. Each row gains `assembledMm`, the part's box under `modelPose` (from the solid when it has one, else from the plate mesh by its seat), and `frame` when it is `"part"`. The key is `assembledMm`, not `assembled`, to match `bboxMm`. `assembly` waits for M2.
- **Survival is tested, and nothing needed fixing.** `src/plate.test.ts` pins that `arrangedObjects` (with and without `keep`) and a centred read leave `modelPose` and `frame` alone. `mcp/assemblies-m1.test.ts` pins it through `model_place`, `object_place` (centre on the bed), `plate_arrange` and `model_commit`, on the real engine.
- **The frame.** `PlateObject.frame` is `"model" | "part"`, absent for `"model"` (D2: nothing changes for any existing object). `model_place {frame}` sets it. With `"part"`, every typed number in the MCP (`bake`, the workplane, the `render_view` section, the checks and the pieces they report, the partition planner) goes through `typedPoseOf` (`src/model-space.ts`), which is the identity for a part-frame object, so a stored op is the op that was typed. A join still stores the true relative pose of its two objects. On `main`, a box with a hook fused on and then `model_place x: 200` refuses the same hook in `model_probe` ("This would add a separate body ... at least 149 mm clear of the part's bounding box"), and `model_edit` then answers "Probe this edit first". With `frame: "part"` the probe, the edit and a further apply all work; with the default frame they refuse exactly as before.
- **The file.** `frame` is saved as `"part"` on the object row and omitted for `"model"`. An older app ignores it and drops it on its next save, as it does `heldPieces`. The app reads and writes it, and copies it on duplicate and on a split's pieces, so a project the MCP saved keeps it through the app.
- **Not in M1.** The app still types Model numbers in model space whatever `frame` says (the viewport, its picks and the panel share `openPose()`). The Place tool's frame control and the app side of the frame are M5. A refusal does not yet name the frame (M4). `faces_find`, `edges_find` and `surface_at` answer in the part frame, as before.
- **Tests.** `src/plate.test.ts`, `src/project.test.ts`, `src/model-space.test.ts`, `mcp/assemblies-m1.test.ts` (added to the CI step that runs against real Open CASCADE), and the unchanged token budgets in `mcp/schema.test.ts`.

## 9. Open decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | Is `modelPose` the one stored assembled pose, with the assembly as a constraint layer that writes it? Or does the assembly own a second pose per member? | The first. One value for every reader, and an older app draws the same assembly (section 3 and 7). |
| D2 | Which frame do typed Model numbers use? Always the part's, always model space, or per object? | Per object (`frame`), with `"part"` the default for a member of an assembly and `"model"` for everything else. It fixes the owner's refusals without changing any existing project. Make `"part"` the default for all in a later major version, if the owner wants it. |
| D3 | Mates in the first release: fixed offsets only, or also face and anchor mates? | Fixed offsets with expressions first (M2 to M4). A mate is a way to compute an offset from two named features (`model_anchors` labels, a face pair), so it is an add-on that writes the same `Member` fields. Wait until the owner has used fixed offsets on the LED cover. |
| D4 | Does the assembly view live in Prepare's viewport, or does it open Model? | In Prepare's viewport as a toggle. Model already draws model space for the open part; the toggle shows it for all, with no part opened. |
| D5 | Should the interference check run by itself, or only on request? | Mesh pass automatic in the assembly view (it is cheap and bounded to one assembly); the exact volume on request or on hover. It never blocks. |
| D6 | A member's print pose: free, or kept from its assembled orientation? | Free, as now. A hook is not printed in the orientation it assembles in. An option "Print as assembled" can come later. |
| D7 | Is a Split to print's group made at Apply, or only on request? | At Apply, so the cut parts are related from the first moment. A card checkbox "Group the parts" on by default can turn it off. It adds no print time, so it does not clash with the "no costly defaults" rule. |
| D8 | Does Separate shells make an assembly? | Yes, but only when the user chose Separate; a mesh's shells are not designed parts, and the group is easy to remove. |
| D9 | What does moving the root do? | Moves the whole assembly (every member's `modelPose` changes by the same transform). The print layout does not move. |
| D10 | A deleted member or root? | Deleting a member removes its row and gives its children its parent as theirs, keeping their solved poses as new offsets. Deleting the root asks which child becomes the root. Deleting the last two members dissolves the assembly. |
| D11 | Where does the interference tolerance sit? | 0.01 mm^3 or 1e-6 of the smaller part, one constant in `src/interference.ts`, tested. |

## 10. How other tools split the two views

- **Bambu Studio** has an **Assembly View** beside Prepare: a separate workspace where components of one model are positioned, rotated and spaced out (explode controls) relative to each other, for the design, and a plate for printing. Its positioning is basic; the docs send advanced edits to CAD. It is the closest match to this plan's two views. [Assembly view](https://wiki.bambulab.com/en/bambu-studio/assembly-view). Users also report overlap of parts in the assembly view and fix it with the explode controls, which is the confusion in item 20 from the other side: [forum thread](https://forum.bambulab.com/t/models-overlap-in-assembly-view-anyone-else-having-this-issue/75297). Bambu Studio 2.8 beta adds an assembly guide generated from a STEP file with exploded views: [BambuHub](https://bambuhub.net/articles/bambu-studio-2-8-beta).
- **PrusaSlicer** keeps one object with **parts** (its own list of part volumes, each with its offset), and splitting "to parts" keeps the original assembly layout, while splitting "to objects" makes separate bed objects. The parts-versus-objects split is the same line this plan draws, with the difference that PrusaSlicer's parts share one object's slice and our members are separate plate objects. [Object list](https://help.prusa3d.com/article/object-list_1758), [splitting to parts](https://3dprinterly.com/how-to-separate-parts-in-prusaslicer-cutting-parts/).
- **Onshape** places instances with **mates** between **mate connectors**, local coordinate systems on or between entities, and one mate between two instances embeds their freedom of motion. Parts are positioned relative to a fixed one. This plan's `Member` is a mate of the fastened kind with typed offsets; D3 leaves a connector-based mate for later. [Mates](https://cad.onshape.com/help/Content/Assembly/mates.htm), [Mate connectors](https://cad.onshape.com/help/Content/mateconnector.htm).
- **Fusion** has joints and **as-built joints**, which relate components already positioned to each other without moving them, and **rigid groups**, which lock the relative position of components so they act as one. An as-built rigid joint is the case here: parts that already sit assembled (a Split to print's pieces, a STEP's solids) are related, not moved. A grounded base component is the root. [As-built joint](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-CREATE-AS-BUILT-JOINT.htm).

What the survey changes: Bambu's separate Assembly View confirms the toggle (D4) and says the weak point is overlap and spacing, so the interference check (section 6) is not optional. Onshape and Fusion confirm one grounded root and relative poses, and that mates beyond fixed ones are a separate, larger step (D3).

## 11. Constraints

- **Licence.** New code is MIT. No new native dependency.
- **Offline.** Nothing is fetched at run time.
- **Slicer output.** No new `SliceRequest` field and no G-code comment. Golden G-code stays byte-identical, and `crates/lime-slice-core` is unchanged.
- **Existing behaviour.** Every file without `assemblies` and `frame` reads and behaves as now. Split, Split to print, Place, Explode, `object_place`, Arrange and the project reader for older files stay.
- **MCP size.** No new tool; the budgets in `mcp/schema.test.ts` hold.
- **View state.** The view toggle and the explode gap are not saved and not in the undo stack.
