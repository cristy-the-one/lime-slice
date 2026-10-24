# Stress solver scaling: faster solves, no "past the budget" dead ends

Status: tier 0 done on `claude/sim-tier0` (items 1–4; follow-ups listed under it). Tiers 1 and 2 not
started; tier 1 is the next piece of work.
Read this first if you are continuing the work. The status list in each tier is the source of truth.

## Why

A sliced study is solved by `FaerLdlt` (`crates/lime-sim/src/solve.rs`): AMD plus faer's supernodal LDLᵀ, in
f64. Two things make it frustrating at real sizes:

- **It refuses.** The second cell size, which judges trust, is skipped whenever its estimate passes the memory
  budget: "A second cell size of 1.41 mm needs about 10877 MB, past the 4096 MB budget, so the sliced result was
  not checked there." With a budget fitted to the first size, the √2-finer size (about 2.8× the nodes) almost
  never fits, so the default study is almost never checked.
- **It is slow.** The factor ran on one thread (`Par::Seq`, faer built without `rayon`). Measured, the factor is
  not the only cost: on the jet's 99k-node grid (one thread) assembly took 1.0 s, copying triplets and building
  the CSC 0.8 s, AMD 0.4 s, the numeric factor 4.1 s, and recovery 1.3 s, most of it a second full assembly.

Memory is the factor's fill, not the mesh: peak grows about as nodes^1.2 (2.2 GB at 74k nodes, 4.6 GB at 136k in
the 2026-10-22 trial, `docs/stress-sim-review-tasks.md`). A GPU direct factor would not help that: it still
stores the fill, in less memory than the host has. The memory wall is removed by an **iterative** solve, whose
memory is linear in the nodes. A GPU then makes that iterative solve fast.

## The benchmark

`crates/lime-sim-bridge/examples/study_bench.rs` replays one `study_json` body and prints slice time, study time,
peak working set, resolutions, margins and notes. One study per process, so the peak is that study's own.

```
cargo run -p lime-sim-bridge --release --example study_bench -- body.json checkResolution=false hXy=2
```

Each `key=value` replaces that key of the study (JSON values; `hXy=null` removes the fixed cell). A body is what
`Session` sends to `engine.simStudy`: wrap the engine's `simStudy` to write its argument to a file, then call
`sim_setup` and `sim_run` as usual. The reference body is the 200 mm fighter jet from the wing-stiffness loop
(`fighter_jet_tips04.lime`: held at the fuselage middle, 10 N down on each wing's outer two thirds, provisional
PETG, two 6 mm tip spheres at 0.4 mm and a safety factor of 5). It is not in the repo; regenerate it the same
way from any part.

### Before tier 0 (24-core Windows machine, 64 GB, release without LTO)

| Jet study | Cell | Nodes | Study time | Peak | Tip deflection (governing) |
|---|---|---|---|---|---|
| `hXy=2`, check on (what the MCP sends) | 2 mm | 99,361 | 8.9 s | 2.54 GB | 0.391 mm; check skipped |
| `hXy=2`, check off | 2 mm | 99,361 | 8.7 s | 2.54 GB | 0.391 mm |
| `hXy=2.83`, check off | 2.83 mm | 45,234 | 2.7 s | 1.04 GB | 0.318 mm |
| fitted cell, check on | 1.83 mm | 120,646 | 10.3 s | 3.09 GB | 0.445 mm; check skipped |
| `hXy=2`, `memoryMb=16000` | 2 mm | 99,361 | 8.4 s | 2.53 GB | check skipped, see below |

Found while measuring:

- **The refusal blames the wrong limit.** With `memoryMb=16000` it still says "needs about 10877 MB, past the
  16000 MB budget". `nodes_for_memory` clamps to `NODE_CAP` (200,000), and the √2 size needs about 281k nodes,
  so the node cap refused it while the sentence names memory.
- **The jet's 2 mm result is not converged.** 2.83 mm reads 0.318 mm, 2 mm reads 0.391 mm (19% apart), and the
  fitted 1.83 mm reads 0.445 mm. The deflection rises as the grid refines (a coarse staircase grid is too stiff),
  so a 2 mm "pass" at 0.39 mm is not trustworthy. This is exactly what the skipped check should have said.

## Tier 0: CPU quick wins (this branch)

Each item stands alone. Keep `cargo test -p lime-sim` and `cargo test -p lime-sim-bridge` green.

1. **Parallel factor.** faer gets its `rayon` feature; `solve.rs` uses `Par::rayon(min(cores, 8))` for the factor
   and the solve. The numeric factor went from 4.1 s to 1.9 s; it stops improving past 6–8 threads (2.4 s on all 24
   of a Core Ultra 9 275HX, whose 16 E-cores don't help). The feature adds 17 crates to `Cargo.lock` (spindle and
   its loom/tracing tree). Status: done.
2. **Exact memory for the second size.** Replace the `2176 · (n / 73558)^1.20` fit, for the check, with a
   symbolic analysis: build the finer grid's mesh and its node graph, run AMD and the symbolic Cholesky on it
   (no values), and scale by the first size's real factor so the dof-level fill is calibrated, not guessed.
   The sentence must name the limit that actually stopped it (memory or node cap). Status: done:
   `solve::node_graph_factor_len`, `sliced::study_peak_mb` (peak ≈ 2 × factor bytes + 300 MB, fitted on two jet
   runs), `sliced_study::second_size_cost`. The sliced path's node cap is now `SLICED_NODE_CAP` (1,000,000), a
   backstop only; `NODE_CAP` (200k) still caps the smear path and the first size's fit.
3. **RAM-aware budget.** A study with no `memoryMb` fits its first cell size to `DEFAULT_MEMORY_MB` as today, so
   default solves do not get slower, but the second size may use the RAM actually available (with headroom).
   An explicit `memoryMb` keeps today's meaning for both. Status: done: `memory::spare_mb` (¾ of available
   physical memory; Windows and Linux, `None` elsewhere, which falls back to 4096).
4. **Coarser check instead of none.** When the finer size does not fit, solve at h·√2 and judge trust from the
   move between h and h·√2. The coarse move overstates the fine error, so trust stays conservative. The note
   says which size was checked and why. Status: done; if the coarser grid fails too (no solid cell, a hold that
   touches nothing), the study still answers, with one size and a note.

### After tier 0 (same machine and build)

| Jet study | Before | After |
|---|---|---|
| `hXy=2`, check off | 8.7 s, 2.54 GB | 6.5 s, 2.54 GB |
| `hXy=2`, check on (the MCP default) | 8.9 s, check skipped | 23.1 s, 6.6 GB; 1.41 mm solved (217,392 nodes), moved 18% |
| fitted cell, check on | 10.3 s, check skipped | 31.2 s, 8.7 GB; 1.29 mm solved (277,770 nodes), moved 11% |
| `hXy=2`, `memoryMb=4096` | skipped | 10.5 s; checked at 2.83 mm, moved 19%, note says why |
| `hXy=2`, `memoryMb=16000` | skipped, wrong sentence | 24.8 s; 1.41 mm solved |

The 1.41 mm solve itself (check off, `hXy=1.4142`) took 17.9 s and peaked at 6.4 GB; the estimate said 6,715 MB
and the old fit 10,877 MB. The jet's governing tip moves 0.391 → 0.475 mm from 2 mm to 1.41 mm, so its 2 mm
"pass" against 0.4 mm was an artefact of the coarse grid. A check costs time now (23 s against 9 s); tier 1
brings that down.

Tests added: `solve::tests::the_node_graph_sizes_a_finer_factor` (the node-graph ratio to a real 3-dof factor
holds within 15% across a √2 refinement) and `sliced_study::a_finer_size_past_the_memory_is_checked_coarser`.

Not in tier 0, worth doing after:

- Assemble once. `solve_cases` assembles again in "recover" only to read the residual (1.0 s of the jet's
  6.5 s); the first assembly's system can be kept.
- Assemble straight into CSC. Today the assembler builds a `Vec<(usize, usize, f64)>` and `FaerLdlt` copies it
  into faer `Triplet`s before building the matrix; both lists are alive at once, hundreds of MB at 100k nodes.
- Progress with time left, from the symbolic flop count, on the `stage()` hook that the sliced path leaves
  unset (`on_progress: None` in `solve_at`).
- `NODE_CAP` (200k, `units.rs`) refuses meshes that the memory budget could hold. Once item 2 measures memory
  exactly, the sliced path can be capped by memory alone.

## Tier 1: iterative solve on the CPU (removes "cannot be done")

The plan for this already exists as a line in `docs/plan-stress-simulation.md` §5.3 ("Large models: CG or GMRES
behind `LinearSolver`, plus a `Preconditioner`"). This tier carries it out for the sliced grid.

- `PcgSolver: LinearSolver`, chosen when the symbolic estimate does not fit, or by `Study::solver`. Direct LDLᵀ
  stays the default where it fits: it is exact and fast there.
- **Preconditioner: reuse the factor we already have.** The first size is factored anyway. The second size's
  solve is a two-level method: smooth on the fine grid (Jacobi or Chebyshev), correct with the first size's
  LDLᵀ. Memory is the fine grid's vectors plus a factor that already exists, so the resolution check always runs.
  - h and h/√2 do not nest. Either interpolate across non-nested grids (trilinear on the coarse tets; works,
    converges a little slower), or make the check refine by 2 in the layer plane only, which nests because
    cells stay whole layers tall.
- Elasticity needs the six rigid-body modes in any coarse space; the coarse direct factor carries them.
- Stopping rule: relative residual 1e-8, checked against the same `RELATIVE_RESIDUAL_MAX` the direct path uses
  for "not held".
- Accept when: Kirsch, Lamé and the cantilever baselines match the direct solver within their existing
  tolerances; the jet's 1.41 mm check runs on this machine and reports a move; peak memory at the fine size is
  under the first size's peak plus the fine vectors.

## Tier 2: GPU backend (removes "takes very long")

- **wgpu compute** (Vulkan, DX12, Metal): one code path for NVIDIA, AMD, Intel and Apple, at home in Tauri.
  WGSL has no f64, so the GPU runs the preconditioned CG in f32 inside an f64 iterative refinement on the CPU:
  residual in f64, solve the correction in f32, repeat. That reaches f64-quality answers.
- **Matrix-free operator on the structured grid.** Every sliced cell is h × h × whole layers, split into the same
  six tets (`HEX_TETS`). Geometry repeats; only each cell's material (fraction, fibre axis, alignment, role)
  differs. A kernel per cell builds its TET10 element action from the cell's D matrix on the fly. At 271k nodes
  this is under 100 MB against ~10.9 GB for the direct factor; an assembled f32 CSR would be ~0.5 GB and is the
  simpler first step.
- **Geometric multigrid** on the structured grid (coarsen 2× in the plane, merge slab pairs), Galerkin coarse
  operators, Chebyshev smoothing. Thin wings, cells down to φ = 0.02 and layer anisotropy make plain Jacobi CG
  take thousands of iterations; multigrid is what makes the GPU pay.
- Fallback: no adapter, or the adapter's memory is too small, runs tier 1 on the CPU with the same operator.
- Optional later: a CUDA backend (cuDSS direct, or AmgX) for NVIDIA users who want native f64. Not the default:
  heavy, one vendor.
- Accept when: the same baselines as tier 1; the jet at 1.41 mm solves faster than tier 1 on a mid-range GPU;
  a machine without a GPU gives the same numbers through the CPU path.

## Where things are

- Solver and its trait: `crates/lime-sim/src/solve.rs` (`LinearSolver`, `FaerLdlt`).
- Driver: `crates/lime-sim/src/lib.rs` (`solve_cases`, `NODE_CAP` check), assembly in `assemble.rs`.
- Sliced study, budget and second size: `crates/lime-sim/src/sliced_study.rs` (`run`, `DEFAULT_MEMORY_MB`,
  `sliced_trust`), grid and memory fit: `crates/lime-sim/src/sliced.rs` (`fitted_h_xy`, `study_memory_mb`,
  `nodes_for_memory`, `SlicedGrid::mesh`).
- The MCP builds the body in `mcp/session.ts` (search `simStudy(payload)`); the desktop calls
  `lime_sim_bridge::study_json` from `src-tauri/src/lib.rs`.
