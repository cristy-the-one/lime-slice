---
name: lime-slice
description: How to model, assemble, animate, export STEP and slice with the lime-slice MCP (Lime Slice — Open CASCADE solid modeler + filament slicer). Use whenever the user mentions lime-slice, Lime Slice, a .lime project, lust / lust-lang recipes, lime plugins or nuggets, NURBS sheets, STEP export from lime, or printing on their Ideaformer IR3 V2 belt printer.
---

# lime-slice

Lime Slice is a filament slicer **and** an Open CASCADE solid modeler behind one MCP server. You drive it with four
tools: `guide` (find/read docs), `call` (run any tool by name), `plan_run` (up to 250 calls in one round trip),
`session_info`. Everything else (≈100 tools) is reached through `call`.

The user's standing preferences (also in project memory) — follow them unless told otherwise:
- Build models as **lust recipes** (`.rs`, a Rust subset) run with `recipe_run`, never Python.
- Detail must look **real, period-correct, crafted**. Blocky toy shapes get rejected.
- Print target: **Ideaformer IR3 V2** belt (`ideaformer-ir3-v2`, filament `lime-pla`); orient for 45° belt layers.
- Track the project folder with **git** (`*.lime binary` in `.gitattributes` first!) and keep a `notes/LESSONS.md`.
- Use the guide with **progressive disclosure**; never dump whole topics.

## 1. Orient (cheap, every session)

```
session_info                              → workspace path (it moves! read it), engine, OCCT, tandem bridge, plugin count
guide {}                                  → map of areas + topics
guide {query:"few words"}                 → tools, op kinds, sections that match
guide {tool:"x"} | {kind:"fillet"} | {topic:"recipes", section:"api,params"}
nugget {action:"find", query:"…"}         → kept plugins / ingredients / presets / lessons BEFORE writing code
```
A refused call changes nothing and **lists the real field names** — read it instead of guessing. `guide {kind}`
ends with `seenInPractice`: your own lessons first, then the shipped technique lessons for that op (from 7.4.0).

Exact signatures: `guide {topic:"recipes", section:"api"}` lists every public item of lime_recipe (from 7.4.0,
generated from the crate). Before that, grep the cached source
`%LOCALAPPDATA%\Lime Slice\cache\recipes\<hash>\lime-recipe\src\lib.rs` for `pub fn`.

## 2. Project + git

```
mkdir <workspace>/<proj>/{recipes,renders,notes,export,plugins}; git init -b main
.gitattributes: *.lime binary, *.step binary, *.3mf binary, *.png binary, *.gif binary, *.rs text eol=lf
call project_create {}            … work …          call project_save {name:"<proj>/<proj>"}
```
Commit after every milestone (recipe works, assembly built, export done). Snapshot kept plugins from
`%APPDATA%\com.limeslice.slicer\plugins\*.rs` into `plugins/` so the repo shows how the repertoire evolved.

## 3. Recipes (lust)

Write the `.rs` into the workspace, run by path: `recipe_run {path:"proj/recipes/x.rs", name:"x", mode:"check"|"dry"}`
then without mode to apply. Same `name` = warm rebuild (~30 ms). `query:"type L:C"` / `"def L:C"` asks lust.

```rust
//! title: …            //! description: …            //! api: 1.16
use lime_recipe::{Json, Session};
use lime_recipe::geom2d::Region;
fn main() {
    let mut s = Session::start();
    let h = s.number("height", 150.0).range(60.0, 300.0).unit("mm").label("Height").get(); // params BEFORE calls
    let part = s.solid_new(Json::obj().set("primitive","cylinder").set("radius",10.0).set("height",h)).unwrap();
    s.apply(&part, Json::obj().set("kind","fillet") /*…*/).unwrap();
    s.done_with(&part, Json::obj().set("metric", 1));
}
```
API facts that bite:
- A recipe's `//! budget: 240s` line sets its time limit (default **30 s**, at most 600); `timeoutS` overrides it.
  Pass `meshAtEnd:true` on long runs. A rerun with `object` keeps the last params. A debug `stage` param + early
  `s.done(&p); return;` lets you render a half-built part.
- solid_new primitives stand on z=0, centred in X/Y; `centre:[x,y,z]` puts the bounding-box centre there instead.
  `centre` is the one spelling everywhere (aliases are refused with the canonical name).
- A part can **start from a feature**: `solid_new {feature:{kind:"extrude"|"revolve"|"loft"|"sweep", …}}` (also
  `nurbsSurface` / `sheet`). No more burying a primitive or `common` with a huge box. Loft plane `turn:[0,90,0]` → U=−Z,
  V=+Y; workplane and section replies echo the plane's `u`/`v` axes. Uneven section spacing: keep the default
  chord-length loft (`maxDegree:5` was measured worse; `maxDegree:3` with `smoothing` is refused).
- Keep neighbouring skins ≥0.75 mm apart (near-coincident skins → 90 s boolean timeouts). Since 7.3.0 a fuse the quick
  volume measure calls "lost" is measured again exactly, so a fuse that really adds material is kept; a real
  "would be lost" refusal still means move the piece. Thin sweeps running *along* a spline skin can still meet it along
  a line ("only touches"): inset them so they overlap.
- Nothing is dropped silently: a step skipped inside `apply_later`, an ignored field, a reused param or a colour that
  can't apply comes back as a **warning**. Read `warnings`. From 7.4.0 runs are **strict**: a refused `apply_later` step
  the recipe never reads fails and rolls back the run (handle `s.flush` / each result). `//! strict: false` opts out
  through 7.4 only (removed in 7.5.0); before 7.4.0, `//! strict: true` opts in.
- A bending path with a `profile` is always a **pipe-shell** sweep, and takes `caps`/`capStart`/`capEnd` `round` or
  `point` (+ `capLength` mm); round caps meet the pipe G1. Arcs: `sections` + `spine:{kind:"segments"}` with tangent
  arcs (reverse-curve radius > profile reach). `radius` = one number, a one-element list, or one per path point.
- `Part` is `{ object: String }` → `part.object.as_str()` for a tool's `object` arg.
- `Json::at("a.0.b")` → `Option<&Json>`; chain `.and_then(|j| j.as_f64())`, `.as_f64s()`, `.as_str()`. `s.log(&format!("{:?}", j))` to see a reply's shape.
- Booleans are `fuse | cut | common` everywhere. `mirror` and `pattern` repeat a sweep whole.
- Organic figures (guide {topic:"organic"}): start every sweep base ~2 mm inside the body or commit fails on open edges.
- `faces_find` rows: `{index, areaMm2, normal, centre, bbox{min,max}, kind}` (no radius).
- `surface_at {point, direction}` (or `rays:[…]`) hits the **exact B-rep** of a solid (`exact:true`), not its mesh,
  and no longer meshes first inside a recipe. It answers in the frame the reply names (`frame`, the part frame on an
  assembly member); a miss is `{hit:false}`. `measure` and `section` replies name their frame too.
- `s.section(&part, origin, normal)` → `Section{area, region, loops, frame}`; `sec.extrude("fuse", depth, loops)` builds in that plane.
- A fused body that only *touches* (coincident skins) is refused — inset it so it overlaps.
- `s.run_plugin(id, params)?.part` runs a kept plugin nested; `s.attach(&child,&parent,[x,y,z],[rx,ry,rz])` (parent frame), `s.joint(&p, {kind:"hinge", pivot, axis, min, max})`. Don't `hold` the root.

## 4. NURBS (the showcase feature)

- **Sheet:** op `nurbsSurface {poles:[[[x,y,z]…]…] (rows = U), weights, degreeU, degreeV, periodicU/V, knots…}`,
  ≤64×64 poles. Then `thicken {thickness, direction:"reverse"}`, `sew {capPlanar}`, `trimSplit`, `blendSurface (G1/G2)`, `patch`.
- **Closed vessel:** `periodicV:true` around, clamped up U. Add a pole row 4 mm below z=0, thicken, section at floor
  height → largest loop → `offset_miter(-wall/2)` → extrude `fuse` down through the skirt → `boolean cut` box under z=0.
- **Rational weights** >1 on every Nth pole sharpen crests (lobes, a petal midrib) without adding poles.
- **Exact NURBS in sketches:** revolve/extrude loops take `{kind:"nurbs", to, poles, weights(incl. both ends), degree}`.
- **Text on freeform faces:** `text {faceIndex (kind other), point (from surface_at), font:"hershey-script", along:"v"}`; default `along` is the face's U.
- `model_check {surfaces:true}` → G0/G1/G2 counts, gaps, surface health, sharp vertices. Add `detail:true` for every
  sampled seam edge (worst first, up to 256), e.g. to read a cap's seam angle.

## 5. Plugins, presets, lessons, ingredients — how lime-slice evolves

- Keep a recipe as a plugin: `recipe_run {path, name:"<id>", keep:{title, description}}` on a **real apply**
  (keep refuses check/dry). Same id again → next version. `nugget save from:<name>` keeps the code that last ran.
- Write plugins people can drive: params with range/unit/label/help, common first, a `name` text param when an
  assembly needs distinct member names, measure from picked faces, `s.refuse("…")` when the part doesn't fit.
- Presets: `nugget save {kind:"preset", id:"<plugin>/<name>", params}` → `recipe_run {plugin, preset}`.
- Ingredients: accept the run's offer, or `nugget save {kind:"ingredient", from, items:["fn"]}` → `use ingredients::<id>::*;`.
- Lessons: `nugget save {kind:"lesson", id:"<op kind>", text}`: one sentence, **≤ 200 chars** (longer is refused
  with "at most 200 characters, got N"). They surface in `guide {kind}`.
- Rerunning an assembly recipe pins the plugin versions it ran; remove parts and run fresh to take new versions.

## 6. History (git-like)

`model_history {object}` → nodes with parent ids (a tree). `model_goto {node}` moves HEAD; applying from an older node
**forks**. `model_edit {node, op, probe:true}` on a plain step replaces it and replays the children on a new branch
(old branch kept; labels are kept). Composite steps (text, pattern) can't be edited:
goto parent + apply. `model_commit` puts the current node on the plate. **A multi-part recipe rerun wipes hand-made
branches** — finish the generating recipe first, then hand-edit.

## 7. Assemblies + animation

`assembly_link {child, parent}` links two parts where they stand (a free parent starts an assembly named after it),
the same as **Link** in the app's Pose tab, which is where assemblies are made, ungrouped and exported. Pose owns
design space: its **Move** (M) moves a free part or a member in model space, the same move `model_place` makes over MCP
(Model no longer has Place / Shift+P). Prepare only lays parts out for print (no assembly view; "Edit in Pose" opens it).
In the app, Model's Scale solid is Shift+S, and the stage keys follow the tabs: Model 1, Pose 2 | Prepare 3,
Preview 4, G-code 5. Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) are one command each, routed by stage: Model undoes the open part
(the rail buttons are that history; an open sketch keeps its own undo); Pose, Prepare, Preview and G-code undo the
plate; the palette names the step ("Undo Move"). An MCP move, link or joint is not on the window's Ctrl+Z: use
`model_undo` / `plate_undo`.

Animation = a lust script `//! kind: animation`, `//! api: 1.17`: `let rig = s.rig().unwrap(); rig.group("Petal *")`,
`Animation::new(fps)`, `a.key(t, Pose::new().set(name, deg).colour(name,"#hex")).ease(Ease::InOut)`, `.hold(s)`,
`a.camera(Camera::looking(x,y,z))`, `a.background("#…")`, `s.animate(&a)`.
- `pose_animate {object, path}` **without `out`** = free collision check of every frame (warnings: pair, frames).
  Iterate params until warnings are empty, then export `out:{gif, frames}`, `fit:{min,max}`, `longEdge`.
- Keep with `keep:{title, description}`. Member names written literally become required members — take them as text params.
- Slides can't be keyed (move via couplings); for a nonlinear slide use a far-pivot hinge.
- MP4: `ffmpeg -framerate 20 -i frames/frame-%03d.png -c:v libx264 -pix_fmt yuv420p out.mp4` (ffmpeg via winget).

## 8. Render, export, slice

- `render_view {object, views:[{direction, up}], background, longEdge, name:"proj/renders/x.png", fit}`;
  `view:"assembly"` + `partColours` for assemblies; `colours` keys are step labels. A colour that can't apply warns;
  an unknown part name is refused with "did you mean".
- Export: one tool, `export {scope, format, object?, assembly?, frame?, name}`. `scope` is `part`, `assembly`,
  `plate-assembled` or `plate-print`; `format` is `step`, `stl`, `3mf`, `obj`, `glb` or `pose` (the scope limits
  which). In the app: **File → Export…** (Ctrl+Shift+E). `model_export_step` / `pose_export` still work, same bytes.
- Slice: `machine_list` → `machine_select {printerId:"ideaformer-ir3-v2", filamentId:"lime-pla", nozzleMm:0.4}` →
  `object_select` → `slice_start {wait:true}` → `gcode_summary` (read `standsOnNothing`) → `settings_apply {supports:true}`
  if needed → `gcode_export {name}`. Nothing is ever sent to a printer.
- In the app (7.4.0): **Calibrate** is a Prepare rail button (towers for pressure advance, flow, temperature,
  retraction); **Printers** is a top-bar menu beside File (printer, filament, library, machine settings), also opened
  by the printer chip. The `calibrate_*` and `machine_*` tools are unchanged.

## Strengths / weaknesses of working this way

Strong: recipes are transactional (a panic rolls back everything), warm reruns are fast, plugins nest (a recipe can
run plugins and assemble them), every refusal is a precise sentence, history is a real tree, OCCT gives true
NURBS/STEP, collision checking per animation frame is free, and lessons feed back into the guide.
Weak: some replies are still large (plate_list on big assemblies: prefer `plan_run` with selected `results`),
multi-part reruns drop hand edits, and belt-slicing overhang rules must be designed in (from 7.4.0 `orient_compare`
ranks candidate orientations, but the choice is still yours).
Better since 7.3.0: one vocabulary across tools, warnings instead of silent drops, replies name their frame, and
`surface_at` is exact. From 7.4.0: describe, mass, check and the Part card give exact volumes (lofts no longer read
~0.6 % low; apply replies keep the quick figure), the recipe API is a guide section, and technique lessons ship.

Always end a session by appending roadblocks to `notes/LESSONS.md`, saving the useful ones as nuggets, committing,
and updating project memory.
