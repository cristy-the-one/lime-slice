# Architecture

* [Overview](overview.md) - Lime Slice 4.2.0 is a filament slicer and a solid modeler in one window, with a Rust planner, a Tauri 2 shell, a browser UI, and an MCP server.
* [Engine](engine.md) - The Rust workspace plans FDM toolpaths, edits STEP solids, and runs the stress solver, and the crates do not all link each other.
* [UI](ui.md) - The window is a web UI with four stages — Prepare, Preview, G-code, and Model. Stress is a section of the Model dock.
* [Desktop shell](desktop.md) - The Tauri 2 app calls the engine in-process. The same pages talk to lime-slice serve over loopback HTTP.
* [MCP server](mcp-server.md) - One Node process speaks MCP on stdio and loads the slicer in-process. It does not send a job to a printer.
