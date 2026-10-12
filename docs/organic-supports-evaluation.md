# Organic supports, judged

The brief asks for a second support style: a voxel distance field, an A* route, and a belt-specific re-slice. That pipeline is not what Cura, PrusaSlicer, Orca, Bambu, or Qidi run, and it is not a gap in this tree. The tree in `crates/lime-slice-core/src/support.rs` already seeds overhangs, merges branches, tapers by load, prints an interface, and on a belt lands on the belt or the model. One piece of Thomas Rahm's rewrite is worth folding into that walk. A parallel mode is not.

The judgement below is unchanged. Avoidance, as specified here, is now a request field, off unless the slice asks.

## The lineage

**Wrong.** "Thomas Rahm's distance-field graph search, adopted as PrusaSlicer Organic, Orca, Bambu, and Qidi" names one algorithm and one port. There are two generators, and neither searches a distance field.

Rahm rewrote Cura's tree supports. The code is `TreeSupport` and `TreeModelVolumes` in CuraEngine, and the notes on [ThomasRahm/CuraEngine](https://github.com/ThomasRahm/CuraEngine). Collision and avoidance are 2D polygons per layer, keyed by radius, built by offsetting the layer. An avoidance is the region a branch of that radius must stay out of if it still has to reach the bed or the model. Influence areas grow downward from the overhang and merge where they overlap. Circle centres are then picked inside those areas, from the bed upward. That is polygon propagation. It is not a voxel signed distance field, and it is not A* or Dijkstra.

PrusaSlicer 2.6 Organic is that generator plus a mesher. `OrganicSupport.hpp` is copyright Prusa Research 2023, Vojtěch Bubník. The release notes call it an evolution of Rahm's Cura trees: straighter branches, a circular section perpendicular to the branch, and double walls where the branch is thick. `organic_draw_branches` smooths the centreline (a bilaplacian pass, refused where the curvature would exceed the radius or the move would hit a collision polygon) and slices one cumulative mesh back into layers. The path still comes from `TreeModelVolumes`.

Bambu's slim, strong, and hybrid styles are a different file, `TreeSupport.cpp`. Per layer it builds collision and avoidance polygons and a minimum spanning tree of the contact nodes. Radius grows with distance from the tip. Bambu's wiki describes organic as a later style: Cura, then PrusaSlicer, then ported by them. That port is `TreeSupport3D` (`organic_draw_branches`). Orca kept Bambu's tree and copied Prusa's organic sources beside it for organic mode only ([OrcaSlicer #1938](https://github.com/OrcaSlicer/OrcaSlicer/pull/1938)). Qidi Studio is a Bambu Studio fork, so it inherits whichever of those two the fork contains. Qidi Print is an older Cura fork and a different program.

"Distance field" is a misreading of the radius-keyed offset. "Graph search" is a misreading of Bambu's spanning tree, or of the branch graph the influence areas become. Prusa's smoother does limit curvature, after the path exists. The cost `length + curvature − proximity` is not in any of these.

## The pipeline

| Stage | Mark | What actually runs | This tree |
| --- | --- | --- | --- |
| Voxel SDF, plus an XY-offset collision envelope | Wrong | Collision is the layer outline offset by XY distance and radius. Avoidance propagates that offset up through the layers. No voxel grid. | `organic_disks` shrinks a disk that enters `xy_gap`. `push_out` steps the centre out of this layer's outline. `settle_disks` narrows a disk to what the layer below can hold. |
| Overhang seeds by a normal threshold | Partially | The angle is a threshold. The seed is the overhang polygon, not a dot product with a face normal. | `overhang_at` is this layer minus the layer below, offset by `height / tan(angle)` (`past_angle`), plus a floating island. Paint disks do use normals, and only for enforce and block. |
| A* or Dijkstra, cost = length + curvature − proximity | Wrong | Downward influence areas, then a centre picked inside them. Bambu's other tree connects contacts with a minimum spanning tree. Curvature shows up only in Prusa's later smooth. Proximity is a polygon the branch may not enter. | `pair_steps` matches the closest legal pair and walks toward a section-weighted meeting point, at most one lean step. |
| Merge branches | Correct | Influence areas merge by intersection. Bambu's spanning tree joins contacts. | `merge_nodes` joins a guest into the earlier node when `carries` and `holds_both` pass. |
| `r(h) = r_tip + h · tan(φ)` | Partially | Bambu's `calc_branch_radius` is `r_tip + (h − tip) · tan(φ)`, and `φ` is the branch diameter angle, a few degrees, not the lean. Cura and Prusa increase radius per layer the same way, then cap it. | Radius is `section_radius` of the carried tips, plus `flare_per_mm` (0.03 to 0.08 mm of radius per mm of fall), capped at the trunk. Lean is `branch_angle_deg` (default 40°), through `lean_of`. Using that angle as `φ` would hit the 4.2 mm trunk in about 2 mm. |
| Interface roofs at the tips | Correct | A dense roof under the overhang, then the branch. | `interface_layers` (default 3) and `z_gap`. Tips freeze for those layers. `drop_unfooted_interface` removes a roof nothing holds. |

The collision difference is the one that prints. Rahm's avoidance knows that a branch which must thicken cannot enter a pocket it cannot leave. `push_out` sees only the outline on the layer it is stepping onto, and only after the lean. A centre that has already stepped into a narrowing becomes `End::Pinched`, or `settle_disks` drops it and the trunk above has to find another footing.

## The belt

The slice already rotates the mesh about X so the nozzle plane is horizontal (`rotate_x` in `belt.rs`), then runs this planner. Support disks are cut on those planes. In the lab the planes are sloped. Building a support mesh in order to cut it again on sloped planes repeats the BeltEngine path this rotation was chosen to avoid (`docs/belt-slicing.md`).

| Adaptation | Mark | What this belt already does |
| --- | --- | --- |
| Rotate the frame about X | Correct, and already the slice frame | `prepare_belt`. Supports are not a second transform. |
| Overhang test from a gravity vector and a nozzle vector | Wrong | Need is `overhang_at` in the rotated frame. The previous layer is along the nozzle normal, so a face that leans with the belt can pass vertical in the lab and still count as supported. A second vector test would judge that face again. |
| Anchor on the belt or on the model | Correct, and already true | `reaches_model` separates a tip that can land on a roof from one that must reach the ground. `FloorPlane` stops a trunk on the belt. `clip_printed` cuts disks to the printable half-plane. |
| Bias toward +Y so the gantry clears | Wrong | `FloorPlane::fall` adds `height · tan(α)` to slice Y so the trunk stays plumb in the lab. +Y is toward the belt (`docs/belt-floor-supports.md`). The seam's `rear` is that same edge. `sequential_gantry_mm` does not move a tree. |
| A slanted wedge of nozzle clearance | Wrong | Clearance is `xy_gap` (default 0.55 mm) in the layer plane. There is no toolhead wedge. |
| Slice a support mesh on sloped planes | Wrong | There is no support mesh. A leaning branch is a stack of disks, one per nozzle plane. |

## What is worth doing

Fold Rahm's per-layer areas into the walk we have. Leave the style list as grid and tree.

**Avoidance.** For each radius bucket, offset the part by `xy_gap` plus the radius, then propagate that region up by one lean step per layer. `propagate_nodes` treats that polygon as blocked, where `push_out` today tests the raw outline. A prune or a regrow keeps the polygons: they are demand, and demand does not read knots (`docs/support-edits.md`).

**Merge where the areas overlap.** Two branches join when their downward regions overlap and the existing tests still pass (`can_carry`, `holds_both`). Greedy pairing inside `PAIR_REACH_MM` (22 mm) stays the way a layer chooses which pair moves. The polygon says whether that meeting point is still a place a thickening trunk can stand.

Both are the `supportAvoidance` field. It is omitted when off, so the cache key and the G-code of a tree that does not ask stay the bytes they were. `tools/golden_ab.sh` against main, with the field omitted, is the check. Turning the field on changes the trees that meet a pocket.

Leave the rest.

- Thickness stays `section_radius`. `flare_per_mm` is already the small diameter angle. The lean stays a step limit.
- The interface, the tip freeze, and the roof drop stay.
- The organic mesh stays out. The README describes these trees as stacked shafts with an interface tip. Knots, prune, and regrow are disks. Prusa's cumulative mesh is why organic looks smooth, and why Orca had to vendor a second generator.
- The belt overhang test stays the rotated layer offset. Gravity stays `FloorPlane::fall`. A gantry wedge needs a measured toolhead, which this brief does not have.

## Cost

Avoidance is a bottom-up offset per radius bucket, stored with the part, consulted from the walk. Medium, and local to `support.rs`. Influence-area merge is a second top-down polygon pass in front of `merge_nodes`. Larger, same flag. A voxel grid, an A* router, and a support mesh are a second slicer: new memory, a new edit model, and a belt path that fights the rotation. That is the cost of shipping the brief as an alternative style.

## Shipped

`supportAvoidance` is left out of the request when it is off. The switch is Avoid pockets, under Organic tree, on the advanced row with Style.

The bed foot is stored at the trunk radius. `arrive` widens a branch that reaches the bed to `trunk_r * 0.95`, and one lean step cannot walk that trunk out of a pocket, so the forbidden region starts at the trunk and is eroded by one lean step per layer. A branch that must reach the ground reads the bed map. A branch that may stop on a roof reads the model map, which drops the part on a roof layer.

`pair_steps` will not walk toward a meeting point the merged radius cannot occupy. `merge_nodes` refuses that point when `holds_both` would otherwise pass. `push_out` treats the polygon as blocked. A step that would enter it is not taken, so the lean is spent leaving.

`tools/golden_ab.sh origin/main`, with the field omitted: 48 same, 0 different.

## Review questions

1. Is refusing a second style right, because prune and regrow address disks and limbs?
2. Is per-layer avoidance, then a merge that still uses `can_carry` and `holds_both`, the change worth a later off-by-default field?
3. Should thickness stay on carried load, with `flare_per_mm` as the diameter angle?
4. Is the belt overhang test correctly left as `overhang_at` after the X rotation, with `FloorPlane::fall` as the only gravity term?
5. Does a gantry wedge stay out until the toolhead is measured?
6. Is widening the bed foot to the trunk, then eroding it upward, the right reading of a branch that only becomes a trunk on the last layer?
7. Should a meeting point the merged section cannot occupy be refused even when `holds_both` would pass?
8. Is Avoid pockets in the right place: advanced, under Style, off unless the slice asks?
