# Clock parts in the window: shipped plugins, and a ratchet coupled from its parts

Status: built on `claude/clock-ratchet-parts` for 6.8.0. This file is the spec the code follows. It builds on
`docs/plan-recipe-plugins.md` (plugins, the panel, stamps, trust), `docs/plan-plugin-recipes.md` (API 1.16) and
`docs/plan-coupling-kinds.md` (the Ratchet kind and its click).

## 1. Why

`lime_recipe::horology` draws a ratchet and its click, a Graham escape wheel and anchor, cycloidal wheels and pinions,
and bores. Only a recipe could make them, so the Couplings form asked for the wheel's teeth, tip and root, numbers only
the recipe's author knows. The owner's standard: "the user should be able to rely on the fact that [it] is working. not
constant tweaking by an LLM". So a person with no agent and no script must be able to make the clock's special parts and
couple a ratchet without typing a number they cannot know. And from memory: every recipe can become a plugin, and a
plugin that makes its own parts runs with nothing open.

## 2. What existed for shipping things with the app

- **Lessons** ship as code: `SHIPPED_LESSONS` in `mcp/nuggets.ts`, numbered 0 and down, listed by `nugget find` with
  `shipped: true`, read by `get`, refused by `remove` ("ships with Lime Slice and stays"). The app's panel does not show
  them.
- **Plugins** had no shipped form. The panel had the demo plugin (`src/plugins/demo.ts`, "Samples", never applied), the
  project's copies and the library folder. MCP also reads **extra libraries** (`LIME_PLUGINS_EXTRA`, the beta's sibling),
  which are always treated as imported: shown before the first run, never run inside another plugin.
- **Trust** (`needsFirstRun`, `src/ui/plugin-import.ts`): a library plugin is trusted unless marked imported; a code whose
  hash the library holds (`bySha`) is trusted.
- **Versions**: a stamp names plugin, version and the body's hash; the project keeps a copy of every stamped code
  (`session.plugins`, MCP `pluginCopies`), so a part rebuilds with its own code; History's Use vN offers a newer library
  version (`newerInLibrary`), never by itself.

## 3. Decisions

### 3.1 Shipped plugins: files in code, read as the library's own

`src/plugins/clock-parts.ts` holds each plugin's recipe as text (`CLOCK_SOURCES`); `clock-parts.json` records each
body's hash and the parameters its describe run declares; `shippedText` writes the front matter as the library writes it
(`author: Lime Slice`, `api: 1.14`, `target: new`). One copy serves the window, the MCP server and the tests.

- **The app**: `readLibrary` adds every shipped plugin the folder has no file of (`addShipped`), as a `LibraryPlugin` with
  `shipped: true`, its code in `bySha`. So it is trusted like the library's own (no first-run view: it is the app's
  code), a project's step finds its code by hash, Use vN works across app updates, and presets work (they are files in
  the folder keyed by id). The panel lists them in their own section, **Built in**, with a "built in" badge; their menu
  has View source and Export only (no file to reveal, nothing to remove). The browser build, with no folder, lists the
  shipped plugins alone (`shippedLibrary`).
- **MCP**: `readPlugin` falls back to `readShipped` when the library has no file of that id, so `recipe_run {plugin}`,
  nested runs, rebuilds and project copies find them as library plugins; `plugin list` and `nugget find` list them with
  `shipped: true`; `plugin remove` refuses ("ships with Lime Slice and stays"). `writePlugin` never keeps the shipped
  text as an older version.
- **A library file of the same id wins** (a person who saved an edited copy keeps it).
- **Versions across updates**: only the current version ships. Changing a body changes its hash: record it again
  (`LIME_CLOCK_RECORD=1`) and raise its version. Parts made with the old code keep it in their project and rebuild with
  it; History offers Use vN for the new one.
- Rejected: writing the files into the person's folder on first start (a copy the person could edit and that drifts from
  the app; removal would bring it back each start); an extra library (those are treated as imported).

### 3.2 The plugins

All `target: new`, all with a bore from horology's tables: **Arbor pin, mm** (none, 1, 1.5, 2, 3: `STEEL_PINS`), **Fit
on the pin** (running H9/d9, sliding H7/h6, press H7/p6) and **Hole allowance** (0.2 mm), plus **Thickness** (3 mm). Each
refuses with horology's own sentence (and "A 2 mm pin's bore leaves no wall in the …: choose a smaller pin, or none." for
a bore too big for its hub). Each part is a box over its outline cut by an extrude `common`, then the bore; each stands in
model space with its own axis or pivot at its local origin, so Pose's Hinge (about +Z at [0, 0, 0]) is the right one.

| Plugin (id) | Parameters (defaults) | Stands |
|---|---|---|
| Ratchet wheel (`clock-ratchet-wheel`) | teeth 20, tip 12, root 10.2; pin 2 press | axis on the model origin |
| Ratchet click (`clock-ratchet-click`) | the wheel's teeth, tip, root (the same defaults); length 10; pin 1.5 running | at `Ratchet::click`'s pivot, turned by `seat_deg`: its nose in tooth 0's notch |
| Graham escape wheel (`clock-escape-wheel`) | teeth 30, tip 22.5, root 17.5, lean 12°, anchor span 7.5; pin 2 press | axis on the origin, turned to `rest_pose`'s wheel phase for that span |
| Graham anchor (`clock-graham-anchor`) | the wheel's numbers and span (the same defaults); pin 2 press | pivot at `pivot_distance` above the origin, turned to `rest_pose`'s anchor angle |
| Clock wheel and pinion (`clock-wheel-pinion`) | wheel teeth 60, leaves 8, module 1, leaf top standard (BS 978-2's choice); pin 2 press | wheel on the origin, pinion at the centre distance on +X at `mate_phase`: two parts in one run |

### 3.3 Pairs: why the click takes numbers, not a picked part

With nothing open, a plugin cannot read another part: a run gets its parameters and the parts it makes; a face pick needs
a part on screen; `model_place {to}` is refused in the app's runs (`canAssemble: false`). So the Click and the Anchor take
the wheel's numbers, with defaults equal to their wheel plugin's, and stand where they belong relative to a wheel on the
model origin, which is where the wheel plugins put it. Applying Ratchet wheel then Ratchet click with their defaults gives
a wheel and its seated click; change the teeth in one and type the same in the other. The clock wheel and its pinion
share every number, so they are one plugin that makes both parts. Not built: a "Ratchet and click" plugin making both
through `run_plugin` (its parts would carry the pair's stamp, not each plugin's, and the window cannot rebuild a run of
several parts).

### 3.4 The Couplings form and MCP read the numbers

`readRatchet` (`clock-parts.ts`) reads the newest Ratchet wheel run on the driver part (its stamp's values over the
defaults of the code that ran: the shipped text by hash, else the project's copy), else the Ratchet click's on the
click, which carries its wheel's numbers. A wheel and click whose stamps disagree are refused: "Click was made for a
ratchet of 24 teeth, …, and Ratchet wheel has 20 teeth, …: make the click again with the wheel's numbers."

- **Pose**: with Kind Ratchet, the clicks made by Ratchet click for this wheel come first, marked "(made for this wheel)",
  and the first is chosen unless the person chose one; "Runs free turning" is set from the wheel's hinge (horology's wheel
  runs free clockwise about its +Z: back on a hinge about +Z) with a line saying so; teeth, tip and root show as "Read from
  the parts: 20 teeth, tip 12 mm and root 10.2 mm, read from Ratchet wheel (Ratchet wheel v1)." with **Type them**, which
  opens the three fields filled with those numbers. A wheel made another way shows the fields as before.
- **MCP**: `model_place {couple: {kind: "ratchet", click}}` fills teeth, tip, root and free left out from the stamps, and
  the reply carries `read` (the same sentences, also at the end of `note`). Typed numbers win.
- **The click's hand** is read from where its body lies. A stamped click's body is known from its stamp (horology's
  outline in the click's own frame, `clickBodyCentre`), placed by the click's pose: the box of a part only tells the side
  once the kernel has cut it.
- Change to `mcp/session/place.ts` (another agent is moving it): in `coupleMember`, `given` became `let`, a `read` list,
  one block before the `DeclareSpec` that calls `ratchetFromStamps` and merges its numbers and click centre, and `read`
  in the reply and note. Nothing else.

### 3.5 Model's gear card: Ratchet left out

A Ratchet kind on the gear card beside spur, internal and rack would need the kernel's gear step (`ops::gear`, Rust in
`crates/lime-model-occt`) to cut saw teeth, an engine build and a new primitive in the file format. The plugins make the
same wheel with no kernel change, so it is left out; the gear card can list the clock parts later as shortcuts to their
plugins.

No `lime_recipe` change was needed (horology had everything): no new recipe API level.

## 4. Tests

- `mcp/clock-parts.test.ts` (unit chain): each shipped file reads as a plugin whose hash is its body's; with lust, each is
  built by lust and rustc, describes the parameters its header lists, sends the same calls bit for bit with its defaults
  and with other values (every part placed), and gives the same refusal sentences; the calls the browser spec replays are
  checked against `e2e/fixtures/clock-parts-calls.json`.
- `mcp/clock-couple.test.ts` (unit chain, fake engine, lust): listed with an empty library, found by `nugget find`, not
  removed; Ratchet wheel and Ratchet click run by id; on a frame with a hinge each, coupled with no numbers: the reply says
  they were read; half a tooth its free way lifts the click, a tooth drops it back in a notch, turned back it holds; a click
  made for 24 teeth is refused.
- `src/plugins/library.test.ts`: shipped plugins in every library read, trusted, by hash, Built in, overridden by a file.
- `e2e/model-clock-parts.spec.ts` (smoke): from an empty project, Built in lists the five; Ratchet wheel and Ratchet click
  applied with nothing open; attached to a frame in Prepare, a hinge each in Pose; the form shows the numbers read, the
  click chosen and the free way; Couple; -9° lifts the click, -18° reseats it, turning back is held.
- Real geometry: `node --experimental-strip-types e2e/gear-train-project.ts out.lime --ratchet --plugins [--real]
  [--coupled]` with `LIME_LUST` set builds the pair through the shipped plugins.
