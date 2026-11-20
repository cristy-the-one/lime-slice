# Study: typical mechanical components for Lime Slice

Status: study branch `study/mech-components`, 2026-11-20. Recipes live under `mcp/fixtures/plugins/mech-study/` as plugins (API 1.17 front matter, lust-built `main.rs`). Nothing here is wired into the Model tab, Plugins panel catalogue, or MCP library.

## Executive summary

| Metric | Value |
|---|---|
| Catalogue entries (ranked for FDM mechanical design) | 38 |
| Recipes built and tested (lust + metrics bounds) | **23/38** |
| Already in app as primitives (gear family) | 3 (spur, ring, rack) |
| Needs new engine primitive or feature | 9 |
| Out of scope for current stack | 6 |

Bounding boxes in the recipe table come from each plugin's `done` metrics (`bmin`/`bmax`), collected by running every recipe through the lust host on 2026-11-20 (`node --experimental-strip-types mcp/recipe-mech-study.test.ts`). Closed/manifold solids are expected under CI's OCCT MCP job (`gear.test.ts` pattern); this study environment had no `OCCT_ROOT` at engine build time.

## What a recipe is here

Same as `docs/plan-recipe-plugins.md`: a `//! ---` YAML header (`plugin`, `title`, `params`, `api`, …) and a Rust `main` using `lime_recipe::Session`, built with lust, talking to the host via `solid_new` / `apply` / `done_with`. Gears use `solid_new { gear: { … } }` like `mcp/fixtures/plugins/companions/corpus-gear-api-1-16.rs`. Fits and bearings use `lime_recipe::horology::{hole, shaft, bearing, Fit}`.

## Ranked catalogue

Frequency is approximate use in printable mechanical assemblies (hobby robotics, fixtures, enclosures). **Build** = study recipe exists; **App** = Model primitive today; **Need** = missing capability; **OOS** = out of scope.

| Rank | Component | Standard (ID only) | Build | Notes |
|---:|---|---|:---:|---|
| 1 | Spacer / standoff (round) | — | Yes | `mech-spacer` |
| 2 | Flat washer | ISO 7089 | Yes | `mech-washer` |
| 3 | Hex nut | ISO 4032 | Yes | `mech-hex-nut` |
| 4 | Hex bolt (head + shank, no thread) | ISO 4017 | Yes | `mech-hex-bolt-head` |
| 5 | Socket head cap (no thread) | ISO 4762 | Yes | `mech-socket-head-cap` |
| 6 | Shaft (fitted diameter) | ISO 286 | Yes | `mech-shaft` |
| 7 | Mounting plate / flange | — | Yes | `mech-mounting-plate` |
| 8 | L-bracket | — | Yes | `mech-l-bracket` |
| 9 | Spur gear | ISO 53 / involute | Yes + App | `mech-spur-gear`, primitive `gear` |
| 10 | Ball bearing seat block | ISO 15 series | Yes | `mech-bearing-housing` |
| 11 | Shaft collar | — | Yes | `mech-shaft-collar` |
| 12 | Parallel key | ISO 8734 | Yes | `mech-parallel-key` |
| 13 | Flat belt pulley | — | Yes | `mech-flat-pulley` |
| 14 | V-belt pulley (groove) | ISO 5291 | Yes | `mech-v-pulley` |
| 15 | GT2 timing pulley (approx.) | GT2 pitch | Yes | `mech-gt2-pulley` (trapezoid cuts, not certified profile) |
| 16 | Ring gear | — | Yes + App | `mech-ring-gear`, `internal: true` |
| 17 | Rack | — | Yes + App | `mech-rack`, `rack: true` |
| 18 | Knob / hand grip | — | Yes | `mech-knob` |
| 19 | Heat-set insert boss | — | Yes | `mech-heat-set-boss` |
| 20 | 2020 extrusion T-nut block | — | Yes | `mech-2020-t-nut` |
| 21 | Cable clip | — | Yes | `mech-cable-clip` |
| 22 | Snap-fit cantilever | — | Yes | `mech-snap-fit-beam` |
| 23 | Disk cam (single lobe) | — | Yes | `mech-disk-cam` |
| 24 | HTD timing pulley | HTD | Need | Same approach as GT2; needs curated tooth constants |
| 25 | Roller chain sprocket | ISO 606 | Need | Repeated tooth + pitch diameter primitive or dedicated outline |
| 26 | Woodruff key | — | Need | Keyway cut + half-disk profile helper |
| 27 | Threaded rod / screw **helix** | ISO 261 | Need | No thread primitive; visual-only cylinder today |
| 28 | Compression spring | — | OOS | Helix / sweep along path not in recipe ops |
| 29 | Torsion spring | — | OOS | Same |
| 30 | Worm | — | OOS | No worm outline in `lime_recipe::gears` |
| 31 | Worm wheel | — | OOS | Pair with worm |
| 32 | Bevel gear | — | OOS | Only parallel-axis spur in crate |
| 33 | Helical / herringbone gear | — | OOS | No helix on gear primitive |
| 34 | Ball bearing solid (races) | ISO 15 | OOS | Print-in-place races poor; seat + commercial bearing |
| 35 | Linear rail carriage | — | Need | Complex multi-body; linear pattern + recess ops |
| 36 | Hinge (knuckle) solid | — | Need | `model_place` hinge is assembly, not one solid |
| 37 | Coupler (Oldham / jaw) | — | Need | Multi-part + alignment math |
| 38 | Wave / lock washer | — | Need | Thin swept form; sheet metal style |

**Recipes built today: 23/38** (items marked Yes in the Build column).

## Default parameters (shared style)

Parameters follow `docs/plan-recipe-plugins.md` D4: `number` / `count` / `toggle` / `choice` with `range`, `unit`, `label`, declared before the first host call. Bores use `horology::hole` / `shaft` with a user **allowance** (typically 0.1–0.2 mm for FDM holes, 0.05–0.1 mm for shafts). Gear entries use module 1–1.5 mm, backlash 0.1 mm default in the kernel (`src/model-gear.ts` `GEAR_DEFAULTS`).

### FDM print notes (general)

| Topic | Guidance |
|---|---|
| Clearance holes | Add 0.15–0.25 mm to nominal on M3–M8; use recipe `allowance` |
| Press fits | ISO press classes are below FDM resolution; measure on a coupon |
| Gear teeth | Print on XY, thickness along Z; 0.2–0.3 mm extra backlash on PLA |
| Pulleys | GT2/HTD: tooth cuts weak on teeth < 10 mm diameter; prefer 20+ teeth |
| Snap fits | Beam thickness ≥ 1.2 mm; hook ≥ 0.4 mm for PETG |
| Min feature | 0.4 mm vertical, 0.6 mm horizontal (0.4 mm nozzle) |

## Recipe build results (defaults)

Bounds are axis-aligned boxes from recipe metrics at default parameters (mm). **Manifold**: verified in CI OCCT job when `OCCT_ROOT` is set at engine build; lust-only runs confirm build + `done`.

| Plugin | bmin (mm) | bmax (mm) | Lust build (ms) |
|---|---|---|---|
| mech-spacer | [-5, -5, 0] | [5, 5, 12] | 85 |
| mech-washer | [-6.5, -6.5, 0] | [6.5, 6.5, 1.2] | 93 |
| mech-hex-nut | [-5, -5, 0] | [5, 5, 5.1] | 86 |
| mech-hex-bolt-head | [-5, -5, -20] | [5, 5, 4] | 94 |
| mech-socket-head-cap | [-5, -5, -25] | [5, 5, 6] | 107 |
| mech-shaft | [-3.944, -3.944, 0] | [3.944, 3.944, 40] | 95 |
| mech-parallel-key | [0, 0, 0] | [6, 6, 30] | 99 |
| mech-bearing-housing | [-14, -14, 0] | [14, 14, 13] | 382 |
| mech-spur-gear | [-18, -18, 0] | [18, 18, 6] | 97 |
| mech-ring-gear | [-20, -20, 0] | [20, 20, 6] | 89 |
| mech-rack | [-2.356, -4.125, 0] | [91.892, 1.5, 8] | 90 |
| mech-flat-pulley | [-20, -20, 0] | [20, 20, 20] | 341 |
| mech-v-pulley | [-31.2, -31.2, 0] | [31.2, 31.2, 16] | 94 |
| mech-gt2-pulley | [-7.166, -7.166, 0] | [7.166, 7.166, 8] | 107 |
| mech-l-bracket | [-20, -15, 0] | [20, 15, 40] | 93 |
| mech-mounting-plate | [-40, -30, 0] | [40, 30, 4] | 96 |
| mech-cable-clip | [-7, -5.3, 0] | [7, 5.3, 5.4] | 359 |
| mech-snap-fit-beam | [-7.4, -3.2, 0] | [17.4, 3.2, 10] | 103 |
| mech-heat-set-boss | [-3, -3, 0] | [3, 3, 5] | 97 |
| mech-2020-t-nut | [-10, -10, 0] | [10, 10, 20] | 337 |
| mech-knob | [-10, -10, 0] | [10, 10, 14] | 86 |
| mech-shaft-collar | [-7, -7, 0] | [7, 7, 6] | 90 |
| mech-disk-cam | [-20, -20, 0] | [27, 20, 8] | 375 |

## Capability map (lust + primitives today)

| Capability | Used by recipes | Crate / primitive |
|---|---|---|
| Box, cylinder, tube, cone, polygon prism | Most fasteners, spacers, pulleys | `ops::`, `solid_new` primitives |
| Holes through / blind | Washers, plates, bosses | `ops::hole` / `hole_through` |
| Extrude loops / geom2d | Clips, snap fits (some) | `geom2d`, `extrude` |
| Spur / ring / rack gear | Gear train parts | `solid_new { gear }`, `lime_recipe::gears` |
| ISO fits / bearings table | Shaft, washer, housing | `horology::hole`, `shaft`, `bearing` |
| **Missing** | Threads, springs, worm, bevel | Would need engine or `gears` extension |

## Integration plan (next agent)

Do **not** duplicate logic already in `src/model-gear.ts` and `src/model-primitive.ts`. Suggested order:

1. **Promote plugins to library** – Copy `mcp/fixtures/plugins/mech-study/mech-*.rs` into the user's plugin corpus or ship a read-only `samples/plugins/mech/` set; record `source-sha256` like `api-1.1-flange.rs`.
2. **Model tab primitives (optional)** – Only where repetition warrants UI parity with `gear`:
   - *Low priority*: box-like parts stay recipe-only (plates, brackets).
   - *Medium*: add `washer`, `spacer` as presets on cylinder/tube primitive if product wants picker entries.
   - *High*: spur/ring/rack already done; link recipes via `run_plugin` examples.
3. **Panel fields** – Mirror each plugin's `params` JSON in the Plugins panel (D5); gear fields already in `GearFields` (`src/model-gear.ts`).
4. **Panel picker order** – Fasteners → spacing → motion (gears, pulleys) → structure → retention (clips, snap fits).
5. **New primitives / engine** (describe in plans, do not implement in study):
   - `thread` op: ISO metric profile swept along axis (or cosmetic helix).
   - `sprocket` / `timing_pulley` kernel steps with standard tooth tables (GT2, HTD, ISO 606).
   - `worm` / `bevel` in `lime_recipe::gears` if mechanical clock horizon expands beyond horology.
6. **Tests** – Keep `mcp/recipe-mech-study.test.ts` in the recipes CI shard; add OCCT spot-check subset (e.g. spur, rack, washer) to the existing OCCT workflow when promoting to main library.

## Pattern references (files)

| Topic | File |
|---|---|
| Gear primitive spec | `src/model-gear.ts`, `src/model-primitive.ts` |
| Gear edit / validation | `src/model-edit.ts` |
| E2E gear | `e2e/model-gear.spec.ts`, `e2e/gear-train-project.ts` |
| Recipe gears API | `mcp/fixtures/plugins/api-1.12-gears.rs`, `crates/lime-recipe/tests/ring_gear.rs`, `rack_gear.rs` |
| Plugin format | `docs/plan-recipe-plugins.md`, `mcp/fixtures/plugins/api-1.1-flange.rs` |
| lust / runner | `src-tauri/src/recipe.rs`, `tools/lust/`, `docs/mcp-setup.md` |

## Open questions for Marius

1. Should promoted components live in **shipped** `samples/plugins/` or only MCP-discoverable study fixtures until curated?
2. Is an approximate **GT2** pulley acceptable for v1, or must tooth form match vendor drawings (gates recipe vs kernel step)?
3. For fasteners, is **head-only** geometry enough (tap/thread insert assumed), or is cosmetic thread priority?
4. Ring gear default `rim: 0` (auto) vs explicit rim in the panel—preference for library defaults?
5. Should bearing housing expose **catalog choice** (608, 625, …) only, or free-form seat diameter too?
6. Couplers and hinges: assembly recipes (`run_plugin` + `hinge`) vs single printable flexure—product direction?