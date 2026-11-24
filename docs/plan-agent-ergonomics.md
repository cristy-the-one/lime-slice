# Plan: Lime Slice for an agent that models

Status: proposed. Written 2026-11-24 against `main` at `e28fcdbb` (v7.2.0).

The owner's request on 2026-11-24: evaluate how to upgrade Lime Slice from what Opus ran into while it modelled three objects through the MCP server and the `/lime-slice` skill. The sources are the three `notes/LESSONS.md` files in the owner's workspace: Tin Lizzie T-26 (a touring car, 29 lessons), Lunafen (an organic figure, 9) and Lime Bloom (a NURBS vessel, 23).

## 1. What the lessons say

Opus finished all three objects. About 60 lessons over three projects means a detour every few steps, and most detours were not modelling problems. They were places where Lime Slice was silent, inconsistent or strict, so the agent had to find the rule by trial.

The `/lime-slice` skill already carries most of these lessons as workarounds: its section 3, "API facts that bite", is in effect this list. The goal of this plan is to make those workarounds unnecessary. Every milestone names the skill lines it lets us delete, and a milestone is done only when its skill lines and guide text are updated too.

Lessons are cited as T (Tin Lizzie), L (Lunafen) and B (Lime Bloom) with their number.

## 2. Principles

1. **Nothing is lost or changed without being asked.** A dropped step, a reset history, a stale keep, a new plugin id, a reused parameter: each one either fails the call or comes back as a `warnings` entry in the reply itself, not a line among `notes`.
2. **One vocabulary.** The same idea has the same field name, the same frame and the same colour rules in every tool. A common alias is accepted or answered with "did you mean".
3. **Say the number.** A refusal about distance, size or length gives the measured value and the limit (how far apart, how much overlap is needed, how many characters are allowed).
4. **Exact where it is cheap.** A query that can be answered on the exact B-rep does not wait for a display mesh.
5. **No new native dependencies.** Everything below uses Open CASCADE 7.9.2 as linked today.

## 3. Inventory

"Checked" means read in the code at `e28fcdbb` while writing this plan. "To confirm" is the first task of the milestone that owns it.

| Lesson | What happened | Checked | Milestone |
|---|---|---|---|
| T6 | A refused step in an `apply_later` batch is replayed one by one; the recipe never reads the refusal, so the step is dropped and the run still succeeds | Yes: `mcp/session/recipe.ts` turns it into a `notes` line ("apply_later was refused…") | E1 |
| B16 | Rerunning a multi-part recipe drops hand-made steps and branches on its parts | To confirm | E1 |
| B13 | `nugget save {from}` after a dry run re-kept the previous code (still version 1) | To confirm | E1 |
| T25 | `keep` with a `name` that differs from the kept id makes a new plugin `<id>-2` | To confirm | E1 |
| T14 | A rerun with `object` keeps the last params, so a debug `stage` stuck | To confirm | E1 |
| B12 | `surface_at` on an assembly member answers in the part frame; the guide says model space for a moved part | Partly: the reply carries `frame` (`obj.frame`), and `mcp/guides.ts` line 475 states the model-space rule | E1 |
| B17 | An edit's own `label` is ignored when `model_edit` forks | To confirm | E1 |
| L2 | A refused fuse inside a queued run is reported on an earlier line | To confirm | E1 |
| T3, B9 | `solid_new {feature}` takes only `nurbsSurface` or `sheet`; a loft-first part needs a 400 mm box and `common`; a revolve-first part a buried primitive and `fuse` | Yes: the `feature` description in `mcp/schema.ts`; the kernel tree already opens from extrude, revolve, loft, sweep and sheet (`tests/feature_root.rs`) | E2 |
| T3 | Primitives stand on z = 0, centred in X/Y, with no `centre` | To confirm | E2 |
| L1 | `mirror` cannot repeat a sweep | To confirm against the repeat list in `mcp/schema.ts` | E2 |
| T8 | `path` + `profile` sweeps along arcs are refused ("could not loft"); the `sections` + `spine` pipe-shell form works | To confirm | E2 |
| T10 | `sweep.radius` as a one-element list is refused | To confirm | E2 |
| T16, L6, B7 | `colours` (by step label) is refused with `view:"assembly"`; `partColours` works only with assembly and print views | Yes: `mcp/session/layers.ts` lines 45 and 85 | E2 |
| B20, B3 | Field names drift (`project_save {name}`, not `path`); booleans are `fuse`, `cut`, `common` only | To confirm per tool | E2 |
| T1 | Unevenly spaced loft sections ripple at degree 3; `maxDegree: 3` with `smoothing` is refused | To confirm | E3 |
| T2 | A turned loft plane's U and V had to be found with a probe recipe | To confirm | E3 |
| T13 | `surface_at` forces a flush and a mesh (12.8 s of a 75 s run) | Yes: `surfaceAt` in `mcp/session/model.ts` casts the ray on the display triangles (`surfaceAtSolid` on a mesh view) | E3 |
| T28 | Design gaps of 0.05 mm read as overlaps when placed from sampled points | Likely the same cause: `surface_at` is only as exact as the mesh | E3 |
| B19 | `model_check {surfaces:true}` replies run to about 40 kB | To confirm | E3 |
| T13 | `recipe_run` defaults to a 30 s timeout | Yes: `mcp/schema.ts`, "Default 30." | E3 |
| B22 | A nugget lesson over about 250 characters is refused with only "input.text is too long" | Yes: the schema check says "is too long" without the limit | E3 |
| T20, L7 | Orientation chosen by hand: unheld length per yaw (T), overhang per yaw (L) | Not a defect: a missing tool | E4 |
| T19 | `slice_start` without `scope:"plate"` slices only the selected object | To confirm | E4 |
| T4, T7, T9, L3, L4, B5 | Near-coincident or barely overlapping skins: booleans past 90 s, a 0.02 mm overlap kills a fuse, "only touches", lost volume | Not yet measured | E5 (study) |
| T5 | Thin sweeps running along a spline skin shatter into pieces that meet along a line | Not yet measured | E5 (study) |
| B8, B2 | The `lime_recipe` API is learnt by grepping its cached source | Not a defect: a missing guide section | E6 |
| T11, T12, T15, T17, T18, T21, T22, T23, T24, T26, T27, T29, L5, L8, L9, B1, B4, B6, B10, B11, B14, B15, B18, B21, B23 | Modelling technique, the agent's own slips, or behaviour that is right but needs saying | n/a | E6 (guide, skill or nugget only) |

## 4. Milestones

Each milestone is one PR into `main`, with tests for every change, and with the matching skill and guide lines updated in the same round. The skill is outside the repo (`~/.claude/skills/lime-slice/SKILL.md`), so each PR body lists the skill lines to delete or rewrite, and the Claude side applies them when it merges.

### E1: nothing silent

1. A run whose recipe never read a refused queued step does not succeed silently. The reply gets `ok: true` with a top-level `warnings` entry per dropped step (line, tool, reason). With a new recipe flag, `//! strict: true`, a dropped step fails the run and rolls it back. Whether strict becomes the default is decision 1.
2. A rerun of a multi-part recipe that would drop hand-made steps or branches says so before it runs: a `mode:"dry"` reply lists them, and a real run refuses unless `replaceHandEdits: true` is passed.
3. `nugget save {from}` saves the code of the run it names. If that run was a dry run with newer code than the last kept version, it keeps the newer code, or refuses with a sentence. It never silently keeps the old one.
4. `keep` with a `name` that differs only by punctuation from a kept id (`t26-touring-body` against `t-26-touring-body`) refuses with "did you mean". A new id is made only when no near match exists.
5. A rerun with `object` and no `params` says in `warnings` which params it reused and from which run.
6. `surface_at` and every other tool that answers points name the frame in the reply (`frame`). The guide states the rule for assembly members, matching the code.
7. `model_edit` keeps the `label` it was given.
8. A refusal inside a queued run is reported at the line of the tool that was refused.

Done when: one test per item, and skill lines 63 (rerun params), 70 (apply_later), 80 (surface_at frame), 99 (nugget save), 112 (multi-part rerun) and the frame remark on 142 are deleted or reduced to the new behaviour.

### E2: tool coverage and one vocabulary

1. `solid_new {feature}` accepts every op a feature root can be in the kernel: `extrude`, `revolve`, `loft`, `sweep`, plus today's `nurbsSurface` and `sheet`. No more box-and-`common`.
2. `solid_new` takes an optional `centre` (`[x,y,z]`, the centre of the primitive's bounding box) next to today's default (standing on z = 0, centred in X and Y).
3. `mirror` repeats a sweep (path and `up` mirrored).
4. A `path` + `profile` sweep whose path has arcs goes through the same pipe-shell construction as `sections` + `spine`, or is refused with a sentence that gives the `spine` form to use.
5. A one-element list is accepted wherever a scalar or a per-point list is (`sweep.radius` first; list the others found).
6. Colours: `colours` (by step label) and `partColours` (by part name or handle) are accepted by every `render_view` view and by `pose_animate`. Where one cannot apply, it is ignored with a warning, not refused.
7. Names: an audit of the field names of every tool that saves or names a file, a part or a plugin, and of the boolean op names. Each common alias (`path` for `name` in `project_save`, `union` and `subtract` for `fuse` and `cut`) is either accepted or answered with "did you mean". The audit table goes in the PR body.

Done when: tests per item, and skill lines 65–67 (box-and-common), 71–74, 77 and 129 are rewritten.

### E3: speed and exactness for an agent

1. `surface_at` casts its ray on the exact B-rep (`IntCurvesFace_ShapeIntersector` or `BRepIntCurveSurface_Inter`) when the part has a solid, so it needs no flush and no mesh, and its point is exact. The mesh path stays for mesh-only parts. Measure the 75 s Tin Lizzie body run before and after.
2. `model_check {surfaces:true}` answers with a summary by default (`continuity.{g0,g1,g2,gaps}`, `surfaceHealth`, `sharpVertices`), and lists every sampled edge only with `detail:true`.
3. Loft: unevenly spaced sections stop rippling by default. Either the default parametrisation follows the section spacing, or `maxDegree` defaults to 5 for 5 or more sections; the study in this milestone picks one with numbers. `maxDegree: 3` with `smoothing` builds or refuses with a reason.
4. Every reply that takes a plane `turn` includes the resulting U and V axes in model space.
5. `recipe_run`'s default timeout follows the recipe's `//! budget:` line when it has one; the reply of a timeout says how long the run had and how to raise it.
6. A too-long text field is refused with its limit ("at most 250 characters, got 312"). The nugget lesson limit is reviewed; 250 is kept or raised with a reason.

Done when: tests per item, the T26 body's run time before and after, and skill lines 62, 80, 94 and 104 are rewritten.

### E4: choosing an orientation

1. A new tool, `orient_compare {object, rotations?}`, slices the object (or reads overhang without slicing; decision 3) at a set of rotations: by default every 90° of yaw on a belt printer, and the six faces down on a flat bed. For each rotation it returns unheld length and area, overhang area, the estimated time and the grams, and it marks the best. It changes nothing on the plate until `object_place` is called.
2. `slice_start` without `scope` says in its reply which objects it sliced, and that `scope:"plate"` slices them all.

Done when: a test on the T26 body's numbers (rotZ −90 gave the least unheld path) or an equivalent fixture, and skill section 8 gains the tool.

### E5: surfaces that touch (study first)

Six lessons are about skins that touch or nearly touch: booleans that crawl, fuses that fail on a 0.02 mm overlap, "only touches" refusals, lost volume. Today the agent offsets by hand.

The study measures, on the fixtures from T4, T7, T9, L3, L4 and B5:

- Open CASCADE's fuzzy booleans (`BOPAlgo_Options::SetFuzzyValue`) and gluing (`BOPAlgo_GlueShift`, `BOPAlgo_GlueFull`): time, result validity, and volume against the exact result.
- A refusal that measures instead: how far apart the skins are, and how much overlap the fuse needs.
- A check before a boolean that finds near-coincident faces (closer than a set distance) and refuses in under a second, instead of running past 90 s.

A fuzzy value can also hide a real gap, so whatever the study proposes is checked against `tools/golden.sh` and the slicer A/B before it is built. The study is a `docs/studies/` PR; the build, if any, is its own milestone.

### E6: guide, skill and nuggets

1. A `guide {topic:"recipes", section:"api"}` section generated from the `lime_recipe` crate: every public type and function with its signature and one line, so nobody greps the cache (B8, B2).
2. The technique lessons in the last inventory row become nuggets (`kind:"lesson"`, keyed by op kind) or guide sentences, so `guide {kind}` shows them under `seenInPractice`.
3. The skill is trimmed as E1–E4 land, and its "Strengths / weaknesses" section is rewritten at the end.

E6 runs alongside the others.

## 5. Order

E1 first: it is small, and silent loss costs the most trust. Then E2 and E3, which remove the most detours per session. E4 is a new tool and can go in parallel with E3. E5 is a study, and nothing is built from it before its numbers are in. E6 follows each milestone.

## 6. Decisions for the owner

1. **Strict runs.** Should a dropped queued step fail the run by default (`//! strict` on), or warn by default with strict as an opt-in? This plan proposes warn by default for one release, then strict.
2. **Aliases.** Accept common aliases silently, or only answer them with "did you mean"? This plan proposes "did you mean": one spelling stays canonical, and the refusal teaches it.
3. **`orient_compare` cost.** A full slice per rotation is exact but slow on a big part (T26 is about 4 hours of print). Should it slice each rotation, or estimate from overhang first and slice only the best two?
