# Modifier volumes and height-range settings

This is the plan for changing infill, walls, and speed inside a Z range or inside a box, cylinder, or sphere, without touching the rest of the part. Height ranges and modifier volumes have shipped. See [Shipped](#shipped-2026-10-04) at the end. The sections before Shipped are the plan as it was reviewed, and they describe the engine and the UI before the engine read the overrides.

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
   Amended 2026-10-07: the volume wins on each field it sets, and the range fills the fields the volume leaves empty, then the object's own values. Applying the range only outside every volume meant a volume that set only infill dropped a range's 4 walls back to 2 inside its footprint, so one layer printed two wall counts.
3. `speed` is a cap inside the region. Every feature speed (outer, inner, sparse, solid, top, and the print speed) becomes min(its strategy speed, `speed`). The 3D gyroid speed is a feature speed too, so it takes the same cap. Users set a range speed to slow a fragile or detailed section. A cap never speeds a feature past what the strategy chose.
4. `infill: 0` leaves the region walled with no sparse infill. Solid top and bottom skins stay. Today `plan_region_split` skips its whole infill block when density is 0.01 or less, and that block also draws the solid skins. The guard must let a solid shell through. `walls` must be 1 to 12 in the first version, and 0 is refused. A wall-less region whose infill becomes the shell surprises users and breaks seams and combing. Allowing 0 can come later.
5. Yes. Volumes are axis-aligned with no rotation. A cylinder is always upright on Z.
6. Membership is by the layer's z inside `[from, to]`, inclusive. This holds even when the layer band is thicker than the range.
7. Yes. The range and volume structs use `deny_unknown_fields`. A `layerHeight` key or any typo is refused with the field name.
8. Supports stay global. A volume does not change support settings in the first version.

**Cache.** Overrides are part of the toolpath stage's cache key (see the staged cache from PR #98). Changing them recomputes toolpaths and later stages, not the cut. Only the layers whose resolved overrides changed are planned again, and the tour, combing, and join reuse every other layer they can (see "Kept part layers" in `docs/support-edits.md`). The stage keys hash the whole settings struct, so a new field lands in every stage key by default. The two new fields must be blanked in the contours key, the way `feature_speeds` is, or a change would recut.

**Engine order.** The seam picker comes first, then height ranges and modifier volumes, then ironing, then support paint, then multi-object all-at-once, then sequential.

## Shipped (2026-10-04)

Height ranges and modifier volumes landed as decided above. The UI sends them, and the "stored but not yet sliced" toast is gone.

**Request.** `heightRanges` and `modifierVolumes` sit on `SliceRequest` beside `supportEdits` (`HeightRangeSpec` and `ModifierVolumeSpec` in `crates/lime-slice-core/src/slice/wire.rs`). Both are left out of the serialized request when empty, so a request without them keeps its cache key and its G-code bytes. Both entry types use `deny_unknown_fields`, so `layerHeight` or a typo is refused with an "unknown field" error that names the key. The parser refuses a bad entry with its index and field, for example `heightRanges[0]: walls 0 is outside 1 to 12` or `modifierVolumes[0]: size x 300 is outside 0.2 to 220 mm`. The limits are 64 ranges, 64 volumes, `walls` 1 to 12, `infill` 0 to 1, `speed` above 0 and at most 1000 mm/s, and coordinates within 100000 mm. A volume's X and Y size runs from 0.2 mm to the bed's X and Y. The printer profile has no bed height, so the Z size is bounded like a coordinate.

**Membership.** A range holds a layer whose z lies in `[from, to]`, ends included. A layer's z is a sum of layer heights, so a 0.2 mm layer at 2 mm can sit a hair off 2. The ends therefore hold every layer within 1 µm of them. Without that slack, a range from 2 to 4 missed both end layers. The same slack applies to a volume's Z extent.

**Strategy changes.** A region's strategy is the blend's strategy with the override applied (`Tweak::apply` in `crates/lime-slice-core/src/modifiers.rs`). `walls` replaces the wall count. `speed` caps the print, outer, inner, sparse, solid, top, and 3D gyroid speeds. `infill` replaces the density. A density the user asks for fills the whole region, so lightning becomes grid and the roof pruning of lightning and lines is off. Density is the share of the layer the infill covers, so a grid lays each direction at twice the line spacing. From 99% the infill is solid whatever the pattern: parallel lines one bead apart, turning a quarter each layer, printed as `solid` at the solid speed, with no crossing lines. A stretch only a few beads wide, such as the wall of a cover, prints along its length instead, whole rows of at least 10 mm in the direction of the region's longest edges, because rows across it turn every few millimetres and the head never reaches its feed. Without that, a dense volume deep in a speed-blend part printed no infill at all. `infill: 0` leaves no sparse infill. The infill block in `plan_region_split` now runs for a solid shell at any density, so the region keeps its walls and its top and bottom skins. The existing void fill still gap-fills interior pockets narrower than six bead widths.

**Walls in a volume.** PrusaSlicer slices a modifier mesh as its own region. When its perimeter count differs, each region gets perimeters along the modifier's boundary, so walls appear inside the part along the modifier's edge ([Prusa forum](https://forum.prusa3d.com/forum/prusaslicer/adding-more-perimeters-to-one-location-only-nicely/)). OrcaSlicer descends from the same layer-region code. Lime Slice does not print those walls. Lime Slice applies the wall count to the part's own perimeters inside the volume and clips everything else:

- Each zone plans the part's real outline with its own strategy, through the `plan_region_split` machinery the region blend uses. The base zone plans the whole layer with the range that holds the layer, if any. A volume plans the part within its walls plus two beads of its footprint, so the walls along that clip edge fall outside the footprint.
- Each zone keeps only the beads in its zone. The base zone keeps beads outside every footprint. A volume keeps beads where it is the last footprint to hold them. Beads cut at a footprint edge meet the other zone's beads there. A wall loop the cut opens prints as one open piece through its start, as `keep_side` does for the region plane.
- `pair_sides` chains the zones' runs of each travel group, so a wall cut at a footprint edge continues in the next zone without a travel.

So a volume with `walls: 6` over the edge of a 40 mm box prints 6 wall beads where the part's outline passes through the volume and 4 elsewhere. No wall runs along the volume's edge inside the part. A volume that does not meet the part's outline, or a hole's outline, changes no walls.

**Footprints.** A footprint is the volume's cross-section at the layer's z. A box gives a rectangle, a cylinder gives an ellipse with radii of half its X and Y size, and a sphere gives the ellipse of its slice. Bead clipping is analytic: segments split where they cross the rectangle or the ellipse. The planning region uses a 96-sided polygon of the footprint. The layer note names each volume it prints, as `toughness walls=4 infill=34% grid 83mm/s h=0.250 · volume 0`.

**Frames.** Volume centres arrive in bed millimetres, which is how the UI stores them (`x`, `y`, `z` in `src/overrides.ts`, drawn at `frame.toScene(x, y, z)`). Since #122 the engine slices in the part frame. Each object therefore moves the centres into its part frame by minus its offset, as the region blend moves `atMm`. The result is rounded to 1 µm, so a volume moved by the same X/Y as its part lands on the same bits. That move reuses every stage, and a volume left behind plans the toolpaths again. Z does not move. Volumes and ranges that cannot reach a part's bounds are dropped before its stage keys are taken. A far volume therefore never re-plans a part.

**Plates.** Ranges and volumes are plate-wide. Each object takes every range and every volume that reaches it, in its own part frame. `objects[i].settings.heightRanges` and `objects[i].settings.modifierVolumes` are refused as plate settings. The per-object `infill`, `walls`, and `speed` keys of decision 2 in [multi-object-and-support-painting.md](multi-object-and-support-painting.md) stay refused as "not supported yet". The UI plate has no per-object override yet, and a plate-wide volume already reaches one object by position. A per-object override set would also need its own place in the overlap order.

**Kept stages.** The overrides are in the toolpaths key. They are blanked in the contours key and in the painted-supports key, because supports stay global. A range or volume change reuses `contours`, `supports`, and `supportPaths`, and plans toolpaths, order, and comb again for every layer.

**UI.** `payload()` sends `sliceOverrideFields(state.overrides)`. Each list is left out when empty. A range is `{ z: [low, high], infill?, walls?, speed? }`, and a volume is `{ kind, center, size, infill?, walls?, speed? }`. The overrides are part of the settings hash, so an edit marks the slice stale and auto-slice picks it up. The walls inputs run from 1 to 12. A project saved with walls outside that range opens with the value clamped. Speed is capped at 1000 mm/s.

**Evidence.** A 40 × 40 × 10 mm box at weight 0.6 has grid infill at 34% and 4 walls. A box volume over its left edge, `center [80, 100, 5]`, `size [20, 20, 20]`, `walls: 6`, and `infill: 1`, gives these G-code numbers on the layer at Z 5. The infill is sparse without the volume and solid inside it:

| Measure | No volume | Volume |
| --- | --- | --- |
| Wall beads crossing y = 100 in the volume | 4 | 6 |
| Wall beads crossing y = 85, outside it | 4 | 4 |
| Infill mm per mm² inside the footprint (x 80 to 90, y 90 to 110) | 0.681 | 1.672 |
| Infill mm per mm² away from it (x 95 to 115, y 85 to 115) | 0.767 | 0.767 |

**Measured cost.** These times were measured through `serve --cache-dir` on this laptop, client side, with a speed blend, tree supports, the G-code parked, and the default 220 mm bed. Each change sends `previewBase` and differs from every earlier request, so none hits the disk. Each cold slice ran on a fresh server. There were two runs. The range spans the middle half of the part's height with `walls` 4, 5, then 6 and `speed: 40`. The three volumes are a box with infill 0.8, 0.9, then 1, a cylinder with 4 walls, and a sphere with a 30 mm/s cap.

| Mesh | Cold | Range change | Volume change | Cold with 3 volumes |
| --- | --- | --- | --- | --- |
| Baby Dragon | 4.09 to 4.31 s | 2.66 to 2.78 s, 66 or 67 changed layers | 2.49 to 2.91 s, 53 to 120 changed layers | 4.38 to 4.45 s, volumes on 120 of 133 layers |
| Rear cover | 5.15 to 5.34 s | 2.17 to 2.43 s, 106 or 120 changed layers | 2.69 to 3.47 s, 80 to 157 changed layers | 5.21 to 5.32 s, volumes on 150 of 208 layers |

An override change costs 40 to 70% of a cold slice. The toolpaths key covers the whole part, so every layer is planned, ordered, and combed again, even a layer no range or volume reaches. By the run means, three volumes add about 6% to a cold slice of the Baby Dragon and about 1% to the rear cover.

**Golden.** `tools/golden_ab.sh e7624fe` with the rear cover and the boots gives 60 same, 0 different against the stored seam-picker run.

**Tests.** `crates/lime-slice-core/tests/modifiers.rs` checks, with literal values:

- empty lists, and entries out of the part's reach, keep the G-code bytes;
- a range with `walls: 4` gives 4 walls on its layers and 2 elsewhere, including both end layers at 0.2 mm;
- `infill: 0` keeps the walls and the solid skins and drops every sparse layer;
- a dense box changes infill only inside its footprint;
- walls in a volume follow the part's outline;
- a speed cap applies inside its volume only;
- the later volume wins, and a range applies outside every volume;
- a volume that sets only infill keeps its range's walls;
- refusals name their field;
- a plate-wide volume reaches only the object it meets, in bed coordinates.

`tests/modifier_stages.rs` checks that a volume moved with its part reuses every stage, that a volume left behind plans the toolpaths again, and that an override change never cuts again, with kept and cold G-code equal. `e2e/overrides-engine.spec.ts` adds a range in the UI, slices on a real engine, and reads its walls and speed cap from the reply and the G-code.

**Not done.**

- Per-layer toolpath reuse. A change that touches 10 layers still plans all of them.
- Per-object `infill`, `walls`, and `speed`, as above.
- Rotated volumes, mesh modifiers, per-range layer height, and support overrides, as in the non-goals.
- Where a volume cuts the outer wall, the wall prints as open pieces that start at the cut. The planned seam on that loop is lost on those layers.
