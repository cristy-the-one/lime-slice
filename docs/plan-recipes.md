# Plan: recipes as code

Status: the first slice is built. The lust side is on the fork (PR #11 of
cristy-the-one/lust-lang, pinned in `tools/lust/LUST_REV`); the lime-slice side
is `recipe_run` (`mcp/recipe.ts`, `crates/lime-recipe`). Not yet: lust in the
installers, and macOS (lust does not build there, so CI skips the recipe steps
on macOS and the tool answers that it needs lust).

An LLM driving Lime Slice through MCP writes a short Rust recipe instead of
hundreds of JSON ops. lust checks, builds and runs it in milliseconds, with
machine-applicable fixes for its errors. Every geometry, slicing or stress call
goes back through the engine the app already uses, so a recipe builds exactly
what the window builds, as one undo step, and can be rebuilt from new
parameters.

## How it works

```
LLM agent ──recipe_run(source, params)──▶ MCP server: the recipe host ──source──▶ lust daemon
          ◀──fixes, or handle + metrics──        │   ▲                ◀─diagnostics + fixes─┘
                                                 │   │ calls / replies, JSON lines            │ builds
                                                 ▼   │                                        ▼
                                     lime engine (unchanged)  ◀── serves each call ──   recipe process
                                     OCCT kernel · slicer ·        through the MCP        (lust --sandbox,
                                     stress solver; one history    tools' own functions    lime-recipe crate)
                                     tree, one undo stack
```

lust only checks and builds. The host decides what a recipe may call and owns
the transaction. The engine needs no change, and lust needs no foreign-function
access to Open CASCADE: the recipe asks the host, and the host calls the kernel.

## Measured on the lust branch

From `tests/recipes/` and `scripts/test-recipes.sh` in lust-lang (a
dependency-free stand-in for `lime-recipe`, two recipes, a scripted host),
2-vCPU Linux sandbox:

| Step | lust | Cargo (debug) |
|---|---:|---:|
| Cold build of a recipe, empty caches | 407 ms | 679 ms |
| First build of a new recipe crate in a running daemon | about 420 ms | |
| A new recipe written over a warm slot (same crate directory, new source) | about 105 ms | |
| Edit + check, warm | 7.8 ms | |
| Edit + build, warm | 16.6 ms | |

- The transcript of every call, built by lust `--sandbox` and by Cargo, is the
  same byte for byte (rule zero for recipes).
- Each call carries the recipe line that made it (`#[track_caller]`), so a
  refusal points at the line to fix.
- Keep a few recipe slots: one crate directory each, with `lime-recipe` as a
  path dependency, and write each new recipe into a free slot. The daemon keys
  sessions by crate, so the slot's std and `lime-recipe` stay compiled.

## The recipe protocol, version 1

One JSON object per line, UTF-8, over the recipe's stdin and stdout. stderr
carries only a panic report or a sandbox stop.

| Direction | Message | Fields |
|---|---|---|
| host → recipe, first line | start | `v: 1`, `params` (name → number, string or bool), `context`: `units: "mm"`, `printer` (name, bed size, nozzle mm), `material`, `object` (a handle, or null for a new part) |
| recipe → host | call | `id` (counts up from 1), `call` (one name from the allowlist, S4), `args` (as the matching MCP tool takes them), `at` (`line`, `col` in the recipe) |
| host → recipe | reply | `id`, `ok: true` + `result`, or `ok: false` + `error` (the engine's sentence) and any hint it gives, such as `maxMm` for a blend |
| recipe → host, last line | done | `object` (the handle built), optional `metrics`, optional `notes` |

A recipe that exits without `done`, exits nonzero, or passes a limit (S5) is a
failure: the host rolls back everything the run applied. A failed run reads as:

| Exit | stderr | Meaning |
|---|---|---|
| 101 | `thread 'main' (<tid>) panicked at <file>:<line>:<col>:` then the message | a panic, in rustc's exact format |
| 101 | `error[L0532]: this program was built with --sandbox and tried to use <family>` | the sandbox stopped an OS call before it ran |
| other | | `std::process::exit(n)`, or killed by the host |

## Requirements for lime-slice

The host lives in the MCP server and reuses the engine functions today's tools
call: no new kernel path.

| ID | Requirement | Acceptance check | Phase |
|---|---|---|---|
| S1 | MCP tool `recipe_run`: `source` or a stored `name`, `params`, optional `object`, `mode` = `check`, `dry` or `apply`. Returns lust's diagnostics with their edits, a one-line summary per call made, the result handle and `metrics`. | An invalid recipe answers with diagnostics in under 50 ms warm. A valid one in `apply` mode lands as one undo step. | 1 |
| S2 | `recipe_define`, `recipe_list`, `recipe_get`: a named recipe (source + parameter defaults) stored in the session and the `.lime` project, as `model_define` stores parts. | A project saved and reopened lists the recipe and runs it unchanged. | 1 |
| S3 | Recipe host: writes the source into a warm slot, builds it with `lust build --sandbox --json`, runs it as a child process with an empty environment and serves protocol v1. Every call goes to the function the matching MCP tool uses. One run is one transaction: commit at `done`, roll back on any failure, the way `model_apply_batch` rolls back. | A recipe that fails at call 7 leaves the plate and History exactly as before the run. | 1 |
| S4 | Allowlist v1: `solid_new`, `apply` (any op `model_build` takes), `probe`, `measure`, `surface_at`, `faces_find`, `edges_find`, `check` (as `model_check`), `describe`, `estimate` (a slice summary: time, grams, support volume), `log`. `stress` (as `sim_run`) in phase 3. | A call outside the list answers `ok: false` naming the list. A test calls each listed name once. | 1 (stress 3) |
| S5 | Limits: 30 s wall time per run by default, kernel time included; at most 2,000 calls, 1,000 applied ops (the `model_apply_batch` cap) and 1 MB per line. Past a limit: kill, roll back, and name the limit in the reply. | One test per limit. | 1 |
| S6 | Errors point at recipe lines: a refusal goes back to the recipe as `ok: false`. A recipe that then panics or fails surfaces the engine's sentence, the panic message and the `at` line of the failing call in the MCP reply. | A recipe filleting an edge too far gets one reply naming its line and `maxMm`. | 1 |
| S7 | Crate `lime-recipe` in this repo: Rust source with no dependencies (its own small JSON reader and writer, as lust's `tests/recipes/kit` does), compiled by both lust and rustc. Typed builders for every op kind, generated from `mcp/schema.ts` so the schema stays the one source of truth. | CI: every op kind in the schema has a builder. CI: each sample recipe sends the same calls, byte for byte, built by lust and by rustc. | 1 |
| S8 | History: a part a recipe built stores the recipe name, source hash, params and lust version. The Parameters panel edits the params and Rebuild reruns the recipe. This closes the README's "Built by a recipe" read-only gap. | Change a parameter, Rebuild, and the fingerprint matches a fresh run with the new value. | 2 |
| S9 | Determinism: the same source, params and context give the same call stream and the same fingerprint. | Two runs compare equal in CI. | 1 |
| S10 | `recipe_search`: up to 64 candidates (parameter variants or source variants), objectives (volume, grams, print time, support volume, overhang area, max deflection, minimum safety factor) and constraints. Runs on the engine's parallel workers, caches by source hash + params + printer + material, and answers a ranked table with handles. | A 16-candidate search returns a table that a re-run answers from cache. | 3 |
| S11 | LLM aids: `recipe_guide` returns a cheat sheet under 2,000 tokens: the `lime-recipe` API, three examples, and `lust capabilities --summary`. `samples/recipes/*.rs` are tested in CI. Replies stay compact: numbers and handles, no meshes; `render_view` works on the result. | The guide's examples build and run in CI. | 1 |
| S12 | Packaging: the Tauri bundle ships `lust`, `lust-core`, lust's `library/` and tcc for Windows and Linux. One daemon per app, started on first use, exiting when idle. Without lust, the recipe tools are hidden and `session_info` says why in one line. | A fresh Windows install runs the first recipe without admin rights. | 2 |
| S13 | Isolation: recipes build with `lust --sandbox`, run with an empty environment and a temp working folder, are killed when the app closes, and get only stdin, stdout and stderr. The host never passes file paths. | A recipe opening a file is refused at check time (L0532). | 1 |

## What lust provides (fork branch `recipes-lust`)

| ID | Requirement | Status |
|---|---|---|
| L1 | Source in the request | Not needed. A host writes each recipe into a warm slot; a new recipe builds in about 105 ms, an edit in about 17 ms. |
| L2 | Sandbox profile | Done: `--sandbox` (docs/sandbox.md). Check refuses std paths to the file system, network, environment, processes, OS extensions and threads (L0532); the include! family reads no file; `env!` sees nothing; codegen stops any other OS call before it runs. |
| L3 | Memory cap | Open. Until then the host limits memory itself (a job object on Windows, `setrlimit` on Linux). |
| L4 | Warm `lime-recipe` | Done through slots (L1). |
| L5 | Panic report | Done as is: the panic line is rustc's, byte for byte; the sandbox stop is one fixed line (table above). |
| L6 | Fixes for numeric mistakes | Done: `4` where a float goes gets a `.0` edit (auto); numeric casts with `auto` only when lossless. Integer casts were already done. |
| L7 | Subset summary | Done: `lust capabilities --summary` (about 3,800 bytes). |
| L8 | Per-user caches | Done for the runtime object (was a shared temp file). The relocatable Windows bundle is part of S12. |
| L9 | Rule zero for recipes | Done: `scripts/test-recipes.sh` compares transcripts with Cargo builds. |
| L10 | Speed gate | The recipe loop is timed in `scripts/test-recipes.sh`; the fork's speed rows cover the rest. |

## An example recipe

A mounting bar with a row of holes, filleted only when enough material is left
(the host's measurement drives the choice). One `recipe_run`; with JSON ops it
is a probe and apply round trip per hole and per decision.

```rust
use lime_recipe::{ops, Session};

fn main() {
    let mut s = Session::start();
    let width = s.param_f64("width", 60.0);
    let holes = s.param_u32("holes", 4);
    let part = s.new_box([width, 20.0, 4.0]);
    for i in 0..holes {
        let x = width * (i as f64 + 0.5) / holes as f64;
        s.apply(&part, &ops::hole_down([x, 10.0, 4.0], 1.6, None));
    }
    if s.volume(&part) > 0.8 * width * 20.0 * 4.0 {
        s.apply(&part, &ops::fillet_top(1.0));
    }
    s.done(&part);
}
```

If the model writes `20` where an `f64` goes, lust returns the `20.0` fix as an
auto edit and the next build needs no model round trip.

## Phases and gates

1. **Recipes that build parts.** S1–S7, S9, S11, S13. Gate: the sample recipes
   run through MCP on Linux and Windows, and the lust-vs-rustc transcript check
   (S7) passes in CI.
2. **Recipes the app keeps and ships.** S8, S12. Gate: Rebuild from new
   parameters works in the window, and a clean Windows install runs a recipe.
3. **Design search.** S10 and the `stress` call. Gate: a 16-candidate search on
   the example bar finishes, and its re-run answers from cache.

## How we measure that the LLM is more efficient

The same model builds ten reference parts twice, once with today's JSON ops
(`model_build`, `model_apply_batch`), once with `recipe_run`: a mounting bar
with N holes, a honeycomb panel, a bolt-circle flange, an enclosure with snap
fits, a text plate, a family of cable clips, ribs added until a safety factor
is met, a split-to-print part with dowels, a lattice block, and a parametric
knob.

| Metric | Proposed target for recipes |
|---|---|
| MCP calls per finished part | at most half the JSON baseline |
| Model tokens, in + out | at least 40% fewer |
| Parts right on the first `apply` | at least as many as the baseline |
| Wall time to a finished part | no worse than the baseline |
| Rebuild after a parameter change | works for all ten (phase 2) |

The targets are a starting proposal; the first baseline run sets the real ones.

## Open questions

- May a recipe call `stress` at all, given one solve can take seconds? A
  per-run budget (count or seconds) is the likely answer.
- Should a recipe kept in a project also be built by rustc into the release
  app, so shipped features can start life as recipes?
- Where do recipes live in the window: read-only source in History first, or an
  editor in phase 2?
