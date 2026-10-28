# Plan: where slicing time goes, and what the GPU could do

Status: study, for review. Written 2026-10-28 against `main` at v4.1.0 (`d4b1c58`). This step changes no slicer behaviour. It adds timing clocks that are off by default (section 2), and the golden run is 60/60 identical to the stored run.

The owner wants GPU slicing, mostly because it "might allow for dynamic update of the sliced part": the sliced result would follow edits live. This document measures where the time goes first, then rates each stage for the GPU.

**The short answer.** About 70–80% of a slice is one serial loop: the travel tour that orders each layer's paths from where the previous layer ended. That loop runs on one core, and a GPU can't speed it up. The stages a GPU suits (contours, offsets, infill) already run on all 16 threads and take 0.7–2 s of a 9–12 s slice. GPU slicing would save at most about 1 s on the Telo cover. It would also break byte-identical G-code. The way to get dynamic updates is on the CPU:
- a speculative parallel tour, checked exactly against the serial result;
- per-layer reuse after local edits;
- a progressive preview that draws the toolpaths before the tour finishes.

## 1. Setup

| | |
|---|---|
| Machine | AMD Ryzen 7 PRO 8840HS, 8 cores / 16 threads, 60 GB, Radeon 780M (integrated) |
| Threads | rayon default, 16; no custom pool |
| Build | release (`lto = "thin"`, `codegen-units = 1`), `main` at `d4b1c58` plus the off-by-default clocks |
| Path | `lime-slice serve` over HTTP. This is the same `slice_payload_watched` the desktop's `slice_model` calls. The in-memory stage cache (`kept.rs`) is on, and there is no disk cache. |
| Requests | Built by the MCP `Session` (the app's `sliceRequest` builder), then replayed the way the app sends them: `meshRef` once the engine holds the mesh, and `previewBase` from the last reply |
| Profiles | Ideaformer IR3 V2 (belt, 45°, Klipper) with PETG and a 0.4 mm nozzle; Lime 220 (flat bed) with PETG and a 0.4 mm nozzle; app defaults otherwise (single Speed, 0.2 mm, supports off) |
| Parts | Telo cover (`20261009_Telo_cover.stp`) and rear cover (`20260916_rear_cover_12_88.stp`), both company files, read by path only. Nothing derived from them is kept. |

The Telo cover tessellates through Open CASCADE to **96,358 triangles**, the same count as the owner's last desktop slice of it. Without the OCCT bridge, the in-house STEP mesher gives 167,482 triangles. The rear cover gives 15,818 triangles. It does not fit across the IR3 belt as loaded, so it was turned 90° about Z there.

Cold means a fresh `serve` process. Warm means the same process right after the previous request in the edit sequence of section 4. Cold rows are the median of three runs, and the three agreed within 3%. No other build ran during the runs (each run logged `rustc`, `cargo` and `link` processes, and found none).

## 2. Instrumentation added (off by default)

`crates/lime-slice-core/src/inner_prof.rs` already had per-call clocks for the inner loops (infill patterns, void fill, ordering), switched by `set_inner_profile`. Nothing outside a test turned them on. This study adds:

- five clocks on the existing switch:
  - `load` (mesh decode and parse in `slice_request_inner`);
  - `tour layout` (the parallel `PartLayout::new` in `tour_part`);
  - `tour serial` (the serial per-layer tour in `tour_part`);
  - `preview` (building the preview or patch);
  - `reply json` (`to_value` and `to_string` of the reply in `slice_payload_watched`);
- `LIME_INNER_PROFILE=1` in the `lime-slice` CLI:
  - `serve` prints one `inner …` line to stderr per `/api/slice`, then resets;
  - `slice` prints it after the summary.

With the variable unset, each clock is one `AtomicBool` load. Golden (`tools/golden.sh`, six configs over the samples plus the rear cover and the Baby Dragon) is **60/60 identical** to the stored run of `020e1ff6`. Since then `main` changed `lime-slice-core` only in L1a, which was itself 60/60 identical. With `LIME_INNER_PROFILE=1` the run is also 60/60 identical.

A trap found on the way: when a golden binary sits next to `lime_model_occt.dll`, `lime_model_load::step_mesher()` picks up Open CASCADE, and the six STEP rows change. Run golden from a folder without the bridge, as the stored runs were.

## 3. Where a full slice goes

### 3.1 Telo cover, cold, through `serve`

| Stage | IR3 V2 belt | Share | Lime 220 flat | Share | Threads |
|---|---:|---:|---:|---:|---|
| Mesh load (STL from held bytes) | 1 ms | 0% | 1 ms | 0% | 1 |
| Z index + layer contours | 18 + 52 ms | 0.8% | 18 + 48 ms | 0.5% | 16 (cut CPU 0.60 s, 11.6×) |
| Roof distances (booleans) | 142 ms | 1.5% | 112 ms | 0.9% | 16 |
| Supports (off) | 152 ms | 1.6% | 154 ms | 1.2% | 16 |
| Toolpaths: walls, infill, skin, gap fill | 1,640 ms | 17.7% | 1,677 ms | 13.5% | 16 (CPU 25.1 s, 15.3×) |
| · walls (Clipper2 offsets), CPU sum | 1.13 s | | 0.79 s | | |
| · infill and void fill, CPU sum | 23.9 s | | 23.0 s | | |
| · · void cover / void booleans / skin, CPU | 5.6 / 4.7 / 1.0 s | | 6.3 / 4.9 / 1.4 s | | |
| · · infill pattern itself (lightning), CPU | 19 ms | | 70 ms | | |
| **Order: travel tour, seams, scarf** | **5,779 ms** | **62.2%** | **8,609 ms** | **69.1%** | |
| · layout (parallel) | 41 ms | | 38 ms | | 16 |
| · **tour (serial)** | **5,681 ms** | **61.2%** | **8,514 ms** | **68.3%** | **1** |
| · · of which infill ordering (`order_infill`) | 5,143 ms | | 7,675 ms | | 1 |
| Combing and z-hop | 369 ms | 4.0% | 1,051 ms | 8.4% | 16 |
| G-code emit (text deferred) | 58 ms | 0.6% | 51 ms | 0.4% | 1 |
| Rest of `coreMs` (join, estimate, belt output) | ~250 ms | 2.7% | ~190 ms | 1.5% | |
| **`coreMs`** | **8,461 ms** | | **11,916 ms** | | |
| Preview build | 135 ms | 1.5% | 73 ms | 0.6% | 1 |
| Reply JSON (serialise) | 322 ms (55.0 MB) | 3.5% | 230 ms (36.5 MB) | 1.8% | 1 |
| Request decode, HTTP, client `JSON.parse` | ~370 + 196 ms | 6.1% | ~250 + 140 ms | 3.1% | 1 |
| **Wall, request to parsed reply** | **9,284 ms** | 100% | **12,463 ms** | 100% | |

The shares are of the wall time. Thread use: the slice spends about 32 s of CPU in 8.5 s on the belt, an average of 3.8 busy threads out of 16. The parallel stages saturate the CPU, at 11–15×, and then the tour runs on one core for two thirds of the wall.

The owner's last desktop slice of this part (IR3, 96,358 triangles, the same layer count, a different filament) took 9.29 s: order 6.11 s, toolpaths 2.05 s, contours 51 ms. That is the same split.

### 3.2 Rear cover (second data point)

| Rear cover, cold | IR3 V2 belt, turned 90° | Lime 220 flat |
|---|---:|---:|
| Contours | 19 ms | 9 ms |
| Supports (off) | 38 ms | 48 ms |
| Toolpaths (infill CPU) | 497 ms (6.6 s) | 411 ms (4.2 s) |
| **Order: serial tour** | **3,455 ms (76%)** | **3,304 ms (81%)** |
| Combing | 317 ms | 232 ms |
| Emit | 35 ms | 19 ms |
| `coreMs` | 4,542 ms | 4,099 ms |
| Reply | 35.2 MB | 13.8 MB |
| Wall | 5,147 ms | 4,378 ms |

### 3.3 Before the slice: STEP import and Model

| Step (Telo cover) | Time | Note |
|---|---:|---|
| STEP import (`meshPreview`, OCCT tessellation), per load | 12.0–18.1 s over 4 loads | Once per import. Larger than a slice. |
| Model open (`faces_find`'s first call opens the B-rep tree) | 12.5–19.4 s | Once per Model session |
| Hole: `model_probe` + `model_apply` | 1.2–1.9 s + 0.5–0.7 s | Open CASCADE |
| `model_commit` (export, retessellate) | 0.47–0.63 s | |
| CLI `lime-slice slice part.stp` (OCCT mesher), whole run | 39.5 s | Includes about 25 s of read and tessellation; CLI defaults, not the app's |
| CLI `slice` with the in-house mesher (167k triangles) | 18.5 s | `core` 13.9 s |

The CLI's own defaults differ from the app's, so its `core` (12.7 s, infill CPU 43.5 s) is not comparable to section 3.1. It agrees on the split: order 8.2 s, toolpaths 2.9 s, contours 38 ms. `bench` output on the same part is in section 9.

## 4. Re-slice cost after typical edits (Telo cover)

The warm column replays one sequence in one process: base, base again, infill 30%, walls 3, back to 12% and 2 walls, move, supports on, support angle 50°, hole. Cold sends the edited request to a fresh process.

| Edit | IR3 belt, warm | IR3 belt, cold | Lime 220, warm | Lime 220, cold | Stages reused when warm |
|---|---:|---:|---:|---:|---|
| Same request again | **0.16 s** | 9.3 s | **0.07 s** | 12.5 s | all; 70 KB patch |
| Infill 12 → 30% | 7.9 s | 8.2 s | 12.5 s | 11.6 s | contours, supports |
| Walls 2 → 3 | 7.2 s | 7.0 s | 10.6 s | 10.7 s | contours, supports |
| Back to 12% / 2 walls (two recipes ago) | 11.9 s | — | 13.3 s | — | contours, supports (toolpaths shelf holds 2) |
| Move the part (125,125 → 120,110) | **11.2 s, full** | 10.3 s | **0.21 s** | 12.9 s | belt: nothing; flat: all, offset at emit |
| Supports on | 14.5 s, full | 13.0 s | 5.4 s | 19.1 s | belt: nothing; flat: contours, toolpaths, order, comb |
| Support angle 45 → 50° | 7.0 s | — | 6.4 s | — | contours, toolpaths, order, comb |
| Model: 6 mm through hole, then slice | 20.1 s | 14.7 s | 20.3 s | 21.4 s | nothing (new mesh) |
| · plus the Model op before it | +2.2–3.2 s | | +2.2–3.2 s | | probe, apply, commit |

What the numbers say:

- **Every settings edit that touches the part re-runs the whole serial tour.** Infill and walls change the paths of every layer, so `tour_part` finds no layer it can reuse and spends 3–9 s on one core. This one loop decides whether an edit feels live.
- **A move on the belt is a full re-slice.** On the flat bed it costs 0.2 s, because #122 applies the offset at emit. On the belt, this move changed the position along the belt, which changes where the slanted layers cut the part, so a full re-slice is correct for that axis. A move across the belt only should not need one. That case was not separated here; it is milestone G4.
- **Supports on the belt re-slice everything**, because floor supports move the slice frame. On the flat bed only the supports are recomputed: 4.0–5.0 s of tree growing, plus 0.5 s re-touring the support layers.
- **A hole is a new mesh, so nothing is reused.** The hole changes a band of layers, but the cache keys hash the whole mesh.
- **A long-lived process got slower.** In the warm sequence, the parallel void-fill CPU sum grew from about 24 s to between 48 and 77 s for the same kind of work. The hole took 20.1 s warm against 14.7 s cold, and "back to 12%" took 11.9 s against the base's 9.3 s. The serial tour did not slow down. The likely causes are memory pressure from the kept stages (two shelves of every layer's stages) and the allocator, or heat. This was not diagnosed here. It matters for dynamic updates, which are the long-lived case, and it is milestone C0.
- The replies are 30–75 MB of JSON even as patches, because a toolpath change redraws every layer. They cost 0.2–0.4 s to serialise and about as much to send and parse.

## 5. GPU fit, stage by stage

The reference is `crates/lime-sim`'s `multigrid/gpu.rs`:
- wgpu 27 on DX12, Vulkan or Metal, with a CPU fallback;
- f32 on the GPU, because WGSL has no f64;
- a context opened about 1 s ahead, overlapped with other work.

It won only from about 400k nodes, and by about 6% there (13.1 s against 13.9 s), because assembly and everything around the smoothing stayed on the CPU. It was measured on an RTX 5080 laptop. This machine has a Radeon 780M that shares system memory, so uploads are cheaper but there is less compute.

| Stage | Wall today (Telo IR3 / L220) | Data-parallel? | Precision and determinism | Transfer | GPU verdict |
|---|---:|---|---|---|---|
| STEP tessellation (OCCT) | 12–18 s per import | Inside OCCT | n/a | n/a | **No.** Not ours to port. Cache the tessellation by file hash instead (cache or skip). |
| Mesh load | 1 ms | — | — | — | No |
| Contours (cut + chain) | 52 / 48 ms | Yes: triangle × layer is the textbook GPU kernel | Cuts in f32 move vertices by about 1e-5 mm, so the loops and every byte after them change | 4.8 MB up, loops down | **No-go.** It is under 1% of the wall. Even infinitely fast it saves 50 ms, against a 1 s adapter open. |
| Wall offsets (Clipper2) | about 1.1 s of CPU, inside toolpaths | Per layer, yes; per offset, no. A polygon offset is a sweep, with no GPU Clipper. | Clipper2 is integer and exact; a GPU offset would be a raster or f32 approximation. Not byte-identical. | Every layer's loops, both ways | **No-go.** It is already parallel at 15×, and the precision rule rules it out. |
| Infill / void fill / skin | 1.6 s wall (24 s CPU, 15×) | The pattern generation, yes, and it is tiny (lightning 19 ms, grid 0.85 s CPU). The cost is the Clipper booleans (void cover, void bool, skin). | Same as offsets. A raster coverage test would be f32 and inexact. | Large: every layer's regions | **No-go** for exact output. A raster "where is solid" pre-pass could prune work, but it must be conservative and leave the result exact. It is a later research item at best, worth 0.5–1 s. |
| Gyroid (3D, Toughness) | not exercised by these defaults | A scalar field: an ideal GPU kernel | f32 field, then contouring: changes bytes | Field down | **Maybe later.** Worth measuring only on Toughness slices, where `gyroid` shows up. Even then the output contour must come from the CPU's f64 path to stay byte-identical, which leaves little to save. |
| Supports (tree growing) | 0.15 s off; 3–5 s on | Partly: collision and avoidance distance fields are voxel work. The growth itself is ordered branch by branch. | f32 fields are acceptable only as a conservative pre-filter with exact CPU checks | A voxel grid of the part per layer band | **Defer.** This is the only stage over 1 s that is partly GPU-shaped, and only when supports are on. Profile `support_ms` by sub-step first. |
| **Order: serial tour** | **5.7 / 8.5 s** | **No.** Each layer starts where the last ended. Within a layer, the work is about 44 infill paths per run (a 2-opt and Or-opt polish of a tiny TSP), which is too small and branchy for a GPU dispatch. | Must be exact | — | **No-go on GPU. Go on CPU** (section 6). |
| Combing | 0.37 / 1.05 s | Per layer, already parallel | — | — | No |
| G-code emit | 0.06 s (deferred) | Ordered fold | Bytes | — | No |
| Preview build and reply | 0.5–0.8 s | — | — | 36–75 MB JSON | No. Fix the wire instead (binary columns, patches by layer range). |

### 5.1 End-to-end estimate for the Telo cover

GPU-shaped work: contours 0.05 s, plus the toolpath stage 1.6–1.7 s (already at 15× on the CPU), plus supports when on.

- **Best case**, ignoring the byte-identical rule: the toolpaths run 3× faster on the GPU, transfers overlap, and the adapter opens in the background. That saves about 1.1 s of 9.3 s on the belt (**−12%**) and of 12.5 s flat (**−9%**).
- **Realistic**, on this 780M with the stress solver's experience: per-layer polygon data, uploads and readbacks for every layer, and launches of a few kernels per layer erase most of that. The result is **−3% to +5%**, where a positive number is slower. A cold slice also pays a 1 s adapter open.
- **The dynamic-update case** (a settings edit, warm): the tour is 60–75% of each edit, and the GPU leaves it untouched. The gain is **0–10%** per edit.
- **Under the byte-identical rule:** the G-code would change wherever f32 or raster geometry reaches the toolpaths, which is everywhere above. The only GPU work that keeps the bytes is a conservative pre-filter whose result the CPU re-checks exactly. That shrinks the savings toward zero.

**GPU recommendation: no-go for every slicing stage today.** Revisit only for support fields, and for 3D gyroid on Toughness, after the CPU work below lands and only if those stages then dominate.

## 6. What does achieve dynamic update

All of the following run on the CPU and keep the G-code byte-identical.

### 6.1 A speculative parallel tour, checked exactly (the biggest lever)

`tour_part` already lays out every layer in parallel (`PartLayout`, 41 ms) and tours them serially, because layer *i* starts at the end of layer *i−1*. It already reuses a kept layer when its start (`from`) matches the new start bit for bit.

The same check makes speculation exact:

1. **Pass 1, parallel.** Tour every layer from `None`, the no-cursor start, and keep each layer's end *eᵢ*.
2. **Pass 2, parallel.** Tour layer *i* from *eᵢ₋₁*.
3. **Serial fix-up.** Walk up the layers. A layer whose real start equals the start pass 2 used, bit for bit, is final. Any other layer is toured again from its real start, as today.

Each final layer was toured from its true start by the same deterministic code, so the output bytes are the ones the serial loop makes.

How often is a layer's end independent of its start? Measured with a throwaway probe (not committed) that toured every layer a second time from `None` and compared the end bits:

| Part / printer | Layers whose end is independent of the start |
|---|---:|
| Telo / IR3 belt | **88%** |
| Telo / Lime 220 | 58% |
| Rear / IR3 belt | 66% |
| Rear / Lime 220 | 27% |

The cost is two parallel passes (about 2 × serial ÷ 12 effective threads) plus the serial residue for the layers whose end depends on their start.

| Telo cover | Serial today | Estimated after |
|---|---:|---:|
| IR3 belt | 5.7 s | 1.6–2.4 s |
| Lime 220 | 8.5 s | 4.5–6 s |

That takes the belt slice from 9.3 s to about 5–6 s. Where most ends depend on the start (the flat rear cover), it falls back to today's time plus the wasted passes. A cheap guard can skip pass 2 when pass 1 shows few start-independent ends.

### 6.2 Make the per-layer infill ordering cheaper

`order_infill` is 90% of the serial tour. On the Telo IR3 slice it makes 7,382 calls over 322k paths: 0.7 ms per call.

Each call builds:
- up to five candidate orders (legacy NN, NN, Hilbert, identity, islands, plus stripes);
- a `walk_cost` for each candidate;
- a `polish_order`;
- an `untangle` (2-opt).

Profile one call. Then:
- drop candidates that never win (count the winners over the golden set);
- cache `walk_cost` legs;
- bound the 2-opt with a neighbour list.

Each change must keep golden identical, or document every row that moves and why, as a deliberate output change. Expect 1.5–3× on this loop. That speeds up both the serial and the speculative passes.

### 6.3 Per-layer reuse after local edits

A hole, a fillet or a boss changes the contours of a band of layers. Today the stage keys hash the whole mesh, so nothing is reused.

Key contours, toolpaths and tours per layer by the hash of that layer's cut loops, the way `LayerKeys` already does for overrides:
- unchanged layers keep their toolpaths;
- the tour keeps every layer below the band;
- above the band, the existing `bits(k.from) == bits(end)` check reuses each layer again once a re-toured layer ends where it did before. That happens quickly at an 88% start-independence rate.

A small through hole touches a few percent of the layers. That edit would cost the contour cut (50 ms) plus that band, instead of 14–21 s.

### 6.4 A progressive preview

The parallel stages finish within about 2 s; then the tour takes 4–8 s. Changes:
- After the toolpath stage, send a preview patch of the toolpaths themselves. Paths, widths and kinds are already final; the tour only reorders them and changes the seams and travels.
- Then send the ordered patch, the estimate and the G-code when the tour ends.
- Mark the preview "ordering…" in between.

Together with 6.1, settings edits look live within about 2 s on the Telo cover.

### 6.5 Smaller items the numbers point at

- **Moves on the belt.** A move across the belt (the belt's X) should take the part-frame path the flat bed takes (0.2 s). A move along the belt changes the layer phase and stays a re-slice, unless it is a whole number of layer pitches.
- **Recipe shelf.** "Back to 12%" missed because the toolpath and tour shelves hold only 2 entries. Hold more entries while memory allows, keyed as today.
- **Long-lived slowdown.** Section 4's warm-process slowdown, up to 3× on the parallel stages, must be explained before any live mode ships (milestone C0).
- **Reply size.** 36–75 MB of JSON per edit costs 0.4–0.8 s. Binary preview columns and layer-range patches would cut that.
- **STEP import.** 12–18 s per load of the Telo cover. Cache the tessellation by file hash and tolerance. In the CLI, reading and tessellating the same file took about 25 s.

## 7. Recommendation, per stage

| Stage | GPU | Do instead |
|---|---|---|
| STEP tessellation | No-go | Cache by file hash |
| Contours | No-go | Per-layer keys (6.3) |
| Walls and infill (Clipper2) | No-go | Keep; per-layer reuse (6.3) |
| Gyroid 3D | Not now | Measure on Toughness first |
| Supports | Defer | Profile its sub-steps; revisit a conservative GPU field later |
| Travel tour | No-go | **Go:** speculative tour (6.1), cheaper ordering (6.2) |
| Combing, emit | No-go | — |
| Preview and reply | No-go | Progressive preview (6.4), binary wire |

## 8. Milestones (CPU first, each byte-identical)

Every milestone keeps G-code byte-identical. Proof:
- `tools/golden.sh` against the stored run (60/60);
- the Telo and rear-cover replays from section 4 compared by G-code hash, in the scratchpad, never committed;
- `cargo clippy -p lime-slice-core --all-targets --locked -- -D warnings`.

Times are measured with `LIME_INNER_PROFILE=1` against the tables above.

- **C0. Explain the warm slowdown.** Replay the section 4 sequence with peak working set and per-stage CPU logged. Try:
  - a smaller kept shelf;
  - `mimalloc`;
  - a cool-down between requests (to rule out heat).

  Done when a warm edit costs no more than the same request cold, ±10%.
- **C1. Speculative tour (6.1).** Add `tour_part` passes 1 and 2 behind the existing `travel_opt` path, with an exact serial fix-up. Tests:
  - a unit test that tours a fixture both ways and compares the paths and ends exactly;
  - golden 60/60;
  - section 4's replays hash-identical.

  Target: Telo IR3 order ≤ 2.5 s.
- **C2. Cheaper infill ordering (6.2).** Count the winning candidates over the golden set and the two covers, then remove dead candidates and bound 2-opt. Must stay byte-identical. If a change is worth an output change, it gets its own PR with the moved rows listed.
- **C3. Progressive preview (6.4).** Engine: an early patch event on the job stream (`/api/jobs/{id}/events` and the desktop's `slice-progress`). UI: draw the toolpaths with an "ordering…" note. Tests: an e2e spec in `test:smoke` with a held job (`slices.hold()`), plus `--repeat-each=3`.
- **C4. Per-layer contour keys (6.3).** Done when a Model hole on the Telo cover re-slices in under 3 s warm. Tests:
  - a unit test where a local mesh edit reuses every layer outside its Z band;
  - golden 60/60.
- **C5. Belt move across the belt (6.5).** A belt X move reuses all stages. Test the belt part-frame G-code offset the way #122 tested the flat bed.
- **G1 (only if C1–C4 leave a GPU-shaped stage on top).** Prototype the support-collision field in wgpu behind a feature flag. Use the `lime-sim` pattern: one context per process, opened in the background, with a CPU fallback. The CPU must check the field exactly, and golden must stay 60/60. Ship it only if it wins on both the 780M and a discrete GPU.

## 9. Raw notes

- CLI `bench` on the Telo STEP (OCCT mesher, default flat printer, no app profile, 14 min for the whole bench):

  | Mode | Slice | Contours | Toolpaths | Order | Combing | Emit | Classic planner |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | Speed | 13.1 s | 37 ms | 1.64 s | **9.67 s** | 1.09 s | 0.16 s | 2.4 s |
  | Toughness | 14.5 s | 64 ms | **5.86 s** | **6.92 s** | 1.06 s | 0.28 s | 4.3 s |
  | Layer blend | 13.7 s | 110 ms | 4.78 s | 6.95 s | 1.19 s | 0.22 s | 4.0 s |
  | Region blend | 12.6 s | 121 ms | 2.83 s | 8.18 s | 0.77 s | 0.22 s | 3.1 s |

  - Toughness is the one mode where toolpaths approach the tour (gyroid, more walls).
  - 3D against 2D gyroid on Toughness: 14.7 s against 14.0 s. So a GPU 3D-gyroid field could save at most about 0.7 s on that mode.
  - The classic planner (lines, nearest-neighbour order, no polish) slices the same part in 2.4–4.3 s. That bounds what the tour's travel optimisation costs: about 7–10 s.
- Every replay row (stage clocks, reply sizes, reuse flags) came from `serve` with `LIME_INNER_PROFILE=1`. The scripts (`capture.ts`, `replay.mjs`, `run.mjs`, `measure.mjs`) lived in the session scratchpad. They need the company parts, so they are not committed.
- To repeat: wrap the MCP engine's `sliceStart` to save its body, as `docs/plan-stress-solver-scaling.md` does for `simStudy`. Then POST the bodies to `lime-slice serve` in order, swapping `dataB64` for `meshRef` and setting `previewBase` from the last reply.

## 10. Built milestones

Measured the way section 4 was, against the release `serve` with `LIME_INNER_PROFILE=1`, on the Telo cover with PETG and a 0.4 mm nozzle. The request bodies were captured again through the MCP `Session` (96,358 triangles) and deleted afterwards. Every row also logs the process's peak working set and CPU time after each request.

### 10.1 C0: the warm slowdown is the Windows heap

**Cause.** Rust's default allocator on Windows is the process heap. In a long-running `serve`, the parallel toolpath stage took up to twice as long as in a fresh process, yet the process spent the same CPU time on the request. The threads were waiting, not working. Turning to mimalloc removes the slowdown. The other suspects were ruled out:

- **Heat.** A 20 s pause before each request changed nothing: "back to 12%" took 12.3 s warm against 12.0 s without the pause.
- **The kept stages' memory.** With mimalloc, the peak working set is the same (2.1 GB after the sequence), and a warm edit is no slower than a cold one. Memory held by the shelves is not the cause, so their size stays as it is.

**Fix.** `mimalloc` is the global allocator of every long-running engine: the desktop app, `lime-slice` (`serve` and the CLI), and the MCP engine library. The slicer core doesn't change, and golden is 60/60 identical.

IR3 V2 belt, medians of three alternating runs. Warm is the section 4 sequence in one process; cold is the same request to a fresh process.

| Edit | Windows heap, warm | Windows heap, cold | warm / cold | mimalloc, warm | mimalloc, cold | warm / cold |
|---|---:|---:|---:|---:|---:|---:|
| Base | 10.4 s | 9.6 s | +8% | 9.5 s | 9.0 s | +6% |
| Infill 30% | 8.4 s | 8.8 s | −4% | 8.1 s | 8.1 s | 0% |
| Walls 3 | 7.3 s | 7.8 s | −5% | 6.1 s | 6.8 s | −10% |
| Back to 12% / 2 walls | 14.2 s | 10.4 s | **+36%** | 9.8 s | 9.8 s | 0% |
| Move | 12.4 s | 10.8 s | +15% | 9.7 s | 11.0 s | −12% |
| Supports on | 18.2 s | 13.6 s | **+33%** | 12.6 s | 15.4 s | −18% |
| Hole (new mesh) | 20.7 s | 16.3 s | **+27%** | 14.2 s | 16.0 s | −11% |
| · toolpaths, warm | 5.0 s | 2.3 s | | 2.3 s | 2.5 s | |
| · infill CPU sum, warm | 69.6 s | 31.4 s | | 34.0 s | | |

Lime 220, one run each:

| Edit | Windows heap, warm / cold | mimalloc, warm / cold |
|---|---:|---:|
| Infill 30% | 11.3 / 11.6 s | 10.6 / 11.1 s |
| Back to 12% / 2 walls | 14.0 / 13.6 s | 11.9 / 12.0 s |
| Hole | 20.4 / 21.9 s | 19.1 / 25.1 s |

Every warm edit now costs no more than the same request cold. The cold column is noisy (±15%) because the serial tour varies from run to run on this laptop. The toolpath stage, which showed the slowdown, holds at 2.1–2.4 s all through the warm sequence. On the Windows heap, it climbed to 5.0 s.
