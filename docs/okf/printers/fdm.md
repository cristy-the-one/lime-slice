---
type: Machine
title: FDM printers
description: Built-in cartesian printers are the Lime 220, Lime 300, and Lime 180, with PLA, PETG, ABS, and TPU filaments.
tags: [printers, fdm, filament]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: library
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library.ts
    title: src/ui/machine-library.ts
  - id: kind
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/belt.ts
    title: src/belt.ts
  - id: strategy
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/strategy.rs
    title: crates/lime-slice-core/src/strategy.rs
  - id: core
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/lib.rs
    title: crates/lime-slice-core/src/lib.rs
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# Kinds

`PrinterKind` is `"cartesian" | "belt"`.[^kind] The Rust core has no printer-kind enum. A cartesian request simply omits `belt`. See [Belt printers](/printers/belt.md).

The planner is FDM. `lime-slice-core`'s module line is "mesh in, strategy-blended FDM toolpaths and G-code out."[^core] The CLI about line is "Lime Slice FDM slicer".

# Built-in machines

`builtinPrinters()` returns five records. The cartesian ones are:[^library]

| id | name | bed X, Y, Z (mm) | max volumetric (mm³/s) | max accel |
| --- | --- | --- | --- | --- |
| `lime-220` | Lime 220 | 220, 220, 250 | 12 | 10000 |
| `lime-300` | Lime 300 | 300, 300, 320 | 15 | 5000 |
| `lime-180` | Lime 180 | 180, 180, 180 | 8 | 2000 |

Each starts as `kind: "cartesian"`, `firmware: "klipper"`, empty start and end G-code, `maxBedC` 120, and `maxNozzleC` 300, except the IR3 V2 row described in [Belt printers](/printers/belt.md).[^library]

# Filaments

`builtinFilaments()` returns PLA, PETG, ABS, and TPU, all 1.75 mm. Densities are 1.24, 1.27, 1.04, and 1.21 g/cm³. Nozzle and bed temperatures are PLA 200/60, PETG 240/80, ABS 250/100, and TPU 230/40. Cost per kg is 20, 25, 25, and 35. Flow starts at 1. Linear advance starts at 0. Pressure advance is a per-nozzle table on the record, and the comment says those numbers are starting values, not a vendor table.[^library]

Fan defaults are applied by material. The README says the built-in fan numbers come from OrcaSlicer's generic profiles: PLA and TPU 100/100 % with 1 layer off, ABS 10/80 % with 3 layers off, PETG 20/100 % with 3 layers off.[^readme]

# Strategies

The engine's `StrategyId` is `Speed` or `Toughness`. A blend is `Single`, `Weight` (toughness 0 is pure speed, 1 is pure toughness), `ByLayer`, or `ByRegion`. The default blend is a single speed strategy. The infill-pattern comment says speed uses lightning, a mid weight uses lines then grid, and toughness uses gyroid.[^strategy] The settings UI names that mid weight Efficiency. See [Profiles](/settings/profiles.md).

[^library]: src/ui/machine-library.ts
[^kind]: src/belt.ts
[^strategy]: crates/lime-slice-core/src/strategy.rs
[^core]: crates/lime-slice-core/src/lib.rs
[^readme]: README.md
