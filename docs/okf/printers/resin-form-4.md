---
type: Machine
title: Resin and the Formlabs Form 4
description: The Formlabs Form 4 is an export-only resin target for split to print. This app does not slice resin.
tags: [printers, resin, form-4, export]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: library
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library.ts
    title: src/ui/machine-library.ts
  - id: partition
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/modeling/partition.ts
    title: src/modeling/partition.ts
  - id: tree
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-model-occt/src/tree.rs
    title: crates/lime-model-occt/src/tree.rs
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
---

# Not a slicer target

`ExportPrinterRecord` is documented as a printer parts are cut for that this app does not slice for. `exportOnly` marks it. It is not a `PrinterRecord`, it is never in `printers`, and `enginePrinter` cannot take it.[^library]

The only such record is `FORMLABS_FORM_4`:[^library]

| field | value |
| --- | --- |
| id | `formlabs-form-4` |
| name | Formlabs Form 4 |
| exportOnly | true |
| process | `resin` |
| bed | 200 × 125 × 210 mm |
| material | Tough 2000 |

`exportOnlyRefusal` returns: "The Formlabs Form 4 is a resin printer this app cuts parts for and does not slice for. Choose it as a split to print's target, then export the pieces."[^library]

There is no resin, SLA, or MSLA slicer module in `lime-slice-core`. The FDM pipeline in [Pipeline](/slicing/pipeline.md) does not emit a resin job.

# Where it is used

Split to print's target type is `{ printer, process: "fdm" | "resin", volumeMm }`.[^partition] The kernel comment on a partition refusal says a resin target cuts, and its pieces are exported, not sliced.[^tree] The MCP `partition` target description says `{printer:"formlabs-form-4"}` (resin, exported) or a `machine_list` id.[^schema]

The README says the Form 4 is last in the split card's printer list. The planner fits each piece upright in the 200 × 125 × 210 mm volume and turns the part to fit when that gives fewer pieces. The pieces stay in Model. Prepare says "Split for the Formlabs Form 4 in Model, N parts. The plate prints it whole." Export writes STEP, a 3MF of every piece, or one STL per piece.[^readme] See [Split to print](/modeler/split-to-print.md).

`RESIN_FEATURE_MM` is 0.5 and `RESIN_LAYER_MM` is 0.1 in the partition defaults.[^partition] Those are fit numbers for the cut, not a slice layer height.

[^library]: src/ui/machine-library.ts
[^partition]: src/modeling/partition.ts
[^tree]: crates/lime-model-occt/src/tree.rs
[^schema]: mcp/schema.ts
[^readme]: README.md
