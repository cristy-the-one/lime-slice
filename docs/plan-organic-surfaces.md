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
- **Zero new native dependencies:** All 14 required OCCT 7.9.2 headers (`Geom_BSplineCurve`, `Geom_BSplineSurface`, `GeomFill_BSplineCurves`, `GeomFill_ConstrainedFilling`, `BRepOffsetAPI_MakeFilling`, `GeomPlate_BuildPlateSurface`, `BRepOffsetAPI_MakePipeShell`, `ChFi3d_FilletShape`, `Law_Interpol`, `GeomConvert`, `ShapeUpgrade_ShapeDivideContinuity`, `ShapeFix_Shape`) are already installed and linked via `crates/lime-model-occt/build.rs`.

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
- **R2.3 Boundary / Gordon / $N$-Sided Patch (`Op::Patch`)**: Auto-dispatches clean 2–4 curve $G^0$ boundaries to `GeomFill_BSplineCurves` / `GeomFill_ConstrainedFilling`, and $N$-sided or $G^1$/$G^2$-constrained openings (plus optional interior guide points/curves) to `BRepOffsetAPI_MakeFilling` (`GeomPlate_BuildPlateSurface`).
- **R2.4 Variable-Radius & $G^2$ Fillets + Surface Blends (`Op::Fillet` v2, `Op::BlendSurface`)**: `continuity: "g1" | "g2"` (`ChFi3d_Rational` vs. `ChFi3d_QuasiAngular` / `ChFi3d_Polynomial` + `GeomAbs_G2` / conic $\rho$), variable-radius stations along edges via `Law_Interpol`, and `BlendSurface` bridging two open edges/chains with $G^1$/$G^2$ tension control.

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
| **S5 — Boundary / Gordon / $N$-Sided `Patch` & `BlendSurface`** | `GeomFill_BSplineCurves` (clean 2–4 side) + `BRepOffsetAPI_MakeFilling` ($N$-sided & $G^1$/$G^2$ constrained + interior guides); `Op::BlendSurface`; clickable per-edge `G0`/`G1`/`G2` badges in UI. | `ops.rs`, `kernel.cpp`, patch tool UI, `mcp/`, `crates/lime-recipe/` | 3-, 5-, and 6-sided organic openings fill with verified $G^1$/$G^2$ continuity and sew into a watertight solid. |
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
