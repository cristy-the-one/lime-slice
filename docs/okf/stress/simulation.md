---
type: Feature
title: Simulation
description: An in-house linear static solver estimates stress in millimetres, newtons, and MPa. It is not a certification.
tags: [stress, simulation]
status: draft
generated: { by: claude/opus, at: 2026-11-20T12:00:00Z }
sources:
  - id: sim
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/lib.rs
    title: crates/lime-sim/src/lib.rs
  - id: element
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/element.rs
    title: crates/lime-sim/src/element.rs
  - id: error
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/error.rs
    title: crates/lime-sim/src/error.rs
  - id: recipe
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/src/recipe.rs
    title: crates/lime-sim/src/recipe.rs
  - id: cargo
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim/Cargo.toml
    title: crates/lime-sim/Cargo.toml
  - id: bridge
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-sim-bridge/src/lib.rs
    title: crates/lime-sim-bridge/src/lib.rs
  - id: study
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sim/study.ts
    title: src/sim/study.ts
  - id: cards
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sim/cards.ts
    title: src/sim/cards.ts
  - id: ui
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/stress.ts
    title: src/ui/stress.ts
  - id: desktop
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sim/desktop-solve.ts
    title: src/sim/desktop-solve.ts
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: ribs-tool
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/mcp/session/ribs.ts
    title: mcp/session/ribs.ts (03b1c1d6)
  - id: ribs-panel
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/auto-ribs.ts
    title: src/auto-ribs.ts (03b1c1d6)
  - id: rib-wall
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/modeling/rib-wall.ts
    title: src/modeling/rib-wall.ts (03b1c1d6)
  - id: moulding
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/modeling/moulding.ts
    title: src/modeling/moulding.ts (03b1c1d6)
  - id: frequency
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/crates/lime-sim/src/shell/planner/frequency.rs
    title: crates/lime-sim/src/shell/planner/frequency.rs (03b1c1d6)
  - id: vents
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/modeling/vents.ts
    title: src/modeling/vents.ts (03b1c1d6)
  - id: planner
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/crates/lime-sim/src/shell/planner/mod.rs
    title: crates/lime-sim/src/shell/planner/mod.rs (03b1c1d6)
  - id: ribnet
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/src/modeling/auto-ribs.ts
    title: src/modeling/auto-ribs.ts (03b1c1d6)
  - id: ribs-schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/03b1c1d6fcdd995bf5b67cf9b65f5ecabfe1a289/mcp/schema.ts
    title: mcp/schema.ts (03b1c1d6)
---

# Solver

`lime-sim` is an in-house linear static stress solver. Length is millimetres, force is newtons, stress and modulus are MPa. The module says the result is an in-house estimate, not a certification. The driver loops over load steps and iterations even when a study has one linear step. A post-step hook exists, and the only implementation returns "A post-step is not in this version."[^sim]

`ElementKind` names `tet4`, `tet10`, `hex8`, `hex20`, `wedge6`, `wedge15`, and `shell-quad`. The module says TET10 is the element a study may ask for. TET4 stays for the patch test and the locking regression; a study that names it is refused. Other named kinds parse so a file can say them, and `nodes()` for anything other than the two tetrahedra is 0.[^element] The refusal sentence is "This study uses quadratic tetrahedra. Linear tetrahedra lock in bending."[^error]

Other refusal sentences in `error.rs`: "This part is not held. Fix a face, or the bed.", "Temperature is not in this version.", "Modal analysis is not in this version.", and "A bead-by-bead model is not in this version."[^error] A modifier or painted reinforcement on a smear recipe is refused with "Modifier and reinforcement regions are not in this version." The smear module says the solver never plans a bead.[^recipe]

The optional `gpu` feature is "the iterative check's smoothing on a GPU through wgpu." It is off in `lime-sim` itself so the solver's tests stay quick to build. A machine without an adapter solves on the CPU. The desktop crate and `lime-mcp-engine` both depend on `lime-sim-bridge` with the `gpu` feature.[^cargo]

# Representations

`SimRepresentation` is `sliced` or `smear`. The comment says `sliced` is the printed part and `smear` is the generated-beam solve. Absent means choose again at run time.[^study]

`lime-sim-bridge` slices one object with `lime-slice-core`, turns its beads into a `slice-field-1`, and runs a study of the part as sliced. Points a caller sends or reads are in the model frame, before the pose put the object on the plate. The Tauri command and the MCP engine both call `study_json`.[^bridge]

Holds are `bed`, `faces`, or `plane`. Loads are `force` or `pressure`. Fields the UI names are `vonMises`, `displacement`, and `safety`. Trust words are `rough`, `usable`, and `converged`.[^study]

# Materials and the panel

`provisionalCards()` returns four cards: `inhouse-pla`, `inhouse-petg`, `inhouse-abs`, and `inhouse-tpu`. The file says the numbers are placeholders so a study has units, they are not a data sheet, and a solve that uses one stays rough. Densities match the filaments. The moduli are not copied from a vendor, a paper, or another slicer. The comment says no other polymer is invented.[^cards]

The Model dock section is a hold, a load, and a material card. Faces are picked on the part. Run does not draw the canned beam; that field is a Playwright fixture only.[^ui] In the browser, with no test hook, `solveStudy` returns "The stress solve runs in the desktop app."[^desktop] MCP `sim_run` goes through the engine, not that browser sentence. See [Tool catalog](../mcp/tools.md).

The README's worked example is a 100 × 10 × 10 mm box, 100% infill, one end held and the other loaded with 20 N, PLA card, 1.5 mm cells, and it says `mcp/sim-paint.test.ts` checks the numbers. It also says the four cards are placeholders, so for now every result is `rough`, and that a second solve within 5% is `converged`, within 15% is `usable`, and otherwise `rough`.[^readme]

# Auto ribs additions

Automatic ribs (6.11.0) plan ribs on one wall with a thin-shell model in `lime-sim`. 6.13.0 adds these, in the panel and in `ribs_plan`:

* **Load cases.** Up to 8 named cases, each with a weight (default 1) and its own loads, weighed as Σ wᵢ·Cᵢ/Cᵢ⁰. The result gives each case's stiffness factor and its bare and ribbed deflection. No two cases share a name: the tool refuses it, the panel adds " (2)".[^ribs-tool] [^ribs-panel]
* **Folded walls.** `wall.folded` (the panel's "Include side walls (folded)", off by default) takes thin faces across sharp edges into one folded shell, with thick regions kept as stiff patches.[^rib-wall]
* **Moulding checks.** With the moulded process, a report of six rules (base 0.6 × wall, root radius 0.25–0.5 × wall, height 3 × wall, draft 0.5°, junction circle 1.2 × wall, spacing 2 walls) with flags per rib. It changes nothing. Without a pull direction each rib is read along its own wall, and a folded wall says so in the report's notes.[^moulding]
* **Higher frequency.** The panel's Higher frequency choice raises the lowest natural frequency. Its slider stops are ×1.15, ×1.3, ×1.5, ×1.75 and ×2; stop 0, in the middle, is ×1.5. The default quantity is stiffness.[^ribs-panel] [^frequency] The result shows hertz before and after (`frequencyHz.bare` and `frequencyHz.ribbed`) and the ratio (`frequencyFactor`).[^ribs-tool] [^frequency] A load that misses the wall is ignored, and the note names it. A hold that misses is still refused.[^ribs-tool] [^ribs-panel] A plan has one goal: `frequency` beside another goal key is refused.[^ribs-panel] [^ribs-schema]
* **Resist buckling.** The panel's Resist buckling choice asks the wall to hold the load by a factor. Its slider stops are ×1.5, ×2, ×3, ×4 and ×5; stop 0, in the middle, is ×3. 1× buckles exactly at the load.[^ribs-panel] The result shows the load factor before and after (`bucklingFactor.bare` and `bucklingFactor.ribbed`).[^ribs-tool] With two or more load cases the card says Against case and buckling is solved for that one case. A load with no compression along the wall is refused. Every result says the number is the ideal buckling load. A plan has one goal: `buckling` beside another goal key is refused, and a factor below 1 is refused.[^ribs-panel] [^ribs-schema]
* **Resin vents.** A resin plan that closes a pocket cuts one full-height notch, 0.75 mm wide.[^vents] [^ribs-schema] The ribNet path sets `openEnds` on a gap end, so that end stays square: a vent notch, not run into the facing rib and not tapered.[^ribnet] [^ribs-schema] `plan.vents` lists the pockets that were cut and the pockets that were not.[^ribs-tool] When projected chords cross and stay more than 1 mm apart, the wall is a fold and venting is left undone; the note says so. Borders are dropped onto the rib plane before that check.[^vents] Filament and moulded plans send no vent fields, so those plans are unchanged.[^vents] [^ribs-tool] [^planner] A frequency plan is not notched: it returns no vents, and when venting was asked it notes that venting was skipped.[^frequency]

`ribs_apply` with `verify` runs the sliced study once per load case, before and after.[^ribs-tool] See [Tool catalog](../mcp/tools.md).

[^sim]: crates/lime-sim/src/lib.rs
[^element]: crates/lime-sim/src/element.rs
[^error]: crates/lime-sim/src/error.rs
[^recipe]: crates/lime-sim/src/recipe.rs
[^cargo]: crates/lime-sim/Cargo.toml
[^bridge]: crates/lime-sim-bridge/src/lib.rs
[^study]: src/sim/study.ts
[^cards]: src/sim/cards.ts
[^ui]: src/ui/stress.ts
[^desktop]: src/sim/desktop-solve.ts
[^readme]: README.md
[^ribs-tool]: mcp/session/ribs.ts (03b1c1d6)
[^ribs-panel]: src/auto-ribs.ts (03b1c1d6)
[^rib-wall]: src/modeling/rib-wall.ts (03b1c1d6)
[^moulding]: src/modeling/moulding.ts (03b1c1d6)
[^frequency]: crates/lime-sim/src/shell/planner/frequency.rs (03b1c1d6)
[^vents]: src/modeling/vents.ts (03b1c1d6)
[^planner]: crates/lime-sim/src/shell/planner/mod.rs (03b1c1d6)
[^ribnet]: src/modeling/auto-ribs.ts (03b1c1d6)
[^ribs-schema]: mcp/schema.ts (03b1c1d6)
