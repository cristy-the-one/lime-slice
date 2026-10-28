---
type: Feature
title: Assemblies
description: An assembly is a tree of plate objects posed relative to each other. There is no mate solver.
tags: [modeler, assemblies]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: assembly
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/assembly.ts
    title: src/assembly.ts
  - id: app
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/app/assemblies.ts
    title: src/app/assemblies.ts
  - id: space
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-space.ts
    title: src/model-space.ts
  - id: project
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/project.ts
    title: src/project.ts
  - id: plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-assemblies.md
    title: docs/plan-assemblies.md
---

# The model

An assembly is a tree of members. One member is the root (`parent: null`): its pose is its own `modelPose`, and only the user moves it. Every other member sits at its parent's pose times its own `offset` and `turn`. The numbers are in the parent's own part frame: turned by Rx, then Ry, then Rz, then moved by the offset. Each number may carry expression text over the project's parameters. Solving walks the tree and writes each member's `modelPose`. That pose is what Model, joins, Explode, and the MCP read.[^assembly]

`ObjectFrame` is `"part"` or `"model"`. `"model"` is the default. Typed Model numbers are read in the part's own CAD frame when `frame` is `"part"`, otherwise in model space.[^space]

The project file comment lists `assemblies` as plate objects at poses relative to each other, and says an older app ignores the field. The current file shape described there is version 4.[^project]

# What the window does

`src/app/assemblies.ts` says the session's assemblies sit against the plate, a hand move carries a root's members or re-seats a member, Attach and Ungroup come from the object list, and the assembly view draws every object at its pose in model space on Prepare's viewport.[^app]

A part-frame member of an assembly that stands moved or turned opens in Model in its own frame: the inverse of its pose, so it stands as it was modelled and the other objects move around it. Anything else opens in model space. The comment marks that behaviour Assemblies M10.[^space]

# What it is not

`docs/plan-assemblies.md` is still marked "Status: plan, for review", written 2026-10-27 against main at v4.0.0. Its non-goals include no change to the G-code writer. The header of `src/assembly.ts` describes poses, not mates, and the file has no mate or degree-of-freedom solver.[^plan] [^assembly]

Interference between members is a separate check in the app module (`interference`, `exactVerdict`), not a constraint that moves parts.[^app]

[^assembly]: src/assembly.ts
[^app]: src/app/assemblies.ts
[^space]: src/model-space.ts
[^project]: src/project.ts
[^plan]: docs/plan-assemblies.md
