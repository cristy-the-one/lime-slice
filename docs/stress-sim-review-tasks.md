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

---

# Round 2: review of S3 and S4, and wiring the sliced solve

Written 2026-10-22 by reviewing `dev/stress-sim` at `72e9dc9`. The sliced plan's L1a to L4b have landed
(`docs/plan-stress-sliced.md`). A real part can now be solved as it is sliced, so the desktop and the MCP can show real
results.

## What the review found

S3 built the panel's mechanics, and they work:
- the menu entry and the dock section;
- typed and dragged loads;
- the legend, the probe and section clipping;
- an undo that stays off the model history.

The **result** it draws isn't a solve. `cannedBeam` in `src/sim/study.ts` applies the Euler–Bernoulli cantilever formula
to the object's **bounding box**. Seen in the app, through a headless Playwright run with the model tree mocked as in
`e2e/model-stress.spec.ts`:

- **The shape is ignored.** An L bracket (a 40 × 10 × 4 foot and a 4 × 10 × 30 upright) is painted as one solid
  40 × 10 × 34 block, filling the empty corner of the L.
- **The holds and the load's faces are ignored.** "Bed" holding the whole bottom face, with 25 N pressing down, should
  give light compression. It shows a cantilever clamped at x = min, bending to 6 MPa. The formula always clamps x = min
  and loads the far end.
- **The print is ignored:** infill, walls, the build direction and the across-layer strength. The safety factor is
  `strengthInPlane / vonMises`.
- **The words over it are wrong.** It's labelled **In-house estimate**. The main plan's §9.2 meant the canned beam only
  for the Playwright spec, so the screenshot doesn't wait on a factorisation.
- **The sweep only scales.** Its rows are the same formula scaled by the load. Walls, infill and pattern variants change
  only the mass.
- **Two visual issues:**
  - The colour surface sits in the same plane as the solid, so the solid's grey top shows through it (z-fighting).
  - The pattern select shows "As printe".

S4 solves only the generated beam, which was its stated scope. `mcp/sim.ts` spawns `target/debug/lime-sim`, a debug
build in the checkout that an installed app doesn't ship.

## The bridge (Claude, SR-14, lands first)

A crate `crates/lime-sim-bridge` links `lime-slice-core` and `lime-sim`. `lime-sim` itself still links no slicer. It
exposes one call, used by both the Tauri command and the engine:

```rust
lime_sim_bridge::study_json(body: &str) -> String   // JSON in, JSON out; a refusal is { "ok": false, "reason": "<sentence>" }
```

Request:

```jsonc
{
  "request": { /* a SliceRequest for this object alone: the body a one-object slice sends, with its pose and settings */ },
  "study": {
    "hXy": 1.0,                      // optional; absent picks the largest that fits the node cap
    "card": { /* a Card, as src/sim/cards.ts holds it; "beads" optional */ },
    "holds": [ { "kind": "bed" }, { "kind": "region", "region": { "kind": "faces", "triangles": [[[x,y,z],[x,y,z],[x,y,z]], ...] } } ],
    "loads": [ { "kind": "force", "region": { ... }, "force": [0, 0, -25] },
               { "kind": "pressure", "region": { ... }, "mpa": 0.2 },
               { "kind": "torque", "region": { ... }, "origin": [..], "axis": [..], "torque": 100 } ],
    "loadCases": [ { "name": "snap", "loads": [ ... ] } ],   // instead of "loads", when there are several
    "constraints": [ { "kind": "minSafetyFactor", "value": 2 },
                     { "kind": "deflectionBandMm", "band": [1.5, 2.5], "region": { ... }, "loadCase": "snap" } ],
    "checkResolution": true
  }
}
```

- **Coordinates:** every point and direction is in the **model frame**, the frame the Model view's solid and its face
  ids are in. The bridge undoes the object's pose and the slice's own frame.
- **Faces:** a `faces` region carries the faces' **triangles**, because `lime-sim` has no B-rep. Take them from the
  solid's positions and its per-triangle face ids, the same arrays the view draws.
- **Winding:** keep the triangles wound as the model's are, counter-clockwise from outside. A surface face of the grid
  belongs to a model face only when their normals agree, so a face wound inward selects nothing. The reply then says
  "A hold's region touches no surface of the sliced part."
- **Regions:** the other kinds are `box` (`min`, `max`) and `near` (`point`, `radius`).

Reply:

```jsonc
{
  "ok": true,
  "report": { "representation": "sliced", "hXyMm": 1, "trust": "usable", "notes": [ ... ],
              "margins": [ { "kind", "limit", "band", "loadCase", "value", "margin", "met", "note",
                             "hotSpot": { "at": [x,y,z], "layer", "layerZMm", "role", "governs" } } ],
              "loadCases": ["default"], "rawMinSafetyFactor", "minSafetyFactor", "maxDisplacementMm", "massG",
              "resolutions": [ { "hXyMm", "nodes", "factorisations", "governingValue" } ] },
  "surface": { "triangles": 1234,                        // the solved part's outer surface, first load case
               "positionsB64": "...",                    // f32 x y z per triangle corner, model frame
               "displacementB64": "...",                 // f32 x y z per corner, model frame, unscaled
               "vonMisesB64": "...", "safetyB64": "..." } // f32 per corner: the cell average the margins read
}
```

The surface is the staircase of the sliced grid: within half a cell of the part, steps on slopes. Draw it as is. A
later improvement smooths it for display only.

## Tasks

### SR-08 (P0, Grok). Stop showing the formula as a result

- `cannedBeam` stays as a Playwright fixture only, reachable from the spec and not from the panel's Run.
- Until SR-09 lands, Run and Run sweep refuse with "The stress solve is not wired to the desktop yet."
- **Accept when:** `e2e/model-stress.spec.ts` still passes on its fixture, and no non-test code path calls
  `cannedBeam`.

### SR-09 (P0, Grok). Run solves through the bridge

Status: done (d1f2f4c3). Follow-ups: SR-15, SR-16, SR-18.

- A Tauri command `sim_study(body)` calls `lime_sim_bridge::study_json` on a blocking thread. Add the crate to
  `src-tauri`'s dependencies.
- **What the panel sends:**
  - the object's one-object slice request: the same body the plate builds for a single object, with its pose;
  - the study in the shape above. Holds and loads on faces go as their triangles, and "Bed" is `{ "kind": "bed" }`.
- **While it runs:** Cancel leaves the previous result. Show the stage the way slicing shows it, if the bridge's watch
  is easy to reach; otherwise the word "Solving".
- **Accept when:**
  - the bracket above, held on its foot's underside and pushed on the upright's top, gives a result whose highest
    stress is at the corner of the L;
  - a Playwright spec on a mocked `sim_study` reply draws it;
  - one `cargo test` in `src-tauri` runs the command on a small box.

### SR-10 (P0, Grok). Draw the sliced result

Status: done (1196af95), but a real solve draws no hot spots or margins until SR-15 lands. Words: SR-19.

- **The surface:**
  - draw `surface.positionsB64` displaced by `displacementB64 × scale`, coloured by the chosen field;
  - von Mises and displacement run from the low colour to the high one, and the safety factor is lowest-is-worst, as
    now.
- **The solid and the legend:**
  - hide the solid's own faces while a result is shown, or give the result `polygonOffset`, so nothing z-fights;
  - the legend reads "In-house estimate · as sliced", the trust word, and every note in `report.notes`.
- **Margins:**
  - each margin's `hotSpot.at` gets a small marker;
  - its row shows value, margin, `met`, and `note` when present, which is the band's side.
- **The probe** reads the nearest surface corner, as now.
- **Accept when:** a Playwright spec on a mocked reply checks the legend words, a marker at the hot spot, and a probe
  value.

### SR-11 (P1, Grok). The sweep reslices

Status: done (e6847afb). Follow-ups: SR-17, SR-20.

A variant of walls, infill or pattern is a different print, so each is one more `sim_study` with that setting on the
object's slice request. Up to 16, as now, and the status line says each variant is a slice plus a solve. A load-scale
variant may scale the base result: the solve is linear. Until this lands, refuse the print variants with a sentence
rather than scaling the formula.

### SR-12 (P1, Grok). The MCP solves real parts (the sliced plan's L5)

Status: done (9840536f), except `reslice` on `sim_sweep` (refused for now). Follow-ups: SR-16, SR-21.

- `sim_setup` takes `representation: "sliced"` and defaults to it for an STL or STEP part with a printer chosen, as
  decided in the sliced plan's §12.
- `sim_run` calls the engine's new `simStudy`, the same `study_json` in-process, which Claude adds with SR-14. Replace
  the `target/debug/lime-sim` spawn, which an installed app can't find.
- The reply carries `margins` and their hot spots. The guide (`lime://guide/sim`) gets the sliced plan's §7.2 table
  that maps `governs` to the change to try.
- **Accept when:** an MCP test solves a sliced box held on the bed and pulled on its top, and reads `margins` from the
  reply.

### SR-13 (P2, Grok). Panel details

- The pattern select is cut to "As printe" at 1440 px.
- The stress section is long. Put Run and Cancel where the other tools keep them, pinned at the foot of the dock.

### SR-14 (Claude). The bridge

Status: done. `crates/lime-sim-bridge`, the engine's `simStudy` and `sliceField` call it, and `lime-sim`'s
`sliced_study::draw_surface` builds the surface.

As specified above, with Rust tests:
- a placed box's result comes back in the model frame;
- the bracket's peak is at its corner;
- the engine's `simStudy` napi call answers the same JSON.

## Round 3: review of SR-09 to SR-12 (2026-10-22, at `9840536f`)

**What was run:**
- `cargo test -p lime-slice-desktop sim_study` passes (the small box goes through `sim_study`).
- Clippy is clean on `lime-slice-desktop`.
- The unit tests pass: `bridge-body`, `study` and `mcp/sim`.
- `mcp/sim-sliced.test.ts` loads the native engine and calls `simStudy`. That closes the one gap left in SR-14: the
  napi export now has a test.
- `e2e/model-stress.spec.ts`: the first test passes. The second, "a saved desktop solve is drawn as sliced", skipped,
  because `/tmp/lime-stress-box.json` was not there. It will skip in CI too (SR-18).

**What is good:**
- The solve runs on a blocking thread.
- The generation counter keeps a late reply from replacing a newer result, and Cancel keeps the previous one.
- Every refusal is a sentence.
- The surface hides the solid, so nothing z-fights.
- The MCP keeps the surface out of its reply.
- The guide has the `governs` table.

### SR-15 (P0, Grok). The panel sends its targets

- **The fault:** `buildStudyBody` (`src/sim/bridge-body.ts`) sends `hXy`, `card`, `holds`, `loads` and
  `checkResolution`, but no `constraints`. `sliced_study` builds `margins` only from `study.constraints`, so a real
  solve from the panel comes back with no margins:
  - no hot-spot markers;
  - no margin rows;
  - the sweep judges each variant with the client's own `constraintVerdict` instead of the bridge's margins.
- **Why the tests pass:** the e2e mock reply carries a margin, so nothing catches this.
- **Fix:**
  - send the panel's targets, Min safety factor and Max deflection, as `constraints`;
  - with no target typed, send `minSafetyFactor: 1`, so the worst spot is always marked;
  - a resliced sweep row reads `met` from its reply's margins.
- **Accept when:**
  - a `bridge-body` unit test shows the body carries the targets;
  - the e2e hook records the body it was sent and the spec checks for `constraints` in it.

### SR-16 (P0, Grok). The sliced mesh and the picked faces are in the same frame

- **The fault:** the study slices one mesh but takes its faces from another.
- **Desktop:** the study slices `meshBase64()`, which is either the plate's committed mesh or
  `scaledCanonical(source, partScale)`. But face triangles and `bounds` come from `viewed()`, the Modeler's solid
  (or the lens), which is not scaled and may not be committed. When the scale isn't 1, or there's an uncommitted edit,
  the holds miss the part ("touches no surface"), or land in the wrong place, and the hot spots don't sit on the solid
  drawn.
- **MCP:** `studyPositions` guesses that "the solid differs" when the triangle counts differ. An edit that keeps the
  count, such as a box parameter, slices the old mesh. A solid path also ignores `obj.scale`.
- **Fix:** slice the tessellation the faces were picked on, with the same scale applied to the mesh and to the face
  triangles. If that isn't possible, refuse with a sentence while the scale isn't 1 or the solid is uncommitted.
  Replace the triangle-count guess with the session's own committed or out-of-date state.
- **Accept when:**
  - a part at scale 2 with a face hold solves, with its hot spot inside the scaled bounds;
  - an uncommitted edit that keeps the triangle count either solves the edited solid or is refused (Desktop and MCP).

### SR-17 (P1, Grok). The sweep reuses the base only when it is the same study

- **The fault:** `baseResult` reuses `result` whenever it is sliced. If you change the load, card or holds and then
  sweep a load scale, the sweep scales the old result.
- **Fix:** keep the body text that `result` was solved from, and reuse it only on an exact match.
- **Accept when:** a unit test or spec changes the load, sweeps scale 2, and sees a new solve.

### SR-18 (P1, Grok). Hermetic tests

- **The fault:**
  - the Rust test writes `/tmp/lime-stress-box.json` when `LIME_STRESS_OUT=1`, and the spec reads it if present;
  - on Windows `/tmp` is `D:\tmp`;
  - in CI the file is never there, so the sliced-drawing test always skips.
- **Fix:**
  - check in a real reply as `e2e/fixtures/sim-study-box.json` (it's small: an 8 × 6 × 4 box);
  - the Rust test compares its reply's shape to the fixture: keys, triangle count > 0, margins with `hotSpot.at`;
  - it rewrites the fixture only under `LIME_STRESS_OUT=1`, into the repo path from `CARGO_MANIFEST_DIR`;
  - the spec always runs.
- **Accept when:** no `/tmp` path is left in `src-tauri/src/lib.rs` or `e2e/`, and the second stress test runs in CI.

### SR-19 (P2, Grok). Margins in words, and a cautious default

- **Margin rows:** a row now reads `minSafetyFactor: 2.50, margin 1.50, met above the band`. Write it the way the
  legend speaks: "Safety factor ≥ 1.0: 2.50 (margin 1.50) · met · above the band".
- **`governs`:** add a line with `governs` and the change to try, the same table as the guide (the sliced plan's §7.2).
  That line is what makes the loop guided.
- **Default trust:** `trustOf` in `bridge-body.ts` turns an unknown trust into `usable`. Make it `rough`, as the MCP
  already does.

### SR-20 (P2, Grok, or Claude if it needs the engine). Prove the pattern variant

- **The fault:** the slice request has no infill-pattern field. `stressSliceRequest` reaches a pattern through
  `blend: { mode: "weight", toughness }` (`PATTERN_TOUGHNESS`), and nothing checks that toughness 0.9 really gives
  gyroid.
- **Fix:** add a test that slices each patch and reads the pattern back. The slice summary or the slice field may
  already say it. If it doesn't, ask Claude for a `pattern` in the slice-field header, or an explicit `infillPattern`
  request field.

### SR-21 (P2, Grok). The MCP's sliced loop

- **Trust:** `sim_run` sends `checkResolution: false`, so a sliced MCP result can never be `converged`, yet the guide
  says "A converged result is the one to keep". Add `checkResolution` to `sim_run`: default true, and tests pass false.
- **The guide:**
  - step 4 says to use `sim_sweep`, which refuses a sliced study;
  - until `reslice` lands (the rest of the plan's L5), step 4 should say: for a sliced part, change the setting, then
    `sim_run`.
- **Tests:** `mcp/sim-sliced.test.ts` forces `representation: "sliced"` on a generated beam. Add the default path: an
  imported STL with a printer chosen and a pose that isn't identity, which is also the SR-16 frame case.

### Still open in the sliced plan

- **L5:** done by Claude on the owner's ask, 2026-10-22.
  - `sim_sweep {reslice: true}` slices each variant alone and solves it, and each row carries `slicerSeconds` and
    `slicerGrams` from its own slice. The bridge now returns `slice: {seconds, filamentG}`, and `sim_run` reports
    those too.
  - `parameters` variants are refused, as are kept pattern variants, since the pattern is the plate's blend.
  - Each variant solves at one cell size unless `checkResolution: true`.
  - `sim_run` and `sim_sweep` detach into background jobs like the other long calls.
  - The schema test now gives each tool a budget, 3 KB and 28 KB for `model_apply`. Growth fails on the tool that
    grew, by name, instead of on whoever next crosses the 78 KB total.
- **L6:** done by Claude on the owner's ask, 2026-10-22. See "L6 notes" below.

### Order

SR-15 and SR-16 first. They decide whether a real solve shows the right thing. Then SR-18, so CI sees the sliced
drawing, then SR-17, SR-21, SR-19, SR-20, and then L5 and L6.

Nothing new for Claude in this round, unless SR-20 needs the engine.

## L6 notes, and two items for Grok (Claude, 2026-10-22)

**What L6 adds:**
- **The bridge reply has a `cells` block:**
  - `partToSlice`, `originXy`, `hXy` and `slabs`;
  - `cellsB64`, with `u32 i, j, slab` and `f32` fraction, bead von Mises and safety per solid cell.
- **A Preview toolpath point in its object's part frame finds its cell.** The part frame doesn't depend on where the
  object sits on the plate, so a plate slice's layers read a study sliced alone.
- **The stress shown is the stress in the beads,** the cell's average over its fraction, so sparse infill reads what
  its struts carry.
- **Desktop:** `src/sim/stress-cells.ts` keeps the last solve's cells. The panel calls `rememberStressCells` after a
  successful Run: one line in `stress.ts`.
- **The Preview's Color by menu** has "Stress (as sliced)" and "Safety factor (as sliced)":
  - they're disabled, with the reason, until a study ran;
  - the note under the menu reads "In-house estimate · as sliced · <trust>." and the scale.
- **Colouring follows the cells exactly:**
  - **2D** cuts each bead where it crosses a cell line, and each piece takes its own cell;
  - **3D** looks the cell up per fragment, from a 3D texture of the grid, so a long bead changes colour where its
    cells do;
  - colouring a whole segment by its midpoint painted a 20 mm infill line one colour, which was wrong.
- **MCP:** `layer_image` takes `colourBy: stress | safety`, from the session's last sliced `sim_run`.
- **Tests:**
  - the bridge's frame round-trip through a pose;
  - `src/sim/stress-cells.test.ts`;
  - `mcp/layer-stress.test.ts`, added to the CI list;
  - `e2e/preview-stress.spec.ts`, which checks the 2D split at the cell line, the 3D shader and the legend.
- **`e2e/fixtures/sim-study-box.json`** was regenerated (`LIME_STRESS_OUT=1`), so it carries `cells`.

### SR-22 (P0, Grok). `tsc -p mcp` fails on the branch

CI's MCP job runs it, so the branch can't merge as is. At `f035fdd`:
- `mcp/request.test.ts(204)`
- `mcp/session.ts`: three errors, around `mergeParams`, the patch key and `slicerSeconds` in the sweep code
- `mcp/sim-sliced.test.ts(163, 231)`

None of these lines are in L6.

### SR-23 (P1, Grok). The sim tests aren't in CI

`mcp/sim.test.ts` and `mcp/sim-sliced.test.ts` are missing from the `mcp` job's list in `.github/workflows/ci.yml`.
Add them next to `mcp/layer-stress.test.ts`. `sim-sliced` needs the release engine that job already builds.

## Review of SR-20, SR-22 and SR-23 (Claude, 2026-10-22, at `8ffef90`)

**What was run:**
- `tsc --noEmit` and `tsc -p mcp --noEmit` are both clean.
- `mcp/pattern-slice.test.ts`, `mcp/sim.test.ts`, `mcp/sim-sliced.test.ts` and `mcp/layer-stress.test.ts` pass against
  a release engine built from `8ffef90`.

**What is good:**
- **SR-22** fixes the types without casting them away:
  - the wrong cast is gone;
  - the sweep's settings are applied by their own keys;
  - the sweep rows have a type;
  - the test's captured flags live in an object, which TypeScript can follow through the callback.
- **SR-23** runs the sim tests in the `mcp` job, after its release engine build.

### SR-24 (P0, Claude on the owner's ask). Move `pattern-slice.test.ts` out of the unit list

Status: done, and wider than first written. `mcp/sim.test.ts` and `mcp/sim-sliced.test.ts` were in the unit list too,
since S4: one spawns the `lime-sim` binary and the other loads the engine. In a copy with no `target/` and no
installed app, the list failed nine checks and stopped. All three now run only in the `mcp` job, which also builds
`lime-sim` in release. `solverPath` takes the release binary when there is one, else the debug one. The clean copy
passes the whole list.

- **The fault:** SR-20 added `mcp/pattern-slice.test.ts` to `tools/unit-tests.txt`. That list runs as
  `npm run test:unit` in the `ui` job too, which has no Rust toolchain and builds no engine. The test calls
  `loadNativeEngine`, which throws when no engine library exists, so the `ui` job fails. It passes locally only because
  a built engine is in `target/release`.
- **Fix:**
  - take the line out of `tools/unit-tests.txt`;
  - run it in the `mcp` job, next to `mcp/sim-sliced.test.ts`, after "Release CLI and in-process engine".
- **Accept when:** `npm run test:unit` passes in a checkout with no `target/` directory, and the `mcp` job lists the
  test.

## Validation of the sliced study (Claude, 2026-10-22)

### Real parts

Two company STEP parts were read by path only, and nothing derived from them was kept. Each had a 10 mm end held, 20 N
on the other end, the provisional PETG card, and the default cell size, through `lime_sim_bridge::study_json`.

| Part | Size, mm | Cell | Nodes, first size | Second size | Study time | Peak memory | Mass, solved and sliced |
|---|---|---|---|---|---|---|---|
| Rear cover | 311 long | 4.6 mm | 73,558 | skipped: past the cap | 25 s | 2.2 GB | 203.3 g and 199.1 g |
| Telo cover | 680 long | 6.3 mm | 62,603 | 4.4 mm, 136,452 nodes | 70 s | 4.6 GB | 403.6 g and 396.0 g |

Mass agrees with the slicer within 2%, and the hot spots sit on the parts. The Telo cover's governing deflection
moved 33% between the two sizes (0.28 to 0.42 mm), so it is honestly `rough`.

**Three faults the trial found:**

- **The default cell is far too coarse on thin parts.** `default_h_xy` sizes a dense grid of the bounding box. A
  cover fills a small part of its box, so the rear cover got 4.6 mm cells against ~0.9 mm walls and used a third of
  the node cap. The grid is too stiff, as the Telo cover's 33% move shows. Fix: count the solid cells of a coarse
  rasterisation and size from those.
- **Memory, not the node cap, is the limit.** 73k nodes peaked at 2.2 GB and 136k at 4.6 GB, so the 200k cap would
  need about 7 GB. The cap should come from a memory budget, or a node cap measured to fit one.
- **The TypeScript cards carry no bead constants** (`src/sim/cards.ts`). So the desktop and the MCP solve every
  sliced cell as a smear, while the Rust placeholder cards carry a provisional bead section. The trial's notes say
  so.

### The belt, end to end

`lime-sim-bridge/tests/bridge.rs`, `a_belt_slice_solves_the_same_bar_in_the_bar_s_frame`: a 20 × 6 × 4 bar on an
isotropic card, solved on a cartesian printer and on the IR3 V2's 45° belt:
- the tips agree within 2.3% (0.0954 and 0.0931 mm);
- the belt's layer normal is (0, −0.707, 0.707) in the bar's frame;
- every surface corner and the tip's hot spot land on the bar in its own frame.

### L5 acceptance: the guide's loop

`mcp/sim-loop.test.ts`, on the real engine, added to CI's `mcp` job. It follows the `sim` guide's loop: set up, run,
sweep, keep, run again.
- **A generated beam:** the smear, with no OCCT.
- **An STL:** sliced, with no OCCT, and its stress-coloured layer image.
- **The STEP sample:** sliced. It is skipped with the engine's reason where STEP can't be meshed.

All three pass locally.
