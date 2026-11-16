# Clock feedback: what gets built, in what order

Status: plan after 6.9.0. Source: the owner's note `lime-slice-feedback.md` from the cute-clock experiment (two builder
agents and two reviewer agents working only through MCP, on 6.7.0 and 6.8.1). Item numbers below are that note's.

Every item was checked against the code at 6.9.0 by reading it. Nothing was run for the triage, so "cause" means the
code path that explains the report, and "inferred" marks the places where the path was reasoned and not seen.

The note's own standard applies here: an agent acts on the sentence it is given, so a sentence that is not true is a
defect of the same weight as a wrong number.

## 1. What the triage found that differs from the note

- **3.7 per-object infill exists.** `settings_set {object, values:{infill, walls, speed}}` works and saves with the
  project, and did in 6.8.1. `settings_schema` and `overrides_list` did not show it, so two agents concluded it was
  missing. The fix is to show it.
- **1.2 autosaves.** Another project's autosave is shelved into `autosaves/`, not overwritten, since 6.8.0.
  `autosave-previous.lime` is the restore offer and stays as it is.
- **3.10 assembly recipes.** A recipe can already declare every coupling kind and pose with `until` over MCP, through
  `Session::call("model_place", …)` (inferred: no test covers it). What is missing is typed wrappers, docs, and `until`
  in the window's host.
- **4.8 versioning from a dry run** is already possible with `nugget {action:"save", source, id}`; it was blocked only
  by the id-from-title rule.
- **4.11 thin-wall false readings** were most likely fixed in 6.8.0 by the 45° facing rule. The cannon repro should be
  run again before more is done.
- **2.2 "a true hanging-still start"** would always answer "no": a Graham escapement posed at static rest does not
  start in a deterministic model. The useful numbers are the release angle and the smallest push that starts it.
- **2.4 "compare rest and push under converged"**: when the two runs disagree the run has not settled, or there are two
  attractors. That is reported under settled, not under the time-step check.
- **2.7** refuses on overlap between a pallet and a tooth, not on "phase differs from the anchor's rest": any phase
  without overlap is a legitimate start.
- **4.5** is worse than "missing": `drive.radius` with a declared winch appears to count the drive twice (read, not
  run).
- **2.11 lay-flat** is not made belt-aware. The belt is flat under the part; which end leads is a separate option.

## 2. Wave 1: fixes, no new concepts (in progress)

Seven changes, one PR each, built by sub-agents and reviewed before they are pushed.

| PR | Items | What changes |
|---|---|---|
| Long calls | 1.1, 3.5 (smallest step), 2.15, 4.9 | Sweeps and `until` yield, report progress and become jobs when long. A sweep ignores pairs that cross at its start pose, and takes `ignore:[pairs]`. |
| `motion_run` verdicts | 2.1–2.8, 2.14, 2.15, 4.3, 4.5 | Verdicts and sentences derived from the run's own history. No change to the physics. |
| Plans and projects | 1.3, 1.4, 4.1, 4.7, 4.9, 2.15 | `project_save` after `override_remove`, `plan_run {path}`, chosen step results, plan progress, single-object export, a size breakdown in the save reply. |
| Animations | 2.13, 4.6 | `ignore:[pairs]` in the animation's crossing report; part colours and a framing box on `pose_animate` and `motion_run` output. |
| Settings | 2.9 (text), 2.10, 3.7, 3.8, 3.11 (density) | Per-object supports reach the slice (window too); per-object settings are listed; `model_mass {part:true}`. |
| Belt check | 2.11, 3.12 (faces), 4.11 (angle) | `model_check` judges overhangs in the belt's build direction and names the faces. Flat-bed results unchanged. |
| Naming and docs | 4.8, 4.10 | Plugin id from `name`; colour-only members optional; the slide-joint refusal names the field; horology docs. |

Replies that existing users see will change in the `motion_run` PR: "runs" for a decaying pendulum becomes "swings,
decaying"; `selfStarts` is qualified by the release angle; run-time hours change on drum-led winches.

## 3. Wave 2: needs a decision first

Each of these adds a concept. They are listed in the order proposed, with the decision that is the owner's.

### 3.1 Per-joint pivots and per-part density (note 3.1) — medium

Pin radius and friction per joint, density per part, in place of one value for the assembly. They enter where the
model already has globals (`src/dynamics.ts`: density per part, pin friction `μ·r·load·g`). The per-arbor energy lines
from wave 1 then show each pivot's share.

Decisions:
- Where the values live. **Proposed:** saved on the joint and on the part (so a project carries them and Pose shows
  them), with `motion_run` arguments able to override for one run. The alternative is arguments only.
- What `friction` and the friction sweep mean then. **Proposed:** they scale every joint that has no value of its own.

### 3.2 Springs, then a knife edge (note 3.2) — medium

A torsion or suspension spring is a stiffness on a hinge: one term in the force and one in the potential. It fits the
model exactly. A knife edge's loss is a rolling-resistance length, which is what the builders' "equivalent radius"
already stood in for; it becomes a joint property with that name.

Decision: whether a knife edge's rolling geometry (the pivot moving as it rocks, a rate effect estimated at about
15 s/day for the clock's 0.05 mm edge, not computed) is in scope. **Proposed:** loss only, with the geometric effect
stated as left out.

Not proposed now: the click spring. It needs parts hinged on moving parts, which the reduced model refuses today, and
is a multibody design of its own.

### 3.3 Crutch coupling (note 3.4) — medium

A coupling between two coaxial hinges with an offset angle and a play band. The anchor becomes its own coordinate; the
swing is measured on the pendulum and the escapement fit stays on the anchor. Needs wave 1's per-side amplitudes for a
beat-error measure.

Decisions: beat error reported in degrees or milliseconds (**proposed:** both); how Pose shows the play.

### 3.4 Declared fits (note 3.5, 2.13) — medium

`fits:[{a, b, kind: press | friction | running, mm}]` on the assembly, set with `model_place {fit}`. The sweep, the
animation report and `model_check {interference}` read it and say "press 0.05 (declared)" in place of a crossing.
Wave 1's `ignore` lists remain for one-off cases.

Not proposed now: typed hardware (pins, screws, bearings as parts with a fit class). It needs its own plan and a
recipe API level.

### 3.5 Escapement teeth a nozzle can print (note 3.6) — large

`tip_land(mm)` on `EscapeWheel` and the matching pallet corner land, default 0 so existing outlines stay bit-identical;
the dynamics then carry two contact points a tooth. It touches the Rust outline, its TypeScript port, the contact
model, the fit, the built-in escape wheel, and needs recipe API 1.18. Several tests pin today's numbers bit for bit.

A cheap first step, if wanted before the full change: a check that refuses or warns when a tooth nose is narrower than
the nozzle. It does not correct the optimistic lock and drop; only simulating the landed outline does.

Decision: full change, check only, or both in that order. **Proposed:** both, check first.

### 3.6 Tooth loads and mesh friction (note 3.3) — large, highest risk

The reduced-coordinate model does not compute the torque through each mesh, so pin loads and mesh losses from tooth
forces are missing; both reviewers stood them in with a lighter drive weight. Adding them means a torque balance down
the train each step, pin load as the vector sum of weight and tooth forces, and a load-dependent loss per mesh.

Decisions: lagged by one step or solved within the step; the efficiency formula for cycloidal teeth; the default mesh
friction. This gets its own plan document before any code. It is the item that most changes whether "it runs" can be
trusted for a printed clock, and the one most able to produce confident wrong numbers if rushed.

### 3.7 Smaller capabilities

| Item | What | Size | Note |
|---|---|---|---|
| 2.12 | `gcode_summary`: skin over infill reported apart from real overhangs | medium, Rust | changes the golden hold numbers' shape; additive field |
| 2.9 | a per-object Z range | medium | engine wire, overrides, the window's range UI |
| 3.10 | typed `couple()` and `turn_until()` in the recipe API; `until` in the window's host | small + medium | API 1.18 |
| 4.2 | arithmetic in plans: `"=$2.angle*4+102"` | small to medium | one form only; reuses `src/modeling/expr.ts` |
| 4.4 | friction sweep with a drive per point | small to medium | mostly a stand-in for 3.6 |
| 4.10 | `path` accepted beside `name` on write tools | small | additive |
| 4.12 | a one-object slice gives a count of layout overlaps, not the list | small | a test pins the list on purpose: owner's call |
| 3.8 | per-object grams in a plate slice reply | medium, engine | "mass from the saved slice" is not possible: projects store no slices |
| 3.11 | unheld-paths overlay per part; a slice of a subset of objects | medium each | |
| 3.12 | `ops::chamfer_under` in the recipe language | medium | builds on wave 1's face names |
| 3.9 | a tipping check for an assembly on a support with a hanging weight | medium to large | contact footprint is the hard part; own plan |

## 4. Proposed order after wave 1

1. Per-joint pivots and density (3.1), then springs and the knife edge (3.2): together they remove the builders'
   Python corrections.
2. Declared fits (3.4): removes the 0.02 mm undersized pins drawn to stay out of reports.
3. The nozzle check for escapement teeth (3.5, first step), and `gcode_summary`'s two kinds of "stands on nothing".
4. Crutch coupling (3.3).
5. Tooth loads and mesh friction (3.6), from its own plan.
6. The smaller capabilities as they fit.

## 5. Not planned

- Renaming autosaves per project (1.2).
- A "start from hanging still" mode (2.2).
- Belt-aware lay-flat (2.11).
- Changing the `pin_bore` allowance convention (4.10): it is consistent and now documented.
- The click spring as a flexible part, and typed hardware, until each has a plan.
