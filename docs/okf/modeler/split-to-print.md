---
type: Feature
title: Split to print
description: A partition cuts one solid into pieces that fit a printer volume, with optional connectors, and can target the Form 4 for export.
tags: [modeler, split, partition]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: partition
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/modeling/partition.ts
    title: src/modeling/partition.ts
  - id: tree-ts
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-tree.ts
    title: src/model-tree.ts
  - id: kernel
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-occt/src/tree.rs
    title: crates/lime-model-occt/src/tree.rs
  - id: test
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-partition.test.ts
    title: src/model-partition.test.ts
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: card
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/split-print.ts
    title: src/ui/split-print.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# The operation

`PartitionModelOp` is a history op: cuts, an optional target, orient, arrange, labels, bed margin, and a piece cap.[2] The card is Features → Split to print, not a rail tool.[7] A target is `{ printer, process: "fdm" | "resin", volumeMm }`.[1] The Form 4 path is [Resin and the Formlabs Form 4](../printers/resin-form-4.md).

# Profiles

`Profile` kinds are `straight`, `lap`, `zigzag`, `tongue`, `dovetail`, and `sketch`.[1] `notBuiltYet` returns null for each of those, and the unit test names them as built. A profile kind outside that list is refused with `PROFILE_KIND`. Connectors turned on for a `tongue` or `dovetail` profile return `SHAPED_JOINTS_LATER`: "Connectors on a tongue or a dovetail cut are not built yet. Turn them off, or cut straight." Connectors on a lap, zigzag, or sketch are not refused by that function. The tests say connectors on a sketch, a zigzag, and a lap are built.[1] [4]

The kernel's profile sentence is "A cut's profile is straight, lap, tongue, zigzag, dovetail or sketch." It refuses connectors on a tongue or a dovetail cut with the same sentence.[3]

# Connectors

Connector types in the planner are `dowel`, `plug`, `hardware`, `key`, and `dovetail`.[1] The kernel's `joint_kind` maps those same five names. A key or a dovetail sends its width in the radius slot.[3] `notBuiltYet` does not refuse a key or a dovetail connector on a straight cut, and the test is named "a key and a dovetail connector are built".[4] The split card's type menu lists Dowel, Plug, Hardware hole, Key, and Dovetail.[6]

Two texts in the tree still say otherwise. The MCP schema's connector `type` description says "key, dovetail: not built yet."[5] The README's Split to print section still ends with "Not yet. A rectangular key, a dovetail, and shaped cuts (lap, zig-zag, tongue and groove)."[7] The planner, the kernel, the card, and `model-partition.test.ts` are the later statements.

Connectors are off by default. The schema says `{on:true}` is a dowel with every default.[5] The README describes dowel, plug, and hardware hole, teardrop holes on FDM when the axis is within 45° of horizontal, and clearance Snug, Loose, Press, or Typed.[7]

# Citations

[1] [src/modeling/partition.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/modeling/partition.ts)
[2] [src/model-tree.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-tree.ts)
[3] [crates/lime-model-occt/src/tree.rs](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-occt/src/tree.rs)
[4] [src/model-partition.test.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/model-partition.test.ts)
[5] [mcp/schema.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts)
[6] [src/ui/split-print.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/split-print.ts)
[7] [README.md](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md)
