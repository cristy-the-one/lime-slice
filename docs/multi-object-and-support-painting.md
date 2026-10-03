# Multi-object plates and support painting

This is a design for Claude to review. Nothing in this note is implemented. Sections marked **Proposal** are not the current wire. The two features share one rule: a plate with one object and no paint must emit the same G-code the engine emits today.

## Multi-object plates

Several meshes on one bed, each with its own placement and a few settings of its own.

### Goals

- Load more than one mesh, place each one, and see it on the bed before a slice.
- Warn when two objects overlap, or when one leaves the bed.
- Arrange objects on the bed from their bounds.
- Slice the plate in one request. Print order is either every layer across all objects, or one object finished before the next starts.
- A `.lime` project from a later version still opens a version 1 file.

### Non-goals

- Different layer heights on one plate. Layer height, adaptive layers, nozzle, and temperatures stay plate settings.
- Assemblies that stay as named STEP components. A STEP file is still one mesh after tessellation.
- A second printer, a wipe tower, or a prime tower.
- Mesh-boolean union. Overlap is a warning. The slice does not fuse the solids.

### Current state

A job is one mesh.

- `state.mesh` is one `{ name, bytes }` or null (`src/app/state.ts`). Loading another file replaces it and clears support edits (`src/app/files.ts`).
- Placement is one pose: orientation, scale, center, offset, and a STEP chord tolerance. `placeMesh` writes a `PlacedPart` and a `RigidPose` (`src/mesh-place.ts`). The slicer applies that pose after load (`SliceRequest::pose` in `crates/lime-slice-core/src/slice.rs`). Scale is already in the vertices.
- The object list is one row: name, triangle count, size, Center, Lay flat, and 90° rotations (`objectList` in `src/app/settings.ts`).
- Bounds against the bed are a warning, not a block. `offBed` in `src/mesh-place.ts` checks the axis-aligned box against the printer profile.
- The slice body is one `filename` and one `dataB64`, plus the pose (`payload` in `src/app/slice-run.ts`). `POST /api/slice` and `POST /api/jobs` take that body.
- STEP import merges every closed solid into one triangle mesh (`crates/lime-slice-core/src/step.rs`). 3MF import reads the first `.model` part and appends every vertex and triangle into one `Mesh` (`load_3mf` / `parse_3mf_model` in `crates/lime-slice-core/src/load.rs`).
- G-code is one `;LAYER:` header per layer (`layer_header` in `crates/lime-slice-core/src/gcode.rs`). On a layer the skirt and supports are one tour, then the part is its own tour (`docs/support-edits.md`). There is no object id and no sequential mode.
- A `.lime` project is version 1: one `mesh`, one `placement`, plate `settings`, one printer `profile`, and one `supportEdits` list (`PROJECT_VERSION` and `LimeProject` in `src/project.ts`). `migrations` is empty. `applyMigrations` is the hook a later version uses.

### Proposal: data model

A plate is an ordered list of objects. The order is the print order.

```ts
interface PlateObject {
  id: string;
  name: string;
  mesh: ProjectMesh;
  placement: ProjectPlacement;
  /** Keys omitted inherit the plate preset. Layer height is not allowed here. */
  settings: Partial<PresetSettings>;
  supportEdits: EditEntry[];
  /** See the painting section. Empty when the user has not painted. */
  supportPaint: SupportPaint;
}
```

`ProjectMesh` and `ProjectPlacement` stay the types in `src/project.ts`. `PresetSettings` stays the type in `src/presets.ts`. Plate-level fields stay what version 1 stores on the project: `settings`, `profile`, `level`, and the blend. Per-object keys are the ones that describe that solid only: supports on or off, support angle and style, infill combine, walls, scarf, gyroid. Which of those keys are legal is a review question.

Collision is the overlap of two axis-aligned bounds in XY, and a flag when either box fails `offBed`. Volume intersection is not in the first model.

Arrange writes new `placement.offset` values. It does not rotate.

### Proposal: request and response

`objects` is omitted when the plate has one object and that object has no setting overrides and no paint. The body is then the one `filename`, `dataB64`, and `pose` sent today, so the cache key does not change.

When `objects` is present:

```json
{
  "objects": [
    {
      "id": "a",
      "filename": "cube.stl",
      "dataB64": "...",
      "pose": { "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [0, 0, 0], "translation": [10, 20, 0] },
      "settings": { "supports": true }
    }
  ],
  "printOrder": "all-at-once"
}
```

`printOrder` is `all-at-once` or `sequential`. It is omitted for `all-at-once`. `sequentialClearanceMm` is sent only for `sequential`. `0` means the nozzle radius plus one line width.

`all-at-once` keeps today's layer loop. On each layer the engine prints objects in plate order. Each object's part is its own tour. The first object's tour starts where today's single part tour starts. Later objects start where the previous object's tour ended. Supports for a layer stay one tour before the parts, in the same object order.

`sequential` finishes every layer of object 1, including its supports and skirt, then starts object 2. The nozzle must clear the finished object's bounds by `sequentialClearanceMm` for the whole of the next object. If it cannot, the response is an error and no G-code is returned.

The response adds, and omits the array when the request had no `objects`:

```json
{
  "objects": [
    { "id": "a", "min": [0, 0, 0], "max": [20, 20, 20], "triangles": 12 }
  ],
  "collisions": [
    { "a": "a", "b": "b", "overlap": [1, 2, 10, 12] }
  ]
}
```

`overlap` is the XY box in millimetres. Paths in a preview layer gain an `object` index into `objects`. Absent means the only object, index 0. G-code comments gain `;OBJECT:a` at the start of that object's tour. A one-object reply has neither the comment nor the field.

### Proposal: project file

Version 2 adds `objects` and removes the single `mesh`, `placement`, and top-level `supportEdits`. The plate `settings`, `preset`, `profile`, and `level` stay.

`migrations[1]` wraps a version 1 document: one object, id `part`, that object's mesh, placement, and support edits, empty paint, empty per-object settings. A version 1 file still opens. A save writes version 2 after the user has opened it. A plate that is still one object with no overrides and no paint may be written as version 1 so older apps open it. That choice is a review question.

### What the UI can do first

A mock plate lives in the session, beside `state.mesh`. The adapter is marked mock.

- Add, select, duplicate, and delete objects. Selection is one id. The gizmo and the object list edit that id. Undo and redo (`src/app/history.ts`) record the selected object's placement, the same way they record the one pose today.
- Collision and bed warnings use `boundsOf` and `offBed` on each object. Overlap of two boxes is a warning line, same tone as `offBed`.
- Arrange packs those boxes in rows on the bed, left to right, then a new row. It does not call the engine.
- Slice, while the engine has no `objects` field, concatenates the placed meshes into one STL and sends today's body. The toast says the engine sliced one mesh. Per-object settings are not sent. `sequential` is refused in the UI until the engine accepts it.
- The compact sheet lists objects in the existing object list. The prepare canvas at the peek detent stays at least 70% of a 390×844 screen.

### What needs engine work

`crates/lime-slice-core` has to accept `objects`, plan each solid, and emit the tours above. `load_3mf` and STEP import stay one mesh until a later change. Sequential clearance is engine work. Per-object settings are engine work. The mock concatenation is not that planner: it glues triangles into one solid, so walls can fuse where boxes overlap.

### Risks

- A one-object request that always sends `objects` will change the cache key and can change G-code if the tour start moves. The omit rule is the guard.
- Concatenated STL is a different mesh. It must not be the path used to claim byte-identity.
- Absolute E means any new tour above layer 0 rewrites every later E value. Object order is part of the G-code.
- Sequential mode can crash the tool into a finished object if clearance is short. The error response is the guard. It does not emit a partial file.
- Version 2 files will not open in an app that only knows version 1. The migration has to run in this app first.

### Test plan

- `tools/golden_ab.sh`: one object, no overrides, no paint, `objects` omitted. G-code is byte-identical to the current tree.
- A fixture with two cubes: `all-at-once` G-code contains `;OBJECT:` in plate order on layer 0, and `;LAYER:1` does not start until both objects have printed layer 0. `sequential` prints every layer of the first id before `;OBJECT:` of the second.
- Unit tests for the version 1 migration, for box overlap, and for arrange staying inside the bed.
- A request with an empty `objects` array is refused.
- Playwright: two samples on the plate, the overlap warning, arrange, undo of a move, and the compact prepare canvas at or above 70%. The slice in that test uses the mock adapter and does not claim engine G-code.

## Support painting

An enforce brush and a block brush on the mesh. Enforce adds support demand the overhang angle would skip. Block removes demand the angle would keep.

### Goals

- Paint on the shaded mesh, before or after a slice, and see the marks without a slice.
- The next slice feeds those marks to the support planner as extra demand or suppressed demand.
- Existing prune and regrow still replay after the walk.
- A slice with no paint matches a slice that never heard of paint.

### Non-goals

- Painting support tips, branches, or the bed. The brush hits the part.
- A density brush, a custom support shape, or paint on the preview toolpaths.
- Grid supports gaining limb identity. Grid keeps coverage warnings and keeps refusing prune and regrow (`docs/support-edits.md`).

### Current state

Demand comes from the mesh and the overhang angle, not from the user.

- `overhang_at` in `crates/lime-slice-core/src/support.rs` marks the area past the support angle, plus islands. The walk grows tips from that demand. Nothing in the request adds or removes a patch of it.
- Edits are `prune` and `regrow` only (`src/support-edits.ts`). A prune stores birth sites. A regrow stores a region and a z range. They are replayed in order. Empty `supportEdits` is omitted so the cache key stays put (`editRequestFields`).
- The UI picks a limb or a coverage gap from the skeleton after a slice (`src/ui/support-edit-ui.ts`, `docs/ui-support-edits-plan.md`). It does not draw on the part to choose demand.
- Compact editing is the preview: a branch tap, a tree long-press, and a Prune or Regrow chip. The prepare canvas is where the mesh is, and it has no brush.

### Proposal: data model

Paint is stored in world millimetres on the placed mesh, not as triangle indexes. A STEP re-tessellation and a reload must still hit the same patch. This is the same idea as a birth site, which stores a position because walk ids change.

```ts
interface PaintDisk {
  /** Point on the placed surface, mm. */
  p: [number, number, number];
  /** Outward normal. */
  n: [number, number, number];
  /** Brush radius, mm. */
  r: number;
}

interface SupportPaint {
  enforce: PaintDisk[];
  block: PaintDisk[];
}
```

A stroke appends disks along the ray hits. A later stroke of the other kind does not delete disks. At plan time, block wins where the two footprints overlap. Disks are capped at 20000 per object. A disk with a non-finite component or a radius outside 0.2 mm to 40 mm is refused.

### Proposal: how the planner uses it

Order of one slice:

1. Build demand as today, from the overhang angle and islands.
2. Project `enforce` disks onto that demand's layers and union them in.
3. Project `block` disks and subtract them.
4. Run the walk on that demand.
5. Replay `supportEdits` as today. A regrow only fills demand that step 3 left unheld. A prune still removes limbs by birth site. Paint does not rewrite a kept knot.

`supportPaint` is omitted when both lists are empty, on the request and in the cache key. The field sits next to `supportEdits`, not inside it, so a prune list from an older client stays valid.

Grid style uses the same demand change for its columns. Prune and regrow on grid stay `stale`.

The response adds `supportPaint` only when the request sent it:

```json
{
  "supportPaint": {
    "enforce": 12,
    "block": 4,
    "enforceUnhit": 1,
    "blockUnhit": 0
  }
}
```

The numbers are disks that projected onto a layer, and disks whose point plus normal missed the mesh. A miss does not fail the slice.

### Proposal: UI

Prepare gains Enforce and Block. The brush is a ray on the placed mesh, the same ray the support editor already builds, aimed at the part instead of a limb. Radius is a slider. Strokes are undo steps in `src/app/history.ts`, one gesture per drag.

After a slice, painted demand that grew no tips shows the existing coverage warning. Blocked demand that still printed is a prune the user can apply. The editor does not auto-prune.

Compact: the brush tools sit in the prepare sheet, 44px targets. Painting does not open the preview sheet. At the peek detent the prepare canvas stays at least 70% of a 390×844 screen. One finger paints when the brush is on. Orbit stays available from a second control, the same split the support editor uses between tap and drag.

### What the UI can do first

A mock adapter stores `SupportPaint` on the object and draws the disks on the prepare mesh. Slice does not send `supportPaint` until the engine accepts it. The toast says paint is stored locally. Prune and regrow keep using the real `supportEdits` field. The mock must not invent birth sites.

### What needs engine work

`crates/lime-slice-core` has to project the disks into demand inside `crates/lime-slice-core/src/support.rs`, then run the existing walk. The UI cannot check that a blocked overhang lost its tips until that lands.

### Risks

- Triangle indexes would be stable for one STL load and wrong after STEP tessellation or a re-export. Disks avoid that and can miss a thin feature. `enforceUnhit` is the signal.
- Paint changes where tips are born, so saved prunes go `stale` more often. That is the existing replay rule, and it will surprise anyone who paints after pruning.
- Block then regrow: the regrow fills only what block left. A regrow region drawn over a block does not punch through the block. The reverse order is a review question if paint is ever folded into the edit list.
- Empty paint must stay off the cache key. A default `{ enforce: [], block: [] }` would split the cache.

### Test plan

- `tools/golden_ab.sh`: supports on, `supportPaint` omitted. G-code is byte-identical.
- An enforce disk on a face below the support angle grows tips that a slice without the disk does not. A block disk on an overhang above the angle drops those tips. Both fixtures are engine tests.
- A prune saved before the paint, whose site moved, returns `stale` and does not move a kept knot.
- Empty lists omitted: the request JSON used as the cache key matches the pre-paint request.
- Unit tests for disk caps, the block-wins overlap, and undo of one stroke restoring the lists.
- Playwright: paint three disks, undo, the local toast while the mock adapter is on, and the compact canvas share. Those tests do not assert G-code.

## Review questions for Claude

1. For a one-object plate, should the client omit `objects` entirely, or send a one-element `objects` array and require the engine to prove byte-identical G-code against the old body?
2. Which `PresetSettings` keys are legal per object? Is layer height, adaptive layers, scarf, and the blend forbidden on the object, as this note says?
3. Is `sequential` in the first engine change, or is the first change `all-at-once` only, with `sequential` refused until clearance exists?
4. Is an axis-aligned overlap warning enough until mesh intersection exists, or should arrange be blocked until the engine reports a real collision?
5. Should arrange stay a client pack of boxes, or become an engine endpoint that also knows the skirt and the sequential clearance?
6. After migration, should a still-single object be saved as version 1 or always as version 2?
7. Are world-space disks the right paint primitive, or should paint store triangle indexes into the placed mesh plus a barycentric hit?
8. Where block and enforce overlap, this note lets block win. Should the later stroke win instead?
9. Should paint stay a sibling field of `supportEdits`, or become edit kinds so one list is the replay order?
10. A regrow over a blocked patch does not punch through the block. Is that the rule, or does a later regrow override paint?
11. Does grid style honor paint, given that grid still has no prune or regrow?
12. On compact, is the brush a prepare-sheet tool, or a mode of the existing support-edit chip on the preview?
13. Is the concatenated-STL mock acceptable for the first UI pull request, as long as byte-identity is claimed only for the real one-object request that omits `objects` and `supportPaint`?

## Decisions (review, 2026-10-03)

1. The client omits `objects` for a one-object plate with no overrides and no paint. The engine must also accept a one-element `objects` and produce the same G-code as the omitted form. A test checks that. The omit rule guards the cache key.
2. These per-object keys are legal.
   - The blend.
   - Support settings: on or off, angle, style, density, tip, and trunk.
   - Scarf, gyroid3d, and infill combine.
   - The same small override set as modifiers: infill, walls, and speed.

   These plate-only keys are refused per object.
   - Layer height, adaptive, line width and nozzle, and simplify.
   - Temperatures and the printer profile.
   - Z-hop, combing, arc fit, and travel opt, because travel and emit are plate-wide.

   The request has no support density key today. Density comes from the strategy, so a per-object density follows from a per-object blend until a key exists.
3. The first engine change is all-at-once only. `sequential` is refused with a clear error until clearance checking exists. Sequential is the second engine step.
4. An axis-aligned XY box overlap warning is enough at first. Arrange is not blocked. The engine can later report real first-layer footprint overlap in `collisions`.
5. Arrange stays a client box pack. An engine endpoint comes only when skirt or sequential clearance must be part of it.
6. A plate that is still one object with no overrides and no paint is saved as version 1, so older apps open it. Anything else is saved as version 2.
7. Paint is disks in the object's own mesh frame, before the pose. The slicer transforms them by the pose, so paint moves with the part when it is moved or rotated. Triangle indices break on remesh or STEP re-tessellation, so they are not used. This replaces the world-millimetre wording in the data model above.
8. The later stroke wins, in paint order. That is what a user expects when painting enforce over block or block over enforce. This replaces "block wins" above. The disks need one ordered list with a kind on each disk, because two separate lists lose the order between kinds.
9. Paint stays a sibling field of `supportEdits`. Paint changes demand, the input to the walk. Edits change the grown forest. They are different layers and replay in that order. Demand with paint comes first, then the walk, then edits.
10. A regrow does not punch through a block. Block removes demand, and regrow only fills unheld demand.
11. Yes, grid honors paint. Paint works at the demand level, so grid gets it for free. Both styles build their demand through the same `Demand` build in `crates/lime-slice-core/src/support.rs`.
12. This is a UI choice for the UI owner. The suggestion is a mode of the existing support-edit chip on the preview, since that is where support editing already lives.
13. Yes. The concatenated-STL mock is acceptable for the first UI pull request if it is labeled as a mock. Byte-identity is claimed only for the real one-object request.

**Engine order across these notes.** The seam picker comes first, then height ranges and modifier volumes, then ironing, then support paint, then multi-object all-at-once, then sequential.

## Engine design: all-at-once plates (2026-10-04)

This section is the contract and the design for the first engine step: `objects` with all-at-once print order. It replaces the proposal above where the two differ. Sequential order and support paint are not in this step.

The goal is the part-frame rule from `docs/part-frame.md`, per object. Moving one object in X/Y re-runs only the plate join and the G-code emit. Changing one object re-plans only that object.

### Contract: request

```json
{
  "layerHeight": 0.2, "printer": {}, "supports": true, "supportStyle": "tree",
  "printOrder": "all-at-once",
  "objects": [
    { "id": "a", "filename": "dragon.stl", "dataB64": "...",
      "pose": { "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [0, 0, 0], "translation": [80, 110, 0] } },
    { "id": "b", "filename": "bracket.step", "dataB64": "...", "stepToleranceMm": 0.05,
      "pose": { "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [0, 0, 0], "translation": [150, 110, 0] },
      "settings": { "supports": false, "blend": { "mode": "single", "strategy": "toughness" } },
      "supportEdits": [] }
  ]
}
```

- `objects` is omitted for a plate with one object and no overrides. The body is then today's body.
- When `objects` is present, the top-level `filename`, `dataB64`, `pose`, and `supportEdits` must be absent. The error names the field.
- An empty `objects` is refused. Duplicate ids are refused. An id is 1 to 64 characters from `A-Z a-z 0-9 . _ -`, because it is written into a G-code comment.
- `printOrder` is omitted or `"all-at-once"`. `"sequential"` is refused with `printOrder "sequential" is not supported yet`.
- `stepToleranceMm` is a load parameter of each object, not a setting.
- A missing `pose` means the object's bytes are already in print space, with offset `[0, 0]`.
- `compare` is refused with `objects`. `baseline` is skipped for a plate.

`objects[i].settings` is checked key by key against one table in `crates/lime-slice-core/src/slice/wire.rs`. Each key has one of three scopes.

| Scope | Keys | Error |
| --- | --- | --- |
| Object | `blend`, `supports`, `supportAngle`, `supportStyle`, `tipDiameter`, `trunkDiameter`, `branchAngle`, `supportHeightMult`, `scarfSeam`, `scarfLength`, `scarfSteps`, `scarfStartHeight`, `scarfStartFlow`, `gyroid3d`, `infillCombine`, `variableWidth` | none |
| Plate | `layerHeight`, `adaptive`, `adaptiveMin`, `adaptiveMax`, `lineWidth`, `printer`, `simplify`, `simplifyErrorMm`, `zHop`, `zHopHeight`, `zHopMinTravel`, `combing`, `arcFit`, `travelOpt`, and every other request key | `objects[1].settings.layerHeight is a plate setting` |
| Not yet | `infill`, `walls`, `speed` | `objects[1].settings.walls is not supported yet` |

Any other key is refused with `objects[1].settings.foo is not a setting`. `variableWidth` is per object because it changes only that object's toolpaths, and the UI plate already stores it.

An object's settings are the request's settings with that object's keys written over them. The engine then resolves them with the same `SliceSettings::from_request` as a single slice, so clamps and defaults have one source.

### Contract: response

A request that omits `objects` gets today's reply, with one change for every reply (see the preview patch contract below).

A request with `objects`, including a one-element `objects`, gets the objects shape:

```json
{
  "mesh": { "triangles": 52100, "outlineToleranceMm": 0.025, "min": [61, 92, 0], "max": [171, 128, 40] },
  "objects": [
    { "id": "a", "min": [95, 92, 0], "max": [125, 128, 40], "triangles": 50000, "offset": [-15, 0],
      "coverage": [], "supportEdits": [], "reused": ["contours", "toolpaths", "order", "comb", "supports", "supportPaths"] },
    { "id": "b", "min": [100, 100, 0], "max": [120, 120, 20], "triangles": 2100, "offset": [40, 0],
      "coverage": [], "inAir": { "islands": 0, "overhangs": 1 }, "reused": [] }
  ],
  "collisions": [{ "a": "a", "b": "b", "overlap": [140, 100, 141, 120] }]
}
```

- Each `objects[i]` holds that object's `min`, `max`, `coverage`, `inAir`, `skeleton`, and `supportEdits` outcomes, in its part frame. Draw them at `offset`. `reused` names the stages the object took from memory.
- The top-level `offset`, `coverage`, `inAir`, `skeleton`, and `supportEdits` are absent. The top-level `mesh.min` and `mesh.max` are the union of every object's box in bed coordinates. `mesh.triangles` is the sum.
- `collisions` lists every pair whose XY boxes in bed coordinates overlap with positive area, in plate order. `overlap` is `[minX, minY, maxX, maxY]`.
- Preview paths gain an `object` column, an index into `objects`. It is omitted when every path is object 0, so a one-object reply keeps its bytes.
- A preview path is in its object's part frame. A travel from one object to another is not drawn.
- G-code is in bed coordinates. `;OBJECT:<id>` starts each object's part tour when the plate has two or more objects. A one-element `objects` writes the same bytes as the omitted form.

### Contract: preview patch

`previewPatch` gains `seconds`, every listed layer's estimator time, aligned with `previewPatch.layers`. A layer whose paths did not change is no longer in `changed`, even when its time did. This applies to single-object replies too, and the old "retimed" patch layers are gone.

The reason is the move rule. On a plate, the travel between two objects changes length when either moves, so the time of almost every layer changes. With times in their own column, a move is a patch with 0 changed layers, new `objects[i].offset` values, and new seconds.

### Design: a plate is N alone-plans and one join

Each object is planned exactly as a single object is planned today, in its own part frame: cut, toolpaths, tour, comb, supports, edits, and `assemble`. The result is that object's joined layers, the same `Vec<JoinedLayer>` a single slice makes. A request without `objects` is a plate of one object. So the one-object byte-identity is structural and not a special case.

The plate join only interleaves what the objects already planned. It does not order or copy paths.

```rust
// gcode.rs: what emit takes
pub(crate) struct PlateLayer { index: usize, z: f64, height: f64, note: String, runs: Vec<Run> }
pub(crate) struct Run {
    object: u16,
    layer: PrintLayer,          // that object's joined layer, shared, with its arc fit
    paths: Range<usize>,        // its head (skirt and supports) or its part
    entry: Entry,
    label: Option<Arc<str>>,    // `;OBJECT:<id>` before a part run on a plate of 2+
}
pub(crate) enum Entry { AsPlanned, Cross { z_hop: f64 } }
```

On each plate layer, the join writes the head run of every object in plate order, then the part run of every object in plate order. This is the order the spec asks for: supports first, then each object's part tour.

A run's entry is `AsPlanned` when the run before it, on this layer or the last printed layer, belongs to the same object. In that case the nozzle stands exactly where the object alone would have left it, so the planned lead-in, retract, and hop hold. Otherwise the entry is `Cross`: a straight travel with a retract. It hops when z-hop is on for the target path, the target is not a scarf ramp, and the travel in bed coordinates is at least `zHopMinTravel`. A cross travel never needs to route around a standing object, because nothing on the plate is taller than the layer being printed.

The join is a pure function of the joined layers and the offsets. It runs on every request and costs `Arc` clones per layer.

### Design: tour start

Each object's part tour starts where that object's own tour on the layer below ended. Layer 0 starts where that object's own skirt ends. This is today's rule for one part. The first object's tour therefore starts where today's single part tour starts.

The spec also says each later object starts where the previous one ended. The nozzle does: the cross travel goes from the previous object's last point to this object's first path. The choice of that first path, the seams, and the order inside the object do not read the previous object's end. Reading it would put `offsetA - offsetB` into B's tour, so every move would re-order, re-comb, and re-fit the arcs of every later object on every layer. That is the cost this work exists to remove.

### Design: emit with one offset per object

`emit_gcode` takes `&[PlateLayer]` and `Frames`, the offset of each object. The single `offset` argument is gone.

- `Writer` and `Carry` gain `frame`, the object whose part frame the X/Y position is in. `Writer::bed` adds that object's offset, and still skips an offset of exactly zero, so a `-0.0` keeps its bytes.
- A `Cross` entry converts the position into the new frame: `x + o_old - o_new`. Same frame means no arithmetic at all.
- Inside an object, lengths, arcs, E, and time are computed in its part frame. They are bit-identical across moves. Only the cross travel changes with a move.
- A run replays the arcs cached on its own `PrintLayer`, starting at its first path. A move never re-fits an arc.
- The layer header, first-layer speed, and fan tiers read the plate layer's index.

### Design: shared layer Z and the adaptive rule

With a fixed layer height, every object plans its own bands as today. Bands start at Z 0 and step by the layer height, so two objects share every band up to the shorter one's top. Only that top band, clipped to the object's own top, differs. The plate merges the objects' bands by `(z, height)` into plate layers. A shorter object's clipped top becomes its own plate layer.

With adaptive layers, the rule is union demand. Every object plans bands to its own top from the facets of every object on the plate, so at each Z the thinnest layer any object needs wins. The bands then agree bit for bit up to each object's top and merge as above.

Each object's contours key hashes its own band list. Under a fixed height that list depends only on the object. Under adaptive layers, a change to any object's mesh can change every object's bands, and those objects are cut again. That is the price of one shared Z.

### Design: the skirt

Today's skirt is not a ring around the plate. `skirt_paths` draws one or two loops one line width out from each island of the first layer's part and supports. It hugs the part like a brim. It stays per object, inside that object's head run, in its part frame. A move never recomputes it.

Two objects closer than the skirt reach, two line widths at most, print skirt loops into each other. The `collisions` box test does not grow by that reach in this step.

### Design: supports across objects

The support code reads `contours` in two roles today: the overhangs that need support, and the solid that trees avoid and land on. `Footing { own, solid }` splits them. Demand reads `own`. The walk, the landing test, `project`, coverage, and edits read `solid`. Alone, `solid` is `own`, so supports are unchanged bit for bit.

Other objects enter only `solid`. Trees of A avoid B and may land on B, as they land on A. B never makes demand for A.

Which objects are solid for A is decided by a closure that starts from A's supports grown alone:

```
S = {}
P = supports of A grown with solid = A's contours        // the alone growth, keyed as today
loop:
    new = { B not in S : on some layer i, box(B, i) moved into A's frame and grown by the margin
                         meets box(P, i) }
    if new is empty: stop
    S = S + new
    P = supports of A grown with solid = A ∪ (every B in S, moved into A's frame)
```

- `box(P, i)` is the XY box of A's supports on layer i: disks with their radius, sparse loops, and interface loops. `box(B, i)` is the box of B's contours on its layer at the same Z.
- The margin is A's support XY gap plus 1 mm.
- `S` only grows, so the loop ends after at most N - 1 regrowths.
- The grown plan is keyed by the alone grow key and the sorted list of (obstacle contours key, shift into A's frame). With `S` empty the key is the alone key.

A cold slice and an incremental one run the same closure on the same inputs, and the cache returns a plan only on key equality, so both write the same G-code. The rule starts from the alone growth, never from the plan held in memory, because a plan that bent around B would hide the bend after B moves away.

The move rule follows. A move of B changes A's supports only when B's old or new footprint, grown by the margin, meets A's alone supports. Otherwise `S` is unchanged and A's supports are taken from memory.

`supportEdits` are per object, in that object's part frame. They replay on whichever plan the closure settled on. A move that keeps `S` reuses the edited plan. A move that changes `S` replays the edits on the new plan, and prunes whose site moved report `stale` as today.

Not in this step: supports of two objects do not avoid each other. Two trees in the gap between objects can overlap. The closure uses the supports before edits, so a regrow edit that reaches toward a far object does not add it to `S`.

### Design: kept stages

Every stage key is computed per object from that object's mesh in its part frame, its band list, its resolved settings, and its blend in its part frame. No key contains an offset, except the grown supports through a non-empty `S`, and a `byRegion` blend through `atMm - offset` as today.

| Stage | Scope | Key |
| --- | --- | --- |
| Contours | object | mesh, nozzle, layer settings, band list |
| Toolpaths, order, comb | object | as today, from the object's settings and blend |
| Supports grown, painted | object | as today, plus the obstacle list when `S` is not empty |
| Supports edited | object | the edit prefix on that entry, as today |
| Joined layers | object | `joins_like` against that object's last join, as today |
| Plate join | plate | not kept, rebuilt per request |
| Preview token | plate | each object's whole key and obstacle list, in plate order, the profile, and each object's edits |

`kept::fit(n)` sizes each shelf to `max(2, n + 1)` entries and the support shelf to `max(3, 2n + 1)`, so a change to B never evicts A. The single `last` join slot becomes one slot per object, found by contours key, plus one shown preview for the plate.

### Design: preview

- `preview_layer` walks the runs of a plate layer. A `Cross` run resets the travel cursor, so no travel between objects is drawn. Each path carries its object index, which is part of path equality and the patch path hash.
- A plate layer is unchanged when it has the same runs: the same object, the same shared `PrintLayer`, the same range, and the same entry kind. A move changes none of these.
- `drawn` hashes every object's contours key and part-frame blend and the flow cap. The client patches only a preview drawn from the same cuts.

The client builds the preview geometry per (object, 32-layer chunk) and draws each object's chunks under a group at that object's offset. A move then updates group matrices and layer times, and uploads no buffer.

### Design: disk cache

The frame key strips `translation[0]` and `translation[1]` from the top-level `pose` and from every `objects[i].pose`. `partFrameKey` in `src/slice-action.ts` does the same. A request whose frame key equals the previous request's and whose disk key differs is a pure move of any number of objects, and is not written to disk. A disk hit still warms the kept stages, which on a plate plans every object.

### What a change recomputes

| Change | Recomputed | Taken from memory |
| --- | --- | --- |
| X/Y move of any object | the support closure's box tests; supports of an object whose `S` changed; plate join; emit; preview diff (0 changed layers) | every object's cut, toolpaths, tour, comb, joined layers, arcs, and supports whose `S` did not change |
| B's blend, scarf, gyroid, infill combine, variable width | B from its first stage whose key changed; plate join; emit | everything of A |
| B's support settings or edits | B's supports and joined layers; plate join; emit | everything of A, and B's part stages |
| B's mesh, rotation, or Z | B in full; A's supports if B is in A's `S`; under adaptive layers, any object whose bands changed | everything else |
| A plate setting | every object from the first stage that reads it | the stages before it |

Progress reports each stage once per object, so the bar runs once for each object.

### Rejected alternatives

- Concatenate the objects into one mesh, as the UI mock does. Every change and move re-slices everything, and overlapping solids fuse.
- Move paths into bed coordinates at the join and keep one offset in emit. Every move then copies every point and re-fits every arc, which is the expensive part of emit.
- Grow one support plan for the whole plate in bed coordinates. Any move regrows every tree.
- Decide obstacles from a fixed envelope, the part's box grown by its height times the branch lean. For a tall part it covers most of the bed, so far moves still regrow.
- Print each object as a block, its supports then its part, before the next object. It is as cheap as the chosen order but departs from the spec's supports-first order.
- Keep layer times inside patch layers. A move would then change almost every layer.

### Tests

`crates/lime-slice-core/tests/plate.rs` checks, with literal values:

- a one-element `objects` writes the same G-code bytes as the omitted form;
- on two objects, layer 0 carries `;OBJECT:a` then `;OBJECT:b`, and `;LAYER:1` comes after both;
- moving B reuses every stage of A and of B, returns a patch with 0 changed layers, and writes the same G-code as a cold slice at the new position;
- changing B's settings re-plans only B;
- A's supports avoid B, and a far move of B keeps A's supports;
- support edits survive moves;
- refused keys and orders return errors that name the field.
