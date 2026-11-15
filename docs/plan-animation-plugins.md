# Plan: animation plugins in the library (F6)

Status: plan and as built, for 6.8.0. Written 2026-11-15 against `main` at `66582f32` (after #692).

The source is F6 of the cat clock note (`lime-workspace/cute-clock/clock-function-plan.md`, section 5): "Let `keep` and
`nugget save` accept `kind: animation` recipes, with member names as parameters or patterns, so 'Escapement motion' is
reusable on any clock assembly." Its cheat: "Animation script lives in the project folder: animation runs cannot be
kept as plugins."

The specs this builds on are `plan-recipe-plugins.md` (D1 to D14: keep, the header, versions, sharing) and
`plan-pose-animation.md` (D1 to D8: the `animation` kind, the rig by name, `pose_animate`, the Pose panel).

## 1. What exists

Most of the plumbing for an animation *file* is there. What is missing is the way from a run to that file, and a way
for one file to fit assemblies whose parts carry other names.

| Piece | State on main |
|---|---|
| `//! kind: animation` in the header | parsed and written by `mcp/plugins.ts` (`parsePlugin`, `pluginText`) and `src/plugin-file.ts` |
| A library animation plugin runs | `pose_animate {object, plugin}` finds it (`pluginFile`), refuses a recipe plugin there, and `recipe_run {plugin}` refuses an animation |
| Listed as an animation | `plugin list`, `nugget find` (`pluginKind: "animation"`, `run: "pose_animate"`), `plugin get` (`kind`), the Plugins panel (badge "animation", "Open Pose to play it") |
| Sharing | `nugget export` and `save {from: "<file>.rs"}` carry `kind: animation` (`mcp/animation-plugin.test.ts`); the window's import keeps the header lines |
| In a project | `mcpModel.animations[name]` (source, params, assembly, plugin id) and the plugin's copy in `plugins`; reopened and played again |
| Pose | lists the project's and the library's animation plugins, draws their parameters (number, count, toggle, choice, text), plays, scrubs, Keep this frame, **Save animation…** (a GIF or PNG frames: an export, never the library), the first-run view for imported code |
| Names in a script | `Pose::set(name, …)`, `set_all(&rig.group(pattern), …)`, `colour(name, …)` and the rig reads send names or `A*|B` patterns; the host resolves each with `rigGroup` (`src/pose-anim.ts`) against the members as named on the plate (a repeated name gets `-2`), and refuses one that matches nothing: "No member matches Driver." |

## 2. What is missing

1. **No keep for an animation run.** `pose_animate` has no `keep`. `nugget {action: "save", kind: "plugin", source}`
   with an animation's code goes through the recipe save check (`pluginCheck`): a recipe dry run, where `rig` and
   `animate` are not on the allowlist, so it fails; and the header it would write has no `kind: animation`. `from` looks
   only at recipe drafts (`rustRecipes`), never at the project's animations. The only way in was to write the header by
   hand and import the file.
2. **Names are frozen in the script.** A script written for a clock whose wheel is "Escape wheel" refuses on a clock
   whose wheel is "Escapement": "No member matches Escape wheel." A `text` parameter can already carry a name (its
   value goes straight into `set`), but nothing marks it as a member, so the window shows a free text box and the
   refusal does not name the parameter to set.
3. **Nothing says what an animation needs.** `nugget find` and `get` say "animation" but not which members it expects.
4. **The window cannot keep.** Pose plays a project's animation but cannot put it in the library.

## 3. Decisions

### A1. `pose_animate {keep}`, the same keep as `recipe_run`

`pose_animate {object, source | path | plugin, params?, keep: {title, description?, members?}}` keeps the script as a
`kind: animation` plugin when the run succeeds, dry run or export alike (the sampling, with every key checked on a real
assembly, is the check). It is the field `recipe_run` has, on the tool that runs animations, so an agent learns one
word. Its reply adds `kept: {id, version, sha256, memberParams?, memberNames?, note?, hints?}` or `keepRefused`, as
`recipe_run` does; a refused keep never fails the run.

- **Versions** follow `pluginSave` exactly (the same function): the id is the title's slug; the same code keeps its
  version; other code is the next version when the run was of that plugin (`plugin: <id>`, or `name: <id>` for a
  source run), else it is kept beside it as `<id>-2` with the note that says how to add a version instead (F7's
  complaint, already on main for recipes).
- **The check** is the run itself, so no second run. A save without an assembly (below) runs describe only, as an
  import does.
- `nugget {action: "save", kind: "animation", from | source, title, description?, members?}` keeps one too:
  `from` names an animation kept with this project (`mcpModel.animations`, the name `pose_animate` gave it), `source`
  is code. `kind: "plugin"` with `from` falls back to the project's animations when no recipe run has that name, and a
  `source` whose header says `kind: animation` is kept as one. `nugget` `get`, `export` and `remove` take
  `kind: "animation"` as `plugin` restricted to animations, and `find {kind: "animation"}` lists only them.

### A2. Member names are `text` parameters, marked in the header

**No crate change.** A script that should fit other assemblies declares a text parameter per member it names, with the
name it was written for as the default, and uses the value where it used the name:

```rust
let wheel = s.text("wheel", "Escape wheel").label("Escape wheel").get();
let anchor = s.text("anchor", "Anchor").label("Anchor").get();
a.key(0.0, Pose::new().set(&anchor, -3.5).set(&wheel, 0.0));
```

The value may be a pattern (`"Finger *|Thumb"`), as any name in a script may. `text` already carries a string, the
host already resolves it with `rigGroup`, and describe already lists it, so a new parameter kind (`s.member(...)`,
API 1.16) would add a builder and a crate level for no new power. What `text` lacks is the *mark* that it names a
member, and that is the host's to write, like `curved` or `built`:

```text
//! member-params: ["wheel","anchor"]
//! member-names: ["Frame"]
```

- `member-params` lists the text parameters that name members. `member-names` lists the names or patterns the script
  used as written (no parameter sets them): what an assembly must have as it is.
- **Written at keep, from the run.** The host records every name the run sent (the keys' `set` and `colors`, the
  palette, the rig reads' members). A text parameter whose value was one of them is a member parameter; a name that
  is no parameter's value is a fixed name. `keep.members` (or `nugget save {members}`) names member parameters
  explicitly, for a save with no run; each must be a text parameter or the save is refused with the name.
- **Header lines, not a flag in `params`,** because `params` is rewritten from describe whenever a file is re-read
  (an edited file, an import); the header lines survive that, and the hash covers only the body, as for the
  description.
- **A script with names written in.** The keep reply's `hints` says which names are fixed and how to turn one into a
  parameter (the three lines above), so the next version is reusable. Considered and not built: a host-side rename map
  (`pose_animate {members: {"Escape wheel": "Escapement"}}`) that renames the rig the script sees. It would fit scripts
  as written, but it is a second way to say the same thing, does not work for patterns, and is invisible in the file.

### A3. A missing member is refused before the script runs

When a plugin's `member-params` or `member-names` match nothing in the assembly, the run is refused before any build,
in one sentence: `This assembly has no member matching "Escape wheel", which the parameter wheel names: set wheel to one
of its members (Frame, Great wheel, Escapement, Anchor).` A fixed name: `This assembly has no member matching "Frame",
a name the animation uses as written: name a part Frame, or keep a version that takes it as a parameter.` Both hosts
use `src/anim-members.ts`. A source run that refuses "No member matches X" where X is the value of a parameter it was
given gains the same "set X to one of its members (...)" ending.

### A4. What `nugget` and the panels say

`nugget find` rows of an animation carry `pluginKind: "animation"`, `run: "pose_animate"` and `needs`: one line,
`an assembly with members: wheel (default "Escape wheel"), anchor (default "Anchor"); and Frame as named`. `get` adds
`memberParams` and `memberNames`. The Plugins panel's target line for an animation names the same members.

### A5. The window

- **A member parameter is a select** in Pose's Animations section, filled with the selected assembly's members (as the
  rig names them). A value that is a pattern stays as an option with how many parts it matches. A value that matches no
  member shows "Choose a member" and Play refuses with A3's sentence.
- **Keep in library…** in the Animations section, under Save animation…, for an animation that was played and whose
  code the library does not hold. A small dialog (title, description), then: describe the script in the app runner for
  its parameters (the synthesized form of a project's animation only guesses them), member parameters detected from the
  run as in A2, the id and version from `savePlan` (the MCP's rule), written with the library's `save`. The kept plugin
  is selected in the list and appears for every assembly.
- Save animation… stays the GIF and PNG export.

### A6. Sharing

The header lines travel in the file: `nugget export` and the Plugins panel's Export write the library file;
`checkImport` (`src/plugins/share.ts`) checks the lines (a list of at most 64 short strings, each member parameter a
`text` parameter) and keeps them; the MCP's import keeps the parsed header; a project carries the file in `plugins`.

## 4. Tests

| Test | What it proves |
|---|---|
| `src/anim-members.test.ts` (unit) | names used by a run, member parameters from values, the missing-member sentences, the needs line, the window's header round trip and `checkImport` (the MCP parser's is in the MCP test) |
| `mcp/animation-keep.test.ts` (lust, fake engine) | keep from `pose_animate {source, keep}`; `nugget find` and `get` say animation and what it needs; play on a second assembly whose members have other names by `params`; refused with the member and parameter; keep again: same code same version, changed code next version, another title's clash kept beside with the note; `nugget save {kind: "animation", from}`; export and import keep the lines |
| `e2e/pose-animation-plugins.spec.ts` | a kept animation in the library appears for an assembly it was not written for, its member parameter is a select of that assembly's members, it plays with the chosen member, and Keep in library… writes a project animation to the library |
| `mcp/plugin-corpus.test.ts`, `mcp/animation-plugin.test.ts`, `mcp/pose-animate.test.ts` | unchanged behaviour |

## 5. As built

- `src/anim-members.ts` holds the shared pieces: `nameMatcher` (the `*` and `|` matching `rigGroup` now uses),
  `memberNamesOf` (the rig's names, which `animationRig` now uses), `namesInCall`, `membersOfRun`, `missingMember`,
  `explainNoMember`, `needsLine`, `fixedNamesHint`, and the header list reader and writer.
- MCP: `pose_animate {keep}` (`keepAnimation`), `nugget save {kind: "animation", from | source, members}` and the
  `kind: "plugin"` fallback (`animationSaveFrom`, which runs the project's animation once more on its assembly when it
  is still there), `pluginSave`'s animation mode (`animationCheck`: describe, then the member lists), `nugget find`,
  `get`, `export`, `remove` with `kind: "animation"`, `needs` on find, list and get rows, and the project's animations
  the library lacks listed by `find` with the call that keeps them. Both animation runners return the names the run
  sent (`used`).
- One behaviour change found on the way: a project keeps an animation's values under its name, and a plugin run under
  that name on *another* assembly inherited them, member names included, so the second clock was refused with the
  first clock's names. Values kept for another assembly no longer carry their member parameters over (MCP), and the
  window keeps member choices per assembly.
- Window: the member select, the refusal before Play, Keep in library… (`src/app/pose-animation-keep.ts`), and the
  Plugins panel's target line ("Poses an assembly with members: …").
- `crates/lime-recipe` is unchanged, and so is the recipe API level.

## 6. Out of scope

- A new parameter kind in `lime-recipe` (A2).
- Running animation defaults on a test assembly at import (an import still describes only).
- The rename map (A2).
