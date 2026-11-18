# Plan: the whole part, not one wall

Status: study only. No feature code. Written 2026-11-18 against `feature/ribs-next` at 8486f501 (v6.11.0, CI on pull requests into this branch). The measurements are on `ribs-next/c-probe` at a3e81a80. That branch is pushed for review and is not to be merged: it adds a test probe and makes three planner modules visible to the crate only while tests build. This document is the only change on the branch that is merged.

The question, from the handover §4C: does the shell solver model a folded thin-walled part, and if it does, which of the three routes do we build, and what does a rib do at a crease?

Evidence marks: **[probe]** measured on this machine with `cargo test -p lime-sim --release`, synthetic geometry only; **[read]** the source.

Material throughout: E = 2000 MPa, ν = 0.3, pressure 0.01 MPa. Units mm, N, MPa. Compliance is the work of the loads, N·mm. `w` is the downward displacement of the watched point. The solid is quadratic tetrahedra (`Tet10`) through `solve_request`. The shell is the Allman membrane plus the discrete Kirchhoff triangle, drilling penalty α = 0.01 unless a row says otherwise.

## The short answer

Build option 1, the folded shell. On an open box the shell's floor-centre deflection is 2.7% above the best solid mesh at the same pressure, and on a cover with walls and a rim it is 6.1% above. A flat plate of the same thickness, where the geometry really is the same, agrees to 1.0%. The drilling penalty is not the mechanism: sweeping α from 10⁻⁴ to 1 moves the box by 0.001%.

A rib at a crease crosses it and runs on to a hold. A rib that stops at the crease keeps about half of that compliance drop. A rib laid along the crease is the worst of the three: three times the material of a single floor rib, for a 5% change in deflection.

The solver can already do this. The planner and the wall extractor cannot. `Surface::neighbour` returns one triangle across an edge, a heading into a 90° fold stops or runs along the crease, and of 13 candidate lines on a right-angle fold none had a point on both faces. On the cover, with the walls free to move, the planner at the finer mesh returned no ribs.

## How the parts were built

All of these are synthetic. No company geometry.

- **Open box.** Outer skin 100 × 60 × 30 mm, walls 2 mm, open at the top. The centre-line shell puts the floor on z = 1 between the wall centre-lines (x from 1 to 99, y from 1 to 59) and the walls on those centre-lines up to z = 30, normals inward, rim clamped. The through-floor shell uses the full 100 × 60 floor and lets the walls meet it as a T-junction. The solid is non-overlapping: floor z from 0 to 2 over the whole plan, the two x-walls own the corners, the y-walls are inset by 2 mm. Its volume is 29472 mm³, checked on every mesh. Pressure is on the floor only. The solid is loaded on the inner face z = 2 inside the cavity (96 × 56 mm). The watched point is (50, 30, 1).
- **Clean L**, used because a box corner is a 2 × 2 column in the solid and a single vertex in the shell. Floor 40 × 24 at z = 0, wall at y = 0 up to z = 20, thickness 2 centred on those planes. The solid is the union of a 42 × 26 × 2 slab from (−1, −1, −1) and a 42 × 2 × 19 wall from z = 1 to 20. Volume 3780 mm³. Same force on both, 9.600 N. Top edge clamped. Watched point (20, 12, 0).
- **Plate**, the control that the two solvers agree when nothing is folded. 100 × 60 × 2, mid-surface z = 0, solid from z = −1 to 1, all four edges clamped, pressure downward.
- **Cover.** Belly 80 × 48, walls rising 12 mm above the floor slab, rim 6 mm, all 2 mm. The shell meets on centre-lines: belly x from 1 to 79, y from 1 to 47, z = 1, walls to z = 13, rim outward 6 mm, outer rim clamped. The solid is butt-joined slabs, volume 16992 mm³, rim outer face 6 mm past the belly. Pressure on the belly only. The shell's loaded area is 78 × 46 = 3588 mm² (force 35.88 N). The solid's inner face, inset by the wall thickness, is 76 × 44 = 3344 mm² (force 33.44 N). That 1 mm a side is the centre-line against the inner face.

The finest solid of the box (296325 nodes) and of the L (275301 nodes) are over the solver's 200000-node cap and were not run. The cover's finest solid, 171445 nodes, did run.

## 1. Stiffness of a fold

### The plate, so the comparison means something [probe]

| Model | Mesh | dofs | w, mm | C, N·mm | against the h = 1 shell |
|---|---|---:|---:|---:|---:|
| Shell | h = 3.85 | 2250 | 0.20934 | 4.1212 | +0.38% |
| Shell | h = 2 | 8526 | 0.20870 | 4.1056 | +0.08% |
| Shell | h = 1 | 35046 | 0.20853 | 4.1012 | |
| Shell, Richardson, order 1.95 | | | 0.20846 | | |
| Tet10 | 4 mm, 1 through | 12789 | 0.20485 | 4.0100 | −1.76% |
| Tet10 | 2 mm, 2 through | 87615 | 0.20973 | 4.1366 | +0.58% |
| Tet10 | 1 mm, 2 through | 355215 | 0.21067 | 4.1621 | +1.03% |
| Tet10 | 2 mm, 4 through | 157707 | 0.20990 | 4.1411 | +0.66% |

Changing the drilling penalty from 10⁻⁴ to 1 on the h = 2 plate moves w by 0.000%. The two solvers agree to about 1% on a flat wall. One element through the thickness is 1.8% stiff, which is the bias to expect from a coarse solid, not a failure.

### The box [probe]

| Model | Mesh | nodes | dofs | w, mm | C, N·mm | force, N | solve, s |
|---|---|---:|---:|---:|---:|---:|---:|
| Centre-line shell | h = 4 | 1131 | 6282 | 0.30653 | 6.6287 | 56.84 | 0.022 |
| Centre-line shell | h = 2 | 4141 | 23886 | 0.30618 | 6.6339 | 56.84 | 0.112 |
| Centre-line shell | h = 1 | 15201 | 89334 | 0.30608 | 6.6355 | 56.84 | 0.527 |
| Centre-line, Richardson, order 1.90 | | | | 0.30605 | | | |
| Through-floor shell | h = 4 | 1255 | 7002 | 0.30529 | 6.5918 | 60.00 | 0.025 |
| Through-floor shell | h = 2 | 4373 | 25254 | 0.30493 | 6.5968 | 60.00 | 0.112 |
| Through-floor shell | h = 1 | 15641 | 91950 | 0.30484 | 6.5983 | 60.00 | 0.546 |
| Through-floor, Richardson, order 1.89 | | | | 0.30480 | | | |
| Tet10 | 2 mm, 1 through | 44691 | 131265 | 0.29231 | 6.2426 | 53.76 | 2.02 |
| Tet10 | 2 mm in plane, 2 through | 75341 | 221319 | 0.29790 | 6.3878 | 53.76 | 5.14 |
| Tet10 | 1 mm, 2 through | 296325 | | skipped, over the node cap | | | |

The shell has converged: from h = 4 to h = 1 the centre moves 0.15%. Membrane energy is 1.7% of the total, so the fold is bending. Against the best solid that ran, at the same pressure:

| Shell | Δw | ΔC |
|---|---:|---:|
| Centre-line, h = 1 | +2.7% | +3.9% |
| Through-floor, h = 1 | +2.3% | +3.3% |

The loaded areas are 5684, 6000 and 5376 mm², so the forces differ by up to 12%. The same-pressure centre deflection is the number the comparison asked for, and it is inside 3%. The solid itself moved +1.9% when a second element was put through the wall, and the next mesh did not fit. The gap is the same size as the solid's last step.

The through-floor shell, which carries the T-junction the centre-line shell does not, is 0.4% stiffer at the centre than the centre-line shell even though it is loaded on a larger floor. The element accepts three triangles on one edge.

### Drilling [probe]

Centre-line box, h = 2, Allman membrane. The reference is α = 10⁻².

| α | w, mm | against α = 10⁻² | C against α = 10⁻² |
|---|---:|---:|---:|
| 10⁻⁴ | 0.306176 | +0.000% | +0.000% |
| 10⁻³ | 0.306176 | +0.000% | +0.000% |
| 10⁻² | 0.306176 | | |
| 10⁻¹ | 0.306175 | −0.000% | −0.001% |
| 1 | 0.306172 | −0.001% | −0.002% |
| CST, α = 10⁻² | 0.306168 | −0.002% | −0.007% |

On the clean L the same sweep, α = 1 against α = 10⁻², moves w by −0.004%.

The fold does not depend on the drilling penalty. Adjacent plates share a node, and that node has one rotation vector in global axes, so the bending rotation of the wall is the same unknown as the drilling rotation of the floor. The penalty only ties that rotation to the membrane's in-plane spin. With membrane energy at 1.7%, tying it harder changes nothing measurable. Leave α at 0.01. Do not remove the web rotation ψ; nothing here touches it.

### The clean L [probe]

| Model | Mesh | dofs | w, mm | C, N·mm | solve, s |
|---|---|---:|---:|---:|---:|
| Shell | h = 4 | 792 | 0.58464 | 5.7343 | 0.002 |
| Shell | h = 2 | 2772 | 0.58445 | 5.7261 | 0.009 |
| Shell | h = 1 | 10824 | 0.58447 | 5.7247 | 0.037 |
| Tet10 | h = 1, two through the wall | 114750 | 0.54101 | 5.2936 | 2.31 |
| Tet10 | h = 0.5 | 275301 nodes | skipped, over the node cap | | |

Same force, 9.600 N. The shell is 8.0% more flexible at the centre and 8.1% higher in compliance. It is mesh-converged (h = 4 to h = 1 moves w by 0.03%). The solid has one mesh, an energy error of 6.5%, and a slab that is 42 × 26 against the shell's 40 × 24, a 1 mm flange on every side, with the wall 42 mm wide. That flange is the extra stiffness. This is the largest gap in the study, and it is inside 10%. The box, which is the part the handover named, is the closer comparison.

## 2. Creases in the model

### Where averaged vertex normals are used [read]

The shell stiffness does not read them. Membrane and plate elements are built in each triangle's own frame. A fold is coupled only by the shared nodes.

1. `ShellModel::new` (`model.rs`, the loop that accumulates `scale(tri.frame.normal, tri.area)` and then normalises). The area-weighted mean of the triangles around the vertex.
2. `layout_of`, the rib web axis: `lateral = cross(n, tangent)`, which sets the direction of the extra web rotation ψ.
3. `rib_element_in`, the rib foot and the web offset, both `scale(n, …)` along that vertex normal, and the beam's "up" direction, the sum of the two endpoint normals.
4. `Field::new` (`field.rs`), a second copy of the same average, used as the vertex frame the cross field is carried in. At a crease that frame lies on the area-weighted bisector.
5. `rib-wall.ts`, the same average again, for the thickness ray and for the mid-surface offset: each vertex is moved half the thickness along it, or half the median where the vertex is flagged thick.

### Where `Surface::neighbour` is used [read]

`neighbour(t, k)` returns the first other triangle on local edge `k` (`find`). Callers:

1. `field.rs`, the dual graph of the cross-field smooth. The third triangle on an edge is never a neighbour.
2. `trace.rs`, `next_triangle`, when a ray leaves through an edge rather than a corner.
3. `trace.rs`, `straight_to`, the same lookup for a straight continuation.

`boundary_flags` and `boundary_loops` treat an edge as a boundary only when it has exactly one triangle, so a three-triangle edge is interior.

### What a 90° fold does [probe]

Two faces share the edge. On the L, all 20 fold-edge sides point back at each other: the two-face case is symmetric.

A heading square into the crease stops on it. With confidence turned off so the trace follows the given direction, it runs from (21.33, 6.67, 0) to (21.33, 0, 0) and ends. The projection of that heading onto the wall is zero, because the heading is the wall's normal, and the trace stops with a turn. A heading at a diagonal, (0.2, −1, 0) normalised, reaches the crease and then runs along it to (40, 0, 0). Its highest z is 0. The component aimed across the edge has an in-plane fraction of 0.000 in the next triangle's frame, so the cross-field connection, which measures the other frame's first axis inside this plane, cannot carry a direction that crosses the fold. On the four fold edges that were printed, that across-edge heading landed in the next plane with in-plane fraction 0.000.

The field-directed traces, confidence left on, also end on the crease. The candidate lines seeded from the solved field: 13 of them, 6 with points only on the floor, 7 only on the wall, none with a point on both.

The vertex normal on a crease is the area-weighted mean, which is the angle bisector only when the two faces contribute the same area. Mid-edge on the box, equal areas: (0, 0.7071, 0.7071), 45° to the floor and 45° to the wall. On the L, floor 40 × 24 against wall 40 × 20: (0, 0.6402, 0.7682), 39.81° from +z and 50.19° from +y. A rib foot offset by t/2 along the unit bisector has a component t/(2√2) = 0.71 mm normal to each face, against the 1 mm a face-normal offset would give. The crease vertex of the mid-surface in `rib-wall.ts` is short of the miter by the same amount.

### A box corner, three faces at one vertex [probe]

The corner (1, 1, 1) has normal (0.5317, 0.5989, 0.5989): 53.21° from +z, 57.88° from +x, 53.21° from +y. An equal-area bisector would be 54.74° from each axis. The corner is pulled toward whichever incident triangles are larger. One rotation vector serves three plates, which the shell matrix allows. A rib or a cross-field frame built on this normal stands on none of the three faces.

### A T-junction, three triangles on one edge [probe]

The through-floor box at h = 8 has 108 edges with one triangle, 804 with two, and 60 with three. On a five-vertex mesh with three triangles on edge 0–1, `neighbour` pairs triangle 0 with 1 and triangle 1 with 0; triangle 2's only answer is 0. The third face is invisible to the smooth and to an edge-crossing trace. The solver does not use this lookup. That five-vertex shell solved: 15 free degrees of freedom, tip displacement −4.64×10⁻⁴ mm under 1 N, pivot ratio 2.45×10⁻².

## 3. How wrong "one wall, clamped borders" is

The cover, belly pressure only, rim held. h = 2 is the mesh to read: the two solids with two elements through the wall agree to 0.04% on w. [probe]

| Model | dofs | w, mm | C, N·mm | force, N | solve, s |
|---|---:|---:|---:|---:|---:|
| One wall, four edges clamped | 5382 | 0.07282 | 0.8607 | 35.88 | 0.020 |
| Folded shell | 13614 | 0.10794 | 1.5436 | 35.88 | 0.059 |
| Tet10, 2 mm, 1 through | 75105 | 0.09834 | 1.3181 | 33.44 | 1.11 |
| Tet10, 2 mm in plane, 2 through | 128511 | 0.10168 | 1.3747 | 33.44 | 2.72 |
| Tet10, 1 mm, 2 through | 505215 | 0.10172 | 1.3772 | 33.44 | 15.4 |

At the same pressure the folded shell is 6.1% more flexible at the centre than the finest solid, and 12.1% higher in compliance. The compliance gap is the loaded area: the shell presses 3588 mm² and the solid 3344 mm², a ratio of 1.073. Scaling the solid's centre deflection by that ratio gives 0.1091 mm, and the shell sits 1.1% under it. Scaling compliance by the square of the ratio gives 1.586 N·mm, and the shell sits 2.6% under it. The scale is not a second solve. The same-pressure figure, 6.1% on w, is the one to quote, and either reading is inside 10%.

The one-wall model, same force as the folded shell, is 28.4% too stiff against the solid (w of 0.0728 against 0.1017). Letting the walls move raises the belly centre by 48%, from 0.0728 mm to 0.1079 mm.

Strain energy of the bare folded cover at h = 2: belly 62.4%, walls 30.1%, rim 7.5%. At h = 4: 62.6%, 29.7%, 7.6%. The side walls hold almost a third of the energy.

Where the ribs go, `Goal::Balanced`, baselines off, spacing 12 mm, ribs 1.5 × 4 mm, four workers. [probe]

| Plan | Ribs | Volume, mm³ | Stiffness factor | Plan, s | Where the length is |
|---|---:|---:|---:|---:|---|
| One wall, h = 2 | 2 | 562 | ×2.24 | 0.73 | 100% belly, both ends on the clamped border |
| Folded, h = 2 | 0 | 0 | ×1.00 | 0.96 | 29 candidates embedded, all pruned |
| One wall, h = 4 | 3 | 833 | ×2.83 | 0.13 | 100% belly, ends on the border |
| Folded, h = 4 | 2 | 697 | ×1.48 | 0.36 | 100% belly, ends on another rib; nothing on a wall or the rim |

On the mesh that matches the solid, the planner adds nothing once the walls can give. Every candidate stays on the face it was seeded on, none of them reaches the rim, and none of them pays. The coarse folded plan does place two ribs, and they end on each other. The one-wall plan anchors its ribs to a clamp the cover does not have, and its centre deflection is 28% smaller than the solid's.

## 4. Ribs at creases

Centre-line box, rectangular ribs 2 × 6 mm on the inward side, pressure on the floor, rim clamped. h = 2 below; h = 4 ranks them the same way (factors 1.278, 1.750, 1.053, 1.342). [probe]

| Policy | Volume, mm³ | w, mm | Δw | C, N·mm | Factor | ΔC per mm³ |
|---|---:|---:|---:|---:|---:|---:|
| Bare | 0 | 0.30618 | | 6.6339 | 1 | |
| Stop: one rib across the floor, ending at the creases | 1176 | 0.23266 | −24.0% | 5.1871 | ×1.279 | 0.00123 |
| Cross: that rib continued up both short walls to the rim | 1872 | 0.17659 | −42.3% | 3.8542 | ×1.721 | 0.00148 |
| Anchor: a rib along each of the four floor creases | 3720 | 0.29002 | −5.3% | 6.2083 | ×1.069 | 0.00011 |
| Anchor plus the centre rib, stopping at the creases | 4872 | 0.22039 | −28.0% | 4.8740 | ×1.361 | 0.00036 |

The rule is cross. Continuing onto the walls to the clamp is the stiffest result and the most compliance per cubic millimetre. Stopping at the crease keeps about half of that compliance drop (1.45 N·mm against 2.78) and spends less material, and it loses on both counts. Anchoring along the crease is the one to reject: 3720 mm³, three times the centre rib, for a 5% change in deflection.

The anchor number is pessimistic as a test of the element. Every vertex of those four ribs sits on the crease, so the web stands on the 45° bisector rather than on either face. A rib that only runs along the crease would still not tie the floor to the clamp, which is why it ranks last even before that geometric error. The cross rib is skewed only at the crease vertices; the rest of it stands on one face, and it is the one that works.

The tracer cannot carry out this rule today. Section 2 measured zero candidates crossing a fold. Until a trace unfolds across the edge, a folded shell solves and then comes back with no ribs, which is what the cover did at h = 2.

## 5. Cost

| Part | Model | dofs | Solve, s | Plan, s |
|---|---|---:|---:|---:|
| Flat plate, the size of the box floor | Shell, h = 1 | 35046 | 0.15 | |
| Box | Centre-line shell, h = 1 | 89334 | 0.53 | |
| Box | Tet10, two through the wall | 221319 | 5.14 | |
| Box | Tet10 at 1 mm | 296325 nodes | skipped | |
| Cover | One wall, h = 2 | 5382 | 0.020 | 0.73 |
| Cover | Folded shell, h = 2 | 13614 | 0.059 | 0.96 |
| Cover | Tet10, 1 mm, two through | 505215 | 15.4 | |
| Cover | One wall, h = 4 | 1254 | 0.006 | 0.13 |
| Cover | Folded shell, h = 4 | 3774 | 0.015 | 0.36 |

Folding the cover costs 2.5× the degrees of freedom and 3× the solve of the single wall, and the plan takes 0.96 s against 0.73 s. The box shell at h = 1 is 2.5× the dofs of a plate the size of its floor. The solid of the cover is 37× the dofs and about 260× the solve. The plans above ran with baselines off, so they are the planner itself, not the thickening and grid comparisons.

## 6. What wall extraction has to change

`rib-wall.ts`, as it stands [read]:

- `wallFaces` grows while the kink across the shared edge is within `growAngleDeg` (15°) over at least half the border. A 90° fold is a stop. The next face is not part of the wall.
- A thickness ray longer than `thickRatio` × the median (3×) is capped there and flagged. The mid-surface offset then uses half the median, not half the reading (`rib-wall.ts`, the `mid` map). Features such as bosses are excluded, and their stiffness is not in the model.
- A border the part continues past is classed joined and clamped. That clamp is the one-wall model of section 3.
- The offset follows the averaged vertex normal, which section 2 showed is the bisector at a crease.

Measured stand-in for the cap, on the folded cover, a disk of radius 8 mm at the belly centre [probe]:

| Thickness on that disk | h = 2 centre w, mm | against the uniform 2 mm wall |
|---|---:|---:|
| 2 mm, the wall | 0.10794 | |
| 8 mm, the reading | 0.06127 | −43.2% |
| 6 mm, the 3× cap | 0.06521 | −39.6%, and 6.4% softer than the real 8 mm |

The disk's own bending stiffness scales with the cube of thickness, so the cap keeps (6/8)³ = 42% of the stiffness the reading asked for. On this small disk that shows up as 6.4% at the centre of the cover. A larger boss would show more of it. The cap is the wrong model of a thick region.

To take every thin region joined at a sharp edge:

1. Grow across a border when both faces are thin. The kink is above `growAngleDeg` and below a fold-back (about 150°), and the neighbour's thickness ray is within `thickRatio` of the median. Sharp edges between thin faces become interior edges of one shell. Edges where the part merely continues into something thick stay joined borders.
2. A face that reads thick, or a boss or rim the feature pass already finds, stays out of the triangle mesh and becomes a stiff patch on the vertices it touches: the real local thickness, or a rigid patch where the thickness is large enough that the shell bending stiffness is not the point. It is not capped at 3× the median, and it is not deleted.
3. A crease vertex is offset by the miter, along each face normal to the mid-surface and then to the intersection. The averaged normal is the wrong direction for that offset, for the rib foot, and for the cross-field vertex frame.
4. The planner has to unfold a trace across those new interior edges, rotating the heading about the shared edge into the next face. Section 4 is the rule for what the rib then does. Without that, the extraction produces a shell the current planner will not reinforce.

## Option 2: condensed neighbours

Keep today's one-wall shell and replace the clamp with the stiffness of everything else, from one coarse solid solve, condensed onto the border degrees of freedom. A coarse solid of these parts is already 1.1 s (the cover, one element through, 75105 dofs) to 5.1 s (the box, two through, 221319 dofs), and it has to be meshed. The border then stops being a clamp and becomes a dense block: the cover's rim is 156 vertices at h = 2, 936 degrees of freedom, and the plan re-factors the shell on every greedy step. Folding the thin walls added 0.04 s to a solve and needed no solid mesh. Condensation is the tool for a boss or a solid rim that should not be meshed as a shell, used on top of option 1 for those regions, not instead of it for the side walls. Cost, from the solves above: one solid factor per plan, 1–15 s on the cover, and a dense border block of order 10³ degrees of freedom inside every shell factor after that.

## Option 3: a true mid-surface

Build the mid-surface of the whole solid and solve that. Nothing in the repository constructs one. It is a medial axis or a CAD mid-surface, and the places it is known to fail are the places this study measured: three faces at a corner, three triangles on an edge, a boss meeting a wall. The folded shell already matches the solid to 2.7% on the box and to 6.1% on the cover (about 1% once the loaded area is allowed for) without that surface. The cost is a kernel project, not a factorisation, and these numbers do not ask for it.

## Recommendation

Option 1. The shell models a folded thin wall. Ship it as follows.

- Extract every thin face across a sharp edge, and represent a thick boss or rim as a stiff patch at its real thickness.
- Offset a crease by the miter. Do not feed the averaged vertex normal to the rib foot or to the cross-field frame.
- A rib crosses a crease and runs on to a hold, the boundary, or another rib. It does not stop at the crease, and a rib along the crease is not the stiffener. The tracer has to unfold across the edge, because today no candidate leaves its face.
- Leave the drilling penalty at 0.01, and leave the web rotation ψ in the beam.

The one-wall clamp stays available for a wall that really does end, or that runs into a thick region whose patch is not yet built. It is the wrong default for a cover.

## What contradicts the handover

The handover §4C says the side walls are assumed stiff. On the cover they hold 30% of the strain energy, and clamping their borders makes the belly 28% too stiff.

It says folded shells should work because a node has a real drilling rotation. The shell does work, and the penalty on that rotation is not why: α from 10⁻⁴ to 1 moves the box by 0.001%. The coupling is the shared rotation vector. What does not work, and §4C does not say, is the planner. `neighbour` and the tracer never carry a line across a 90° fold, and the averaged normals put a rib's offset on the bisector. Proving the solver on a box was the right test, and it passes. The plan on that box is a different test, and it fails until the trace unfolds.

It treats a stiff patch as something the extractor can already emit. The extractor caps a thick reading at three times the median and drops features. An 8 mm disk capped at 6 mm keeps 42% of that disk's bending stiffness.

## What was not measured

- The box solid at 1 mm (296325 nodes) and the L solid at 0.5 mm (275301 nodes), both over the 200000-node cap. The box comparison rests on two solid meshes, the second 1.9% more flexible than the first.
- Any of the section 4 ribs on a solid mesh. Stop, cross and anchor are shell results.
- A shell whose crease vertices sit on the true miter. The shells here meet at the centre-lines, which is t/2 off the solid's inner and outer faces.
- A second solve with the pressure scaled so the forces match. The area correction in sections 1 and 3 is a scale.
- The planner's thickening and grid baselines. They were turned off so the plan time is the planner itself.
- A company part. Buckling, vibration, and any load other than uniform pressure on the floor or the belly.
