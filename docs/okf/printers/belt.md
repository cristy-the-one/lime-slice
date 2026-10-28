---
type: Machine
title: Belt machines
description: A belt request lays the part flat, slices it with the planar pipeline, and maps moves back into the gantry frame.
tags: [printers, belt, fdm]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: belt-rs
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/belt.rs
    title: crates/lime-slice-core/src/belt.rs
  - id: slice
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/slice.rs
    title: crates/lime-slice-core/src/slice.rs
  - id: belt-ts
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/belt.ts
    title: src/belt.ts
  - id: library
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library.ts
    title: src/ui/machine-library.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-gpu-slicing.md
    title: docs/plan-gpu-slicing.md
---

# What a belt slice does

`belt.rs` says the nozzle plane is tilted to the belt by `angle`. The mesh is rotated about the across-belt axis until that plane is horizontal, the planar pipeline slices it, and emit maps the moves back into the gantry frame. A missing belt is not a belt: nothing in that module runs, and the cartesian writer is untouched. Belt advance per layer is `layer_height / sin(angle)`.[^belt-rs]

`prepare_belt` in `slice.rs` is "Lay the plate on the belt, and turn off the features that assume a flat bed." If `settings.compare` is set it returns "belt: compare is not supported yet".[^slice]

The UI's `defaultBelt` is 45 degrees, axis `z`, direction `+1`, unlimited length, one copy, 5 mm gap, and no raft. Angle 45 is described as a CR-30. The firmware axis comment says Z on a CR-30 and a BlackBelt. `beltSliceField` omits `maxLengthMm` when the belt is unlimited, sends `raftLayers` only when it is positive, and sends `floorSupports: true` when supports are on and the raft is off.[^belt-ts]

# Built-in belt printers

| id | name | bed (mm) | notes |
| --- | --- | --- | --- |
| `generic-belt-45` | Generic belt 45° | 200 × 200 × 200 | `kind: "belt"`, otherwise the shared cartesian defaults (volumetric 12, accel 5000) |
| `ideaformer-ir3-v2` | Ideaformer IR3 V2 | 250 × 250 × 250 | `kind: "belt"`, volumetric 12, accel 20000 |

The IR3 V2 comment says the limits were read from its `printer.cfg` through Moonraker on 2026-10-13: square corner velocity 8, minimum cruise ratio 0.5, extruder corner velocity 1, max velocity 400, max Z velocity 20, max Z accel 500. `firmwareArcs` is false because that config has no `[gcode_arcs]`. `maxBedC` is 90. `startOwnsHoming` is true. End G-code is `PRINT_END`. It is the only built-in printer with start and end G-code.[^library]

On a belt the README says the layer readout's Z is position along the belt, not height above the bed.[^readme]

# A single part's place

`docs/plan-gpu-slicing.md` section 10.6 records a behaviour change that is in this tree: a plate of one object no longer bakes the bed place into the mesh before laying it flat. The place across the belt is the emit offset. A plate of several objects still bakes both places, because their places relative to each other decide where they meet a nozzle plane. The same section says this changes G-code for a belt part that sits off the bed's centre across the belt, and that a part at the centre is unchanged.[^plan] See [Interactive slice](../live-slicing/interactive-slice.md) and [Project rules](../conventions/project-rules.md).

[^belt-rs]: crates/lime-slice-core/src/belt.rs
[^slice]: crates/lime-slice-core/src/slice.rs
[^belt-ts]: src/belt.ts
[^library]: src/ui/machine-library.ts
[^readme]: README.md
[^plan]: docs/plan-gpu-slicing.md
