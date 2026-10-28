# Plan: tree supports routed by rays from the part's surface

Status: plan, for review. Written 2026-10-28 against `main` after #481. It changes nothing yet. The first step (R1) is a prototype measured on the owner's housing, and it starts only on the owner's go.

The owner asked whether tree supports could be found by casting rays from the surfaces that face down, and using the places where those rays meet as the nodes of the trunks. This plan explains:
- how today's trees are built;
- what the ray method is, and where it was used before;
- what would change for the user;
- how to get there in steps that each ship or stop on their own numbers.

**The short answer:**
- **Today's method is already this idea, cut into layers.** Each node moves at most one lean step per layer, which is a cone cut into slices, and two nodes merge where their cones overlap. But it only sees the part as 2D outlines, one layer at a time, and it walks from the top layer down.
- **The biggest gain is where tips come from, not the routing.** Taking the demand for supports from the surface's faces and normals, instead of from differences between layers, attacks the housing bug at its root:
  - the hairline rows at 45°;
  - one tip claiming a whole row.
- **Routing in 3D comes after,** and then the GPU, only if profiling asks for it.

## 1. The problem this answers

On the Ideaformer IR3 V2 belt, the owner printed `20261028_12_3_housing.stp` mouth down, with tree supports. Too few tips touched the roof, and parts of the support printed in the air. #480, #481 and #482 fixed what they could inside today's method:
- #480 dropped hairline overhang strips;
- #481 made the gap fields honest;
- #482 gave each trunk a base as wide as the trunk.

Measured on the housing after #480, the remaining gap is this:
- **Interface with no tip under it:** in Automatic, 18 % of the tree interface has no tip within 5.4 mm; in Painted only, 7 %.
- **Why:** the slicer counts a row as held as soon as one trunk touches any part of it.
- **Where it comes from:** both problems start in how today's method finds demand (section 2). They are not routing problems.

A branch tuning the tip seeding inside today's method (`claude/belt-tree-tips`) is the short-term fix for printing the housing. This plan is the longer road.

## 2. How trees are built today

All in `crates/lime-slice-core/src/support.rs`.

1. **Demand.** For each layer, `overhang_at` and `past_angle` compare the outline with the one below it and keep what sticks out past the support angle. Islands and enforce paint are added. The result is flat 2D regions, one set per layer.
2. **Tips.** `sample_tips` places tips on a grid inside those regions. The spacing is set by `tip_spacing`: about 10.8 mm on Speed and 3.5 mm on Toughness. `seed_uncovered_interface` adds tips where interface would otherwise have none. A row already near a tip is skipped.
3. **The walk.** `grow` runs from the top layer down, and `propagate_nodes` steps every node one layer. A node may move at most `layer height × tan(branch angle)` per layer:
   - it leans toward the node it pairs with (`pair_steps`);
   - it merges when one trunk can carry both (`merge_nodes`, `carries`);
   - it thickens for its load (`section_radius`);
   - it stops on the bed, the belt (`floor_y_max`) or a supported part face.
   - **Avoidance:** when it is on, `avoidance.rs` builds forbidden centres per layer from the part's outline, grown by the gap and the radius.
4. **Back end.**
   - `organic_disks` turns the nodes into disks on each layer.
   - `project` / `stand` then runs bottom-up: it narrows any disk wider than what holds it and drops one that cannot stand (`settle_disks`), then drops interface left without a footing (`drop_unfooted_interface`).
   - Interface, toolpaths and G-code follow.
   - `SupportSkeleton` (`support/skeleton.rs`) exports the grown trees as limbs with a position and radius per knot, for picking and editing in the UI.

**What this means:**
- **The cone is there, cut into layers.** The per-layer lean limit is a cone, and a merge is where two cones overlap.
- **The part exists only as 2D outlines.** At a roof that sits at the support angle, which is the housing on the 45° belt, comparing layers gives hairline strips and rows one bead wide. #480 patched over this.
- **The walk is serial from the top down.** Each layer depends on the one above, so it cannot run in parallel across layers.
- **Whether a tip can reach the bed is learnt late.** The `stand` pass finds out after the walk; it then drops the disk, and the interface above it can be left in the air.

## 3. The ray method

These references are as recalled, and should be checked before anything relies on them:
- **Vanek et al., "Clever Support" (2014):** samples points on overhanging surfaces and puts a downward cone at each. Where two cones intersect, it places a merge node, checked against the mesh. It repeats greedily until everything reaches the bed.
- **Meshmixer's branching supports:** I believe these were built the same way.
- **PrusaSlicer's resin (SLA) support tree:** it casts rays against the mesh to check whether a pillar or bridge is clear.
- **The FDM slicers** (Cura, then Orca and PrusaSlicer's organic trees) use a layer walk like ours.

Applied here, the method has four parts:

1. **Demand from the surface.** Every triangle carries its normal and area. A face needs support when its normal points down past the support angle, measured against the direction trunks grow (section 4). Tips are spread over those faces evenly by area, with a Poisson disk at a spacing set by the tip pitch. A roof at 45° is then either supported or not, decided by its normal, and no hairline strips exist.
2. **Reachability per tip.** From each tip, a bundle of rays goes down inside its cone (half-angle = branch angle) and is tested against a BVH of the part, a tree of bounding boxes that makes ray tests fast. The part is grown by the XY gap. Each tip learns whether it can reach the bed or belt, only the part, or nothing. A tip that can reach nothing is moved, made to land on the part, or reported as unsupported before anything is built. Nothing is left in the air.
3. **Routing in 3D.** The cone intersections of nearby tips are candidate trunk nodes. Merging is a graph step: nearest pairs first, keep a merge only when both new segments are clear of the grown part, and repeat until every branch lands. Radii grow with load, as `section_radius` does now. The output is a skeleton: segments with a position and radius at each knot.
4. **Back to layers.** The skeleton is cut into per-layer disks. From there, today's back end runs unchanged:
   - `organic_disks`;
   - the bottom-up `stand` check, kept as the guarantee that every disk stands;
   - interface, toolpaths, G-code;
   - `SupportSkeleton` for the UI.

## 4. The belt

On the IR3 V2, layers are planes at 45° that stack along the belt. Today's walk handles this with drift, plumb trunks and trimming at the belt line. With rays:
- **The trunk direction is a parameter.** The cone's axis is the direction trunks grow. Today that is plumb: straight down, which on the IR3 V2 is perpendicular to the belt and crosses the layers at 45°. The support angle is measured against the same axis, so the demand and the routing agree by construction, without the drift and trimming the walk needs in the slice frame.
- **The belt is a plane** that rays hit, solved exactly. A trunk's base is where its last segment meets that plane, which is the trunk-wide base that #482 builds.
- **A roof at exactly the support angle** gets one decision from its normal, with a small tolerance, instead of a sliver per layer.

## 5. What the user would see

- **Tips under every part of a roof,** spaced by area. Today, one tip can claim a whole row.
- **No interface left in the air.** A tip that can't reach the bed or belt is moved, lands on the part, or is reported before anything is built.
- **Trees that merge earlier and more cleanly,** because merges are chosen with the whole tree in view rather than one layer at a time.
- **The same settings:** branch angle, tip and trunk diameter, Speed / Toughness, Painted only and avoidance keep their meaning.
- **The same editing:** the support editor still picks limbs from `SupportSkeleton`. Regrow needs porting (section 8).

## 6. Speed and the GPU

Study #460 rejected the GPU for slicing, because 61 % of a slice is a serial travel tour. Ray tests are the opposite case: every ray is independent.
- **Size.** Thousands of tips times a few dozen rays is about 10⁵–10⁶ ray tests. A CPU BVH on 16 threads does that in tens of milliseconds, so R2 needs no GPU.
- **Parallel by structure.** Tips are independent. Only the merge step ties them together, so the work runs in parallel on any hardware, unlike today's serial top-down walk.
- **When the GPU pays.**
  - A 3D distance field of the part makes the clearance of any branch one lookup.
  - Dense sampling: many rays per tip, or re-routing while the user drags in the support editor.
  - **Constraints:** it must be portable (wgpu, with a CPU fallback), and the stress solver's lesson applies: opening the GPU costs about 1 s.

## 7. Milestones

Each milestone is measured on the same cases and either ships or stops on its numbers. The cases are:
- the housing, mouth down on the IR3 V2, in Automatic and in Painted only, with the owner's projects and settings;
- the Telo cover on the IR3 V2;
- the 60° test cap from `belt_supports_under_a_roof_stand_in_gravity`;
- the golden set.

The measures are:
- tips touching the underside;
- share of interface with no tip within the reach;
- share of support beads standing on nothing;
- unheld patches reported;
- print time;
- support volume;
- slice time.

| Step | What | Ships as | Golden |
|---|---|---|---|
| **R1** | **Demand from surface samples.** Sample the faces that need support, by normal and area, with a Poisson disk at the tip pitch. Feed those tips to **today's walk** in place of `sample_tips`, and project the faces into each layer for interface. Prototype first, behind a request flag. | Prototype on the owner's go. Ships only if it beats `claude/belt-tree-tips` on the housing at a similar or lower cost. | Off by default: byte-identical. |
| **R2** | **Reachability per tip.** A CPU BVH of the part grown by the XY gap. Each tip's cone is tested before the walk, and a tip that can't reach anything is moved, sent to the part, or reported. | With R1. | Byte-identical while off. |
| **R3** | **Routing in 3D.** Cone-intersection merging builds the skeleton, which is cut into per-layer disks, and the `stand` check stays. | A separate style, **"Tree (ray)"**, beside today's trees. It becomes the default only once it wins on every case. | Today's styles byte-identical. |
| **R4** | **Support editing on the new routing.** Port regrow among kept knots, and `support_edit` / `support_trees` in the MCP. | With R3, or R3 waits for it. | — |
| **R5** | **GPU clearance field.** wgpu, with a CPU fallback, built only if profiling R3 shows clearance tests dominate. | Off until measured. | Byte-identical with the CPU path. |

**What R1 asks of today's code:**
- a mesh-level sampler: the slicer already holds the triangles before it cuts layers;
- one entry point where the walk takes tips;
- a projection of the sampled faces to interface regions per layer.

The walk, the back end and the G-code stay as they are, so R1 is small enough to prototype in a day.

### As built: R1

R1 is built as a prototype behind the request flag `supportDemand: "surface"`, on trees only. Absent, or `"layers"`, keeps today's demand byte for byte. There is no UI control, and the MCP does not pass it.

**What it does** (`support/surface.rs`):
- **Which faces ask.** A face asks for support when its outward normal points down past the support angle along plumb, the axis of section 4. The angle is read as `slope_of` reads it, as the least slope from level that prints, with 2° of tolerance, so a face at the angle gets one answer. Three kinds of face are left out:
  - a face within 0.3 mm of the bed or the belt;
  - a face with part 0.45 mm under it along the axis, which is a face inside the solid where two bodies overlap, as the boxes of the 60° cap do;
  - a face where enforce or block paint says otherwise. Enforce asks for any face that points down, and the later disk wins, as in `paint_layer`.
- **Tips.** A seeded scatter, 16 points per tip pitch squared, is thinned in a seeded order to a Poisson disk at the tip pitch (10.8 mm on Speed). Two points closer than the pitch clash only on the same sheet, so a roof over a roof keeps both. Each tip carries the area of the points nearest it, counted in fine-grid cells and capped at the tip's capacity, as a packed tip carries samples today.
- **Into the walk.** Each face is clipped to every band it crosses and laid flat on it. That is the layer's overhang in Automatic, in place of `overhang_at`. Painted only keeps today's per-layer paint regions. Tips ride the overhang down the Z gap to the layer where it is born, and stay only where that overhang still stands, within 0.5 mm. `Walk::arrive` takes them in place of `sample_tips`; a born piece no tip reaches still gets `sample_tips`. Everything after that is today's walk, #484's held-row seeding and the back end. Regrow (`support/edit.rs`) keeps the grid.

**Measured** on main at v4.2.6 (the "before", flag off) against the flag on. The engine runs the owner's projects and settings for the housing (IR3 V2, PETG, 0.4 mm, Speed, tree 40° / 0.8 / 4.2, gaps and interface on Auto). Time is the engine's Klipper model. The checks are:
- floating interface and support: `gfloat.py`'s stacking-or-gravity rule from #484, with interface bridging 5.4 mm along X;
- no tip within reach: interface with no trunk bead within 5.4 mm on the four layers before it;
- tips touching: live tips whose top is within 0.8 mm of the roof (13.2 mm on the housing, 13.9 mm on the cap).

| Case | Print time | Support | Limbs | Unheld patches | Tips touching | Floating interface | Floating support | No tip within reach | Slice (supports) |
|---|---|---|---|---|---|---|---|---|---|
| Housing, Automatic | 14.64 → 19.98 h (+36 %) | 8.55 → 36.05 cm³ | 178 → 2,209 | 0 → 5 | 32 → 137 | 7,938 mm, 13.5 % → 8,420 mm, 5.0 % | 0.28 → 0.33 % | 41.4 → 42.1 % | 2.1 → 4.7 s (0.4 → 2.7 s) |
| Housing, Painted only | 14.27 → 14.28 h (+0.1 %) | 0.92 → 1.06 cm³ | 38 → 49 | 3 → 1 | 29 → 35 | 32 mm, 0.62 % → 45 mm, 0.86 % | 0.41 → 0.38 % | 22.7 → 13.3 % | 1.9 → 1.9 s |
| Telo cover, IR3 V2, Automatic | 33.40 → 39.86 h (+19 %) | 3.48 → 26.45 cm³ | 1,152 → 5,838 | 535 → 535 | 110 → 341 live tips | 52 mm, 1.1 % → 75 mm, 0.03 % | 0.76 → 0.64 % | 38.2 → 73.0 % | 9.6 → 14.2 s |
| 60° cap, trees at 60° | 0.584 → 0.550 h | 1.64 → 1.35 cm³ | 80 → 121 | 0 → 0 | 17 → 30 | 32 mm, 0.24 % → 1 mm, 0.01 % | 0.76 → 0.59 % | 41.1 → 44.2 % | 0.12 → 0.13 s |
| Housing on a flat bed, Automatic | 15.67 → 15.55 h (−0.8 %) | 29.7 → 32.1 cm³ | 494 → 488 | 0 → 0 | 18 → 36 | 16.8 → 17.2 % | 0.54 → 0.53 % | 24.9 → 37.5 % | 6.0 → 6.2 s |

On the flat bed, "floating" uses a ±0.3 mm window across the row instead of the belt's.

**What the numbers say:**
- **Plumb asks for far too much on the belt.** On the housing it asks for 64,600 mm² of faces, against about 16,000 mm² that are past the angle in the layers' own frame. Most of them are the tapered inner walls and the level ceilings, which point down in gravity but print on the belt by stacking, as the part's own 45° layers do. Interface grows threefold. #484's held-row rule then grows about 1,900 limbs on those rows, beside the 282 tips read off the surface.
- **The floating sheet is not touched.** Floating interface falls from 13.5 % to 5.0 % only because there is three times as much interface. In millimetres it stays at about 8,000, in every variant measured. That sheet's rows step about 0.55 mm a layer in the slice frame. Each row needs a trunk under it, and a tip a pitch apart cannot hold the rows between. This is a stacking problem, not a demand problem.
- **Where it helps.** It doubles the tips touching the roof on a flat bed at no cost in time. On the 60° cap, it holds the roof with less interface and less time. In Painted only it is neutral: one fewer patch, six more tips at the roof, and 13 mm more floating interface.

**Two other axes**, measured on the housing with a switch in the engine that is not committed:
- **The layers' frame** (the angle measured against slice Z): 14.91 h, 10.62 cm³, 287 limbs, 8,206 mm (12.0 %) of floating interface, 18 tips touching the roof.
- **The layers' frame, or within 15° of level in gravity:** 18.92 h, 26.96 cm³, 718 limbs, 8,573 mm (5.1 %), 77 tips touching.

Neither beats #484 at a similar cost.

**Verdict.** R1 does not beat #484 on the housing at a similar cost. It stays off by default, as a request flag. D2 needs another look before R2 or R3: on the belt, the axis that decides demand cannot be plumb alone.

**Tests:**
- `support::surface` unit tests: a ceiling bears tips a pitch apart; the same mesh bears the same tips; a slope inside the angle asks for nothing; enforce paint asks.
- `belt_trees_with_surface_demand_hold_the_roof` in `tests/belt_slice.rs` (the 60° cap with the flag on).
- `an_unknown_support_demand_is_refused`.
- Golden, flag off.

## 8. Risks and open points

- **Printability per layer still rules.** A skeleton that is clear in 3D can still give a disk that overhangs the one below it on some layer. The bottom-up `stand` check stays for that reason, and R3 must measure how much it drops.
- **Sampling noise on CAD meshes.** STEP tessellations have long, thin triangles. Sampling by area, with a tolerance on the normal, handles the near-45° roof. R1 measures it on the housing, whose mesh caused #480.
- **Interface shape.** Today the interface comes from layer differences. Under R1 it comes from projected faces. The two must agree at the edges of the part, or the interface will have gaps or excess.
- **Regrow (R4)** depends on the walk. Until it is ported, "Tree (ray)" either can't be edited or falls back to today's walk for edits.
- **G-code changes.** R1–R3 change every tree support row they touch. They stay off by default until they win, and the golden set proves the other styles unchanged.
- **Print time.** R1 adds tips, and so adds time. The owner's rule: a small measured cost that fixes a real print failure can be on by default; a large one ships off.

## 9. Decisions for the owner

| # | Question | Proposal |
|---|---|---|
| D1 | Should R1 replace the tip-seeding tuning (`claude/belt-tree-tips`) or follow it? | Follow it. The tuning is the short-term fix for printing the housing. R1 is measured against it. |
| D2 | Which direction counts as "down" for demand and routing on the belt? | Plumb: straight down, perpendicular to the belt, the same axis today's trunks use. |
| D3 | Should "Tree (ray)" be a separate style, or replace today's trees? | A separate style until it wins on every case in section 7. |
| D4 | When do we start the GPU work (R5)? | Only after R3 is profiled, with wgpu and a CPU fallback. |
