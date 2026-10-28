---
type: Feature
title: Parameters
description: A project can store named parameters. Expressions on steps and sketch sizes evaluate before the engine sees numbers.
tags: [modeler, parameters]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: project
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/project.ts
    title: src/project.ts
  - id: params
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/modeling/params.ts
    title: src/modeling/params.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# Where they live

A `.lime` project may carry `parameters`: named parameters, in evaluation order, each a number or an expression such as `"wallH / 2"`. The field is omitted when there are none. Older files keep the numbers under `mcpModel.params`. The MCP still reads that, and writes `parameters`.[1]

`mcpModel` is what the MCP server builds from, kept as it wrote it: named parameters, stored parts, and each object's `model_build` recipe. The app writes it back on save. History reads a recipe to show "Built by a recipe".[1]

# Evaluation

`src/modeling/params.ts` says parameters evaluate in order: a later name may use an earlier one. A bad row keeps its sentence and does not enter the table the later rows see. Expression text is stored beside a Model op and stripped to numbers before the engine sees the op.[2] The unknown-name sentence the app shows is "Add it in Parameters, or type a number." The comment says the MCP tool is never named in the app.[2]

The README says Parameters sit under History. A size field shows the evaluated number with an ƒ mark and keeps the expression. Rebuild replays the steps that use a changed parameter. A part an MCP recipe built shows "Built by a recipe", and that line stays read-only: changing the recipe's parameters and rebuilding from them is not in the window yet.[3]

Sketch driving dimensions can name a parameter. See [Sketching and features](sketching.md). Assembly member offsets and turns can carry expression text too. See [Assemblies](assemblies.md).

# Citations

[1] [src/project.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/project.ts)
[2] [src/modeling/params.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/modeling/params.ts)
[3] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
