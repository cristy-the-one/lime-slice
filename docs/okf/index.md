---
okf_version: "0.2"
---

# Lime Slice

Knowledge bundle for Lime Slice 4.2.0, written from the tree at commit `f7647943a2eb198144c9fcc4e499b5e4178e7ea5`. It follows [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md).

Concept files are UTF-8 Markdown with YAML frontmatter. `type` is required. This file is the bundle root: its only frontmatter key is `okf_version`. Nested `index.md` files and `log.md` have no frontmatter. A `sources[].resource` value is an absolute URL pinned to that commit; `sources[].title` is the path in the repository. A footnote label is a `sources[].id`.

`status` is `draft` on every concept. Nothing here is `verified`. The bundle was produced by reading the repository; it does not add behaviour the code does not have.

# Architecture

* [Overview](architecture/overview.md) - Lime Slice 4.2.0 is a filament slicer and a solid modeler in one window, with a Rust planner, a Tauri 2 shell, a browser UI, and an MCP server.
* [Engine](architecture/engine.md) - The Rust workspace plans FDM toolpaths, edits STEP solids, and runs the stress solver, and the crates do not all link each other.
* [UI](architecture/ui.md) - The window is a web UI with four stages — Prepare, Preview, G-code, and Model. Stress is a section of the Model dock.
* [Desktop shell](architecture/desktop.md) - The Tauri 2 app calls the engine in-process. The same pages talk to lime-slice serve over loopback HTTP.
* [MCP server](architecture/mcp-server.md) - One Node process speaks MCP on stdio and loads the slicer in-process. It does not send a job to a printer.

# Slicing

* [Pipeline](slicing/pipeline.md) - A slice request is loaded, cut, pathed, toured, combed, supported, assembled, and emitted as G-code, with the same core for the desktop, the browser, the CLI, and MCP.

# Printers

* [FDM machines](printers/fdm.md) - Built-in cartesian printers are the Lime 220, Lime 300, and Lime 180, with PLA, PETG, ABS, and TPU filaments.
* [Belt machines](printers/belt.md) - A belt request lays the part flat, slices it with the planar pipeline, and maps moves back into the gantry frame.
* [Resin and Form 4](printers/resin-form-4.md) - The Formlabs Form 4 is an export-only resin target for split to print. This app does not slice resin.

# Modeler

* [Sketching and features](modeler/sketching.md) - Sketches, constraints, and history ops live in the app and in the Open CASCADE bridge, which the shell loads only when it is built.
* [Parameters](modeler/parameters.md) - A project can store named parameters. Expressions on steps and sketch sizes evaluate before the engine sees numbers.
* [Split to print](modeler/split-to-print.md) - A partition cuts one solid into pieces that fit a printer volume, with optional connectors, and can target the Form 4 for export.
* [Assemblies](modeler/assemblies.md) - An assembly is a tree of plate objects posed relative to each other. There is no mate solver.

# Stress

* [Simulation](stress/simulation.md) - An in-house linear static solver estimates stress in millimetres, newtons, and MPa. It is not a certification.

# Live slicing

* [Interactive slice](live-slicing/interactive-slice.md) - The engine keeps slice stages in memory, can draw toolpaths before the tour finishes, and the UI can slice again after an edit.

# Settings

* [Profiles](settings/profiles.md) - Print settings, the machine library, and named settings profiles are separate stores. Factory print settings start at the speed strategy.

# MCP

* [Tool catalog](mcp/tools.md) - The server advertises 91 tools from mcp/schema.ts, in a core list plus eight groups.
* [GUI parity](mcp/gui-parity.md) - Model tools and MCP ops share src/modeling. The parity plan is still marked as a plan written at v2.8.1.

# Build

* [Test and CI](build/test-and-ci.md) - CI on pull requests to main runs Rust, the frontend, four Playwright smoke shards, MCP, a release bench, and OCCT link jobs. A docs-only diff skips the rest.

# Conventions

* [Project rules](conventions/project-rules.md) - What the repository actually states about byte-identical G-code, licences, network use, keyboard keys, and defaults.
