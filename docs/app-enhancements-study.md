# Lime Slice — Application & Engine Enhancements Study

## 1. Executive Summary & Architectural Baseline

`lime-slice` is a desktop-first FDM slicer built on a Rust core (`crates/lime-slice-core`), an OpenCascade 7.9.2 C++ B-rep modeling bridge (`crates/lime-model-occt`, `crates/lime-model-load`), a Tauri 2 native shell (`src-tauri`), and a zero-framework TypeScript + Three.js frontend (`src/`).

Unlike legacy slicers inherited from Slic3r or CuraEngine, `lime-slice` already holds four structural advantages:

1. **Strategy Pareto blending (`crates/lime-slice-core/src/pareto.rs`, `src/slice.rs:289–349`)**: Users blend `Speed`, `Efficiency`, and `Toughness` weights globally, by Z-layer range (`LayerRule`), or by 3D modifier volume (`ModifierBox`), with parallel 3-corner reference slicing (`slice_pareto_fronts`) that reports real time/grams/strength deltas.
2. **Part-frame slicing cache & `< 150 ms` fast-path updates (`crates/lime-slice-core/src/slice/cache.rs`, `src/slice.rs:888–956`)**: Mesh contours and support trees are computed in the object's local frame (`ZIndex`, `SupportField`), so pure XY translations or post-slice tree branch prune/regrow operations patch only affected layers via `PreviewPatch` (`src/preview-geom.ts:183–249`).
3. **First-class belt printer support (`crates/lime-slice-core/src/belt.rs`, `src/support/tree.rs:212–280`)**: Native $45^\circ$ / arbitrary-angle belt slicing, belt-bed organic tree supports grown toward the tilted floor $z = y \tan\theta$, belt leading-edge rafts, and belt seam anchoring.
4. **Integrated B-rep Model mode (`crates/lime-model-occt`, `src/app/model.ts`, `src/model-view.ts`)**: Direct STEP/B-rep solids editing (boolean union/subtract/intersect, fillet, chamfer, split plane, counterbored/countersunk holes, shells, linear/circular patterns) inside the slicer without round-tripping to external CAD.

### Scope & Non-Duplication Policy

Per project direction, this study **does not duplicate** work already in progress or recently landed:

- **Infill Reinforcement (`docs/reinforcement.md`, PR #257)**: Surface-painted reinforcement patches (`ReinforcePatch` with `depthMm` and `fillThrough` inward-normal cylinders) and box/cylinder reinforcement volumes (`ModifierShape`: `box` | `cylinder`) that raise sparse infill density up to 100% inside `crates/lime-slice-core/src/slice.rs` and `src/toolpath.rs` are already implemented and excluded from these proposals.
- **Model Mode Usability Baseline (PR #255)**: The foundational Model mode visual polish—hover/pick highlights, selection count chip, floating tool bar, label scrubbing on `#modelPanel` numeric inputs (`src/app/model.ts:668`), keyboard shortcuts (`Q`, `W`, `G`, `P`, `L`, `Shift+L`, `H`, `X`, `Enter`, `Esc`), and local Three.js preview ghosts (`src/model-view.ts:257–304`)—is treated as the baseline. Proposals touching Model mode below focus strictly on remaining architectural gaps (bidirectional 3D ghost drag handles, pre-Apply B-rep feasibility checks, multi-edge fillet/chamfer C++ FFI, unified undo/redo, and shared Prepare viewport furniture).

### Engineering & Licensing Guardrails Applied to All Proposals

Every proposal in this study adheres to two non-negotiable project constraints:

1. **Golden A/B Byte-Identical G-Code Lock (`tools/golden_ab.sh`, `crates/lime-slice-core/tests/cartesian_lock.rs`)**:
   - All new slicing or G-code engine features must default to **off** (or match existing constants when unset) and use `#[serde(default, skip_serializing_if = ...)]` on `SliceRequest` / `MachineConfig` so existing `.lime` projects and golden fixtures serialize identically and emit **byte-for-byte identical G-code** under `tools/golden_ab.sh`.
2. **Strict Licensing Hygiene (MIT Repo; No GPL)**:
   - `lime-slice` is MIT-licensed (`Cargo.toml:9`). **No GPL or AGPL code** (e.g., PrusaSlicer/OrcaSlicer/Bambu Studio LGPLv3/GPLv3 C++ sources or CuraEngine AGPLv3 sources) may be copied or statically linked.
   - **LGPLv2.1** libraries are permissible **only via dynamic linking** (`SONAME` / `.so` / `.dylib` / `.dll` loaded at runtime with full compliance notices, following the pattern established for OpenCascade 7.9.2 in `crates/lime-model-occt/build.rs` and `third_party/occt/NOTICE.md`).
   - Prefer clean-room Rust/TypeScript implementations or permissive **MIT / Apache-2.0 / BSD / MPL-2.0** crates.

---

## 2. UX & Workflow Friction Proposals

Design principles under evaluation:
- **Desktop-first layout** keeping the central 3D viewport $\ge 70\%$ of window width (`e2e/viewport-width.spec.ts`).
- **Slim, precise controls** without visual clutter.
- **Consistent visual language** across Prepare, Preview, and Model modes.
- **Every tool both numeric and mouse-draggable in sync** (scrubbable labels, exact numeric fields, and 3D viewport gizmos/handles updating one another live).
- **Feasibility shown before Apply** (pre-flight geometry/collision checks before committing an operation or running a full slice).
- **Plain-language warnings** (no raw C++/OCCT class names or silent geometry drops).

---

### UX-1: Bidirectional 3D Viewport Gizmos + Scrubbable Numeric Inputs Across All Tools

- **Problem & Code Evidence**:
  Several tools violate the rule that every spatial parameter must be both numerically editable (with scrubbable labels) and mouse-draggable in the 3D viewport in real time:
  1. **Prepare Rotation (`src/app/markup.ts:127–146`, `src/prepare-view.ts:46–49, 820–833`)**: `#placeBar` provides numeric inputs for `Scale %`, `X mm`, `Y mm`, and `Z mm`, and the 3D gizmo rings allow continuous mouse rotation with $15^\circ$ snap (`ROTATE_SNAP_DEG = 15`), but `#placeBar` only has discrete `+90°` step buttons (`#rotX`, `#rotY`, `#rotZ`)—there are no numeric `Rx°`, `Ry°`, `Rz°` inputs to type e.g. `22.5°` or scrub-drag an angle in sync with the 3D rotation rings.
  2. **Support Paint, Seam Paint & Reinforce Paint Brush Radius (`src/ui/support-paint-ui.ts:26–49`, `src/ui/seam-paint-ui.ts:17–34`, `src/ui/reinforce-paint-ui.ts:24–54`, `src/prepare-view.ts:1020–1040`)**: The brush radius controls (`#paintRadius`, `#seamPaintRadius`, `#reinforceRadius`) are `<input type="range">` sliders with static `<span>` readouts (`8 mm`) rather than `<input type="number">` fields bound by `bindScrubLabels` (`src/ui/scrub.ts:17`), and the user cannot `Shift + Scroll` or drag on the 3D brush sphere in the viewport to resize the brush radius while painting.
  3. **Preview Section Plane (`src/section-plane.ts:5–10`, `src/view3d.ts:218–221`, `src/app/viewer.ts:29–55`, `src/app/markup.ts:169–173`)**: The cross-section plane has a 3D drag gizmo (`sectionRig`) and a read-only `#sectionHud` text badge, but no numeric input for section offset (`mm`) or normal angles (`°`) in `#sectionBar`.
  4. **Dynamic Sub-Panels Missing `bindScrubLabels` (`src/ui/overrides-panel.ts:22–56, 81–161`)**: `bindScrubLabels` is called once at startup on `#settingsPanel` (`src/app/settings.ts:448`), `#placeBar` (`src/app/place-scrub.ts:28`), and `#modelPanel` (`src/app/model.ts:668`), but when `#objectOverrides` or `#modifiers` re-render their DOM via `innerHTML` in `renderOverridesPanel()` and `renderModifiersPanel()`, their newly created `<label><input type="number"></label>` elements lose scrub-drag behavior.
  5. **Model Mode 3D Ghost Manipulation (`src/model-view.ts:236–248, 257–304`, `src/app/model.ts:176–262`)**: While `#modelPanel` has scrubbable numeric inputs and face/edge click seeding (`seedFromPick`), the 3D preview ghost (`ghostGroup`) disables raycasting (`edges.raycast = () => undefined`) and has no 3D drag handles in the viewport to drag split-plane offset/tilt, hole depth/diameter, boolean primitive dimensions/translation, or fillet/chamfer radius directly on the part.
- **Proposed Change**:
  - Replace static radius readouts in `#supportPaintBar`, `#seamPaintBar`, and `#reinforcePaintBar` with compact `<input type="number" step="0.5">` inputs wrapped in `<label>` with `bindScrubLabels`, and add `Alt/Shift + Wheel` (or `[` / `]` hotkeys + drag-ring) in `src/prepare-view.ts` to resize the 3D brush sphere in sync.
  - Add compact `Rx°`, `Ry°`, `Rz°` numeric inputs to `#placeBar` (`src/app/markup.ts`, `src/app/place.ts`) synced bidirectionally with the 3D rotation gizmo rings in `src/prepare-view.ts`.
  - Add a scrubbable numeric `Offset mm` and axis selector (`X` / `Y` / `Z` / `Custom`) to `#sectionBar` (`src/app/markup.ts:169–173`) synced with `sectionRig` in `src/view3d.ts`.
  - Call `bindScrubLabels(host)` at the end of `renderOverridesPanel()` and `renderModifiersPanel()` in `src/ui/overrides-panel.ts`.
  - Add lightweight 3D gizmo handles to `ghostGroup` in `src/model-view.ts` (normal arrow for split plane offset, radius/depth arrows for hole and fillet/chamfer, and translate/scale handles for boolean primitives) that write back to the `#modelPanel` inputs via an `onGhostDrag` callback.
- **User Benefit**:
  Complete tactile consistency: every spatial control in the app can be typed to $0.01\text{ mm}$ / $0.1^\circ$, scrubbed on its label, or dragged directly in the 3D viewport with zero mode-switching friction.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** to slicing engine (`crates/lime-slice-core` untouched). UI-only changes; covered by existing Playwright tests (`e2e/place-scrub.spec.ts`, `e2e/modifiers.spec.ts`, `e2e/model-mode.spec.ts`).
- **License Notes**: Pure TypeScript/Three.js (MIT).

---

### UX-2: Viewport $\ge 70\%$ Guarantee When Results & Left Sub-Panels Open

- **Problem & Code Evidence**:
  - `src/ui/splitters.ts:8–11, 29` sets `LEFT_MAX = 480` and `RIGHT_MAX = 560` and collapses `#right` on startup when `window.innerWidth > 1200` so `#prepare` satisfies `e2e/viewport-width.spec.ts:29–56` ($\ge 70\%$ of window width).
  - However, after the first slice completes, `openResultsAfterSlice()` (`src/ui/splitters.ts:95–103`) expands `#right` (`340px` default, up to `560px`) while `#left` (`300px` default, up to `480px`) remains open. On common $1280\text{ px}$–$1440\text{ px}$ laptop displays, $300 + 340 + 12 = 652\text{ px}$ consumes $45\%$–$51\%$ of horizontal width, shrinking the central 3D viewport to $49\%$–$55\%$—violating the $\ge 70\%$ viewport budget during the core Prepare $\leftrightarrow$ Preview iteration loop.
  - Furthermore, in `src/ui/splitters.ts:47–73`, dragging `#leftSplit` or `#rightSplit` only clamps each panel individually (`LEFT_MAX`, `RIGHT_MAX`) without enforcing a combined maximum (`window.innerWidth * 0.30`).
- **Proposed Change**:
  - Enforce a combined panel width budget in `src/ui/splitters.ts`: clamp `leftW + rightW <= Math.floor(window.innerWidth * 0.30)` on desktop layouts (`> 1200px`), dynamically slimming or docking `#right` into a compact floating HUD Drawer when `#left` is expanded past its slim width.
  - Convert the right-hand slice summary (`#summaryCard`, `#layerCard`, `#paretoCard` in `src/app/markup.ts:310–353`) into a slim $240\text{ px}$ docked rail (or collapsible floating HUD overlay in Preview mode) so both panels can stay visible on a $1440\text{ px}$ display while keeping `#center` $\ge 70\%$.
  - Extend `e2e/viewport-width.spec.ts` to assert `#prepare` and `#viewer` maintain $\ge 70\%$ width **after** slicing (`openResultsAfterSlice()`) as well as on initial load.
- **User Benefit**:
  The 3D print bed and toolpath preview never get squeezed into a narrow strip after slicing on $1280\text{ px}$–$1600\text{ px}$ screens.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **None** to slicing engine. Low UI layout risk; directly verified by `e2e/viewport-width.spec.ts`.
- **License Notes**: Pure TypeScript/CSS (MIT).

---

### UX-3: Unified Visual Language Between Prepare and Model Mode

- **Problem & Code Evidence**:
  - `createPrepareView` (`src/prepare-view.ts:99–183, 386–403`) establishes `lime-slice`'s signature visual language: studio 3-point lighting (`HemisphereLight` + warm key + cool rim with `MeshStandardMaterial`), dark-olive crease outlines (`edges-worker.ts`), bed reference grid (`syncBedGrid`), build-volume wireframe cage, bottom-left axis triad (`buildTriad`), interactive corner `ViewHelper` cube (`three/examples/jsm/helpers/ViewHelper.js`), and live `mountMeasureOverlay` (`src/measure-overlay.ts`) XYZ dimension callouts.
  - By contrast, `createModelView` (`src/model-view.ts:45–95, 458–465`) uses a bare scene with no bed grid or build-volume reference, no `ViewHelper` orientation cube, no `mountMeasureOverlay` bounding-box dimension callouts, and `MeshLambertMaterial` (`0xd6d3d1`). When switching from Prepare to Model mode (`src/app/model.ts:316`), the user loses spatial reference to the printer's bed plane ($Z = 0$), build volume limits, and part outer dimensions.
- **Proposed Change**:
  - Share the studio lighting rig, faint $Z=0$ bed grid reference plane, corner `ViewHelper` orientation gizmo, and toggleable `mountMeasureOverlay` dimension callouts between `src/prepare-view.ts` and `src/model-view.ts` via a small shared `src/viewport-chrome.ts` helper (converting coordinates between Prepare's Y-up Three.js frame and Model mode's Z-up OCCT frame).
  - Display live outer bounding-box dimensions ($W \times D \times H\text{ mm}$) on the active solid in Model mode so CAD edits (scale, split, boolean, shell) immediately show whether the modified solid still fits the active printer's build volume.
- **User Benefit**:
  Switching between Prepare and Model feels like changing workspaces inside one cohesive CAD/CAM studio rather than jumping into a separate viewer, and users can see at a glance where the bed plane ($Z=0$) and build limits lie while modeling.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **None** to engine or B-rep topology (`crates/lime-model-occt` untouched).
- **License Notes**: Pure TypeScript/Three.js (MIT).

---

### UX-4: Pre-Apply Feasibility Validation & Live Collision Envelopes

- **Problem & Code Evidence**:
  Two high-traffic workflows violate "feasibility shown before Apply":
  1. **Model Mode B-rep Operations (`src/app/model.ts:176–262`, `crates/lime-model-occt/cpp/session.cpp:607–639, 788–894`)**:
     - While adjusting inputs in `#modelPanel`, `syncGhost()` (`src/app/model.ts:176`) always renders the preview ghost in the same lime/red/sky color (`src/model-view.ts:19–20`), even when:
       - A **Hole** axis completely misses the solid's bounding box or has `depth <= 0` or `counterboreDepth >= depth` (which only fails after clicking Apply at `session.cpp:885`: `"The hole missed this solid"`).
       - A **Boolean** `subtract` or `intersect` primitive does not intersect the solid's bounding box (`session.cpp:624`: `"Result has no geometry"`).
       - A **Fillet** or **Chamfer** radius exceeds the minimum adjacent face width/edge length on the picked edge (`session.cpp:801, 833`), or **Shell** thickness exceeds half the solid's minimum bounding dimension.
       - A **Split** plane doesn't intersect the solid's bounding box (`session.cpp:747`: `"Split produced fewer than two pieces"`).
  2. **Sequential Printing Extruder & Gantry Clearance (`src/plate.ts:553–571`, `src/prepare-view.ts`, `crates/lime-slice-core/src/slice/plate.rs`)**:
     - In Prepare view, `overlappingObjectIds()` (`src/plate.ts:553`) only checks tight XY axis-aligned bounding box overlap (`OVERLAP_EPS_MM = 0.05`).
     - When `printOrder === "sequential"` is enabled (`docs/sequential-printing.md`), Prepare neither renders the extruder's `sequentialClearanceMm` skirt rings around objects nor checks `sequentialGantryMm` Z-height conflicts while dragging objects on the plate—the user only discovers sequential collisions **after** clicking Slice!
- **Proposed Change**:
  - **In Model Mode (`src/app/model.ts`, `src/model-view.ts`)**: Add synchronous client-side geometric feasibility checks inside `syncGhost()` against the current `ModelMeasure` / `ModelFaceInfo[]` / `ModelEdgeInfo[]`:
    - Check ray/cylinder intersection with the mesh AABB/triangles for `hole`; check AABB/OBB overlap for `boolean` (`subtract`/`intersect`); check plane/AABB intersection for `split`; check `radius < minAdjacentEdgeLength` heuristic (plus optional lightweight background dry-run probe) for `fillet`/`chamfer`.
    - When infeasible, tint the ghost amber/red (`0xf59e0b` / `0xf87171`), disable `#modelApply`, and display the specific plain-language reason inline in `#modelStatus` *before* the user clicks Apply.
  - **In Prepare Mode (`src/plate.ts`, `src/prepare-view.ts`)**: When `printOrder === "sequential"` is active, draw translucent `sequentialClearanceMm` stadium/cylinder footprints around each object on the bed and flag both XY clearance overlaps and `maxZ > sequentialGantryMm` height violations live in `#DropToast` / `#placeStatus` before slicing.
- **User Benefit**:
  Eliminates trial-and-error "Click Apply $\rightarrow$ Error" loops in Model mode and "Click Slice $\rightarrow$ Sequential Collision Error" loops in Prepare mode.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** to slicing output (`crates/lime-slice-core` G-code path unchanged).
- **License Notes**: Pure TypeScript/Rust (MIT).

---

### UX-5: Plain-Language Warnings & Mesh Repair Diagnostics Banner

- **Problem & Code Evidence**:
  1. **Raw OCCT C++ Exception Strings (`src/app/model-error.ts:6–41`, `crates/lime-model-occt/cpp/session.cpp:504–506, 637–639, 759–761`)**:
     - `modelErrorText()` in `src/app/model-error.ts:6–41` maps only 9 regex patterns and falls back at line 40 to `return trimmed;`. When OpenCascade throws a `Standard_Failure` such as `BRepAlgoAPI_BooleanOperation: TopoDS_Builder::Add` or `StdFail_NotDone` or `BRepCheck_UnorientableShape`, the raw C++ identifier string leaks directly into `#modelStatus`.
  2. **Silent Non-Manifold Mesh Bridging & Dropped Chains (`crates/lime-slice-core/src/index.rs:28–38, 218–305`, `crates/lime-slice-core/src/audit.rs:42–48`)**:
     - During slicing, `ZIndex::slice_with_stats` (`index.rs:226–305`) repairs broken/non-manifold STL cross-sections by bridging open gaps up to `CLOSE_GAP_MM = 1.25` mm or silently dropping unclosed chains (`stats.dropped += 1`).
     - While `audit_slice` (`crates/lime-slice-core/src/audit.rs:42`) computes `repaired_layers`, `bridged_mm`, and `dropped_chains` for the CLI `audit` binary, `SliceResponse` (`crates/lime-slice-core/src/slice.rs:51–78`) never returns these warnings to the UI. Users slicing broken STLs get missing walls or invented geometry with zero explanation.
- **Proposed Change**:
  - Replace the fallback in `src/app/model-error.ts:40` so any unmapped OCCT exception string containing `BRep*`, `TopoDS*`, `StdFail*`, or `gp_*` is translated into a plain-language message contextualized by the active tool (`"Could not complete this <tool> operation on the selected geometry. Try a smaller dimension or different face/edge."`), while logging the technical string only to the developer console.
  - Aggregate `CutStats` (`repaired_layers`, `bridged_mm`, `dropped_chains`) into an optional `warnings: Vec<SliceWarning>` on `SliceResponse` (only in the IPC response, never altering G-code) and render a non-intrusive, dismissible plain-language warning pill in `#summaryCard` (e.g., *"Mesh has non-manifold gaps on 14 layers; 6 open contour segments were skipped. Use Model > Repair or check the highlighted layers in Preview."*).
- **User Benefit**:
  Users never see cryptic C++ class names, and broken STLs immediately tell the user which layers had open gaps instead of failing silently on the printer.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **None** to G-code output (`SliceResponse` metadata addition only; G-code emission untouched).
- **License Notes**: Pure Rust/TypeScript (MIT).

---

## 3. Print Quality & Engine Feature Proposals (`crates/lime-slice-core` & `crates/lime-model-occt`)

All engine proposals below are strictly **opt-in / off by default** (`#[serde(default, skip_serializing_if = ...)]`) so default `SliceRequest` inputs pass `tools/golden_ab.sh` and `crates/lime-slice-core/tests/cartesian_lock.rs` with byte-identical G-code.

---

### ENG-1: Configurable Bed Adhesion — Outer/Inner Brim, Mouse Ears, and Skirt Controls

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/toolpath.rs:52, 653–685` (`plan_skirt`), bed adhesion on standard Cartesian/CoreXY printers is hardcoded to a single 1-loop skirt offset around the first-layer convex hull (or a belt raft on belt printers in `crates/lime-slice-core/src/belt.rs:49–50`).
  - There is no option for a **Brim** (concentric loops attached to the first-layer outer/inner contour at `brim_gap_mm`), **Mouse Ears** (circular adhesion discs placed automatically on sharp first-layer exterior corners where thermal warping stress concentrates), or **Skirt loops / distance** in `SliceRequest` (`crates/lime-slice-core/src/slice.rs:109–154`) or `src/ui/settings-schema.ts`.
  - Without a brim or mouse ears, tall/narrow parts and warping-prone filaments (ABS, ASA, PC, Nylon, large PETG prints) detach from the bed.
- **Proposed Change**:
  - Add optional fields to `SliceRequest` (`crates/lime-slice-core/src/slice.rs`):
    - `adhesion_type: AdhesionType` (`Skirt` [default], `Brim`, `MouseEars`, `None`)
    - `brim_width_mm: f64` (default `0.0` when `Skirt`, e.g. `5.0` mm when `Brim` is selected)
    - `brim_gap_mm: f64` (default `0.1` mm separation for easy peel)
    - `skirt_loops: usize` (default `1` to match current `plan_skirt` behavior)
  - In `crates/lime-slice-core/src/toolpath.rs`:
    - When `adhesion_type == AdhesionType::Skirt` and `skirt_loops == 1`, execute the exact existing `plan_skirt` code path (preserving golden A/B byte identity).
    - When `AdhesionType::Brim`, offset `layer 0` outer contours outward using `i_overlay` (`crates/lime-slice-core/src/offset.rs`) by `brim_gap_mm + k * line_width` for `k in 0..loops` and emit with `PathKind::Skirt` (or new `PathKind::Brim` when active).
    - When `AdhesionType::MouseEars`, detect exterior vertices on `layer 0` with interior angle $< 125^\circ$, union circular discs of diameter `brim_width_mm * 2` clipped outside `offset(contour, brim_gap_mm)`, and fill with concentric/rectilinear first-layer extrusions.
- **User Benefit**:
  Prevents corner lifting on engineering filaments and bed detachment on small-footprint parts without forcing users to model sacrificial discs in CAD.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **Zero when default** (`AdhesionType::Skirt`, `skirt_loops == 1` executes the untouched `plan_skirt` path; passes `tools/golden_ab.sh`).
- **License Notes**: Uses existing `i_overlay` (MIT) polygon offsetting in `crates/lime-slice-core/src/offset.rs`.

---

### ENG-2: Monotonic Top/Bottom Skin & Concentric Surface Pattern

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/toolpath.rs:480–595`, `PathKind::Solid` and `PathKind::Top` skins are filled with standard alternating back-and-forth rectilinear scanlines linked by nearest-endpoint greedy chaining.
  - When a top surface contains a hole or boss, the scanlines split into left and right sub-islands that are traversed from opposite Y/X directions, then rejoin after the hole. Because adjacent extrusion beads overlap differently depending on whether the previous neighbor was laid to the left or right, this creates a shiny/matte "scar" ridge extending from every hole on the top skin.
- **Proposed Change**:
  - Add `top_surface_pattern: SurfacePattern` (`Rectilinear` [default], `Monotonic`, `Concentric`) to `SliceRequest` (`#[serde(default, skip_serializing_if = "SurfacePattern::is_default")]`).
  - Implement a topological dependency sort (DAG over scanline segments that share an adjacent scanline neighbor across `step = line_width`) in `crates/lime-slice-core/src/toolpath.rs` so that under `SurfacePattern::Monotonic`, every segment in a connected top-skin region is extruded with its lateral progression strictly monotonic (e.g., always stepping from $-Y_\text{rot}$ to $+Y_\text{rot}$).
  - Under `SurfacePattern::Concentric`, offset the top-skin polygon inward repeatedly by `line_width` using `offset_polygons` (`crates/lime-slice-core/src/offset.rs`).
- **User Benefit**:
  Eliminates visible top-surface ridges around holes and lettering on cosmetic parts.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **Zero when default** (`SurfacePattern::Rectilinear` is default and skips the monotonic topological sort; passes `tools/golden_ab.sh`).
- **License Notes**: Clean-room Rust DAG sort over existing scanline segments + `i_overlay` (MIT).

---

### ENG-3: XY Dimensional Compensation (Hole / Contour Offset) & Elephant's Foot Compensation

- **Problem & Code Evidence**:
  - FDM prints systematically shrink vertical holes (due to chordal polygon approximation and inward viscoelastic tension when dragging filament around a concave inner loop) and flare the first layer outward ("elephant's foot" when squishing layer 0 onto the heated bed).
  - `crates/lime-slice-core/src/slice.rs` and `src/toolpath.rs` currently apply no contour/hole XY offset and no layer-0 inset. Users importing functional STEP assemblies must manually edit every hole diameter in Model mode to get M3/M4 clearance fits.
- **Proposed Change**:
  - Add three optional fields to `SliceRequest` (`crates/lime-slice-core/src/slice.rs`, `src/ui/settings-schema.ts` under **Quality**):
    - `xy_hole_compensation_mm: f64` (default `0.0`)
    - `xy_contour_compensation_mm: f64` (default `0.0`)
    - `elephants_foot_compensation_mm: f64` (default `0.0`)
  - In `crates/lime-slice-core/src/toolpath.rs` (at the start of per-layer contour processing, only when any of the three is non-zero):
    - Classify closed contour loops by signed area (`crates/lime-slice-core/src/poly.rs`): outer contours (`area > 0`) are offset by `xy_contour_compensation_mm`, while inner hole loops (`area < 0`) are offset by `-xy_hole_compensation_mm` (widening holes when positive).
    - On `layer_idx == 0`, apply an additional inward offset of `-elephants_foot_compensation_mm` to outer contours (`max(0.0, ...)`).
- **User Benefit**:
  Press-fit bearings, dowel pins, and screw holes printed from STEP/STL files fit to tolerance on the first print, and first-layer brims/edges stay flush without deburring.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero when default** (all three default to `0.0` and bypass the offset call when `== 0.0`; passes `tools/golden_ab.sh`).
- **License Notes**: Uses existing `i_overlay` (MIT) in `crates/lime-slice-core/src/offset.rs`.

---

### ENG-4: Exposed Support Interface Controls (Z-Gap, XY-Gap, Interface Layers) & Tree Trunk Base Brim

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/support.rs:196–216`, `SupportOpts::default()` hardcodes `xy_gap: 0.55`, `z_gap: 0.2`, `interface_layers: 3`, and `interface_pitch: 0.9`. None of these fields are exposed on `SliceRequest` (`crates/lime-slice-core/src/slice.rs:109–154`) or in the UI (`src/ui/settings-schema.ts:404–426`).
  - A fixed $0.20\text{ mm}$ Z-gap is too tight for PETG (causing supports to weld to the part) and too loose for $0.08\text{ mm}$ fine layers (causing drooping).
  - Additionally, in `crates/lime-slice-core/src/support/tree.rs`, organic tree trunks resting on the build plate (`on_bed`) start directly as thin circular wall loops on layer 0 without a wider base flange/brim, making tall slender trees prone to getting knocked over by the nozzle mid-print.
- **Proposed Change**:
  - Expose `support_z_gap_mm: Option<f64>`, `support_xy_gap_mm: Option<f64>`, `support_interface_layers: Option<usize>`, and `support_tree_brim_mm: Option<f64>` on `SliceRequest` (all `None` by default, falling back to `SupportOpts::default()` so golden hashes never change).
  - When `support_tree_brim_mm` is set (or enabled in the UI when `supportType == "tree"`), expand `layer 0` `on_bed` tree trunk rings outward by concentric brim loops of width `support_tree_brim_mm` in `crates/lime-slice-core/src/support/tree.rs`.
  - Add slim, collapsible advanced support controls under `#supportTools` in `src/ui/settings-schema.ts:404–426` with scrubbable `<input type="number">` fields.
- **User Benefit**:
  Allows dialing in clean support detachment across PLA, PETG, ASA, and soluble/breakaway interfaces, and prevents tall organic trees from detaching from the build plate.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero when default** (`None` preserves exact `SupportOpts::default()` values; passes `tools/golden_ab.sh`).
- **License Notes**: Pure Rust/TypeScript (MIT).

---

### ENG-5: Tunable Bridge Flow, Speed, Fan & Multi-Perimeter Anchor Extension

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/toolpath.rs:186, 238–252`, bridge extrusion flow is hardcoded to `1.0` (`"Multiplier on the volumetric bead. Bridges stay at 1."`) and bridge speed uses a fixed slowdown multiplier (`Slowdown::Bridge`), while bridge skin lines anchor only minimally into the supporting perimeter beneath them.
  - Stretching unsupported bridge extrusions under slight tension (`bridge_flow = 0.85–0.95`) with forced $100\%$ part-cooling fan (`M106 S255`) and controlled speed (`15–30 mm/s`) dramatically reduces bridge sag on spans $> 15\text{ mm}$.
- **Proposed Change**:
  - Add optional `bridge_flow_ratio: Option<f64>`, `bridge_speed_mm_s: Option<f64>`, and `bridge_fan_percent: Option<u8>` to `SliceRequest` (`None` by default).
  - In `crates/lime-slice-core/src/toolpath.rs` and `src/gcode.rs`, apply `bridge_flow_ratio` to `PathKind::Bridge` extrusion widths/areas, clamp feedrate to `bridge_speed_mm_s` when present, and emit a fan boost (`M106`) on layers/segments containing `PathKind::Bridge` before restoring layer fan speed.
- **User Benefit**:
  Flatter, tighter undersides on unsupported horizontal spans and counterbored holes without supports.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero when default** (`None` keeps flow at `1.0` and existing `Slowdown::Bridge` behavior; passes `tools/golden_ab.sh`).
- **License Notes**: Pure Rust (MIT).

---

### ENG-6: Multi-Edge Fillet/Chamfer & Face-Normal-Aligned Hole/Split in Model Mode (`crates/lime-model-occt`)

- **Problem & Code Evidence**:
  - In `crates/lime-model-occt/cpp/session.cpp:788–851`, `lime_model_occt_fillet(int edge, double radius, ...)` and `lime_model_occt_chamfer(int edge, double distance, ...)` accept only a **single** `int edge` index.
  - Meanwhile, the frontend (`src/model-view.ts:83`, `src/app/model.ts:154`) already supports Shift-clicking multiple edges (`picks: ModelPick[]`), yet clicking Apply on a fillet or chamfer only processes the single active edge—forcing the user to repeat `Pick -> Apply -> Wait for OCCT remesh` $N$ times (and Worse: edge indices shift after every boolean/fillet rebuild!).
  - Additionally, `BRepFilletAPI_MakeFillet` in OpenCascade handles corner blends across meeting edges *far* more reliably when all meeting edges are added to the **same** `BRepFilletAPI_MakeFillet` instance via `.Add(radius, edge_i)` before calling `.Build()` once.
  - Similarly, `lime_model_occt_hole` (`session.cpp:853–894`) hardcodes the drill axis to `gp_Dir(0.0, 0.0, 1.0)` (world $Z$), so picking a side wall ($X$ or $Y$ face) or an angled face drills vertically along $Z$ instead of perpendicular to the picked face!
- **Proposed Change**:
  - Extend `lime_model_occt_fillet` and `lime_model_occt_chamfer` (or add `lime_model_occt_fillet_many(const int* edges, int edge_count, double radius, ...)` in `crates/lime-model-occt/cpp/session.cpp` and `crates/lime-model-occt/src/lib.rs`) so all selected edges in `picks` are added to a single `BRepFilletAPI_MakeFillet` / `BRepFilletAPI_MakeChamfer` builder before `.Build()`.
  - Extend `lime_model_occt_hole` (`session.cpp:853–894`) to accept a direction vector `(dx, dy, dz)` (defaulting to `(0, 0, -1)` when unpicked, or seeded from the picked planar face's inward normal `-face.normal` from `ModelFaceInfo` in `src/app/model.ts:228–262`).
- **User Benefit**:
  Users can Shift-click 4–12 edges of a pocket or box and fillet/chamfer them in a single atomic operation with proper OCCT corner blending, and drill holes perpendicular to any side or angled face.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** to `crates/lime-slice-core` G-code output. Single-edge fillet/chamfer and Z-axis holes remain backwards-compatible.
- **License Notes**: Uses existing dynamically linked OpenCascade 7.9.2 (`BRepFilletAPI_MakeFillet`, `BRepPrimAPI_MakeCylinder`, LGPL-2.1-only with dynamic linking via `crates/lime-model-occt/build.rs`).

---

### ENG-7: Interactive Layer-Slider Pause (`M601`/`PAUSE`) & Filament Change (`M600`) Injection

- **Problem & Code Evidence**:
  - In `src/app/viewer.ts` and `src/app/markup.ts:183–209`, the Preview vertical layer slider (`#layerMax`, `#layerMin`) lets users scrub through layers, and `LayerRule` (`crates/lime-slice-core/src/slice.rs:289–299`) allows changing Pareto strategy between `z_min` and `z_max`.
  - However, there is no way to right-click or click a `+` button on the Preview layer slider at layer $L$ to insert a **Print Pause** (for embedding captive M3 nuts or magnets) or **Color/Filament Change** (`M600` / Klipper `PAUSE` / `M601`) at the start of that layer in `crates/lime-slice-core/src/gcode.rs`.
- **Proposed Change**:
  - Add `layer_actions: Vec<LayerAction>` (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) to `SliceRequest`, where `LayerAction` specifies `{ z_mm: f64, kind: Pause | FilamentChange | CustomGcode(String), note: Option<String> }`.
  - In `crates/lime-slice-core/src/gcode.rs`, at the layer transition matching `z_mm`, emit the firmware-appropriate command based on `MachineConfig.gcodeDialect` (`M601` / `M600` for Marlin/Prusa, `PAUSE` / `M600` for Klipper, `M400 U1` for Bambu/RRF).
  - Add a `+` marker badge on the `#layerMax` thumb in Preview mode (`src/app/viewer.ts`) to toggle a Pause or Filament Change at the currently inspected layer with visual pin ticks along the layer track.
- **User Benefit**:
  Captive hardware (hex nuts, magnets, ball bearings) and multi-color sign/logo swaps become a 1-click workflow on the Preview layer slider.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero when default** (`layer_actions` is empty by default; passes `tools/golden_ab.sh`).
- **License Notes**: Pure Rust/TypeScript (MIT).

---

## 4. Performance Proposals

`lime-slice` already parallelizes per-layer Z-slicing and toolpath planning via `rayon` (`docs/parallelism-inventory.md`) and transfers `Float32Array` preview chunks zero-copy from `src/geom-worker.ts:26–27`. The proposals below target the remaining single-threaded or multi-pass bottlenecks identified in code.

---

### PERF-1: Single-Pass Object Bucketing in `buildWirePreview` (`src/preview-geom.ts`)

- **Problem & Code Evidence**:
  - In `src/preview-geom.ts:100–120` (`buildWirePreview`), when building 32-layer wire preview chunks for a plate with `objects > 1`:
    ```ts
    for (let i = 0; i < layers.length; i += CHUNK_LAYERS) {
      const j = Math.min(layers.length, i + CHUNK_LAYERS);
      for (let object = 0; object < objects; object++) {
        const chunk = buildChunk(layers.slice(i, j), i, j - 1, objects > 1 ? object : undefined);
    ```
  - Inside `buildChunk` (`src/preview-geom.ts:122–179`), both Pass 1 (counting `beadVerts` / `travelVerts`) and Pass 2 (filling `Float32Array` buffers) iterate through **every path of every layer** in the chunk and filter by `(cols.object[p] ?? 0) !== object` (`lines 130, 152`).
  - For a plate with $N = 12$ objects (e.g. a batch plate or sequential print), `buildWirePreview` scans every layer's packed typed arrays $2 \times 12 = 24$ times instead of 2 times ($O(\text{objects} \times \text{paths})$).
- **Proposed Change**:
  - Refactor `buildChunk` into `buildChunksForLayerRange(sliceLayers, layerStart, layerEnd, objectCount)` in `src/preview-geom.ts`:
    - In Pass 1, iterate each path once and increment `beadAt[obj][kind]` and `travelAt[obj]` for `const obj = cols.object[p] ?? 0`.
    - Allocate the per-object `Float32Array` buffers once for all non-empty objects in that layer range.
    - In Pass 2, iterate each path once and write vertices into that `obj`'s cursor.
- **User Benefit**:
  Up to $8\times$–$15\times$ faster 3D preview geometry generation in `geom-worker.ts` on multi-object plates (e.g. 10–20 copies created with `Fill bed` or `Multiply`), keeping Preview responsive immediately after slicing.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero** (produces identical `PreviewChunk[]` buffers in the exact same order; verifiable by unit test in `src/preview-geom.test.ts`).
- **License Notes**: Pure TypeScript (MIT).

---

### PERF-2: Parallel Per-Layer G-Code String Formatting (`crates/lime-slice-core/src/gcode.rs`)

- **Problem & Code Evidence**:
  - As noted in `docs/parallelism-inventory.md` and `crates/lime-slice-core/src/gcode.rs:86–99, 233–250`, `emit_later` defers G-code text construction until export/upload (`GcodeText::Later(Box<Formatter>)`) while computing `Totals` during slice and caching arc-fit primitives per `PrintLayer` via `OnceLock<Vec<LayerPrim>>`.
  - However, when the user clicks **Export G-code** or **Send to printer**, `Formatter::format` (`crates/lime-slice-core/src/gcode.rs:252–310`) formats every layer sequentially on a single thread (`write!(&mut out, ...)` across hundreds of thousands of moves). On dense 1,000-layer organic-tree prints ($50\text{ MB}$–$120\text{ MB}$ G-code), sequential `f64` formatting takes 400–900 ms.
- **Proposed Change**:
  - In `crates/lime-slice-core/src/gcode.rs`, compute the deterministic per-layer starting modal state (`last_f`, `last_fan`, `last_z`, `last_object`) in a fast lightweight pass over `layers` (which already happens during `scan_totals`), then format each layer's body `String` in parallel using `layers.par_iter().enumerate().map(...)` (`rayon`), and concatenate header + layer strings + footer in layer order.
- **User Benefit**:
  $3\times$–$6\times$ faster G-code export and printer upload preparation on multi-core desktops while producing **100% byte-for-byte identical G-code**.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **Low / Verifiable**: Must preserve exact modal state transitions across layer boundaries; directly guarded by `tools/golden_ab.sh` and `crates/lime-slice-core/tests/cartesian_lock.rs`.
- **License Notes**: Uses existing `rayon` (MIT / Apache-2.0).

---

### PERF-3: Parallel Multi-Shell STEP Tessellation (`crates/lime-slice-core/src/step.rs`)

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/step.rs:118–136` (`load_step`), after reading the STEP exchange structure and extracting `emits: Vec<(String, CompressedShell<...>)>`, each shell is tessellated sequentially in a `for emit in &emits` loop (`tessellate_shell(&emit.1, tol)` using `truck_meshalgo::tessellation::MeshableShape::triangulate`).
  - Furthermore, inside `crates/lime-model-occt/cpp/session.cpp:178` (`ensure_mesh`), `BRepMesh_IncrementalMesh m(s, kLinearDeflection, false, kAngularDeflection, true)` already passes `isInParallel = true` for OCCT, but the pure-Rust `load_step` fallback in `crates/lime-slice-core/src/step.rs` runs strictly single-threaded across shells.
- **Proposed Change**:
  - Replace the sequential `for emit in &emits` loop in `crates/lime-slice-core/src/step.rs:119` with `emits.par_iter().map(|emit| tessellate_shell(&emit.1, tol)).collect::<Vec<_>>()`, then merge triangles in deterministic shell order.
- **User Benefit**:
  Multi-body STEP assemblies tessellate $3\times$–$6\times$ faster when opened via `crates/lime-slice-core`.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero** (deterministic `par_iter().collect::<Vec<_>>()` preserves exact triangle order).
- **License Notes**: Uses existing `rayon` and `truck-meshalgo` (Apache-2.0).

---

## 5. Reliability Proposals

---

### REL-1: Fix Multi-Object 3MF Vertex Indexing Bug & Preserve Objects on 3MF Export/Import

- **Problem & Code Evidence**:
  1. **Critical Bug in `parse_3mf_model` (`crates/lime-slice-core/src/load.rs:212–249`)**:
     - In the 3MF Core Specification, each `<object><mesh><vertices>...</vertices><triangles>...</triangles></mesh></object>` defines its **own** 0-based vertex array.
     - However, `parse_3mf_model` (`crates/lime-slice-core/src/load.rs:212–243`) declares a single `let mut vertices: Vec<[f64; 3]> = Vec::new();` for the entire XML file and **never clears `vertices` or updates a base vertex offset when entering a new `<mesh>` or `<object>`**!
     - As a result, when loading **any** 3MF file containing 2 or more `<mesh>` elements, the second mesh's `<triangle v1="0" v2="1" v3="2"/>` indexes into the *first* mesh's vertices (`vertices[0]`, `vertices[1]`, `vertices[2]`), producing wildly corrupted geometry or distorted plates!
     - In addition, `parse_3mf_model` ignores `<item objectid="..." transform="m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"/>` in `<build>` and `<component>` references (`load.rs:206–254`).
  2. **Bloated & Flattened 3MF Export (`src/mesh-place.ts:364–389`, `src/plate.ts:397–408`)**:
     - On export, `encode3mf` (`src/mesh-place.ts:364–389`) flattens all plate objects into a single merged triangle soup via `platePlacedPositions` (`src/plate.ts:397`) and writes 3 duplicate `<vertex>` tags per triangle without vertex deduplication (inflating exported `.3mf` XML by $\sim 6\times$).
- **Proposed Change**:
  - **Fix `parse_3mf_model` (`crates/lime-slice-core/src/load.rs:206–254`)**:
    - Parse each `<object id="...">` into its own `ObjectMesh { vertices, triangles, components }`, resetting the local vertex table per `<mesh>`.
    - Parse `<build><item objectid="..." transform="..."/></build>` (and `<components><component objectid="..." transform="..."/></components>`) and apply the $4\times 3$ affine transformation matrix (converting to right-handed orientation if determinant $< 0$) when instantiating each build item.
  - **Preserve Multi-Object Plate & Deduplicate Vertices in `encode3mf` (`src/mesh-place.ts:364–389`)**:
    - Deduplicate shared vertices per object via spatial/bit hash before emitting `<vertices>` (shrinking exported `.3mf` files by $\sim 70\%$).
    - Support emitting one `<object>` + `<build><item>` per `PlateObject` so saving and re-opening a `.3mf` preserves independent objects on the plate.
- **User Benefit**:
  Multi-object 3MF files from Printables, MakerWorld, CAD exporters, and other slicers load with intact, accurately positioned geometry instead of cross-wired vertices, and exported 3MF files are $3\times$–$5\times$ smaller.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **Zero** for single-mesh 3MF files without transforms (produces identical triangles); fixes broken geometry on multi-object 3MF files.
- **License Notes**: Pure Rust (`quick-xml`, MIT) and TypeScript (MIT).

---

### REL-2: Unified Undo/Redo History Across Prepare and Model Mode & Async OCCT Execution

- **Problem & Code Evidence**:
  1. **Split Undo Stacks & Missing Redo in Model Mode (`crates/lime-model-occt/cpp/session.cpp:72, 146–164, 766–786`, `src/app/history.ts:27`, `src/app/model.ts:547–576`)**:
     - Prepare/Preview uses `EditHistory<Snap>` (`src/app/history.ts:27`) supporting full Undo (`Ctrl+Z`) and Redo (`Ctrl+Y` / `Ctrl+Shift+Z`).
     - Model mode uses a separate C++ global `std::vector<TopoDS_Shape> g_undo` (`session.cpp:72`) with **no redo stack** (`g_redo` does not exist), and `store()` (`session.cpp:146`) clears `g_undo` whenever a new shape is loaded (such as switching objects or exiting and re-entering Model mode). Pressing `Ctrl+Y` / `Cmd+Shift+Z` in Model mode does nothing, and undoing in Prepare cannot step across a Model mode session.
  2. **Synchronous Tauri IPC Blocking on Heavy OCCT Operations (`src-tauri/src/lib.rs:261–398`)**:
     - While `slice_model` (`src-tauri/src/lib.rs:127`) and `pareto_model` (`lib.rs:202`) run on background worker threads via `tauri::async_runtime::spawn_blocking`, all 12 `model_*` commands (`model_boolean`, `model_fillet`, `model_chamfer`, `model_shell`, `model_pattern`, `model_split`, etc. at `src-tauri/src/lib.rs:261–398`) are synchronous `fn` handlers that block the Tauri IPC thread while OpenCascade computes complex B-rep booleans or fillets.
- **Proposed Change**:
  - Add a `std::vector<TopoDS_Shape> g_redo` stack alongside `g_undo` in `crates/lime-model-occt/cpp/session.cpp` and expose `lime_model_occt_redo` / `model_redo` through `crates/lime-model-occt/src/lib.rs` and `src-tauri/src/lib.rs`, wired to `Ctrl+Y` / `Cmd+Shift+Z` and a `#modelRedo` button in `src/app/model.ts`.
  - Snapshot the pre-Model and post-Model B-rep/mesh state into `EditHistory<Snap>` (`src/app/history.ts`) when applying or exiting Model mode so Prepare Undo/Redo can cleanly step across Model edits.
  - Wrap all `model_*` Tauri commands in `src-tauri/src/lib.rs:261–398` in `async fn ... tauri::async_runtime::spawn_blocking(...)` so long-running OCCT booleans/fillets never freeze window responsiveness.
- **User Benefit**:
  Users get `Ctrl+Y` / `Cmd+Shift+Z` Redo inside Model mode, never lose undo history across mode transitions, and the UI stays responsive during heavy B-rep operations.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** to slicing engine (`crates/lime-slice-core` untouched).
- **License Notes**: Pure C++/Rust/TypeScript using existing dynamically linked OCCT (LGPL-2.1 dynamic linking).

---

### REL-3: Epsilon Vertex Welding Fallback for Jittered STLs (`crates/lime-slice-core/src/index.rs`)

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/index.rs:41–96` (`ZIndex::build`), triangle vertices are deduplicated using exact IEEE-754 bit patterns:
    ```rust
    let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
    ```
  - ASCII STL files and meshes exported from Blender, Rhino, or older CAD tools frequently have $10^{-6}\text{ mm}$ floating-point formatting jitter between shared vertices of adjacent triangles (or signed zero `-0.0` vs `+0.0`, where `(-0.0f32).to_bits() != 0.0f32.to_bits()`!).
  - When two adjacent triangles differ by `-0.0` vs `+0.0` or $10^{-6}\text{ mm}$, `ZIndex::build` treats their shared edge as two unconnected boundary edges, forcing `slice_with_stats` (`index.rs:218–305`) onto the slow `open` chain stitcher on every single layer.
- **Proposed Change**:
  - Normalize `-0.0` (`if x == 0.0 { 0.0 } else { x }`) unconditionally in `ZIndex::build` (or quantize vertex keys to a fine sub-nanometer / $10^{-5}\text{ mm}$ grid when exact bit-welding leaves unshared boundary edges).
  - To guarantee **100% golden A/B byte identity** on all existing watertight meshes, run exact bit-welding (with `-0.0` canonicalized only if open edges exist) first, and trigger quantized $10^{-5}\text{ mm}$ welding **only** on meshes where the exact pass leaves unmatched half-edges (`boundary_edges > 0`).
- **User Benefit**:
  Eliminates spurious open contours, missing layer islands, and slow chain stitching on ASCII STLs and third-party exports while keeping clean binary STLs byte-identical.
- **Effort**: **S**
- **Risk to Existing Behaviour**: **Zero on manifold meshes** (exact bit-welding runs first; fallback triggers only when broken/unshared edges exist; passes `tools/golden_ab.sh`).
- **License Notes**: Pure Rust (MIT).

---

## 6. File Formats & Printer Connectivity Proposals

---

### FMT-1: Moonraker (Klipper) & OctoPrint Native Upload + Live `printer.cfg` Limits Import

- **Problem & Code Evidence**:
  - In `src/ui/machine-library.ts:860–875`, almost every built-in printer profile in `lime-slice` (`Lime 220`, `Lime 300`, `Lime 180`, `Generic belt 45°`, `Ideaformer IR3 V2`) runs **Klipper** (`firmware: "klipper"`), and the comment at `machine-library.ts:865–866` explicitly notes:
    > *"Klipper: no acceleration M-codes in the start G-code. The limits are the printer's own printer.cfg, read from Moonraker."*
  - Yet the printer network client (`src/ui/prusa-link.ts` and `src-tauri/src/prusa_http.rs:1–122`) **only implements the Prusa Link HTTP API** (`GET /api/v1/info`, `GET /api/v1/status`, `PUT /api/v1/files/local/<filename>` with `X-Api-Key`).
  - Users with Klipper/Moonraker printers (Voron, RatRig, Creality K1, Sovol, belt printers, Lime printers) or OctoPrint cannot upload G-code directly from `lime-slice` or sync their machine kinematic limits from Moonraker.
- **Proposed Change**:
  - Add a `hostType: "prusalink" | "moonraker" | "octoprint"` selector to the Printer Connection dialog (`src/ui/prusa-link.ts`, `src-tauri/src/prusa_http.rs`):
    - **Moonraker**:
      - Status: `GET /printer/info` and `GET /printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed`.
      - Upload & Print: `POST /server/files/upload` (`multipart/form-data` with `file`, `root="gcodes"`, `print="true"|"false"`).
      - **"Import kinematic limits from Moonraker" button**: Queries `GET /printer/objects/query?configfile=settings` and populates `maxVelocity`, `maxAccel`, `squareCornerVelocity`, `minimumCruiseRatio`, and bed dimensions into the active `MachineDef` (`src/ui/machine-library.ts`) so `lime-slice`'s trapezoid/junction time estimator (`crates/lime-slice-core/src/gcode.rs:25–58`) matches the real Klipper `printer.cfg` to the second!
    - **OctoPrint**:
      - Status: `GET /api/job` and `GET /api/printer` (`X-Api-Key`).
      - Upload: `POST /api/files/local` (`multipart/form-data`).
- **User Benefit**:
  Makes `lime-slice`'s primary target hardware (Klipper CoreXY and belt printers) first-class citizens for 1-click network printing and automatic print-time calibration from `printer.cfg`.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **Zero** to slicing engine; Prusa Link remains intact as a `hostType` option.
- **License Notes**: Pure Rust (`reqwest`, MIT / Apache-2.0) and TypeScript (MIT). Moonraker and OctoPrint REST APIs are open HTTP specifications; no GPL client code is used.

---

### FMT-2: Multi-Solid STEP Assembly & Multi-Shell Mesh "Split to Objects / Parts"

- **Problem & Code Evidence**:
  - In `crates/lime-slice-core/src/step.rs:118–136` (`load_step`), a STEP file containing multiple solids (`emits`) merges all shells into a single `Mesh` (`triangles.extend(raw.triangles)`).
  - Similarly, in `crates/lime-model-occt/cpp/session.cpp:747` (`lime_model_occt_split`), splitting a solid with a plane keeps all resulting `TopoDS_Solid` pieces inside a single compound (`BRep_Builder::Add(&compound, exp.Current())`) rather than allowing the user to split them into separate movable `PlateObject` items on the bed so both halves can be laid flat (`Place on face`) side-by-side!
- **Proposed Change**:
  - **Split into Objects on Plate (`src/plate.ts`, `src/app/place.ts`)**:
    - Add a **Split to objects** action in `#placeBar` (enabled whenever the selected mesh has $\ge 2$ disconnected triangle shells via connected-component BFS on shared vertices, including after a Model mode `Split` operation or loading a multi-body STEP/STL).
    - Each connected component becomes its own `PlateObject` at its original world position (or auto-arranged on the bed), while retaining its B-rep sub-solid if split from OCCT (`crates/lime-model-occt`).
  - **Multi-Body STEP Import Option**:
    - When a STEP file contains $> 1$ closed shell, offer a non-blocking toast action: *"Imported assembly with N solids — [Split into N objects]"*.
- **User Benefit**:
  Completes the "Split tall part in Model mode $\rightarrow$ Separate halves onto the bed $\rightarrow$ Place cut faces flat on bed" workflow, and lets CAD engineers import multi-part STEP assemblies directly onto the build plate.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** to single-solid files or slicing engine.
- **License Notes**: Pure Rust/TypeScript (MIT) + existing OCCT dynamic link.

---

### FMT-3: Foreign 3MF Project Recipe Import (PrusaSlicer / OrcaSlicer / Bambu Studio / Cura)

- **Problem & Code Evidence**:
  - `src/foreign-3mf.ts:1–60` inspects `.3mf` ZIP archives for `Metadata/Slic3r_pe.config`, `Metadata/PrusaSlicer.ini`, `Metadata/project_settings.config`, and `Cura/` entries, and currently displays a passive dismissal notice:
    > `"Opened the mesh only. <Vendor> settings in this 3MF were not imported."`
  - Users downloading 3MF project files from Printables or MakerWorld lose the author's intended wall count, infill density, layer height, support enablement, and modifier boxes.
- **Proposed Change**:
  - Extend `src/foreign-3mf.ts` with a pure-TypeScript metadata mapper (`extractForeign3mfRecipe(bytes)`):
    - Parse INI (`Metadata/Slic3r_pe.config` for PrusaSlicer) and JSON (`Metadata/project_settings.config` + `Metadata/model_settings.config` for OrcaSlicer / Bambu Studio) keys into a partial `LimeRecipePatch`:
      - `layer_height` $\rightarrow$ `layerHeightMm`
      - `perimeters` / `wall_loops` $\rightarrow$ `walls`
      - `fill_density` / `sparse_infill_density` $\rightarrow$ `infillDensity`
      - `top_solid_layers` / `bottom_solid_layers` $\rightarrow$ `topLayers` / `bottomLayers`
      - `support_material` / `enable_support` $\rightarrow$ `supportsEnabled`, `supportType` (`tree`/`normal`)
      - `nozzle_temperature` / `bed_temperature` $\rightarrow$ `nozzleTempC` / `bedTempC`
    - Instead of a dead-end toast, show an actionable banner: *"Found <Vendor> print settings (0.20 mm, 4 walls, 25% gyroid, tree supports) — [Apply to Recipe] [Keep Current]"*.
- **User Benefit**:
  Turns third-party 3MF files from Printables and MakerWorld into ready-to-slice projects while keeping the user's machine profile safe unless they click **Apply to Recipe**.
- **Effort**: **M**
- **Risk to Existing Behaviour**: **None** (opt-in toast button; mesh loading unchanged).
- **License Notes**: Pure TypeScript INI/JSON key mapping (MIT). Parsing user-supplied config key-value pairs in a 3MF ZIP carries zero GPL taint.

---

## 7. Competitive Gap Analysis: `lime-slice` vs. PrusaSlicer, OrcaSlicer, Cura & Bambu Studio

| Capability Area | PrusaSlicer 2.8+ | OrcaSlicer 2.2+ | UltiMaker Cura 5.8+ | Bambu Studio 1.9+ | `lime-slice` (Current) | Gap & Strategic Direction |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Viewport Budget & UI Density** | Tabbed clutter; settings hide 3D view entirely | Ribbon + wide sidebar ($\sim 55\%$ viewport) | Floating drawer overlays | Wide multi-tab sidebar ($\sim 55\%$ viewport) | **$\ge 70\%$ viewport** target, slim controls, scrubbable labels | **Lead**, but keep $\ge 70\%$ after slice (**UX-2**) and unify gizmo/numeric sync (**UX-1**). |
| **Objective / Pareto Blending** | None (manual profile tweaking) | None | Intent profiles (static presets) | None | **3-corner Pareto (`Speed` / `Efficiency` / `Toughness`) + layer/region weights** | **Unique `lime-slice` differentiator**. |
| **Direct CAD / B-Rep Modeling** | Primitive add/cut only (mesh CSG) | Mesh boolean only | None (plugins only) | Mesh boolean + text emboss | **Full OCCT 7.9.2 B-rep Model mode (Boolean, Fillet, Chamfer, Hole, Shell, Pattern, Split)** | **Major `lime-slice` lead**; needs multi-edge fillet/chamfer & face-normal holes (**ENG-6**) + 3D ghost handles (**UX-1**). |
| **Belt Printer Slicing ($45^\circ$)** | None (community forks stale) | Partial (experimental) | Blackbelt plugin (dated) | None | **First-class belt bed, belt raft, tilted-floor organic trees, belt seam** | **Major `lime-slice` lead**; needs Moonraker upload (**FMT-1**). |
| **Post-Slice Support Editing** | Paint pre-slice only | Paint pre-slice only | Support blocker boxes only | Paint pre-slice only | **Post-slice click-to-prune & click-gap-to-regrow with `<150 ms` patch** | **Unique `lime-slice` differentiator**. |
| **Local Infill Reinforcement** | Modifier mesh setup (multi-step) | Modifier mesh setup | Modifier mesh setup | Modifier mesh setup | **Brush-painted surface reinforcement (`depthMm`, `fillThrough`) + Box/Cylinder volumes** | **Recently completed (PR #257)**. |
| **Bed Adhesion (Brim / Ears)** | Outer/Inner Brim, Skirt, Raft | Outer/Inner Brim, Mouse Ears, Skirt | Brim, Skirt, Raft | Outer/Inner Brim, Mouse Ears, Auto-Brim | **1-loop Skirt or Belt Raft only** | **High-priority gap** $\rightarrow$ **ENG-1** (Brim & Mouse Ears). |
| **Top Surface Quality** | Monotonic, Concentric, Ironing | Monotonic, Concentric, Ironing | Monotonic, Concentric, Ironing | Monotonic, Concentric, Ironing | **Non-monotonic Rectilinear + Ironing** | **High-priority gap** $\rightarrow$ **ENG-2** (Monotonic & Concentric skins). |
| **Dimensional Accuracy** | XY Size & Hole Compensation, Elephant's Foot | X-Y Hole / Contour, Elephant's Foot, Precise Wall | Horizontal Expansion, Hole Horizontal Expansion, Initial Layer | X-Y Hole / Contour, Elephant's Foot | **None** | **High-priority gap for CAD users** $\rightarrow$ **ENG-3**. |
| **Variable Width Walls** | Arachne | Arachne + Classic | Arachne | Arachne + Classic | **Medial-axis gap fill (`gap_fill.rs`) + classic offsets** | Gap fill handles thin walls well; full variable-width perimeter beading is a longer-term **L** option. |
| **3MF Multi-Object & Metadata** | Native 3MF project format | Multi-plate 3MF | 3MF + UFP | Multi-plate 3MF | **Single-mesh vertex table bug on multi-object 3MF (`load.rs:212`); ignores foreign settings** | **Critical bug + workflow gap** $\rightarrow$ **REL-1** & **FMT-3**. |
| **Printer Network Protocols** | PrusaLink, OctoPrint, Moonraker, Bambu | Moonraker, OctoPrint, PrusaLink, Bambu LAN/Cloud | UltiMaker Digital Factory, OctoPrint, Moonraker plugin | Bambu Cloud / LAN MQTT | **Prusa Link only (`prusa_http.rs`)** | **High-priority gap** (especially since default machines are Klipper) $\rightarrow$ **FMT-1**. |
| **Pause / Filament Swap at Layer** | Right-click layer slider (`M601`/`M600`) | Right-click layer slider (`PAUSE`/`M600`/custom) | Post-processing script UI | Right-click layer slider | **None** | **Easy high-value win** $\rightarrow$ **ENG-7**. |

---

## 8. Ranked Top 10 Enhancement Proposals

The proposals below are ranked by **User Impact $\times$ Strategic Fit $\div$ Implementation Risk**:

| Rank | ID | Proposal | Category | Effort | Engine Default / Golden A/B Impact |
| :---: | :---: | :--- | :--- | :---: | :--- |
| **1** | **REL-1** | **Fix Multi-Object 3MF Vertex Indexing Bug & Preserve Objects + Deduplicate Vertices on 3MF Export** (`crates/lime-slice-core/src/load.rs:212–249`, `src/mesh-place.ts:364`) | Reliability / File Formats | **M** | Single-mesh 3MF untouched; fixes corrupted geometry on multi-object 3MFs. |
| **2** | **ENG-1** | **Bed Adhesion Suite: Outer/Inner Brim, Automatic Corner Mouse Ears & Skirt Loops** (`crates/lime-slice-core/src/toolpath.rs:653`) | Print Quality / Engine | **M** | Off by default (`AdhesionType::Skirt`, `loops = 1`); byte-identical golden G-code. |
| **3** | **FMT-1** | **Moonraker (Klipper) & OctoPrint Native Upload + 1-Click `printer.cfg` Kinematic Limits Sync** (`src-tauri/src/prusa_http.rs`, `src/ui/prusa-link.ts`) | Connectivity | **M** | Zero engine change; aligns network client with `lime-slice`'s Klipper machine library. |
| **4** | **UX-1** | **Every Tool Numeric + Mouse-Draggable in Sync** (Prepare `Rx°/Ry°/Rz°` inputs, paint brush numeric + wheel resize, section plane offset input, Model mode 3D ghost handles, dynamic `bindScrubLabels`) | UX & Workflow | **M** | Zero engine change; completes core interaction invariant across all tools. |
| **5** | **ENG-3** | **XY Hole / Contour Compensation & First-Layer Elephant's Foot Compensation** (`crates/lime-slice-core/src/toolpath.rs`, `src/slice.rs`) | Print Quality / Engine | **S** | Off by default (`0.0 mm`); byte-identical golden G-code. Essential for CAD/STEP parts. |
| **6** | **ENG-6** | **Model Mode Multi-Edge Atomic Fillet/Chamfer & Face-Normal-Aligned Hole Drilling** (`crates/lime-model-occt/cpp/session.cpp:788–894`, `src/app/model.ts`) | Model Mode / CAD | **M** | Zero G-code change; unlocks multi-edge corner blends and side/angled holes. |
| **7** | **UX-4** | **Pre-Apply Feasibility Checks in Model Mode & Live Sequential Clearance Envelopes in Prepare** (`src/app/model.ts`, `src/plate.ts`, `src/prepare-view.ts`) | UX & Workflow | **M** | Zero G-code change; flags invalid B-rep parameters and sequential collisions before Apply/Slice. |
| **8** | **ENG-2** | **Monotonic Top/Bottom Skin Ordering & Concentric Surface Pattern** (`crates/lime-slice-core/src/toolpath.rs`) | Print Quality / Engine | **M** | Off by default (`SurfacePattern::Rectilinear`); byte-identical golden G-code. |
| **9** | **FMT-2** | **Split Disconnected Shells / Split-Plane Solids into Independent Plate Objects** (`src/plate.ts`, `crates/lime-slice-core/src/step.rs`) | File Formats / Workflow | **M** | Zero G-code change on unsplit meshes; lets cut parts and STEP assemblies lay flat separately. |
| **10** | **PERF-1 + UX-2 + UX-5** | **Fast Multi-Object Preview Chunking (`O(paths)` single pass), Enforced $\ge 70\%$ Viewport After Slice, and Plain-Language OCCT / Mesh Repair Warnings** (`src/preview-geom.ts:106`, `src/ui/splitters.ts`, `src/app/model-error.ts`) | Performance / UX / Reliability | **S** | Zero G-code change; immediate polish and $8\times+$ faster multi-object preview generation. |

---

## 9. Open Review Questions for Marius

1. **Brim & Mouse Ears Default Policy (`ENG-1`)**:
   - While `AdhesionType::Skirt` must remain the engine default in `SliceRequest` so `tools/golden_ab.sh` stays byte-identical, should the UI recipe presets for high-warp materials (`ABS`, `ASA`, `PC` in `src/ui/filament-library.ts`) automatically suggest **Mouse Ears** or a **5 mm Brim** in the Prepare toast, or keep adhesion strictly manual per recipe?
2. **Model Mode Split $\rightarrow$ Plate Objects Workflow (`FMT-2` & `ENG-6`)**:
   - When a user splits a solid with `Model > Split` (`session.cpp:747`), should Model mode keep the pieces inside one compound with an explicit **"Separate into plate objects"** button on exit, or should `Split` with `Keep: Both` automatically offer a `Separate gap (mm)` / `Lay cut faces on bed` toggle right inside `#modelPanel`?
3. **Moonraker `printer.cfg` Auto-Sync Scope (`FMT-1`)**:
   - When reading `configfile.settings` from a Klipper printer via Moonraker, should `lime-slice` update only the motion planner limits (`max_velocity`, `max_accel`, `square_corner_velocity`, `minimum_cruise_ratio`) used for accurate print-time estimation, or also offers to sync `stepper_x/y/z.position_max` (build volume) and `extruder.nozzle_diameter` into a saved custom machine profile (`.limemachine.json`)?
4. **Monotonic Top Skin Promotion (`ENG-2`)**:
   - Once `SurfacePattern::Monotonic` is implemented behind a default-off field (`SurfacePattern::Rectilinear`), would you like to keep `Rectilinear` as the permanent default, or eventually bless `Monotonic` as the default for the `Quality` preset in a dedicated golden-hash update PR?
5. **Foreign 3MF Recipe Import (`FMT-3`)**:
   - When opening a PrusaSlicer / OrcaSlicer / Bambu Studio `.3mf` project, should clicking **"Apply to Recipe"** import only geometry-level settings (layer height, wall count, top/bottom shells, infill density, support enablement) while ignoring vendor temperatures/speeds, or also map speeds and temperatures when the filament type (`PLA`/`PETG`/`ABS`/`ASA`) matches?
