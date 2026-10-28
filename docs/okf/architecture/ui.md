---
type: Component
title: Web UI
description: The window is a web UI with four stages — Prepare, Preview, G-code, and Model. Stress is a section of the Model dock.
tags: [architecture, ui]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: main
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/main.ts
    title: src/main.ts
  - id: chrome
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/chrome.ts
    title: src/ui/chrome.ts
  - id: platform
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/platform.ts
    title: src/platform.ts
  - id: stress
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/stress.ts
    title: src/ui/stress.ts
  - id: commands
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/commands.ts
    title: src/ui/commands.ts
---

# Shell

The shell is the landscape layout: a tool rail on the left, a dock on each side, and a status line. Prepare and Preview use the left dock for settings and the right dock for results. Model uses the left dock for the open tool, the sketch, History, and Parameters, and the right dock for Inspect.[^readme]

`src/main.ts` boots the theme, mounts the views, and wires the app. `engineMode()` in `src/platform.ts` returns `"invoke"` inside Tauri and `"http"` in the browser.[^main] [^platform]

# Stages

The stage type is `"prepare" | "preview" | "gcode" | "model"`.[^chrome] Palette commands for those tabs are `tab-prepare`, `tab-preview`, `tab-gcode`, and `tab-model`.[^commands]

Prepare puts the model on the plate: move, turn, scale, and a strategy. Preview draws the toolpaths. A G-code tab shows the file. The stage defaults to Split: 2D toolpaths on the left and a 3D view on the right.[^readme] See [Pipeline](/slicing/pipeline.md) and [Profiles](/settings/profiles.md).

Model edits a STEP solid or starts one from a primitive or a sketch. Without the Open CASCADE bridge, Model stays off; an unedited STEP can still be sliced.[^readme] See [Sketching and features](/modeler/sketching.md).

Stress is not a stage. The stress module comment says it lives in the Model dock: a hold, a load, and a material card.[^stress] The command is `model-stress`.[^commands] See [Simulation](/stress/simulation.md).

Phone layout is `?layout=compact`, or Interface layout set to Compact. Auto uses it when the window is 600 px wide or less. It is the same web UI.[^readme]

[^readme]: README.md
[^main]: src/main.ts
[^chrome]: src/ui/chrome.ts
[^platform]: src/platform.ts
[^stress]: src/ui/stress.ts
[^commands]: src/ui/commands.ts
