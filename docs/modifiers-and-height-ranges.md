# Modifier volumes and height-range settings

This is the plan for changing infill, walls, and speed inside a Z range or inside a box, cylinder, or sphere, without touching the rest of the part. The engine does not accept those overrides yet. This note is for Claude to review before any `crates/` change. The UI that stores and draws them is a separate pull request and sends nothing new on the slice request.

## Goals

- A user can add and remove height ranges by Z from and Z to, each with its own infill, wall count, and speed.
- A user can add a box, a cylinder, or a sphere on the bed, move and scale it, and give that volume the same small override set.
- Ranges show as bands on the layer slider and as translucent slabs in the viewport. Volumes show as translucent shapes.
- The lists live in the `.lime` project as an optional versioned field, and in undo and redo.
- With no ranges and no volumes, the slice request, the cache key, and the G-code are the bytes of a slice today.

## Non-goals

- No mesh modifier, no painted region, and no second object. A volume is a primitive, not a loaded STL.
- No per-range layer height in the first engine change. `SliceRequest.layer_height` is one number for the whole slice, and adaptive bands are planned from that one height (`crates/lime-slice-core/src/slice.rs`, `crates/lime-slice-core/src/adaptive`). A range that changed layer height would rebuild the bands, not just the toolpath inside them.
- No flow, temperature, or retraction override. Those towers are deferred in [roadmap.md](roadmap.md).
- No ironing, fuzzy skin, or seam placement inside a volume. Seam placement is [seam-and-ironing.md](seam-and-ironing.md).
- The existing by-layer blend and by-region plane stay what they are. They are not the editor in this note.

## Current state

`SliceRequest` (`crates/lime-slice-core/src/slice.rs`) is one global setting list. It has `layerHeight`, `lineWidth`, `blend`, `printer`, support knobs, scarf, z-hop, pose, and `supportEdits`. It has no `heightRanges`, no `modifierVolumes`, and no per-region infill, walls, or speed.

The only spatial splits are on `BlendMode` (`crates/lime-slice-core/src/strategy.rs`):

- `ByLayer { bottomMm, transitionMm }` is one band from the bed, toughness below, then a linear mix into speed. The UI sends it as `blend.mode = "byLayer"` (`src/app/settings.ts`). The layer slider paints that one band in `#layerBand` (`src/app/viewer.ts`).
- `ByRegion { axis, atMm }` cuts every layer with one plane. The low side is toughness and the high side is speed (`plan_region_split` in `crates/lime-slice-core/src/slice.rs`). It is not a box, a cylinder, or a stack of shapes.

`ResolvedStrategy` (`crates/lime-slice-core/src/strategy.rs`) does carry `walls`, `infill_density`, and `print_speed`, plus the per-feature speeds. Those numbers come from the speed or toughness preset, or from a weight mix. They are not fields on `SliceRequest`, so a client cannot ask for "four walls from Z 0 to Z 4" or "dense infill inside this box".

`supportEdits` is the pattern for an optional list: `#[serde(default, skip_serializing_if = "Vec::is_empty")]` on the request, and the disk cache hashes the exact request (`crates/lime-slice-core/src/slice_cache.rs`). `SupportEditSpec` uses `deny_unknown_fields` (`crates/lime-slice-core/src/slice/wire.rs`). `SliceRequest` itself does not. Serde drops unknown fields on it. A client that sent `heightRanges` today would not get an error, and the planner would ignore them. That is not a reason to send them. The UI cache key is the request body (`recipeKey` in `src/slice-action.ts`), so an extra field would still look like a different slice.

`.lime` version 1 (`src/project.ts`, `PROJECT_VERSION`) stores mesh, placement, settings, preset, profile, level, and `supportEdits`. `migrations` is empty. There is no overrides field.

## Proposed request shape

Camel case, next to `supportEdits`. Both arrays are omitted when empty, the same way empty `supportEdits` are omitted, so a request with neither list keeps today's cache key.

```json
{
  "heightRanges": [
    { "z": [0, 4], "infill": 0.4, "walls": 4, "speed": 40 }
  ],
  "modifierVolumes": [
    { "kind": "box", "center": [110, 110, 10], "size": [20, 20, 20], "infill": 0.8, "walls": 3 }
  ]
}
```

- `heightRanges[].z` is `[from, to]` in millimetres, low then high, in the same print Z as layer `z`. A range applies on a layer whose `z` is inside, including the endpoints.
- `modifierVolumes[].kind` is `"box"`, `"cylinder"`, or `"sphere"`.
- `center` is `[x, y, z]` in print millimetres. The bed origin is `(0, 0, 0)`. Scene code maps print `(x, y, z)` to `(x, z, -y)` (`prepareFrame` in `src/cut-plane.ts`).
- `size` is the full extent in millimetres, `[sx, sy, sz]`. A box is that axis-aligned box. A cylinder stands on Z with elliptical radii `sx / 2` and `sy / 2` and height `sz`. A sphere is the ellipsoid of those diameters. Rotation is not in the first shape.
- An override key that is absent means "use the strategy". `infill` is a fraction from 0 to 1 (`ResolvedStrategy.infill_density`). `walls` is a count (`ResolvedStrategy.walls`). `speed` is millimetres per second and replaces the outer and print speed inside the region; the other feature speeds stay unless a later question says otherwise.
- `layerHeight` is not a key. See non-goals.
- Overlap. A point inside a volume uses that volume. Two volumes: the later one in the array wins. A height range applies only where no volume does. Two ranges: the later one wins. Outside both, the blend is unchanged.
- Limits, in the style of support edits: 64 ranges, 64 volumes, every number finite, extents from 0.2 mm to the bed, centers within 100000 mm. A bad entry is refused with the field name, as in `heightRanges[0]: z runs low to high`.
- The response does not grow a new channel. The existing preview paths are whatever the planner emitted. The UI draws the bands and the volumes itself, from the document it stored, not from the reply.

## Mock versus engine work

**UI, this stretch.** Store the document, edit it, draw it, undo it, and save it. Do not add `heightRanges` or `modifierVolumes` to the body built in `payload()` (`src/app/slice-run.ts`). An adapter returns no fields. When the document is non-empty, a toast says the overrides are stored but not yet sliced. Layer height is not in the editor, because the engine does not allow it.

**Engine, later, in `crates/`.** Parse the two arrays, omit them when empty, and plan walls, infill, and speed inside the winning region. The part outside stays the blend that was requested. Supports, scarf, and the seam mode stay global until a later note. G-code emit still walks the whole print. No `deny_unknown_fields` on `SliceRequest` as a drive-by. Add it only if the new structs need it, the way `SupportEditSpec` does.

## G-code byte-identical when there are no modifiers

A slice with both arrays omitted must match a slice from before the fields existed.

- Serde: `skip_serializing_if` empty, same as `supportEdits` on `SliceRequest`.
- The disk cache hashes the serialized request (`crates/lime-slice-core/src/slice_cache.rs`). An omitted field is not in that hash.
- The UI recipe key drops only the keys it already skips (`src/slice-action.ts`). It must not start sending the new arrays while they are empty, and it must not send them at all until the engine reads them.
- Check with `tools/golden_ab.sh` on a part that has no ranges and no volumes. The G-code bytes match the current tree.
- A `.lime` file with no overrides omits the field, so a version 1 file written today still opens, and a save of a project that never added a range or a volume does not grow a new key.

## Questions for Claude

1. Are `heightRanges` and `modifierVolumes` the right names, both omitted when empty, so a request that sets neither keeps its cache key and its G-code bytes?
2. Overlap: later volume wins, and a height range applies only outside every volume. Is that the rule, or should a range always win on its Z even inside a volume?
3. `speed`: does it replace only `print_speed` and `outer_speed`, or every feature speed inside the region (`inner`, `sparse`, `solid`, `top`)?
4. `infill` at 0: is the region empty of sparse infill but still walled, and does `walls: 0` mean no perimeters, which can leave the infill as the shell?
5. Cylinder and sphere: is an axis-aligned ellipsoid enough, with no rotation in the first request, and is cylinder always upright on Z?
6. A range that covers part of a layer: the layer `z` is one number. Is membership "the layer z is inside `[from, to]`", even when the band is thicker than the range?
7. Should the first engine change refuse a `layerHeight` key on a range, so a later per-band height cannot sneak in as an ignored field?
8. Do supports that pass through a volume keep the global support settings, or does a volume also override support density? This note leaves supports global.

## Decisions (review, 2026-10-03)

1. Yes, `heightRanges` and `modifierVolumes` are the names. Both are omitted when empty.
2. The later volume wins. A height range applies only outside every volume, so the more specific region wins. Between overlapping ranges, the later one wins.
3. `speed` is a cap inside the region. Every feature speed (outer, inner, sparse, solid, top, and the print speed) becomes min(its strategy speed, `speed`). The 3D gyroid speed is a feature speed too, so it takes the same cap. Users set a range speed to slow a fragile or detailed section. A cap never speeds a feature past what the strategy chose.
4. `infill: 0` leaves the region walled with no sparse infill. Solid top and bottom skins stay. Today `plan_region_split` skips its whole infill block when density is 0.01 or less, and that block also draws the solid skins. The guard must let a solid shell through. `walls` must be 1 to 12 in the first version, and 0 is refused. A wall-less region whose infill becomes the shell surprises users and breaks seams and combing. Allowing 0 can come later.
5. Yes. Volumes are axis-aligned with no rotation. A cylinder is always upright on Z.
6. Membership is by the layer's z inside `[from, to]`, inclusive. This holds even when the layer band is thicker than the range.
7. Yes. The range and volume structs use `deny_unknown_fields`. A `layerHeight` key or any typo is refused with the field name.
8. Supports stay global. A volume does not change support settings in the first version.

**Cache.** Overrides are part of the toolpath stage's cache key (see the staged cache from PR #98). Changing them recomputes toolpaths and later stages, not the cut. The stage keys hash the whole settings struct, so a new field lands in every stage key by default. The two new fields must be blanked in the contours key, the way `feature_speeds` is, or a change would recut.

**Engine order.** The seam picker comes first, then height ranges and modifier volumes, then ironing, then support paint, then multi-object all-at-once, then sequential.
