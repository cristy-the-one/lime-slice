# Plan: ribs or a thicker patch

Status: study only. No feature code on this branch. Written 2026-11-19 against `feature/ribs-next` at 54b096b0. The measurements are on `ribs-next/d-probe` at 5ba6b209. That branch is pushed and is not to be merged: it adds `crates/lime-sim/tests/rib_thicken_probe.rs` and does not change the planner. This document is the only change on the branch that is for review.

The question, from the handover §4 D: Gil-Ureta's cell, which moves smoothly from a rib to a thicker wall, against a simpler move in the existing greedy loop, "thicken this region by N". Compare them at equal stiffness, and say whether the thicker region can be an editable step.

Evidence marks: **[probe]** `cargo test -p lime-sim --release --test rib_thicken_probe` and the three v6.11.0 snapshot tests, synthetic geometry, `CARGO_TARGET_DIR=/tmp/lime-target`; **[read]** the source or the paper; **[code]** a check that did not run a solver.

Material is the planner's default, E = 2000 MPa, ν = 0.35, pressure 0.001 MPa. Units mm, N, MPa. Compliance is the work of the loads, N·mm. The stiffness factor is bare compliance over ribbed compliance.

## The short answer

Do not build the cell, and do not add a thicken move to the loop. On the curved wall the membrane region is the whole wall, so "thicken this region" is the uniform thickening the planner already reports, and ribs still use less material (1812 mm³ against 2154 mm³ at ×1.227). On the flat panel there is no membrane region, and ribs use 1061 mm³ against 6685 mm³ to reach ×2. A hot quarter of that panel, thickened on its own, still needs 3828 mm³. Pre-thickening and then planning ribs makes both plans worse.

The geometry cannot be a step inside the rib network. A face move is refused inside a group, and the kernel can offset a whole face, not a patch of one.

## Answers

1. A thicken step costs one new factor. Membrane stiffness scales with thickness and bending stiffness with its cube, so the element matrices change and a new right-hand side is not enough. There is no rank-1 path. `select.rs` records why Sherman–Morrison–Woodbury lost for ribs: the update is full rank on the rib's degrees of freedom; at 39k triangles a refactor is 0.76 s and one right-hand side is 0.035 s, and a candidate that touches 426 dofs costs about 4.5 s of solves. The update wins only under about 7–16 vertices. **[read]** On these meshes a thickness rebuild is 2–6 ms, and the factor inside it is 0.6–2.5 ms. **[probe]**
2. The membrane set is every triangle whose membrane energy exceeds its bending energy on the bare wall. On the curved wall that is 256 of 256 triangles (97.5% of the energy), so the set is the whole wall. The flat panel has 0 of 576. The coarse cover has 55 of 236 (8.5% of the energy). A second probe region, the quarter of triangles with the most strain energy, is 64, 144 and 59 triangles. That is one patch, not a patch per field cell. The loop today sees rib chains only. **[probe]**
3. At the rib plan's compliance, ribs use less material than uniform thickening on all three walls. The hot patch beats uniform on the flat panel and on the coarse cover, and loses to it on the curved wall. Neither patch beats the ribs on the two walls the handover names. The table is below. **[probe]**
4. The cell is not worth it on these numbers, and it was not implemented. Gil-Ureta, Pietroni and Zorin 2020, §3–4: each edge of a cell has a width and a height; the volume formula counts the overlap of the blocks once, so a membrane region wants a wide, thin fill and a bending region wants a tall, narrow rib; the model is a beam network on a partition, minimising weight under a stress bound, and the problem is not convex. **[read]** lime-sim has neither that cell nor that optimiser. Building it is a second planner. The discrete move, if a later wall wanted it, is a region plus one exact refactor beside the rib shortlist, a few hundred lines, and it still has no geometry step.
5. A thickened patch cannot be one editable row next to a rib network today. `MoveFaces` offsets whole faces. `group_step_refusal` rejects it with "A group cannot contain a face move", and a rib network is a group. There is no face-split operation in `Op`. The smallest kernel change is a split of one face by the region's outline, then a face move of the inner piece, as its own History row before the rib network. This machine has no `LIME_OCCT_BRIDGE`, so that solid was not built. **[read]**
6. For the moulding report (package E1) only: a thicker patch next to a rib moves the rib-to-wall ratio the safe way (the moulded preset wants the rib at most 60% of the wall). The new defect is the step at the edge of the patch, which can print a sink line. No check is added here. **[read]**

## Comparison at equal stiffness

Each row is the added volume, in mm³, that reaches the rib plan's compliance. "Hot quarter" and "membrane set" are thickness edits on the input mesh, searched to that compliance. Uniform and grid are the planner's own baselines, on the mesh the ribs were solved on. The two meshes agree to 0.1% on the bare compliance for the curved wall and the flat panel. On the coarse cover the rib embedding raises the bare compliance by 1.7%, so that row's hot-quarter volume is the less exact one.

| Case | Ribs | Uniform | Grid | Hot quarter | Membrane set | Then ribs, after a pre-thicken |
|---|---:|---:|---:|---:|---:|---:|
| Curved, ×1.227 | 1812 | 2154 | 2806 | 2197 | same as uniform | 2344 at ×1.221 |
| Flat, ×2.006 | 1061 | 6685 | 1719 | 3828 | none (0 membrane triangles) | 2831 at ×2.007 |
| Coarse cover, ×1.696 | 762 | 1037 | 711 | 602 | not reached at +8 mm (×1.44, 7526 mm³) | 642 at ×1.065, goal missed |

The curved wall is the v6.11.0 snapshot: cylinder radius 40 mm, length 80 mm, 90°, 16 × 8 cells, thickness 2 mm, the straight edges clamped, `Goal::Balanced`. Four ribs, 1811.5285 mm³, factor 1.226871. The plan took 0.11 s and 42 solves; the baselines took 0.03 s. Uniform thickening is +0.429 mm, 2154 mm³, 4 solves. The grid is pitch 22.8 mm, four by two lines, 2806 mm³. The hot quarter holds 29% of the energy and needs more material than thickening the whole wall, so concentrating the thickness does not pay. Pre-thickening that wall by 0.11 mm and planning again keeps four ribs and spends 2344 mm³ for a slightly lower factor, because `Goal::Balanced` stops.

The flat panel is the other v6.11.0 snapshot: 160 × 80 mm, 24 × 12, thickness 2 mm, the boundary clamped, `Goal::Stiffer(2)`. Two ribs, 1061.3536 mm³, factor 2.005698. The plan took 0.23 s and 47 solves. Membrane energy is under 0.01% of the total, so there is no membrane region to thicken. The hot quarter holds 62% of the energy and still needs 3.6× the rib material. The even grid that reaches the factor is a single cross, 1719 mm³, still more than the planned ribs. Pre-thickening by 0.13 mm and planning again spends 2831 mm³ to land on the same factor.

The coarse cover is a hand-built shell, not the folded parts. A 40 × 24 mm floor, walls 12 mm high, 8 × 5 cells on the floor and 3 up the walls, thickness 2 mm, pressure on the floor only, the top rim clamped, spacing 8 mm, `Goal::Stiffer(1.5)`. 236 triangles. The plan places five ribs, 762 mm³, factor 1.696, in 0.36 s and 202 solves. An even grid reaches the same compliance in 711 mm³, so on this coarse box the ribs do not beat the grid. Thickening only the 55 membrane triangles does not reach the factor even at +8 mm. The hot quarter does, at 602 mm³ on the input mesh. Pre-thickening the membrane set by 0.5 mm and planning again stops at ×1.065. The real cover and the open box, extracted from solids, are under "What was not answered", and on those the ribs do beat both baselines.

A per-step cost, release, one thread, the second build (the first is the same size):

| Wall | Triangles | Free dofs | Assemble | Analyse | Factor | Right-hand side | Whole rebuild |
|---|---:|---:|---:|---:|---:|---:|---:|
| Curved | 256 | 714 | 0.5 ms | 0.4 ms | 0.6 ms | under 0.1 ms | 2 ms |
| Flat | 576 | 1518 | 1.2 ms | 0.9 ms | 2.5 ms | 0.1 ms | 5 ms |
| Coarse cover | 236 | 636 | 0.5 ms | 0.4 ms | 0.8 ms | under 0.1 ms | 2 ms |

The 0.76 s refactor is the 39k-triangle figure in `select.rs`, not one of these. A greedy thicken candidate would pay that refactor once per shortlist entry, the same as a rib's exact eval. Nothing in the shortlist estimates a thickness change: the estimate is the rib's strain energy.

## What the cell would add, and why it stays out

The paper's point, §3, is the volume. Adding the volumes of two crossing ribs counts the intersection twice. With that count, a bit of bending makes both ribs tall and narrow, and a membrane region never fills in. Their volume of three trapezoidal blocks in a triangle, overlap counted once, is what lets the same parameters become a rib or a solid patch. The published gains (1.44× stiffer than Li at equal weight, 1.08×–26.9× against an equal-weight plain shell, 2–80 s) are for that whole optimiser, not for a thickness edit inside our loop. **[read]**

Putting that model into this planner means a partition of the wall, two parameters per cell edge, their beam stiffness, the overlap volume, and a stress-bounded solve that is not the greedy "add the rib with the best drop per volume". That is a new planner, of the same kind of size as `shell/planner/`, and it does not answer the handover until the geometry exists to build the cells.

The discrete move does not earn a place on these walls either. Where the load is membrane, the region is the whole wall and the planner already reports it. Where the load is bending, ribs win by a wide margin and a forced thicken-then-ribs pass wastes material. The rule for a later candidate, if a wall ever shows a hot patch beating the ribs at the same compliance, is the loop's existing rule: take the move with the larger compliance drop per added volume, and take neither when it falls under the goal's floor. A patch that loses that comparison must not be added, or the blend does worse than ribs alone, which is what the pre-thicken rows show.

## Geometry

`ribNet` is one History group (`src/modeling/auto-ribs.ts`). `build_group` refuses `Op::MoveFaces` and `Op::FaceExtrude` before it builds anything. **[read]** So an offset cannot be a step of the rib network, grouped or not. The handover's sentence is the code.

`MoveFaces` offsets each picked face along its outward normal and extends or trims the neighbours. It has no region, only faces. `Op` has no split that draws a curve onto a face. A patch of one wall of an imported solid is exactly the thing those two facts exclude.

What the kernel tests already show, when Open CASCADE is present (`crates/lime-model-occt/tests/faces.rs`): pulling the top of a 20 × 20 × 10 box by 5 mm is one stored face move and takes the volume from 4000 mm³ to 6000 mm³; pulling a hole wall inward by 1 mm grows the hole; a ball-shaped void inside a box cannot be moved, because the joined offset does not move that closed surface. Those tests were not re-run here. `LIME_OCCT_BRIDGE` is unset on this machine, and the study does not claim a solid was built.

The smallest change that would make a patch an editable row:

1. A face split: the region's outline drawn onto one face, producing an inner face.
2. `MoveFaces` on that inner face, inward, as its own History row.
3. The rib network as the next row, not as a container of the face move. The group's refusal stays. A face move inside the group would still offset a whole face, and the ribs land on the face the move has just replaced.

Until that split exists, the shell can already carry the thickness. `ShellMesh.thickness` is one number per vertex, and the folded shell uses it for a stiff patch. That is the model the probe edited. It is not a row in the History.

## Printability, for E1

The moulded preset in `docs/plan-auto-ribs.md` §2.4 is a rib no thicker than 60% of the wall, height under three times the rib thickness, draft 0.25–0.5°, and a root fillet of 0.25–0.5× the rib thickness. A patch that thickens the wall beside a rib helps the 60% rule. The step where the patch ends is a sudden change of thickness, which is the sink the rule is trying to avoid, now along a line instead of along a rib. Package E1 is the place to report that line. This study adds no check and no preset.

## What was not answered

The folded cover and the open box are planned. `mcp/folded-shell-occt.test.ts` runs each folded request once more with `baselines: true`. This machine has no Open CASCADE bridge, so the numbers are from CI job "Folded shell against real Open CASCADE" on `2e7d1944` (run 44498064625). The job took 480 s, the test 307 s after a 118 s engine build, and the two extra plans 26.09 s and 59.08 s. That is under the 1500 s limit. **[probe]**

| Part | Factor | Ribs, mm³ | Uniform thickening, mm³ | Grid, mm³ |
|---|---:|---:|---:|---:|
| Cover | 2.4101 | 1381.98 | 6122.99 (+0.701 mm) | 2941.82 |
| Open box | 1.8292 | 1368.25 | 6718.61 (+0.455 mm) | 2974.04 |

The grid reached both, at pitch 19.97 mm on the cover and 34.40 mm on the box. Neither baseline wins on either part. Thickening needs 4.43× the rib material on the cover and 4.91× on the box. The grid needs 2.13× and 2.17×. The test asserts only that the three volumes are present and positive.

- There is no measured cell-model column. The paper was read; the model was not built, for the reason in the cell section.
- No screenshot. Nothing was built in the kernel.

## Snapshots

On `ribs-next/d-probe`, with the planner sources untouched, these three tests passed in 0.50 s:

- `a_one_case_plan_matches_v6_11_0`
- `a_curved_balanced_plan_matches_v6_11_0`
- `a_budget_plan_matches_v6_11_0`

The curved plan inside the probe, baselines on, is the same four ribs, 1811.5285 mm³, factor 1.226871. The thicken edits live only in the new test. They are not a planner option, so there was nothing to turn off.

## Recommendation

Leave the planner as it is. The uniform baseline is the equal-material check the handover asks for, and the curved wall still favours ribs, by 16% of the added volume, not by a margin that needs a new move. A cell model is a second planner and these walls do not ask for it. A regional thicken candidate is a small loop change that would have lost every comparison that matters here, and it cannot become a History row until a face can be split. Revisit the candidate only when a wall shows a hot patch beating the ribs at the same compliance. The coarse box did, and it does not survive on the real parts: there the ribs use less material than both baselines.
