# Parallelism inventory (no merge)

Measured on this VM: 4 cores, `rustc 1.88`, `cargo test -p lime-slice-core --release` (`lto = "thin"`, `codegen-units = 1`). `rayon::current_num_threads()` is 4. No custom pool.

The README hull-toughness slice is 675 ms on the bench machine. The same path is **3.84 s** here. Rank by share of this run. Absolutes will move with the CPU; the split will not.

No smoke PR. The independent per-layer loops are already `par_iter`. Wrapping them again does not buy milliseconds.

## Ranked

**P0 — none.** On 4 cores the slice is not waiting on an unthreaded layer loop. Contours, roof tests, per-layer toolpaths (walls, infill, clipper offsets, travel reorder, scarf, toolpath overhangs), support overhang classification, and 3D-gyroid sampling already run in rayon. That layer phase scales **3.8–4.0×** (CPU sum ÷ wall). The slowest single layer is 5–7% of that wall, so a second parallel split inside the layer does not move the 4-core clock.

**P1 — G-code string, ordered per layer.** The only engine stage that is still a big serial chunk *and* is data-parallel with a defined reduce. Arc fitting is not the cost (hull toughness, arcs on vs off: core **3819 ms vs 3842 ms**). The ~200 ms is the writer: `format!` into one `String`, plus lookahead.

**P1 — preview bead mesh in the geom worker.** Off the slice clock, on the time-to-3D-view clock. A synthetic copy of `pushBead` (same quad count, `number[]` pushes) took **2.3 s for 497k segments**, which is the hull-toughness preview point count. The real worker was not timed. Frames are already fine: color, hide, and playback do not rebuild the mesh.

**P2 — everything else below.** Either the grain is too fine, the scan is ordered by a nozzle or a trunk, the stage is already off the UI path, or the measured cost is under ~30 ms.

## What this machine spent

Engine time is plan + G-code (`core_ms`). Preview JSON is extra, after `core_ms`, and the UI pays it (`includePreview: true`). `baseline: false` on the UI path, so the second slice is not in these rows.

| Case | Layers | Toolpaths wall (sum) | Seat | Supports | G-code | Preview JSON | Engine ≈ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cube speed | 100 | 8 (29) | 0.4 | 0.5 | 2.3 | 0.8 | ~12 ms |
| Cube toughness | 100 | 298 (1141) | 0.5 | 0.5 | 40 | 5.7 | ~345 ms |
| Hull speed | 140 | 63 (248) | 7.0 | 3.8 | 13 | 2.2 | ~100 ms |
| Hull toughness | 140 | 3585 (13934) | 11 | 3.9 | 225 | 33 | **3.84 s** |
| Dragon speed | 161 | 1296 (5125) | **837** | **761** | 201 | 26 | **3.21 s** |
| Dragon toughness | 161 | 2147 (8351) | **862** | **1001** | 280 | 33 | **4.4 s** |

Toolpath speedup (sum ÷ wall): cube toughness 3.83×, hull toughness 3.89×, dragon speed 3.95×. Slowest layer: hull toughness **263 ms** of a 3585 ms wall; dragon speed **63 ms** of 1296 ms.

Dragon is 37 986 triangles, 151 × 99 × 32 mm, up to 28 loops on a layer. Hull is 4800 triangles and one loop per layer, so island support and combing stay cheap there. Cube is 12 triangles.

## P1 brief — G-code ordered reduce

**Scope.** `emit_gcode` walks layers on one `Writer`. Lookahead already stops at the layer boundary: `layer_header` calls `close_layer` → `flush_motion`, then `has_dir = false`. Time math does not cross layers. Filament `E`, fan, accel, pressure advance, retract state, and the nozzle XY do.

**Measured.** Hull toughness **225 ms** and **9.3 MB** (187k extrusion moves, 100k arcs). Dragon speed **201 ms** and **14.1 MB**. Cube toughness **40 ms**. That is **6%** of hull toughness and dragon speed, **12%** of cube toughness. Turning arc fit off did not change hull-toughness `core_ms`, so do not parallelize `fit_arc` by itself.

**API.** Fit and format each layer into a fragment with local `E` starting at 0: text, `e_delta`, feature seconds, bounds, counts. Fold fragments in layer index order, adding the `E` prefix. Replay fan / accel / PA from the previous fragment’s end state so those lines stay byte-identical. Travel from the previous layer’s last XY stays in the fold, not in the parallel task.

**Determinism.** Ordered fold. Same G-code bytes, not a “close enough” estimator. Prove with `tools/golden.sh` on the small samples and one dragon pair (`GOLDEN_DRAGON=1`) for speed and toughness.

**Bench.** `core_ms` and emit-only milliseconds on dragon / hull / cube, speed and toughness, arcs on. Target: hull toughness emit 225 → well under 120 ms. If the fold of the `String` dominates, stop; the win is gone.

**Risk.** A missed carry (retract still down, `M204` elided, PA scale) changes bytes without changing the toolpath. Do not parallelize the `Writer` in place.

## P1 brief — bead mesh, per layer, then concat

**Scope.** `src/geom-worker.ts` decodes columnar paths and `buildPreviewGeometry` walks every segment on one worker. `pushBead` emits five quads per segment (four margin faces + one top face) via `number[]` spreads. The main thread only uploads the buffers (`view3d.setBuffers`). Shader uniforms cover color and hidden kinds. Playback moves one segment.

**Measured.** Rust `preview_of` is **9–13 ms** even on dragon. JSON for the preview columns is **33 ms / 9.9 MB** (hull toughness) and **26 ms / 7.2 MB** (dragon speed). The synthetic bead loop, same vertex pattern as `pushBead`:

| Segments | Time | Float64 heap |
| ---: | ---: | ---: |
| 36k (hull speed order) | 166 ms | 52 MB |
| 408k (dragon speed preview points) | 2.1 s | 588 MB |
| 497k (hull toughness preview points) | 2.3 s | 716 MB |

This is not a trace of the real worker (no `decodePaths`, no travel lines, one polyline). Treat 2 s as an upper bound that says the builder can dwarf the slice on a dense gyroid.

**API.** One task per preview layer, writing a `Float32Array` it sized itself. Concatenate in layer order. Assign kind slots in a first pass over kind names, or merge slot tables in order, so hiding “thin wall” still leaves gap fill drawn.

**Determinism.** Geometry only. Vertex order within a layer stays path order. G-code is untouched.

**Bench.** Time `buildPreviewGeometry` in the worker on hull toughness and dragon speed, before and after. Also time `JSON.parse` of the preview body once; it is in the slice worker today and should be a few tens of milliseconds, not seconds.

**Risk.** A parallel `number[]` version that still spreads will GC harder and may not scale. Pre-sized typed arrays are part of the same PR, or the parallel version will not win.

## P2 — do not staff these first

### Cross-layer seam and comb (`seat_layer_start`) — 837 ms on dragon speed

**26%** of the dragon speed engine, **7 ms** on hull speed. The cursor starts this layer where the previous layer ended, then walks paths in order. That order is the G-code. A `par_iter` over layers changes seams and travels.

The z-hop inset (`offset_loops` of every contour, **78 ms** on dragon, **7 ms** on hull) does not depend on the cursor. It is also mostly dead on a speed slice: `ZHopMode::Blend` resolves to off for speed paths, and `apply_z_hop` still receives the offset. A guard beats a thread pool. Measured hop application after the offset is **4–6 ms**.

### Organic support walk — serial on purpose

`build_supports` already parallelizes `overhang_at` and the XY-gap offset. The downward walk is one layer at a time because trunks, interface generations, and merges depend on the layer above.

Dragon speed, supports checkbox **off** (island support is hardcoded on in `SliceSettings::from_request`):

| Piece | ms | Threads |
| --- | ---: | --- |
| Overhang / island classify | 123 | rayon, already |
| Gap offset | 13 | rayon, already |
| Interface booleans | 30 | serial in the walk |
| Generation trim | 22 | serial in the walk |
| Disks + uncovered-interface seed | 96 | serial |
| `propagate_nodes` | 259 | serial |
| `settle_disks` | 17 | serial, bottom-up |
| `drop_unfooted_interface` | 155 | serial, bottom-up |
| **Total** | **761** | |

Dragon toughness walk is heavier (`propagate_nodes` **392 ms**, drop **197 ms**, 238 branches). Hull stays at **~4 ms** because nothing is in the air. Turning the supports checkbox on for dragon speed changed the total by **~5 ms** (767 vs 762). The island walk is the cost, not the overhang toggle.

`propagate_nodes` is the only piece that looks data-parallel: per-node lean and `push_out`, then `merge_nodes` sorts by id. Grain is ~145 nodes and **1.6 ms/layer**. A `par_iter` per layer, called from a serial Z loop, can lose to spawn overhead. Prototype `par_chunks` on dragon and keep the merge sorted by id. If the wall does not drop by ≥100 ms, delete it.

`settle_disks` and `drop_unfooted_interface` read the layer below. Leave them serial.

### Region and layer blends — already inside the layer `par_iter`

Hull, first run, same 4 threads:

| Blend | Toolpath wall (sum) | Slowest layer | G-code |
| --- | ---: | ---: | ---: |
| Speed | 63 (248) | 6 ms | 14 ms |
| Layer | 1184 (4351) | 318 ms | 83 ms |
| Region | 921 (3633) | 58 ms | 112 ms |
| Toughness | 3539 (13785) | 256 ms | 225 ms |

Region is two `plan_region` calls per layer (toughness on the low side of the cut, speed on the high side) plus `merge_split_outers`. They share a seam hint, low side first. Parallelizing the pair changes the high side’s seam and nests inside a pool that is already at 4×. Dragon region toolpaths were **621 ms** wall, with the same **~950 ms** serial seat as speed. There is no separate “resolve” pass worth threading. `interior_remainings` is **0.01 ms**.

### Adaptive bands

`plan_bands` is a serial Z walk: this layer’s height is the min facet recommendation above the previous floor. Hull with adaptive on: **0.50 ms** to build bands (fixed height is 0.05 ms). Dragon was not re-run; it is an 8× triangle count on a short mesh, still single-digit milliseconds. `facets_of` is the only independent loop, and it is lost in that 0.5 ms.

### Overhangs on the toolpath

`apply_overhang` (slow spans, bridges, fan) runs inside the layer `par_iter`. Support `overhang_at` is its own `par_iter`. Neither needs another wrapper.

### Estimators

Print time and filament are produced inside `emit_gcode` (lookahead flushed per layer). There is no second estimator pass on the UI slice. `structural_mm3` and seam metrics sit after `core_ms` and are small next to preview JSON.

`pareto_estimates` already does `points.par_iter()` over five full slices. `compare_estimates` runs four full slices in a `for` loop and is off unless `compare: true` (UI sends false). If that flag starts getting used on hull toughness, those four are ~15 s serial and should use the same `par_iter` as Pareto. Not before.

### Mesh load / decode

Dragon STL load + bed settle: **0.7 ms**. `ZIndex::build` (weld + Z buckets): **3.5–3.9 ms**. The UI parses binary STL on the main thread (`parseStl`) and `computeVertexNormals` on upload. Same order of magnitude as the load, not as the slice. A pool does not matter until meshes are much larger than 40k triangles.

### Second slice

Still in the tree, not on the UI path.

`slice_configured` plans and emits again with `BlendMode::Single { strategy: Speed }` when `settings.baseline` is true, then drops the G-code (`_baseline_gcode`). `SliceSettings::default()` sets `baseline: true`. The CLI `slice` command fills settings with `..Default::default()`, and `bench` uses `SliceSettings::default()` directly. `core_ms` does **not** include it. Wall clock does.

| | Wall | `core_ms` | Second slice |
| --- | ---: | ---: | ---: |
| Cube speed | 26 ms | 12 ms | 14 ms |
| Hull speed | 204 ms | 98 ms | 106 ms |

The UI sends `baseline: false` (`src/main.ts`). Serve honors that flag. Do not parallelize the duplicate. Gate the default, or the bench keeps paying a full speed slice that the printed “slice ms” hides.

### Infill per island, gyroid nesting

Infill, lightning, 2D gyroid, and 3D gyroid all run inside `build_layer` on the layer `par_iter`. `gyroid::section` also `par_iter`s the sample grid and the marching rows. That is nested rayon. The outer loop still hit ~4×, so the nesting is not the bug on this box. A third level (islands inside an already-parallel layer, on a mesh whose fattest layer is 63–263 ms) adds tasks and does not shorten a 4-core wall.

Dragon’s 28 loops are not 28 equal islands of work. The hull has one loop. Per-island `plan_region` would also have to concatenate paths in a fixed order or the travel optimizer and G-code change.

## Already parallel — leave it

| Work | Where | Independence | Notes |
| --- | --- | --- | --- |
| Contour cut | `plan`: `bands.par_iter().map(\|band\| index.slice(cut_z))` | Layer Z | `contour_times` is the same cut, used by `bench`. Dragon speed **4.9 ms** after a **3.9 ms** serial index build. |
| Roof flags | `roof_distances` `into_par_iter` | Layer, reads the layer above | Dragon **20 ms**. The distance prefix scan after the flags is serial and tiny. |
| Walls, infill, gap fill, variable width | `build_layer` → `plan_region` inside `bands.par_iter` | Layer | The 93% of hull toughness. |
| Travel reorder, toolpath overhangs, scarf | Same `par_iter`, after `build_layer` | Layer | Scarf and overhang do not use the cross-layer cursor. |
| Support overhang + island classify, XY gap | `build_supports` `par_iter` | Layer | Dragon classify **123 ms**. |
| 3D gyroid grid | `gyroid::section` | Grid rows, inside the layer task | Nested. Do not add another `par_iter` around it. |
| Pareto | `pareto_estimates` `par_iter` | Whole slice × 5 toughness values | Five independent slices. Output order follows the point list. |
| Audit | `audit_slice` `par_iter` | Layer | Only `--audit` / tests. Not the UI slice. |
| HTTP | `serve` `thread::spawn` per request | Request | One slice does not fill two cores by itself. Cancel still works because the accept loop is free. |
| UI | slice worker, geom worker, Tauri `spawn_blocking` | The request | The main thread is not inside `plan`. |

`par_iter().collect()` keeps layer index order. That is why the existing parallel slices match golden G-code. Any new parallel task has to collect in that same index order or fold in that order.

## Candidate index

| Candidate | Unit | Serial cost on this VM | Threads today | Hazard | Honest win |
| --- | --- | --- | --- | --- | --- |
| Per-layer contour | Layer | Dragon 5 ms, hull 2 ms | Rayon | `ZIndex` is immutable here | Already taken |
| Clipper inside the layer (walls, infill clip) | Layer | Inside the 1.3–3.6 s toolpath wall | Rayon over layers | Clipper owns its polygons per call; this is already how the code runs | Do not double-wrap |
| Infill / gyroid | Layer, and grid rows inside 3D gyroid | Most of hull toughness toolpaths | Both | Nested rayon; seam hint is per layer | ~0 on 4 cores. Scales with more cores until the fattest layer (hull toughness **263 ms**) |
| Island split of `plan_region` | Island | Unknown; max 28 loops on dragon | None inside the layer | Path order, seam hint | Unlikely past the fattest-layer gap (dragon speed max 63 vs mean ~32 ms) |
| Support classify | Layer | Dragon 123 ms | Rayon | Reads only that layer and the one below | Already taken |
| Tree growth | Node, then layer below | Dragon speed prop **259 ms**, disks **96 ms** | Serial walk | `merge_nodes` is order-sensitive unless sorted by id; Z is a chain | Maybe ~100 ms, maybe nothing. Bench before writing it |
| `settle_disks` / drop unfooted | Layer vs layer below | 17 + 155 ms dragon speed | Serial | Footing is the previous layer | Leave serial |
| Adaptive bands | Facet, then previous floor | Hull 0.5 ms | Serial | Next Z depends on this height | Not a slice win |
| Toolpath overhangs | Layer | Inside toolpath wall | Rayon | Lower contour is read-only | Already taken |
| `optimize_travel` | Paths in one layer | Inside toolpath wall | Rayon over layers | Greedy nearest-neighbor; order is the result | Already per layer |
| `seat_layer_start` | Path, cursor from previous layer | Dragon **837 ms**, hull **7–11 ms** | Serial | This *is* the seam order | Not data-parallel. Faster comb, or accept different G-code |
| Z-hop inset | Layer | Dragon **78 ms** | Serial, and independent | None if gathered before the cursor walk | Skip the offset when no path can hop. A pool saves under 80 ms |
| Estimator | Layer chain, flushed per layer | Inside G-code ms | Serial writer | Feature totals are a sum | Fold with the G-code reduce. No third pass |
| G-code text | Layer fragment, then `E` prefix | Hull tough **225 ms**, dragon speed **201 ms**, cube tough **40 ms** | Serial | Fan, accel, PA, retract, start XY | **~100–150 ms** if the string scales. See P1 |
| Mesh STL / index build | Triangle | Dragon load 0.7 ms, index 4 ms | Serial | Weld map | Under 5 ms |
| `preview_of` + JSON | Layer | 10 ms + 26–33 ms | Serial | Kind dictionary while streaming | Tens of ms. Not the bead mesh |
| Bead extrusion | Segment, per layer | Synthetic **2.3 s** at hull-toughness point count | One worker, off the main thread | Kind-slot ids | Up to ~1 s off the time-to-3D, if the real worker matches the synthetic loop |
| Second baseline slice | Whole extra speed plan + G-code | Hull speed **+106 ms** wall, **0** in `core_ms` | Serial, UI off | None: it is thrown away | Delete or stop defaulting it on. Do not parallelize |
| `compare_estimates` | Whole slice × 4 | Off by default. Hull toughness would be ~4 × 3.8 s | Serial `for` | None if ordered like Pareto | Only if the flag is turned on |
| Region low/high | Two regions per layer | Inside the region toolpath wall (hull **921 ms**) | Layers already parallel | Shared seam hint | Do not split the pair |

## How the numbers were taken

A temporary `STAGE_PROFILE` test in `lime-slice-core` (not in this PR) called the same functions as `plan` / `plan_contours` and timed each stage. Layer milliseconds are the closure duration, summed across cores; the wall column is the `par_iter`’s elapsed time. Support sub-times were `Instant`s inside `build_supports`. Arc-on vs arc-off was two `slice_configured` calls. The bead loop was a Node script with the same five-quad pattern as `pushBead`. Settings match the UI: baseline off, compare off, adaptive off except one hull run, tree style, gyroid blend, scarf blend, travel opt on, overhang control on. Release, 4 threads.
