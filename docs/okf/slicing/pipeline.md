---
type: Pipeline
title: Pipeline
description: A slice request is loaded, cut, pathed, toured, combed, supported, assembled, and emitted as G-code, with the same core for the desktop, the browser, the CLI, and MCP.
tags: [slicing, gcode, pipeline]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: progress
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/progress.rs
    title: crates/lime-slice-core/src/progress.rs
  - id: slice
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/slice.rs
    title: crates/lime-slice-core/src/slice.rs
  - id: gcode
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/gcode.rs
    title: crates/lime-slice-core/src/gcode.rs
  - id: load
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/load.rs
    title: crates/lime-slice-core/src/load.rs
  - id: cache
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/slice_cache.rs
    title: crates/lime-slice-core/src/slice_cache.rs
  - id: request
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/slice-request.ts
    title: src/slice-request.ts
  - id: lib
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/lib.rs
    title: src-tauri/src/lib.rs
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# Entries

The desktop command `slice_model` calls `slice_payload_watched` and emits `slice-progress`.[^lib] The browser posts the same payload to the local API. MCP `slice_start` calls the in-process engine's `sliceStart`, which uses the same watched payload. The CLI `lime-slice slice` calls the core directly. See [Desktop shell](../architecture/desktop.md) and [MCP server](../architecture/mcp-server.md).

The UI request builder always sets `includeGcode: false`, `baseline: false`, and `compare: false`. `includePreview` is the caller's flag.[^request] When `include_gcode` is false, the reply parks the text and returns `gcodeToken` instead of the full G-code string.[^cache]

# Stages

Progress stages, in order, are Load, Cut ("Per-layer slice of the mesh"), Part ("The part's walls, infill, and skin"), Travel ("The part's tour"), Supports, Assemble, and Emit.[^progress]

The functions that do that work in `slice.rs` are `slice_plate`, then per object `cut_mesh`, `part_paths`, `tour_part` (and `guess_tours` when travel optimisation is on), `comb_part`, `plan_supports`, and `assemble`. `emit_gcode` in `gcode.rs` writes the file.[^slice] [^gcode]

`cut_mesh` builds a `ZIndex` and cuts bands in parallel with rayon. `part_paths` is the comment "Every layer's walls, infill, and skin, with overhangs split, and the ironing over each roof."[^slice]

# Inputs and outputs

`load_slice_mesh_tol` reads STL, 3MF (or a zip that is not named `.stl`), and STEP or STP. STEP goes through `load_step`.[^load] Mesh repair at cut time is described in the README: contours are cut from a welded mesh, a broken chain is closed across gaps up to 1.25 mm, and overlapping shells are merged with a nonzero union. A 1.5 mm opening stays open.[^readme]

The print artifact is G-code. The reply also carries preview layers, an estimate, a score, warnings, and optional belt copy data. The slicer does not write a resin job file. 3MF and STEP on the way out are model or plate exports, not a slice. See [Resin and Form 4](../printers/resin-form-4.md).

A belt request is prepared before the planar pipeline and mapped on emit. Compare mode on a belt returns "belt: compare is not supported yet".[^slice] See [Belt printers](../printers/belt.md) and [Interactive slice](../live-slicing/interactive-slice.md).

[^progress]: crates/lime-slice-core/src/progress.rs
[^slice]: crates/lime-slice-core/src/slice.rs
[^gcode]: crates/lime-slice-core/src/gcode.rs
[^load]: crates/lime-slice-core/src/load.rs
[^cache]: crates/lime-slice-core/src/slice_cache.rs
[^request]: src/slice-request.ts
[^lib]: src-tauri/src/lib.rs
[^readme]: README.md
