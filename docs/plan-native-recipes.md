# Plan: native speed for recipes

Status: plan, for review. Written 2026-11-09 against `main` at v6.1.0 (`84953920`). Nothing here is built yet.
Companions: `docs/plan-recipes.md` (the protocol and rule zero: lust and rustc send the same bytes),
`docs/plan-recipe-plugins.md` (plugins, the sandbox, API levels, the fixtures corpus), and
`docs/plan-recipe-ingredients.md` (ingredients and standard ingredients in `lime-recipe`).

The owner's question, in short: code the app produced and keeps in the library (the involute gear ingredient, for
example) would make a good native primitive, and native code would not be slow the way lust code is. Should proven
library code be adopted into a release, or should the person's own machine compile it with the real Rust compiler
(with their consent) into something like a DLL the app loads without a new release? lust gives flexibility; how do we
also get speed?

## 1. Short answer

**lust is not where the time goes.** On the owner's gears-on-sphere recipe (9 gears, 27 calls, about 12 s), the
recipe's own maths takes 0.16 milliseconds. The protocol between the recipe and the app takes about 1.5 ms. Building
the recipe takes 0.05 to 0.09 s warm. About 92 % of the run is the modelling kernel doing 27 booleans one after the
other on a part that grows with each one, and re-meshing it after each.

**The same part in two calls instead of 27 takes 1.8 s instead of 11.7 s**, with the same solid (same volume to 13
digits, same 1,358 faces and 3,996 edges). That uses `s.apply_many`, which the crate already has. No new compiler,
toolchain or trust question is involved.

lust code itself is slower than optimised Rust: 5 times on trig-heavy code like the gear maths, 25 times on the 2D
geometry plugins use for lattices and webs. That matters for a minority of plugins (the spiderweb plugin spends about
3 s in its own geometry when the app's native help is off). The app already answers the heaviest of that work
natively: since #624, `geom2d` booleans and `lattice` cells run in the engine, compiled by rustc and shipped in the
release. That is option 1 of the owner's question, already working, and it cut the spiderweb plugin from 4.5 s to
2.5 s.

So the plan, in order:

1. Fix a byte-for-byte difference found while measuring (section 2.6): the native geometry answer passes through a
   JSON parser that can change the last digit of a number.
2. Make the kernel do less: show where kernel time goes in `profile`, let recipes queue applies so the host sends
   them as one boolean, and stop re-meshing a part after every step of a run.
3. Adopt proven library code in a release, by a written process: the gear ingredient becomes a standard ingredient in
   `lime-recipe` (for reuse and exact curves, not speed), more geometry gets a native fast path when the profile shows
   it is worth it, and a kernel `gear` step comes later if the owner wants one in the Model tab.
4. Ask lust-lang for an optimised sandboxed build (lust's C through an optimising C compiler, in the background,
   cached by hash). That is the "other side of the win" without leaving lust or its sandbox.
5. Not now: compiling plugins with rustc on the person's machine into a library the engine loads, and WebAssembly.
   Section 3 says why and what would change the answer.

## 2. Where the time goes

### 2.1 Method

- Machine: the owner's Windows 11 PC (the one the owner's numbers came from), release engine `lime_mcp_engine.dll`
  and OCCT bridge built from `main` at 6.1.0 (copied to a scratch folder), OCCT 7.9.2, lust at the pinned
  `94c8995e` (`C:\Users\marius\.lime-slice\lust-94c8995e`), Node 24, rustc 1.98.1.
- A throw-away harness drove a real MCP `Session` (the same object the server uses) with the real engine and real
  lust: make a sphere of radius 60 with `solid_new`, then `recipe_run {source, object, profile: true}`. It wrapped the
  engine's `modelTree` to time each kernel request and its reply size. Recipes and the library were copies of the
  owner's (`%APPDATA%\com.limeslice.slicer\plugins`, `lime-workspace-beta\gears-on-sphere.rs`), read only.
- Each row is two to three runs; other work on the machine moved times by up to 30 %, so ranges are given.
- Pure computation was compared by building one file (the bench, `lime-recipe` inlined as a module, the involute
  ingredient inlined) with `lust build --sandbox`, `rustc` (debug) and `rustc -O`, and running each three times.

### 2.2 gears-on-sphere, as written (27 applies)

| Where | Time | Share of the run |
|---|---:|---:|
| Build, cold (fresh slot, daemon starting) | 0.8 to 2.1 s | before the run |
| Build, warm, unchanged source | 45 to 55 ms | before the run |
| Build, warm, after an edit | 75 to 86 ms | before the run |
| **Run** | **11.4 to 13.2 s** | 100 % |
| Kernel: building each boolean (the probe; the apply reuses it) | about 9.4 s | 78 % |
| Kernel: re-meshing the part and writing the reply after each step (0.7 to 1.5 MB each) | about 2.6 s | 21 % |
| The server's own work per call (checks, reading the reply) | about 0.25 s (about 10 ms a call) | 2 % |
| Outside the calls: starting the program, the commit at the end, the recipe's code | 0.37 to 0.95 s | 3 to 7 % |
| of which the recipe's maths (9 gear outlines) | 0.16 ms | 0.001 % |
| of which the protocol (27 round trips at about 55 µs) | about 1.5 ms | 0.01 % |

The cost of a step grows with the part. Fusing a small hub cylinder takes 62 ms on the plain sphere and 633 ms on the
sphere with eight gears; extruding a gear takes 113 ms first and 867 ms last. Each step re-checks, measures and
re-meshes the whole part, so n steps on one part cost about n² / 2 times one step. The re-mesh is expensive after a
gear (150 to 390 ms) and cheap after a hub (10 to 20 ms): a gear trims the big sphere face, which is meshed again,
holes and all.

An empty recipe (no calls) runs in 0.30 s warm and 0.76 s the first time; 1,900 `log` calls add 0.1 s. Starting a
newly built program is the fixed cost, and it is larger the first time (Windows checks a new executable).

### 2.3 The same part in two calls

`gears-batched.rs` builds the same 27 tools and sends them as two `s.apply_many` calls: every gear and hub in one
fuse, every bore in one cut.

| | Calls | Kernel and calls | Run | Solid |
|---|---:|---:|---:|---|
| As written | 27 | 10.8 to 12.3 s | 11.4 to 13.2 s | 919,718.52394057 mm³, 1,358 faces, 3,996 edges |
| Two combined booleans | 2 | 1.7 to 1.8 s | 2.1 to 2.3 s | 919,718.52394057 mm³, 1,358 faces, 3,996 edges |

That is 6.5 times faster on the kernel, with the same part. `docs/mcp-server.md` already reports the same effect for
the honeycomb tray (115 cells: 38 to 40 s one by one, 3.0 s as one extrude of loops, 2.7 s combined).

### 2.4 What the kernel pays for: faces, and curves

Same batched recipe, with the number of points per gear flank changed, and one variant whose flanks are true curves
(a spline through 6 involute points per flank, an arc across each tip and each root, which `extrude.loops` already
takes):

| Gear outline | Faces of the result | Kernel time | Volume |
|---|---:|---:|---:|
| Polyline, 2 points a flank | 1,030 | 1.26 s | 919,513.5 mm³ |
| Polyline, 3 points a flank (the ingredient's default) | 1,358 | 1.73 s | 919,718.5 mm³ |
| Polyline, 8 points a flank | 2,998 | 4.36 s | 919,785.8 mm³ |
| Spline flanks, arcs at tip and root | 1,030 | 3.1 to 4.0 s | 919,801.5 mm³ |

Kernel time follows the face count, and a curved face costs about two and a half to three times a flat one. A native
gear made of true involute curves would cost about what the spline row costs: better teeth (the 3-point polyline cuts
inside the involute, 83 mm³ less over the nine gears than the spline), not a faster build.

### 2.5 Other plugins in the owner's library

| Plugin (defaults) | Calls | Run | In kernel calls | Outside the calls |
|---|---:|---:|---:|---:|
| Steampunk puzzle box (20 parts, 198 applies) | 238 | 22.2 to 23.3 s | 21.2 to 21.6 s (95 %) | 1.0 to 1.6 s |
| Moon crater field (10 craters on the sphere) | 166 | 1.5 to 2.0 s | 0.7 to 1.1 s | 0.8 s |
| Spiderweb cut on a part (100 × 80 × 10 plate), native geometry on | 129 | 2.5 to 3.0 s | 1.2 to 1.7 s (one combined cut) + 0.16 to 0.23 s native geometry | 1.1 s |
| The same, native geometry off (all geometry in lust) | 129 | 4.5 to 4.7 s | 1.5 to 1.6 s | 2.9 to 3.1 s |

The spiderweb plugin is the one where lust's own speed shows: about 2 s of its 2D geometry moved to the engine's
native code, and about 0.7 s of lust work remains (offsets and small booleans under the native threshold). Each
native geometry call costs 1.3 to 1.8 ms round trip through the engine.

### 2.6 Found while measuring: native geometry changes the last digit

With native geometry on, the spiderweb plugin sends a cut whose loop coordinates differ from the all-lust run in the
last digit (for example `11.005321081608713` against `…711`; 72,067 against 71,998 bytes; the final volume differs at
the 13th digit). Answering the same requests with a rustc-built `lime_recipe::native_geometry_request` fed the request
text directly gives the all-lust bytes exactly. The engine path differs in one step: `lime-model-load`'s `tree`
parses the request with `serde_json` and writes `args` back out before the crate reads it. Most likely `serde_json`,
which without its `float_roundtrip` feature may read a decimal number one unit off in the last place, is the cause. The bench of section 2.7 also
gives the same bits under lust and rustc, so the algorithm is not the cause.

Why it matters: a plugin's calls should be the same bytes on every host (rule zero, the fixtures corpus, a part's
fingerprint on rebuild). Today the bytes depend on whether the host offers native geometry and on input size. The fix
is small (pass the `args` text through untouched, or turn on `float_roundtrip`) and is milestone 1.

### 2.7 lust against rustc on the same code

| Same source | lust (tcc) | rustc debug | rustc -O | lust ÷ rustc -O |
|---|---:|---:|---:|---:|
| 9 gear outlines (trig, small vectors) | 161 µs | 59 µs | 34 µs | 4.8× |
| geom2d: 80 hex cells clipped to a disc, unioned, cut from it, inset (allocations, loops) | 335 ms | 147 ms | 13.5 ms | 25× |
| Compile the 4,250-line bench (crate inlined) | 0.55 s cold | 0.73 s | 3.07 s | |
| Compile one recipe against a prebuilt `lime_recipe` rlib (2.7 s once) | | 0.32 s | 0.47 s exe, 0.40 s cdylib | |

All three give the same bits for both outputs. lust's own README says the same thing at a larger scale: its programs
run 4 to 5 times slower than a rustc debug build and about 70 times slower than a release build, because tcc does not
optimise and daemon builds call through a function table. Sizes for comparison: the lust that installers ship is about
31 MB (lust, lust-core, tcc, its library). A Rust toolchain is several hundred MB (the 1.88 toolchain on this machine
is 593 MB), and on Windows rustc also needs a linker: Microsoft's (Visual Studio Build Tools, gigabytes, its own
licence) or the GNU target's bundled one.

### 2.8 What this means

- For the recipes the owner actually runs, the kernel is 90 to 95 % of the time. A faster compiler for the recipe,
  local or not, would change gears-on-sphere by under a millisecond and the puzzle box by well under a second.
- The biggest wins are in how a recipe talks to the kernel (one boolean for many tools) and in what the kernel does
  after each step (re-meshing the whole part, measuring it).
- lust's codegen matters only for recipes with heavy 2D or numeric work in their own code. The native geometry path
  already covers the heaviest part of that, and adding a function to it is a release, with no new trust question.

## 3. Options

Each is judged on speed (from the numbers above), safety and trust, platforms (Windows x64, Linux x64, macOS arm64 and
Intel), what ships, the update story, API and ABI stability, reproducibility, what the person must accept, the CI
burden, and the plugin corpus guarantee: every saved plugin keeps building and sending the same calls, or says in one
sentence why not.

### 3.1 Make the kernel do less (no new compiler)

**a. Queued applies.** A recipe that does not need each apply's answer before the next one queues them, and the host
sends each run of queued ops as one combined boolean. Today that is `s.apply_many(&part, "fuse", ops)`, which needs
the recipe to sort fuses from cuts itself, and gives up per-op answers. Proposed for the next API minor:

```rust
s.apply_later(&part, op);   // queued; nothing is sent
s.flush(&part)?;            // sends the queue: Combined {applied, failures}
```

A queue is also flushed by any other call on that part (a read, a probe, a place) and by `done`, so a recipe can never
read a stale part. The host plans the flush: consecutive ops of one kind go in one combined boolean; a cut followed by
a fuse may be swapped only when their tools' boxes do not overlap (then they commute), so gears-on-sphere's
fuse, fuse, cut per gear becomes one fuse and one cut. A refused op comes back in `failures` with its recipe line, as
`apply_many` does today. The run stays one History step, as every recipe run is.

- Speed: 6.5 times on gears-on-sphere; the honeycomb numbers suggest 13 to 15 times for cell-by-cell recipes.
- Trust, platforms, toolchain: none; everything stays in the sandboxed program and the shipped engine. Works on every
  platform that runs recipes, and in the app as well as through MCP.
- Corpus: an addition (a new API minor with its own corpus plugin). Old plugins send what they sent.
- Cost: the crate's queue (small), the host's flush planner (the box test), the guide and profile hints.

**b. A hint in the profile.** When a run makes more than about eight applies on one part with no read between them,
`recipe_run`'s reply says so with the numbers: "27 applies on obj_1 took 11.7 s; queued (s.apply_later) they would
be about two booleans." Agents learn from replies; this costs nothing at run time.

**c. Mesh once, at the end.** Inside a recipe run, the kernel's reply after each step carries a fresh mesh of the
whole part (0.7 to 1.5 MB here), and meshing a trimmed sphere face again cost 150 to 390 ms a gear. A run needs the
mesh only when a read asks for it (`surface_at`, a section, a check) and at `done`. The session would mark the mesh
out of date and ask for it lazily. Measured ceiling: 21 % of gears-on-sphere. Same part, nothing for the person to
accept.

**d. Show the kernel's own split.** `kernel.cpp` already counts microseconds in booleans, volume integration and
meshing (`Stats`), but the bridge does not export them. Exporting them and adding them to `profile: true` would say
how much of the 9.4 s of "probe" time is the boolean itself and how much is measuring and checking the whole part
after it, which decides the next kernel change (for example, measuring only the faces a step touched).

### 3.2 Adopt in a release

This is the owner's first option, and part of it already exists.

**a. Standard ingredients (source in `lime-recipe`).** A library ingredient that proved itself moves into the crate
as a module, as `geom2d` and `lattice` did from the honeycomb evidence. For gears: `lime_recipe::gears` with
`outline` (polyline, today's numbers), `outline_loops` (spline flanks and arcs, section 2.4), `pitch_radius`,
`mate_phase`, `mate_turn`, `idler_centre`, `rack_outline`, with tests against rustc and the kernel.

- Speed: none on its own. The crate is source; lust compiles it with the recipe. The gear maths costs 18 µs a gear in
  lust, so there is nothing to win.
- What it gives: one tested copy, documented in `guide {kind: "ingredients"}`, found without `nugget find`, better
  curves offered as a choice, and a stable API level.
- Corpus: an API minor addition. A plugin that used the library ingredient carries its own inline copy (a kept plugin
  has its `mod ingredients`), so it keeps sending what it sent.

**b. Native fast paths for heavy crate functions.** The pattern #624 built: the crate function is also compiled by
rustc into the engine; when the host says it can (`context.nativeGeometry`), the lust-built recipe sends one
`native_geometry` call with the inputs and gets the answer, and otherwise runs its own copy. Today it covers `geom2d`
booleans above 40 points and `lattice` cells.

- Speed: the rustc -O speed for that function (25 times on geom2d), less the round trip (1.3 to 1.8 ms a call). So a
  function is worth moving only when one call costs more than a few milliseconds in lust. Offsets, rounded corners and
  the spiderweb's free-spot search are the next candidates by the profile; the gear outline is not one.
- Trust: none new. It is release code.
- Identity: the native answer must be the same bytes as the lust answer. Today it is not, by one JSON parsing step
  (section 2.6). The test that guards it (`mcp/recipe-geom2d.test.ts`) runs its own rustc helper, not the engine's
  path, which is why it did not catch it.
- Platforms: every platform that runs recipes.

**c. A kernel `gear` step.** A new op in the OCCT bridge: `gear {teeth, module, pressureDeg, backlash, width,
profileShift}` built from true involute B-spline flanks with arcs at root and tip, as a Model tab card and an MCP op.

- Speed: about the spline row of section 2.4, so no faster than today's coarse polyline; quality is the reason (exact
  flanks, the same gear in the GUI and in recipes, one op an agent cannot get wrong).
- Trust, toolchain: none new. Op JSON is additive; the corpus is untouched.
- Cost: a kernel op, a card, refusals, history replay, a guide entry. This is a product decision more than a speed one.

**Update story.** Every adoption waits for a release, and that is also its strength: it is reviewed, tested in CI on
every platform, signed with the installer, and covered by the corpus. The library version keeps working the whole
time.

### 3.3 Compile with rustc on the person's machine

The owner's second option: after the person agrees, build a plugin with the real Rust compiler and use the optimised
result without a new release.

What it would take:

- **The toolchain.** rustc is not something the installer can carry (hundreds of MB per platform, plus a linker on
  Windows). The person would install Rust with rustup and, on Windows, a linker. The app would find it, check its
  version, and build the `lime_recipe` crate once per API level and toolchain (2.7 s), then each plugin in about 0.5 s
  (section 2.7), cached by the plugin's hash, the toolchain version and the API level.
- **Loaded as a DLL into the engine:** the plugin's code would run inside the engine with the person's full rights. A
  shared plugin becomes ordinary native code: it can read files, use the network, start programs. The sandbox the
  plugin plan promises ("It cannot read files, use the network or start programs") would be false for it. A panic,
  an overflow or a bad pointer in safe-looking code that leans on a bug takes the engine down with the person's open
  work. The protocol is lines of JSON over a pipe; an in-process plugin needs a new C ABI for every call, versioned
  against API levels, with no unloading story on Windows while a call is in flight. This is the most work for the
  least safety.
- **Built by rustc but kept as a separate program:** this already works. Rule zero means a recipe builds and runs the
  same under rustc, and CI does it (`mcp/recipe-geom2d.test.ts`, `scripts/test-recipes.sh` in lust-lang). It keeps
  crash isolation. It loses lust's sandbox: lust refuses file and network use when checking (that part could still run
  first) and also stops the built program before any other OS call; a rustc build has no such stop. The app would need
  an operating-system sandbox per platform (an AppContainer or restricted token on Windows, seccomp or Landlock on
  Linux, the macOS sandbox) to make the promise again. That is a project per platform.
- **Speed won:** only the recipe's own code: 5 to 25 times on the 3 to 25 % of the run outside the kernel. Zero for
  gears-on-sphere, under a second for the puzzle box, about 0.6 s for the spiderweb plugin once native geometry is on.
- **Reproducibility and corpus:** a rustc upgrade on the person's machine could change bytes the corpus never saw
  (libm differences are real: the crate does its own trig for this reason). The CI corpus checks the pinned lust, not
  whatever rustc a person has.
- **What the person must accept:** installing a compiler and a linker, and, for a plugin from someone else, running
  native code with their own rights.

Verdict: not now. If it ever comes, only for plugins the person wrote or kept themselves, never for imported ones, as a
separate program, after an OS sandbox exists, and only if profiles show plugins whose own code dominates.

### 3.4 WebAssembly

Compile the plugin to WebAssembly and run it in an embedded runtime (wasmtime or wasmer, with Cranelift) inside the
engine. This keeps a real sandbox (the module can do only what the host imports give it) and, by published
benchmarks, runs compute within about two times of native code.

- The compile still needs rustc and its wasm target on the person's machine (section 3.3's toolchain problem), unless
  lust gains a wasm backend. lust has none (its backends are C for tcc, and C for clang, zig cc or LLVM in release
  builds); a wasm backend is a large lust-lang project.
- The runtime adds roughly 10 to 20 MB to the engine on every platform, and a second way to run plugins to test.
- A built module could travel with the plugin (built once by its author, checked by hash), so the person needs no
  toolchain; but then a person runs a binary they cannot read, and the source and the module can disagree. The corpus
  would have to check both.
- Speed won: the same as 3.3, the recipe's own code only.

Verdict: the best of the "compile it" options for safety, and the most new machinery. Revisit only if 3.5 fails and
compute-bound plugins turn out to be common.

### 3.5 Make lust itself faster (the other side of the win, inside lust)

lust already turns Rust into C (`--emit-c`) and has a release driver that compiles C with an optimising compiler (zig
cc or clang, and an LLVM path), but `--release` refuses `--sandbox` today (checked: the pinned lust prints its usage).
The sandbox's runtime stop is written into the generated C by lust's code generator, so an optimised build of the
same sandboxed C keeps it.

A request to lust-lang, then an experiment here:

- **A sandboxed optimised build.** `lust build --sandbox --opt` emits the same sandboxed C and compiles it with a
  bundled optimising C compiler.
- **Tiered.** The app runs the tcc build at once (today's speed, about 0.05 to 0.09 s warm), starts the optimised build
  in the background, and uses it for later runs of the same source, cached by the source hash, the lust revision and
  the crate's API level. Live preview keeps the fast build; a rebuild of a plugin step, a rerun of a saved plugin, and
  everything after the first run get the optimised one.
- **Identity.** lust's rule zero and its rustc oracle already require the optimised build to print the same bytes;
  the plugin corpus runs both builds.
- **Cost.** A C compiler in each installer (zig, for example, is a 45 to 80 MB download per platform; it could be
  trimmed to the one target), and lust-lang work. macOS Intel still has no lust.
- **Speed won:** close to rustc -O on the recipe's own code, the same share as 3.3 and 3.4, with the sandbox and the
  update story unchanged.

A Cranelift backend in lust (lust's own plan has a backend bake-off) would also do it, with a smaller compiler to ship,
and is lust-lang's call.

### 3.6 Run the recipe inside the engine

Removing the process boundary would save the protocol (55 µs a call) and starting the program (about 0.3 s a run).
The server's own work per call (about 10 ms) stays unless the host moves to Rust, which the plugin plan rejected for
good reasons (one copy of the call handlers). It needs 3.3's ABI and loses its crash isolation. Not worth it.

### 3.7 Side by side

| Option | gears-on-sphere | Spiderweb | Puzzle box | New trust | Ships | Platforms | Corpus |
|---|---|---|---|---|---|---|---|
| Queued applies (3.1a) | 12 s to about 2 s | already one cut | to measure (198 applies over 20 parts) | none | crate + host | all with lust | additive minor |
| Mesh at the end (3.1c) | up to −21 % | small | likely 10 to 20 % | none | engine + session | all | unchanged |
| Standard ingredient (3.2a) | none | none | none | none | crate | all with lust | additive minor |
| More native fast paths (3.2b) | none | up to −0.6 s | small | none | crate + engine | all | needs the byte fix |
| Kernel gear step (3.2c) | none (better teeth) | none | none | none | engine + card | all | additive op |
| rustc on the machine (3.3) | under 1 ms | about −0.6 s | under 1 s | native code with full rights | the person installs Rust | per OS sandbox needed | not covered |
| WebAssembly (3.4) | under 1 ms | about −0.6 s | under 1 s | none (sandboxed) | runtime in engine; rustc on the machine | all, macOS Intel too | two artefacts |
| Optimised lust build (3.5) | under 1 ms | about −0.6 s | under 1 s | none | a C compiler | all with lust | same bytes, checked |

## 4. Recommendation

1. **Fix the native geometry bytes** (milestone 1). A small change with a test through the engine's own path.
2. **Measure in the open** (milestone 2): the kernel's split in `profile`, and a committed bench of three real plugins
   (gears-on-sphere, the puzzle box, the spiderweb plugin) so every later step reports before and after.
3. **Queued applies and the profile hint** (milestone 3). The largest win, no new trust, all platforms.
4. **Mesh once, at the end of a run** (milestone 4).
5. **Gears as a standard ingredient** (milestone 5), adopted by the process in section 5, with the spline outline as a
   choice.
6. **More native fast paths, picked by data** (milestone 6).
7. **lust: optimised sandboxed builds** (milestone 7), as an experiment with lust-lang; adopt if it gives at least
   five times on the corpus's compute-heavy plugins with the same bytes.
8. **A kernel gear step and its Model card** (milestone 8), if the owner wants gears as a first-class feature.

Not recommended now: rustc on the person's machine (3.3), WebAssembly (3.4), in-process recipes (3.6).

## 5. How library code gets adopted

1. **Candidates.** Once per release, list the library's ingredients and plugins by use (the `// ingredient: <id> vN`
   stamps in kept plugins and projects, `nugget find` hits) and by cost (`profile: true` on the bench plugins: time
   outside calls per recipe line). An ingredient used by three or more plugins, or a function costing over 5 ms a call
   in lust, is a candidate.
2. **Which form.** Cheap pure maths becomes a standard ingredient (source in the crate). Heavy pure geometry also gets a
   native fast path. Something people would want as a button becomes a kernel step, and the crate gets a builder for it.
3. **Same behaviour.** The adopted function keeps the library function's name and arguments, and a test runs the
   library copy and the crate copy on the same inputs and compares the bytes. Where the crate wants better maths (the
   crate's own trig, spline flanks), that is a new function name, never a silent change; the old name keeps the old
   numbers.
4. **Old plugins.** Nothing changes for them: a kept plugin carries its ingredient inline and builds as it did. The
   library ingredient gets a new version whose body is `pub use lime_recipe::gears::*;` plus whatever the crate does
   not have, so new recipes that import it get the crate's copy. `nugget find` lists the standard ingredient first and
   the library one as "now in lime-recipe".
5. **Level and corpus.** The crate's API minor goes up, and the release adds that level's corpus plugin, which uses
   the new module (the corpus already refuses a level without one).
6. **Native fast paths.** A function gets one only with a profile showing the saving, a byte test through the
   engine's own request path (not a helper), and a size threshold below which the recipe runs its own copy.

## 6. Risks

| Risk | Effect | What limits it |
|---|---|---|
| Queued ops reordered wrongly | a cut lands before a fuse it should follow | swap only when tool boxes do not overlap; a test with overlapping fuse and cut keeps order; the corpus |
| A queued op refused | the recipe learns late | `flush` and `done` return `failures` with recipe lines; a recipe that needs each answer keeps `s.apply` |
| Lazy meshing serves an old mesh to a read | wrong `surface_at` or section | any read flushes the queue and meshes first; the bench and plugin tests compare reads before and after |
| Native fast path drifts from the lust copy | different bytes on different hosts | the byte test through the engine's path, per function; milestone 1 fixes the known case |
| A standard ingredient changes a plugin's part | a rebuild differs | plugins keep inline copies; new behaviour gets a new name |
| Optimised lust builds disagree with tcc builds | a plugin builds a different part after its first run | lust's rule zero and oracle, the corpus run under both builds, fall back to the tcc build on any mismatch |
| Bigger installers (a C compiler) | download size | only if milestone 7 proves the speed; trimmed to one target |
| macOS Intel still has no lust | none of this reaches it until lust does | projects open as built, as today; option 3.4 is the only one that would reach it without lust |
| Measurement noise on a busy machine | wrong conclusions | the committed bench runs each case three times and reports ranges; compare back to back |

## 7. Decisions for the owner

Each has the plan's choice; the plan goes ahead on it unless the owner says otherwise.

1. **Queued applies.** (a) A new `s.apply_later` with `flush`, plus the profile hint; (b) the host quietly queues
   every `s.apply` whose answer the recipe ignores (it cannot know that for sure); (c) only the hint, recipes use
   `apply_many` by hand. **Plan: (a).** It is explicit, safe, and old recipes are untouched.
2. **Mesh at the end of a run.** (a) Always inside recipe runs; (b) only when the recipe asks. **Plan: (a).** Nothing
   visible changes except speed: previews and the plate show the finished part.
3. **Gears.** (a) A standard ingredient in the crate now (polyline and spline outlines); (b) also a kernel gear step
   and a Model tab card now; (c) leave gears in the library. **Plan: (a) now, (b) later** if the owner wants gears as
   a feature people click.
4. **Compiling on the person's machine with rustc.** (a) Not now; (b) opt-in for the person's own plugins, as a
   separate program, after an OS sandbox; (c) as a DLL in the engine. **Plan: (a).** The measurements show the time is
   in the kernel; (c) breaks the sandbox promise.
5. **lust's optimised build.** (a) Ask lust-lang for a sandboxed optimised build and try it as a tiered build here;
   (b) wait for lust's own backend work; (c) drop it. **Plan: (a)**, as an experiment with a go/no-go number (five
   times on compute-heavy plugins, same bytes), before any installer grows.
6. **Behaviour when adopting.** (a) Same names keep the same bytes; better maths comes under new names; (b) allow the
   crate copy to improve the old name's numbers. **Plan: (a).** It is what keeps every saved plugin building the same
   part.

## 8. Milestones

Each is one PR to `main`, smallest useful first, with an "As built" note here and the docs it touches
(`docs/mcp-server.md`, `guide {kind: "recipes"}` or `"ingredients"`, `docs/step-modeler.md`). MCP tests run with
`node --experimental-strip-types`; real-lust tests run in CI with `LIME_RECIPE_REQUIRED=1` on Windows and Linux.

1. **Native geometry gives the same bytes.** `lime-model-load`'s `tree` hands the crate the request's `args` text
   without parsing and re-writing its numbers (or `serde_json` gets `float_roundtrip`; the test decides).
   *Notice:* a plugin sends the same cut whether or not the host helps with geometry.
   *Tested by:* a Rust test in `lime-model-load` that sends coordinates known to misparse and compares
   `native_geometry_request` through `tree` with the direct call; `mcp/recipe-geom2d.test.ts` gains a case through the
   real engine path when the addon is present, comparing the op bytes with the all-lust run, using a spiderweb-like
   web of a hundred cells.

2. **The kernel's split in the profile, and a bench.** The bridge exports its timing counters; `profile: true` adds
   `kernel: {booleanMs, volumeMs, meshMs, readoutMs}` per line. `mcp/fixtures/bench/` gets gears-on-sphere, the
   puzzle box and the spiderweb plugin (copies the owner approves; no company parts), and `tools/recipe-bench.mjs`
   runs them on the real engine three times and prints a table like section 2.
   *Notice:* an agent sees whether a slow plugin is slow in its own code, in the booleans, or in meshing.
   *Tested by:* a unit test of the profile shape (stand-in engine); the bench runs locally, and in the nightly perf job
   if that job can build lust; never in the smoke shards.

   **As built (2026-11-09, `claude/recipe-profile-mesh`).** The bridge's counters were already there (`Stats` in
   `kernel.cpp`, `lime_model_occt_stats`); what was missing was a per-call reading. `lime_occt_tree` in
   `crates/lime-model-occt/src/lib.rs` now answers a request whose body starts with `{"timing":true,` with `kernelUs`
   added as the reply's last field (`us` in the bridge, `booleanUs`, `volumeUs`, `meshUs`, `readoutUs`, `describeUs`,
   `builds`, `meshes`: the counters before and after the call). Any other request is answered as before, with no extra
   work, and an old bridge ignores the marker, so the profile then says only `engineMs`. `recipe_run {profile: true}`
   puts the marker on every tree call of the run (`treeCall`, `mcp/session/model.ts`) and keeps the answers per recipe
   call and in total (`mcp/session/mesh-end.ts`). The reply gets `profile.split`, parts that add up to `runMs`:
   `recipeMs` (the recipe's own code and its start), `hostMs` (the server's work in the calls), `engineHopMs`
   (the worker hop and the text both ways), `kernelBooleanMs`, `kernelMeshMs` (meshing and reading the mesh out) and
   `kernelOtherMs` (volume, measuring faces and edges, building the tools, the store); `profile.kernel` has the
   counters and each line its `kernelMs`, `booleanMs` and `meshMs`. The plan's `{booleanMs, volumeMs, meshMs,
   readoutMs}` per line became those three on the line and the full set in `profile.kernel`, so a line stays short.
   The bench is `mcp/bench/recipe-bench.ts` (not `tools/recipe-bench.mjs`: it runs the session, which is TypeScript):
   `node --experimental-strip-types --no-warnings mcp/bench/recipe-bench.ts [--runs 3] [--only gears,web,moon]
   [--json file]`, with the real engine, the bridge and lust (it says what is missing and exits 2). Its fixtures are in
   `mcp/fixtures/bench/`: the owner's `gears-on-sphere.rs` (with `involute-gears` and `op-builders`), and the saved
   `spiderweb-cut-on-a-part` and `moon-crater-field` plugins, which carry their ingredients; they hold no personal data
   and no part of anyone's. The plan named the puzzle box; it is 22 s a run and the bench takes the moon crater field
   (10 craters on a sphere) instead, whose time is in meshing. It is not a CI job: the perf workflow has neither lust
   nor Open CASCADE. *Tested by:* `mcp/recipe-profile.test.ts` (the split adds up to the run within a millisecond, with
   the stand-in engine and with real Open CASCADE; the kernel is inside the engine's time, which is inside the calls),
   `cargo test -p lime-model-occt` (`tests/mesh_end.rs`, `timing_tests`). Measured on the owner's PC with other work
   running (three runs each, medians; `docs/mcp-server.md` has the table's columns), gears on a sphere, as written:
   run 16.1 to 20.3 s of which the kernel's booleans 10.5 s, meshing 3.1 s, the rest of the kernel 2.5 s, the recipe's
   own code 0.5 s, the host 0.3 s, the hop to the engine 0.1 s. The crater field: 1.1 to 1.25 s, of which meshing 0.47 s.
   The web cut: 1.7 to 2.0 s, of which the recipe's own code 0.73 s, the booleans 0.71 s, meshing 0.15 s.

3. **Queued applies.** Crate: `apply_later`, `flush`, the queue flushed by any other call and by `done`; API minor up,
   with its corpus plugin. Host: the flush planner (runs of one kind, safe swaps by box), `failures` mapped to recipe
   lines; the profile hint. Guide: queue applies whose answer you do not read.
   *Notice:* gears-on-sphere written with `apply_later` runs in about 2 s instead of 12, with the same part.
   *Tested by:* `cargo test -p lime-recipe` (queue and flush lines), `mcp/recipe-queue.test.ts` (real lust, stand-in
   engine and real OCCT in CI: same solid as one by one, a refused op's line, an overlapping cut and fuse kept in order,
   a read flushes first, `done` flushes), the corpus job, the bench before and after.

   *As built (2026-11-09), as the owner decided it (silent queuing by default, the explicit queue, the teaching):*
   - **Which lines queue.** lust does not yet say how a call's result is used (its build JSON has diagnostics only;
     `must_use` is parsed and ignored). A lazy reply from `s.apply` was ruled out: its type is `Result<Json, Refusal>`
     and a `Json` is a plain enum a recipe may match, so no read can be caught without changing the API of every saved
     plugin. So the host reads the built text itself (`src/recipe/unread-applies.ts`) and claims a line only when the
     call's shape proves the reply unread: `s.apply(..)?;`, `.unwrap();`, `.expect(..);`, a bare statement, `let _ =`,
     `.is_ok()` / `.is_err()`, and `match` / `if let` whose `Ok` binds nothing (gears-on-sphere's helper). Comments and
     strings are blanked; a line with a read apply beside an unread one, or a recipe with its own `fn apply`, claims
     nothing. Request to lust-lang, to replace the scan: in `lust build --json`, one line per call to a
     `#[track_caller]` function the host names (a flag such as `--mark-unread lime_recipe::Session::apply`) whose
     `Ok` value is never read, `{"kind":"unread_result","fn":"lime_recipe::Session::apply","span":{"line":L,"col":C}}`,
     with the span the call reports through `Location::caller()`; lust's checker knows each value's uses, so it also
     covers what text cannot (a helper that returns the reply, a binding never read).
   - **Host** (`src/recipe/queue.ts`, shared by the MCP session and the app's Plugins run and plugin-step rebuild): an
     unread line's plain fuse or cut (boolean, extrude, revolve, loft naming no face, edge or anchor) is answered
     `{ok, queued}` after a pre-check: the engine builds its tool alone (`toolBox`, a new stateless tree call) and its
     box must meet the part's box grown by queued fuses. Anything else is built in its place after the queue, so its
     refusal is the recipe's own. Flush triggers as decided (any call naming the part, the selected part for calls
     naming none, checkpoint, `done`, `flush`, 200 ops, 80 % of the time limit). Grouping: earliest compatible group
     of the same kind past groups whose tools the box misses; plain booleans group only with plain booleans, and a
     queued group of them merges faces on one surface once at its end, as each did alone (without that the puzzle box
     had 102 extra faces). Each group is a `group {combine, source: {kind: "queue"}}` applied as any combined batch;
     then the engine's new `unfold` call swaps the groups for one step per op in the order sent, the last holding the
     solid, and the client marks each `builtWith` (saved in the project, shown by `model_history`). The step guards run
     per group. The kernel names an extrude, revolve or loft that changed nothing inside a queued group by its faces
     (`combined.missed`, from the boolean's history); a plain boolean that misses is an ordinary step either way.
     Any refusal there replays the run with silent queuing off (MCP re-enters `recipe_run`; the app runs again after
     dropping the first attempt's steps). `LIME_RECIPE_QUEUE=0` turns silent queuing off for a server.
   - **API 1.11**: `apply_later`, `flush` (with `Combined::lines`), `apply_now`, `queue(bool)`; corpus plugin
     `api-1.11-queue`. The corpus also runs every level again with silent queuing off and checks the same calls, ops,
     solid and metrics.
   - **Teaching**: the recipes guide's Speed paragraph, the instructions line, a lesson that ships with the app
     (`apply/0`, found by "slow", "speed", "many applies", "batch"), and the reply's `queued {applies, booleans}`,
     `queueHints` and `replayed`.
   - **Numbers** (this PC, release engine and bridge, real OCCT, three runs each, wall time of `recipe_run`):
     gears-on-sphere unchanged 4.7 to 4.8 s queued (3 booleans) against 13.8 to 18.3 s one by one (27); with
     `apply_later` 4.5 to 4.6 s. The same 1,358 faces, 3,996 edges and volume 919,718.5239405725 mm³, and 28 History
     rows either way. The puzzle box plugin: 12.9 to 15.0 s queued against 14.3 to 19.2 s one by one; 176 applies built
     as 76 booleans (319 kernel applies against 419); the same 20 parts, 218 History rows, 2,362 faces and 6,103
     edges, volume equal to 15 digits. Its hint says why it gains less: `model_place` at line 52 builds the queue 13
     times.

4. **Mesh once, at the end.** During a recipe run the session asks the kernel for no mesh after a step and marks the
   part's mesh out of date; a read, a probe preview or `done` meshes it. The app's runner does the same.
   *Notice:* sequential recipes get faster (up to about a fifth on gears-on-sphere); previews look the same.
   *Tested by:* `mcp/recipe-session.test.ts` (reads after applies give the same answers), `mcp/plugin-app.test.ts`
   (same stamp and solid through MCP and the window), the bench.

   **As built (2026-11-09, `claude/recipe-profile-mesh`).** On request only, as decision 2 (b) names it, so nothing
   changes for a run that does not ask: `recipe_run {meshAtEnd: true}`, or `s.mesh_at_end()` in the recipe (API 1.10,
   corpus plugin `api-1.10-mesh-at-end`; the window answers it with an ok and meshes every step as before, the part is
   the same). The engine's `apply` takes `mesh: false` and then answers `{id, format: "lime-solid-lite", fingerprint}`
   with the usual `op`, `replayed` and `held`: the solid is built and kept, not meshed (a split, and any apply with
   `otherKey`, `pieceKeys` or `pinsKey`, is meshed whatever was asked). The session asks this of a plain `model_apply`
   only: a boolean with a primitive, or an extrude, whose fields are all sizes and a place (`skipsMesh`,
   `mcp/session/mesh-end.ts`); the part then holds a solid with its volume, fingerprint and a box and no faces
   (`lightSolid`), and a step is owed a mesh (`session.meshPending`). Every other call of the run first meshes what is
   owed (`ensureMeshes`: a `goto` of the step, which meshes the solid the step already holds), so a read, a pick, a
   section, a check or a checkpoint sees the part as it always did, and the run's end meshes once before the parts are
   kept. A failed run clears what was owed and takes the run back as before. `profile.meshAtEnd` is that last mesh.
   Two differences, both in a step that skipped its mesh, both documented in `guide {kind: "recipes"}`: the check that a
   tool misses the part reads the part's box as grown by the fuses so far (never smaller than the part, so a miss is
   found less often and never refused wrongly), and the check that a step does not leave pieces meeting only along an
   edge reads a step's mesh and is not made (`model_check` of the finished part still lists open edges). The engine does
   not measure the box: from the geometry it cost 70 ms a step on the gears, as much as the mesh it saved (the first
   version did, and gained nothing). Found while measuring: Open CASCADE's booleans take about a tenth longer on a part
   with no mesh (they measure faces from it), so the gain is a little less than the meshing saved. Decision 2's (a),
   always on, was left: it would change the checks above for every recipe. The schema gains one short parameter
   (`meshAtEnd`, 18,246 of 18,250 tokens; the detail is in the recipes guide).
   *Tested by:* `mcp/recipe-profile.test.ts` (stand-in engine: every plain step asks for no mesh, one mesh at the end, a
   read in the middle meshes first, a hole is meshed, a refused run leaves nothing owed, the same stored steps; real
   Open CASCADE: the same fingerprint, volume and mesh byte for byte, the same read in the middle and the same
   `model_check`), `cargo test -p lime-model-occt` (`tests/mesh_end.rs`: four steps meshed one by one and not meshed
   until a `goto` give the same replies byte for byte), `mcp/plugin-corpus.test.ts`. The bench, three runs each,
   medians, run plus the final mesh against meshing every step, the same solid and mesh byte for byte in every case:
   gears on a sphere 14.2 % faster (final mesh 0.7 s), moon crater field 44.8 % (0.02 s), spiderweb cut no different
   (its time is in the recipe's geometry and lust, and its parts are small: -3 %, which is noise).

5. **Gears as a standard ingredient.** `lime_recipe::gears` adopted from the library's `involute-gears` v1 by section
   5's process, plus `outline_loops` (spline flanks, tip and root arcs) and a worked example; the library ingredient's
   next version re-exports it; `guide {kind: "ingredients"}`; API minor up with its corpus plugin.
   *Notice:* an agent writes a gear train without importing a library file, and can ask for true curves.
   *Tested by:* byte comparison of the library copy and the crate copy on every tooth count from 6 to 120; rustc
   against lust; real-OCCT extrude of each outline kind (valid solid, expected volume); the corpus.

6. **More native fast paths.** From milestone 2's profiles: the next `geom2d` functions whose calls cost over 5 ms in
   lust (offsets and rounded corners first), each with its threshold and its byte test through the engine.
   *Notice:* the spiderweb plugin and lattice-heavy plugins get faster; nothing else changes.
   *Tested by:* `mcp/recipe-geom2d.test.ts` per function, the bench.

7. **Optimised lust builds (experiment).** With lust-lang: a sandboxed optimised build; here, a tiered runner behind
   an environment switch (first run tcc, later runs the optimised build, cached by source hash, lust revision and API
   level). Go if the bench's compute-heavy cases get at least five times faster in their own code with the same bytes;
   then a follow-up PR ships the compiler in the installers.
   *Notice:* behind the switch only, until the go decision.
   *Tested by:* the corpus under both builds (same calls, byte for byte), the bench.

   **As built (2026-11-09, `claude/lust-opt-zig`, for 6.2.0).** The owner took it on by default, with zig in the
   installers, in one PR. lust is pinned at lust-lang PR #24's head (`--opt` and `--opt=bg`, lust-lang `docs/opt.md`);
   the pin moves to its merge commit once #24 merges. `tools/lust/zig.sh` fetches the official zig 0.14.1 for the host
   (sha256 pinned in `tools/lust/ZIG_SHA256` from ziglang.org's index), and `tools/lust/stage.sh` puts it trimmed to the
   host's own target in `mcp/lust/zig` (Windows: 274 MB on disk, 6,079 files, about 46 MB compressed). The MCP host
   (`mcp/recipe-opt.ts`) and the app's runner (`crates/lime-recipe-runner/src/opt.rs`) build with `--opt=bg` when that
   zig is there, tcc otherwise; `LIME_LUST_OPT=0` off, `1` on anywhere, `now` foreground `--opt`; `profile.build`
   says which ran. On by default on Windows only: on Linux, CI's float maths found `ln` of a negative number giving a
   NaN with the other sign bit (zig's default x86_64-linux-gnu target is glibc 2.28, so the program links the old
   `log@GLIBC_2.2.5` wrapper, where tcc and rustc link `log@GLIBC_2.29`); macOS is not proven. Both stay tcc by
   default until lust-lang PR #24 targets the host's glibc; CI's Linux `--opt` step keeps running, not blocking.
   Decisions: zig's cache is Lime Slice's own and shared (`%LOCALAPPDATA%\Lime Slice\cache\zig` and the like), filled
   by a one-shot warm-up without lust's daemon before the first `--opt=bg` (a cold zig cache held the daemon, and every
   build behind it, for 30 to 80 s); lust's cache, with the optimised binaries, stays each host's (`<root>/cache`), as
   lust keys them by the slot's path; a slot rewritten while a background build runs marks that build untrusted, and
   its binary is removed when it ends (the background build reads the file when it runs).
   Measured on the owner's Windows machine, bench medians of 3 per way (`mcp/bench/recipe-bench.ts`), tcc then `--opt`:
   the recipe's own code 578 to 84 ms (gears), 963 to 324 ms (spiderweb), 735 to 257 ms (moon); the run 649 to 161 ms,
   2,201 to 1,569 ms, 798 to 332 ms; same solid and mesh. The optimised compile itself takes 4.7 to 6.5 s once per new
   source, in lust's daemon, which holds a build that follows at once for that long. The corpus, the float maths
   against rustc and the native geometry bytes pass with every build `--opt` (`mcp/recipe-opt.test.ts`, CI's "Recipes
   with lust --opt" on Linux and Windows, and the release's staged copy).

8. **A kernel gear step** (if decided). `gear` op with B-spline involute flanks, a Model tab card, an MCP op with its
   guide, and the crate builder `ops::gear`.
   *Notice:* a person adds a gear from the Model tab; an agent makes one with one op.
   *Tested by:* real-OCCT tests (valid solid, tooth thickness at the pitch circle, two gears mesh without
   interference at the right centre distance), an e2e spec in `test:smoke`, a fixture rebuild.

## 9. Done for the whole plan

- A recipe's time is reported where it goes: its own code, the booleans, the meshing.
- A recipe that makes many tools on one part builds them in a few booleans, with the same part.
- Library code that proved itself is in the crate (and, when heavy, also native in the engine) by a written process,
  and every plugin saved before still sends the same calls.
- The same plugin sends the same bytes on every host.
- If lust's optimised build proves itself, a plugin's own code runs at close to rustc speed, still in lust's sandbox,
  with no compiler for the person to install.

## Appendix: reproducing the numbers

The harness was a throw-away file next to `mcp/session.ts` (not committed; milestone 2 makes a real one). It set
`LIME_MCP_ENGINE` and `LIME_OCCT_BRIDGE` to copies of the release engine and bridge with the OCCT DLLs beside them,
`LIME_LUST` to the pinned lust, and `LIME_PLUGINS_DIR` to a copy of the owner's library, then for each run: a sphere
of radius 60 by `solid_new`, `recipe_run {source, name, object, params, profile: true}`, the solid's fingerprint,
`object_remove`. Wrapping `session.engine.modelTree` gave each kernel request's time and reply size, and answering
`nativeGeometry` with an error turned native geometry off. The variants (`gears-batched.rs` with a `flank` parameter,
`gears-spline.rs`, a protocol probe making `n` `log` calls) and the compute bench (`lime-recipe` and the involute
ingredient inlined into one file, built with `lust build --sandbox`, `rustc` and `rustc -O`) are kept in the
investigation's scratch folder and go into `mcp/fixtures/bench/` with milestone 2.
