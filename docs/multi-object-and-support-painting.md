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
