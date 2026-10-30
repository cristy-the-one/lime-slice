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
  - id: shift
    resource: https://github.com/cristy-the-one/lime-slice/blob/main/src/modeling/profile-shift.ts
    title: src/modeling/profile-shift.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# The operation

`PartitionModelOp` is a history op: cuts, an optional target, orient, arrange, labels, bed margin, and a piece cap.[^tree-ts] The card is Features → Split to print, not a rail tool.[^readme] A target is `{ printer, process: "fdm" | "resin", volumeMm }`.[^partition] The Form 4 path is [Resin and the Formlabs Form 4](../printers/resin-form-4.md).

# Profiles

`Profile` kinds are `straight`, `lap`, `zigzag`, `tongue`, `dovetail`, and `sketch`.[^partition] `notBuiltYet` returns null for each of those, and the unit test names them as built. A profile kind outside that list is refused with `PROFILE_KIND`. Connectors turned on for a `tongue` or `dovetail` profile return `SHAPED_JOINTS_LATER`: "Connectors on a tongue or a dovetail cut are not built yet. Turn them off, or cut straight." Connectors on a lap, zigzag, or sketch are not refused by that function. The tests say connectors on a sketch, a zigzag, and a lap are built.[^partition] [^test]

The kernel's profile sentence is "A cut's profile is straight, lap, tongue, zigzag, dovetail or sketch." It refuses connectors on a tongue or a dovetail cut with the same sentence.[^kernel]

# Shift and thin walls

A lap, a zig-zag, a tongue and a dovetail take `shift`, millimetres the profile slides along the cut without moving the cut: a zig-zag's teeth along U (a phase, modulo the pitch), a lap's step along V from its height, a tongue across V, a dovetail across its slide. 0 and absent are the placement before shifts; `"auto"` picks the shift that leaves the thickest walls, up to three floors, nearest 0. The card's Shift field is empty for Auto, and the profile has an arrow that drags it.[^shift] [^card]

No piece keeps a wall under the floor (the process's wall floor, at least 0.8 mm), read on the section at the cut and at the profile's depth; a thin stretch shorter than two floors along the cut line is a corner, not a wall. When no shift clears every wall, a zig-zag's tooth is flattened onto the cut plane (or the gap between two filled), stored as the zig-zag's `chain`, which the kernel cuts as a sketch's; a tongue or a dovetail is moved, then shortened; a lap is moved; a profile with no place at all is stored `{kind: "straight", wanted}`. One sentence says what changed. The stored op keeps `shiftAuto: true` for Auto, and a replay reads only `u0`, `at` and `v`, so old projects build the same solids.[^shift] [^kernel]

# Connectors

Connector types in the planner are `dowel`, `plug`, `hardware`, `key`, and `dovetail`.[^partition] The kernel's `joint_kind` maps those same five names. A key or a dovetail sends its width in the radius slot.[^kernel] `notBuiltYet` does not refuse a key or a dovetail connector on a straight cut, and the test is named "a key and a dovetail connector are built".[^test] The split card's type menu lists Dowel, Plug, Hardware hole, Key, and Dovetail.[^card]

Two texts in the tree still say otherwise. The MCP schema's connector `type` description says "key, dovetail: not built yet."[^schema] The README's Split to print section still ends with "Not yet. A rectangular key, a dovetail, and shaped cuts (lap, zig-zag, tongue and groove)."[^readme] The planner, the kernel, the card, and `model-partition.test.ts` are the later statements.

Connectors are off by default. The schema says `{on:true}` is a dowel with every default.[^schema] The README describes dowel, plug, and hardware hole, teardrop holes on FDM when the axis is within 45° of horizontal, and clearance Snug, Loose, Press, or Typed.[^readme]

[^partition]: src/modeling/partition.ts
[^shift]: src/modeling/profile-shift.ts, and `placeShaped` in src/split-print.ts; docs/plan-split-connectors.md section 32
[^tree-ts]: src/model-tree.ts
[^kernel]: crates/lime-model-occt/src/tree.rs
[^test]: src/model-partition.test.ts
[^schema]: mcp/schema.ts
[^card]: src/ui/split-print.ts
[^readme]: README.md
