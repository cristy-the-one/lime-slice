# Directory Update Log

## 2026-11-23

* **Update**: [Sketching and features](modeler/sketching.md) describes the organic-surfaces steps of 7.2.0 (S1 to S5): which the app has, which are MCP and recipe only, and what 7.1.2 does with a project that uses them. [Tool catalog](mcp/tools.md) describes `model_check {surfaces: true}` and the organic ops' refusals. The new sources point at the `feature/organic-surfaces` branch; pin them to the merge commit once it reaches main.

## 2026-11-21

* **Update**: [Simulation](stress/simulation.md) describes the Resist buckling goal, and [Tool catalog](mcp/tools.md) describes `goal.buckling`, `goal.on` and `plan.bucklingFactor`. The sources are on this branch; pin them to the merge commit once it reaches main.

## 2026-11-20

* **Update**: [Simulation](stress/simulation.md) describes the Higher frequency goal and resin vents, and [Tool catalog](mcp/tools.md) describes `goal.frequency`, `plan.frequencyHz`, `plan.frequencyFactor`, `plan.vents` and ribNet `openEnds`. The new sources are pinned to `03b1c1d6`.
* **Update**: the auto ribs and `draft` sources in [Sketching and features](modeler/sketching.md), [Simulation](stress/simulation.md) and [Tool catalog](mcp/tools.md) are pinned to `03b1c1d6`, the merge of `feature/ribs-next` into main (#775), and the text says 6.13.0. The frequency goal and resin vents of that round are not described here yet.
* **Update**: [Sketching and features](modeler/sketching.md) gains the `draft` op from `feature/ribs-next`. [Simulation](stress/simulation.md) gains the auto ribs additions (load cases, folded walls, moulding checks), and [Tool catalog](mcp/tools.md) gains `ribs_plan` and `ribs_apply`. New sources point at the `feature/ribs-next` branch, not a commit, because the facts land with that branch's close-out; pin them to the merge commit once it reaches main. The rest of the bundle still describes 4.2.0.

## 2026-10-29

* **Update**: [Test and CI](build/test-and-ci.md) gains "Target crashed" in a probe: the reported Split to print crash was a test-harness kill. It also covers the new real-kernel split spec in `test:engine`.

## 2026-10-28

* **Creation**: Established this bundle from commit `f7647943a2eb198144c9fcc4e499b5e4178e7ea5` (Lime Slice 4.2.0). No `okf/` directory, `.okf` file, or "Open Knowledge Format" text was on `origin/main`. A path search of all refs found no `okf` path either.
* **Update**: Made cross-links directory-relative, so the reference visualizer draws graph edges. Shortened titles to labels that match the index entries, and renamed the Belt printers index entry to Belt machines. The bundle stays on OKF v0.2, with `okf_version: "0.2"` and keyed footnotes.
