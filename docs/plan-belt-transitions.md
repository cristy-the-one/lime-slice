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
