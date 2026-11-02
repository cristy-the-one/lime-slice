# Plan: recipe ingredients and nuggets

Status: plan, for review. Written 2026-11-02 against `main` at v4.9.0 (`276beed2`). Nothing here is built yet.
Companions: `docs/plan-recipes.md` (the recipe protocol, S1–S13) and `docs/plan-recipe-plugins.md` (a whole recipe
kept as a plugin, D1–D16). This plan does not change either. It adds what sits below a plugin: the reusable pieces a
recipe is made of, and the lessons a run teaches.

The owner's direction, in their words: "we don't transform 'recipes' into less than what they are - we need to make
them more easy to use. it is expected that each interaction with the MCP will have the potential to find a 'nugget'
usable for future designed objects."

## 1. Goal

A recipe stays the most expressive way to build a part: a Rust `main` with loops, arithmetic and decisions between
the calls. Nothing in this plan replaces a recipe with a fixed op, or narrows what a recipe may do. Instead:

- **Easier to write.** The geometry every recipe re-derives (polygons, clipping, rounded corners, lattices) ships in
  `lime-recipe`, tested once. A recipe can read the real outline of a face instead of guessing it.
- **Every run can leave a nugget.** A plugin (D1) keeps a *whole* recipe. A nugget is smaller and is kept on its own:
  - an **ingredient**: a module of functions another recipe imports;
  - a **preset**: a named set of parameter values that built a good part;
  - a **lesson**: one sentence about an op, learned from a refusal a run recovered from.

  The next session finds them with one cheap call, before writing anything.

### Non-goals

- No new language features. Ingredients are plain Rust modules that lust and rustc both build (rule zero,
  `plan-recipes.md`).
- No change to the sandbox (S13, D11). An ingredient has the same powers as the recipe that imports it: none outside
  the allowlist.
- No ingredient store on a server. Ingredients live where plugins live (D7) and are shared as files (D10).
- No automatic saving. A nugget is kept only by an explicit act, as with plugins (O1).
- No replacing recipes with bigger ops. Where an op gains power (section 6) it is so a recipe can call it, not so a
  recipe isn't needed.

### Words used here

| Word | Meaning |
|---|---|
| recipe, plugin, draft | As in `plan-recipe-plugins.md`. |
| ingredient | A named, versioned Rust module with no `main`: public functions, types and constants with a doc line each. Imported by recipes and plugins. |
| standard ingredient | An ingredient shipped inside `lime-recipe` (section 3). |
| preset | A plugin or recipe name plus a set of parameter values, under a name. |
| lesson | A sentence attached to an op kind or a helper, shown in that op's `guide {kind}`. |
| nugget | Any of the last three. |

## 2. Where things stand: one session's evidence

On 2026-11-02 an agent built a 300 × 120 × 100 mm injection-moulded tray with a honeycomb rib floor (115 cells, 10 mm
hex side, 3 mm ribs, rounded nodes), using only the MCP's guides and one recipe (`honeycomb_tray`, obj_3 in
`honeycomb_tray.lime`). It worked, at these costs:

| Observation | Cost |
|---|---|
| About 90 of the recipe's 200 lines were generic 2D geometry: Sutherland–Hodgman clipping, duplicate and collinear cleanup, area, corner rounding with a shrinking radius, polygon to `loops` JSON | Most of the writing time; one intersection sign that only worked by accident |
| The floor boundary was guessed (a rectangle inset 3 mm with chamfered corners), because a recipe can't read a face's outline | Clipped cells follow the guess, not the real R7 corners and floor fillet |
| `extrude.loops` takes at most 32 loops, so 115 cells became 115 cut steps | 40–58 s per build |
| `fillet` with `select.onFace` + `nearPoint` silently picked the pocket floor under a cell centre, then refused "No edge matches that filter." | One full rebuild |
| `recipe_run {name, object, source}` made obj_3 beside obj_2 instead of replacing it (the guide promises `replaced` only for a rerun without `source`) | A stale part removed by hand |
| `model_check` reported "larger than the build volume" and 45° overhangs for a moulded part | Noise the agent had to explain away |
| The helper code exists only inside that one recipe | The next grille, vent or honeycomb starts from zero |

## 3. Standard ingredients in `lime-recipe`

### I1. A 2D geometry module

`lime_recipe::geom2d`, pure functions with no `Session` calls and no dependencies (S7's rule for the crate):

| Group | Must provide |
|---|---|
| Shapes | `Poly::from(points)`, `rect`, `rounded_rect`, `regular(sides, Size::Side \| Size::Across \| Size::Corners, centre, rot_deg)`, `circle(r, segments)` |
| Measures | `area` (signed), `centroid`, `bbox`, `is_convex`, `contains(point)`, `perimeter` |
| Booleans | `intersect`, `union`, `difference` and `offset(mm)` on `Region` (outer loops with holes). Correct for concave polygons and holes, not only convex clippers. |
| Corners | `round_corners(r)` and `chamfer_corners(d)`. The radius shrinks per corner when an edge is too short, and the result reports each corner as `full`, `reduced(r)` or `sharp`. |
| Cleanup | `clean(tol)`: duplicate points, collinear points, slivers under an area |
| Output | `Poly::to_loop() -> Json` (lines and arcs, ready for `extrude.loops`) and `Region::to_loops()` |

### I2. Lattices

`lime_recipe::lattice`: `hex(side, orientation)`, `rect(pitch_u, pitch_v)`, `staggered(...)` and `along(points, count)`.
Each, given a `Region`, returns cells with their centre, the cell polygon clipped to the region, and whether it was
clipped. A `min_area` drops slivers.

### I3. Documentation and diagnostics

- `guide {topic: "recipes"}` names the modules in one line. A new `guide {topic: "ingredients"}` lists every public
  function with its signature and a one-line example, under S11's token budget for guides.
- An unknown function in `geom2d` or `lattice` gets a diagnostic listing the nearest names, as unknown `f64` methods
  do today.

### I4. Tests

- Every function has `cargo test -p lime-recipe` cases, including degenerate input: zero area, a self-touching loop,
  edges shorter than the corner radius, and a clipper that misses entirely.
- Rule zero: a sample recipe using I1 and I2 sends the same calls, byte for byte, under lust and rustc.

**Done when** the honeycomb recipe, rewritten with I1–I2, has no hand-written geometry functions and builds a solid
whose volume matches obj_3's within 0.01 mm³ (with I5 off, so the boundary is the same).

## 4. Reading the real geometry

### I5. Face outline as a region

`s.face_outline(face, inset_mm) -> Region`, from a face index or `{normal, nearPoint}`. It returns the boundary of a
flat face in that face's plane frame, curved edges sampled to a stated chord tolerance (default 0.05 mm), with the
frame alongside (I7). An inset that empties the region answers with an empty `Region`, not a refusal.

### I6. Section

`s.section(origin, normal) -> Region`: the solid's cross-section at a plane, for wall and rib checks inside a
recipe.

### I7. Plane frames

Every face query (`faces_find`, I5, I6) also returns the face's frame `{origin, u, v, w}` and the matching
`origin`/`turn` for an `extrude`, so a recipe never has to work out axis conventions by trial.

### I8. Say which face a selector picked

Every selector (`face`, `onFace`, `nearPoint`) reports the face it resolved to: index, normal, centre and area. It goes
in the reply and in a refusal's sentence. When `nearPoint` lies over empty space (a pocket, a hole), the reply says so
and names the nearest face with material under the point. The lesson in section 2 becomes impossible to miss.

## 5. Nuggets

### I9. Ingredients are files beside plugins

An ingredient is one `.rs` file with the same `//!` front matter as a plugin (D6), with `kind: ingredient` and no
`target` or `params`. It is stored in the same three places (D7) and versioned the same way (D12: the `api` it was
written against, `version` counting up, `source-sha256`).

### I10. Importing

A recipe writes `use ingredients::honeycomb::*;` (latest version) or `use ingredients::honeycomb::v2::*;` (pinned).
The host resolves the name before the build, the same way under lust and rustc. An unknown name is a diagnostic
listing close matches.

### I11. A plugin stays one file

When a recipe that imports ingredients is kept as a plugin (D1), the save copies each imported ingredient into the
plugin file as an inline module, stamped with its name, version and hash. Sharing a plugin (D10) still means sending
one file, and it still builds where the ingredient library is missing. `plugin {action: "get"}` lists the ingredients
inside.

### I12. Keeping an ingredient

- **Agent:** `ingredient {action: "save", from: "<recipe name>", items: ["fn honeycomb_cells", ...], title, description}`
  lifts the named items, and what they call, out of a successful run's source into a new ingredient.
- **Person:** the plugin step's History row (D8) gets "Save parts as ingredient…", listing the recipe's free
  functions.
- A save builds the ingredient alone under lust and runs its doc examples, if any, as tests. An ingredient that
  doesn't build alone is not saved, and the sentence says which item needs what.

### I13. Harvest suggestions

After a successful `apply`, the `recipe_run` reply adds at most three lines under `nuggets`:

- free functions that make no `Session` call and are over 10 lines, offered as an ingredient;
- a parameter set that built (offered as a preset, I14);
- each refusal the recipe handled with `if let Err` and then got past, offered as a lesson (I15).

Each line carries the ready-made save call. Nothing is saved until that call is made (O1 holds).

### I14. Presets

`preset {action: "save" | "list" | "remove", for: "<plugin or recipe>", name, params}`, and
`recipe_run {plugin, preset}`. A preset stores values only. It is checked against the plugin's declared ranges
(D4) when it's saved and again when it's used. Example: `honeycomb-tray/pp-5mm-wall`.

### I15. Lessons

- `lesson {action: "save" | "list" | "remove", about: "<op kind or helper>", text}`, with `text` at most 200
  characters, plain text, shown as data (D11's rule for descriptions).
- `guide {kind}` ends with a "Seen in practice" list of up to five lessons for that kind, newest first.
- Lessons are stored with the user's library, not in projects.
- Example from section 2: about `fillet`: "`select.onFace` with `nearPoint` over a pocket picks the pocket floor;
  aim at material, such as a rib node."

### I16. One place to look first

- `nugget {action: "find", query}` searches ingredients, presets, lessons and plugins together and answers one line
  per hit, at most 20. This is the one call `guide {topic: "recipes"}` tells an agent to make before writing.
- `session_info` gains the counts: "Nuggets: 6 ingredients, 9 presets, 14 lessons."
- Token budget: the `ingredient`, `preset`, `lesson` and `nugget` tools come in as one tool with a `kind`, or as
  actions on D14's `plugin` tool. Which one is Q2. Either way it follows `mcp/schema.test.ts`'s budget rule.

### I17. Promotion

An ingredient that several plugins use can be proposed for `lime-recipe` (section 3) in a PR. The library keeps the
original file and version, so recipes that import it keep building (O9's spirit).

## 6. Scale and speed

### I18. More loops per extrude

Raise `extrude.loops` from 32 to at least 1,000, under the existing 400-step and 1 MB line limits (S5). An extrude
over the limit is refused with a sentence that points to I19.

### I19. Many tools, one boolean

`s.apply_many(&part, ops)` sends ops of one kind (`cut` or `fuse`) as one kernel boolean of their combined tools, as
one History step with a row per op. One op that fails is reported by index and the rest still apply. The step counts
as one against the 1,000 applied-op cap.

### I20. `array` takes any cell

`array.cell` accepts `{loops}` (a `Region` from I1) next to today's shapes, plus `cornerRadius`, `draftDeg` and
`minArea`. Cells are clipped to the face outline minus `margin` (I5's outline, so curved edges count). This is a
building block a recipe calls with its own lattice. It is not a honeycomb op.

### I21. Progress

A run past 5 s reports `stage` as `call N of about M, line L` (M taken from the previous run of the same name).

**Done when** the 115-cell floor of section 2 builds in under 10 s on the owner's machine.

## 7. Rerun identity

### I22. Same name and object: replace

`recipe_run {name, object, source}` where `object` was made by an earlier run of `name` replaces that run's outputs in
place: same handle, new history. The reply says `replaced: obj_N`. A part that wasn't made by a run of that name
keeps today's meaning (the recipe works on it). It never silently leaves a duplicate.

### I23. Quick partial runs

`recipe_run {mode: "dry", maxSteps: N}` stops after N applied ops and reports the metrics so far, so a recipe needs no
`maxCells` parameter of its own for a quick test.

## 8. Checks that fit the process

### I24. Check by process

`model_check {process: "fdm" | "injection" | "resin"}`, defaulting to the plate's printer. `injection` drops bed size
and overhang findings. It adds faces with less draft than `minDraftDeg` (default 0.5°) for a pull direction (default
+Z), wall thickness against a nominal, and ribs thicker than `ribRatio` × the wall they stand on (default 0.6, the
sink-mark rule).

### I25. Checks as recipe calls

`s.check_with(json)` passes I24's options, and its findings come back as numbers a recipe can test (minimum draft,
thickest rib ratio), not only as sentences.

## 9. Seed nuggets

The first entries, from the session in section 2. The source recipe is kept at
`C:\Users\marius\.lime-slice\recipe-samples\honeycomb_tray.rs` (Q4).

| Kind | Name | Content |
|---|---|---|
| ingredient | `honeycomb` | `cells(side, rib_t, region, node_r) -> Vec<Poly>`: clipped hex pockets with rounded nodes |
| ingredient | `moulded-tray` | `drafted_body(l, w, h, draft, corner_r)` plus the shell and bottom-round steps |
| preset | `honeycomb-tray/default` | hexSide 10, ribHeight 3, ribThick 2.4, ribDraftDeg 1.5, nodeR 2, ribTopR 0.7, wall 5, wallDraftDeg 1, cornerR 12, bottomR 8 |
| lesson | `fillet` | "`select.onFace` with `nearPoint` over a pocket picks the pocket floor; aim at material, such as a rib node." |
| lesson | `extrude` | "At most 32 loops: for many holes, cut per cell or use `array`." (Until I18 lands.) |

## 10. Risks

- **Polygon booleans are hard to get exactly right.** A home-grown clipper that fails on touching edges would give
  wrong solids, quietly. Mitigation: Q1, I4's degenerate cases, and comparing against the kernel's own section on a
  test set.
- **Lesson noise.** Lessons written by agents can be wrong or redundant. Mitigation: at most five shown per op,
  `remove` is one call, and a lesson is data, never an instruction.
- **Library drift.** An edited ingredient could break recipes that use it. Mitigation: versions (I9), pinned imports
  (I10), and plugins carrying their copy (I11).

## 11. Questions for the owner

- **Q1. Polygon booleans.** Write them in `lime-recipe` (pure Rust, no dependency, as S7 requires), or route them to
  the engine as a new allowlisted call `poly` backed by the kernel? The plan's choice: in the crate, with the kernel
  used in tests as the reference.
- **Q2. Tool shape.** One `nugget` tool with `kind` and `action`, or actions on D14's `plugin` tool? The plan's choice:
  one `nugget` tool, because a plugin is itself a kind of nugget and `find` should search them all.
- **Q3. Where lessons live.** User library only (the plan's choice), or also shipped with the app once the owner
  reviews them?
- **Q4. Seed sample.** Keep `honeycomb_tray.rs` as a recipe sample beside `gear_pyramid.rs` (O6)?

## 12. Milestones

Each is one PR to `main`, smallest useful first. Each updates `docs/mcp-server.md` for MCP behaviour.

1. **I8 + I22 + I23.** Selector reports, replace on rerun, `maxSteps`. Small and removes rebuilds.

   **As built (milestone 1, branch `claude/recipe-host-fixes`),** with the groovi session's R-A and R-C:
   - **I8.** The face selector's resolver (`faceByDetail`, `src/modeling/frames.ts`) returns the face's index, normal,
     centre and area, and for `nearPoint` its distance to the face. Off the face by more than 0.05 mm, the nearest
     matching face whose plane runs through the point is named as `level`: "the face with material level with the
     point". Every MCP call lists its picks as `picked`; a refusal adds one sentence per pick, so a recipe's `e.reason`
     carries it. `faces_find {nearPoint}` adds the same as `note`. The honeycomb case (a pocket floor picked from a
     point over the cell) reads: "No edge matches that filter. The face selector picked face 10 (normal [0, 0, 1],
     centre [0, 0, 7], 100 mm²), 3 mm from nearPoint [0, 0, 10]: the point lies over empty space (a pocket or a
     hole), ... The face with material level with the point is face 2 (..., 5 mm away); aim nearPoint at material."
   - **I22.** New `source` (or `path`) under the same name with an `object` that name made reruns it, as
     `{object, params}` does. Both now hand each old object's handle, list place and name to the new object in turn,
     and its plate and model place unless the recipe placed it (`replaced`); old objects left over leave (`removed`).
     A run of the same name without `object` keeps the earlier parts under their own entry and says so (`earlier`).
   - **I23.** `maxSteps` on a dry run stops after N applied ops (a batch counts its ops) and reports each part's
     `volumeMm3` and `sizeMm` so far (`partial`), then takes the run back. A recipe's own `done_with` metrics do not
     exist at that point, so those are the host's measures. On an apply it is refused.
   - **R-A (data once).** Lean form, no new tool: `recipe_run {path}` reads the source from a `.rs` in the MCP
     workspace, and the host's own recipe call `data {name}` reads `<name>.json` or `.csv` from it. The agent writes
     both with its own tools; nothing passes through the model twice. The data a run read is kept with its recipe in
     the project (hash and value), so a rerun from the object builds where the files are missing. The groovi skin's
     rerun costs 37 bytes of arguments instead of 19,390. A typed `s.data_f64(...)` helper belongs to `lime-recipe`
     (milestone 2's crate) and is left to it; until then `s.call("data", ...)` with `as_array` reads the numbers.
   - **R-C (crash to refusal).** The modeler already ran in its own process, so the server never went down with it;
     what failed was the session afterwards: the call threw, the trees were gone but taken as open, the next edit and
     commit answered `unknown`, and the plate's part became a 1 mm speck. Reproduced by stopping the modeler under a
     60-section loft cut. An engine process that ends under a call is now a refusal with a sentence ("The loft
     stopped the kernel (...). Nothing changed. Make it in shorter pieces: at most 4 sections each, ..."), the trees
     rebuild on next use, and a recipe gets `Err` and can fall back to pieces. The modeler and the preview end
     themselves past a memory cap (70 % of the machine's memory), so a runaway kernel stops there. `slice_wait` on a
     job a restarted server never had reopens the last autosave. The exact groovi cut (19 sections) did not stop the
     kernel on this build: it is refused ("The boolean removed the solid."), and the chunked hollow finishes in 30 s.
2. **I1–I4.** `geom2d` and `lattice` in `lime-recipe`, with the guide topic and tests.
3. **I5–I7.** Face outline, section, frames.
4. **I18–I21.** Loops limit, `apply_many`, `array` cells, progress.
5. **I9–I11.** Ingredient files, import, plugins carrying their ingredients. Needs the plugin plan's D6–D7 first.
6. **I12–I17.** Saving ingredients, presets, lessons, harvest suggestions, `nugget find`.
7. **I24–I25.** Process-aware checks.

## 13. Done for the whole plan

- The honeycomb tray recipe is rewritten as about 60 lines that import `honeycomb` and `moulded-tray`, uses the real
  floor outline, and builds in under 10 s.
- A fresh session asked for "a honeycomb-ribbed lid" calls `nugget {action: "find", query: "honeycomb"}` first, and
  its recipe contains only the lid-specific logic.
- `model_check {process: "injection"}` on the tray reports draft and rib ratio, with no FDM findings.
