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
- **R2.3 Boundary / Gordon / $N$-Sided Patch (`Op::Patch`)**: A clean 2–4 curve $G^0$ boundary, with no interior guides, still goes to `GeomFill_BSplineCurves` / `GeomFill_ConstrainedFilling`. There is no `GeomFill_Coons` class: the G0 four-curve fill uses `GeomFill_BSplineCurves` with `GeomFill_CoonsStyle`. An opening that asks for $G^1$ or $G^2$ on any side, and any opening of 5 or more sides, is $N$ four-sided Hermite–Coons pieces around one centre point, each stored as a `Geom_BSplineSurface`. That is the Gordon construction for one cell (the Boolean sum of the two directional Hermite blends, minus the corner correction). `BRepOffsetAPI_MakeFilling` and `GeomPlate_BuildPlateSurface` are not on this path.
- **R2.4 Variable-Radius & $G^2$ Fillets + Surface Blends (`Op::Fillet` v2, `Op::BlendSurface`)**: Fillets stay as they are: `continuity: "g1" | "g2"` (`ChFi3d_Rational` vs. `ChFi3d_QuasiAngular` / `ChFi3d_Polynomial` + `GeomAbs_G2` / conic $\rho$), variable-radius stations along edges via `Law_Interpol`. `BlendSurface` is a separate Hermite `Geom_BSplineSurface` across two open edges or edge chains: degree 3 across the gap for $G^1$, degree 5 for $G^2$. The cross-edge derivatives come from the adjacent faces at the edge, through `BRepLProp_SLProps`, scaled by the tension. No `GeomPlate`.
- **S5 acceptance (R2.3 and R2.4, bounds unchanged)**: Every patch or blend edge that was asked to meet a neighbour shows a $G^0$ gap under $10^{-4}$ mm. Where $G^1$ was asked, the normal angle is under $0.1°$. Where $G^2$ was asked, the curvature jump is under $0.05\,\text{mm}^{-1}$. That $0.05$ is half of Open CASCADE's default `TolCurv` ($0.1$), the same as mistaking a flat for a $20$ mm radius; it was justified on PR #815 and is not loosened. The S3 analytic $G^2$ fillet keeps its jump within $10^{-3}\,\text{mm}^{-1}$, the same threshold `model_check` already uses to call an edge G2. `model_check` lists every shared edge in `continuity.edges`, including a clean G2 edge. The cases are the same three openings, 3, 5, and 6 sides, plus the two-edge blend, each at the continuity that was asked, sewn to a `BRepCheck_Analyzer`-valid solid with zero naked edges.

#### R2.3 construction — $N$ Hermite–Coons pieces

Build one `Geom_BSplineSurface` per boundary side, then sew the pieces to each other and to the opening with the existing `Op::Sew`. Do not call `GeomPlate`.

1. **Loop.** Convert each side with `GeomConvert::CurveToBSplineCurve`. A side that is an edge chain is concatenated first (`GeomConvert_CompCurve`, then `CurveToBSplineCurve`). Order the curves into one closed loop and reverse a curve when its end is farther from the previous curve's end than its start is. Consecutive ends that do not meet are a refusal, the same refusal the G0 fill already uses.
2. **Centre point.** Sample each of the $N$ curves at 16 equal arc-length stations (`GCPnts_AbscissaPoint`; if the length query fails, 16 equal parameter steps). The centre $C$ is the arithmetic mean of those samples, so each side has equal weight.
3. **Centre plane.** Let $N_c$ be the normalized sum of the support-face unit normals at each edge midpoint. Take each normal from `BRepLProp_SLProps::Normal()` and reverse it when the face is `TopAbs_REVERSED`, which is the orientation `model_check` already uses. A side with no support face contributes nothing. If that sum is shorter than $10^{-9}$, $N_c$ is Newell's normal of the sample polyline.
4. **Shared splitting curves, one per corner.** Corner $V_i$ is the shared vertex of two consecutive sides. The curve from $V_i$ to $C$ is a cubic Bézier, degree 3, knots $\{0,0,0,0,1,1,1,1\}$, weights 1, and both pieces that meet at $V_i$ store that same curve.
   - Let $T_a$ and $T_b$ be the tension-scaled transverse derivatives (step 6) of the two edges at $V_i$. The shared tangent at the corner is $T_s = \mathrm{normalize}(T_a + T_b)\,|C - V_i|$. If $|T_a + T_b| < 10^{-9}$, project $(C - V_i)$ onto the corner plane (normal = the average of the two face normals) and give it length $|C - V_i|$.
   - The arrival tangent at $C$ is $(C - V_i)$ projected onto the centre plane, length $|C - V_i|$. If that projection is shorter than $10^{-9}$, use $(C - V_i)$ unprojected, same length.
   - Poles: $Q_0 = V_i$, $Q_1 = V_i + T_s/3$, $Q_2 = C - T_c/3$, $Q_3 = C$.
5. **Parameter of one piece.** $u = 0$ on the outer edge, $u = 1$ at $C$. $v = 0$ on the split of the start corner, $v = 1$ on the split of the end corner. $V$ degree, knots, and multiplicities are the outer edge's, after `IncreaseDegree` to at least 3. $U$ is clamped:
   - $G^1$, and no guide point: degree 3, one span, flat knots $\{0,0,0,0,1,1,1,1\}$ (4 poles).
   - $G^2$, and no guide point: degree 5, one span, flat knots $\{0,0,0,0,0,0,1,1,1,1,1,1\}$ (6 poles).
   - A guide point inserts one $U$ knot at $0.5$ (multiplicity 1). End multiplicity stays $p+1$. The first derivative at an end still depends only on the boundary row and the next row; the second derivative also uses the row after that. The new middle row is the free one.
6. **Outer ribbon, from the face, scaled by tension.** At each $V$ Greville abscissa, evaluate the support with the same property object the continuity check uses: `BRepLProp_SLProps(BRepAdaptor_Surface, 2, 1e-9)`, parameters from `BRep_Tool::CurveOnSurface`. Read `D1U`, `D1V`, and for $G^2$ also `D2U`, `D2V`, `DUV`. Edge tangent $T_e$ comes from `BRepAdaptor_Curve::D1`, normalized. Face normal $N$ is `Normal()`, reversed when the face is `TopAbs_REVERSED`. The in-face unit transverse is $B = N \times T_e$. Step from the edge along $B$ and classify with `BRepClass_FaceClassifier`; if the step is `TopAbs_IN`, flip $B$, so $B$ points out of the face and into the opening. With $S_u = \mathtt{D1U}$, $S_v = \mathtt{D1V}$, $E = S_u\cdot S_u$, $F = S_u\cdot S_v$, $G = S_v\cdot S_v$, and $\Delta = EG - F^2$: if $\Delta < 10^{-18}$ the face is singular here and the op refuses. Otherwise
   $a = (G\,(S_u\cdot B) - F\,(S_v\cdot B)) / \Delta$, $b = (E\,(S_v\cdot B) - F\,(S_u\cdot B)) / \Delta$,
   $D_s = a S_u + b S_v$, and $D_{ss} = a^2\,\mathtt{D2U} + 2ab\,\mathtt{DUV} + b^2\,\mathtt{D2V}$.
   Let $g$ be the distance from this edge point to $C$, and let $\lambda = \mathrm{tension}\cdot g$ with the per-edge tension defaulting to $1$. A tension $\le 0$ is a refusal. The prescribed derivatives are $\partial S/\partial u = \lambda D_s$ and, for $G^2$, $\partial^2 S/\partial u^2 = \lambda^2 D_{ss}$. The second derivative uses a parameter speed that is locally constant ($\mathrm{d}^2 s/\mathrm{d}u^2 = 0$ at the boundary). A $G^0$ side has no face ribbon: $\partial S/\partial u = C - P$ and the second derivative is $0$.
7. **Poles from the single-span identities.** With no guide knot the $U$ span has parameter length $1$, so a degree-$p$ end has $\partial S/\partial u = p(P_1 - P_0)$ and $\partial^2 S/\partial u^2 = p(p-1)(P_2 - 2 P_1 + P_0)$. The $G^1$ rows are $P$, $P + T/3$, $C - T_c(v)/3$, $C$. The $G^2$ rows are $P$, $P + T/5$, $P + 2T/5 + A/20$, then the centre-side pair $C - 2T_c(v)/5 + A_c(v)/20$, $C - T_c(v)/5$, then $C$. $T_c(v)$ is the linear blend $(1-t) T_c^{\mathrm{start}} + t\,T_c^{\mathrm{end}}$ of the two splits' arrival tangents, $t\in[0,1]$ along the outer edge, and both tangents already lie in the centre plane. $A_c(v)$ is the same blend of the two cubics' $S''(1) = 6(Q_3 - 2 Q_2 + Q_1)$. These offsets are only for that one span. After the guide knot at $0.5$ is inserted, recover $P_1$ and $P_2$ from the B-spline derivative recurrence $Q_i = p/(u_{i+p+1} - u_{i+1})\,(P_{i+1} - P_i)$, applied once for the first derivative and again, at degree $p-1$, for the second. Interior $V$ columns use these rows. The first and last $V$ columns are not rebuilt from this formula: they are the shared cubic, raised with `IncreaseDegree` to the piece's $U$ degree, so both pieces store the same split. The whole $u = 1$ row is the point $C$. That row has no $v$ extent, so every $\partial^k S/\partial v^k$ on it is $0$.
8. **Ribbon across a split, one shared field.** The split column is shared, so $\partial S/\partial u$ matches. Both pieces also store one transverse $\partial S/\partial v = W(u)$, so the tangent planes match along the split. $v$ increases from the previous split toward the next, and $u$ increases the same way on both pieces, so both pieces' positive $\partial S/\partial v$ point from piece $i-1$ into piece $i$. They store $W$, not $-W$.
   - $W(1) = 0$. The centre row is the single point $C$, so a nonzero $\partial S/\partial v$ there cannot be represented.
   - $W(0) = W_0$ lies in the corner plane, perpendicular to $T_s$, length $|T_s|$, pointing from piece $i-1$ into piece $i$.
   - The limiting normal at $C$ is fixed by the twist, not by $W(1)$. Set $W'(1) = W'_c = (N_c \times T_c)\, \alpha$, where $\alpha$ is the angle at $C$ from this split to the next split in loop order, and the sign of $N_c \times T_c$ points into piece $i$. $T_c$ lies in the centre plane, so $T_c \times W'_c$ is parallel to $N_c$.
   - With $W'(0) = 0$ and those ends, $W(u) = (2u^3 - 3u^2 + 1)\, W_0 + (u^3 - u^2)\, W'_c$, so $W'(1) = W'_c$.
   - For $G^2$, the shared second derivative across the split is $W_2(u) = (1-u)\, W_{2,0}$. $W_{2,0}$ is the average of the two faces' $\lambda^2 D_{ss}$ at the corner, projected perpendicular to $T_s$. A $G^0$ side contributes nothing to that average. $W_2(1) = 0$, because the centre row is a point.
   Write $W$ into the $V$ column next to the split, and $W_2$ into the column after that, sampling $W(u)$ at that row's $u$ and applying the same end identity. Do not move the outer $U$ row (that row is the edge) and do not move the split column or the centre row.
9. **Twist at the corners, the compatibility fix.** The pole one row in from the outer edge and one column in from the split is claimed by both ribbons. A single polynomial cannot honour both unless the mixed partials agree, so that pole stores the average. For degree 3, $\tau = \partial^2 S/\partial u\partial v$ and $G_{11} = G_{00} + T_u/3 + T_v/3 + \tau/9$, with $\tau = \tfrac{1}{2}(\mathrm{d}T_u/\mathrm{d}v + \mathrm{d}W/\mathrm{d}u)$ at that corner. $\mathrm{d}T_u/\mathrm{d}v$ is the derivative of the outer ribbon along the edge, and $\mathrm{d}W/\mathrm{d}u$ is the derivative of the cubic $W$ above. For degree 5 the same average fixes $\partial^2 S/\partial u\partial v = 25(G_{11} - G_{10} - G_{01} + G_{00})$. The pure second-derivative poles ($G_{20}$ from $A_{uu}$, $G_{02}$ from $W_2$) stay on their own ribbons. Any higher mixed pole that both ribbons claim uses the same average; a pole that only one ribbon claims stays on that ribbon. At the centre end of the split the two candidates are $\partial T_c/\partial v = T_c^{\mathrm{next}} - T_c^{\mathrm{this}}$ from the linear centre field, and $W'_c$ from the split ribbon. Those two are not the same vector. The mixed pole stores their average, and both pieces compute that same average from the same $T_c$ and the same $W$. Coplanar arrival tangents plus this shared twist are what make one tangent plane at $C$; the normal exactly at $C$ is undefined because both $v$-partials vanish there.
10. **Guide points, and only guide points, may move a free pole.** GeomPlate is not called, including as a fallback. With no guide point the middle knot is absent and there is no free row. With a guide point, the free middle $U$ row starts at the value of the single-span Hermite at $u = 0.5$, then moves, along $N_c$ only, on $V$ columns that are not a split column and not a ribbon column. If the point is already within $10^{-4}$ mm of the piece, leave the poles. If a moved pole would land farther from $C$ than twice the longest centre-to-sample distance, the op refuses. The boundary row, the ribbon rows, and the split columns stay where steps 7–9 put them.
11. **Check, then insert knots, then refuse.** Wrap each surface with `BRepBuilderAPI_MakeFace`. Measure every asked edge with the same `BRepLProp_SLProps` station loop `model_check` uses. A polynomial outer edge (every weight $1$) meets the outer row exactly, because that row is the curve's poles. A rational outer edge (an arc) keeps the curve weights on that row and weight $1$ on every interior row; the angle is then what the check measures. When a bound is missed, insert one $V$ knot at the middle of each failing span and rebuild. Stop when the bounds hold, or when a failing span is shorter than $10^{-3}$ of that edge's length: then refuse. Do not hand the opening to GeomPlate.

#### R2.4 construction — Hermite `BlendSurface`

One surface, two edges, no centre and no splits.

1. Convert each edge or chain the same way as a patch side. Pair endpoints by nearest point and reverse the second curve when the pairing crosses. Translate and scale both knot vectors so both domains are $[0,1]$. `IncreaseDegree` to $\max(d_0, d_1, 3)$, then `InsertKnots` until both curves share one knot vector and one multiplicity vector (the union, multiplicity the max). $U$ on the surface is that common vector, so each input edge is a $V$ row. The $V = 0$ row and the $V = 1$ row are the two curves' poles, and the gap along those edges is exact for polynomial curves.
2. $V$ runs from the first edge to the second, one clamped span. $G^1$: degree 3, flat knots $\{0,0,0,0,1,1,1,1\}$. $G^2$: degree 5, flat knots six $0$s and six $1$s. Weights on the two boundary rows are the curve weights; every interior weight is $1$.
3. At each $U$ Greville station, take $D_s$ and $D_{ss}$ from each face by the same `BRepLProp_SLProps` procedure as R2.3, with $B$ pointing into the gap (the classifier flip above). Let $g(u)$ be the distance between the two edge points at that station. Each side has its own tension, default $1$; a tension $\le 0$ is a refusal. $\lambda = \mathrm{tension}\cdot g(u)$, $\partial S/\partial v = \lambda D_s$, and for $G^2$ $\partial^2 S/\partial v^2 = \lambda^2 D_{ss}$ under the same constant-speed assumption. If $g(u)$ is under $10^{-4}$ mm the edges already meet inside the $G^0$ bound and the op refuses.
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

The $G^0$ quad on that same Windows job, filled by GeomFill rather than GeomPlate, printed `gapMm=0.0000030611` on each of its four edges, with `solid=true naked=0 brepCheck=accepted-by-promotion`. That is the path R2.3 keeps. #815 is being narrowed to $G^0$ on its own branch; this plan does not change that branch. $G^1$ and $G^2$ wait on the construction above, and on these same bounds.

### R3 — Surface-to-Solid Workflow
- **R3.1 Open Sheet Ops**: `Op::Sew` (`BRepBuilderAPI_Sewing` + `ShapeFix_Solid`), `Op::Thicken` (`BRepOffsetAPI_MakeThickSolid` / directional or symmetric wall closure), `Op::TrimSplit` (`BRepAlgoAPI_Splitter` splitting a solid by an open surface), `Op::ReplaceFace`, and `Op::SplitFace` (imprinting/projecting a curve onto a face).
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
| **S5 — Boundary / Gordon / $N$-Sided `Patch` & `BlendSurface`** | $G^0$ of 2–4 sides stays on `GeomFill_BSplineCurves` (`GeomFill_CoonsStyle`) / `GeomFill_ConstrainedFilling`. $G^1$/$G^2$, and any opening of 5 or more sides, is $N$ Hermite–Coons `Geom_BSplineSurface` pieces around one centre (R2.3): cubic across the span for $G^1$, quintic for $G^2$, ribbons from `BRepLProp_SLProps` scaled by tension, shared cubic splits, averaged twist at the corners. `BlendSurface` is the same Hermite surface across two edges (R2.4). GeomPlate is not called. Per-edge `G0`/`G1`/`G2` badges in the UI. | `ops.rs`, `kernel.cpp`, patch tool UI, `mcp/`, `crates/lime-recipe/` | 3-, 5-, and 6-sided openings, and a two-edge blend, at the asked continuity. Gap under $10^{-4}$ mm, angle under $0.1°$ where $G^1$ was asked, curvature jump under $0.05\,\text{mm}^{-1}$ where $G^2$ was asked. Sewn into a `BRepCheck_Analyzer`-valid solid with zero naked edges. |
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
