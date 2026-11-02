# Plan: recipes as plugins

Status: milestones 1 and 2 built (see their As built notes in section 14). Written 2026-11-01 against `main` at v4.8.0 (`723d1842`).
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
  parts; run it again from Plugins to change it." (Decided: O4, section 13.)

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

## 9. Library and discovery

### D13. A Plugins panel in the Model tab

- **Where:** a "Plugins" button in the Model toolbar (beside Parameters in the overflow while the toolbar is full),
  shortcut Ctrl+Alt+L, opening a dock panel the way Parameters does (`openDock`).
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
- **O4. Multi-part runs.** Plain parts with a note in v1.
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

4. **The app reads plugin steps.** History folds a run into one row with the plugin's name and version; the row shows
   the form read-only and View source; the D9 cases as row messages; the app keeps the `plugins` map on save.
   *Ships:* an MCP-built plugin part opens in the app as one readable row, and every no-rebuild case is explained.
   *Tested by:* `src/model-history.test.ts` for folding and each D9 case on fixture trees; a Playwright spec opening a
   fixture `.lime` with a plugin step (row, form read-only, source view), screenshots in the owner's theme.

5. **The shared host and the Tauri runner.** `src/recipe/host.ts` out of `mcp/recipe.ts` (no behaviour change for
   MCP); `src-tauri/src/recipe.rs` with build, start, send, kill, limits and the memory cap; finding the bundled lust
   from the app's resources.
   *Ships:* nothing visible; the app can build and run a recipe that only logs.
   *Tested by:* every `mcp/recipe*.test.ts` unchanged; Rust tests for the runner (timeout, memory cap, kill on drop,
   line limit) with a tiny recipe on Windows and Linux CI; a host test over a scripted transport in Node.

6. **The app answers recipe calls.** `src/recipe/app-calls.ts`; the face and edge finders and the remaining handlers
   moved into `src/modeling/` with MCP tests unchanged; Edit values and Rebuild on a plugin step in the app.
   *Ships:* a person changes a plugin part's values in the window and it rebuilds, as one undo step.
   *Tested by:* each sample plugin run through the app adapter and through the MCP session gives the same
   fingerprint (unit, stand-in engine, and OCCT in CI); a Playwright spec with a scripted transport (the browser
   build has no Tauri): edit a value, rebuild, undo returns the old value.

7. **The Plugins panel.** (Designed after `plan-sketch-for-people.md` milestones 1 and 5, so it follows the sketch
   card's tips, demos and 1440 px layout; see that plan's section 7a.) D13: list, search, sections, form, Preview with Live, Apply, Save as plugin… from History,
   Use vN, Reveal in folder, Remove; the "Plugin author" setting; macOS read-only state (D15).
   *Ships:* the feature, for a person, end to end on Windows and Linux.
   *Tested by:* a Playwright spec on the panel (search, form ranges and units, apply lands one History row, preview
   rolls back), a macOS-state spec with lust absent, screenshots; a desktop check on Windows with the installed app.

8. **Import, export and trust.** D10 and D11.2 to D11.6: export, import (file, drop, MCP `save {source}`), name
   clash, first-run source view, `mod`/`#[path]`/`extern crate` refused, text caps, build time limit.
   *Ships:* plugins move between machines and people safely.
   *Tested by:* import fixtures (a clean plugin, one with `mod x;`, one with an over-long description carrying an
   instruction, one with a newer API); each answers with its sentence; Playwright for the first-run dialog.

9. **Versions in CI.** The fixtures corpus with one plugin per API level, the lust-bump and crate-change CI check, the
   "needs a newer API" path, and the slot-per-major plumbing ready for a first major bump (tested with a fake `2.0`
   crate in the test only).
   *Ships:* old plugins keep building, or fail with one clear sentence.
   *Tested by:* the corpus job itself; a test that a plugin recording API 9.0 is refused without a build.

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
