# Seam placement and ironing

The UI does not ship a rear / nearest / aligned picker yet. `SliceRequest` has no field for seam placement, and adding one is engine work in `crates/`. Ironing is not implemented. This note is the plan for Claude to review before that work.

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
