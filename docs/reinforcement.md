# Reinforcement

Paint a patch on a part, or place a box or a cylinder, and that portion prints denser infill than the rest, up to solid. The rest of the part keeps the strategy, including a hollow part at 0%. A slice with no reinforcement omits the field and keeps today's G-code bytes.

## Goals

- A brush on the prepare mesh, the same gesture as support paint.
- Each painted region has its own density, from the strategy's infill ("normal") up to 100%.
- The reinforced solid extends a depth inward from the painted surface along the outward normal. The default depth is 5 mm. Fill through keeps going until the column leaves the mesh, so the enclosed volume under the painted patch is filled.
- A box or a cylinder is a region too, with the same per-region density.
- The list is on the object in the `.lime` project, and undo stores it the way it stores paint.
- It applies on every infill pattern, at 0% infill, on a belt, and with adaptive layers.

## Non-goals

- No wall count, speed, flow, or temperature change. Modifier volumes already cover walls and speed (`docs/modifiers-and-height-ranges.md`).
- No sphere, and no mesh modifier. A volume is a box or a cylinder.
- No support-density change. Supports stay global.
- Top and bottom skins, seams, fuzzy skin, and ironing are unchanged.
- A region never prints less infill than the strategy gave that layer.

## Current state

`supportPaint` is an ordered list of disks `{ kind, p, n, r }` in the object's source frame (`src/support-paint.ts`). The slice sends them in the mesh frame. The engine moves them with the pose into the part frame, and on a belt `prepare_belt` then applies `Frame::pose` (`crates/lime-slice-core/src/slice.rs`). A disk is a ball. Support demand uses the circle where that ball meets the layer band (`crates/lime-slice-core/src/support/paint.rs`). The normal is stored and is not used to place the demand.

`heightRanges` and `modifierVolumes` replace infill, walls, or a speed cap inside a Z span or an axis-aligned box, cylinder, or sphere (`Tweak::apply` in `crates/lime-slice-core/src/modifiers.rs`). They are plate-wide, in bed millimetres. A volume wins over a range on each field it sets. The planner clips beads to the footprint and does not print a wall along the volume's edge (`plan_object_layer` in `crates/lime-slice-core/src/slice.rs`). Density the user asks for fills the region: lightning becomes grid, roof pruning turns off, and from 99% the infill is solid (`SOLID_DENSITY` in `crates/lime-slice-core/src/toolpath.rs`). `infill_density <= 0.01` skips the sparse-infill block, so a hollow part has walls and skins and no interior beads.

Neither of those is a painted column of denser infill. A modifier box can already be set to `infill: 1`, but it does not follow a brush stroke, it does not stop at a depth under the surface, and it is not stored on the object.

Undo captures the plate (`snapPlate` in `capture` in `src/app/history.ts`). Paint rides along because it is on the object. A one-object project with paint is version 2 and omits the field when the list is empty (`src/project.ts`).

## Request

`reinforcement` sits on the object, next to `supportPaint`. It is omitted when empty. A one-object request with no `objects` array carries it at the top level and omits it when empty. A top-level `reinforcement` beside `objects` is refused, as `seamPaint` is.

```json
"reinforcement": [
  {
    "kind": "paint",
    "density": 1,
    "depthMm": 5,
    "fillThrough": false,
    "disks": [{ "p": [0, 0, 10], "n": [0, 0, 1], "r": 3 }]
  },
  {
    "kind": "box",
    "density": 0.8,
    "center": [10, 12, 4],
    "size": [8, 8, 6]
  }
]
```

- `kind` is `"paint"`, `"box"`, or `"cylinder"`.
- `density` is a fraction from 0 to 1. On a layer the region prints `max(strategy.infill_density, density)`. When that does not exceed the layer's strategy, the region adds no footprint, so a region left at normal infill does not move a seam or a bead.
- Paint disks match support paint's `{ p, n, r }`, without a kind. They are in the mesh frame on the wire and in the source frame in the project. `n` is the outward unit normal. The column runs along `-n`.
- `depthMm` is the column length. The default the UI writes is 5. The engine accepts 0.2 to 100 mm. Fill through ignores it.
- `fillThrough` extrudes the same cylinder along `-n` until the ray leaves the mesh. The length is the far hit. If the ray never leaves, the length is the part's bounding diagonal. The reinforced solid is that cylinder, not a flood fill of every cavity the part contains. One dab on a shell must not solidify the whole interior.
- A box or a cylinder is axis-aligned in the mesh frame. `center` and `size` are in that frame, so the volume moves, turns, and scales with the part. `size` is the full extent. A cylinder stands on mesh Z, with radii `size.x / 2` and `size.y / 2` and height `size.z`. After the pose, and after the belt lay-flat, the footprint is the polygon where the transformed solid meets the layer. There is no separate rotation.
- Later region wins where two overlap. A modifier volume still wins on walls and speed. Reinforcement then raises infill inside its own footprint: `max(resolved density, region density)`. A height range fills whatever the volume left empty, as it does today, and the reinforcement floor is applied after that.
- The pattern stays the strategy's pattern. Raising the density uses the same rules as a modifier infill: lightning becomes grid, roof pruning is off, and from 99% the beads are solid. Walls are not changed. The zone clip is the one modifier volumes already use, so a wall that crosses the footprint is cut and rejoined, and the seam on that loop can sit on the cut.
- A hollow layer (`infill_density <= 0.01`) still plans the reinforced zone at the raised density. Skins stay with the strategy.
- Adaptive layers evaluate the footprint at that layer's `z`, the same point a modifier volume uses.
- On a belt, paint disks take `Frame::pose` with support paint. Volume corners and the cylinder axis take the same move. The radius and the depth scale with the part, as a paint radius does.
- `classic` does not drop the list. The density floor still applies to whatever pattern classic left.
- Limits: 64 regions, 20000 disks across them, radius 0.2 to 40 mm, coordinates within 100000 mm, volume size 0.2 to 10000 mm on each axis. Each region uses `deny_unknown_fields`. A bad entry is refused with the field, as `reinforcement[0].density`. A paint region with no disks is refused. `depthMm` outside 0.2 to 100 is refused even when fill through is set, so a typo is not silent.

## Cache and G-code

The disk cache hashes the client JSON. Leaving `reinforcement` out leaves that key unchanged. An empty list is omitted on the way back out. A request that sends `[]` slices to the same G-code as one that omits the field.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding the field changes that text once, including when the list is empty. That is process memory. It does not change a stored request or a cartesian file.

The field is blanked in the contours key and in the support grow and support-path keys. It stays on the toolpaths key. A change replans toolpaths, order, and comb. It does not recut and it does not regrow supports.

When the list is empty the planner does not build footprints and does not enter the zone loop it would not have entered. `tools/golden_ab.sh` against the parent commit must report 0 different.

## Project and undo

Optional `reinforcement` on each version 2 object, omitted when empty. A one-object project that has a region is version 2, as paint is. A file with no reinforcement opens as before. A damaged entry fails the open with `The reinforcement in this project is damaged.`

The plate object holds the list, so `snapPlate` already puts it on the undo snapshot once the field exists. A stroke is one gesture, as a support-paint stroke is. Clearing the mesh clears the list. Splitting a solid clears it, as support paint is cleared.

## UI

Two later changes. The engine accepts both region kinds before either is drawn.

**Brush.** A Prepare rail tool, Reinforce, separate from Paint supports and Paint seam. One tool at a time. The bar is the support-paint bar: top center on desktop, a bottom strip in the compact layout, overlaying the stage so the prepare view stays at least 70% of a 1440 px window (`e2e/viewport-width.spec.ts`). Radius 0.5 to 20 mm, step 0.5, default 3. Depth 0.2 to 100 mm, step 0.5, default 5, hidden while fill through is on. Fill through is a checkbox on the active region. Disks are drawn on the prepare mesh in a new `--paint-reinforce` token, distinct from enforce blue, block red, and seam amber.

The first stroke creates a region at density 1, depth 5 mm, fill through off, and further strokes append to the active region. New region starts another at those defaults and selects it. The bar lists regions. Each row has a density slider from the sparser strategy infill (the label at that end is Normal) to 100% in steps of 5%, and delete. The brush edits the selected row's depth and fill through. An empty region is dropped on Done and is not saved. Off, or with every region at the strategy density, the slice body does not carry the field.

**Along edge.** The bar switches between Brush and Along edge. Along edge swaps Radius for Offset (0 to 50 mm, the gap from the edge to the near side of the strip) and Width (twice the brush radius limits; it starts at twice the radius). Hovering the part highlights the nearest boundary of the face under the pointer, from corner to corner. Faces are split where the surface bends more than 25°, the angle the Prepare outline uses, and a worker labels them the first time the mode opens for a mesh. A click on a highlighted edge starts a strip, the preview follows the pointer along the same boundary on the shorter side, and a second click on the part lays it. A double click or double tap lays the whole boundary. Esc drops a started strip, and a second Esc leaves the tool. A strip is a run of ordinary paint disks appended to the active region, so the engine, the slice request, the `.lime` file, undo (one step per strip) and the G-code are the same as for a brush stroke.

**Straight line.** With any paint brush (support enforce or block, seam, reinforce Brush), Shift+click paints a straight line of dabs from the last dab to the click, and a drag continues the stroke. The line stops where it leaves the part. A new mesh, another selected object or another brush kind forgets the last dab.

**Volumes.** Place a box or a cylinder on the selected object, move and scale it, and set its density on the same list. The shape is translucent in the prepare view. No rotation handle. The volume is stored in the source frame.

## Tests

`crates/lime-slice-core/tests/reinforcement.rs`:

- The field absent, and `"reinforcement": []`, match the G-code of a slice that does not mention it.
- A hollow cube with a disk on the top face, depth 5 mm, density 1, has solid infill inside the column on a layer within that depth, and none outside it and none below the depth.
- The same disk with fill through has solid infill on a layer past 5 mm and still none outside the column.
- A disk on a vertical wall (normal `+X`) reinforces inward along X, not downward.
- A later region at a lower density wins inside the overlap and does not lower the rest.
- A region at or below the strategy density matches the unreinforced G-code.
- A box and a cylinder raise infill only inside the footprint.
- A modifier volume's wall count is unchanged inside a reinforcement that overlaps it.
- A belt moves a disk with the mesh. An adaptive stack still hits the layers the column reaches.
- Grid, gyroid, lines, and lightning: the first three keep their pattern at the new spacing; lightning becomes grid inside the region; density 1 is solid.
- Refusals name the field.
- Changing only reinforcement reuses the contour stage.

`tools/golden_ab.sh` on the release binary, no reinforcement in the golden scenes, is included in the engine change.

## Questions for review

1. Is `reinforcement` the right name, omitted when empty, on the object rather than plate-wide like `modifierVolumes`?
2. Is the reinforced solid a cylinder of the brush radius along `-n`, and is fill through that cylinder until the ray leaves the mesh, rather than a flood fill of the cavity?
3. Should density be a floor (`max(strategy, density)`) so a region can never thin the part, with no footprint when the floor does not rise?
4. Are depth and fill through per region, with a new region's defaults at 100%, 5 mm, and fill through off?
5. Do volumes live in the mesh frame and rotate with the part, with the layer footprint taken after the pose and the belt lay-flat?
6. Where a reinforcement overlaps a modifier, reinforcement raises infill only and the modifier keeps walls and speed. Is that the overlap rule?
7. Should `classic` keep the list, as seam paint does?
