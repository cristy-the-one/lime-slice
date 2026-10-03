# Part frame and bed offset

Moving a part in X or Y on the bed does not re-slice it. The engine slices the part in its own frame and adds the bed offset only when it writes the G-code. A move costs one emit and a cache hit.

The same split is the basis for multi-object plates. Each object is sliced in its own part frame and placed on the bed by its own offset.

## Contract

### Request

The request does not change. It still sends one `pose`:

```json
"pose": { "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [px, py, pz], "translation": [tx, ty, tz] }
```

`placed = rotation * (v - pivot) + translation`. The engine splits the pose in two:

- The **part frame** keeps `rotation`, `pivot`, and the Z translation. It puts the pivot over the bed centre, `(bedX / 2, bedY / 2)`, from the request's printer.
- The **offset** is the rest of the X/Y translation: `[tx - bedX / 2, ty - bedY / 2]`.

Bed coordinates are part-frame coordinates plus the offset. Only X and Y move. Z is part of the slice.

The part frame does not depend on `translation[0..2]`, so a move leaves every slice input unchanged. The app centres a part on the bed by default, so a centred part has an offset near `[0, 0]` and its reply frame is the bed frame.

A request without `pose` is already in print space. That is the CLI's default placement. Its part frame is the bed frame and the reply has no `offset`.

### Response

The reply gains `offset: [x, y]` in millimetres whenever the request had a `pose`. The geometry in the reply is in the part frame, which this note also calls the reply frame:

- `layers` paths and `previewPatch`;
- `coverage` gaps;
- the support `skeleton`;
- `inAir`;
- the gaps in `supportEdits` outcomes;
- `mesh.min` and `mesh.max`.

The client draws at reply coordinates plus `offset`. A GPU matrix on the preview group does this without touching the buffers.

Two fields are in bed coordinates, because they describe the G-code:

- `gcode`, and the parked G-code text;
- `sanity.minX`, `maxX`, `minY`, `maxY`.

### Support edits

Support-edit sites and regrow regions arrive in the reply frame and the engine uses them as they are. The client copies them from the skeleton and the gaps, which are in the same frame. A support edit made before a move still applies after it.

### Client

The UI draws the preview group, the support overlay, the section rig, and the region plane at `offset` through a group matrix, and subtracts it from picking rays (`src/bed-offset.ts`, `setBedOffset` in `src/view3d.ts`). Four places in `src/app/viewer.ts` compare reply coordinates with bed coordinates and convert between them:

- G-code line matching adds the reply's `offset` to the preview point, because the G-code is in bed coordinates.
- The region split `state.atMm` is a bed coordinate. The 2D and 3D planes draw it at `atMm` minus the shown offset, and a drag adds the offset back before it commits.
- The split notice compares `atMm` with the reply bounds plus the shown offset.

### Preview token

`previewToken` does not include the offset. After an X/Y-only change, a request that names the previous token gets a `previewPatch` with no changed layers and the new `offset`. Only the G-code emit runs again.

The app sends that request by itself 200 ms after the move ends, whether auto-slice is on or off, and does the same for a recipe the engine already stores (`quietRefresh` in `src/slice-action.ts`). Export stays off until the reply lands. This holds after a result loaded from the disk cache too. After a cache hit, the engine plans the same request again in the background, so the kept stages and the shown preview match the loaded reply. A move that arrives before that plan finishes supersedes it and plans in full, reusing the stages the background plan already finished.

## Where the engine reads absolute X/Y

Each stage below was checked for a dependence on where the part sits on the bed.

| Input | Finding | Handling |
| --- | --- | --- |
| Region blend (`"mode": "byRegion"`, `atMm`) | The split plane is a bed coordinate. It is the one slice input that really reads absolute X/Y. | The engine moves the plane into the part frame, `atMm - offset[axis]`, before planning. A move that carries the plane with the part reuses every stage. A move that leaves the plane behind changes the split, and the toolpaths are sliced again. The G-code header and the reply's `blend` still name the requested plane. |
| Tour start on layer 0 | The tour starts where a skirt around the part alone would end. The skirt seam starts nearest the frame origin. | The engine evaluates this in the part frame. It does not depend on the offset. |
| Printer start position | The preamble homes with `G28` and the first move goes straight to the first point. No purge line, no fixed start point, and the estimator does not time that first travel. | Nothing to change. |
| Combing | Combing routes inside the part's own outlines. It never reads the bed bounds. | Nothing to change. |
| Seam ties | Ties break toward +X. That is the same in every translated frame. | Nothing to change. |
| Bed-size check | The engine has no bed-bounds check. The bed size appears only in a G-code comment. The app's `offBed` warning runs on the placed bounds in bed coordinates. | Nothing to change. |
| Support demand | Supports grow down to Z = 0. Nothing reads the bed's X/Y edges. | Nothing to change. |
| Adaptive layers | Layer heights come from Z slopes only. | Nothing to change. |
| Infill and gyroid phase, Hilbert order, nearest-to-origin defaults | These anchor at the frame origin, `[0, 0]`. | The engine evaluates them in the part frame. Moving a part no longer shifts its infill pattern relative to the part. |
| Clipper's integer grid | Coordinates round to a fixed grid, so the same outline at a different position can round differently. | The engine cuts in the part frame, so a moved part rounds exactly as before the move. |
| G-code coordinates | Absolute by definition. | Emit adds the offset to every X and Y it writes. Distances, arcs, I/J, E, and the estimate are computed in the part frame, so they are bit-identical across moves. An offset of exactly zero is not added, so a pose-free slice writes the same bytes as before. |

## Stage keys

The kept slices (`crates/lime-slice-core/src/slice/kept.rs`) key each stage on what it reads. The engine computes every key from the part-frame mesh and from settings with no `pose`, so no stage key contains the offset.

| Stage | Key | Reads the offset |
| --- | --- | --- |
| Contours | mesh, nozzle, layer settings | no |
| Toolpaths | contours inputs, blend in the part frame | no |
| Order | toolpath inputs, travel and scarf settings | no |
| Comb | order inputs, combing and z-hop | no |
| Supports grown | contours inputs, blend in the part frame, support settings | no |
| Supports painted | toolpath inputs, blend in the part frame, support settings | no |
| Whole plan and `previewToken` | everything but edits, preview base, and job | no |
| Emit | every layer, printer, emit settings, offset | yes |

The disk cache in `serve --cache-dir` still keys on the whole request body, less `previewBase`. A move misses it and then hits the kept slices. The engine stores a reply it sent as a `previewPatch` with its whole preview, so returning to a tweaked recipe later loads it from the disk. A request that differs from the one before it only in the pose's X/Y translation is not stored: a few nudges while arranging a part would push the recipes a user switches between off the disk, and the kept plan re-emits a move in a fraction of a second. The app mirrors this rule (`storesReply` in `src/slice-action.ts`), so it does not label a moved recipe as stored.

## Multi-object plates

A plate is a list of objects, each with its own `pose` (see `docs/multi-object-and-support-painting.md`). The engine splits each pose the same way:

- Each object is cut, filled, and toured in its own part frame, with its own stage keys. Moving one object leaves every object's stages in memory.
- Each object has its own `offset`. The reply carries one per object, beside each object's `min` and `max`.
- Emit writes each object's paths plus its own offset.

Some plate stages read more than one object. They key on the offsets of the objects they read:

- the travel between objects on a layer, and the object order;
- supports that must avoid, or may land on, another object;
- combing across the gap between two objects;
- sequential printing's clearance check.

Those stages run in bed coordinates, from each object's part-frame result plus its offset. A move then re-runs only them and the emit.

## Measured cost of a move

Measured through `serve` on this laptop, with the app's settings: speed blend, tree supports, and the G-code parked. Each move is an X/Y-only change with `previewBase` set.

| Part | Cold slice | Move, before | Move, after | Reused after |
| --- | --- | --- | --- | --- |
| Baby Dragon, tree supports | 6.7 s | 6.4 to 7.2 s | 0.15 to 0.16 s | every stage, 133 of 133 layers, 0 changed preview layers |
| Rear cover, tree supports | 8.0 s | 6.7 to 8.1 s | 0.14 to 0.19 s | every stage, 208 of 208 layers, 0 changed preview layers |

A centred part has an offset of exactly `[0, 0]` in the app, and its G-code is byte-identical to the engine before this change. A part moved by `(20, 10)` writes the centred G-code with every X/Y shifted by `(20, 10)`. The largest difference from an exact shift is 0.001 mm, in the last printed digit, and E, the time, and the filament are identical. Before this change the same move re-sliced with the infill and support patterns anchored at the bed origin, so the estimate moved too: the rear cover went from 38067 s to 38134 s.

## Tests

`crates/lime-slice-core/tests/part_frame.rs` checks, with literal values:

- a move by `(dx, dy)` reuses every stage up to emit, joins every layer from the kept slice, and returns a patch with no changed layers and the new `offset`;
- the kept slice's G-code equals a cold slice at the new pose;
- every G-code X/Y equals the unmoved G-code plus `(dx, dy)` within 0.0015 mm, and E and the estimate are identical;
- a support edit made before the move reports `applied` after it;
- a region plane moved with the part reuses every stage, and a plane left behind does not.
