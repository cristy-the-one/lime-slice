# Plan: recipes as plugins

Status: milestones 1 to 10 built (API 1.4 now; see the As built notes in section 14). Written 2026-11-01 against `main` at v4.8.0 (`723d1842`).
Companion: `docs/plan-recipes.md` (the recipe protocol, `recipe_run`, lust). This plan takes over that plan's
requirements S2 (named recipes kept in the session and project) and S8 (a recipe's part rebuilt from new parameters),
and widens them from "kept in a chat" to "kept in the app".

The owner's goal, in their words: "end goal with these 'lust recipe' feature is: each LLM interaction that makes use of
this feature can produce potentially a plugin for lime-slice, given that the code that is used to generate the various
things - are in fact 'rust code'."

## 1. Goal

A recipe that worked once is not thrown away. After a successful `recipe_run`, one call from the agent or one click
from the person keeps it as a **plugin**: a named, described, versioned Rust file with typed parameters. From then on:

- The app lists it in a Plugins panel in the Model tab, draws its parameters as a form, and runs it on a new part or
  on the selected part.
- An agent finds it with one cheap MCP call and runs it by name, instead of writing the same recipe again.
- The part it built carries a live History step: change a parameter later and the step rebuilds, with the steps
  after it replayed, as one undo step.
- A `.lime` project carries a copy of every plugin its parts were built with, so the project opens and rebuilds on
  another machine, and opens (without rebuilding) where lust is missing.
- A plugin is one file a person can send to someone else. Importing it is safe by construction: the sandbox has no
  files, network, processes or environment, and a plugin may only touch the part it is given and the parts it makes.

### Non-goals

- An editor for Rust source inside the app. v1 shows the source read-only and opens the plugin folder; agents and
  people edit the file elsewhere. (Decided: O7, section 13.)
- A public plugin store, signatures, or a server. Sharing is a file (section 7).
- Plugins that change slicing, settings, supports or G-code. The allowlist stays the Model calls of S4. A plugin is a
  solid modelling feature.
- Compiling plugins into the release app with rustc. Rule zero (lust and rustc send the same bytes) keeps that door
  open; it is not a step here.
- Turning `model_build` JSON builds (the "Built by a recipe" note, A8 of `plan-gui-mcp-parity.md`) into plugins. They
  already rerun with new parameters. Only Rust recipes become plugins.

### Words used here

| Word | Meaning |
|---|---|
| recipe | A Rust `main` written against `lime-recipe`, run once by `recipe_run {source}`. |
| plugin | A recipe kept under a name, with a front matter header: one `.rs` file (section 4). |
| draft | A recipe that ran with `apply` and reached `done`. Its source is in the session and in the project; it is one call or click away from being a plugin. |
| plugin step | The History step a plugin run leaves on a part: the ops it applied, stamped with the plugin, its hash and the parameter values (section 6). |
| library | The user's plugin folder (section 5). |
| API level | The `lime-recipe` crate's `major.minor` version, which a plugin records (section 8). |

## 2. Where things stand

- `recipe_run {source, name, params, object, mode, autofix, timeoutS}` builds a recipe with lust in a warm slot,
  runs it over protocol v1 and treats the run as one transaction (`mcp/recipe.ts`, `recipeRun` and `recipeRollback`
  in `mcp/session.ts`). The steps a run adds to a passed part become one undo group labelled `recipe <name>`, kept in
  memory (`obj.groups`), not saved. The source is not kept anywhere after the call.
- `crates/lime-recipe` has `Session::start`, `param_f64/u32/bool/str(name, default)`, `context()`, `object()`,
  `solid_new`, `apply`, `probe`, `volume`, `check`, `log`, `done`, `done_with`, a `Json` type and a few `ops` helpers.
  A parameter has a name and a default, nothing else: no range, unit or label, and the host cannot ask which
  parameters a recipe has without running it.
- lust ships in the Windows and Linux installers at `mcp/lust` beside `server.mjs` (#523); the app's own process never
  runs it. macOS has no lust: `recipe_run` answers "Recipes need lust" there.
- The desktop app does not run the MCP server and does not ship Node. Recipes run only in the MCP server today.
- The History tree (`src/model-tree.ts`) has group ops (`GroupOp`, kernel `Op::Group`), the MCP stores composites as
  groups (A9), the History panel folds runs of steps (`foldEndingAt`), and the Parameters panel
  (`src/ui/parameters.ts`, `src/param-rebuild.ts`) rebuilds steps whose expressions name a project parameter.
- A `.lime` saves each node's ops, the step's binary solid and the plate mesh, so a project opens without replaying
  anything (`docs/mcp-server.md`, "What shipped").
- The MCP tool list is held to token budgets (`mcp/schema.test.ts`: 750 per tool, 16,352 for the list; `recipe_run`
  is in the model group).

## 3. Keeping a recipe

### D1. Every applied run is a draft; a plugin is a promoted draft

A recipe that reached `done` in `apply` mode is already worth keeping: its part is on the plate and its History step
needs the source to rebuild. So the session keeps every such run as a **draft**, keyed by its source hash, and
`project_save` writes the drafts the plate's parts use into the project (section 5). Nothing reaches the user's library
without an explicit act:

- **Agent:** `recipe_run {..., keep: {title, description}}` keeps the run as a plugin when it succeeds, or
  `plugin {action: "save", from: "<recipe name>"}` keeps the session's latest successful run of that name.
- **Person:** the plugin step's row in History has "Save as plugin…", which opens a small dialog: title, description
  (prefilled from the agent's when there is one), author.

Why not save every run to the library automatically: a chat makes many small throwaway runs (`check`, `dry`,
corrections). The library would fill with near-copies. A draft costs nothing and lives with the project; promotion is
one call. (Decided: O1, section 13.)

A run that failed, a `check` or a `dry` run is never a draft.

### D2. What a plugin records

| Field | Source | Notes |
|---|---|---|
| `plugin` | the slug of the title, or `name` | `[a-z0-9-]`, at most 48 characters; the file name and the id in MCP calls |
| `title` | agent or person | one line, at most 60 characters |
| `description` | agent or person | at most 280 characters; plain text, shown as data (section 7) |
| `author` | the app setting "Plugin author", else `unknown` | never filled from an account, email or OS user name |
| `made-by` | the MCP client's `clientInfo.name`, and the model when the client says it | provenance only, e.g. `claude-code` |
| `version` | counts up from 1 | a save of the same `plugin` with a different body is the next version |
| `api` | `lime_recipe::API` when saved, e.g. `1.0` | section 8 |
| `lust` | `tools/lust/LUST_REV` short hash of the lust that built it | for a bug report, not checked |
| `source-sha256` | SHA-256 of the body (everything after the front matter), LF line ends | the identity of the code |
| `created` | date of the save | |
| `target` | `new`, `object` or `either`, from the describe run | whether it needs a selected part |
| `params` | the describe run (section 4) | a cache, so the form needs no lust |

### D3. Saving checks the plugin once more

A save runs the recipe in `describe` mode (section 4) to read its parameters, then once in `dry` mode with the
defaults. A plugin whose defaults do not build is not saved: "This plugin does not build with its own defaults: <the
run's sentence>. Change the defaults or the code, then keep it." That is the only guarantee a library entry gives: it
built once, as saved, with what its form shows.

## 4. Parameters

### D4. Typed parameters in `lime-recipe`, declared before the first call

A minor API addition (`1.0` to `1.1`, section 8). Plain builder calls, no macros, so lust and rustc take them alike:

```rust
use lime_recipe::{ops, Session};

fn main() {
    let mut s = Session::start();
    let d = s.number("diameter", 80.0).range(20.0, 250.0).step(0.5).unit("mm").label("Outer diameter").get();
    let holes = s.count("holes", 6).range(3, 24).label("Bolt holes").get();
    let bore = s.toggle("bore", true).label("Centre bore").get();
    let style = s.choice("edge", &["fillet", "chamfer", "sharp"], "fillet").get();
    // ... calls start here
}
```

| Builder | Value | Settings | Form control |
|---|---|---|---|
| `number(name, default)` | `f64` | `range(min, max)`, `step`, `unit` (`mm`, `deg`, `%`, or none), `label`, `help` | scrub field (`src/ui/field-scrub.ts`), takes an expression of project parameters |
| `count(name, default)` | `u32` | `range`, `label`, `help` | integer scrub field |
| `toggle(name, default)` | `bool` | `label`, `help` | checkbox |
| `choice(name, options, default)` | `String` | `label`, `help` | select |
| `text(name, default)` | `String` | `max_len`, `label`, `help` | text field (for embossed text) |

- `get()` returns the value the host passed, or the default; a number outside its range is clamped and the run's
  notes say so in one line, so a rebuild never fails on a stale value the form would not allow.
- The old `param_f64` and friends stay and mean `number(name, default).get()` with no range. Recipes written before
  1.1 keep building.
- **Describe mode.** The host's start line carries `describe: true`. Each `get()` records its parameter and returns
  the default. At the first call (or at `done`) the session writes one line, `{"params": [...], "target": ...}`, and
  the host ends the process. No call reaches the engine. `target` is `object` when the recipe read `s.object()` before
  that point and treated `None` as an error, `either` when it read it and coped with `None`, otherwise `new`. (A
  recipe that reads `s.object()` and unwraps it is `object`; the host learns this because describe mode passes no
  object and the recipe panics with lime-recipe's own "needs a part" message.)
- **Declared before the first call.** A parameter declared after a call would be missing from the form. In a normal
  run the session notes it (`{"late_param": name, "at": line}`), and a save refuses: "Declare `holes` before the
  first call (line 12), so the form can show it."
- The protocol stays version 1: an old host ignores the new lines, and a recipe that never declares typed
  parameters never sends them.
- `cargo test -p lime-recipe` checks the JSON of each builder; `mcp/recipe.test.ts` checks the describe line against
  the scripted host under lust and rustc (rule zero).

### D5. The form

The Plugins panel (section 9) and a plugin step's edit panel draw the same form from `params`, in declared order:
label (else the name), the control, the unit, and `help` as the field's hint. Fields use the Model panels' layout and
classes (D4 of `plan-gui-mcp-parity.md`), so the form needs no new look. A number field takes an expression of project
parameters (`wallH / 2`), stored as text beside the value, the way an op's `exprs` are; changing that project
parameter offers the plugin step's rebuild, as the Parameters panel does for other steps.

### D17. API 1.2: values a person picks

A plugin that works on a part needs to know *where* on it: which face, which outline. Before 1.2 it took a face as an
index or `{normal, nearPoint}` typed by an agent, and an outline as a data file, both frozen into the step. 1.2 adds two
kinds a person picks in the form and the host resolves on the part as it stands.

| Builder | The recipe gets | A person supplies | An agent passes |
|---|---|---|---|
| `face(name)`, `.rule(r)` or `.rule("largest").facing(dir)` | `s.pick_face(&part, &f)`: index, normal, a point, area, and its outline (`Section`: frame, region, loops) | **Pick face**: a click on a flat face in the view | an index, or `{normal, nearPoint}` |
| `outline(name)`, `.default_poly(p)`, `.default_loops(l)`, `.default_face(r)` | `s.pick_outline(&o)`: a `Section` (frame, region, loops, area) | **Pick a sketch** (an extrude's or revolve's step on the plate) or **Use a face's outline** | `{sketch: step, object?}`, `{face, object?, insetMm?}`, `{loops, origin?, turn?}`, `{data: name}` |

- **Resolved by the host, through one call.** `pick` is the host's own call, like `log` and `data`; `get()` only declares
  the parameter, so it stays before the first call and describe mode lists it (`kind: "face"`, `default: {rule}` or
  null). The answer is read through the run's own `faces_find` and `section` answers, in `src/recipe/picks.ts`, which
  the MCP session and the app share, so both resolve the same face.
- **What is kept.** The stamp, a preset and the form keep a face as `{normal, nearPoint, areaMm2}` (an index is turned
  into that on the part as shown when the call came, since a rebuild starts from an earlier step whose faces are
  numbered otherwise), a sketch as `{sketch, object}`, a face's outline as `{face, object}`, loops as given, and data as
  the loops it held, so a project carries no file. A rule is the default and is never kept: a step built with the
  default follows the rule on each rebuild.
- **Replay.** Each run resolves again: the kept face is the flat face with its normal (within 5°) under the kept point,
  the nearest along the normal, so an earlier step that moved or grew it does not lose it, and the stamp keeps the
  point where the face now is. A sketch is read from its step as it is now.
- **Refusals,** one sentence each, the part kept: a face with nothing under its point ("The face picked for face
  (facing +Z, near 0, 900, 20) is no longer on the part. Pick it again; the part is kept as it was."), a curved face or
  index ("face: face 7 is not a flat face of this part. Pick a flat face."), no face and no default, a sketch step that
  is gone or is not an extrude or revolve, data that is not an outline. A recipe that unwraps a refused pick fails with
  the pick's sentence, not the panic around it.
- **Trust.** The value the run was given always wins over what the recipe sends in `pick`; a recipe's own default may
  only be a rule or loops, so a plugin cannot name another part or a sketch by itself (O8 holds: a face is read on the
  part given or made; an outline may come from any part the person named).
- **Also in 1.2:** `s.refuse(sentence)` ends a run with that reason and nothing kept (no panic line), and
  `s.bounds(&part)` reads the box `model_describe` now answers. Plugins of 1.0 and 1.1 build and run unchanged.

## 5. Where plugins live, and the file

### D6. One `.rs` file with a front matter header

```rust
//! ---
//! plugin: bolt-circle-flange
//! title: Bolt-circle flange
//! version: 3
//! description: A round flange with bolt holes on a circle and an optional centre bore.
//! author: Marius
//! made-by: claude-code (claude-opus-5-5)
//! api: 1.1
//! lust: 9df185cd
//! source-sha256: 4f2c...e1
//! created: 2026-11-01
//! target: new
//! params: [{"name":"diameter","kind":"number","default":80,"min":20,"max":250,"step":0.5,"unit":"mm","label":"Outer diameter"}]
//! ---
use lime_recipe::{ops, Session};

fn main() { /* ... */ }
```

- The header is inner doc comments, so the file is a valid `main.rs` as it stands: lust builds it, rustc builds it, an
  editor highlights it, and it reads on GitHub or in a chat.
- `key: value`, one per line; `params` is one line of JSON (it is a cache the host writes, not something to type).
- The hash covers the body only, so editing the description does not make a new version; editing the code does.
- The body ends with the recipe data the run read, when it read any (`data {name}`), one `// data:` line per name
  after a fence line: plain comments, so the file still builds as it stands (As built, "plugins carry the recipe data
  they read", milestone 7).
- A file whose body does not match its hash is treated as edited by hand: the app recomputes the hash and `params`
  (one describe run), bumps `version`, and says so once.
- Rejected: a folder with `manifest.json` and `main.rs` (two files to send, two to keep in step), and a JSON file with
  the source as a string (unreadable, does not build as is). (Decided: O2, section 13.)

### D7. Three places

| Place | Path | Written by | Read by |
|---|---|---|---|
| Library | `<app data>/plugins/<plugin>.rs`: `%APPDATA%\com.limeslice.slicer\plugins` on Windows, `$XDG_DATA_HOME/com.limeslice.slicer/plugins` (default `~/.local/share/...`) on Linux, `~/Library/Application Support/com.limeslice.slicer/plugins` on macOS | the app; the MCP server (`plugin save`, `keep`) | both |
| Project copy | `.lime` top-level `plugins`: `{ "<source-sha256>": "<whole file text>" }` | `project_save`, the app's Save | both, on open |
| Samples | `samples/plugins/*.rs`, shipped read-only beside `server.mjs` (`mcp/plugins/`) | this repo | both; listed with a "sample" badge |

- The MCP server finds the library from the same identifier; `LIME_PLUGINS_DIR` overrides it (tests, portable
  installs). Today every MCP write stays under `LIME_MCP_WORKSPACE`. The library is a second, narrow write root: only
  `<slug>.rs` files, written whole through a temp file and a rename, and never a file the call did not name. (Open
  decision O3.)
- The project copy holds every plugin and draft a plugin step on the plate names, and nothing else. It is the reason a
  project never depends on the library: the library is for running new things; the project copy is for rebuilding
  what is there.
- An older version in the library is kept as `<plugin>.v2.rs` when a new version is saved, so a project's step that
  names v2 can still find it there even without its own copy. At most the last five versions are kept.

## 6. A plugin step in History

### D8. The ops stay real; the plugin is a stamp on them

A plugin run is stored exactly as today: the root primitive of a part it made, and the concrete ops it applied, each a
normal node with its solid. What is new is a **stamp** on the run's first node and a run id on each node of it:

```ts
interface PluginStamp {
  plugin: string;          // slug
  version: number;
  sha256: string;          // the body that ran
  api: string;             // "1.1"
  params: Record<string, number | boolean | string>;
  exprs?: Record<string, string>;   // a number field typed as an expression of project parameters
  context: { bedMm: [number, number, number]; nozzleMm: number };  // what the run read
  fingerprint: Fingerprint;          // of the run's last node
}
// ModelNode gains: plugin?: PluginStamp (first node of the run); run?: { id: string; k: number; n: number } (every node of it)
```

Why a stamp on ordinary nodes and not one `GroupOp`: a recipe may fillet by edge index, join, split or scale, which a
group refuses (D2 of `plan-gui-mcp-parity.md`). A stamp works for every op, and it keeps the part's history readable by
anything that reads trees today. `model-tree-file.ts` reads and writes both fields; the kernel never sees them
(stripped in `src/model-request.ts`, as `exprs` are).

- **Opening a project needs no lust.** Every node has its ops and solid; nothing replays. The stamp only matters when
  someone changes a parameter.
- **The row.** History folds the run (`run.id`) into one row, "Bolt-circle flange · plugin v3", the way it folds
  composites; expanding it shows the steps. The row's edit button opens the form (D5) with the stamped values.
- **Undo.** The run is one undo step (the fold's `before`), replacing today's in-memory `obj.groups` entry, so it is
  also one undo step after a save and reopen.
- **Rebuild.** Changing a value and pressing Rebuild (or live, section 9) reruns the plugin with `object` set to the
  part at the run's parent node. The new run is a new branch from that parent, the steps that followed the old run
  are replayed on it (`replayChain`, as A6 does), and the whole thing is one undo step: Undo goes back to the old
  values on the old branch. A replayed step that fails is marked `broken`, as today.
- **A part the plugin made.** When the run made the part (its root came from the run's `solid_new`), the stamp is on
  the root and a rebuild makes a new tree for the same plate object, with the later steps replayed onto it, the way
  `model_build` starts a new root when its base moved. Plate undo goes back to the old tree.
- **Fingerprint.** A rebuild with unchanged values must land on the stamp's fingerprint (S9). When it does not, the
  rebuild still applies, and the row says once: "This plugin built a different solid from the same values; the
  plugin or the app changed since." That is how drift shows instead of hiding.
- **Context.** A run reads the printer's bed and nozzle. A rebuild uses today's; when they differ from the stamp's,
  the form says "Built for a 0.4 mm nozzle; a rebuild uses 0.6 mm."
- **Several parts in one run.** v1 stamps a run that made at most one part and changed at most the part it was given.
  A run that made several parts keeps them as plain parts with a note, "Made by bolt-circle-flange v3 with 2 other
  parts; run it again from Plugins to change it." (Decided: O4, section 13.) **Superseded 2026-11-06** (As built, "a
  plugin run that makes several parts", section 14): every part such a run keeps is stamped, one run id for them all,
  and the Plugins panel makes them all.

### D9. When the source changed or is gone

| Case | What the row shows | What works |
|---|---|---|
| The project copy matches the stamp | nothing extra | everything |
| The library has a newer version of the same plugin | "v5 is in your library" with **Use v5** | Use v5 reruns with v5, values carried by name; new parameters take their defaults and removed ones are named in one sentence. Never automatic. |
| Only an older file: the project has no copy, the library has the same hash (`<plugin>.vN.rs`) | nothing extra | everything; the next save writes the copy |
| No copy anywhere | "The plugin source is not in this project or your library. The part is kept as built; its values cannot change." | the solid, every later step, undo, slicing. The form is read-only. |
| The copy's hash does not match the stamp (edited file) | "This project's copy of the plugin was changed outside the app." | the solid; rebuild asks first, naming the change |
| No lust here (macOS) | "Rebuilding needs lust, which the macOS app does not ship yet." | the solid, every later step; the form is read-only (section 10) |
| The plugin needs a newer API than this app | "This plugin needs recipe API 2.0, from Lime Slice 5.x; this app has 1.3." | the solid; the form is read-only |

A project always opens, and its parts are always the parts that were saved.

## 7. Sharing and trust

### D10. Export and import are the file

- **Export:** the Plugins panel's "Export…" writes the plugin's `.rs` (the same bytes as the library file).
  "Export with samples" is not needed: the file is the plugin.
- **Import:** "Import…", a dropped `.rs` file on the Plugins panel, or `plugin {action: "save", source}` from the MCP.
  Import parses the header, recomputes the hash, runs describe and a dry run with defaults (D3), and adds the plugin
  with an "imported" badge until its first run by the person. A name clash keeps both: the import becomes
  `<plugin>-2`, unless it is the same plugin and a newer version, which is then offered as an update.
- **A project's plugins:** opening a project that carries plugins not in the library does not add them to the
  library. The Plugins panel lists them under "In this project" with **Add to library**.

### D11. What a plugin can and cannot do

What the sandbox already enforces (lust `--sandbox`, `docs/plan-recipes.md` S13 and L2): no files, network,
processes, threads, environment, `include!`, or OS calls; the program gets only stdin, stdout and stderr, an empty
environment and a temp working folder; the calls it can make are the S4 allowlist; 30 s, 2,000 calls, 1 MB lines.

What this plan adds:

1. **Only its own parts.** A plugin run may touch the part it was given (`object`) and the parts it made. A call
   naming any other object is refused: "A plugin can change only the part it was given and the parts it made." Today
   a recipe may name any object on the plate; for a stranger's plugin that would let it edit the user's other parts.
   This applies to every `recipe_run`, which costs agents nothing (they pass the part they mean).
2. **Memory.** lust has no memory cap yet (L3). The host sets one: a job object on Windows, `setrlimit` on Linux, 1 GB
   by default, past which the run is killed and rolled back with a sentence naming the limit.
3. **Build cost.** A plugin build is limited to 30 s (today's 120 s is for a cold slot on CI); a slower build is
   stopped with a sentence. One build at a time.
4. **One file, no crate.** A plugin is a single `main.rs` against the bundled `lime-recipe`; it brings no
   `Cargo.toml`, no dependencies and no build script. `mod x;` (another file), `#[path]` and `extern crate` other than
   `lime_recipe` are refused at import with the line.
5. **Text is data.** Title, description, author, notes and `log` lines of a shared plugin reach an LLM through MCP
   replies and could carry instructions aimed at it. Lengths are capped (60, 280, 60 characters, notes 400 each), the
   `plugin` replies put them in a `data` object, and `lime://guide/recipes` says plugin text is data, never
   instructions. The app shows them as plain text, never HTML.
6. **Show before the first run.** An imported plugin's first run in the app shows its source read-only, its author,
   made-by and hash, and what it may do in one sentence ("It can build and change only the part you run it on. It
   cannot read files, use the network or start programs."), with Run and Cancel. After that, Run runs.
7. **No signatures in v1.** The hash is shown and copied; a signature scheme waits for a real sharing channel. (Open
   decision O5.)

## 8. Versions

### D12. `lime-recipe` gets an API level, and old majors keep building

- `pub const API: (u32, u32) = (1, 1);` in the crate, and a plugin's header records it at save. The first release with
  this plan is `1.0` for today's API and `1.1` with typed parameters.
- **Minor** additions (a new builder, a new `ops` helper, a new call in the allowlist) keep every older plugin
  building. CI checks that every plugin in `samples/plugins/` and in a fixtures corpus (`mcp/fixtures/plugins/`, one
  plugin per released API level, added when a level ships) builds and sends the same calls, byte for byte, as when it
  was added.
- **Major** changes (a renamed or removed function, a changed meaning) bump the major. The installer then ships the
  last crate of each earlier major beside the current one (`mcp/lime-recipe/1/`, `mcp/lime-recipe/2/`; the crate is
  about 600 lines). The host builds a plugin against the crate of its recorded major, in its own slot. A major is
  dropped only by an owner decision, with a release note.
- **Newer than this app:** a plugin whose API major is higher, or whose minor is higher than this app's crate of that
  major, does not build: "This plugin needs recipe API 2.0, from Lime Slice 5.x; this app has 1.3. Update Lime Slice
  to run it. Its parts are kept as built." No attempt is made, because a lust error about a missing function would
  read like the plugin's fault.
- **Op JSON.** A plugin's ops are the MCP op JSON, which can change under it even when the crate does not. Op kinds and
  fields are only added; a renamed field keeps its old name as an alias reader in the session. The fixtures corpus
  catches a break.
- **lust.** A `LUST_REV` bump runs the corpus too. lust changes that refuse code it used to accept fail CI on that
  bump, not on a user's machine.
- **API 1.4 (one frame for reads and cuts).** `PickedFace` gains `centre` (a sphere's) and `axis_point` (a round face's
  axis point), an addition, so the minor moves to 1.4 and a plugin that reads them says so in its header. The same
  release fixes the reads for every level: `bounds`, `pick_face`, `faces_find`, `edges_find`, `surface_at` and
  `model_describe` answer in the frame `apply` takes (model space for a part `model_place` moved or turned, the part's
  own frame with `frame: "part"`), over MCP and in the app alike (`src/modeling/typed-view.ts`). Before, they answered in
  the solid's own frame, so a recipe that measured a moved part and cut at the point missed by the pose. This is a
  fix, not a changed meaning: on a part with no pose every answer is the same number, and a 1.0 to 1.3 plugin that
  measured and cut now hits a moved part too. A plugin that worked around it by adding the pose (moon-crater-field v2
  parsed "sits at (x, y, z)" from a probe's refusal) finds no such text any more, so it adds nothing. Kept faces in a
  stamp stay in the part's own frame, so a move never loses a pick.

## 9. Library and discovery

### D13. A Plugins panel in the Model tab

- **Where:** a "Plugins" button in the Model toolbar (beside Parameters in the overflow while the toolbar is full),
  shortcut Ctrl+Alt+L, opening a dock panel the way Parameters does (`openDock`). It needs no part open: with an
  empty plate Model's empty card offers **Run a plugin…** (As built after milestone 10, 2026-11-06).
- **List:** a search field (title, description, plugin name), then sections: "In this project", "Your plugins",
  "Samples". Each row: title, one line of description, version, author, and badges (`imported`, `sample`, `needs a
  part`). Sorted by last used.
- **Selected plugin:** the form (D5), a target line ("Builds a new part" or "Changes <selected part>"; a plugin that
  needs a part and has none says "Select a part to run this on"), **Preview**, **Apply**, and a menu with View
  source, Export…, Reveal in folder, Remove from library.
- **Preview:** a `dry` run whose result shows as the probe ghost the Model panels use, then is rolled back. With
  "Live" checked, a field change previews again 300 ms after the last change, when the last run took under 1 s; a
  slower plugin previews on the button only.
- **Apply:** one `apply` run; the plugin step lands in History as one row and one undo step. A refusal shows the
  engine's sentence and the plugin's line, as the MCP reply does.
- **History row menu:** Edit values (the form, D8), Save as plugin… (a draft), Use vN (D9), View source.

### D14. MCP: one new tool, and `recipe_run` takes a plugin

Lean, after #405: one tool with an action, and two fields on `recipe_run`.

```text
plugin {action: "list" | "get" | "save" | "remove", id?, query?, from?, source?, title?, description?, withSource?}
recipe_run {..., plugin?: id, keep?: {title, description}}
```

| Call | Answer |
|---|---|
| `plugin {action: "list", query?}` | Up to 20 rows, one line each: `id`, `v`, `target`, and the parameters as `diameter mm 80 [20-250], holes 6 [3-24], bore true`; `data.title` and `data.description` per row. Library, project and samples; drafts of this session as `draft:<name>`. |
| `plugin {action: "get", id, withSource?}` | The header fields, `params` in full, and the source only with `withSource: true`. |
| `plugin {action: "save", from: "<recipe name>" \| source, title, description}` | D3's checks, then the file. The reply is `{id, version, sha256}` or the sentence of the check that failed. |
| `plugin {action: "remove", id}` | Removes a library plugin (older versions too). Parts built with it keep their project copy. |
| `recipe_run {plugin: id, params, object?, mode?}` | Runs the saved plugin; `source` is then not given. The reply is today's. |
| `recipe_run {source, ..., keep: {title, description}}` | Today's run; on success, also a save. |

- Budget: the `plugin` tool is about 220 tokens and the two `recipe_run` fields about 40; the list grows by about 260,
  to about 16,610, and `TOTAL_BUDGET` moves with a comment in `mcp/schema.test.ts`, as for `recipe_run`. Both are in
  the model group, so the first list with groups on does not grow.
- `session_info` adds one line: "Plugins: 14 in your library, 2 in this project."
- **Guidance to reuse before writing.** `lime://guide/recipes` gains, first: "Before writing a recipe, plugin {action:
  \"list\", query} with a word or two of what you need. Run one that fits with recipe_run {plugin, params}. To change
  one, get it withSource, edit, run, and keep the result as a new version. Keep a recipe that worked and that someone
  could want again: keep {title, description}." The server's instructions line for Model gains the first sentence.
- **Drafts are listed** so an agent in a later chat on the same project finds what an earlier chat ran, even if
  nobody kept it.

## 10. Platforms

### D15. Windows and Linux run plugins with the bundled lust; macOS keeps what it has

- **Windows and Linux:** the app finds lust where the installer put it for the MCP server (`mcp/lust/bin/lust`
  beside `server.mjs`, in the app's resources), or at `LIME_LUST`. The app and the MCP server use separate daemons
  and slot roots; neither waits on the other.
- **macOS until lust builds there:** nothing runs. The Plugins panel lists plugins and shows their forms read-only with
  one line: "Running plugins needs lust, which the macOS app does not ship yet. Projects open, and parts built with
  plugins are kept as built." Import and export work (they need no build; the describe run is skipped and the header's
  `params` are used, with the plugin marked "not checked here"). `plugin list` and `get` work over MCP; `save` from
  source and `recipe_run` answer with the same sentence. Projects open with every part.
- **When lust reaches macOS:** the installer gains it like the others; no plan change.

## 11. How the app runs a plugin

### D16. The protocol host is shared TypeScript; Rust only spawns and pipes

The window has no Node, and the 12 recipe calls are answered today by `mcp/session.ts`. So:

- **`src/recipe/host.ts`** (new, browser-safe): the protocol v1 host from `mcp/recipe.ts` (line handling, limits,
  refusals, `done`, describe), with the process behind a small transport interface. `mcp/recipe.ts` keeps the Node
  transport (spawn, pipes, slots) and re-exports the host, as `src/modeling/` is shared today.
- **`src-tauri/src/recipe.rs`** (new): `recipe_build {slot, source, crateMajor}` runs `lust build --sandbox --json`
  in the app's slot root and returns its JSON; `recipe_start {exe}` spawns the program with an empty environment, the
  memory cap (D11) and a kill on window close, and emits each stdout line as a `recipe-line` event; `recipe_send
  {line}` writes a reply; `recipe_kill`. Limits are enforced here too, so a stuck webview cannot leave a recipe
  running.
- **`src/recipe/app-calls.ts`** (new): answers the 12 calls against the app's own Model (the tree, the probe, faces
  and edges). Where the MCP handler and the app already share code in `src/modeling/`, the call uses it; where they do
  not (face and edge finders), the step moves the MCP handler into `src/modeling/` first, with the MCP tests unchanged.
  This is the largest single step (milestone 6).
- **Transaction:** the app run commits once at `done` and rolls back by dropping the run's branch, the way the MCP
  session rolls back.

Rejected: a host in Rust (a second copy of the call handlers, which are TypeScript), and running plugins through the
MCP server from the app (the app does not ship Node and the server is the user's to start).

## 12. Risks

| Risk | Effect | What limits it |
|---|---|---|
| The app call adapter (D16) disagrees with the MCP's handlers | a plugin builds a different part in the app than through MCP | handlers move into `src/modeling/` and are shared, not copied; a test runs each sample plugin through both and compares fingerprints |
| A plugin step rebuild replays many later steps | slow edit on a long history | it is the same `replayChain` the Parameters panel uses; the edit says how many steps it will replay before it starts |
| Determinism breaks (kernel or lust change) | a rebuild with unchanged values gives a different solid | the fingerprint check in D8 says so on the row; the corpus in CI catches it first |
| A shared plugin is hostile | edits other parts, eats memory, misleads an agent through its text | D11: own parts only, memory cap, build limit, text as data, source shown before the first run |
| API drift strands old plugins | old projects cannot rebuild | D12: minor is additive, majors ship side by side, the corpus is CI-tested, and the solid is kept regardless |
| The library fills with near-copies | discovery gets worse | drafts are not plugins (D1); versions replace, not add; `remove` exists |
| Two writers of the library (app and MCP) | a save lost | whole-file writes through a rename; a save of an existing plugin re-reads it and bumps the version from what is there |
| macOS users get plugin projects | values cannot change on a Mac | D15: the part is kept and the reason is one sentence |
| Token budget | a larger tool list | one tool with actions, ~260 tokens, in the model group |
| Describe mode misreads `target` | the form offers "new part" for a plugin that needs one | the dry run in D3 runs with no object for `new` and with a test cube for `object`; a mismatch is fixed in the header at save |

## 13. Decisions

The owner answered on 2026-11-01: the plan's choice stands for every question, and O6 has its sample.

- **O1. Keeping.** Drafts are kept automatically in the project; a plugin is saved only by an explicit keep.
- **O2. File format.** One `.rs` file with a `//!` front matter header.
- **O3. MCP writes outside the workspace.** The MCP server may write plugin files to the app's plugin folder,
  `<slug>.rs` files only.
- **O4. Multi-part runs.** Plain parts with a note in v1. Changed on 2026-11-06 at the owner's request (a 20-part
  puzzle box the window refused): each part stamped, one run id shared, the window makes them all (section 14, As
  built after milestone 10).
- **O5. Signatures.** No signing in v1; the hash is shown.
- **O6. Samples.** Yes, shipped in the installer, but in a later release than the plugin milestones. The first sample
  is the owner's gear pyramid recipe (`gear_pyramid.rs`: a ring of ten interlocked involute spur gears, 16 and 10
  teeth, module 2, on capped axle pins inside a hollow square pyramid, print-in-place), made a plugin with its
  numbers as parameters. One or two more are chosen then, for example from `plan-recipes.md`'s reference parts.
  The owner curates them.
- **O7. Editing source in the app.** Read-only source plus "Reveal in folder" in v1.
- **O8. Restricting every recipe to its own parts** (D11.1). Accepted for every `recipe_run`, not only saved plugins.
- **O9. Major API compatibility window.** Every earlier major's crate ships for good.

## 14. Milestones

Each is one PR to `main`, smallest useful first. Each updates `docs/mcp-server.md` (MCP behaviour) or
`docs/step-modeler.md` (app behaviour), and the version bump rides on the last PR before a release, as usual. MCP tests
run with `node --experimental-strip-types`; the real-lust tests run in CI with `LIME_RECIPE_REQUIRED=1` on Windows and
Linux and are skipped on macOS. App changes are proved with the `verify-ui` procedure.

1. **Keep and reuse through MCP.** Drafts in the session; the file format (D6) with hash; the library folder and
   `LIME_PLUGINS_DIR`; `plugin {list, get, save, remove}`; `recipe_run {plugin, keep}`; `API = (1, 0)` in the crate;
   the guide's reuse paragraph; own-parts-only (D11.1, pending O8); schema budget update.
   *Ships:* an agent can keep a recipe and a later chat can find and run it.
   *Tested by:* `mcp/plugin.test.ts` (scripted host: save, list with query, get, version bump on a changed body, same
   body keeps the version, name clash, remove, a header that does not match its hash), the real-lust session test
   (keep, then run by id, same fingerprint), `schema.test.ts` budgets, a refusal test for a call on another part.

   **As built (milestone 1, branch `claude/recipe-plugins-m1`, with milestone 2):**
   - **One store.** The plan's drafts are #527's `rustRecipes`, not a second map. That store already kept a run's
     source as it built, its parameters, its data and its objects, saved in the project as `mcpModel.rustRecipes`.
     It now also keeps runs that only changed a part (their `changed` parts; under the name, or `<name>@<part>` when
     the name's entry still has parts on the plate), each entry's `sha256` (D1's identity) and order (`at`), and the
     stamp `plugin: {id, version, sha256}` of the plugin a run came from or was kept as. `plugin list` shows them as
     `draft:<name>` and `save {from}` takes the latest of a name. Because #527 already saves the store, drafts outlive
     the session in the project (the plan had that at milestone 3); the project copy of a plugin as a file (`plugins`
     map, D7) and the stamp on nodes (D8) are still milestone 3.
   - D6's file and hash, D7's library (`LIME_PLUGINS_DIR`, five older versions), D14's tool and `recipe_run {plugin,
     keep}`, `API`, the guide's reuse paragraph (first in `lime://guide/recipes`) and its first sentence in the
     server instructions, and O8 for every run, as the plan says. `session_info.plugins` has no project count yet.
   - **Version or clash.** A save of the same body keeps the version. Another body is the next version when the run's
     name is the plugin's id (`recipe_run {plugin}` runs it under its id, and the guide tells an agent to edit and
     run it under that name); otherwise it is a different recipe with the same title, kept as `<id>-2` (D10's rule,
     brought forward for saves).
   - **Checks** (D3) run at every save, not only from milestone 2: a describe run, then a dry run with the defaults on
     the run's part or a 40 × 40 × 20 test block. D11.4's `mod`, `#[path]` and `extern crate` refusal is in (one
     line); the rest of D11 waits for milestone 8.
   - **Author** is `LIME_PLUGIN_AUTHOR` or `unknown` until the app's "Plugin author" setting (milestone 7); `made-by`
     is the client's `clientInfo.name` from initialize; `lust` is lust's build id from `lust --version`.
   - **Budget.** The tool and the two fields cost 281 tokens (the plan said about 260): the list is at 17,021 of
     17,030. Both are in the model group.
   - Tests: `mcp/plugins-file.test.ts` (format, hash, versions, removal, API check; no lust), `mcp/plugin.test.ts`
     (keep, list with a query, get, run by id with the same volume, held values, same body keeps the version, a new
     version, a clash, a hand-edited file, late parameters, defaults that do not build, a plugin that needs a part,
     a call on another part refused, a newer API refused, the project keeping drafts, remove; real lust, stand-in
     engine), `mcp/recipe-session.test.ts` (keep, then run by id on OCCT: the same fingerprint).

2. **Typed parameters.** `number`, `count`, `toggle`, `choice`, `text` builders; describe mode; late-parameter note;
   `API = (1, 1)`; `params` and `target` in the header; save refuses late parameters and defaults that do not build
   (D3).
   *Ships:* `plugin list` shows each plugin's parameters with units and ranges; agents pass valid values first time.
   *Tested by:* `cargo test -p lime-recipe` for each builder's JSON and clamping; `mcp/recipe.test.ts` for the
   describe line, byte for byte under lust and rustc; a plugin with a late parameter refused with its line.

   **As built (milestone 2, same branch):** the five builders with `range`, `step`, `unit`, `label`, `help`,
   `max_len`; describe mode; `{"note"}` for a held value, `{"late_param"}` after the first call; `API = (1, 1)`. The
   builders keep no reference to the session (a builder holding `&Session` crashed lust's borrow checker, as did a
   match guard with a closure over the bound value; both are written around in the crate). `target` is `object` when
   the describe run read `s.object()` and then panicked, `either` when it read it and went on, else `new`.
   `cargo test -p lime-recipe` checks each builder's JSON and the held values; `mcp/plugin.test.ts` checks the
   describe line through a save and the late-parameter refusal under lust; `mcp/recipe-geom2d.test.ts` builds the
   recipes guide's example (now typed) under lust and rustc, call for call.

3. **The plugin step in the MCP session and the project.** `PluginStamp` and `run` on nodes; `model-tree-file.ts`
   reads and writes them; `project_save` writes the `plugins` map; `project_open` reads it; `obj.groups` for runs
   replaced by the run id; `recipe_run {plugin, object, params}` on a stamped part rebuilds the step (new branch,
   later steps replayed, one undo step), with the fingerprint check.
   *Ships:* through MCP, a part built by a plugin can be changed later, and the project keeps the code.
   *Tested by:* `mcp/plugin-step.test.ts`: build, add two later steps, rebuild with a new value (later steps
   replayed, one undo goes back), save and reopen (nothing replays, stamp intact), rebuild after reopen with
   unchanged values lands on the same fingerprint; the stand-in engine for the tree, real OCCT and lust in CI.

   **As built (milestone 3, branch `claude/plugin-steps`):**
   - **No second store.** D8's `PluginStamp` and `run` are fields of `ModelNode` (`src/model-tree.ts`), read and written
     by `model-tree-file.ts` (a damaged one is left out and the step opens plain) and never sent to the engine. Drafts
     stay #527's `rustRecipes`: a draft's stamp names the recipe with `version: 0` and the hash its entry already
     keeps, and `project_save` now keeps every entry a stamp names. D7's `plugins` map holds library plugins only
     (with their inlined ingredients, #541), keyed by the body's hash; a draft's ingredient copies stay in its entry.
     Keeping a draft (`keep`, `save {from}`) turns the stamps it left on its own parts into the plugin's.
   - **Which runs are stamped.** Every apply that made or changed one part, plugin or not, so `{object, params}` can
     rebuild a draft too. O4's several-part run keeps plain steps and the session's undo group, with a note.
   - **Undo.** Found from the run id (`src/plugin-step.ts`), replacing `obj.groups` for stamped runs; the reply's
     `group` still reads `recipe <name>`. A run's rollback now also drops the steps it added, which before stayed as a
     branch `model_redo` could walk into (a `keep`'s check run did).
   - **Rebuild.** `recipe_run {plugin, object}` rebuilds the newest stamped run of that plugin on the shown path,
     instead of running it again on top; with no stamped run it runs on the part as before. The later steps are the
     ones on the way to the shown step (not the redo tail), replayed in one engine `edit` with step ids renamed when
     the new run has as many steps. A rebuild is one undo step back to the old branch through the session's group (not
     saved; after a reopen, undo at the tip steps back through the replayed steps one by one, then the run). A part
     the plugin made is rebuilt through #527's rerun, with the later steps replayed onto the new tree; the old object
     is kept for one `model_undo` (not saved).
   - **D9 over MCP.** No copy anywhere and a newer API refuse with the plan's sentences. The edited project copy
     refuses ("asks first" needs the app's dialog, milestone 6). A newer library version is a note; "Use vN" is the
     app's row menu (milestone 7), and over MCP a new run of the new version replaces nothing. Fingerprint drift is a
     note and `rebuilt.sameSolid: false`, not stored on the row.
   - **Not built:** `exprs` (a number typed as a project expression) waits for the form (milestone 6); a split to
     print after the run refuses the rebuild.
   - Tests: `mcp/plugin-step.test.ts` (real lust; real OCCT in CI's OCCT job, the stand-in engine in the MCP jobs):
     stamp and run marks, two later steps, one undo and redo of the run, a rebuild with a new value (later steps
     replayed, one undo back to the old branch, redo), save (stamps in the tree, the file in `plugins`), reopen with
     the library file gone (nothing built on open, stamp intact, rebuild from the project's copy with the same
     fingerprint, one undo), an edited copy and no copy refused, and a part the plugin made rebuilt with its later
     step and undone. `src/plugin-step.test.ts` (unit chain): marks, runs, redo, a cut chain, save and read back, a
     damaged stamp, the `plugins` map reader.

4. **The app reads plugin steps.** History folds a run into one row with the plugin's name and version; the row shows
   the form read-only and View source; the D9 cases as row messages; the app keeps the `plugins` map on save.
   *Ships:* an MCP-built plugin part opens in the app as one readable row, and every no-rebuild case is explained.
   *Tested by:* `src/model-history.test.ts` for folding and each D9 case on fixture trees; a Playwright spec opening a
   fixture `.lime` with a plugin step (row, form read-only, source view), screenshots in the owner's theme.

   **As built (milestone 4, branch `claude/plugin-steps-app`):**
   - **The row.** `historyFolds` folds a run by its run id ahead of `prefix k/n` names; the label is "<title> · plugin
     vN" (title from the project's copy, else the id), "<recipe> · draft" for a draft, and a one-step run keeps its
     single row under that name. `foldEndingAt` and `foldRedoFrom` read run ids too, so the app's Undo and Redo take
     the whole run, as the MCP's do.
   - **The form, read-only.** The row's pencil (folded runs show it, since the run is one step) or "Plugin values…"
     opens a card above the rows: description, author, made-by, then each declared parameter as a disabled control
     with its unit and "default" when the run was not given it; values the header does not declare (a draft) show by
     name. "View source" opens a read-only sheet with the file or the draft's source. UX decisions: a card above the
     rows rather than a second line per row, because rows are a fixed-height git graph; a sheet for the source, since
     a recipe is wider than the dock; the card says plainly that values change over MCP until milestone 6.
   - **D9 in the app.** The app reads only the project: an edited copy (its body hashed with Web Crypto against its key),
     a newer API (`RECIPE_API` in `src/plugin-step.ts`, tested equal to the crate's), no copy and no draft ("not in
     this project", since the app does not read the library yet), and macOS. The library cases wait for the Plugins
     panel (milestone 7). The sentence is the row's tip and description, with a warning mark, and the card's note.
   - **Kept on save.** `session.plugins` is the project's map as it opened, written back by the app's Save.
   - Tests: `src/model-history.test.ts` (a run folds under its title, without the file under its id, one row between
     its neighbours, one undo and redo, a one-step draft, the card's fields with defaults, and each D9 case),
     `src/plugin-step.test.ts` (copies hashed as the server does, an edit seen, the API level),
     `e2e/model-plugin-step.spec.ts` (in `test:smoke`: a project saved by the app with a stamped run written in opens
     as one row; undo and redo the run; the card's read-only values; View source and Esc; the menu; save keeps the
     map, the stamp and the run; an edited copy's sentence on the row and the card). Screenshots in
     `test-results/plugin-step/`.

5. **The shared host and the Tauri runner.** `src/recipe/host.ts` out of `mcp/recipe.ts` (no behaviour change for
   MCP); `src-tauri/src/recipe.rs` with build, start, send, kill, limits and the memory cap; finding the bundled lust
   from the app's resources.
   *Ships:* nothing visible; the app can build and run a recipe that only logs.
   *Tested by:* every `mcp/recipe*.test.ts` unchanged; Rust tests for the runner (timeout, memory cap, kill on drop,
   line limit) with a tiny recipe on Windows and Linux CI; a host test over a scripted transport in Node.

   **As built (milestone 5, branch `claude/plugin-runner`):**
   - **The host.** `src/recipe/host.ts` holds protocol v1 for both sides: the build loop with lust's `auto` fix rounds
     and the ingredients suffix (`buildRecipe` over a `RecipeCompile`), the run loop (`runRecipe` over a `RecipeSpawn`:
     start line, calls, replies, refusals, `done`, describe mode, notes, late parameters, the limits), diagnostics and
     byte-offset edits. It uses no Node: byte lengths and edits go through `TextEncoder`. `mcp/recipe.ts` keeps the
     slots, lust, the child process (`nodeSpawn`) and the workspace's files, and re-exports the host, so every
     `mcp/recipe*.test.ts` runs unchanged. A runner may end a run with its own reason (a memory cap); it becomes the
     run's reason.
   - **The runner is a crate.** The process side is `crates/lime-recipe-runner`, not code inside `src-tauri`: its tests
     then build and run on Windows CI in seconds (the MCP Windows job), where the Tauri crate is never compiled.
     `src-tauri/src/recipe.rs` is the thin Tauri layer over it: `recipe_available`, `recipe_build {slot, source}`,
     `recipe_start {run, exe, limits}`, `recipe_send`, `recipe_close_input`, `recipe_kill`, with `recipe-line` and
     `recipe-exit` events. It starts only a slot program under its own root, the app's slots and lust daemon live under
     `%TEMP%/lime-recipes-app` (apart from the MCP server's), one build runs at a time and stops at 30 s (D11.3), and
     every running recipe is killed when the window closes. lust is `LIME_LUST`, else `mcp/lust/bin/lust` in the app's
     resources, else PATH; the crate is `LIME_RECIPE_CRATE`, else `mcp/lime-recipe` in the resources.
   - **Limits in the runner.** Wall time, calls, lines (calls × 2 + 1000, room for notes and describe lines), line
     length, and the memory cap (1 GB, D11.2), with the host's own sentences. Memory is the peak private commit on
     Windows, read every 20 ms, with a job object as the backstop at twice the cap that also kills the recipe when its
     handle closes; on Linux the peak resident size (`VmHWM`). `setrlimit` was not used: an address-space cap would
     also count the allocator's reserved ranges.
   - **`src/recipe/tauri.ts`** (`AppRecipes`) is the app's transport: builds in four slots by name as the MCP keeps
     them, a run id the window picks, listeners set before the start, replies sent in order. Nothing in the window
     calls it yet (milestone 6).
   - Tests: `src/recipe/host.test.ts` (unit chain; a scripted recipe: a whole run, the allowlist, a panic, every limit,
     a runner's reason, cancel, halt, describe mode, fix rounds, ingredient edits never applied, diagnostics, byte
     edits), `src/recipe/tauri.test.ts` (unit chain; a scripted Tauri runner: commands, events of another run ignored,
     slots, no lust), `cargo test -p lime-recipe-runner` (a stand-in recipe binary for the empty environment, time,
     memory cap, kill on drop, line, line count and call limits; a real recipe that only logs, built by lust, in CI's
     Linux and Windows jobs with `LIME_RECIPE_REQUIRED=1`), and `src-tauri` tests for the slot-only start.

6. **The app answers recipe calls.** `src/recipe/app-calls.ts`; the face and edge finders and the remaining handlers
   moved into `src/modeling/` with MCP tests unchanged; Edit values and Rebuild on a plugin step in the app.
   *Ships:* a person changes a plugin part's values in the window and it rebuilds, as one undo step.
   *Tested by:* each sample plugin run through the app adapter and through the MCP session gives the same
   fingerprint (unit, stand-in engine, and OCCT in CI); a Playwright spec with a scripted transport (the browser
   build has no Tauri): edit a value, rebuild, undo returns the old value.

   **As built (milestone 6, branch `claude/plugin-app-calls`):**
   - **Shared handlers.** What decides a call's answer moved out of `mcp/session.ts` so the app and the session run the
     same code: `src/modeling/bake.ts` (`bakeOp`, the typed op made into the stored op, with resolveEdges, bakedFace,
     profilePlane and the loop, profile and section readers; a join, a split to print and a print transition come
     through hooks only the session gives), `src/modeling/model-calls.ts` (the solid as calls read it, paging, the
     model_describe, faces_find and edges_find replies, the probe verdict, the stored echo of a blend, the step guard,
     the applied reply, a solid's sections, the part's face context and typed plane, an edit's built and broken steps),
     and `src/modeling/selectors.ts` and `solid-geometry.ts` (moved from `mcp/`, which re-exports them). The replay of
     the steps after a run is `replayOps` and `replayedTree` in `src/recipe/rebuild.ts`, used by both. Every MCP test
     runs unchanged.
   - **`src/recipe/app-calls.ts`** answers on one part, on a branch in a copy of its tree: log, data (what the step's
     draft kept), model_describe, faces_find, edges_find, surface_at, section, model_probe, model_apply,
     model_apply_batch (one by one, or combined), with own-parts-only (O8). Refused with a sentence that points to
     `recipe_run {object, params}`: composite ops, split, join, partition, transition, model_check, measure,
     model_history, anchors other than `part`, and solid_new, model_place and object_place (a stamped branch run
     changes one part).
   - **`src/recipe/rebuild.ts`** (`rebuildPluginStep`) builds the code, runs it from the step before the run with the
     stamped values under the changed ones and today's bed and nozzle, stamps the new run (fresh run id, the values,
     the fingerprint), and replays the later steps in one engine edit. A failure shows the old step again and hands
     back what the engine must drop.
   - **The card** (`src/ui/model-history.ts`): fields are editable where the app runs plugins (the desktop app with
     lust; the browser says it needs the desktop app). Numbers and counts are checked against their range as they are
     typed ("Studs is 1 to 10."), a changed value says "changed", Reset puts the stamped values back, Enter or
     Rebuild runs (unchanged values rerun too, which is how drift shows). The readout says what was rebuilt and how many
     later steps; a failure is said in the card and the readout, and the part is as it was. The card follows the plugin
     to its new rows, and back on Undo, so Undo shows the old values and Redo the new. One Undo is the edit's
     (`editBack`), as a step edit's is.
   - **D9, asking.** An edited project copy is no longer only refused: Rebuild asks in the card ("Confirm" runs the
     changed code), the new stamp names that code's hash, and the project keeps it under that hash with its header's
     `source-sha256` rewritten, so the MCP reads it as intact.
   - **Not built here:** a part the plugin made (stamped on the root) still rebuilds over MCP, and the card says so;
     "Use vN" waits for the library read of milestone 7; a draft that imports library ingredients rebuilds over MCP;
     `exprs` (a value typed as a project expression) waits for the Plugins panel's form.
   - Tests: `mcp/plugin-app.test.ts` (real lust; the stand-in engine, real OCCT in CI's OCCT job): the same plugin
     rebuilt with the same new values through the MCP and through the app adapter gives the same stamp values, run
     fingerprint, stored ops of the whole shown path and final solid; unchanged values land on the stamp; a panic is
     taken back; a part the plugin made is refused. `e2e/model-plugin-rebuild.spec.ts` (in `test:smoke`; a scripted
     runner behind `__limeRecipeRunner`): range refusal and Reset, rebuild with the later step replayed, the new run
     as one row on a new branch, Undo back to the old values and Redo, a refused run said in the card, the save
     keeping both stamps, and an edited copy that asks then runs. `src/model-history.test.ts` for which steps can
     change. Screenshots in `test-results/plugin-rebuild/`.

   **As built (every plugin rebuilds in the app, branch `claude/plugin-app-all`):** the gap milestone 6 left is closed;
   the app answers every allowlisted recipe call the MCP does, through the same code.
   - **A run holds its own small plate.** `src/recipe/app-calls.ts` keeps the part a run was given (if any) and every
     part it makes (`RunPart`): solid_new makes a tree in the engine, model_place and object_place move a part the run
     made (`src/modeling/placing.ts`, which the session's model_place and object_place now run too), and each call goes
     to the part it names, own parts only (O8, as the session refuses it). `parts` hands the caller what the run left.
   - **Shared, not copied.** What the session did on its own moved to `src/modeling/` and the session calls it:
     `composite-apply.ts` (a composite's expansion and pieces, a piece that misses or only touches, the fold into one
     group, an array of loops cells), `part-reads.ts` (model_history, model_check, measure, the box an anchor's label
     names, a split's check and kept side), `bakeTransition` in `bake.ts`, and `inspect.ts` and `cells.ts` moved from
     `mcp/` (which re-exports them). `src/recipe/ingredients.ts` is the ingredient inliner with no file system; the MCP
     host reads the library into it, the app the copies a draft kept.
   - **Every kind of call.** Composite ops (pattern, mirror, pocket, boss, texture, ribs, text, arrays of shapes or of
     loops cells), a split (keep above, below, or both: the other half is a piece on the plate, as the split tool puts
     one), a join of a part the run made (it leaves the plate), a split to print (its pieces wait in their trees and
     come on the plate as a commit across the cut places them), a print transition (aimed from the part's turn on the
     plate's printer), model_check, measure, model_history, and anchors on any step's label. A step a run labels keeps
     the label as the session's does (the app set the step's name before, so an anchor on it missed).
   - **A part the plugin made** rebuilds in place (`rebuildPluginStep` with the stamp on the root): the plugin runs with
     no part, as it first did, and makes the part again as a new tree; the later steps are replayed on it; the plate
     object keeps its id, name and place (a run that placed it with model_place keeps that pose) and takes the new tree
     and mesh in one Prepare step. One Undo goes back to the old tree and its values, Redo forward (`swapBack` in
     `src/app/model.ts`, the way Undo takes back a new object). The made part takes its plate id back, so its replies
     name what they named.
   - **Drafts that import ingredients.** The card's Rebuild inlines the copies the draft's `rustRecipes` entry kept,
     exactly as the MCP host does on a rebuild (`preferKept`); the same text either way. A copy that is missing is one
     sentence. A kept plugin carries its own `mod ingredients` and builds as it stands.
   - **MCP change.** A run whose made tool was joined into the part (keepTool false) is now stamped: the tool left the
     plate, so the run made or changed one part (O4). Before, it counted the tool and kept plain steps. And
     `recipe_run {keep}` now checks the plugin (D3's dry run with its defaults) on its part as it stood before the run,
     not on the part the run had just changed: there, pegs fused again changed nothing, a split's default plane was
     already the part's edge, and the keep was refused on the real kernel (the stand-in engine did not show it).
   - **Refused in the window, one sentence each, because the window has no place for them yet:** a fit coupon
     (`solid_new {coupon}`, two parts with pins), an assembly (`model_place {to}` or `{assembly}`: the plate's assembly
     table), `model_check {interference}` (it reads every part on the plate), and the planners (`model_probe {plan}`).
     A rebuild that would now make more than the one part, or a second part beside the given one, is refused: a
     plugin step stands for one part (O4); the Plugins panel (milestone 7) runs such plugins as new runs.
   - **Deviations.** object_place in a run moves a made part's plate turn and spot for the run's own reads (model_check,
     a transition's aim), but a rebuilt part keeps its plate place; the probe's transition rows and a too-thick shell's
     advice are worded more briefly in the window than over MCP; the solids, stored ops and fingerprints are the same.
   - Tests: `mcp/plugin-app.test.ts`, one plugin per kind, each rebuilt with new values through the MCP and through the
     app on two engines built the same way: plain steps; a part the plugin makes (a new tree, the stamp on its root);
     a draft that imports a library ingredient (the app's inlined text equal to the host's); a pattern, an anchor on a
     labelled step, a made, placed and joined tab and a split; model_check, measure, model_history and a print
     transition; a split to print in a draft (the other piece a tree of its own). Each compares the stamp values, the run's fingerprint, the stored ops of the shown path, the final
     solid and the run's log lines. `src/recipe/ingredients.test.ts` (unit chain). `e2e/model-plugin-made.spec.ts` (in
     `test:smoke`): a part the plugin made rebuilds in History, one object stays on the plate, Undo back to the old
     tree and values, Redo, and the save keeps the new stamp on the root. Screenshots in `test-results/plugin-made/`.

7. **The Plugins panel.** (Designed after `plan-sketch-for-people.md` milestones 1 and 5, so it follows the sketch
   card's tips, demos and 1440 px layout; see that plan's section 7a.) D13: list, search, sections, form, Preview with Live, Apply, Save as plugin… from History,
   Use vN, Reveal in folder, Remove; the "Plugin author" setting; macOS read-only state (D15).
   *Ships:* the feature, for a person, end to end on Windows and Linux.
   *Tested by:* a Playwright spec on the panel (search, form ranges and units, apply lands one History row, preview
   rolls back), a macOS-state spec with lust absent, screenshots; a desktop check on Windows with the installed app.

   **As built (milestone 7, branch `claude/plugins-panel`):**
   - **Where.** A card in the Model dock (`src/ui/plugins-panel.ts`), opened from the Features menu's "Plugins…"
     (beside Parameters) or Ctrl+Alt+L, holding the pane as Split to print does; no rail button (sketch plan 7a).
     Apply and Cancel are the pane's own; Esc closes it.
   - **The library in the app.** `src-tauri/src/plugins.rs` lists, writes, removes and reveals files in the folder the
     MCP server writes (`LIME_PLUGINS_DIR`, else the app's data folder, the same identifier), touching only `<id>.rs`,
     `<id>.vN.rs` (five kept, as `writePlugin`), `presets/<id>.json` and `settings.json`, each written whole through a
     rename. Everything else is browser-safe TypeScript in `src/plugins/library.ts`: reading the files (every version by
     hash), presets, the author, the sections, search (`queryScore`'s rule), last used (kept in the browser), the form's
     checks, the save's version rule (`pluginSave`'s), Use vN's carried values, and the project's copies.
     `pluginFileText` writes the MCP's bytes (checked in `mcp/plugins-file.test.ts`).
   - **List.** "In this project" holds the project's plugins whose id the library lacks (D10's Add to library); a
     project copy of a library plugin, at any version, is listed once, in the library, since History's Use vN moves a
     step between versions. "Samples" waits for O6's samples, which ship later; the section is drawn when it has rows.
     Badges: "needs a part" and "edited" (a library file whose body no longer matches its hash). Not "imported", which is
     milestone 8's.
   - **Form.** D5's fields from the header's `params` (the History card's layout and classes), the range and unit after
     each, checked as typed with the reason in the card and on the greyed Apply; presets from `presets/<id>.json` fill
     it (a value that no longer fits is named and left at its default). Values the run is given are those that differ
     from the defaults, so the step's card marks the rest "default". Typed expressions of project parameters (D5's
     `exprs`) are not built yet.
   - **Preview and Apply** run the plugin fresh through the app's runner and the shared call answers (#551's
     `app-calls.ts`; `runPluginFresh` in `src/recipe/apply.ts`): on the open part from its shown step, or with no part
     for a plugin that builds its own (`target: new`, or `either` with nothing open). Preview shows the result in place
     of the part (the pane's preview, as a tool's dry run), then goes back to the shown step, drops the run's steps and
     closes the trees it opened: History and the plate keep what they had. A new part's Apply is a new plate object,
     stamped on its root, as one Prepare step. O4 holds for fresh runs too: a run that makes several parts, or changes
     the part and makes another, is refused with a sentence (since 2026-11-06 the window makes them all: see the As
     built note after milestone 10); so are the calls the window refuses (fit coupons,
     assemblies, interference, planners), with their own sentences. Live previews 300 ms after the last change while the last run took under 1 s.
     Apply keeps the run as one History row, stamped (D8) so its pencil changes it later, and the project keeps the
     plugin's file. D13's "dry run" is a real run taken back, as the MCP's dry mode is.
   - **History.** The env History reads gains the library: a stamp whose code only the library holds works as if the
     project carried it (and the next save writes the copy, D9 row 3); "v5 is in your library." with **Use v5** in the
     card and the row menu rebuilds the step with v5 (values carried by name, a dropped one named), as one undo step;
     the no-copy sentence becomes "not in this project or your library". **Save as plugin…** on a draft's row and card
     opens a dialog (title, description, author), then runs D3's checks in the app (a describe run, then a run with the
     defaults on the part as it stood before the draft's run, taken back), writes the file with the MCP's version rule,
     turns the draft's stamps into the plugin's, and the project keeps the file.
   - **Plugin author.** A field in the gear menu, kept as `settings.json` in the library; the MCP server reads it at
     each save (`pluginAuthor` in `mcp/plugins.ts`), and `LIME_PLUGIN_AUTHOR`, when set, still wins (tests, portable
     installs). A name typed in Save as plugin… becomes the setting when none is set.
   - **Tips, reasons, Show me.** Each button carries a purpose line and, greyed, its reason on a second line
     (`blockedTip`, as the sketch card); every reason ends with the next action (`src/ui/plugins-panel-text.ts`,
     checked by the unit test). The How (?) lists four steps under **Show me**, which opens a demo plugin (the recipes
     guide's drilled bar, its numbers typed) with a strip that says the next change; its Apply is greyed ("This is a
     demo, so nothing is added to your part.").
   - **macOS and no lust (D15).** The panel lists, searches and shows every form read-only with the runner's sentence
     and "Projects open, and parts built with plugins are kept as built."; Preview, Apply, Use vN and Save as plugin…
     are greyed with it; Reveal in folder, View source and Remove work. The browser build reads no library and says so.
   - UX decisions: a list and a plugin's page in one card (with "All plugins" back) rather than both at once, since
     the dock is about 270 px wide; Enter in a field applies, as in every Model panel, and Enter in the search opens
     the first match; Remove asks first; the Use vN note is drawn as news, not as a warning.
   - Tests: `src/plugins/library.test.ts` (unit chain), `src/model-history.test.ts` (the library's D9 cases),
     `mcp/plugins-file.test.ts` (same bytes, the author setting), `cargo test -p lime-slice-desktop --lib plugins::`,
     `e2e/model-plugins-panel.spec.ts` and `e2e/model-plugins-mac.spec.ts` (in `test:smoke`, with a library and a
     scripted runner in the page). Screenshots in `test-results/plugins-panel/`. The desktop check with the installed
     app is the owner's.

   **As built (plugins carry the recipe data they read, branch `claude/plugin-data`):** a data-driven plugin (R-A's
   `data {name}`) ran only over MCP in the workspace that had its files: the window answered `data` only from a draft's
   kept data, and the file did not carry what its run read. In 5.0.0 the owner's skull plate refused Preview, Live and
   Apply with "No recipe data named skull/outline is kept with this step. Rebuild it over MCP ...".
   - **Where (D6, O2).** Inside the one file, after the code and its `mod ingredients`: a fence line, then one plain
     `//` comment line per name, `// data: <name> sha256:<file hash> bytes:<file size> <value as one line of JSON>`
     (`src/recipe/plugin-data.ts`, shared by the app and the MCP). Rejected: a sidecar `<id>.data.json` the id owns in
     the library, which would make a plugin two files to send (O2), need its own `.vN` copies, and not fit the
     project's `plugins` map of one text per hash. The lines are in the body, so `source-sha256` covers them: other
     data is another version, and the project's copy, keyed by that hash, carries the data with it. The host builds the
     code above the fence only. A plugin that reads no data is written byte for byte as before.
   - **Limits.** At most 4 MB a name as kept JSON (the workspace read limit) and 12 MB together; the app's library
     listing (`src-tauri/src/plugins.rs`) now reads files up to 16 MB (was 1 MB). Over either, keeping is refused with
     one sentence naming the data.
   - **Lookup order**, every path: the step's kept data (rerun, rebuild) → the plugin's carried data → the workspace's
     file (MCP only) → what the replaced run kept → for new source under a library plugin's id, the data that plugin
     carries. In the window, `carriedEnv` adds the plugin's data for a kept plugin's run (version 1 and up) in
     `runPluginFresh` and `rebuildPluginStep`; a draft keeps its own refusal.
   - **Kept and attached.** `keep` and `save {from}` carry the run's data; `nugget save {kind: "plugin", id, data:
     [names]}` carries workspace files into an existing library plugin without a run (code unchanged, the next version).
     The window's Save as plugin… carries the draft's kept data. The window's refusal for a plugin without its data
     names it and the fix.
   - **Shown.** `nugget get` lists `recipeData: [{name, bytes}]` and returns the code alone with `withSource`; the
     panel's plugin page says "Carries the recipe data <name> (<size>)"; View source hides each value.
   - Tests: `src/recipe/plugin-data.test.ts` (unit chain), `mcp/plugins-file.test.ts` (round trip through the file, the
     library and the app's reader), `mcp/plugin.test.ts` (keep carries, library run and rebuild with the file deleted,
     an old plugin's refusal and attach, too large refused), `mcp/plugin-app.test.ts` (a data plugin's app rebuild and
     fresh run against the MCP's, stand-in engine locally, real OCCT in CI), `e2e/model-plugins-panel.spec.ts` (a data
     plugin's Preview and Apply, and the refusal of one kept without its data). The schema budget grows by 29 tokens
     for nugget's `data`.

8. **Import, export and trust.** D10 and D11.2 to D11.6: export, import (file, drop, MCP `save {source}`), name
   clash, first-run source view, `mod`/`#[path]`/`extern crate` refused, text caps, build time limit.
   *Ships:* plugins move between machines and people safely.
   *Tested by:* import fixtures (a clean plugin, one with `mod x;`, one with an over-long description carrying an
   instruction, one with a newer API); each answers with its sentence; Playwright for the first-run dialog.

   **As built (milestone 8, branch `claude/plugin-sharing`):**
   - **One file, and what is in it.** The shared file is the library's file (the code, the ingredients it carries
     inline, I11, and the recipe data after its code) with two more header lines, `//! presets: {...}` and
     `//! lessons: [...]`: its presets, and the lessons about its id or an ingredient it carries (lessons about op kinds
     stay home). D10 said "the same bytes as the library file"; the header is outside the hash, so the `source-sha256`
     is the library's, an import keeps the library file byte for byte, and presets and lessons still travel in one
     file. Named `<id>-v<N>.lime-plugin.rs`: `.rs` keeps it a valid `main.rs` (O2), `.lime-plugin` says what it is to a
     person, a file picker and a drop. A plain `<id>.rs` imports too. `src/plugins/share.ts` holds the format and every
     import check, browser-safe, and the MCP and the app both use it.
   - **Import checks nothing by running it first.** Header, text caps, API level, one file (D11.4), and one more: a
     hidden text-direction character ("Trojan source") is refused with its line. Text over a cap is refused, not cut
     (D11.5's caps, plus a value's label 60, help 280, unit 12, an option 60, and at most 64 values, 50 presets, 50
     lessons): a 900-character "description" is not one. Over MCP the import then runs D3's describe and dry runs with
     its build held to 30 s (D11.3; a person's own keep keeps 120 s, which a cold CI slot needs; the app's runner holds
     every build to 30 s since milestone 5). **Deviation:** the app's import runs nothing (D10 said describe and a dry
     run): D11.6 says nothing runs before a person has seen the code, so the header's `params` are used, as D15 does on
     macOS, and the first run the person approves is the check.
   - **Trust.** `imported.json` in the library marks a plugin imported (`{sha256, from, at}`), written by the MCP and
     the app; the app clears it when the person presses Run in the first-run view (its first Preview, Apply or History
     rebuild; Live never opens it). A project's plugin the library lacks is asked about the same way, once, approved by
     its hash in the browser's storage (it is not in the library to mark). MCP runs are not gated: the agent imported
     it, and the sandbox and own-parts-only hold for every run; `nugget get`/`find` say `imported: true`. The browser
     build reads no library, so it cannot tell another's plugin from one's own and asks nothing.
   - **Clash.** D10's keep-both is `<id>-2`, titled "(2)" so two rows never read the same; Replace (or **Update to vN**
     when the file is newer, D10's update offer) writes it above the library's version so the old one stays as
     `<id>.vN.rs`. Over MCP, keep both is the default and `replace: true` replaces. The safe choice leads in the view,
     except for an update.
   - **Projects.** The app says once after an open that the project carries plugins the library lacks, with Review
     (the panel's "In this project"); Add to library goes through the import view and marks it `from: "project"`.
     `project_open` names them (`pluginsNotInLibrary`) and `from: "project:<id>"` imports one; nothing is added by an
     open. A drop of a `.rs` file anywhere on the window imports (D10 said on the panel), since the panel lives in Model.
   - **Budget.** `export`, `from` naming a file or `project:<id>`, and `replace` add 31 tokens (17,183 of 17,190).
   - Tests: `src/plugins/share.test.ts` (unit chain: the four fixtures in `mcp/fixtures/plugin-import/`, the round trip,
     clash, merges, marks), `mcp/plugin-share.test.ts` (real lust: export, import into a second library with the same
     hash, the library file byte for byte and the same solid without the ingredient or the data file, preset, mark,
     same, keep both, replace, the fixtures over MCP with the instruction only in `data`, a project's copy),
     `e2e/model-plugins-share.spec.ts` (Export, Import… with the import view and the first-run view, Cancel runs
     nothing, clash, update, refusals, a drop, a project's offer). Screenshots in `test-results/plugins-share/`.

9. **Versions in CI.** The fixtures corpus with one plugin per API level, the lust-bump and crate-change CI check, the
   "needs a newer API" path, and the slot-per-major plumbing ready for a first major bump (tested with a fake `2.0`
   crate in the test only).
   *Ships:* old plugins keep building, or fail with one clear sentence.
   *Tested by:* the corpus job itself; a test that a plugin recording API 9.0 is refused without a build.

   **As built (milestone 9, branch `claude/plugin-versions-ci`):**
   - **The corpus.** `mcp/fixtures/plugins/` holds one real saved plugin per level, 1.0 to 1.4, each kept through the
     MCP's own save (`recipe_run {keep}`) and using what its level added: `param_*` (1.0), the typed values (1.1), a
     picked face, `bounds` and `refuse` (1.2), a `.curved()` face and what the pick says it is (1.3), and reads on a
     part `model_place` moved, which answer in model space (1.4). Beside each, `<name>.expected.json` says how it is run
     (`run`: the part, its pose, the values) and what it must produce: its calls byte for byte, the stored ops of the
     shown path, the solid's fingerprint, its metrics and its log lines. The levels shipped before this milestone were
     recorded now, on today's crate (D12 said "as when it was added"; nothing older was kept). A level with no plugin
     fails the check, so the next minor ships with its plugin. Never re-record an old level: its record is the contract.
   - **The engine is the stand-in.** The record is the same on Linux and Windows and needs no OCCT build, which keeps the
     check in the MCP jobs (about 15 s). The 1.3 and 1.4 plugins therefore use the parts of their level the stand-in
     answers (a curved face declaration, picked-face fields, model-space reads); lettering and text outlines need real
     fonts and stay in `mcp/plugin-text.test.ts` on OCCT.
   - **CI.** `mcp/plugin-corpus.test.ts` is a step in the Linux and Windows MCP jobs (which already build lust), run
     only when the "what changed" job's new `recipes` output is true: `tools/lust/` (a `LUST_REV` bump), the crates
     `lime-recipe*`, the corpus, the recipe host and plugin code (`mcp/recipe*`, `mcp/plugin*`, `mcp/session*`,
     `mcp/refusals.ts`), the op JSON the answers come from (`src/recipe/`, `src/modeling/`, `src/model-tree*`,
     `src/plugin-step*`), `tools/mcp/bundle.mjs` and the workflow. Not a required check, and no new job.
   - **Newer than this app.** One function, `apiVerdict` in `src/recipe/api-level.ts`, decides for the MCP, History and
     the Plugins panel before anything is built, with one sentence: "This plugin needs recipe API 9.0; this Lime Slice
     has 1.4. Update Lime Slice to run it. Its parts are kept as built." (D12's "from Lime Slice 5.x" is left out: an
     app cannot know which later release ships a level.) The code is `plugin-unsupported`, as milestone 1 answered a
     first run; a rebuild of a stamped part said `recipe-source` before and now says `plugin-unsupported` too. A major the
     app no longer ships is `plugin-api-retired` (new). History's note and the panel's greyed reason now use the MCP's
     sentence. Import keeps its own wording ("Update Lime Slice, then import it again.").
   - **Slots per major.** `recipeCrates` (`mcp/recipe.ts`) finds the current crate and, beside it, the last crate of
     each earlier major as `lime-recipe-<major>/` (D12 said `mcp/lime-recipe/1/`; the current crate already sits at
     `lime-recipe/` with its `src/` inside, so the older ones are siblings). In the repo they would be
     `crates/lime-recipe-<major>/` (a `lib.rs`, not a workspace member), and `tools/mcp/bundle.mjs` copies each one into
     the installer. `RecipeHost.build(..., major)` builds against that major's crate copy in that major's own four slots
     (`slot-<major>-<n>`; the current major keeps `slot-<n>`), and `recipe_run` passes the major a library plugin or a
     stamp records. `crateApi` is the host's current level. No 2.0 ships: the test makes a fake 2.0 crate (API (2, 0),
     `param_f64` removed, one new function) in a temp folder with the real crate beside it as `lime-recipe-1/`.
   - **Not built:** the app's Tauri runner still builds against one crate, so the app treats an older major as retired;
     when the first major ships, `recipe_build` takes D16's `crateMajor` and the window's slot naming follows the
     host's. A plugin imported or kept from an older major is still checked against the current crate.
   - Tests: `mcp/plugin-corpus.test.ts` (no lust: a plugin recording 9.0 refused with the sentence and code, nothing
     built; real lust: every corpus plugin's record, a stamped part whose plugin now records 9.0 refused on a rebuild
     without a build and kept as built, every level has a plugin, and the fake 2.0 crate: the 1.0 plugin builds in a
     1.x slot with its recorded calls and does not build against 2.0, a 2.0 source builds, 1.5 and 3.0 refused without
     a build, a retired 1.x), `src/recipe/api-level.test.ts` (unit chain), `src/model-history.test.ts` (the shared
     sentence, a newer minor, a retired major).

10. **API 1.2: faces and outlines a person picks** (D17).
   *Ships:* plugins take their input from the part (a clicked face, a sketch, a face's outline) instead of a frozen index
   or a data file, in the Plugins panel, History and over MCP.

   **As built (milestone 10, branch `claude/recipe-api-1-2`):**
   - **The crate:** `face`, `outline`, `pick_face`, `pick_outline`, `PickedFace`, `FACE_RULES`, `refuse`, `bounds`;
     `API = (1, 2)` and `RECIPE_API` with it. `refuse` writes a `refuse` line the host turns into the run's reason.
   - **The host:** `pick` joins the allowlist; `answerPick` in `src/recipe/picks.ts` answers it for `mcp/session.ts` and
     `src/recipe/app-calls.ts` from the same reads (`PickReads`: faces, section, a step's sketch, data), and hands back
     what each given value resolved to, which both write into the stamp in its place. The app reads another part's
     sketch or face (`AppRunEnv.otherPart`), the run's own parts first. `model_describe` answers `bounds`.
   - **Stamps** (`PluginStamp.params`, presets, `model-tree-file.ts`) take a JSON object as a value; `sameValues`
     compares them by JSON.
   - **The form** (`src/ui/pick-field.ts`, in the Plugins panel and the History card): the value in words ("face facing
     +Z", "largest up (default)", "sketch on step 4 of obj_2"), **Pick face** (or **Use a face's outline**), which arms a
     face pick in Model (Face mode, the hovered face lit as Face mode lights it, Esc cancels, a curved face asks again),
     **Pick a sketch** (a list of the extrude and revolve steps on the plate's parts), and **Use default**. A face with no
     default and no pick greys Apply with the reason. In History, Use default drops the pick from the rebuilt run.
   - **MCP:** `recipe_run {params}` takes the values above; the schema's `params` line points to the guide, so the tool
     list gains no tokens and the budget is unchanged. `plugin list` and `nugget find` show `face face [largest up]`.
   - **Not done:** `s.context()` does not carry "the face last clicked" (a person picks it in the form instead); a
     `face` outside the part a run was given or made stays refused to the recipe (O8).
   - Tests: `cargo test -p lime-recipe` (builders' JSON and values), `src/recipe/picks.test.ts` (unit chain: an index
     kept, rules, a moved face found, a gone face, outlines with holes, defaults that may not name a part, data kept as
     loops), `mcp/plugin-picks.test.ts` (real lust; stand-in engine, real OCCT in CI: a rule, an index kept, the face
     found after an earlier plugin step scaled the part, a gone face, `refuse`, outlines from the default, a sketch step,
     data and a face), `mcp/plugin-app.test.ts` (a picked face rebuilt through the MCP and the app: the same stamp, ops
     and solid), `e2e/model-plugin-picks.spec.ts` (in `test:smoke`: Pick face in the panel, Apply, Pick face in the
     card, Rebuild on the other face, Undo). Screenshots in `test-results/plugin-picks/`.

   **As built (a plugin run that makes several parts, and Plugins with nothing open, branch
   `claude/plugin-multi-part-app`):** the owner's 20-part puzzle box was refused by the window ("the window keeps one
   part per run for now"), and running a plugin that builds its own parts needed a throw-away part to open Model's
   Plugins panel. Both are gone.
   - **The run** (`runPluginFresh`, `src/recipe/apply.ts`) keeps every part it made, and the given part when it
     changed it, as `kept`: each tree stamped with the same values and run id and its own fingerprint. The part the run
     ended on (`done`) is the one shown. The only refusal left for size is a real limit, more than 100 parts
     (`MAX_RUN_PARTS`), which says to lower the count.
   - **The MCP stamps the same** (`mcp/session/recipe.ts`): a run over several parts stamps each, one run id, instead of
     O4's plain steps; its note says so. `recipe_run {object}` on one part of a set the session made reruns the entry and
     replaces every part in turn (the existing rerun), so the set changes together with a new shared run id. A set the
     entry does not hold (made in the window, or a run that also changed a given part), or one with steps after the run
     (which the rerun would drop), is refused with the way round.
   - **Preview** draws every part as one shape (`mergedSolid`, `src/plugin-parts.ts`): the given part as changed, each
     made part where Apply will put it (`madePoses`: the plugin's `model_place` pose, else beside the plate's parts and
     the parts laid before it, as a new solid is placed). Cancel takes them all back. The model view now draws a preview
     with no solid open, in model space, and the camera frames it.
   - **Apply** puts each made part on the plate as its own object, named as the plugin named it (`base`, `base 2` on a
     clash), in the order made, in one Prepare step: one Undo takes all of them back, Redo brings them again. Model opens
     the part the run ended on, with the plugin's History row. A run that also changed the given part keeps that as one
     History row on it, with its own Undo (two undo stacks: a part's steps and the plate's objects; joining them is a
     follow-up). Assemblies: the MCP does not group a plugin's parts into an assembly, so neither does the window.
   - **Changing the values later** of one part of a set is not built in the window yet: History's Rebuild (and Use vN)
     on such a part says so in one sentence before anything runs, "Parts box made this part in one run with lid and peg,
     and the window cannot yet change the values of a run of several parts, so nothing changed. Run Parts box again from
     Plugins with the new values, then remove the old parts." The standard, as the MCP has it: the run id is shared, the
     plugin runs again with no part, each new part replaces the old part in its place in order (keeping its id, name
     and place unless the run placed it), extra parts are added, missing ones removed, all one undo step. Follow-up.
     A single-part step whose new values would make more parts says it rebuilds only its own part and how to get all.
   - **Plugins with nothing open:** Model's empty card has **Run a plugin…**, and Ctrl+Alt+L opens the panel with an
     empty plate or a mesh open. Plugins that build their own parts list and run; one that changes a part is greyed with
     "Needs a part: open one in Model, then run it." (its form still opens). The list follows a part opening.
   - **Speed:** Live previews only while the last run took under 1 s and never while one runs, so a 20-part gear set
     previews on the button; a value typed during a run previews once it ends (unchanged).
   - Tests: `src/plugin-parts.test.ts` (poses, the merged shape, names, a run's other parts), `mcp/plugin-app.test.ts`
     (a three-part plugin through the MCP and the window: the same names, stored ops, stamps and fingerprints, one run
     id; the MCP rebuilds the set together), `e2e/model-plugin-parts.spec.ts` (in `test:smoke`: an empty plate, Run a
     plugin…, greyed plugins, Preview of three parts and of four, Cancel, Apply three objects, Undo and Redo, a value
     change on a set). Screenshots in `test-results/plugin-parts/`.

Milestones 1 and 2 are useful on their own and need no app change. 3 and 4 make plugin parts live through MCP and
readable in the app. 5 to 7 bring running into the app. 8 and 9 make sharing and the long term safe; 8 may move ahead
of 5 if sharing between agents' chats matters before the app runs plugins.

## 15. Done for the whole plan

- A recipe that worked in a chat is kept with one call, found by a later chat with one `plugin list`, and run by name.
- A part built by a plugin opens on any platform as built, and on Windows and Linux its values can be changed in the
  window or through MCP, rebuilding as one undo step.
- The Plugins panel lists, previews and applies plugins with a form drawn from their declared parameters.
- A plugin file moves between machines; an import is checked, shown before its first run, and limited to its own
  parts.
- Every plugin ever saved by a released version either builds and sends the same calls it did, or says in one sentence
  why not, and its parts stay.
