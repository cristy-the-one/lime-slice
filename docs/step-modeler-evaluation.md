# Editing STEP, beside the slicer

Ship a history-free editor on Open CASCADE Technology 7.9, dynamically linked, in a new native crate. The slicer keeps the mesh it already slices. `crates/lime-slice-core` stays as it is, truck included, and stays the reader of an untouched STEP file.

Sketch and extrude can follow on that same kernel. A constraint solver and a feature tree are a different product. They are not on this roadmap.

Effort below is a rough engineering estimate, not a schedule. Each one is uncertain until someone has built OCCT into this release matrix.

## What a STEP file does today

Opening a `.step` or `.stp` does not send the STEP file to the planner. `adoptBytes` calls `previewRemote` (`src/app/files.ts`). Inside Tauri that is the `preview_mesh` command (`src-tauri/src/lib.rs`). In the browser it is `POST /api/mesh` (`crates/lime-slice/src/main.rs`). Both call `mesh_preview_tol` (`crates/lime-slice-core/src/load.rs`), which calls `load_step` (`crates/lime-slice-core/src/step.rs`) and seats the mesh on Z = 0. The positions become `sourcePos`.

`load_step` tessellates with truck (`truck-stepio` 0.3, features `in` and `derive`, `truck-meshalgo` 0.4, `truck-topology` 0.6). It reads planes, cylinders, cones, spheres, tori, and NURBS, applies file units and assembly placements, and merges every closed solid into one triangle mesh. Open shells, faceted breps, and AP242 tessellated solids are rejected. The chord defaults to 0.1 mm and is clamped to 0.01–2 mm (`STEP_TOLERANCE_DEFAULT_MM`, `STEP_TOLERANCE_MIN_MM`, `STEP_TOLERANCE_MAX_MM`). The Prepare field and Add object use that same chord (`docs/plate-distinct-objects.md`).

Once `sourcePos` exists, a slice does not read the STEP again. `meshBytes` encodes `scaledCanonical(sourcePos)` as an STL (`src/app/files.ts`). The request renames `.step` / `.stp` to `.stl` (`ownMesh` in `src/app/slice-run.ts`, `slicePlateFields` in `src/plate.ts`). The engine loads that STL and applies `pose` afterwards. Scale is already in the vertices.

Add object runs the same preview and parks a new `PlateObject` (`addMeshBytes`). A `.lime` project stores each object's original bytes (`src/project.ts`, `fileObjects` in `src/app/project-io.ts`). Open previews a STEP through truck again. STL opens through `parseStl`, which also seats the mesh on Z = 0.

Placement undo does not snapshot triangles. `snapPlate` records the pose, paint, and settings. `hold` keeps one geometry slot per object id (`src/plate.ts`). `EditSnap` in `src/app/history.ts` stores that plate snap, not the mesh bytes.

The app is MIT (`Cargo.toml`). The desktop shell is Tauri 2 (`src-tauri`). Release builds are an unsigned deb and AppImage, two macOS dmgs (Apple silicon, and Intel cross-compiled on the Apple silicon runner), and a Windows NSIS installer (`.github/workflows/release.yml`). CI tests on Ubuntu only (`.github/workflows/ci.yml`). The window is desktop first. The phone layout is the same UI at `?layout=compact`, and the default Prepare canvas stays at 70% or more (`README.md`, `src/ui/splitters.ts`).

## The boundary

The modeler is a session beside the plate. It reads STEP, edits a B-rep, and writes two results:

- Positions, seated on Z = 0 the way `mesh_preview_tol` and `parseStl` already seat a mesh. Those positions replace `sourcePos`. `encodeStl` and the `.stl` rename then feed the slicer with no change to `load_step`, `load_slice_mesh_tol`, or the planner.
- A STEP document, kept for the next edit and for export. The slicer does not read it.

On the first committed edit, the object's `fileName` becomes an `.stl` name and its stored bytes become that STL. `isStepName` then hides the STEP chord, so `refreshStepPreview` cannot send the edited file back through truck. Further chord changes re-tessellate in the modeler at the same 0.01–2 mm range. The number lives on the object (`stepTolerance`). The modeler copies it. It does not import a new API from the core.

`crates/lime-slice-core` is not modified. Truck stays the preview tessellator of an unedited STEP file. A new crate, called from the Tauri shell the way `preview_mesh` is called, and from a new route on the `lime-slice` serve binary for the browser path, owns the session. That serve route is process wiring. It does not call `slice_payload`.

An edited STEP must not be handed to `load_step`. Truck rejects faceted brep and AP242 tessellation, drops surfaces outside its list, and merges solids. OCCT booleans leave trimmed B-splines and seams. `step.rs` already has special cases for Creo edges that miss a face by microns. Round-tripping an edit through that reader would make the slicer depend on a second kernel's writer. The triangles are the contract.

## Kernels

| Kernel | License | STEP read / write | What it actually edits | Fit |
| --- | --- | --- | --- | --- |
| OCCT 7.9 | LGPL-2.1 with the Open CASCADE exception 1.0 | AP203, AP214, AP242. Writer schema is `write.step.schema` (AP214CD, AP214DIS, AP214IS, AP203, AP242DIS). | B-rep: boolean, fillet, chamfer, primitives, defeaturing, transform. Direct face edits fail on some imports. | The kernel to ship. |
| truck 0.3 / 0.4, as linked here | Apache-2.0 on the crates in `Cargo.lock` and on [ricosjp/truck](https://github.com/ricosjp/truck) | `truck-stepio` reads and writes Part 21. This tree enables `in` only. No AP schema switch. | `truck-shapeops` 0.4.0, not a dependency, exports `and`, `or`, and healing. Its public `lib.rs` has no fillet. | Stays the slicer's reader. |
| Fornjot | 0BSD. The GitHub repo is archived. | No production STEP. | Code-CAD, early B-rep. The author called it too early for a CadQuery-class kernel ([discussion 2317](https://github.com/hannobraun/fornjot/discussions/2317)). | Out. |
| Manifold | Apache-2.0. A pure-Rust port exists. | No STEP. | Robust mesh booleans on manifold triangles. | A mesh cutter, if that is ever a separate feature. |
| CadQuery, build123d | Apache-2.0 for the Python. OCP bundles OCCT, so the binary is LGPL-2.1. | Whatever OCCT does. | Code-CAD on a dumb imported solid. | A prototype sidecar, not the app. |
| Parasolid, ACIS | Commercial (Siemens, and Spatial / Dassault). Price is not published. | The industry STEP stacks. | Full B-rep. | No redistribution path for an MIT app. |
| opencascade-rs | The wrapper is the crate author's license; it links OCCT, which stays LGPL-2.1. | STEP viewer (`--step-file`). README still says the bindings are a work in progress. | A subset of modeling, aimed at code-CAD. | A map of which `TK*` libraries to link. The UI calls a small facade. |

Sources for the license lines: [OCCT 7.9 public license](https://dev.opencascade.org/doc/occt-7.9.0/overview/html/occt_public_license.html), [`OCCT_LGPL_EXCEPTION.txt`](https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt), crates.io for `truck-stepio` 0.3.0 (Apache-2.0, published 2024-09-20), Fornjot's repository status, [planegcs](https://pypi.org/project/planegcs/) for the solver in tier 3. The brief's "Apache/MIT" for truck does not match the crates this repo links. An MIT grant was not found on them.

OCCT is the only open kernel here that already reads the STEP variants truck rejects, writes a solid another CAD system will open, and has fillet, chamfer, boolean, and defeaturing as real APIs (`BRepFilletAPI_MakeFillet`, `BRepFilletAPI_MakeChamfer`, `BRepAlgoAPI_Fuse` / `Cut` / `Common`, `BRepAlgoAPI_Defeaturing`, `BRepPrimAPI_*`, `BRepBuilderAPI_Transform`, `BRepMesh_IncrementalMesh`). Those calls still return failure on imported geometry. CadQuery's fillet bugs are OCCT returning not-done when edges meet, including a cube fillet of exactly half the edge length. Defeaturing removes some blends and cylindrical holes and leaves the rest. A face push on a trimmed NURBS import is the operation most likely to fail. The editor has to show that failure and leave the solid unchanged.

truck's own policy note ([issue 121](https://github.com/ricosjp/truck/issues/121), April 2026) says the library is not an end-user CAD system by wrapping, and that fillet robustness is a property high-level operations still have to earn. Building tier 1 on `truck-shapeops` would mean writing the fillet, the STEP schema writer, and the healing this tree already special-cases, inside a second kernel, while the core continues to vendor the 2024 crates. That is a new slicer-adjacent kernel. It is the long way to a worse STEP writer.

Fornjot is archived. Manifold never sees a face. A Python sidecar pulls an OCP wheel that the maintainers described as about 88–185 MB per platform when they asked PyPI to raise the file limit (that range was not re-measured for this note). Parasolid or ACIS would raise STEP fidelity and cannot be shipped under MIT without a contract that allows it. No such contract is assumed.

`opencascade-rs` links the libraries a modeler needs, including `TKDESTEP`, `TKFillet`, `TKBool`, `TKBO`, `TKOffset`, `TKMesh`, and `TKXCAF`. Its default build compiles OCCT from source and links it statically, which the maintainers describe as a multi-gigabyte link. Dynamic linking is a feature flag and drops the example binary to a few hundred kilobytes plus the shared libraries. Use the flag and the library list. Keep the session API local, so a binding gap does not become the product.

## Three tiers

**Tier 1, direct edits on an imported solid.** The file has no history. The user picks a face or an edge and asks for one operation. Undo is a checkpoint of the solid, replayed from the import if we ever want a smaller log. This is what SpaceClaim-style editing is, and what FreeCAD's Part workbench does with the same kernel.

The operations, and the honest version of each:

| Ask | OCCT already has | What to expect |
| --- | --- | --- |
| Measure distance, edge length, face area, volume | `BRepExtrema`, curve length, `BRepGProp` | Reliable. Ship with the session. |
| Boolean with a box, cylinder, sphere | `BRepAlgoAPI_*` plus `BRepPrimAPI_*` | The useful subset. Failure is a kernel error, shown, solid unchanged. |
| Fillet, chamfer | `BRepFilletAPI_*` | Works on clean edges. Fails when fillets collide. Same kernel limit FreeCAD and CadQuery hit. |
| Hole | A cylinder cut | A new hole. Changing an existing hole's diameter is defeaturing plus a new cut, and recognition is partial. |
| Push-pull, move face, delete face | Offset, `BRepFeat`, defeaturing, sewing | The long tail. Some faces move. Many imported faces do not. |
| Split or cut with a plane | `BRepAlgoAPI_Splitter` | Two solids can become two plate objects through the existing add path. |
| Scale the solid | `BRepBuilderAPI_Transform` | Uniform scale of the B-rep. The plate's `partScale` stays the placement scale. Applying both would scale twice. A non-uniform scale turns analytic faces into B-splines. |

A first shippable slice is measure, primitive booleans, fillet and chamfer that can fail visibly, a cylinder hole, uniform scale, and a plane split. Push-pull and delete-face land in the same phase behind the same failure rule. They do not block the rest, and they do not get a mesh-boolean fallback. A mesh fallback would look like success and destroy the B-rep the next edit needs.

Estimate: large. On the order of one engineer for a quarter after the session in phase 1 exists, longer if fillet failures turn into special cases. Uncertain. The tail of "move any face on any import" does not close.

**Tier 2, sketch, then extrude or revolve.** `BRepPrimAPI_MakePrism` and `MakeRevol` are the kernel part. The work is a sketch plane on the viewport, lines, arcs, and circles with typed dimensions, a closed profile, and a preview. No constraint solver. Dimensions are numbers the user typed. This is a modeler people can design a bracket in, on top of tier 1.

Estimate: large, and it is mostly UI. On the order of another quarter after tier 1's booleans exist. Uncertain.

**Tier 3, parametric history and a constraint solver.** A sketch solver exists: FreeCAD's PlaneGCS, extracted as [planegcs](https://pypi.org/project/planegcs/), LGPL-2.1-or-later, two-dimensional. SolveSpace itself is GPL-3.0. Linking GPL-3.0 into this MIT app forces the combined work under GPL-3.0. PlaneGCS can be dynamically linked the same way OCCT is. It solves a 2D sketch. It does not solve 3D constraints, and it does not answer which face a later fillet refers to after the sketch is edited. That naming problem is what FreeCAD and SolveSpace have spent years on. A feature tree without it replays onto the wrong face.

Tier 3 is not scheduled. Calling it a year would be a guess that hides a product. It is several years of kernel and UI, and it is not required to edit an imported STEP file.

## Where it runs

Native, in-process, on a blocking thread, the way `pareto_model` already uses `spawn_blocking`. One OCCT shape is owned by one queue. Parallel modeling on that shape is not part of the design. Which OCCT 7.9 algorithms are re-entrant across two shapes was not established here.

The desktop app already runs offline. The modeler does too. The browser dev path keeps using localhost `lime-slice serve`, with one new route. The phone layout does not get a second engine.

WASM is the other place OCCT runs. [opencascade.js](https://ocjs.org/docs/getting-started/file-size) documents a full build of 48.9 MB of wasm, about 9.1 MB with Brotli, and a custom build of 7.1 MB (2.4 MB compressed) that drops modules. A third-party build (`occt-wasm`) claims 20.3 MB raw, 6.4 MB gzip, 4.3 MB Brotli, pinned to an OCCT 8.0 release candidate. That size claim is theirs. OCCT 7.9.2 is the line to pin. A release candidate is a different kernel.

WASM stays off the shipping path. Modeling is interactive, the shell is already a native process, and a worker plus pthreads means `SharedArrayBuffer` and cross-origin isolation in the webview. A forum report of `TransferRoots` taking most of a minute on one part is a single anecdote, not a benchmark. It is enough to refuse WASM as the default without a measurement we have not made.

Installer weight was not measured on a Lime Slice bundle. The official OCCT 7.9.2 Windows archive of the shared libraries (`opencascade-release-no-pch.zip`) is 51.2 MB compressed. The modeling subset is most of that list. Uncompressed size on disk will be larger. The delta on the deb, AppImage, dmg, and NSIS installer is unknown until a build exists.

CI grows when the crate lands, not with this note. Compiling OCCT inside `build.rs` on every clean runner is the cost to avoid. Pin a prebuilt per target. The sharp edge is the existing Intel macOS cross-compile from the Apple silicon runner (`.github/workflows/release.yml`). Ubuntu CI (`.github/workflows/ci.yml`) should consume the same pin, not configure OCCT from source on each pull request. `cargo test --workspace` of `lime-slice-core` stays a Rust test.

## The Model workspace

`setStage` is `"prepare" | "preview" | "gcode"` (`src/app/viewer.ts`). The tabs are Prepare, Preview, and G-code (`src/app/markup.ts`). Model is a fourth stage, desktop first, on the same canvas. It is not a second window and not a panel that shrinks the view.

The 70% rule stays. Above 1200 px the results panel already starts folded so the viewport is at least 70% of the width (`src/ui/splitters.ts`). On a phone the sheet peeks at 56 px and the default Prepare canvas stays at 70% or more. Model tools are a short icon row and a numeric field in the existing sheet. A feature tree does not exist in tier 1, so none is drawn.

The prepare gizmo is an 88 px screen-constant widget (`GIZMO_SCREEN_PX` in `src/gizmo-math.ts`) for moving the part. Model push-pull is one arrow and a number, in millimetres, with the same 0.1 mm fine step the placement scrub already uses (`src/app/place-scrub.ts`). The plate move, rotate, and `partScale` stay on Prepare. Model scale, if it is offered, writes a new solid and resets `partScale` to 1 so the part is not scaled twice.

Picking hits the tessellation, then a face or edge id the modeler returned with that mesh. The id dies at the next commit. Triangle indexes are the wrong identity for the same reason paint refuses them: a re-tessellation builds new triangles (`docs/multi-object-and-support-painting.md`). The prepare view's `sourcePos` stays a flat position buffer. The model stage keeps its own face channel. The slice never sees it.

Box callouts, the scale bar, and the bed numbers stay (`src/measure.ts`). Kernel measure is distance, length, area, and volume, drawn as one readout, not a second overlay system.

Undo of an edit is a stack of B-rep checkpoints in the session. It does not push STEP bytes into `EditSnap`. On commit, the new positions replace `sourcePos`, `hold` is updated, and placement undo keeps using the one geometry slot it already has. Undoing the edit restores the checkpoint, the positions, and that slot.

A committed edit clears support paint, seam paint, and support edits on that object. Those disks live in the source mesh frame and refer to a surface that just moved. One model-undo step restores the solid and the disks together. The pose stays.

An assembly stays one plate object. Truck already merges it, and the plate has no named STEP components (`docs/roadmap.md`). A plane split that yields two solids can add the second through the existing add path. That is the deferred "cut to two bodies" row, done with a kernel split instead of a mesh boolean. The viewer's section plane stays a view.

## Save

Export STEP writes AP214 IS, a manifold solid brep, via `STEPControl_Writer` and `write.step.schema`. AP203 is a second schema if a receiver asks. AP242 tessellation is the encoding `load_step` rejects, so it is not the export. Assemblies written back as one solid lose the component tree. Preserving XCAF names is a later option on `STEPCAFControl_Writer`, and the plate would still receive one tessellation until split-to-objects is a real feature.

The `.lime` file stays version 2. `applyMigrations` rejects a version newer than `PROJECT_VERSION`, so a version 3 file would not open in a build that is already shipped. `readPlateObject` ignores keys it does not know. An optional `brep` on the object (base64 STEP, length, hash, the same shape as `mesh`) is written when a session exists and omitted otherwise. This app's reader keeps it. An older build opens the project, slices the STL, and drops `brep` on the next save. The printed mesh survives. The ability to keep editing does not. That is the compatible choice.

While the session is open, `brep` is the document the Model tab reloads. The STL bytes are what `parseStl` reads if the process starts cold. Duplicate copies the STL today. It should copy `brep` too, or the copy is a dumb mesh.

## Licensing

OCCT is LGPL-2.1 plus [exception 1.0](https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt). The exception lets object code that incorporates OCCT header material be distributed under other terms, with a prominent notice. It does not replace LGPL section 6 for the library itself.

Section 6(b) is the path that fits this app: ship OCCT as shared libraries the user can replace with a compatible build. Section 6(a), static linking, means shipping object files so someone can relink. OCCT's own overview says a static bundle, or a store that prevents replacement, needs that relink material, and that a commercial license exists for anyone who wants out of the LGPL. A maintainer restated the paid static-link exception on [OCCT issue 244](https://github.com/Open-Cascade-SAS/OCCT/issues/244). The price is not published.

The MIT sources stay MIT. A thin C++ facade that only calls the library is a work that uses the library. Changes to OCCT itself would be LGPL and are not required. The About box names OCCT, links the LGPL text, and points at the exact tag that was shipped. The release stores that source. Whether an AppImage that bundles the `.so` still counts as 6(b) depends on the `.so` being replaceable. That should be checked against the AppImage layout before the first installer, not assumed.

WASM would statically link OCCT into one module. That is the 6(a) case, plus a webview that cannot relink. Another reason to stay native.

PlaneGCS, if a sketch solver is ever added, is LGPL-2.1-or-later and wants the same dynamic treatment. SolveSpace proper is GPL-3.0 and stays out. Manifold's Apache-2.0 would be fine for a later mesh tool. It is not a reason to put mesh booleans under the STEP editor.

## Risks

- Fillet, push-pull, and defeaturing fail on ordinary imports. A silent mesh fallback would ship a lie. The failure has to be the result.
- `hold` is one slot per object. A model commit has to update it, or placement undo revives the previous solid's positions under the new pose.
- Paint and support edits cleared on commit will surprise someone who filleted a painted part. One undo has to put them back.
- An older Lime Slice drops `brep` when it saves. The file format does not prevent that.
- OCCT on the Intel macOS cross build is unproven in this repository. A pin that builds on Linux and fails on that runner blocks the release job.
- Shared-library packaging on Windows (DLL next to the exe), Linux (rpath in the deb and the AppImage), and macOS (dylib in the dmg) is the work that makes LGPL real. A static `builtin` link is the mistake that looks simpler.
- Installer size is unknown until that package exists. Budget tens of megabytes compressed, from the 51.2 MB OCCT Windows archive, and measure.
- Two kernels means two STEP interpretations until the first edit. An unedited preview is truck. The modeler, once opened, may heal the solid differently before the user changes anything. Opening Model should not commit a tessellation. Commit happens on an edit.
- This note did not run OCCT against the repo's STEP samples. Fidelity claims above are the kernel's API and its known failure modes, not a measurement of the rear cover.

## Roadmap

**Phase 1. Session and handoff.** New crate. OCCT 7.9.2, dynamic, pinned per release target. Read AP203, AP214, and AP242 B-rep. Tessellate at the object's chord with `BRepMesh_IncrementalMesh`. Replace `sourcePos` only when the user commits an edit. Measure. Export of an unmodified import as AP214 IS, knowing the bytes will differ. No face edit yet. The core crate is untouched.

Estimate: large, on the order of a quarter, and a large share is the four installers and CI. Uncertain. Someone who has shipped OCCT spends less of that on the API and the same amount on the dmg cross-compile.

**Phase 2. Tier 1.** Booleans, fillet, chamfer, cylinder hole, uniform scale, plane split, push-pull and defeaturing behind a visible failure. Model stage, picking, one gizmo, its own undo. `brep` on the version 2 project. Paint and support edits cleared on commit. Duplicate copies `brep`.

Estimate: large, on the order of another quarter to half a year for the subset that fails cleanly. Uncertain. Open-ended if every failed face becomes a special case. The rule is to stop at the kernel error.

**Phase 3. Tier 2.** Sketch plane, typed dimensions, extrude, revolve. Desktop. The compact layout keeps the sheet and does not grow a sketcher.

Estimate: large as UI, on the order of a quarter after phase 2. Uncertain.

**Not scheduled.** Tier 3. PlaneGCS as a 2D solver under the sketch is a possible later addition inside phase 3's UI, and it still does not create a feature tree. Manifold, as a way to boolean an STL that never had a B-rep, is a different feature and a different note. Parasolid and ACIS are out. Replacing truck inside `lime-slice-core` is out.

## Review questions

1. Is OCCT 7.9.2, dynamically linked, in a new crate, the kernel to start from, with truck left as the reader of an unedited STEP file?
2. Is the handoff "replace `sourcePos`, let `encodeStl` feed the slicer, store STEP beside the mesh" the right boundary?
3. Should the object's file name become `.stl` on the first commit, so the chord control and `refreshStepPreview` stay on the truck path only for unedited STEP?
4. Is a visible kernel failure enough for fillet, push-pull, and defeaturing, with no mesh fallback?
5. Should a committed edit clear support paint, seam paint, and support edits on that object, restored together by model undo?
6. Is an optional `brep` on version 2 acceptable, given that an older build drops it on save and a version 3 file would not open there?
7. Should Model be hidden in the compact layout until phase 3, so the phone sheet does not grow a sketcher?
8. Should an assembly stay one plate object, matching today's merge, with a plane split as the way a second solid reaches Add object?
9. Is AP214 IS the export schema, with AP242 tessellation left out of the writer?
