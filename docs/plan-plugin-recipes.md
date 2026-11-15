# Recipes that use plugins (recipe API 1.16)

Status: built on `claude/clock-plugin-recipes` for 6.8.0 (F5 of the cat-clock note,
`lime-workspace/cute-clock/clock-function-plan.md`, section 5). This file is the spec the code follows.

## 1. Why

An agent built a printable cat clock with Lime Slice. Every part is a kept plugin ("Clock wheel on arbor", the Graham
anchor, the ratchet and click), but the clock itself is a 65-step MCP plan written by a Python script, because a recipe
cannot run another plugin and the plan cannot compute. The owner's goals for this area:

- every recipe an agent writes can become a plugin, and recipes are never reduced to fit;
- a plugin that makes its own parts runs with nothing open (no dummy part);
- an assembly built over MCP keeps one Lime Slice object per part.

So a recipe must be able to run a kept plugin and get its parts back, place them in an assembly, set joints and couple
gears, and the whole thing must then be one plugin with a `module` parameter, rebuilt by one rerun.

## 2. What existed

- `crates/lime-recipe`: `Session` talks to the host in JSON lines (a call, a reply). `s.call(tool, args)` reaches any
  tool in `RECIPE_TOOLS` (`src/recipe/host.ts`).
- The MCP host (`mcp/session/recipe.ts`): a run is one transaction. A refusal the recipe does not handle, a panic, a
  limit or a cancel takes back every object it made (`created`) and every step it added (`touched`). A recipe may change
  only the part it was given and the parts it made (D11.1); `model_place` and `object_place` only the parts it made.
  A rerun (`recipe_run {object, params}`) makes the parts again and hands each new object the old handle (`takeOver`).
  A kept plugin's run is stamped on its parts (`PluginStamp`), and the project keeps a copy of each stamped plugin's code
  (`pluginCopies`), so the part rebuilds where the library lacks it.
- The app's host (`src/recipe/apply.ts`, `rebuild.ts`, `app-calls.ts`): the same protocol, the calls answered against
  the window's trees by `AppRecipeCalls`; the Plugins panel keeps the parts the run made as new plate objects in one undo
  step (`addMadeObjects`). Its start context says `canAssemble: false`, and `model_place {to}` is refused there.
- One recipe could carry another's code only as an ingredient (`inlineIngredients`): library code compiled into the
  recipe as `mod ingredients`.
- The assembly side on main: `model_place {object, to, x, y, z, turnX..Z}`, `{joint}` (hinge, slide, ball, held),
  `{angle}`, `{gears: "couple"}` (`mcp/session/place.ts`, `docs/plan-gear-coupling.md`, `docs/plan-gear-kinds.md`).

## 3. Decisions

### 3.1 Mechanism: a nested run, not linked code

`s.run_plugin(id, params)` sends one call, `plugin_run {plugin, params, version?}`. The host runs that plugin as a run of
its own inside the outer run: its own build (in a slot of its own), its own start line and parameters, its own calls,
restricted to its own parts. When it reaches `done`, the parts it made become the outer run's (`created`), and the reply
names them: `{object, objects, metrics, plugin: {id, version}}`. The crate reads that as `PluginRun {plugin, version,
part, parts, metrics}`.

Why not link the code in, as ingredients are:

- Two plugins' parameters would share one namespace: both read `s.number("module")` from the same start line.
- A plugin is a program with `fn main`, describe mode, its own carried data (`data {name}`) and its own copy of its
  ingredients (`mod ingredients`); two of them in one file clash on all of these.
- The version that ran must be pinned by the hash of the plugin's code. A nested run builds exactly that file.
- The nested plugin's own rules hold unchanged: it can touch only what it made, and its refusals are its own sentences.

The cost is one more process and one build per distinct plugin (a slot stays warm, so the second and third run of the
same plugin build nothing).

### 3.2 Versions

- With no version asked, a nested run uses the **pin** recorded with the outer run's parts, else the library's current
  version. A pin is `{version, sha256}` by plugin id, kept in the outer run's stamp (`PluginStamp.uses`) and its record
  (`RustRecipe.uses`, MCP).
- A pinned run looks up the code by its hash: the project's copy, the library's current file, the library's older files
  (`<id>.vN.rs`). When the library has a newer version, the reply says so: "v2 of gear-on-arbor is in your library; this
  run used v1, the version this recipe ran before. Run the recipe as a new run to use v2." A new run (not a rerun) takes
  the library's current version and pins that.
- Pinned code found nowhere is refused with a sentence; nothing runs.
- `s.run_plugin_version(id, version, params)` asks for one version.

### 3.3 Recursion, depth, limits

- A plugin cannot run itself, directly or through others: "loop-a runs loop-b runs loop-a: a plugin cannot run itself,
  directly or through other plugins, so nothing ran."
- At most `MAX_PLUGIN_DEPTH` = 3 nested runs inside one another.
- **Time**: the outermost run's limit is one deadline for the whole tree; a nested run gets the time left.
- **Calls**: one budget (`RecipeLimits.spent`) counts the calls of the recipe and every plugin it runs against
  `maxCalls` ("The recipe and the plugins it ran made more than 2000 calls and were stopped").
- **Memory**: each program has its own 1 GiB cap (`--max-memory`), so a chain holds at most depth + 1 programs.
- **Parts**: in the app, nested parts join the outer run's, and `MAX_APP_RECIPE_PARTS` bounds them together.
- **Slots**: a slot whose program is running (an outer recipe waiting on its nested run) is never rebuilt for another
  recipe, in either host (`RUNNING` in `mcp/recipe.ts`, `running` in `src/recipe/tauri.ts`). With four slots and three
  levels there is always one free.

### 3.4 Failure

- A nested refusal comes back as the recipe's `Err`, with the plugin's title before its own sentence ("picky-gear: More
  than 100 teeth is more than this plugin cuts."). Nothing of that nested run is left: its parts are taken back at once,
  so the recipe can carry on.
- An `Err` the recipe does not handle ends the whole run, which takes everything back, the parts of earlier nested runs
  too.
- A nested run cannot checkpoint: the outer run keeps or takes back the whole.

### 3.5 Trust

A plugin from someone else is shown to a person before its first run (D11.6, `needsFirstRun`). It must never run hidden
inside another:

- Over MCP, a plugin marked imported (`imported.json`, with this code) is refused from inside another, and so is one in
  a read-only library: "Imported gear was imported and no person has run it yet, so it does not run from inside another
  plugin. Run it once from the app's Plugins panel, where its code is shown, then run this recipe again."
- In the app, `needsFirstRun` decides, as for a run from the panel: a library plugin marked imported, or a project's
  copy the library does not hold and nobody approved here.
- A plugin whose library file was edited outside the app is refused until it is run once on its own (which keeps it as a
  new version).
- A plugin that needs a part (`target: object`) or an animation is refused: a nested run makes its own parts.

### 3.6 What the project keeps

The outer run's stamp pins each plugin it ran (`uses`), and the project keeps the code of every pinned plugin by its hash,
beside the stamped plugins' copies: `pluginCopies` (MCP) and `stampedShas` (app) read the pins. The nested plugin's
carried data is in its own file. So a project rebuilds from the file alone when the library is gone; the MCP test saves,
empties the library, reopens and reruns.

### 3.7 Assembly: calls a part recipe makes, not a new kind

Placing, joints and couplings are the calls a `part` recipe already makes where the host lets it (`model_place`, with
`context.limits.canAssemble`), now with typed wrappers: `s.attach(&part, &parent, at, turn)`, `s.joint`, `s.hinge`,
`s.slide`, `s.hold`, `s.turn_joint`, `s.couple_gears`. A separate `assembly` kind would split making a part from placing
it, while the clock is one run that makes, places and couples; the refusals are the tools' own, unchanged.

Three things changed under them, in the MCP host:

- **One undo step.** A recipe's `model_place` calls used to push a plate undo step each ("Pose", "Gears"). While a recipe
  runs, `remember` now only notes that it would have, and a run that did keeps the plate as it stood before the run as
  one step, "Recipe <name>".
- **Reruns keep the assembly.** A rerun's new parts take the old handles; the assemblies the new run built named the new
  ids and stood beside the old assembly, whose couplings no longer fit. `rerunAssemblies` (`src/recipe/rerun-assembly.ts`)
  renames the new run's members and couplings to the old handles and puts that assembly in the old one's place, with its
  id and name. A part the run did not make that someone put in the assembly after the run stays, with its link.
- **Couplings survive save and reopen** because they now name live members with seats that fit.

### 3.8 App versus MCP

| | MCP | App (Plugins panel) |
|---|---|---|
| `run_plugin` | yes | yes (`src/recipe/app-nested.ts`): built by the app's runner, answered by an `AppRecipeCalls` of its own, parts adopted (`adopt`) |
| pins, project copies | stamp and record; `projectPlugins` | stamp; `session.plugins` (`keepUsedPlugins`) |
| trust | imported marks, read-only libraries | `needsFirstRun` |
| assembling (`canAssemble`) | yes | yes since 6.8.0 (section 6); before, refused with its sentence |

Section 6 builds what this paragraph asked for. Why the app said `canAssemble: false` in 6.7: the app's run hands its parts back to the panel, which commits each as a
new plate object (`addMadeObjects`). Placing in an assembly, joints and Couple gears live in `mcp/session/place.ts` as
methods of the MCP `Session` (its `find`, `assemblies`, `writeSolved`, parameters), and the window's own assembly code
(`src/app/assemblies.ts`, `src/app/pose.ts`) edits `session.assemblies` of the open project directly. Lifting it safely
needs a host-neutral assembly editor (the place, joint and gears logic over a list of parts and assemblies, shared by
both) that `AppRecipeCalls` can run on the run's own parts, plus the panel committing the run's assemblies with the new
objects in the same undo step. That is its own piece of work; this stage leaves the app's refusal in place ("An assembly
is kept by the plate, which a plugin run in the app does not change"), and a plugin that assembles runs over MCP.

## 4. The clock stage (proof)

`mcp/plugin-recipes.test.ts` keeps "Gear on arbor" (a gear with an arbor fused through it, parameters teeth, module,
thickness, phase, name) and "Gear train", which:

1. takes one parameter, `module`;
2. counts its teeth with `horology::count_train(0.75, 30, 3, TrainLimits::new(40, 64, 8, 10))` (50, 9 and 54 from the
   first two stages);
3. computes the centre distances with `gears::pitch_radius` and the mating phases with `gears::mate_phase`;
4. makes a plate, runs Gear on arbor three times, attaches each gear to the plate, hinges it and couples the train.

One call builds a train that turns (the centre wheel turned 30 degrees turns the pinion and the wheel by the tooth
ratios, and the mesh check still calls both pairs meshing). `recipe_run {object: plate, params: {module: 1.5}}` rebuilds
it under the same four handles, still one assembly, still hinged and coupled, meshing at the new module; one undo takes
it back to module 1 and redo returns. Saved and reopened, the train is coupled, and a rerun at module 2 rebuilds it
coupled. The corpus plugin for 1.16 (`mcp/fixtures/plugins/api-1.16-plugin-recipes.rs`) is a smaller train: a plugin run
twice from its companion in `companions/`, a missing plugin handled as `Err`, attach, hinge, couple and a turn.

## 5. Not done

- ~~Assembling in the app's runs (section 3.8).~~ Built for 6.8.0: section 6.
- ~~The app's rebuild of a run of several parts (a train)~~: built for a run that made all its parts (section 6.4).
- A nested plugin may not take a part from the outer run (`target: object`); a recipe that wants a plugin to change one
  of its parts runs that plugin's code as an ingredient.

## 6. Assembling in the app (6.8.0)

The owner's standard: a person in the window, with no agent, applies "Gear train" from the Plugins panel and gets the
assembled, coupled, turning train; one Undo takes it all back; another module rebuilds it under the same parts, still
coupled. So the app's host answers a recipe's assembly calls itself, and says `canAssemble: true`.

### 6.1 What moves, what stays

- **Moves** to `src/assembly-edit.ts` (no DOM, no session): what `model_place` does to assemblies. Attach (`to`), a
  member's offset and turn (numbers or expressions), the root's own pose (`withRootAt`), joints (hinge, slide, ball,
  held, none), `angle` and `travel` with the train they drive (`trainTurn`), `reach`, `root`, `gears` (couple, list,
  uncouple, with the validator's sweep), `couple` (ratio, winch, ratchet, clutch, remove), and `objects` joined at their
  poses. Each is a function of a world (the assemblies, the plate's parts with name, model pose, frame and Model tree,
  the parameters, and the host's box and centre of a part) that returns the new assemblies, the poses and frames it
  wrote, the undo label to remember first and the reply; or a refusal (code, sentence, which next step), with nothing
  changed. This is the shape `src/gear-train.ts` already has.
- **Stays** in `mcp/session/place.ts`: reading the session into that world (`assemblyWorld`), writing an edit back
  (`applyAssemblyEdit`: `remember`, `assemblies`, frames, poses, autosave), the wording of a refusal's next step
  (`NEXT`), `assembly_merge`, `writeSolved` (contact's `placeUntil` uses it), and `until`, which asks the kernel and
  belongs to the contact work.
- Why a world and not the session: the window's run holds its parts in `AppRecipeCalls` (copies of trees, poses, solids
  that reach the plate only at Apply), not plate objects, so the same code must run over either. The proof that MCP did
  not change is a probe of 110 `model_place` calls (every reply, the assemblies and every pose after each) that is
  byte-identical before and after, and the MCP tests' logs.

### 6.2 The app's host assembles

- `AppRecipeCalls` keeps the run's own assemblies. `model_place` is answered by `placeEdit` over a world of the run's
  made parts only (a nested run's parts are made parts once adopted), so the MCP rule holds unchanged: a recipe places,
  joints and couples only what it made, and a `to`, `objects`, `driven` or `click` that names anything else is refused
  with the sentence MCP gives. `until` is refused with a sentence (it asks the kernel for contact).
- A nested run assembles in its own `AppRecipeCalls`; `adopt` takes its assemblies with its parts (an id that clashes
  is renewed).
- Every start context of the window's runs (fresh, nested, rebuild) says `canAssemble: true`.

### 6.3 One undo step

The Plugins panel's Apply already puts the made parts on the plate in one Prepare step (`addMadeObjects`, inside
`noteEdit`/`flushEdit`, whose snapshot holds `session.assemblies`). The run's assemblies are added in that same step:
their ids renewed against the project's, members' frames set as the run set them, and each assembly solved and its
poses written as Pose writes them (`writeAssembly`: identity drops the key). The parts the run assembled keep the run's
model poses (they are "posed"), so the train stands as built; the print layout of the parts already on the plate does
not move, and the new parts are laid out as every new part is.

### 6.4 Rerun and rebuild

- The History card's Rebuild on any part of a run of several parts now rebuilds the whole set, when the run made every
  part (each part's root carries the run) and no part has steps after the run. The plugin runs fresh with the changed
  values and the stamp's pins; its made parts are matched to the old parts in plate order (the order the run made them),
  each old object takes its new tree and mesh and keeps its handle, name, place on the bed and, unless the run posed
  it, its model pose. The run's assemblies are renamed to the old handles and take the old assembly's place
  (`rerunAssemblies`, as over MCP), hinged and coupled; the assembly is solved and its poses written. One Prepare step,
  so one Undo goes back to the old set.
- It refuses with a sentence, and changes nothing, when: the new values make a different number of parts; a part has
  steps after the run (they would have to be replayed on several trees, which the window does not do); or the run
  changed a part it was given as well as making others.
- Saved and reopened, the project holds the assembly (members, joints, couplings) and the plugin's code, so the set
  rebuilds from the file.

### 6.5 The app's part cap

`MAX_APP_RECIPE_PARTS` stays 100. An assembling run's parts are the same plate objects a several-part run already makes;
the clock that motivated this (section 1) has about twenty, the gear train four. Nothing in assembling adds parts, so
there is no measured reason to raise it.
