---
type: System
title: Overview
description: Lime Slice 4.2.0 is a filament slicer and a solid modeler in one window, with a Rust planner, a Tauri 2 shell, a browser UI, and an MCP server.
tags: [architecture, overview]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: cargo
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/Cargo.toml
    title: Cargo.toml
  - id: claude
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/CLAUDE.md
    title: CLAUDE.md
---

# What it is

Lime Slice 4.2.0 is a filament slicer and a solid modeler in one window. A Rust planner builds the toolpaths. Model edits go through Open CASCADE when its bridge is installed. The window is a Tauri 2 desktop app, and the same pages run in a browser against a local engine.[1]

The workspace version is 4.2.0, the licence field is MIT, and the Rust version is 1.88.0. Members are `lime-slice-core`, `lime-slice`, `lime-model`, `lime-model-occt`, `lime-model-load`, `lime-mcp-engine`, `lime-preview`, `lime-shell`, `lime-sim`, `lime-sim-bridge`, and `src-tauri`.[2]

The notes for agents describe the same product as a filament slicer and a solid modeler in one Tauri 2 window, with an MCP server. The owner tags releases and publishes them.[3]

# How the pieces sit

| Piece | Where it lives | Role |
| --- | --- | --- |
| FDM planner | [Engine](engine.md) | Mesh in, toolpaths and G-code out |
| Solid modeler | [Engine](engine.md) | STEP history through a dynamically loaded Open CASCADE bridge |
| Stress solver | [Simulation](../stress/simulation.md) | In-house linear static estimate, linked to the slicer only in `lime-sim-bridge` |
| Window | [UI](ui.md) and [Desktop shell](desktop.md) | Prepare, Preview, G-code, and Model |
| Agent API | [MCP server](mcp-server.md) | Stdio MCP, slicer in-process, files only inside a workspace folder |

There is no separate "Architecture" heading in the README. The component map is the Layout section.[1]

# Citations

[1] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
[2] [Cargo.toml](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/Cargo.toml)
[3] [CLAUDE.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/CLAUDE.md)
