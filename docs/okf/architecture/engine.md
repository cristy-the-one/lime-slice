---
type: Component
title: Engine
description: The Rust workspace plans FDM toolpaths, edits STEP solids, and runs the stress solver, and the crates do not all link each other.
tags: [architecture, engine, rust]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: core
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/lib.rs
    title: crates/lime-slice-core/src/lib.rs
  - id: cli
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/Cargo.toml
    title: crates/lime-slice/Cargo.toml
  - id: bin
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/src/main.rs
    title: crates/lime-slice/src/main.rs
  - id: model
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model/src/lib.rs
    title: crates/lime-model/src/lib.rs
  - id: occt
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-occt/src/lib.rs
    title: crates/lime-model-occt/src/lib.rs
  - id: load
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-load/src/lib.rs
    title: crates/lime-model-load/src/lib.rs
  - id: mcp-engine
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-mcp-engine/src/lib.rs
    title: crates/lime-mcp-engine/src/lib.rs
  - id: sim
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/lib.rs
    title: crates/lime-sim/src/lib.rs
  - id: bridge
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim-bridge/src/lib.rs
    title: crates/lime-sim-bridge/src/lib.rs
  - id: preview
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-preview/src/lib.rs
    title: crates/lime-preview/src/lib.rs
  - id: shell
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-shell/src/lib.rs
    title: crates/lime-shell/src/lib.rs
---

# Crates

`lime-slice-core` is "mesh in, strategy-blended FDM toolpaths and G-code out." Its public surface includes mesh load, slice entry points, G-code, strategy, supports, STEP loading, audit, and calibration towers.[1]

`lime-slice`'s package description is "Lime Slice CLI, bench, and local API".[2] The clap about line is "Lime Slice FDM slicer". Subcommands include Slice ("Slice a mesh to G-code"), Bench, Serve ("HTTP API used by the browser UI", default port 43118), and Calibrate.[3]

`lime-model` is the kernel boundary for STEP editing. `lime-slice-core` does not depend on it. An unedited STEP file is still read by truck. With `OCCT_ROOT` set at build time, `open()` dynamically links Open CASCADE. Without it, `open()` returns an error.[4]

`lime-model-occt` is the Open CASCADE bridge for Model mode: the history tree, as JSON in and JSON out. The desktop dlopens this crate. OCCT is present only when `OCCT_ROOT` is set at build time.[5] `lime-model-load` finds and calls that bridge. It does not link OCCT; it uses `libloading`.[6]

`lime-mcp-engine` is the in-process slicer engine for the MCP server. TypeScript owns the project and the plate. This library provides slicing and `lime_model_load::tree` in-process. Node loads the cdylib.[7]

`lime-sim` is the in-house linear static stress solver. Units are millimetres, newtons, and MPa.[8] `lime-sim-bridge` is the one place that links the slicer and the stress solver. The Tauri command and the MCP engine both call `study_json`.[9] See [Simulation](../stress/simulation.md).

`lime-preview` reads the optional thumbnail and summary at the front of a `.lime` file, with a 500 ms read budget.[10] `lime-shell` is the Explorer thumbnail, preview, and property handler for `.lime` files. COM is Windows-only. Linux builds the crate for tests and lints without registering handlers.[11]

# What does not link what

The stress crate does not link the slicer, and the slicer does not know about stress. Only `lime-sim-bridge` joins them.[9] The modeling bridge is loaded at runtime, not linked into the slicer. See [Project rules](../conventions/project-rules.md) for the licence check around that split.

# Citations

[1] [crates/lime-slice-core/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/lib.rs)
[2] [crates/lime-slice/Cargo.toml](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/Cargo.toml)
[3] [crates/lime-slice/src/main.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/src/main.rs)
[4] [crates/lime-model/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model/src/lib.rs)
[5] [crates/lime-model-occt/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-occt/src/lib.rs)
[6] [crates/lime-model-load/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-load/src/lib.rs)
[7] [crates/lime-mcp-engine/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-mcp-engine/src/lib.rs)
[8] [crates/lime-sim/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/lib.rs)
[9] [crates/lime-sim-bridge/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim-bridge/src/lib.rs)
[10] [crates/lime-preview/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-preview/src/lib.rs)
[11] [crates/lime-shell/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-shell/src/lib.rs)
