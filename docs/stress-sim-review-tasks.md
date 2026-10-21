# Stress simulation: review of S0–S2 and the tasks it leaves

Status: task list. Written 2026-10-21 by reviewing `dev/stress-sim` at `146891c` against
`docs/plan-stress-simulation.md`.

Each task is marked with who should take it:

- **Grok**: clear-cut work with a precise spec.
- **Claude**: work that needs geometry or finite-element judgement.

## What is already good

- **Tests.** `cargo test -p lime-sim` passes: the patch, cantilever, Kirsch, Lamé, driver, graph and print suites.
  `src/sim/recipe.test.ts` and the typecheck pass.
- **The plan's rules hold:**
  - No diff in `lime-slice-core` or `lime-slice`. `sliceRequest` strips `sim` (D10).
  - faer is pinned to `=0.24.4` with only `sparse-linalg`, and CI has the GPL-family licence check for `lime-sim`
    (§8).
  - The dependency-graph test exists (D1).
  - The driver is a real loop over steps and iterations (D5).
  - Modal, temperature, TET4 and post-steps are refused with sentences (§5.6).
  - `trust.rs` matches the §7.7 table.
- **Verification:**
  - The TET10 cantilever tip is within 2.4% at h and 1.1% at h/2.
  - TET4 at the same node count is 50% stiff, which is the locking regression.
  - The hole's Kt goes 2.41 → 2.70 → 2.84 as the edge length halves.
  - Lamé matches at the sample radius.

## Who has what (2026-10-21)

- **Claude**: SR-03 and SR-04, both done.
- **Grok**: SR-02, SR-05, SR-06 and SR-07 first, then SR-01 last. SR-01 changes the recovery code in
  `crates/lime-sim/src/lib.rs` that SR-04 rewrote: SR-04 has landed, so pull first. The safety factor now also runs
  over the Gauss samples in `recover`, so SR-01's volume fraction must reach both the nodal and the Gauss loop.
  Pull before each task: SR-03 already rewrote `volume_fractions` in `recipe.rs`, which SR-02 option (a) extends.

## Rules for these tasks

- One commit per task, with its ID in the subject (`SR-03: …`).
- No change to `lime-slice-core`, `lime-slice` or the golden hashes. The D10 test must still pass.
- No new modulus or strength copied from a data sheet. The provisional cards stay provisional (§6.3).
- A baseline row that moves is a reviewed change. Say in the commit why it moved.
- `cargo test -p lime-sim`, `cargo clippy -p lime-sim -- -D warnings`, `npm run test:unit` and `npx tsc --noEmit`
  pass before each push.

---

## P0: correctness

### SR-01 (P0, Grok). The safety factor must not be optimistic in the infill, and must see compression and interlayer shear

- **Seen** in `MaxStress::safety` (`crates/lime-sim/src/material.rs`):
  1. The core's stiffness is scaled by its volume fraction (`moduli(vf)`), but the allowable isn't. The smeared
     stress in a 20% core is about one fifth of what the struts carry, and it's compared against the full solid
     strength, so the core's safety factor is about 5× too high. `recover` in `src/lib.rs` also builds the
     safety factor's `MaterialContext` with `volume_fraction: 1.0` for every node.
  2. Only tension is checked: the in-plane principal tension, and the tension along the layer normal. Pure
     compression returns `1.0e9`. The two interlayer shear components (the layer-normal row of the local stress,
     `local[4]` and `local[5]`) are never checked, and delamination by shear is a common way a print fails.
- **Change**:
  1. Scale the allowables by the local volume fraction: `allow × vf` in the core and `allow` in a wall. Pass each
     node's fraction into the context. Recover the nodal fraction as the volume-weighted mean of the elements around
     the node, the same way the stress is averaged, or take the **lowest** fraction around the node, which is more
     conservative. Write down which you chose.
  2. Add compression allowables to `Allowables`: `compressionInPlaneMPa` and `compressionAcrossLayersMPa`. Add an
     interlayer shear allowable: `shearAcrossLayersMPa`. On the provisional cards, default each to an explicit
     placeholder that is clearly not data: compression equal to the tension number, shear equal to half the
     across-layer tension. Mark them in the card's `specimen` text as "placeholder".
  3. Max-stress checks every component in the build frame:
     - in-plane principal tension and compression;
     - layer-normal tension and compression;
     - interlayer shear, `hypot(local[4], local[5])`.
  4. A node with no stress at all reports `null` in the summary's location, not a `1e9` sentinel at an arbitrary
     node.
- **Accept when** (new tests in `tests/print.rs` or a new `tests/safety.rs`):
  - A uniform tension bar at 20% infill, on the same card and load, has a core safety factor 0.2× that of the 100%
    bar, within 1%.
  - A bar in pure compression has a finite safety factor equal to `compressionInPlane / σ`.
  - A block in pure interlayer shear has a safety factor equal to `shearAcrossLayers / τ`, and the in-plane shear
    case doesn't trigger it.
  - The cantilever baseline's stresses are unchanged. Only safety-factor fields may move.

### SR-02 (P0, Grok). Regions and reinforcement are used, or refused, never dropped

- **Seen**: `simRecipe` in `src/sim/recipe.ts` sends `regions` (height ranges and modifier volumes with `walls` and
  `infill`) and `reinforcedInfill`. The Rust `Recipe` (`crates/lime-sim/src/recipe.rs`) has neither field and
  doesn't deny unknown fields, so serde discards both. A study with a modifier or painted reinforcement solves as if
  they weren't there, with no note. The plan's §5.6 says "Refusing is the point".
- **Change**:
  - Add `#[serde(deny_unknown_fields)]` to `Recipe` and to the request structs in `study.rs`, so a future field can
    never be dropped silently again.
  - Then choose one of these, and say which in the commit:
    - **(a) Use them.** Add `regions: Vec<Region>` with a `kind` (`range` with `zMinMm`/`zMaxMm` in the build frame,
      `box`, `cylinder`, `sphere`) and optional `walls`/`infill`. In `volume_fractions`, an element whose centroid is
      inside a region takes that region's infill for its core. A region's `walls` changes the side-skin thickness
      inside it. `reinforcedInfill` is the region kind `reinforcement` with `infill` only, applied with `max`.
    - **(b) Refuse them.** If `regions` is non-empty, or `reinforcedInfill > infill`, refuse with "Modifier and
      reinforcement regions are not in this version." Option (b) is acceptable for this milestone.
- **Accept when**: a Rust test deserialises a recipe with an unknown key and gets an error naming the key. A
  TypeScript test sends a study with one modifier region and gets either a different core fraction inside it (a) or
  the refusal sentence (b), never a silent solve.

### SR-03 (P0, Claude). Walls and skins follow the real surface, not the bounding box

Status: done. `crates/lime-sim/src/skin.rs` builds the bands from `boundary_faces`, finds them with a bucket grid,
and samples each element at 64 equal sub-tet centroids, then 512 where those disagree. `tests/skin.rs` checks a box
meshed 4× coarser than its walls, the box turned 30°, and a tube's bore against the exact band volume, each within
10% (the turned box within 5% of the flat one).

- **Seen**:
  - `in_skin` in `recipe.rs` measures each Gauss point's distance to the six faces of the mesh's **axis-aligned
    bounding box**. That's right only for a box aligned with the axes. On a cylinder, a bracket, a rotated part, or
    around a hole, the walls along the real surface are never found, and those elements are treated as infill.
  - The skin share is the fraction of an element's Gauss points inside the band. With elements of a few millimetres
    and walls of 0.8 mm, the band is usually missed entirely unless `h` is below the wall thickness.
- **Change** (needs geometry judgement):
  - Extract the boundary faces of the volume mesh once: the triangle faces used by one cell only, using the corner
    nodes of a TET10.
  - Build a distance query to that surface: a BVH, or a grid of face buckets.
  - Each face's outward normal decides its band thickness: `skinLayers × layerHeight` when it's within 45° of the
    build axis, `walls × lineWidth` otherwise.
  - Integrate the element's wall fraction instead of counting Gauss points: sub-sample each tet, for example 4–8
    points per Gauss point, or use the distance at the nodes with a linear split.
  - The result is the same per-element `volume_fraction` field the material already reads. Nothing downstream
    changes.
  - Document the cost and cap it, so a 200,000-node mesh doesn't spend longer in the smear than in the factor.
- **Accept when**:
  - **A hollow cylinder at 20% infill:** the deflection under bending lies between the all-infill and all-solid
    answers. Adding walls stiffens it, which the bounding-box version can't show.
  - **A box rotated 30° about Z:** it gives the same deflection, within the mesh tolerance, as the unrotated box
    with the load rotated the same way.
  - **Mesh independence:** a box with 2 walls, on a mesh whose `h` is 4× the wall thickness, gets a wall fraction
    within 10% of the analytic area ratio.
  - **No regression:** the existing "more walls deflect less" test still passes.

### SR-04 (P0, Claude). `converged` must mean the peak numbers are converged

Status: done.

- **Recovery** (`estimate::recover_nodal`): each TET10's linear stress through its four Gauss points is extrapolated
  to its corners, its mid-edge nodes take the mean of their two corners, and each node averages over its elements by
  volume. The drawn field, the safety factor and the estimator all use it. TET4 keeps the plain mean.
- **Peaks**: the summary's `maxVonMisesMPa` and `minSafetyFactor` are the more severe of the recovered and the
  Gauss-point values, never below the Gauss maxima.
- **Local error**: `trust.peakRelativeError` is the ZZ error of the elements within 2h of the peak von Mises, and of
  the lowest safety factor when it is finite. `trust.peakGap` is the gap between the recovered and the Gauss-point
  peak, and is reported only.
- **Trust**: `converged` needs both the global and the peak error at 0.05 or under, and `usable` both at 0.15 or
  under.

The baselines moved, reviewed:

| Case | Global error, old → new | Peak error | Trust, old → new |
|---|---|---|---|
| Cantilever h | 0.650 → 0.070 | 0.081 | rough → usable |
| Cantilever h/2 | 0.218 → 0.035 | 0.063 | rough → usable |
| Cantilever h/4 (`LIME_SIM_FINE=1`) | 0.084 → 0.018 | 0.035 | rough → converged |
| TET4 h/2 | 0.673 → 0.673 | 0.670 | rough → rough |
| Plate with a hole, coarse (Kt 2.41) | 0.052 → 0.025 | 0.109 | usable → usable |
| Plate with a hole, middle (Kt 2.70) | 0.035 → 0.014 | 0.085 | **converged → usable** |
| Plate with a hole, fine (Kt 2.84) | 0.019 → 0.006 | 0.038 | converged → converged |
| Lamé wedge | 0.085 → 0.009 | 0.010 | usable → converged |

The beam's root is a clamped corner, a real singularity, so its peak error falls slowly. Usable at h and h/2 is the
honest word there. The tests now assert each row's trust word, that it never gets worse as the beam refines, and
that a Kirsch row whose flank stress is more than 5% below the finest row's is not `converged`.

Follow-up, after the corrected cantilever reference: the beam's root shear goes through one pinned node, a point
support, and its peak error rose with refinement (0.022, 0.034, 0.074). Trust is now judged away from **hold edges**:
nodes held in a direction that runs along every boundary face through them (a fixed face's perimeter, a pinned point,
a pinned line), on a face with a corner not held that way. Rollers and symmetry planes hold across their faces and
are never marked, so the plate with a hole and Lamé are unchanged. The exclusion reaches the larger of 1.5 elements
and a fifth of the part's thinnest extent: near a singularity the error a fixed number of elements away doesn't fall,
only the error at a fixed distance does. Peaks are still reported in full, with `peakAtHold` and a note when they sit
there. The cantilever's peak error is now 0.022, 0.0068 and 0.0029, `converged` at h, h/2 and h/4.

- **Seen**:
  - The trust level comes from the global ZZ relative energy error (`estimate.rs`), with nodal stress recovered as a
    plain average of the Gauss samples around each node.
  - In the checked-in baselines that global number is the wrong way round:
    - On the TET10 cantilever at h/2, the tip is within 1.1% and the stress within 2%, but the error is 0.22, so it's
      `rough`.
    - On the plate with a hole, middle mesh, Kt is 2.70 against about 3 (the peak is 10% low), but the error is
      0.035, so it's `converged`.
  - The summary's `maxVonMisesMPa` and `minSafetyFactor` are taken from the **averaged** nodal values, which flattens
    exactly the peaks they report. That's unconservative.
- **Change** (needs finite-element judgement):
  1. **Peaks from the Gauss points.** Report `maxVonMisesMPa`, `minSafetyFactor` and their locations from the Gauss
     samples, or from recovery that extrapolates to the nodes, not from the node average. Keep the averaged field
     for drawing.
  2. **A local error at the hot spot.** Compute the ZZ error of the elements around the peak von Mises and the
     minimum safety factor, for example the elements within 2h, and the gap between the Gauss-point peak and the
     recovered peak. Put both on `trust` (`peakRelativeError`, `peakGap`).
  3. **Re-base the trust levels.** `converged` needs **both** the global and the peak error under 0.05, and `usable`
     needs both under 0.15. Calibrate the recovery (superconvergent patch recovery, §5.5's planned replacement, or a
     corrected average) so that the TET10 cantilever at h/2 isn't `rough`. Record the thresholds and why in
     `trust.rs`.
  4. **Update the baselines** with the new fields, reviewed.
- **Accept when**:
  - On the cantilever, the trust word improves monotonically from h to h/2 (and to h/4 under `LIME_SIM_FINE=1`).
  - On the plate with a hole, `converged` isn't reached while the Gauss-point Kt is more than 5% below the finest
    listed row.
  - The summary's peaks match the Gauss-point maxima.
  - Lamé stays at least `usable` on its coarsest wedge.

---

## P1: robustness

### SR-05 (P1, Grok). Refuse a part that's nearly free, not only one that's exactly free

- **Seen**: an unheld part is caught when faer reports a zero pivot, or when a displacement passes 10⁸ mm
  (`RIGID_DISPLACEMENT_MM` in `lib.rs`). A part held along a line of nodes, or by one corner, is a mechanism
  with tiny pivots. It can return a huge but finite answer that passes both checks. The relative residual is computed
  and reported but never used to refuse.
- **Change**:
  - Refuse with the existing "This part is not held. Fix a face, or the bed." when **any** of these holds:
    - the relative residual is above `1e-6`;
    - the peak displacement is above 10× the part's bounding-box diagonal;
    - the smallest LDLᵀ pivot over the largest is below `1e-12`, if faer exposes the diagonal.
  - Set `rigid_failed` in `TrustInput` from that, instead of leaving it unused.
- **Accept when**: a beam held only on one edge line of nodes, and a beam held on one corner node, are both refused
  with the sentence. The existing driver test for a fully free part still passes.

### SR-06 (P1, Grok). Say what a lines infill loses

- **Seen**: `Pattern::Lines` is smeared like grid. Its note says the factor is unmeasured, but lines infill is
  strongly one-directional (it alternates per layer), and the smear is isotropic in the layer plane.
- **Change**: extend the lines note: "Lines infill is modelled as a grid of the same density. Its strength along each
  layer's direction is not modelled." Cap lines at `usable`, as gyroid and lightning already are.
- **Accept when**: a study with lines infill has that note in `trust.notes`, and its level is at most `usable`.

### SR-07 (P1, Grok). Keep CI time in check

- **Seen**: in debug, `tests/kirsch.rs` takes 25.6 s and `tests/print.rs` 35.7 s on a desktop. GitHub runners are
  2–3× slower.
- **Change**:
  - Build `lime-sim`'s tests at `opt-level = 2` in the `[profile.test]` override for that package
    (`[profile.test.package.lime-sim]`), which faer benefits from a lot.
  - Or move the finest Kirsch row behind `LIME_SIM_FINE=1`, like the cantilever's h/4.
  - Keep the coarse and middle rows in the PR run.
- **Accept when**: `cargo test -p lime-sim` in the CI `rust` job takes under 60 s in total, and the job's timing is
  recorded in the commit message.

---

## Order

1. SR-02 first: it's small, and it stops silent drops while the rest changes.
2. SR-01 and SR-05.
3. SR-03 and SR-04 (Claude), which can run in parallel: SR-03 touches `recipe.rs`, SR-04 touches `estimate.rs`,
   `trust.rs` and the summary in `lib.rs`.
4. SR-06 and SR-07.

S3 (desktop) shouldn't start until SR-01 to SR-04 have landed. The legend and the MCP summary show the very numbers
those tasks fix.
