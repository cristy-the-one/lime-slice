# Handover: what comes after automatic ribs 6.11.0

Written 2026-11-17 by the session that planned and built automatic ribs. For a second team: an Opus session that coordinates, and Grok 4.7 / 4.8 sessions that execute. It covers the six things `docs/plan-auto-ribs.md` lists as "not in the first version". Read that plan first; this document does not repeat it.

## 1. How this work is organised

- **Start point.** The work starts from `main` at the commit tagged `v6.11.0`. Nothing here starts before that tag exists: until then the first team is still changing the same files.
- **One feature branch.** All of it lives on a long-lived branch cut from that tag: `feature/ribs-next`. Nothing from this handover goes to `main` directly.
- **One branch per package.** Each package below gets its own branch off the feature branch (`ribs-next/<package>`) and lands by a pull request **into `feature/ribs-next`**, not into `main`.
- **The coordinator (Opus)** owns the feature branch: writes each task brief, reviews each diff and its numbers, merges package PRs into the feature branch, merges `main` into the feature branch at least weekly, and decides order. It writes no feature code itself.
- **The executors (Grok)** each take one task from a brief, on one package branch, and report back with numbers.
- **Reaching `main`.** When a package is complete on the feature branch, the coordinator opens a PR from a branch holding only that package to `main`, for the owner. The owner tags and publishes; nobody else does.

## 2. Rules of this repository that bind every session

Read `CLAUDE.md` and `.claude/skills/land-pr/SKILL.md`, `verify-ui/SKILL.md` before the first task. The ones that have cost time before:

- **Company parts never enter the repository**: no STEP files, meshes, pictures or numbers that identify one, in code, tests, docs or PR text. Tests use synthetic solids only.
- **Browser tests run in headless Chromium only**, never Edge or Chrome.
- **One heavy cargo build at a time**: `CARGO_BUILD_JOBS=4`, and a shared `CARGO_TARGET_DIR` so builds queue. If cargo says the directory is locked, wait.
- **Skip the workspace-wide `cargo test` locally**; CI runs it. Run the tests of the crate you changed, and clippy with `-D warnings --locked`.
- **Two guards that failed CI during 6.11.0**: a new file under `src/modeling/` must be added to the expected list in `src/modeling/index.test.ts`; a new kernel-backed MCP test must be added by name to the "MCP server against real Open CASCADE" job in `.github/workflows/ci.yml`.
- **New unit tests** go in `tools/unit-tests.txt`; new end-to-end specs go in `test:smoke`.
- **No version bump, tag or release** from this team.
- **Commit attribution** is the executing session's own line; never another model's.
- **A plan before a build.** Each package marked "study first" produces `docs/plan-<topic>.md` as a docs-only PR to the feature branch, and builds only after the coordinator accepts it.
- **Evidence in every PR**: before and after numbers, against an analytic value or a solid reference. "It works" is not evidence.
- **Say what was not done.** Every report ends with what is untested or rough.

## 3. What exists at the start (as of v6.11.0)

This document was written before the tag. On the day of writing, the first two rows were merged, the next two were in review, and the last two were being built. The table says what 6.11.0 is planned to contain: check it against the tag before the first task, and against the release notes for anything that shipped simpler.

| Piece | Where | What it does |
|---|---|---|
| Rib-network step `ribNet` | `src/modeling/rib-net.ts` | Ribs along paths on any wall, one History row; profiles straight, drafted, tee; guards that the outside never changes |
| Shell solver | `crates/lime-sim/src/shell/` | Thin wall as membrane plus plate-bending triangles, ribs as beams with a real cross-section; linear static only |
| Rib planner | `crates/lime-sim/src/shell/planner/` | Traces lines along bending directions, adds ribs by stiffness gained per material, prunes, sizes; zones, goals, progress, cancel; compares with thickening and an even grid |
| Wall extraction | `src/modeling/rib-wall.ts` | Picked faces to the planner's input: remeshed wall, thickness, borders held or free, zones, holds and loads |
| Engine call and MCP tools | `mcp/`, `crates/lime-sim-bridge` | Plan as a background job, apply as one step, optional Stress check before and after |
| Auto ribs panel | `src/` | Pick the wall, Run, preview, Apply |

Facts worth knowing before touching them:

- **The planner models one wall, held at its borders.** Borders where the wall runs on into the part are clamped. That is the largest simplification in the feature.
- **Ribs must run along mesh edges.** Candidate lines are cut into the mesh; a rib forced onto a regular grid's own edges came out 54 % too stiff.
- **A rib tied to the wall needs its own web-rotation unknown**, or it stiffens without limit as the mesh refines. Do not remove it.
- **Speed comes from many single-threaded factorisations in parallel.** A low-rank update of the factor was measured and lost by 50 times or more. Do not rebuild it without new evidence.
- **A T-rib is not more stiffness per gram than a taller straight rib.** It wins only where height is limited.
- **Stiffness numbers are relative**: the material cards are placeholders.
- **A fillet over a whole rib network ran past the kernel's time limit.** Flared roots are part of the rib section instead.

Check each of these against the code before relying on it; they were true when written.

## 4. The packages

Sizes: S is days for one executor, M one to two weeks, L more, with unknowns.

### A. Several loads at once (S, build)

- **Now**: the planner combines load cases by summed strain energy; the code path exists and has no tests. The tools and panel take one load, or even pressure.
- **Goal**: a user gives two or more load cases, each with a weight; ribs serve all of them; the report gives the stiffness factor per case.
- **Tasks**
  1. Tests for the existing combination: two opposed loads on one panel; assert both cases improve and neither is ignored.
  2. A worst-case mode beside the weighted sum: the goal must hold in every case.
  3. Carry cases through wall extraction, the engine call, the MCP tool, the panel.
- **Evidence**: per-case stiffness before and after; a case where single-load ribs fail the second load and multi-load ribs pass.
- **Risk**: load-aligned ribs are not optimal for mixed loads (the plan, section 2). State it in the guide; verify by the numbers, promise nothing.

### B. Buckling and vibration targets (L, study first)

- **Now**: linear static only. The existing Stress study refuses modal and buckling too.
- **Study questions**
  1. Mass matrix for the shell and the rib beam (consistent or lumped), including the web-rotation unknown.
  2. Geometric stiffness for the plate, membrane and beam elements from a static pre-stress.
  3. A sparse eigen solver for the lowest few modes: what the current linear algebra crate offers, or shift-invert Lanczos on the existing factor. Repeated eigenvalues are a known trap for optimisation.
  4. How a goal reads to a user: "first natural frequency above N Hz", "buckling load factor above N".
  5. Whether the greedy rib score extends: gain in the lowest eigenvalue per material.
- **Build order after the study**: vibration first (no pre-stress), buckling second.
- **Evidence**: plate natural frequencies and plate buckling loads against textbook values, with convergence; a ribbed panel against a solid reference.
- **Reserve**: CalculiX as a separate program is the fallback named in the plan, with licence duties. Use it only as a cross-check on a developer machine unless the owner decides otherwise.

### C. The whole part, not one wall held at its edges (L, study first)

The biggest gap to "automatic on any part".

- **Now**: one smooth wall; borders into the rest of the part are clamped; side walls are assumed stiff.
- **Study the options and pick one**
  1. **Many walls as one folded shell.** Extend wall extraction to take every thin region, joined at sharp edges. The solver already has six unknowns per node with a real drilling rotation, so folded shells should work; prove it on a box. Thick regions (bosses, solid rims) become stiff patches. Likely the cheapest route.
  2. **Condense the rest of the part.** Solve the wall as now, but replace the clamp by the stiffness of the neighbouring structure, from a coarse solve.
  3. **A true mid-surface of the whole solid.** The general answer and the hardest; nothing in the repository builds one.
- **Questions to answer with numbers**: how wrong is the clamped-border answer on a real cover shape (compare with a solid model of a synthetic cover: belly, side walls, rim); where do ribs move when the side walls are allowed to give; what does it cost in time.
- **Evidence**: an open box under a load on its floor, shell model against the existing solid solver.
- **Depends on**: nothing; affects A, B and D, so do the study early.

### D. A blend between ribs and local thickening (M, study first)

- **Now**: ribs only. Every plan reports the uniform thickening that reaches the same stiffness, as a comparison.
- **Why**: theory says a thicker wall wins where the wall is stretched, ribs where it bends. The measured case: on a curved, in-plane loaded wall, ribs barely beat thickening.
- **Study**: the published cell model that moves smoothly between ribs and wall (Gil-Ureta, Pietroni & Zorin 2020, linked in the plan) against a simpler route: "thicken this region by N" as another move in the same greedy loop.
- **Geometry is the hard part**: thickening a region of an imported solid inward, as an editable step. The kernel has an offset-faces step, but it cannot sit inside a grouped step today.
- **Evidence**: the curved wall case, ribs only against the blend, at equal stiffness.

### E. Process checks and small geometry (three S builds, independent)

1. **Moulding checks.** For the moulded preset: rib thickness against wall (60 % rule), height, draft, junction thickness as an inscribed circle. A report, not a simulation. An unbuilt note for this exists in `docs/plan-recipe-ingredients.md`.
2. **Draft on existing faces.** A kernel step using Open CASCADE's draft-angle tool; today draft exists only on new extrudes.
3. **Vent notches for resin.** Ribs can close pockets that trap resin; detect closed pockets facing the build plate and cut a notch through the ribs that close them. Formlabs gives 0.75 mm for a drain hole (linked in the plan).

### F. Rib planners as plugins (M, study first)

- **Now**: plugins can read faces, sections and rays and emit model steps, but cannot call the solver or the planner; limits are 30 s and 2,000 calls.
- **Study**: which calls a plugin needs (wall extraction, a solve, the planner, `ribNet`), what the sandbox limits mean for a plan that takes 5 to 20 s, and whether a plugin supplies a whole planner or only candidate lines for the built-in selection.
- **Evidence**: one sample plugin that lays an even grid through the same checks as the built-in planner.

## 5. Order and conflicts

- **First**: C's study and A in parallel. A is small and proves the team's route end to end. C's answer changes B and D.
- **Then**: B's study, D's study, and the three E builds, each independent of the others.
- **Last**: F, once the tool surface has settled.

Files more than one package will touch, so the coordinator sequences them:

| File or area | Packages |
|---|---|
| `crates/lime-sim/src/shell/model.rs`, `beam.rs` | B, C, D |
| `crates/lime-sim/src/shell/planner/select.rs` | A, B, D |
| `src/modeling/rib-wall.ts` | A, C |
| MCP tools and the panel | A, B, C, D |
| `crates/lime-model-occt` (kernel) | D, E2 |

## 6. How the coordinator briefs an executor

One task per brief. Each brief states:

1. **The goal in one sentence**, and what the user sees when it is done.
2. **The branch** to work on, and its base.
3. **What to read first**, by path. Notes from earlier sessions are pointers, not truth: verify.
4. **What is out of scope**, and which files another task owns.
5. **The tests that prove it**, with the reference each is measured against and the tolerance.
6. **The commands** to run, and the ones not to run.
7. **The report format**: what was built, each test with numbers, what was not done, the pushed commit.

What worked for the first team:

- **Probe before building.** A half-day probe of what the kernel could already do changed the geometry plan.
- **Ask for the finding, not the confirmation.** The most useful results were the ones that contradicted the brief: the low-rank update that lost, the T-rib that did not win.
- **Never loosen a test to make it pass.** Report the number and the diagnosis.
- **Check the claim at equal material.** A pattern "saves material" only against wall thickening and an even grid at the same stiffness.

## 7. Decisions that stay with the owner

- Publishing or tagging a release.
- Anything that would put company part data in the repository.
- Bundling a third-party solver, or anything else that changes what the installer ships.
- Defaults that change what an existing feature does.
- A patent search before the feature is advertised; none has been done.
