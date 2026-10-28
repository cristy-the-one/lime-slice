---
type: Component
title: Rust engine
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

`lime-slice-core` is "mesh in, strategy-blended FDM toolpaths and G-code out." Its public surface includes mesh load, slice entry points, G-code, strategy, supports, STEP loading, audit, and calibration towers.[^core]

`lime-slice`'s package description is "Lime Slice CLI, bench, and local API".[^cli] The clap about line is "Lime Slice FDM slicer". Subcommands include Slice ("Slice a mesh to G-code"), Bench, Serve ("HTTP API used by the browser UI", default port 43118), and Calibrate.[^bin]

`lime-model` is the kernel boundary for STEP editing. `lime-slice-core` does not depend on it. An unedited STEP file is still read by truck. With `OCCT_ROOT` set at build time, `open()` dynamically links Open CASCADE. Without it, `open()` returns an error.[^model]

`lime-model-occt` is the Open CASCADE bridge for Model mode: the history tree, as JSON in and JSON out. The desktop dlopens this crate. OCCT is present only when `OCCT_ROOT` is set at build time.[^occt] `lime-model-load` finds and calls that bridge. It does not link OCCT; it uses `libloading`.[^load]

`lime-mcp-engine` is the in-process slicer engine for the MCP server. TypeScript owns the project and the plate. This library provides slicing and `lime_model_load::tree` in-process. Node loads the cdylib.[^mcp-engine]

`lime-sim` is the in-house linear static stress solver. Units are millimetres, newtons, and MPa.[^sim] `lime-sim-bridge` is the one place that links the slicer and the stress solver. The Tauri command and the MCP engine both call `study_json`.[^bridge] See [Simulation](/stress/simulation.md).

`lime-preview` reads the optional thumbnail and summary at the front of a `.lime` file, with a 500 ms read budget.[^preview] `lime-shell` is the Explorer thumbnail, preview, and property handler for `.lime` files. COM is Windows-only. Linux builds the crate for tests and lints without registering handlers.[^shell]

# What does not link what

The stress crate does not link the slicer, and the slicer does not know about stress. Only `lime-sim-bridge` joins them.[^bridge] The modeling bridge is loaded at runtime, not linked into the slicer. See [Project rules](/conventions/project-rules.md) for the licence check around that split.

[^core]: crates/lime-slice-core/src/lib.rs
[^cli]: crates/lime-slice/Cargo.toml
[^bin]: crates/lime-slice/src/main.rs
[^model]: crates/lime-model/src/lib.rs
[^occt]: crates/lime-model-occt/src/lib.rs
[^load]: crates/lime-model-load/src/lib.rs
[^mcp-engine]: crates/lime-mcp-engine/src/lib.rs
[^sim]: crates/lime-sim/src/lib.rs
[^bridge]: crates/lime-sim-bridge/src/lib.rs
[^preview]: crates/lime-preview/src/lib.rs
[^shell]: crates/lime-shell/src/lib.rs
