# Seam placement and ironing

The seam picker has shipped. See [Shipped](#shipped-2026-10-04) at the end. Ironing is not implemented. The sections before Shipped are the plan as it was reviewed, and they describe the engine before the picker.

The 2026-10-03 roadmap decision stands: a rear, nearest, and aligned picker is enough before seam painting, and ironing comes before fuzzy skin.

## What the engine does today

Seam placement is `SeamMode` on the resolved strategy, not a request field (`crates/lime-slice-core/src/strategy.rs`).

- **Nearest.** The loop starts near the previous extrusion. Speed uses this.
- **Aligned.** The seam stacks on one side: the sharpest real corner, ties toward +X, or the +X vertex when the loop has no corner. Toughness uses this.

A weight mix follows the resolved strategy. The user cannot ask for rear, or force nearest on a toughness blend, without a new field.

Scarf is a different control and it already has a request field: `scarfSeam` is `blend`, `off`, `outer`, or `all`. That changes the joint from a butt seam to a scarf. It does not choose rear, nearest, or aligned. The picker must not be wired through `scarfSeam`.

There is no ironing pass. Top surfaces are the normal skins. There is no fuzzy skin either. Painting a seam is the later step in [multi-object-and-support-painting.md](multi-object-and-support-painting.md).

## Decisions

- Three choices are enough: rear, nearest, aligned. No painting in this step.
- Omitted means today's behavior. A request without the field keeps the strategy's seam, and the G-code stays byte-identical to a slice from before the field existed.
- The field is a placement. Scarf stays the joint shape it is now.
- Ironing is a second pass on top skins, after the picker exists, and before fuzzy skin. Fuzzy skin is not part of this note's first engine change.
- Compact only has to keep the prepare canvas at or above 70% when the settings sheet is at the peek. The control is a select in the existing settings panel.

## Wire

**Request.** Add `seam` on `SliceRequest`, camelCase in JSON, next to `scarfSeam`.

- Absent, or `"blend"`: the strategy chooses, as it does now. Absent is what old clients send, so the cache key of a request that does not set it must not change. Prefer `skip_serializing_if` for the default, the same way empty `supportEdits` are omitted.
- `"nearest"`: `SeamMode::Nearest` on every wall the strategy would seam, including a toughness blend.
- `"aligned"`: `SeamMode::Aligned`, including a speed blend.
- `"rear"`: a third placement. It does not exist yet. See the questions.

Anything else is refused, the way a bad `scarfSeam` is refused, with the field name in the error.

**Response.** No new preview channel. The seam shows up as the start of the wall paths that already exist. Do not add a painted-seam mask here.

**UI.** One select, default Blend (strategy). It is omitted from the slice body while it is Blend, so a default slice matches today's bytes. Nearest, aligned, and rear are sent as `seam`. This UI waits on the engine field. It is not in this doc's pull request.

## Ironing

Not in the first engine change. When it is, it is a pass over the top skins of the part, not over supports.

- Off by default. Omitted from the request, so a slice that does not iron matches today's G-code.
- On: after the top skin is planned, a second set of extrusions on those skins, inset from the outer wall, at its own flow and speed.
- It does not change the wall count, the seam placement, or the layer height.
- Fuzzy skin, if it comes later, runs on the walls and must not be the same pass.

## Questions for Claude

1. Is `seam` the right request name, omitted when it is the strategy default, so a request that does not set it keeps its cache key and its G-code bytes?
2. Rear: which direction in the bed frame, where the bed runs from `(0, 0)` to `(bedX, bedY)`? Is rear maximum Y, minimum Y, or the side farthest from the origin along the longer bed axis?
3. Aligned today is "sharpest corner, else +X", not "a straight line on +X" for every loop. Should the picker's Aligned keep that, and should Rear use the same corner rule with the tie toward the rear, or a fixed rear point even on a cornered loop?
4. Does the override apply to outer walls only, or to every closed loop the strategy seams, including inner walls?
5. A sharp convex corner currently keeps the corner and refuses a scarf. Does Rear still lose to that corner, or does Rear win?
6. Ironing: top skins of the part only, or also the top of a support interface? What flow, speed, line spacing, and inset should the first version use, and does ironing add time to the existing estimate or only to the G-code?
7. Should ironing be one boolean, or flow and speed on the request from the start? Omitted must stay byte-identical either way.

## Decisions (review, 2026-10-03)

1. Yes, `seam` is the name. It is omitted when it is `blend`, through `skip_serializing_if`. A request without it keeps its cache key and its G-code bytes. Golden checks that.
2. Rear means maximum Y in the bed frame. That is the back of the bed, as in PrusaSlicer and OrcaSlicer.
3. Aligned keeps today's rule. It takes the sharpest real corner and breaks ties toward +X. Rear uses the same corner rule, restricted to vertices within 1 mm of the loop's maximum Y. If no corner is in that band, Rear uses the rear-most vertex and breaks ties toward +X. This hides the seam in a corner when a corner sits at the back, and it stays stable from layer to layer.
4. The override has the same scope as today's `SeamMode`. It applies to every closed loop the strategy seams, so inner walls follow the outer wall. Today an inner wall is planned with the mode but then gets `Seam::Nearest` in the tour, so it does not follow. An explicit `seam` must set the inner wall's seam kind to match the outer wall. With `blend`, inner walls stay as they are, so the default bytes do not move.
5. The scarf refusal at a sharp convex corner is about joint geometry, not placement. It stays. Rear picks the start point. If that point is a sharp convex corner, the joint is a butt joint there, as today.
6. Ironing covers the part's top skins only, not support interface. It is off by default. The first version uses a flow of 10% of a normal top line, a speed of 20 mm/s, a line spacing of 0.1 mm, and an inset of half a line width from the outer wall. Ironing is real G-code, so the estimate counts it automatically. The estimate comes from the same emit scan as the G-code.
7. Ironing is one optional object, `"ironing": {"flow": 0.1, "speed": 20, "spacing": 0.1}`. Every key is optional and defaults to those values. `{}` turns ironing on with the defaults. Omitted means off, and the G-code stays byte-identical. Unknown keys are refused.

**Implementation order.** The seam picker comes first. Ironing comes second. Fuzzy skin comes later and separately. The engine order across the design notes is the seam picker, then height ranges and modifier volumes, then ironing, then support paint, then multi-object all-at-once, then sequential.

## Shipped (2026-10-04)

The seam picker landed as decided above. Ironing did not.

**Request.** `seam` sits on `SliceRequest` beside `scarfSeam`. It takes `blend`, `nearest`, `aligned`, or `rear`. `blend` is the default and is left out of the serialized request, so a request without it keeps its cache key and its G-code bytes. Any other value is refused with `seam "left" is not a seam placement; send blend, nearest, aligned, or rear`. The CLI takes `--seam`. The G-code header line `; features:` ends in `; seam rear` (or the other value) only when the seam is explicit. `classic` forces `blend`.

**Placement.** `nearest` and `aligned` replace the strategy's `SeamMode` on every wall it seams, with today's rules. `rear` is `SeamMode::Rear`. It takes the sharpest real corner within 1 mm of the loop's maximum Y, ties toward +X. If no corner is in that band, it takes the rear-most vertex, ties toward +X. Under an explicit seam, inner walls keep their planned start (`Seam::Fixed`, or `Seam::Corner` for `nearest`) instead of the vertex nearest the nozzle. Under `blend`, inner walls stay as they were. The scarf refusal at a sharp convex corner is unchanged.

**Part frame.** The part frame applies the pose's rotation before the cut, and the X/Y offset is added only at emit. Max Y in the part frame is therefore max Y on the bed, and a move with `rear` set reuses every stage (`tests/part_frame.rs`).

**Plates.** `seam` is a plate setting, because decision 2 of [multi-object-and-support-painting.md](multi-object-and-support-painting.md) does not list it per object. A plate request passes it to every object. `objects[i].settings.seam` is refused as a plate setting.

**Kept stages.** `seam` is in the toolpaths key. It is blanked in the contours key and in the painted-supports key, because support paths are never loops and never read a seam. A seam change reuses `contours`, `supports`, and `supportPaths`, and plans toolpaths, order, and comb again.

**UI.** One select, Seam position, sits beside Scarf seam in Strength at the advanced level. Its options are Blend (strategy), Nearest, Aligned, and Rear. Blend is left out of the slice body. Presets, settings profiles, and project files store `seam`. A profile or project file written before `seam` existed opens at Blend, through `readPresetSettings` in `src/presets.ts`.

**Measured cost.** These times were measured through `serve --cache-dir` on this laptop, client side, with a speed blend, tree supports, the G-code parked, and a 450 mm bed. Each change sends `previewBase`. There were two runs with a fresh server each time.

| Mesh | Cold | Seam change (rear, aligned, nearest) | Back to a stored seam |
| --- | --- | --- | --- |
| Baby Dragon | 3.95 to 3.98 s | 2.47 to 2.64 s, 133 changed layers | 0.34 to 0.45 s, disk hit |
| Rear cover | 4.85 to 5.07 s | 3.15 to 3.52 s, 208 changed layers | 0.79 to 0.87 s, disk hit |

With `rear`, every closed outer loop starts within 1 mm of its back: 4825 of 4825 on the Baby Dragon and 1089 of 1089 on the rear cover. Under `blend`, the counts are 1604 of 4825 and 352 of 1089. Overhang control splits some outer walls into open pieces at the overhang's edge. Those pieces start at the split, as they do under `aligned`.

**Ironing still needs** the following:

- The request object `ironing` with optional `flow`, `speed`, and `spacing`. Unknown keys are refused, and an omitted object stays byte-identical.
- A pass over the part's top skins, after the top skin is planned. Use 10% flow, 20 mm/s, 0.1 mm spacing, and an inset of half a line width from the outer wall.
- A place in the toolpaths key, a UI control, and a golden run that shows the omitted request is unchanged.
