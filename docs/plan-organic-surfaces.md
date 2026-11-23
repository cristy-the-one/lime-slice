# Plan: Organic & Freeform Smooth Surfaces

Status: ready for implementation (all architectural & UX decisions locked via `/grill-me`). Written 2026-11-22 against `main` at `e6625f97` (v7.1.0).
Integration branch: `feature/organic-surfaces` (branched from `origin/main` so beta releases can ship independently without interfering with `main` until the full plan is ready to merge).

---

## 1. Plain-English Mental Model (How 3D Organic Surfaces Work)

Before diving into OCCT classes and data structures, here is the intuitive picture of how CAD tools represent smooth, organic shapes:

1. **Analytic shapes vs. Freeform (NURBS) shapes**
   - A box, cylinder, cone, sphere, or torus is described by a tiny exact formula (like "center + radius").
   - An organic shape—a mouse shell, an ergonomic handle, a drone canopy, a sculpted fairing—cannot be described by a single circle or plane. CAD represents it using **NURBS** (*Non-Uniform Rational B-Splines*).
2. **How a NURBS curve or surface is controlled**
   - Imagine a flexible elastic wire (curve) or stretchy cloth (surface) pulled by magnets floating nearby:
     - **Control points (poles / CVs):** the magnets. Moving one magnet pulls only its local neighborhood, keeping the rest of the curve/surface calm.
     - **Degree (usually 3 = cubic):** how stiff or smooth the wire is. Degree 1 is straight segments; degree 3 is the sweet spot for smooth, organic curves without wiggles.
     - **Weights:** how strong each magnet is. Equal weights (`1.0`) give a standard smooth spline; boosting a weight pulls the surface tighter toward that magnet—and lets NURBS represent **exact** circles, arcs, and ellipses with zero error.
     - **Knots (and knot multiplicity):** invisible seams along the wire that decide how smoothly two sections join. Repeating a knot lets you put an intentional **sharp crease** inside an otherwise smooth curve or surface.
   - **Isoparametric curves ("isoparms"):** the natural $U$ and $V$ grid lines running across the stretchy cloth—like latitude and longitude lines. Clean, evenly spaced isoparms mean a healthy surface that fillets, shells, and slices reliably.
3. **Continuity ($G^0$, $G^1$, $G^2$) — why two surfaces look "seamless" or "kinked"**
   - **$G^0$ (Touching / Position):** Two surfaces meet with no gap, like two sheets of paper taped at an angle. You see a sharp edge.
   - **$G^1$ (Smooth / Tangent):** Both surfaces arrive at the seam facing the same direction (like a standard circular fillet). No sharp crease, *but* a shiny reflection still shows a subtle sudden bend where flat meets round.
   - **$G^2$ (Curvature-continuous / "Apple-smooth"):** Both direction *and* rate of bending match across the seam. Light reflections glide across the seam with zero visual break—the hallmark of consumer-product / automotive / ergonomic industrial design.
   - **Zebra Stripes:** An instant visual lie detector. The viewport wraps black-and-white reflection bands over the part: broken stripes = $G^0$ gap/corner; stripes that meet with a sharp V-kink = $G^1$; stripes that flow smoothly across the seam = $G^2$.
4. **Open Surfaces ("Sheets") vs. Watertight Solids**
   - For 3D printing and booleans, a finished part must be a **watertight solid** (a closed volume with no leaks).
   - Organic designs are often much easier to build as thin open skins ("sheets") first—sculpting a curved lid, fairing, or grip—and then turning them into a solid by **Thickening** (giving the skin wall thickness), **Sewing** multiple skins together into a closed shell, or **Splitting/Trimming** an existing solid block with the sculpted skin.
5. **Exact Math vs. Display Triangles (Tessellation)**
   - Inside Lime Slice, OCCT stores the **exact** mathematical NURBS B-rep (for STEP export, booleans, fillets, and slicing accuracy).
   - Your graphics card draws triangles. Converting exact surfaces into display triangles is **tessellation**. If we also send OCCT's **exact mathematical surface normals** to the GPU instead of guessing normals from flat triangles, surfaces look smooth and Zebra stripes stay accurate *without* exploding triangle counts or slowing down the viewport.

---

## 2. Core Non-Negotiable Principle: Exact NURBS Everywhere

**The exact NURBS representation is the single source of truth across every layer of Lime Slice:**

- **No silent approximations between UI and kernel:** When a user draws a NURBS curve in a 2D sketch or drags control points on a 3D surface, the client evaluates the **exact same rational Cox–de Boor B-spline formula** (same poles, weights, degree, and knot vector) that Open CASCADE constructs in `Geom_BSplineCurve` / `Geom_BSplineSurface`.
  - Today, `src/sketch/geom.ts` draws splines with centripetal Catmull-Rom ("close enough to draw") while `kernel.cpp` builds `GeomAPI_Interpolate`. This plan eliminates that mismatch for NURBS curves and verifies TS-vs-OCCT parity to `< 1e-6 mm` in automated tests.
- **Exact topology & STEP round-trip:** Every curve, sweep, loft, patch, blend, and sculpted surface remains a true analytical/NURBS B-rep inside Open CASCADE (never downgraded to triangle-mesh hacks), preserving lossless STEP AP242 export, exact fillets, exact booleans, and clean slicing.
- **Zero new native dependencies:** All 14 required OCCT 7.9.2 headers (`Geom_BSplineCurve`, `Geom_BSplineSurface`, `GeomFill_BSplineCurves`, `GeomFill_ConstrainedFilling`, `BRepOffsetAPI_MakeFilling`, `GeomPlate_BuildPlateSurface`, `BRepOffsetAPI_MakePipeShell`, `ChFi3d_FilletShape`, `Law_Interpol`, `GeomConvert`, `ShapeUpgrade_ShapeDivideContinuity`, `ShapeFix_Shape`) are already installed and linked via `crates/lime-model-occt/build.rs`. `BRepOffsetAPI_MakeFilling` and `GeomPlate_BuildPlateSurface` stay in that set; S5 does not call them (R2.3, R2.4).

---

## 3. What Lime Slice Has Today vs. Gaps

| Area | Current implementation | Gaps for organic surfaces |
|---|---|---|
| **2D / 3D Curves** | `ProfileSegment::Spline { through, to }` (`ops.rs:464`), `GeomAPI_Interpolate` (`kernel.cpp:4901`), `SketchEntity::spline` (`src/sketch/model.ts:45`) | Interpolated through-points only. No control-polygon (CV) NURBS, no weights, no knot vectors/creases, no endpoint tangent/curvature constraints, no 3D space/guide/projected curves. 2D sketch preview uses Catmull-Rom instead of OCCT's B-spline. |
| **Sweep** | No `Op::Sweep` in `ops.rs`. `src/sketch/sweep.ts` fakes sweeps as sampled `Op::Loft` (`MAX_SAMPLES = 16`, `SHARP_DEG = 25°` hard refusal). `BRepOffsetAPI_MakePipeShell` is only used inside `Transition` wedges (`kernel.cpp:2173`). | Rippled/bloated lofted skin; refuses sharp bends; no corner modes (round/right/transformed); no guide rails, auxiliary spine, or smooth scale/twist laws. |
| **Loft** | `Op::Loft` (`ops.rs:620`), `BRepOffsetAPI_ThruSections` (`kernel.cpp:5242`, `6461`) | Only exposes `ruled: bool`. No guide rails, no start/end $G^1$/$G^2$ boundary tangency, no point-apex caps, no seam alignment, no closed periodic loft, no degree/smoothing cap. |
| **Fillets & Blends** | `Op::Fillet` (`ops.rs:516`), `BRepFilletAPI_MakeFillet` (`kernel.cpp:1689`) | Constant-radius circular ($G^1$) only. No variable-radius fillets, no $G^2$ curvature-continuous blends, no conic-$\rho$, no face-to-face surface blend. |
| **Freeform Surfaces & Sheets** | None. Every kernel node enforces `has_solid`. No `splitFace` op (also noted in `docs/plan-rib-thicken-blend.md`). | Cannot build direct NURBS surfaces, Coons/Gordon 4-sided patches, $N$-sided $G^1$/$G^2$ fill patches, or author open skins before sewing/thickening/trimming into a solid. |
| **Shading & Inspection** | `src/model-view/smooth.ts` welds triangle normals in JS on the main thread; `src/model-view/mesh.ts` uses one `MeshStandardMaterial`. | Triangle-averaged normals hide $G^1$ vs $G^2$ breaks and cost main-thread time. No Zebra stripes, curvature heatmap, UV isoparm overlay, curvature combs, or analytical edge-continuity checks. |
| **Tessellation & Speed** | `kernel.cpp:627-685` already has parallel Delabella meshing + Watson fallback + `mesh_around_made` incremental face meshing. | Fixed `Angle = 0.5 rad` (~28.6°) facets curved highlights; no fast preview vs. final chord pipeline; no 60 fps client-side NURBS preview during CV drags; pole/knot bloat slows downstream booleans & shelling. |

---

## 4. Locked Architectural Decisions

### D1. Open Surfaces ("Sheets") Live Directly in the Part History Tree
- Open B-rep faces/shells (`TopoDS_Face` / `TopoDS_Shell`) are first-class nodes in the same History tree—not hidden in a separate construction tree.
- They display a clear **Surface / Sheet** badge in History, two-sided backface tint + distinct naked-edge highlight in the 3D viewport, and keep the exact same undo, replay, and History Edit lifecycle as solids.
- Slicing and solid-only exports continue to require a closed watertight solid; sending an open sheet toward Print surfaces a direct **Thicken** or **Sew to Solid** action.

### D2. Milestone Order: S1 → S6 Sequentially
1. **S1** — Performance & Inspection Foundation (OCCT analytic normals, adaptive chord/angle, Zebra, Curvature, Isoparms, analytical $G^0$/$G^1$/$G^2$ checks).
2. **S2** — Exact NURBS Curves (2D sketch + 3D curves) & Real Kernel `Op::Sweep`.
3. **S3** — Continuity-Controlled `Op::Loft` + Variable-Radius & $G^2$ `Op::Fillet`.
4. **S4** — Open Surfaces ("Sheets") & Surface-to-Solid Workflow (`Sew`, `Thicken`, `TrimSplit`, `ReplaceFace`, `SplitFace`).
5. **S5** — Boundary / Coons / Gordon / $N$-Sided `Op::Patch` & `Op::BlendSurface`.
6. **S6** — Direct NURBS Surface Primitive (`Op::NurbsSurface`) & 60 fps CV Sculpting.

### D3. SubD Control Cage → Exact NURBS Deferred to S7 (Hooks Reserved Now)
- SubD cage modeling (Catmull-Clark control cage converted into exact bicubic `Geom_BSplineSurface` patches + `Op::Sew`) stays out of S1–S6 so core NURBS B-rep ships cleanly and fast.
- Data-model hooks (`Sheet` nodes, multi-patch `Op::Sew`, `Op::NurbsSurface` patch topology, and CV gizmo infrastructure) are designed in S4–S6 so S7 plugs directly into the exact same B-rep pipeline later.

### D4. Feature Branch & Beta Release Workflow
- **Integration branch:** `feature/organic-surfaces` (branched from `origin/main`). Never pushes half-finished surfacing features to `main`.
- **Per-milestone work:** Each milestone lands via a focused PR (e.g. `organic-surfaces/s1-inspection-normals` → `feature/organic-surfaces`) with full CI verification.
- **Sync with `main`:** Periodically merge `origin/main` into `feature/organic-surfaces` so the branch never drifts far behind ongoing releases.
- **Beta releases:** Cut prerelease tags directly from `feature/organic-surfaces` (e.g. `v7.2.0-organic-beta.1`, `v7.2.0-organic-beta.2`). Note: `.github/workflows/release.yml` line 41 currently checks `[[ "$tag" == *-tandem-beta.* ]]` for `prerelease=true`; in Milestone S1 we will broaden that check on `feature/organic-surfaces` to `[[ "$tag" == *-beta.* ]]` so every organic-surfaces beta tag automatically publishes as a GitHub **Pre-release** without affecting stable releases on `main`.
- **Final merge:** Once S1–S6 are complete and beta-tested, merge `feature/organic-surfaces` into `main` cleanly.

### D5. MCP & `lime-recipe` First-Class Parity
- Every new op ships in the same milestone with:
  - Compact MCP JSON schemas (respecting the first-contact token budget),
  - Rust helpers in `crates/lime-recipe`,
  - `.lime` project file serialization and backward-compatible load of all pre-existing files.

---

## 5. Requirements

### R1 — Exact NURBS Curves & Surfaces
- **R1.1 Exact 2D & 3D NURBS Curves**: `poles`, optional `weights` (default `1.0`), `degree` (default `3`), optional `knots` & `multiplicities` (enabling exact conics and sharp creases at multiplicity $= p$), `periodic`, and optional endpoint tangent/curvature constraints.
- **R1.2 Zero Preview/Kernel Drift**: Pure-TS rational Cox–de Boor evaluator (`src/modeling/nurbs-eval.ts`) matches OCCT `Geom_BSplineCurve` / `Geom_BSplineSurface` evaluation within `1e-6 mm`.
- **R1.3 Direct NURBS Surfaces**: $M \times N$ pole grid, optional weights, $U$/$V$ degrees (default $3 \times 3$), clamped or periodic $U$/$V$ knots, knot insertion / degree elevation, and interactive CV editing (single pole, row/column isoparm, soft falloff, symmetry mirror).

### R2 — Continuity-Aware Surface Creation & Blending
- **R2.1 True Kernel Sweep (`Op::Sweep`)**: Real `BRepOffsetAPI_MakePipeShell` supporting 2D/3D spine wires (`Curve3D`), sharp-corner transitions (`round`, `right`, `transformed`), multi-section profiles, guide rails / auxiliary spine, orientation modes (`correctedFrenet`, `fixedBinormal`, `auxSpine`), and smooth `Law_Interpol` scale/twist laws.
- **R2.2 Controlled Loft (`Op::Loft` v2)**: Optional 3D guide rails, start/end $G^1$/$G^2$ boundary conditions (tangent/curvature to adjacent face, normal to plane, or vector + tension), point-apex caps, closed periodic lofts, seam alignment, and max-degree cap.
- **R2.3 Boundary / Gordon / $N$-Sided Patch (`Op::Patch`)**: A clean 2–4 curve $G^0$ boundary, with no interior guides, still goes to `GeomFill_BSplineCurves` / `GeomFill_ConstrainedFilling`. There is no `GeomFill_Coons` class: the G0 four-curve fill uses `GeomFill_BSplineCurves` with `GeomFill_CoonsStyle`. An opening that asks for $G^1$ or $G^2$ on any side, and any opening of 5 or more sides, is $N$ true four-sided Hermite–Coons pieces around one centre point, each stored as a `Geom_BSplineSurface`. Side $i$ is split at its arc-length midpoint $M_i$. Piece $i$ has corners $V_i$, $M_i$, $C$, and $M_{i-1}$: two outer half-sides meeting at $V_i$, and two inner splits $M_i \to C$ and $M_{i-1} \to C$. No piece is collapsed onto $C$. That is the Gordon construction for one cell (the Boolean sum of the two directional Hermite blends, minus the corner correction). `BRepOffsetAPI_MakeFilling` and `GeomPlate_BuildPlateSurface` are not on this path.
- **R2.4 Variable-Radius & $G^2$ Fillets + Surface Blends (`Op::Fillet` v2, `Op::BlendSurface`)**: Fillets stay as they are: `continuity: "g1" | "g2"` (`ChFi3d_Rational` vs. `ChFi3d_QuasiAngular` / `ChFi3d_Polynomial` + `GeomAbs_G2` / conic $\rho$), variable-radius stations along edges via `Law_Interpol`. `BlendSurface` is a separate Hermite `Geom_BSplineSurface` across two open edges or edge chains: degree 3 across the gap for $G^1$, degree 5 for $G^2$. The cross-edge derivatives come from the adjacent faces at the edge, through `BRepLProp_SLProps`, scaled by the tension. No `GeomPlate`.
- **S5 acceptance (R2.3 and R2.4)**: Every patch or blend edge that was asked to meet a neighbour shows a $G^0$ gap under $10^{-4}$ mm. Where $G^1$ was asked, the normal angle is under $0.1°$. Where $G^2$ was asked, the curvature jump is not greater than $10^{-3}\,\text{mm}^{-1}$. That is `model_check`'s own test: `edge_kjump > 1e-3` classifies the edge as G1, and the edge is G2 only in the else branch (`crates/lime-model-occt/cpp/kernel.cpp:9611`). A looser $0.05\,\text{mm}^{-1}$ bound would pass a patch that `model_check` still reports as not G2. If knot insertion cannot reach $10^{-3}\,\text{mm}^{-1}$, the op refuses. The S3 analytic $G^2$ fillet keeps this same $10^{-3}\,\text{mm}^{-1}$ threshold. `model_check` lists every shared edge in `continuity.edges`, including a clean G2 edge. The cases are the same three openings, 3, 5, and 6 sides, plus the two-edge blend, each at the continuity that was asked, sewn to a `BRepCheck_Analyzer`-valid solid with zero naked edges.
- **Sharp corner (one acceptance opening)**: If the two support faces at a vertex $V_i$ meet at more than $0.1°$, no surface can be $G^1$ to both faces at that point. $G^1$/$G^2$ on the two half-sides is measured along those edges and not at $V_i$. The stations are the ones `model_check` already uses, fractions $0.1, 0.3, 0.5, 0.7, 0.9$ of the edge parameter (`kernel.cpp:9568`). The angle is the same normal test as an edge: `acos` of the dot product after reversing a normal on a `TopAbs_REVERSED` face. `model_check` names the vertex in `continuity.sharpVertices`: `{ at:[x,y,z], faces:[a,b], angleDeg }`. The 3-sided acceptance opening has one such vertex. The fill still has to meet the edge bounds on the stations away from it, and the report has to name it. The 5-sided and 6-sided openings have no such vertex. Refusing the whole fill is not the rule: a corner the walls already have is not a failed patch.

#### R2.3 construction — $N$ Hermite–Coons pieces

Build one `Geom_BSplineSurface` per vertex of the opening, by midpoint subdivision, then sew the pieces to each other and to the opening with the existing `Op::Sew`. Do not call `GeomPlate`. No piece collapses to $C$, so no centre row is degenerate, no split edge sews as a point, and the normal at $C$ is the cross product of the two split tangents.

1. **Loop.** Convert each side with `GeomConvert::CurveToBSplineCurve`. A side that is an edge chain is concatenated first (`GeomConvert_CompCurve`, then `CurveToBSplineCurve`). Order the curves into one closed loop and reverse a curve when its end is farther from the previous curve's end than its start is. Consecutive ends that do not meet are a refusal, the same refusal the G0 fill already uses.
2. **Centre point.** Sample each of the $N$ curves at 16 equal arc-length stations (`GCPnts_AbscissaPoint`; if the length query fails, 16 equal parameter steps). The centre $C$ is the arithmetic mean of those samples, so each side has equal weight.
3. **Centre plane.** Let $N_c$ be the normalized sum of the support-face unit normals at each edge midpoint. Take each normal from `BRepLProp_SLProps::Normal()` and reverse it when the face is `TopAbs_REVERSED`, which is the orientation `model_check` already uses. A side with no support face contributes nothing. If that sum is shorter than $10^{-9}$, $N_c$ is Newell's normal of the sample polyline.
4. **Midpoints, then one shared split per side.** $M_i$ is the arc-length midpoint of side $i$ (`GCPnts_AbscissaPoint` at half the length; if the length query fails, the parameter midpoint). `Geom_BSplineCurve::Segment` splits the side there, so each half keeps that side's poles. The inner curve of the fill runs from $M_i$ to $C$, not from $V_i$. It is a cubic Bézier, degree 3, knots $\{0,0,0,0,1,1,1,1\}$, weights 1. Piece $i$ and piece $i+1$ store that same curve.
   - The plane at $M_i$ is the tangent plane of side $i$'s own support face. Its normal is `BRepLProp_SLProps::Normal()`, reversed when the face is `TopAbs_REVERSED`.
   - The tangent at $M_i$ is the tension-scaled transverse derivative of that one face (step 6), projected onto this plane, then given length $|C - M_i|$. If that derivative is shorter than $10^{-9}$, project $(C - M_i)$ onto the plane and use that direction with the same length.
   - The arrival tangent $T_c$ at $C$ is $(C - M_i)$ projected onto the centre plane, length $|C - M_i|$. If the projection is shorter than $10^{-9}$, use $(C - M_i)$ unprojected, same length. Every $T_c$ lies in the centre plane.
   - Poles: $Q_0 = M_i$, $Q_1 = M_i + T_M/3$, $Q_2 = C - T_c/3$, $Q_3 = C$.
5. **Parameter of piece $i$.** The four corners are $V_i$, $M_i$ on side $i$, $C$, and $M_{i-1}$ on the previous side. Set $P_{00} = V_i$, $P_{10} = M_i$, $P_{11} = C$, $P_{01} = M_{i-1}$.
   - $v = 0$: half of side $i$, $V_i \to M_i$. Outer edge.
   - $u = 0$: half of side $i-1$, $V_i \to M_{i-1}$. Outer edge.
   - $u = 1$: split $M_i \to C$, shared with piece $i+1$.
   - $v = 1$: split $M_{i-1} \to C$, shared with piece $i-1$.
   Both directions carry a ribbon, so both degrees follow the continuity asked on those outer halves. $G^1$: degree at least 3. A single span uses flat knots $\{0,0,0,0,1,1,1,1\}$. $G^2$: degree at least 5. A single span uses six $0$s and six $1$s. A half-side keeps a finer knot vector when it has one. Unify each opposite pair with `IncreaseDegree` to the higher degree, then `InsertKnots` of the union. The curve opposite a half-side is one split; `IncreaseDegree` raises that cubic to the pair's degree, and both pieces read the raised poles back from the same curve.
6. **Outer ribbons, from each face, scaled by tension.** On each outer half, at each Greville station of that half, evaluate the support with the same property object the continuity check uses: `BRepLProp_SLProps(BRepAdaptor_Surface, 2, 1e-9)`, parameters from `BRep_Tool::CurveOnSurface`. Read `D1U`, `D1V`, and for $G^2$ also `D2U`, `D2V`, `DUV`. Edge tangent $T_e$ comes from `BRepAdaptor_Curve::D1`, normalized. Face normal $N$ is `Normal()`, reversed when the face is `TopAbs_REVERSED`. The in-face unit transverse is $B = N \times T_e$. Step from the edge along $B$ and classify with `BRepClass_FaceClassifier`; if the step is `TopAbs_IN`, flip $B$, so $B$ points out of the face and into the piece ($+v$ on $v = 0$, $+u$ on $u = 0$). With $S_u = \mathtt{D1U}$, $S_v = \mathtt{D1V}$, $E = S_u\cdot S_u$, $F = S_u\cdot S_v$, $G = S_v\cdot S_v$, and $\Delta = EG - F^2$: if $\Delta < 10^{-18}$ the face is singular here and the op refuses. Otherwise
   $a = (G\,(S_u\cdot B) - F\,(S_v\cdot B)) / \Delta$, $b = (E\,(S_v\cdot B) - F\,(S_u\cdot B)) / \Delta$,
   $D_s = a S_u + b S_v$, and $D_{ss} = a^2\,\mathtt{D2U} + 2ab\,\mathtt{DUV} + b^2\,\mathtt{D2V}$.
   Let $g$ be the distance from this edge point to $C$, and let $\lambda = \mathrm{tension}\cdot g$ with the per-edge tension defaulting to $1$. A tension $\le 0$ is a refusal. On $v = 0$ the prescribed derivatives are $\partial S/\partial v = \lambda D_s$ and, for $G^2$, $\partial^2 S/\partial v^2 = \lambda^2 D_{ss}$. On $u = 0$ they are $\partial S/\partial u = \lambda D_s$ and $\partial^2 S/\partial u^2 = \lambda^2 D_{ss}$. The second derivative uses a parameter speed that is locally constant ($\mathrm{d}^2 s/\mathrm{d}u^2 = 0$ at the boundary). A $G^0$ half has no face ribbon: the first derivative points from the sample to $C$, and the second derivative is $0$.
7. **Poles from the boundary curves and the single-span identities.** The four boundary rows of poles are the two half-sides and the two degree-elevated splits. Do not rebuild those rows. With no guide knot each ribbon direction that is a single span has parameter length $1$, so a degree-$p$ end has $\partial S/\partial t = p(P_1 - P_0)$ and $\partial^2 S/\partial t^2 = p(p-1)(P_2 - 2P_1 + P_0)$. The row next to an outer boundary is that identity applied to the face ribbon. The row next to a split is the same identity applied to that piece's own cross field $R$ from step 8. For $G^2$ the second row uses $A/20$ on an outer boundary and that piece's transverse second derivative from step 8 on a split, with the quintic end poles $P$, $P + T/5$, $P + 2T/5 + A/20$ at the start of a span and $P - T/5$, $P - 2T/5 + A/20$ at the end. These offsets are only for a span of length $1$. After a guide knot at $0.5$, recover the interior poles from $Q_i = p/(u_{i+p+1} - u_{i+1})\,(P_{i+1} - P_i)$, applied once for the first derivative and again, at degree $p-1$, for the second. $C$ is the single corner pole $P_{11}$, not a collapsed row. Both partials there are the two arrival tangents, so the normal is $T_c(M_{i-1}) \times T_c(M_i)$, parallel to $N_c$.
8. **One shared plane along a split, and a cross field per piece.** There is no shared cross-derivative. Piece $i$'s $\partial S/\partial u$ at $C$ on split $i$ is the arrival tangent of split $i-1$, and piece $i+1$'s $\partial S/\partial v$ there is the arrival tangent of split $i+1$. Those are different vectors for $N \ne 4$, so one $W(1)$ cannot satisfy both corners. Parameter $s$ runs from $0$ at $M_i$ to $1$ at $C$. The shared cubic is unchanged.
   - **Shared unit normal $n(s)$.** $n(0)$ is side $i$'s face unit normal at $M_i$, with the same `TopAbs_REVERSED` reversal as step 6. $n(1)$ is $N_c$. Let $\theta = \arccos(\mathrm{clamp}(n(0)\cdot n(1), -1, 1))$. If $\theta < 10^{-9}$, the raw normal is $n(0)$. If $\pi - \theta < 10^{-9}$, the two normals are opposite and the op refuses, naming the split by its side index. Otherwise the raw normal is the slerp $\sin((1-s)\theta)/\sin\theta\; n(0) + \sin(s\theta)/\sin\theta\; n(1)$. Let $t(s)$ be the shared cubic's unit tangent. Replace the raw normal by $n - (n\cdot t)\, t$ and normalize. If that vector is shorter than $10^{-9}$, the split tangent is parallel to the interpolated normal: the op refuses, with a sentence that names the side index and the parameter $s$. Both pieces use this $n(s)$.
   - **Cross field, one per piece.** Piece $i$ stores $R_i(s) = \partial S/\partial u$ along $u = 1$. Piece $i+1$ stores $R_{i+1}(s) = \partial S/\partial v$ along $v = 1$. At $s = 0$ the corner fixes it: it is that piece's outer-half tangent at $M_i$, which lies in the face plane. The step 6 ribbon at $M_i$ is the split's departure tangent, already on the shared cubic, and is not this cross field. At $s = 1$ the corner fixes it again: $R_i(1) = T_c$ of split $i-1$, and $R_{i+1}(1) = T_c$ of split $i+1$. In between, $R(s) = (2s^3 - 3s^2 + 1)\, R(0) + (-2s^3 + 3s^2)\, R(1)$, then $R \leftarrow R - (R\cdot n)\, n$, so $R$ lies in the plane that contains the split tangent. The ends are already in that plane, so the projection leaves them as the corner set them. Both cross fields then lie in one plane with the split tangent, and the tangent planes match on the whole split.
   - **$G^2$, the same shape, matched on the normal component.** Each piece builds $A(s)$ the same way. $A(0)$ is that side's $\lambda^2 D_{ss}$ at $M_i$ (0 when the side is $G^0$). $A(1)$ is the other split's $S''(1) = 6(Q_3 - 2Q_2 + Q_1)$. The blend is the same cubic Hermite. Keep the normal component: it is the curvature. Let $R_\perp$ be the part of $R$ perpendicular to $t$. If $|R_\perp| < 10^{-9}$ the op refuses, naming the side index and $s$. The normal curvature of a piece is $\kappa = (A\cdot n) / |R_\perp|^2$. Replace $(A\cdot n)\, n$ on both pieces by $\kappa_\ast |R_\perp|^2\, n$, where $\kappa_\ast$ is the average of the two pieces' $\kappa$. The tangential part of $A$ stays with the piece. At $s = 0$ both pieces start from the same face, so $\kappa_\ast$ is that face's normal curvature. Step 11 measures the jump that remains.
   Write $R$ and $A$ into the interior row next to the split. Do not move either outer boundary row, and do not move the split's own poles.
9. **Twist where two ribbons of the same piece meet.** The diagonal pole, one step in from both boundaries, is claimed by both ribbons of that one piece. A single polynomial cannot honour both unless the mixed partials agree, so that pole stores the average $\tau = \partial^2 S/\partial u\partial v$ of those two candidates. Do not average a candidate from the neighbouring piece. Solve for the pole from the Bézier identity at that corner: $\tau = n^2$ times the alternating sum of the corner pole, the two adjacent poles, and the diagonal pole, with each sign taken from $\partial^2/\partial u\partial v$ of the Bernstein basis at that corner ($n = 3$ or $n = 5$). At a parameter-$0$ end the first-derivative step adds $T/n$; at a parameter-$1$ end it subtracts $T/n$. Pure second-derivative poles stay on their own ribbon. Any higher mixed pole that both ribbons of this piece claim uses the same average.
   - **At $V_i$ (both outer ribbons).** The two candidates are the derivative of side $i$'s ribbon along that half-side, and the derivative of side $i-1$'s ribbon along the other half-side. If the two support faces meet at more than $0.1°$, the ribbons lie in different planes and the average still builds the polynomial; the acceptance check does not sample this vertex (the sharp-corner rule above).
   - **At $M_i$ and at $M_{i-1}$.** One candidate is the derivative of this piece's outer ribbon along its half-side. The other is $\mathrm{d}R/\mathrm{d}s$ at $s = 0$ of this piece's own cross field, after the projection in step 8. The piece on the other side of the split has its own $R$ and its own diagonal pole.
   - **At $C$.** Each piece's two first derivatives are the arrival tangents of its own two splits, both in the centre plane, so its normal is $N_c$. The two twist candidates are $\mathrm{d}R/\mathrm{d}s$ at $s = 1$ on each of those splits, using that piece's own projected $R$. Adjacent pieces share the split curve and $n(s)$. They do not share $R$ or this twist.
10. **Guide points, and only guide points, may move a free pole.** GeomPlate is not called, including as a fallback. With no guide point a single-span net is fixed by the four boundaries and the four twist poles, and there is no free pole. With a guide point, insert one knot at $0.5$ in $U$ and in $V$. The new interior pole starts at the single-span Coons point at $(0.5, 0.5)$, then moves along $N_c$ only. If the point is already within $10^{-4}$ mm of the piece, leave the poles. If a moved pole would land farther from $C$ than twice the longest centre-to-sample distance, the op refuses. Boundary poles, ribbon poles, and split poles stay where steps 7–9 put them.
11. **Check, then insert knots, then refuse.** Wrap each surface with `BRepBuilderAPI_MakeFace`. Measure every asked edge, including each shared split, with the same `BRepLProp_SLProps` station loop `model_check` uses, at the five stations in `kernel.cpp:9568`, and do not add a station at a sharp vertex. The per-piece fields of step 8 are not a separate pass: this loop is the acceptance test. A polynomial outer half (every weight $1$) meets its boundary row exactly, because that row is the curve's poles. A rational outer half (an arc) keeps the curve weights on that row and weight $1$ on every interior row; the angle is then what the check measures. The $G^2$ test is `model_check`'s: a curvature jump greater than $10^{-3}\,\text{mm}^{-1}$ fails. When a bound is missed, insert one knot at the middle of each failing span, in whichever parameter runs along that edge, and rebuild. Stop when the bounds hold, or when a failing span is shorter than $10^{-3}$ of that edge's length: then refuse. Do not hand the opening to GeomPlate.

#### R2.4 construction — Hermite `BlendSurface`

One surface, two edges, no centre and no splits.

1. Convert each edge or chain the same way as a patch side. Pair endpoints by nearest point and reverse the second curve when the pairing crosses. Translate and scale both knot vectors so both domains are $[0,1]$. `IncreaseDegree` to $\max(d_0, d_1, 3)$, then `InsertKnots` until both curves share one knot vector and one multiplicity vector (the union, multiplicity the max). $U$ on the surface is that common vector, so each input edge is a $V$ row. The $V = 0$ row and the $V = 1$ row are the two curves' poles, and the gap along those edges is exact for polynomial curves.
2. $V$ runs from the first edge to the second, one clamped span. $G^1$: degree 3, flat knots $\{0,0,0,0,1,1,1,1\}$. $G^2$: degree 5, flat knots six $0$s and six $1$s. Weights on the two boundary rows are the curve weights. The interior rows that carry the cross-boundary derivatives take that rim's weights: for $G^1$ the one row beside each rim, for $G^2$ the two rows beside each rim. Each side keeps its own weights, so two different arcs still meet. The weight is then stationary across the rim ($\partial w/\partial v = 0$, and $\partial^2 w/\partial v^2 = 0$ for $G^2$), and the single-span identities of step 4 are the geometric derivatives of a rational circle or arc. An interior weight of $1$ against a rational rim leaves $\partial w/\partial v \ne 0$. On the coaxial exact circles that measured $0.315°$ short of $G^1$ (#818): boundary weights $1$ and $0.80473785$, every interior weight $1$.
3. At each $U$ Greville station, take $D_s$ and $D_{ss}$ from the wall face that contains that point, by the same `BRepLProp_SLProps` procedure as R2.3, with $B$ pointing into the gap (the classifier flip above). A circle made of two arcs is two faces; the first edge's face does not contain the other arc, and projecting the other arc onto it flips the cross derivative. A sample that lies on the seam of those faces can still take the other side. It is reversed when it opposes the rest of that rim. $D_{ss}$ is unchanged: it is even in that direction. Let $g(u)$ be the distance between the two edge points at that station. Each side has its own tension, default $1$; a tension $\le 0$ is a refusal. $\lambda = \mathrm{tension}\cdot g(u)$, $\partial S/\partial v = \lambda D_s$, and for $G^2$ $\partial^2 S/\partial v^2 = \lambda^2 D_{ss}$ under the same constant-speed assumption. If $g(u)$ is under $10^{-4}$ mm the edges already meet inside the $G^0$ bound and the op refuses.
4. Apply the single-span identities of R2.3 step 7. Naming the ends $0$ and $1$: cubic poles $P_0$, $P_0 + T_0/3$, $P_1 - T_1/3$, $P_1$; quintic poles $P_0$, $P_0 + T_0/5$, $P_0 + 2T_0/5 + A_0/20$, $P_1 - 2T_1/5 + A_1/20$, $P_1 - T_1/5$, $P_1$.
5. The $U = 0$ and $U = 1$ sides of the blend are free edges of this face. Closing them is `Op::Sew`, not part of the blend. The same measure-and-insert loop as R2.3 step 11 refines $U$ until the asked bounds hold, and refuses instead of calling GeomPlate.

#### Why this replaced GeomPlate

PR #815 (`organic-surfaces/s5-patch`, base `feature/organic-surfaces`) filled $G^1$/$G^2$ with `BRepOffsetAPI_MakeFilling`. GeomPlate builds its own start plane only when every support normal lies in one half-space. A closed wall does not, so the plate stays flat and meets the wall at a right angle.

On head `a3648c23`, CI run [45077382808](https://github.com/cristy-the-one/lime-slice/actions/runs/45077382808), job **Rust tests**, the 8-iteration plate with GeomPlate's own start printed:

```
S5 case=3-side solid=true naked=0 brepCheck=accepted-by-promotion
S5 case=3-side sharedEdges=9 listed=9
S5 case=3-side edge=7 asked=g1 gapMm=2.84895 angleDeg=90 curvatureJump=0 matchMm=1.2500005359475312
```

The gap $2.84895$ mm is not under $10^{-4}$ mm, and $90°$ is not under $0.1°$. The PR body records $674$ s for that 3-sided case alone. The assert stopped the test, so the 5-sided and 6-sided plates were not printed. Sewing still promoted a solid (`naked=0`) because the flat cap closed the opening; that solid is not a $G^1$ fill.

A dome start, so the meridian would leave the opening vertically, was tried on head `c184c54b`, CI run [45080046182](https://github.com/cristy-the-one/lime-slice/actions/runs/45080046182). No $G^1$ or $G^2$ continuity line was printed. **Rust tests** and **OCCT dynamic link (macOS)** printed `The modeler hit an internal error on this step; the step was not applied.` for the 3-sided $G^1$ patch, and `Open CASCADE could not bridge these edges. Move them closer, or lower the tension.` for the blend. **OCCT dynamic link (Windows)** printed that same blend error, and for the patch `Open CASCADE could not fill this opening. Use G1 on a smoother boundary, or split the opening into fewer sides.`

The $G^0$ quad on that same Windows job, filled by GeomFill rather than GeomPlate, printed `gapMm=0.0000030611` on each of its four edges, with `solid=true naked=0 brepCheck=accepted-by-promotion`. That is the path R2.3 keeps. The G0 patch landed in #815. $G^1$ and $G^2$ wait on the construction above, and on the S5 acceptance bounds (gap under $10^{-4}$ mm, angle under $0.1°$, curvature jump not greater than $10^{-3}\,\text{mm}^{-1}$).

### R3 — Surface-to-Solid Workflow
- **R3.1 Open Sheet Ops**: `Op::Sew` (`BRepBuilderAPI_Sewing` + `ShapeFix_Solid`), `Op::Thicken` (`BRepOffsetAPI_MakeThickSolid` / directional or symmetric wall closure), `Op::TrimSplit` (`BRepAlgoAPI_Splitter` splitting a solid by an open surface), `Op::ReplaceFace`, and `Op::SplitFace` (imprinting/projecting a curve onto a face). A TrimSplit of a sheet keeps the cut piece of that sheet; an older `.lime` that splits a sheet rebuilds into that piece, and a split of a solid is unchanged.
- **R3.2 Print-Readiness Gate**: Distinct sheet visualization (backface tint + naked edges) and a one-click prompt to Thicken or Sew before slicing.

### R4 — Visual & Analytical Continuity Inspection
- **R4.1 Zero-Re-Mesh Viewport Analysis Modes**:
  - **Zebra Stripes** (anti-aliased reflection bands using exact analytic normals, configurable density & orientation).
  - **Curvature Heatmap** (Gaussian $K$, Mean $H$, Min/Max principal curvature, and **Min Radius of Curvature** warning where $|R_{\min}| < \text{wall thickness}$).
  - **Isoparametric UV Wireframe** (real `Geom_Surface::UIso` / `VIso` curves).
  - **2D / 3D Curvature Combs** (scaled curvature needles on splines and edges).
- **R4.2 Kernel & MCP Continuity Checks**: Exact shared-edge metrics via `BRepLProp_SLProps` ($G^0$ gap mm, $G^1$ normal angle °, $G^2$ curvature jump $\text{mm}^{-1}$) and per-face NURBS health (surface type, $U$/$V$ degree, pole/span counts, rational flag, min radius of curvature).

### R5 — Performance & Efficiency
- **R5.1 Analytic Vertex Normals from OCCT**: Stream exact `BRepLProp_SLProps` unit normals alongside vertex positions from C++, bypassing `smoothNormals()` in JS for all OCCT meshes.
- **R5.2 Dual-Quality Adaptive Tessellation**: Fast interactive preview chord/angle during live drags; tighter curved-face angular deflection (`~0.15 rad` vs current `0.5 rad`) for final/inspection display; keep planar faces minimal; extend `mesh_around_made` so local edits only re-mesh touched faces and their 1-ring neighbors.
- **R5.3 60 fps Client-Side NURBS Preview**: Live CV drags, tension sliders, and sweep/loft ghosts evaluate locally in `nurbs-eval.ts` at 60 fps and commit exact OCCT B-rep on release/debounce.
- **R5.4 Knot Hygiene**: Clamp max degree (default 5–7), provide optional tolerance-bounded refit (`GeomConvert_ApproxSurface`) and co-surface unification (`ShapeUpgrade_UnifySameDomain`) so downstream booleans, fillets, and shelling stay fast and stable.

---

## 6. Architecture Summary

### 6.1 Kernel Data Model (`crates/lime-model-occt/src/tree/ops.rs`)
- `ProfileSegment`: add `Nurbs { poles, weights?, degree?, knots?, mults?, to }` and optional `tangentStart`/`tangentEnd` on `Spline`.
- Shared `Curve3D` enum: `Line`, `Arc`, `Spline`, `Nurbs`, `EdgeChain`, `IsoCurve`, `Project`.
- New / extended `Op` variants: `Sweep`, `Loft` (v2), `Fillet` (v2), `NurbsSurface`, `Patch`, `BlendSurface`, `Sew`, `Thicken`, `TrimSplit`, `ReplaceFace`, `SplitFace`.
- `Held` metadata: `shape_kind: Solid | Sheet | Compound`, naked-edge list, per-face NURBS health summary, and extended `EdgeSig` distinguishing `bspline` / `bezier` / `offset`.

### 6.2 Fast Tessellation & Analysis Pipeline
```
OCCT TopoDS_Shape
  ├── Incremental face meshing (mesh_around_made)
  │     ├── Preview pass: coarse chord, angle = 0.35 rad
  │     └── Final pass:   fine chord,   angle = 0.15 rad (curved faces)
  ├── Exact UV vertex normals via BRepLProp_SLProps (streamed with positions)
  │     └── Lazy on-demand curvature buffers (Gaussian K, Mean H, R_min)
  └── Three.js BufferGeometry (no JS normal-weld pass on OCCT meshes)
        └── Instant GPU mode switch: Standard | Zebra | Curvature | Isoparms
```

---

## 7. Phased Milestone Roadmap

| Milestone | Scope | Key Files | Acceptance Criteria |
|---|---|---|---|
| **S1 — Inspection & Fast Normals** | Stream exact OCCT analytic normals; dual preview/final tessellation angle; Zebra & Curvature shaders; Isoparms overlay; `model_check` $G^0$/$G^1$/$G^2$ + surface health; `*-beta.*` prerelease rule in `release.yml`. | `kernel.cpp`, `src/model-view/mesh.ts`, `src/model-view/analysis-shaders.ts`, `mcp/`, `.github/workflows/release.yml` | 0 ms JS normal-weld on OCCT parts; Zebra visually separates $G^1$ vs $G^2$; `model_check` reports exact $G^0$/$G^1$/$G^2$ values. |
| **S2 — Exact NURBS Curves & Real `Sweep`** | `ProfileSegment::Nurbs`, `Curve3D`, `Op::Sweep` (`BRepOffsetAPI_MakePipeShell`); pure-TS exact rational Cox–de Boor `src/modeling/nurbs-eval.ts`; sketch CV handles & 2D curvature combs; MCP & `lime-recipe`. | `ops.rs`, `kernel.cpp`, `src/modeling/nurbs-eval.ts`, `src/sketch/model.ts`, `src/sketch/geom.ts`, `src/sketch/sweep.ts`, `crates/lime-recipe/` | 90° elbow sweep with round/right corners builds cleanly; TS evaluator matches OCCT within `< 1e-6 mm`; legacy `.lime` sweeps still load identically. |
| **S3 — Controlled `Loft` & Variable / $G^2$ `Fillet`** | Guide rails, start/end $G^1$/$G^2$ tangency, apex caps, periodic loft; variable-radius (`Law_Interpol`) & $G^2$ (`ChFi3d_QuasiAngular`/`Polynomial`) fillets; UI controls & MCP/recipes. | `ops.rs`, `kernel.cpp`, `src/sketch/loft.ts`, fillet panel, `mcp/`, `crates/lime-recipe/` | Variable $G^2$ fillet passes `model_check` ($G^1 < 0.1°$, bounded curvature jump) with continuous Zebra bands. |
| **S4 — Open Sheets & Surface-to-Solid** | `Sheet` node state + naked edges; `Op::Sew`, `Op::Thicken`, `Op::TrimSplit`, `Op::ReplaceFace`, `Op::SplitFace`; sheet viewport rendering & Print-gate prompt. | `ops.rs`, `kernel.cpp`, tree engine, `src/model-view/`, History UI, `mcp/` | Sculpted NURBS roof splits a solid cleanly and thickens into a watertight `BRepCheck_Analyzer`-valid solid with zero naked edges. |
| **S5 — Boundary / Gordon / $N$-Sided `Patch` & `BlendSurface`** | $G^0$ of 2–4 sides stays on `GeomFill_BSplineCurves` (`GeomFill_CoonsStyle`) / `GeomFill_ConstrainedFilling`. $G^1$/$G^2$, and any opening of 5 or more sides, is $N$ Hermite–Coons `Geom_BSplineSurface` pieces (R2.3). Each side is split at its arc-length midpoint; piece $i$ has corners $V_i$, $M_i$, $C$, $M_{i-1}$. Ribbons from `BRepLProp_SLProps` scaled by tension, shared cubics $M_i \to C$, averaged twists at $V_i$ and at $C$. Degree at least 3 for $G^1$ and at least 5 for $G^2$ in both directions. `BlendSurface` is unchanged (R2.4). GeomPlate is not called. Per-edge `G0`/`G1`/`G2` badges in the UI. | `ops.rs`, `kernel.cpp`, patch tool UI, `mcp/`, `crates/lime-recipe/` | 3-, 5-, and 6-sided openings, and a two-edge blend, at the asked continuity. Gap under $10^{-4}$ mm, angle under $0.1°$ where $G^1$ was asked, curvature jump not greater than $10^{-3}\,\text{mm}^{-1}$ where $G^2$ was asked (`kernel.cpp:9611`). The 3-sided opening has one sharp vertex, named in `continuity.sharpVertices` and excluded from the edge samples. Sewn into a `BRepCheck_Analyzer`-valid solid with zero naked edges. |
| **S6 — Direct `NurbsSurface` & 60 fps CV Sculpting** | `Op::NurbsSurface` (poles, weights, degrees, knots, refinement, symmetry); 60 fps interactive CV/isoparm drag + soft falloff + live Zebra; OCCT commit on release. | `ops.rs`, `kernel.cpp`, `src/modeling/nurbs-eval.ts`, surface sculpt gizmo, `mcp/`, `crates/lime-recipe/` | Dragging poles on an $8 \times 8$ bicubic surface runs $\ge 60\text{ fps}$ with live Zebra and commits to OCCT in `< 100 ms`. |
| **S7 (Deferred) — SubD Cage → Exact NURBS** | Catmull-Clark control cage converted to exact bicubic `Geom_BSplineSurface` patches feeding S4's `Op::Sew`. | New SubD module + S4/S6 hooks | Cage converts cleanly into a watertight NURBS B-rep solid with STEP export. |

---

## 8. Locked UX & Beta Decisions (from `/grill-me`)

All 8 UX and delivery decisions are resolved and binding for implementation across S1–S6:

- **U1 — Surface Inspection Placement (S1):** Zebra, Curvature, and Surface Grid (Isoparms) live inside Model's existing **Look** menu (`src/model-look.ts`) alongside Section & Colour by step: one clean **Shading** selector (`Normal` / `Colour by step` / `Zebra` / `Curvature`) plus an independent **Surface grid (Isoparms)** checkbox, keyboard shortcuts, and an optional auto-show mode while editing curves/surfaces.
- **U2 — Practical Curvature Default (S1):** Curvature view defaults to **Bend tightness (Radius in mm)** with a configurable red warning threshold (e.g. bends tighter than target wall thickness) to predict Shell/Thicken/Fillet self-intersection before running them. **Gaussian** and **Mean** curvature remain available as optional sub-modes.
- **U3 — 2D Exact NURBS Sketch Ergonomics (S2):** The Sketch curve tool offers both **Control-point NURBS** and **Through-point** modes via a toolbar toggle (defaulting to Control-point NURBS, both backed by exact Cox–de Boor math matching OCCT), with a simple **Curvature comb** toggle and per-point **Weight / Sharp crease / Insert knot** actions in a right-click menu or inspector pill when a point is selected.
- **U4 — 3D Paths & Guide Rails (S2–S3 → S6):** Start in S2–S3 with predictable derived 3D curves (existing solid edges, 2D-to-face projection, and **Combine two 2D sketches** side + top → exact 3D NURBS curve). Add direct 3D triad CV dragging alongside S6's 3D NURBS surface sculpting gizmo (reusing one unified 3D CV gizmo). *(MCP and `lime-recipe` accept arbitrary 3D `Curve3D` NURBS directly from S2 onward.)*
- **U5 — Fillet Smoothness & Variable Radius (S3):** **Fillet** defaults to **Circular ($G^1$)** for mechanical predictability, adds a **Profile** selector (`Circular G1` / `Smooth G2` / `Conic`), and adds a **Variable radius** toggle that places draggable start/end/middle radius dots directly on the picked edge.
- **U6 — Open Sheets Visual Identity & Print Handoff (S4):** Open sheets show a subtle inside-face tint, bright open-border (naked-edge) highlights, and a `Sheet` badge in History. Sewing all open borders shut **auto-promotes** the node to a watertight Solid. Sending an open Sheet toward Print/Prepare shows a friendly one-click prompt offering **Thicken wall (mm)** or **Cap / Sew to solid**.
- **U7 — Patch & 3D NURBS Sculpting Balance (S5–S6):** Guided defaults up front with full exact NURBS one click away: **Patch** auto-selects `Smooth (G1)` on edges touching existing faces and shows clickable `G0` / `G1` / `G2` badges directly on each edge; **NURBS Sculpt** opens with clean normal/axis drag + **Symmetry mirror** + **Soft-falloff radius**, and exposes **Weights / Degree / Knot insertion & creases** in an expandable **Exact NURBS** drawer.
- **U8 — Beta Release Cadence on `feature/organic-surfaces`:** Cut **3 milestone-paired GitHub Pre-releases** (`v*-beta.*` via `.github/workflows/release.yml` updated to match `*-beta.*`):
  1. **`beta.1` after S1 + S2:** Fast analytic OCCT normals, Zebra/Curvature/Isoparms, exact 2D/3D NURBS curves, and real kernel `Sweep`.
  2. **`beta.2` after S3 + S4:** Guided/$G^2$ Lofts, Variable-radius & $G^2$ Fillets, Open Sheets, and Sew/Thicken/TrimSplit/ReplaceFace/SplitFace.
  3. **`beta.3` after S5 + S6:** Coons/Gordon/$N$-sided `Patch`, `BlendSurface`, and Direct `NurbsSurface` + 60 fps CV sculpting — ready for final review & merge to `main`.
