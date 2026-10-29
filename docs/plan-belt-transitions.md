# Plan: 45° belt transitions as a Model operator

Status: plan, for review. Written 2026-10-29 against `main` at v4.3.0 (`730c3102`). It changes nothing yet. Building starts only on the owner's go.

The owner printed the 12_3 housing on the Ideaformer IR3 V2 and found two kinds of geometry that no support setting rescues:

1. **A lip born in the air.** An edge whose first rows appear all at once, such as the closing lip of an opening. A 45° chamfer under it worked on the printer: the lip then grows as a ramp.
2. **A corner where a slope turns horizontal.** At the bend, the next rows step out past the row below. That bend must also be 45° in the belt's frame.

The owner wants a Model-tab operator that adds (or cuts) that transition on a selected edge. Corners are required; lips are wanted too.

**The short answer:**
- **One operator, "Print transition".** Pick an edge or a chain of edges. It adds a flat wedge whose new face makes a set angle with the layers, so every row of it stands on the row before. It is one history step with typed parameters.
- **Lips get a gusset added under them. Corners get a flat wedge added on their inner side.** A cut is offered only for a lip that is thick enough to lose its underside. A round fillet is never used (section 3).
- **The angle comes from the pose.** The build direction is computed from the object's rotation on the plate and the printer's belt angle. The step stores it, so the solid does not move when the pose changes later. The app warns instead, and offers to re-aim.
- **An auto-find lists the edges that would start in the air,** with a one-click fix on each.
- **Proof is a measurement first.** The slicer gains a check for part beads that stand on nothing. Two synthetic coupons decide the default angle before the operator is built.

## 1. The belt frame

The plate frame has X across the belt, Y along it, and Z up from the belt. The IR3 V2 lays every layer on a plane tilted by the belt angle α, 45° on the IR3 V2 preset. `mirror_rotate_x` in `crates/lime-slice-core/src/belt.rs` gives each point its layer height:

```
s = −y · sin α + z · cos α
```

So the **build direction**, the side each new layer is laid on, is `b = (0, −sin α, cos α)`. Layers stack toward low Y, and the high-Y end prints first. Gravity points straight down onto the belt, and tree trunks grow plumb (decision 2 of `docs/plan-ray-trees.md`).

```
 Side view on the IR3 V2. X, across the belt, points out of the page.

        b  (build direction: each new layer goes on this side)
         \
          \          /     /     /     /     /
           o       /     /     /     /     /      layers: planes at α = 45° to the belt
                 /     /     /     /     /
   ========================================================  belt
   -Y  <-- layers stack this way        the belt carries the part -->  +Y
```

### How the slicer judges a face

A face with outward normal `n` faces down, as the slicer sees it, when `n · (−b) > 0`. Its **angle to the layers** is `ψ = acos(n · (−b))`:
- 0° is a face parallel to the layers: its first rows all appear on one layer;
- 90° is a wall in the slicer's frame: each row sits right on the one before.

With the support angle θ (`supportAngle`, 45 in `src/app/state.ts`), a face holds its own rows when `ψ ≥ 90° − θ`. `past_angle` in `crates/lime-slice-core/src/support.rs` is the same test, done per layer on outlines.

On a 45° belt with a 45° support angle, the faces of an ordinary CAD part fall like this. These are faces whose normal lies in the side view, like the edges of the housing that run across the belt:

| Face in the side view | Angle to the layers | What the slicer sees |
|---|---|---|
| Underside sloping up at 45° toward −Y | 90° | A wall. Grows with no step. |
| Horizontal underside, parallel to the belt | 45° | Exactly at the support limit. |
| Upright face looking toward +Y | 45° | Exactly at the support limit. |
| Underside sloping up at 45° toward +Y | 0° | Parallel to the layers. Born all at once. |

So "45° to the belt" means opposite things depending on which way the face leans. And every flat, square face on the underside of a part sits exactly on the limit. That is why the housing's horizontal roof made hairline rows (#480) and holes. Decision 1 settles what the operator's number means.

**An edge across the belt lies in one layer.** Every layer plane contains the X direction. So an edge that runs across the belt and is the lowest point of its feature appears on one layer, along its whole length. That is the lip on the zigzag split of the housing.

## 2. Which edges need a transition

The rule, in the slicer's frame: **an edge needs a transition when the rows just past it, in build order, are not held by the rows just before it.** There are two shapes.

### The lip born in the air

The lip's underside is parallel to the layers, or past the limit. Its first edge is the lowest point of that part of the solid, measured along `b`. Both faces at the edge rise away from it in build order, and nothing of the part lies under it.

```
 Layer frame: the side view turned so the layers are level. b points up.

   before                                  after
                      |                                        |
   +------------------+  lip               +-------------------+  lip
   |                  |                    |                   |
   +------------------+ <- these rows      +.                  |
                      |    appear at once    '.     gusset     |  new face at the
                      |    with nothing        '.              |  transition angle
                      |    under them            '.            |  (45° to the layers here)
                      | wall                       '.          |
                      |                              '.        |
                      |                                '.      |
                      |                                  '.    |
```

**The fix is a gusset, added.** A flat face runs from the lip's first edge, at the transition angle, back into the part until it meets material. Cutting would remove the lip, which is the feature the user wants.

A lip of depth `w`, measured in the layer from its first edge to the wall, needs a gusset `w · tan ψ` tall along `b`. At 45° that is `w`. A lip with nothing under it within the size limit cannot be fixed this way, and the operator says so (section 5).

**Cut instead** is offered for a lip thick enough to lose its underside: the underside becomes a ramp from the root of the lip to its first edge. It is refused when the ramp would leave less than the wall floor (twice the nozzle) on top.

### The corner where a slope turns flat

The underside goes from a steep face that holds itself (the near face) to a flatter face (the far face), at an edge. On the underside of a part, a bend toward flat is always a **concave** edge: the material wraps around the outside of the bend.

```
 Layer frame. b points up. Material is above and to the right.

   before                                   after
   _____________________________            _____________________________
                         material |                           material |
   _____________________          |          ____________              |
                        \ <- corner                      '.            |
    far face: nearly     \        |          far face      '.  wedge   |
    flat, each row        \       |          held from        '.       |
    steps out too far      \      |          here                \     |
                            \     |                               \    |
               near face:    \    |                                \   |
               steep, held    \   |                                 \  |
```

**The fix is a flat wedge, added on the inner side of the bend.** Its face runs from a point on the near face to a point on the far face, at the transition angle.

**Why not a cut chamfer?**
- The rows that hang are on the concave side.
- Cutting the convex side of that bend is cutting the other skin of the wall. That thins the wall, changes the outside of the part, and does not touch the rows that hang.

**Why not a round fillet?**
- A fillet ends tangent to the far face.
- So its last rows are as flat as the face it was meant to fix, and the overhang comes back where the fillet ends.

**Why it still adds material on a shell:** the housing is a shell. The wedge thickens the roof locally on the inside, where nothing is seen, and leaves the outside alone.

**How far the wedge reaches** depends on the far face:
- **Past the limit:** a wedge at the corner only moves the problem along. The wedge must run to the far face's end, and it becomes a gusset, exactly as under a lip. By default it does.
- **At the limit, within 3°:** this is the housing's flat roof. Geometry says it holds, and what fails there is the corner. A wedge at exactly the limit would be parallel to the far face and add nothing. So it must be steeper than the limit, sized to a few millimetres. The coupon study (step 1 in section 9) measures whether that is enough before this case is built.

## 3. The transition angle and the pose

### Defining it

The number the user types is the **angle between the new face and the layers**, ψ:
- default 45°, the support angle (decision 2);
- allowed from `90° − θ` up to 85°.

The new face contains the edge's direction `e` and makes the angle ψ with the layers, so its normal `m` satisfies `m · e = 0` and `m · (−b) = cos ψ`. That gives two answers or none:
- **Two:** the operator keeps the one that lies in the air between the edge's faces (add) or inside the solid (cut).
- **None:** the edge itself climbs through the layers more steeply than ψ. Then every face through it already holds, and the operator says "This edge already grows at least that steeply."

The preview also shows the new face's angle to the belt, so a number the owner thinks of in the belt's frame can be checked against it.

### Where `b` comes from

`b` is computed in the part's own frame from:
- the object's rotation on the plate, `orient` in `src/plate.ts`;
- the plate printer's belt angle, `belt.angleDeg` from the printer profile.

Position, offset and uniform scale do not change an angle, and neither do belt copies.

**One formula, two places.** The Rust engine already owns the formula in `belt.rs`. The app gets one helper for `b`, and a unit test locks it against the engine's `mirror_rotate_x` on a few rotations. Then a change of hand in the belt frame cannot leave the operator aiming the wrong way.

**On a flat-bed printer,** `b` is the bed's +Z in the part's frame. The same operator then puts a 45° chamfer under an ordinary overhang (decision 6).

### When the pose changes later

The step stores the following:
- `b` in the part's frame;
- the belt angle;
- the printer's id.

A rebuild uses the stored values, so turning the part on the plate never changes the solid by itself. This matters because later steps may name the faces a transition made.

**What changes is a warning.** When the stored `b` is more than 1° from the current one, the step is stale:
- **History:** its row turns amber.
- **Prepare:** a note reads "2 print transitions were made for another pose. Re-aim, or keep them as they are."
- **Re-aim:** rewrites `b` for the current pose and rebuilds. Any edge that now refuses is listed with its sentence.
- **Keep:** dismisses the note for this pose.

Only rotations that leave `b` in place keep a transition valid. On the belt, `b` is not vertical, so even a turn about the plate's Z makes the step stale. The note says so.

## 4. Building it in Open CASCADE

Two ways to make the solid exist, and the plan uses both, each where it is exact.

### A chamfer by distance and angle

`lime_tree_chamfer2` (mode 2), reached through `chamfer_sides` in `crates/lime-model-occt/src/tree.rs`, already chamfers an edge by a distance along one face and an angle from that face.

The operator does three things:
1. It picks the far face as the reference.
2. It sets the distance to the wedge's reach along that face.
3. It sets the angle to the one between the far face and the target plane, computed from `b`, ψ and the two face normals.

On a concave edge, an Open CASCADE chamfer adds material, which is the corner wedge.

- **Good:**
  - The path is tested.
  - It names its faces the way fillet and chamfer already do.
  - It re-finds its edge after an edit above it, through the stored face kinds and normals (`resolve_blend`).
- **Exact only when:**
  - the edge is straight;
  - both faces are planar.

  The chamfer keeps one angle to its reference face along the whole contour. On a curved face or a curved edge, the angle to the layers drifts along the edge.
- **After the build:** the operator samples the new face. If its angle to the layers is off by more than 1° anywhere, it refuses the chamfer path and falls back to the prism.

### A prism along the edge, fused or cut

The prism path has three parts:
1. **The section:** a triangle in the plane across the edge, with one side on each face and the third at the transition angle.
2. **Straight edges:** `BRepPrimAPI_MakePrism` along the edge.
3. **Curved edges and tangent chains:** `BRepOffsetAPI_MakePipeShell` along the edge's wire, with its binormal held fixed to `b`. The fixed binormal keeps the same lean to the layers all the way along, which a chamfer cannot do.

The tool is fused for add, or cut for cut.

**For a lip,** the gusset is built from the lip's underside instead of from one edge:
1. Extrude the underside along −`b` by the size limit.
2. Keep the side of the transition plane that faces the part.
3. Subtract the solid.
4. Keep the one piece that touches the lip's underside.
5. Check that this piece lands on the part somewhere other than the lip. If it does not, the gusset would itself start in the air, and the operator refuses.

This handles a lip with a wall beside it and a lip over a floor alike.

**Proposal:**
- Straight edges between planar faces go through the chamfer.
- Lips, curved edges and chains go through the prism.

Both are behind one op, and the choice is internal.

### Chains of tangent edges

Selecting one edge offers its tangent chain, the edges that meet it with no corner, the way Open CASCADE already extends a fillet or a chamfer. The chain is one wire for the pipe.

A chain with a real corner in it, more than 5° at a vertex, is split there:
- Each run gets its own prism.
- At the corner, the two prisms are cut on the bisecting plane and fused, so there is no notch and no spike.

### Edges that end at walls

- **Add:** at an end where a third face crosses the prism's path (a wall), the prism is made longer by its own height, and the boolean merges it into the wall. At an end in the open air, the prism stops flush with the edge's end.
- **Cut:** the opposite. A cut never runs past an end with a wall, or it would notch the wall. It runs past a free end, where it only cuts air.

### When it refuses

Each refusal is a sentence, and the solid is not changed (the house rule for Model refusals):
- The edge is not between two faces: a seam, a boundary, or an edge shorter than 0.2 mm.
- The edge already grows at least as steeply as the angle asked.
- A lip with no part under it within the size limit (default 20 mm). Supports or a split are the way there.
- The added piece would touch a face other than the edge's own and the walls at its ends: an opening, a hole, a boss. The sentence names the face and the distance.
- A cut would leave a wall under the floor, or go through the part.
- A chain mixes add and cut edges. It is split into runs, and each run is applied on its own.
- The object is a mesh with no solid. The sentence says to open the STEP.
- The edge lies on the belt, where the belt holds its rows.

## 5. The Model tab

**Where it lives:**
- "Print transition…" in the Features menu, a card like Split to print.
- No new rail button and no new shortcut, the same rule `docs/plan-split-connectors.md` set for `MODEL_TOOLS`.

**Using it:**
1. **Select.** Click an edge. The tangent chain lights up, and a second click on the same edge takes the single edge only. Shift-click adds edges.
2. **Card.** The card shows the following:
   - the edge's case (lip or corner), as found, which the user can change;
   - Add or Cut;
   - the angle to the layers;
   - the size, "To the end of the face" or millimetres;
   - the build direction's source: "From this pose on the IR3 V2, belt 45°".
3. **Preview.** A ghost of the wedge: green when added, red when cut. The new face's angle to the layers and to the belt is written on it. The volume added or removed is shown. A refusal shows its sentence in place of the ghost, and Apply stays off.
4. **Apply.** One history row, "Print transition (3 edges)". The edit pencil reopens the card with the same parameters, and the row rebuilds from them.

### Auto-find

A button on the card: **"Find edges that start in the air"**.

**What it lists.** It reads every edge of the solid against `b` and the support angle, and lists:
- **Lips:** edges that are the lowest point of their faces along `b`, above the belt, where the face past the edge is past the limit.
- **Corners:** concave edges where the near face holds and the far face is past the limit, or within 3° of it.

Each row shows the following, longest first:
- the case;
- the length;
- the fix it proposes, with its size;
- whether that fix refuses, with the reason.

**Using the list.**
- Hovering a row lights its edge in the view.
- **Fix** applies that row as its own history step.
- **Fix all** applies every row that does not refuse as one step, which can be edited per edge afterwards.

**Its source is the geometry, not a slice.** It is instant in Model and needs no slice. Decision 7 adds a check against the slicer later (step 6 in section 9).

**Points are not edges.** A feature that is born at a single point, such as the tip of a cone, is not an edge and is not listed. Trees already handle points.

## 6. The MCP

This follows the lean schema of #405: an op kind, an `OP_SUMMARY` line, and a guide entry. There is no new tool.

**Op kind `transition`:**

```
{kind:"transition",
 edges: [index] | {select:{...}} | {fromNode:"..."},   // as fillet and chamfer take them
 mode: "auto" | "add" | "cut",                          // auto: add, except as section 2 says
 angleDeg: 45,                                          // between the new face and the layers
 size: "face" | mm,                                     // "face": to the end of the far face
 maxMm: 20,
 build: [x, y, z]}                                      // part frame; default from the pose and printer
```

**The `OP_SUMMARY` line:**

> transition {edges, mode, angleDeg, size}: a flat wedge under a lip or in a corner, at angleDeg to the layers of the plate's printer.

**The guide entry**, for `guide {kind:"transition"}`:

> transition: on the belt, a lip whose first rows appear at once, or a corner where the underside turns flatter, prints in the air. {kind:"transition", edges:[12]} adds a flat wedge whose new face is angleDeg (default the support angle) to the layers, from this object's pose on the plate's printer. A lip gets a gusset back into the part; a corner gets a wedge on its inner side, to the end of the far face when that face is past the limit. mode:"cut" turns a thick lip's underside into a ramp instead. The probe gives each edge's case, the new face's angle to the layers and to the belt, and the volume added or removed. model_probe {op:{kind:"transition"}, plan:true} lists the edges that would start in the air, with the op that fixes them. The step keeps the pose it was made for; after a turn, model_describe names it stale and model_edit with build:null re-aims it.

**Auto-find** is `model_probe {op:{kind:"transition"}, plan:true}`, the same pattern Split to print uses for its plan.

- **It returns:** rows of `{edges, case, lengthMm, fix, refused?}` and one ready op for the rows that do not refuse.
- **Stale steps:** `model_describe` gives a stale step a note.

## 7. Measuring a fix

### The check

The housing showed that "floating interface" called a failed slice good. What failed were **part beads that stand on nothing**. The diagnosis wrote that check as a scratchpad script (`pheld.py`). Its rule: a part bead on a layer is held by any of these:
- a part bead on the layer below, within half a bead;
- support or interface within the Z gap below it, in the belt frame;
- the stacking-or-gravity rule;
- the belt.

**The script moves into the engine.**
- It becomes a field of the slice audit (`SliceAudit` in `crates/lime-slice-core/src/audit.rs`):
  - the length of unheld part beads;
  - the patches, largest first, each with the layer and the place where it starts.
- It is reached through the CLI's audit and the MCP.
- **It only reads a finished plan.** Golden G-code stays byte-identical.

### The coupons

Every coupon is synthetic, built with `model_build`, and kept in the tests. Company files are never used, for the coupons or for the proof.

| Coupon | What it holds |
|---|---|
| **Lip** | A 40 × 30 × 20 mm block on the belt, with a slot across the belt closed by a 6 mm lip, the lip's first edge across the belt. |
| **Corner** | A 2 mm shell with an inner underside that climbs steeply and then turns flat parallel to the belt, as the housing's roof does. It comes in two variants: flat face exactly at the limit, and 10° past it. |
| **Curved lip** | A disc over a post, so the lip's first edge is an arc. |
| **Chain** | A lip that turns a corner in plan, for the mitre. |

### What proves a fix

Each coupon is sliced on the IR3 V2 preset with PETG, 0.4 mm and 0.2 mm layers, before and after the transition, and the measures are:
- **Unheld part beads,** in millimetres and patches, near the edge. The target is none.
- **Print time** and **volume** added. The volume is expected to be tiny, and the rule in "No costly defaults" is followed.
- **Golden:** 60/60 byte-identical. The operator changes a solid the user chose to change, never the slicer.

**One print.** The owner prints the lip and corner coupons side by side, before and after, at 45° and 55° to the layers. That is about half an hour on the IR3 V2. The photo and the numbers go in the PR.

### As built: step 1

**The check** is `PartHold` in `crates/lime-slice-core/src/audit.rs`. One rule serves the audit, the tests and the MCP:
- **Part beads** are wall, outer, inner, thin-wall, gap-fill, infill, sparse, solid, top and bridge beads, sampled every 0.2 mm. Skirt and ironing are left out.
- **Held** by any of:
  1. a part bead on the layer below within half a bead;
  2. a part, support or interface bead on the layer below that the bead can lean on: half a bead across, 0.3 mm back against gravity, 0.5 mm along it;
  3. support or interface on the layers within the Z gap below, out to where gravity carries the bead on that layer (layer drop × tan of the belt angle, along slice +Y);
  4. the belt (0.3 mm), or the first layer.
- **Dangling:** an unheld bead with no held bead within 0.5 mm on its own layer.
- **Patches:** unheld beads grouped over 1 mm cells in X and Y, on the same layer and the next. Each patch gives its length, its dangling length, its first and last layer, and where it starts in the plate frame (Z up from the bed or the belt).
- **A flat bed** has no downhill side, so rules 2 and 3 reach 0.3 mm every way.

**Where it shows:**
- `SliceAudit.part_hold`, printed by the command line's `--audit`.
- A request field `partHold`, omitted when off, so other requests keep their cache keys. The reply then carries `partHold`. Only the first belt copy is read.
- The MCP sets `partHold` on every `slice_start`, and `gcode_summary` returns `standsOnNothing {unheldMm, danglingMm, longestSpanMm, partMm, patches, largest[5]}`. `longestSpanMm`, on the whole slice and on each patch, is the longest stretch of one path over nothing, through turns up to 30°: a bridge between walls reads a few mm, a row laid along a hollow its whole length. The slice guide says what it means.
- It reads the emitted layers after the plan. Golden is byte-identical: 54 of 54 rows against the newest stored run (`bb09342b`). The 6 rows of the company's rear cover were left out of both sides.

**It matches `pheld.py`.** The diagnosis script and the engine read the same G-code of a synthetic wall with an arm on the IR3 V2, at three underside angles, with supports off and with floor trees. The results:
- Unheld and dangling length match to 0.1 mm in all six runs: for example, 742.2 / 679.2 mm with the arm born in the air.
- Patch counts and patch lengths match.
- "No bead under" matches in four of the six runs. In the other two, one row of 19.5 mm sits exactly on a 0.05 mm row edge of the index and falls on the other side by float rounding.
- The engine's row index starts where the gantry's coordinate starts, so its rows fall where the script's do.

**The coupons.** Each is a side view in Y and Z, extruded 20 mm across the belt. The base is a box, and an extrude `common` with the profile on the plane `turn: [90, 0, 90]`:
- **Lip born in the air.** A post at high Y, with a lip hanging 6 mm toward −Y. The lip's underside rises 45° toward +Y, so it lies in one nozzle plane.
- **Flat roof at the limit.** A 2 mm shell. The inner underside climbs a 45° slope (a wall to the slicer), then turns flat at Z 20, parallel to the belt.
- **Roof 10° past the limit.** As the flat roof, but the far face falls 10° toward −Y.
- **Roof 20° past the limit.** As the last, at 20°. This one was added because 10° past held.

The transitions were made by hand:
- **Lip:** a gusset from the lip's first edge back to the post. At 45° to the layers its face is flat; at 55° it rises 10° toward −Y.
- **Flat roof:** a wedge. The 45° wedge is the roof itself, so none exists. The 55° wedge reaches 5 mm along the roof. It is a `chamfer {size: 5, angleDeg: 10}` on the concave corner, adding 53.5 mm³, which is the wedge to 0.1 mm³.
- **Past the limit:** a gusset running to the far face's end, as section 2 says.

Every coupon was sliced alone on the owner's IR3 V2 machine file, with PETG, a 0.4 mm nozzle, 0.2 mm layers, Speed, and supports off. Each cell below gives the unheld length at the feature in mm, with the volume added in brackets:

| Coupon | No transition | 45° to the layers | 55° to the layers |
|---|---|---|---|
| Lip born in the air | 275.2 (all dangling but 45) | 0 (+180 mm³) | 0 (+212 mm³) |
| Flat roof at the limit | 0 | no wedge exists | 0 (+53.5 mm³, chamfer) |
| Roof 10° past the limit | 0 | 0 (+1,626 mm³) | 0 (+3,948 mm³) |
| Roof 20° past the limit | 2,450.5: 1,227 outer and 1,223 inner wall | 1,223.3: inner wall only (+3,893 mm³) | 1,223.3: inner wall only (+7,015 mm³) |

Print time per coupon:
- Lip: 425 s with no transition, 412 s at 45°, 413 s at 55°.
- Flat roof: 927 s with no transition, 948 s with the 55° wedge.
- 10° past: 884 s, 816 s, 869 s.
- 20° past: 630 s, 736 s, 822 s.

**Outside the features**, every coupon also shows one patch of 92–110 mm. It is a gap-fill line across the full width, on the last-printed top corner (the low-Y end). The 10° gussets add a second one where the gusset thins the end. These are not transition rows. They are the slicer's gap fill over a sliver, and are worth their own look.

**What the numbers say:**
- **45° suffices.** Wherever a transition fixes anything, 45° fixes all of it, and 55° measures the same for more material. Decision 2 stays at 45°, the support angle.
- **The lip is the case that needs it.** Born in one plane, its first rows stand on nothing. A gusset at 45° removes all of them, for 4 % more volume.
- **A corner at the limit, or 10° past it, holds** at 0.2 mm layers. Its rows step 0.2–0.29 mm a layer, inside the half bead and the 0.5 mm lean. So the hole at the housing's turn to horizontal was not this geometry. It agrees with the diagnosis behind #490: the hollow ramp roof. Step 2's wedge for a corner at the limit has nothing to fix on a solid shell.
- **20° past the limit fails.** The gusset removes the underside rows, but the inner wall rows above it still hang. That is the hollow-roof case. With **Skin on shallow slopes** (#490) on:
  - the bare 20° roof keeps only its underside (1,230 mm);
  - with a gusset, a new 1,600 mm patch appears inside the thickened roof.

  The two rules need to be tuned together before step 2 sizes gussets past the limit.

**The coupon sheet** for the print:
- **Files:** `C:\Users\marius\lime-workspace\20261029_belt-transition-coupons.lime` and `.gcode`.
- **Coupons:** eight, 10 mm wide, side by side across the belt in this order from low X: lip with no transition, lip at 45°, lip at 55°, flat roof with no transition, flat roof at 55°, 20°-past roof with no transition, at 45° and at 55°.
- **Print:** 74 min and 12.4 g on the engine's estimate.

### As built: step 2

**The op** is `Op::Transition` in `crates/lime-model-occt/src/tree/transition.rs`, kind `transition`. For each picked edge it checks the corner, works out the wedge, builds it, and checks the result:
- **The corner.** A straight, concave edge between two flat faces. The face with the smaller angle to the layers is the far face; the other is the near face.
- **The new face.** Its normal turns about the edge from the far face's normal toward the near face's until it makes `angleDeg` with the layers (section 3).
- **The reach.** `size` runs along the far face: millimetres, or `"face"` to that face's end. The reach up the near face follows from the angles.
- **Two paths.** A wedge that stops short of both faces' ends is a chamfer by a distance and an angle from the far face (`lime_tree_transition_chamfer`, one angle per edge). A wedge that reaches a face's end is a triangular prism along the edge, fused on (`lime_tree_wedges`), because a chamfer cannot use up a face.
- **The checks on the built solid.** The volume added must be the wedges' own, within 1 %, or the wedge met another part of the solid. One new edge must border a face within 1° of the asked angle.

**What the step stores:**
- `build`: the build direction in the solid's frame, as a unit vector;
- `angleDeg`, `size` and `maxMm`;
- `beltDeg`, `orient` (the plate orientation, row by row) and `printer`, as sent.

A rebuild uses the stored `build`, so a later turn on the plate never moves the wedge.

**The MCP** works out `build` from the object's orientation and the plate printer's belt angle with `buildDirection` in `src/belt.ts`. A unit test locks that helper to the engine's `mirror_rotate_x` for five turns and three belt angles. The MCP also does the following:
- **The angle.** The default is the support limit, `90° − supportAngle`, which is 45°. A smaller angle is refused with the limit.
- **The echo.** The typed echo carries every default, `build` included, so a `model_edit` of it keeps the pose it was made for. `build: null` aims it from the pose then.
- **The probe.** Each edge gets its case, its path, the far and near faces' angles to the layers, the new face's angle to the layers and to the belt (or bed), the reach, and the volume. The reason says the same in words.
- **The schema.** It is one op branch, an `OP_SUMMARY` line and two lines in the ops guide. The new line puts `tools/list` 25 tokens over its 16,000 budget, which was at 15,999, so the budget is now 16,050.
- **The app.** A history row reads "Print transition 1 edge at 45°, 2 mm". The app has no card yet, so editing the step in the app is refused with the existing "no edit panel" sentence (step 3).

**Refusals,** each a sentence, with the solid unchanged:
- An edge shorter than 0.2 mm, or not between two faces.
- A curved edge or a curved face: "for now", until step 6.
- A convex edge: the sentence points lips to step 4.
- An edge whose faces meet with no corner.
- An edge that already grows at least the asked angle through the layers.
- Both faces looking up the build.
- A far face already at or above the asked angle: "a wedge adds nothing. A steeper angle makes one."
- Both faces flatter than the asked angle: "That is a lip", for step 4.
- A wedge past the far face's end, or up past the near face's end.
- A wedge reaching past `maxMm` (20 mm by default): "Supports or a split are the way here."
- A wedge that meets another part of the solid. The sentence gives the volume it would add and the wedge's own.
- A new face off the asked angle by more than 1°.
- `mode: "cut"`, which comes with lips.
- An angle outside 0–85°, a zero `build`, or a transition inside a group.

**The coupons,** re-measured on this branch: main at `f85055ed` with step 1 merged in. They are step 1's 2 mm shell corners, 20 mm across the belt, sliced alone on the owner's IR3 V2 machine file with PETG, a 0.4 mm nozzle, 0.2 mm layers, Speed and supports off. Main moved after step 1 measured. The bare 20°-past coupon now hangs 1,228 mm with Skin on shallow slopes off, against step 1's 2,450 mm: its outer-wall rows at the bend now hold. With the setting on, it hangs 128 mm, against step 1's 1,343 mm.

Each cell gives the unheld part beads over the whole coupon in mm, with the volume added in brackets. Every coupon also has one gap-fill patch away from the corner (section "As built: step 1"): 111.5 mm on the 20° coupon with Skin on shallow slopes on, 91.9 mm on the 10° coupon, and 110.1 mm on the flat roof. The 1,223.3 mm patch is the inner wall of the hollow roof, layers 159–219, which no wedge reaches.

| Coupon, wedge | Skin on shallow slopes off | Skin on shallow slopes on |
|---|---|---|
| 20° past, none | 1,228.3 (1,223.3 + 5.0 at the bend) | 128.1 |
| 20° past, 2 mm at 45° | **1,223.3** (+17.5 mm³) | **123.0** |
| 20° past, 3 mm at 45° | 1,223.3 (+39.5) | 122.8 |
| 20° past, 5 mm at 45° | 1,223.3 (+109.6) | 275.5 |
| 20° past, 10 mm at 45° | 1,223.3 (+438.4) | 476.3 |
| 20° past, 15 mm at 45° | 1,223.3 (+986.3) | 729.0 |
| 20° past, to the face's end at 45° (29.8 mm, `maxMm: 40`) | 1,223.3 (+3,892.1) | 1,677.2 |
| 20° past, 5 mm at 55° | 1,223.3 (+197.5) | 279.0 |
| 20° past, 5 mm at 65° | 1,223.3 (+344.6) | 291.1 |
| 20° past, 3 mm at 65° | 1,228.3 (+124.1) | 203.6 |
| 10° past, none | 91.9 | 91.9 |
| 10° past, 2 mm or 5 mm | 91.9 (+8.0, +50.3) | 91.9 |
| 10° past, to the face's end | 183.8 (+1,626.2) | 183.8 |
| Flat roof at the limit, none | 110.1 | 110.1 |
| Flat roof, 2 mm or 5 mm at 55° | 110.1 (+8.6, +53.5) | 110.1 |

Print time on the 20°-past coupon, with the setting off: 1,024 s bare, 1,009 s with 2 mm, 972 s with 5 mm, 737 s to the face's end. With it on: 1,316 s, 1,301 s, 1,250 s and 946 s.

**What the numbers say:**
- **A small wedge fixes the bend.** With the setting off, a 2 mm wedge at 45° takes every row a larger one takes, the 5 mm at the bend. With it on, 2 and 3 mm take 5 mm too.
- **A larger wedge makes things worse with Skin on shallow slopes on.** From 5 mm up, the wedge thickens the roof, and the skin rule lays rows inside it that hang: 147 mm at 5 mm, up to 1,645 mm for the full gusset. Section 2's rule, "to the far face's end", is the worst case here.
- **To the face's end also costs on the 10° roof.** It adds a second gap-fill patch of 91.9 mm where the gusset thins the roof's end, as step 1 saw.
- **Steeper is not better.** 55° and 65° wedges hold no more rows than 45° and add more material. A 3 mm wedge at 65° is too short to reach past the bend.
- **The hollow roof is not the corner's.** The 1,223 mm inner-wall patch stays with every wedge, as step 1 found. Skin on shallow slopes is the fix for it, and with it on, only a small wedge is safe.

So the default `size` is **2 mm**, not the far face's end. The probe adds a sentence when Skin on shallow slopes is on and a wedge reaches past 3 mm. `size: "face"` stays for the owner's print and for a solid part with no hollow roof. Its 29.8 mm reach on the 20° coupon is past the 20 mm `maxMm`, so it is refused unless asked for.

**Golden:** 54 of 54 rows are byte-identical to the newest stored run (`bb09342b`). The 6 rows of the company's rear cover were left out of both sides, as in step 1. The slicer is not touched.

**Deviations from sections 4 to 6:**
- **The wedge to a face's end is a prism, not a chamfer.** A chamfer cannot use up a face. Every other wedge goes through the chamfer path.
- **The default size is 2 mm, not "the face's end".** The numbers above are the reason.
- **"Touches another face" is a volume check.** It gives the volume, not the face's name and distance.
- **The belt refusal is not built.** A concave corner on the underside cannot lie on the belt: its near face would have to go below it.
- **Not built yet:** the stale-pose note and Re-aim in `model_describe` (step 3, with the card), and `plan: true` (step 5).

### As built: step 3

**The card.** "Print transition…" is in the Model tab's Features menu, under Split to print. It is a card in the tool pane, built like Split to print's. There is no rail button and no shortcut. From top to bottom, the card shows:
- **Edges.** The card takes the edges picked on the solid: a click picks one, and Shift-click adds or removes one. Opening the card switches the pick filter to Edge. A line under the count says that only straight edges between flat faces work for now.
- **Case: Corner or Lip.** Corner is on. Lip is greyed out, and its tip and the line under it say "Lip: coming in a later version."
- **Material: Add or Cut.** Add is on. Cut is greyed out: "Cut comes with lips, in a later version."
- **Angle to the layers.** The default is the support limit, 90° minus the support angle, which is 45°. An angle under that limit, or over 85°, is refused on the card with a sentence that names the limit.
- **Size.** Either millimetres along the flatter face (2 mm by default) or "To the end of the face". The millimetres stay put while the second choice is on.
- **The source line.** For example, "From this pose on the Ideaformer IR3 V2, belt 45°." On a flat printer it reads "…, its bed."

**One source of truth.** The defaults, the build direction, the stale check, the reading of the probe's rows and the sentences now live in `src/model-transition.ts`. The card and the MCP both use that file:
- The MCP's `bakeTransition` takes the angle limit, the 2 mm size and the build direction from it.
- Its probe sentence and its Skin on shallow slopes check also come from there.
- The build direction is still `buildDirection` in `src/belt.ts`, which step 2 locked to the engine.

**Preview.** The card asks the kernel through the same probe call the MCP uses, 300 ms after the last keystroke, or at once after a pick:
- **The ghost.** When the kernel builds the wedge, a green ghost of it is drawn on the solid. The card lists:
  - the new face's angle to the layers, and to the belt or the bed;
  - the flatter face's angle to the layers;
  - the reach along the flatter face and up the steeper one;
  - the volume added.
- **A refusal.** The kernel's sentence takes the place of the numbers and the ghost, and Apply stays off.
- **Skin on shallow slopes.** With that setting on and a wedge reaching past 3 mm, the card shows the warning the MCP's probe gives, worded for the app.

**Apply and edit.**
- **Apply.** It makes one history row: "Print transition (1 edge), 45°, 2 mm", or "(3 edges)" for three.
- **Edit.** The row's pencil reopens the card on the parent solid, with the step's own numbers, its stored pose, and its edges picked again. Update stays off until something changes. The step then rebuilds as a sibling with the steps after it replayed, as every Model edit does.
- **Aim from this pose.** An edit of a step made for another pose keeps that pose, as `model_edit` keeps the typed echo. The source line says the step was made for another pose, and an "Aim from this pose" button aims the card at the pose the part is in now.
- **The "no edit panel" refusal** is gone for this op.

**A stale pose (decision 5).** A step is stale when its stored build direction is more than 1° from the one the part's current pose and the plate's printer give. The solid never changes by itself. Where it shows:
- **History.** The step's row turns amber, with a warning mark. A note above the rows reads, for example, "1 print transition was made for another pose. On the belt, even a turn about the plate's Z changes the layers. Re-aim it, or keep it as it is." It has two buttons:
  - **Re-aim** rebuilds every stale step on the shown branch with this pose's build direction, in one edit from the earliest stale step, with the steps after it replayed. If a step now refuses, the readout gives the kernel's sentence and the solid stays as it was.
  - **Keep** sends the note away for this pose.
- **Prepare.** The object's row in the object list shows the same note and the same two buttons. Re-aim there opens Model on that object and re-aims once its solid is on screen.
- **The MCP.** `model_describe` gives `notes` and `staleTransitions` (`{node, label, offDeg}`) for each stale step on the shown branch. The note says how to re-aim (`model_edit` with `build: null`). The ops guide says that `model_describe` names such a step.

**Tests:**
- `src/model-transition.test.ts`, in `tools/unit-tests.txt`, covers:
  - the defaults;
  - the stale check: a turn about the plate's Z on the belt, half a degree, a flat bed after the belt, a turn about Z on a flat bed, and another 45° belt;
  - Re-aim and Keep;
  - the card's round trip through a stored op;
  - the probe rows and the wedge's triangles;
  - the history label, and that the step can now be edited.
- `mcp/transition.test.ts` checks the `model_describe` note after a turn, and that it goes when the part turns back.
- `e2e/model-transition.spec.ts`, in `test:smoke`, runs on a synthetic L-shaped part built in the spec: a base with a post at its back, printed upside down. It goes through these steps:
  1. Open the card and pick the corner. The green ghost is 20 × 2 × 2 mm, and the card gives its numbers.
  2. Pick a convex edge. The card shows the refusal, and Apply stays off.
  3. Apply, then edit the step to 50° and Update.
  4. Switch to the IR3 V2 and see the note in Prepare and in History.
  5. Re-aim in a pose where the wall is too flat, which is refused with its sentence.
  6. Turn the part about Z, then Re-aim, which works.
  7. Turn again and Keep.

**Golden.** The slicer is not touched.
- Before main moved, the branch was 60 of 60 byte-identical to the newest stored run (`fb5d7053`), with the rear cover included.
- After merging main at `92da7c3f` (#500, gap fill under lightning), 51 rows are byte-identical. The other 9 are #500's: slope_ramp, the Baby Dragon and the rear cover, each under speed, region and grid.
- The branch's slicer, tools and samples differ from `92da7c3f` only in `tools/unit-tests.txt`, so this run is stored as main's baseline at `92da7c3f`.

**Deviations from section 5 and decision 5:**
- **No tangent chains.** A click takes one straight edge, and Shift-click adds edges. Chains, and the rule that a second click takes the single edge, come with step 6.
- **The case and Cut can't be changed yet.** Lip and Cut are shown, greyed out, with the version they come in.
- **The ghost is drawn by the app.** The app draws it from the probe's rows: the edge, the two faces, and the reach along each. The kernel does not send a mesh. Its triangle is the wedge's own section, for the chamfer path and the prism path alike.
- **The angles are on the card, not written on the ghost.** They sit next to it in the card's numbers.
- **The history row is "Print transition (1 edge), 45°, 2 mm".** The plan's "(3 edges)" form keeps the angle and size step 2 put in the label.
- **Stale means the layers turned, not that the printer's name changed.** Another printer with the same build direction (another 45° belt) leaves the step as it is, because its layers are the same.
- **Keep lasts for the session.** It is not saved in the project, so reopening the project shows the note again.
- **Prepare's Re-aim goes through Model.** It needs the modeler, so it opens Model on the object first.
- **The Skin on shallow slopes warning is worded for the app.** The trigger is the same as the MCP's, but the sentence does not name the MCP's `standsOnNothing` field.

### As built: step 4

**What a lip is, to the op.** A straight, convex edge between two flat faces that is the lowest point of both faces along the build, and whose flatter face (the underside) grows flatter to the layers than the angle asked. Its first rows appear all at once. The op now finds each edge's case by itself: a convex edge like that is a lip, a concave edge is a corner (step 2, unchanged). `case: "lip"` or `"corner"` overrides what was found.

**The gusset (Add, the default for a lip).** It is built from the lip's underside, as section 4 says:
1. The underside is swept down the build by `maxMm`.
2. Only the side of a plane through the lip's edge, at the angle asked, that faces the part is kept.
3. The solid is subtracted, and the piece that holds a point just under the edge is kept.
4. **Landing check.** Every lowest point of that piece, along the build, must lie on the part. If one hangs in the air, or the piece reaches `maxMm` down, the op refuses: "There is nothing of the part under this lip within 20 mm along the build, so a gusset would itself start in the air. Supports or a split are the way here, or a larger maxMm." Only the lowest points matter: every other row of the gusset stands on the gusset's row before.
5. The piece is fused on, and the volume check of step 2 runs: the solid grows by the piece's own volume. One new edge must border a face at the angle asked.

This handles a lip off a wall and a lip over a floor alike: over a floor, the gusset fills down to the floor from where its face meets it.

**The ramp (Cut).** `mode: "cut"` turns the underside into a ramp from the lip's root up to the lip's front face, at the angle asked. It is a triangular prism along the edge, cut away. It is refused when it would leave less than `floorMm` of the front face above it: "A ramp at 45° from the lip's root would leave 0.50 mm at this lip's first edge, under the 0.8 mm wall floor (twice the nozzle). A gusset (mode add) keeps the lip whole." A ramp that would come out through the top says it would cut through the lip. The removed volume must be the ramp's own, or it ran into another part of the solid.

**`mode: "auto"`** adds: a wedge for a corner, a gusset for a lip. Cut is never chosen by itself. Cut on a corner is refused: "Cut is for a lip."

**A lip picked at its root.** Its concave root edge is a corner by default. With `case: "lip"`, the op finds the lip's first edge, the far edge of the flatter face, straight and parallel, and builds the lip from there.

**What the step stores.** As step 2, plus `case`, and `floorMm` for a cut. When every edge was found a lip, the kernel stores `case: "lip"`, so the history row reads "Print transition (1 lip), 45°", or "Print transition (1 lip), cut, 45°". A mixed step keeps "Print transition (2 edges), 45°, 2 mm".

**The probe.** Each lip row has `case: "lip"`, `path` (`gusset` or `ramp`), `material` (`add` or `cut`), `firstEdge`, the underside's and front face's angles to the layers, `depthMm` (along the underside), `heightMm` (down the build), `landingMm` (a gusset's lowest point from the edge), `leftMm` and `floorMm` (a ramp's), and the volume. The kernel also sends the gusset's or ramp's triangles (`soup`) for the app's ghost; the MCP leaves them out of its reply.

**The MCP.**
- `floorMm` defaults to twice the plate machine's nozzle and is sent only with a cut. `case` passes through.
- The probe sentence names a lip: "Edge 10: a lip 6 mm deep, its underside at 0° to the layers. The gusset runs back into the part at 45° to the layers and 0° to the belt, 3 mm down the build, landing 4.24 mm from the edge and adding 180 mm³."
- The Skin on shallow slopes warning still reads only corners' reach.
- **Schema.** One more enum (`case`) and `floorMm` on the op branch, a longer `OP_SUMMARY` line, and one more line in the ops guide. `tools/list` is at about 16,049 tokens, inside the 16,050 budget, so the budget is not raised.
- **A bug fixed on the way.** `OP_WORDS`, the enum words an op may hold as text, was filled before the partition and transition kinds were added to the schema. `case: "lip"` was then read as an expression and refused as "not a parameter". It is filled again after those kinds are added.

**The card.**
- **Case.** Corner and Lip are both live. With no choice made, the button of the case the kernel found is pressed, and a line says what was found: "Found a lip.", or "Found 1 lip and 2 corners." Clicking the other case overrides it ("Found a corner; set to Lip."). Clicking the found case goes back to finding it. Picking other edges finds them again.
- **Material: Add or Cut** appears only while the case is a lip. With Cut on, a line says the ramp keeps at least the wall floor, twice the nozzle.
- **Size** is shown for a corner only: a gusset runs back to the part and a ramp to the lip's edge.
- **Numbers.** For a lip, "Flatter face" reads "Underside" with the lip's depth, and "Reach" reads "Gusset" (how far down the build, and where it lands) or "Ramp" (what it leaves at the first edge). The volume reads "+180 mm³ added" or "−180 mm³ removed".
- **Ghost.** Green for added, red for cut. A cut lies inside the solid, so it is drawn through it.
- A refusal shows the kernel's sentence in place of the numbers, and Apply stays off, as in step 3.

**Tests.**
- Kernel (`crates/lime-model-occt/tests/transition.rs`): the step 1 lip coupon with gussets at 45° (180 mm³, 3 mm down the build, landing 4.24 mm away) and 55° (211.8 mm³); the lip from its root with `case: "lip"`; the cut (180 mm³, 6 mm left), refused under a typed 7 mm floor, on a 0.5 mm lip under the 0.8 mm floor, and at 55° through the thin lip; a lip then a fillet on its first edge, then the gusset rebuilt; shelves 4, 10 and 18 mm deep on a flat bed; a 25 mm shelf refused with nothing under it within 20 mm and within 40 mm, and the same shelf over a floor, which lands; a corner and a lip in one step; the Corner case on a lip refused.
- MCP: `mcp/transition.test.ts` (the case and the floor sent, the schema) and `mcp/occt.test.ts` (the lip coupon through the real kernel: the gusset, its sentence, the cut, the floor refusal, Apply and the history row).
- `src/model-transition.test.ts`: the floor, the card's round trip with a cut, the case shown, the lip rows and sentences, the history rows.
- `e2e/model-transition-lip.spec.ts`, in `test:smoke`: a synthetic wall and shelf built in the spec. It finds the lip, previews the gusset, cuts, refuses a ramp at 50° under the floor, applies, edits to a cut, and changes the case at the root. `e2e/model-transition.spec.ts` now expects the card without the greyed Lip and Cut.

**The coupon.** Step 1's lip coupon (a post with a 6 mm lip, its underside in one layer), 20 mm across the belt, sliced alone on the owner's IR3 V2 machine file with PETG, a 0.4 mm nozzle, 0.2 mm layers, Speed and supports off. The transitions were made with the op through the MCP:

| Lip coupon | Unheld part beads | Longest span over nothing | Volume | Print time |
|---|---|---|---|---|
| No transition | 375.4 mm (275.2 at the lip) | 19.5 mm: the lip's first row, the whole width | — | 426 s |
| Gusset at 45° | 100.2 mm | 2.3 mm | +180 mm³ | 414 s |
| Gusset at 55° | 100.2 mm | 2.3 mm | +211.7 mm³ | 415 s |
| Cut at 45° (6 mm left) | 100.2 mm | 2.3 mm | −180 mm³ | 405 s |
| Cut at 55° (5.25 mm left) | 100.2 mm | 2.3 mm | −211.7 mm³ | 404 s |

The 100.2 mm left in every row is step 1's gap-fill patch on the last-printed top corner, away from the lip (layers 124–125). With Skin on shallow slopes on, every row measured the same: this solid coupon has no thin roof for that rule to fill.

**What the numbers say:** a gusset or a ramp at 45° takes every hanging row of the lip, and its 19.5 mm span over nothing. 55° holds no more. The ramp also saves material and time; the gusset keeps the lip's shape and adds 4 % of volume.

**Golden.** 60 of 60 rows are byte-identical to the newest stored run, main at `92da7c3f`, rear cover and Baby Dragon included. The slicer is not touched.

**Deviations from sections 2 to 6 and decision 4:**
- **Size does not apply to a lip.** A gusset runs back to the part, and a ramp to the lip's first edge. `size` stays a corner's.
- **`maxMm` is the gusset's depth down the build** for a lip, not its reach along a face.
- **The case is one field for the whole step**, not one per edge. With none given, each edge's case is found; a typed case applies to every edge. A step of only lips is stored with `case: "lip"`.
- **`floorMm` is a new op field.** The plan says the floor is twice the nozzle; the kernel does not know the nozzle, so the MCP and the app send it, and the step keeps it.
- **The wall floor is measured along the front face** at the lip's first edge, which is the thinnest place a ramp leaves on a square lip.
- **The ramp runs flush with the lip's ends**, like a corner's wedge. Section 4's rule for cuts at ends with walls is not built; a cut that would notch something else fails the volume check instead.
- **The belt refusal is still not built.** A lip edge on the belt would need the plate pose, which the kernel does not have.
- **The landing check reads the gusset's lowest points**, not "touches the part somewhere other than the lip": the lowest rows are the only rows that have no gusset row under them.
- **Chains and curved lips** stay for step 6.

### As built: step 5

**The finder** is in the kernel, `crates/lime-model-occt/src/tree/transition_find.rs`, reached by a new call, `transitionFind`. It reads the solid's own faces and edges against the build direction and the support limit. Nothing is sliced, so it is instant in Model. It lists:
- **Corners:** straight concave edges between flat faces. The steeper face holds its own rows, and the flatter face is past the limit or within 3° of it.
- **Lips:** straight convex edges between flat faces, above the belt or the bed. Both faces rise away from the edge in build order, so nothing of either is laid before it there, and the flatter face is at or within 0.5° of the limit, or past it. This is section 2's "both faces rise away from it", read at the edge. It also finds a lip that starts past a hole in a larger face, whose face goes on lower along the build beyond the hole. Each underside lists one lip, its longest such edge: its other edges lie in the same layer, and one gusset from that edge holds every row born with it.

It leaves out:
- an edge on the belt or the bed (within 0.05 mm of the solid's lowest point along the plate's up);
- an edge that climbs through the layers at least as steeply as the limit, since every face through it holds;
- seams, open edges and edges shorter than 0.2 mm;
- points, such as a cone's tip, which are not edges.

**Curved edges are not listed.** An edge on a curved face, or a curved edge, that looks as if it starts in the air at its middle is counted instead. The card says "3 curved edges skipped until a later version." The MCP gives the count and the edges' indexes.

**Each row's fix is the op itself.** The kernel probes `{kind: "transition", edges: [edge], mode: "auto", angleDeg, size}` on the row's one edge, exactly as section 6's input shape, and the row keeps the probe's answer: the wedge's numbers, or its sentence. The finder decides nothing about what can be built. With step 4 merged, a lip's row builds its gusset with no change here: on the lip coupon, Find lists the lip, and its Fix adds 360 mm³ as one step, "Print transition (1 lip), 45°". The corner at the lip's root is listed too, as step 4 reads it, and its wedge refuses.

**The card.** "Find edges that start in the air" is the first button on the Print transition card:
- **The status line.** For example, "4 edges start in the air: 2 corners and 2 lips, longest first. 2 fixes build; 2 refuse, each saying why." With none: "No straight edge starts in the air in this pose."
- **One row per edge, longest first.** Each row shows the case, the length, and the fix with its size and the volume it adds, such as "Wedge, 2 mm at 45°, +40 mm³" or, for a lip, "Gusset at 45°, +360 mm³". A fix that refuses shows the kernel's sentence under the row, and its Fix button is off.
- **Hover.** Every listed edge is outlined amber on the solid. The row under the pointer, or under the keyboard focus, draws its edge bold, and its wedge in green when it builds.
- **Fix** applies that row as its own history step.
- **Fix all (N)** applies every row whose fix builds as one step, "Print transition (N edges)" (decision 9). Its pencil reopens the card with those edges picked, and Shift-click drops one.
- **After a Fix,** the card opens again on the new solid and finds again, so the list shows what is left.
- **Clicking a row's text** picks that edge alone, and the card checks it as a click on the edge would.

**The MCP.** `model_probe {op: {kind: "transition"}, plan: true}` returns:
- `rows`, each `{edges, case, lengthMm, at, fix, refused?}`, with `volumeMm3` when the fix builds. `at` is the edge's middle in model space, and `fix` is the op for that edge alone.
- `op`, the one ready op that holds every row that builds.
- `curvedSkipped` and `curvedEdges`.

`angleDeg`, `size` and `maxMm` may be typed; any other field is refused. The guide has one more line, and the `plan` field's description names the transition. That adds 11 tokens to a `tools/list` that was at 16,049, so the budget goes from 16,050 to 16,060. `OP_SUMMARY` is left as step 4 wrote it.

**Fixes found on the way:**
- **Words in a transition op.** The MCP read `mode: "auto"` and `size: "face"` as parameter names, because its list of words was made before the transition branch was added. Step 4 (#503) fixed the list for enums such as `mode` and `case`; this step keeps that fix and adds the one-word choices a schema gives as a constant, such as `size: "face"`, which still failed. Kind names stay out of the list.
- **A wedge along a face at the limit.** When the steeper face was exactly at the angle asked, the corner op answered with a reach of 10¹⁶ mm. It now says the wedge would run along that face, and that a steeper angle makes one. The shell coupon's inner wall, which looks toward +Y at exactly 45°, has such a corner.

**Tests:**
- `crates/lime-model-occt/tests/transition_find.rs`, on the belt and on a flat bed:
  - a corner past the limit, whose 2 mm wedge builds, and the inner wall's corner at the limit, whose fix now says the wedge would run along that wall;
  - a corner at the limit, listed with its refusal;
  - a corner that holds, not listed;
  - a lip whose gusset builds, one lip for its underside, and the corner at its root;
  - a lip past a hole in a plate parallel to the belt, and no row at the hole's near edge;
  - a box on the belt and on the bed, with nothing listed;
  - a cone's tip hanging under a plate on a leg: nothing listed under the plate where the cone is, and the circle where the cone meets the plate counted as curved.
- `src/model-transition.test.ts`: the request, the rows read and sorted, Fix all's edges, the fix op and the sentences.
- `mcp/transition.test.ts`, against the stand-in engine: the request, the row shape, the ready op, the refusals, a typed size and angle, and the flat bed.
- `mcp/occt.test.ts`, against the real kernel: the shell coupon lists the bend with a 2 mm wedge that builds, and the inner wall's corner with its sentence.
- `e2e/model-transition-find.spec.ts`, in `test:smoke`, on a synthetic U printed upside down: find, an empty result upright, hover, Fix one, Undo, Fix all, the step's edit, and Undo.

**The owner's housing,** read only, posed mouth down on the IR3 V2 as in `20261028_12_3_housing-pain.lime`. The app's request and the MCP's give the same build direction, (−0.707, 0, −0.707) in the part's frame. Finding with every row's fix probed took 0.1 s at 45° and 2.6 s at 55°, where more fixes build far enough to be checked.
- **With the project's support angle, 70°** (limit 20° to the layers): 1 row, a 126 mm lip at the end wall, 0.5 mm above the belt. 3 curved edges were skipped.
- **With the default support angle, 45°:** 11 rows, 7 corners and 4 lips. 27 curved edges were skipped.
  - **Every corner is at the limit.** Its flatter face is the flat roof at 45°, so its fix at 45° refuses: "a wedge adds nothing. A steeper angle makes one."
  - **At 55°,** 1 of the 11 fixes builds (+25.5 mm³). The others refuse with their sentences: the wedge would run into another part of the solid, past the flatter face's end, or both faces are flatter than 55°.
  - **The lips** refuse with step 4's sentences. At 45°, their undersides lie at the limit, so their rows hold. At 55°, nothing of the part lies under them within 20 mm, so a gusset would itself start in the air.
- **The cutout lip is among the rows.** It is a 45.4 mm lip at X −58: the far edge of the cutout in build order, where the plate around the cutout starts again with nothing under it. A test of "the lowest point of both faces" missed it, because that face goes on lower beyond the cutout. The finder now tests whether both faces rise away from the edge, as section 2 words it, and lists it. The screenshot is in the PR.
- **The down-ramp's bend is not among the rows.** The ramp's inner roof is 22.6° to the layers. The bend where it meets the 45° roof is concave, so it would be a corner. But Open CASCADE reads that edge, or its faces, as curved, because the STEP file stores them as B-splines. It is one of the 27 curved edges skipped, and the op refuses it for the same reason. With the project's 70° support angle, the ramp is past the 20° limit anyway.

**Golden:** 60 of 60 rows are byte-identical to the newest stored run (`92da7c3f`), the rear cover and the Baby Dragon included. The slicer is not touched. Main at `ae8aad72` (#502) differs from `92da7c3f` only in `tools/unit-tests.txt`, so the run is also stored as main's baseline there.

**Deviations from sections 5 and 6, and from decision 9:**
- **The finder is in the kernel, not in the app.** The app has no face beside each edge; the kernel has, with each surface's kind.
- **One angle and one size for every row.** Each row proposes the card's angle and size, 45° and 2 mm by default, so Fix all is one op. A corner at the limit therefore refuses at 45°; typing a steeper angle and finding again makes it build. Step 1's coupons showed such a corner holds anyway.
- **Lips are listed at or within 0.5° of the limit.** The plan says "past the limit". An edge across the belt whose faces both rise from it is born at once even when its flatter face lies exactly at the limit.
- **"The lowest point of their faces" is read at the edge.** Both faces must rise away from the edge, not lie wholly above it, so a lip past a hole is found (the housing's cutout).
- **"Curved" means what Open CASCADE reads.** A flat face that a STEP file stores as a B-spline counts as curved, as in the op.
- **Rows sharing a chain are not merged.** Each row is one edge, until chains come in step 6.
- **One lip per underside.** Only the longest lip edge of each underside is listed; its sides can still be picked by hand.
- **After a change of angle, size or pose, the list stays, with a note,** and its Fix buttons wait for Find again.
- **The list is hidden while a step is edited.** An edit works on that step's own edges.

## 8. Risks

- **The limit itself.** At 45° to the layers, the new face sits exactly where the housing's flat roof sat. If the coupon still shows unheld rows on the face at 45°, the default goes steeper (decision 2). The corner at the limit is the case most at risk: what fails there may be the slicer's handling of a limit face, not geometry. The coupon study runs first for that reason.
- **Function.** A wedge changes the part: it can block a mating face, a cable path or a screw. The preview and the "touches another face" refusal limit this. The owner still has to judge the company's parts.
- **Topology after a boolean.** A fuse merges faces that end up on one surface (the house rule for pocket and boss). A later step that named such a face re-finds it by kind and normal. Tests cover a transition followed by a fillet.
- **Open CASCADE chamfers fail on busy topology.** The prism fallback covers that. A failure names the step, as other blends do.
- **False positives on curved faces.** Auto-find reads B-rep faces, not triangles. A cylinder near the limit is sampled along the edge, and only runs longer than 2 mm are listed.
- **A stale pose.** The warning keeps the solid honest, but a user who ignores it prints transitions for another pose. Prepare shows the note until it is re-aimed or kept.
- **The hand of the belt frame.** The engine mirrors Y before rotating. The shared helper and its test exist so the operator cannot aim the wedge at the wrong side.

## 9. Steps

Each step ships on its own, on its numbers.

| Step | What | Ships as | Golden |
|---|---|---|---|
| **1. The check and the coupon study** | Part beads that stand on nothing, in the slice audit, with tests on synthetic parts. Coupons built by hand with today's ops (chamfer with a computed angle, extrude), sliced at 45° and 55°. The owner prints one sheet. The findings go into this plan. | One PR: the audit field and its tests. | Byte-identical. |
| **2. Corners on straight edges** | `Op::Transition` in the kernel: the corner wedge through the chamfer path, with stored `b`, the refusals and kernel tests. The MCP op kind, the probe and the guide entry. | One PR. | Byte-identical. |
| **3. The card** | The Model-tab card, preview, history row, edit, and the stale-pose note in Model and Prepare. Playwright specs with screenshots. | One PR. | Byte-identical. |
| **4. Lips** | The gusset from the lip's underside through the prism path, landing check, Cut for thick lips. | One PR. | Byte-identical. |
| **5. Auto-find** | The geometric finder, the list with Fix and Fix all, and `plan:true` in the MCP. | One PR. | Byte-identical. |
| **6. Curves, chains and the slice cross-check** | Curved edges and tangent chains through the pipe with a fixed binormal, mitred corners in chains, and walls at ends. After a slice, each unheld patch is mapped to the nearest model edge, and that edge's row reads "seen in the slice". | One or two PRs. | Byte-identical. |

Steps 2 and 3 make the required corner fix usable. Step 4 is the wanted lip fix.

## 10. Decisions for the owner

| # | Question | Proposal |
|---|---|---|
| 1 | What does "45° in the belt frame" mean for the operator's number? | The angle between the new face and the layers, which is what the slicer judges. The preview also shows the face's angle to the belt, because "45° to the belt" is a wall or a face born at once, depending on its lean (section 1). |
| 2 | Default angle? | The support angle, 45° to the layers, unless the coupon study shows unheld rows on it. In that case 55°. |
| 3 | Corner fix: added wedge, cut chamfer, or round fillet? | An added flat wedge on the inner side of the bend. A cut thins the other skin and misses the hanging rows. A fillet ends as flat as the face it fixes. |
| 4 | Lip fix: added or cut? | Added gusset by default. Cut is offered for a lip thick enough to keep the wall floor on top. |
| 5 | What happens to a transition when the pose or printer changes? | The step keeps the pose it was made for, the app warns in history and Prepare, and Re-aim is one click. It never re-aims silently. |
| 6 | Belt only, or any printer? | Any printer, using that printer's build direction. On a flat bed, it is a 45° chamfer under an overhang. It is called "Print transition", not "Belt transition". |
| 7 | Auto-find from geometry, or from a slice? | Geometry, instant in Model, now. A slice cross-check comes in step 6, using the stands-on-nothing check. |
| 8 | Where does the stands-on-nothing check live? | In the engine's slice audit, so tests and the MCP use one rule. It does not stay a script. |
| 9 | Fix all: one step or one per edge? | Fix makes one step per row. Fix all makes one step, edited per edge in its card. |
| 10 | Size limit? | 20 mm by default, typed per step. Past it, the operator refuses and points to supports or a split. |
| 11 | Order? | Step 1 first, on the owner's go. The corner fix (steps 2 and 3) is built only after the coupon numbers are in. |
