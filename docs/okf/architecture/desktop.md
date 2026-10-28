---
type: Component
title: Desktop shell
description: The Tauri 2 app calls the engine in-process. The same pages talk to lime-slice serve over loopback HTTP.
tags: [architecture, tauri, desktop]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: conf
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.conf.json
    title: src-tauri/tauri.conf.json
  - id: lib
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/lib.rs
    title: src-tauri/src/lib.rs
  - id: bridge
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/bridge.rs
    title: src-tauri/src/bridge.rs
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: windows
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.windows.conf.json
    title: src-tauri/tauri.windows.conf.json
  - id: macos
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.macos.conf.json
    title: src-tauri/tauri.macos.conf.json
  - id: occt
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.occt.json
    title: src-tauri/tauri.occt.json
  - id: shell
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.shell.json
    title: src-tauri/tauri.shell.json
  - id: crt
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.crt.json
    title: src-tauri/tauri.crt.json
---

# App identity

`tauri.conf.json` sets `productName` to Lime Slice, `identifier` to `com.limeslice.slicer`, and `version` to 4.2.0. The dev server is `http://127.0.0.1:43117`. The window `main` is 1440×900, minimum 960×640, with `decorations` false. The base bundle target is `deb`, and `.lime` is a file association.[1]

Platform overlays replace the bundle target: Windows `nsis`, macOS `dmg`. `tauri.occt.json` bundles `resources/occt/` and `resources/mcp/`. `tauri.shell.json` bundles `lime_shell.dll` and an NSIS hook. `tauri.crt.json` bundles the MSVC CRT DLLs beside the executable.[5] [6] [7] [8] [9]

# Commands

`slice_model` runs `slice_payload_watched` from `lime-slice-core` and emits `slice-progress`. `sim_study` calls `lime_sim_bridge::study_json`. `model_tree` calls `lime_model_load::tree`. Setup adds the OCCT search directory, registers the STEP mesher, and starts the live bridge.[2]

Inside Tauri the UI calls `slice_model` instead of HTTP. In the browser, `cargo run -p lime-slice --release -- serve` listens on `127.0.0.1:43118`. A new slice supersedes the one in flight.[4]

# Live bridge

The bridge is off unless `LIME_BRIDGE` is `1`, `true`, or `yes`, and `LIME_BRIDGE_TOKEN` is non-empty. The listener is `127.0.0.1` only. `LIME_BRIDGE_PORT` defaults to 43119. A matching POST is emitted as the `lime-bridge` event after any token field is removed. A body `{"open": "<path>"}` is not mirrored: the window opens that file.[3] The MCP side points at that listener with `LIME_MCP_BRIDGE` and the same token. See [MCP server](mcp-server.md).

# Citations

[1] [src-tauri/tauri.conf.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.conf.json)
[2] [src-tauri/src/lib.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/lib.rs)
[3] [src-tauri/src/bridge.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/bridge.rs)
[4] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
[5] [src-tauri/tauri.windows.conf.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.windows.conf.json)
[6] [src-tauri/tauri.macos.conf.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.macos.conf.json)
[7] [src-tauri/tauri.occt.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.occt.json)
[8] [src-tauri/tauri.shell.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.shell.json)
[9] [src-tauri/tauri.crt.json](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/tauri.crt.json)
