---
type: Reference
title: GUI parity
description: Model tools and MCP ops share src/modeling. The parity plan is still marked as a plan written at v2.8.1.
tags: [mcp, gui, parity]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-gui-mcp-parity.md
    title: docs/plan-gui-mcp-parity.md
  - id: features
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-features.ts
    title: src/model-features.ts
  - id: drag
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-drag.ts
    title: src/model-drag.ts
  - id: drag-test
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-drag.test.ts
    title: src/model-drag.test.ts
  - id: edit
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-edit.ts
    title: src/model-edit.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: commands
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/commands.ts
    title: src/ui/commands.ts
---

# The plan is still a plan

`docs/plan-gui-mcp-parity.md` opens with "Status: plan, for implementation by agents. Written 2026-10-18 against `main` at v2.8.1." Its goal is that everything an MCP session can do to a solid, a person can do in Model, with the same results, the same history, and the same `.lime` file. It says drawing 2D shapes and push/pull were out of scope for that plan.[^plan] This tree is 4.2.0. The plan file was not rewritten to say the work is finished. Treat the file as the original spec, and the modules below as what the code does now.

# What is shared

Composite feature tools (pocket, boss, texture, array, ribs, text) expand through `src/modeling` into a group of boolean steps, "the same pieces the MCP builds for the same solid and the same spec."[^features] `MODEL_TOOLS` lists those features next to the older tools: create, boolean, split, fillet, chamfer, hole, shell, scale, measure, place, workplane, check, pushpull, pattern, and mirror.[^drag] Sketch extrude, revolve, loft, and sweep are sketch-card operations, not entries in that list. See [Sketching and features](../modeler/sketching.md).

`hasPanel` returns true for extrude, revolve, and loft (a sweep is stored as a loft), for a `moveFaces` whose faces share one distance, and for a group that is a feature, a pattern, a mirror, a sketch extrude, a sketch revolve, or sketch holes. Other op kinds fall through to true. A group that is none of those, or a `moveFaces` with a distance per face, has no panel.[^edit]

`editRefusal` then says "This step has no edit panel yet. Delete it and apply it again with new numbers."[^edit]

The README says a part an MCP recipe built shows "Built by a recipe" and that line stays read-only: rebuilding from the recipe's parameters is not in the window yet.[^readme] See [Parameters](../modeler/parameters.md).

# Surfaces that are not the same

The desktop command `send-printer` is "Send to printer".[^commands] The MCP `session_info` description says "Nothing is sent to a printer."[^schema] There is no MCP tool with send in its name. See [MCP server](../architecture/mcp-server.md).

The browser stress panel refuses a solve outside the desktop app. MCP `sim_setup`, `sim_run`, `sim_field`, `sim_sweep`, and `sim_cancel` call the engine. See [Simulation](../stress/simulation.md) and [Tool catalog](tools.md).

The repository has no marker string "GUI only" or "MCP only". `src/model-drag.test.ts` says "Checklist: every toolbar tool has a viewport drag for every number its panel shows," and it checks that the toolbar's `data-tool` values and `MODEL_TOOLS` are the same set.[^drag-test]

[^plan]: docs/plan-gui-mcp-parity.md
[^features]: src/model-features.ts
[^drag]: src/model-drag.ts
[^drag-test]: src/model-drag.test.ts
[^edit]: src/model-edit.ts
[^readme]: README.md
[^schema]: mcp/schema.ts
[^commands]: src/ui/commands.ts
