---
type: Feature
title: Stress simulation
description: An in-house linear static solver estimates stress in millimetres, newtons, and MPa. It is not a certification.
tags: [stress, simulation]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
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

The Model dock section is a hold, a load, and a material card. Faces are picked on the part. Run does not draw the canned beam; that field is a Playwright fixture only.[^ui] In the browser, with no test hook, `solveStudy` returns "The stress solve runs in the desktop app."[^desktop] MCP `sim_run` goes through the engine, not that browser sentence. See [Tool catalog](/mcp/tools.md).

The README's worked example is a 100 × 10 × 10 mm box, 100% infill, one end held and the other loaded with 20 N, PLA card, 1.5 mm cells, and it says `mcp/sim-paint.test.ts` checks the numbers. It also says the four cards are placeholders, so for now every result is `rough`, and that a second solve within 5% is `converged`, within 15% is `usable`, and otherwise `rough`.[^readme]

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
