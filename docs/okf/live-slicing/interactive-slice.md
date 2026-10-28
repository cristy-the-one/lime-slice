---
type: Pipeline
title: Interactive slice
description: The engine keeps slice stages in memory, can draw toolpaths before the tour finishes, and the UI can slice again after an edit.
tags: [slicing, live, cache]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: kept
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/slice/kept.rs
    title: crates/lime-slice-core/src/slice/kept.rs
  - id: progress
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/progress.rs
    title: crates/lime-slice-core/src/progress.rs
  - id: tauri
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src-tauri/src/lib.rs
    title: src-tauri/src/lib.rs
  - id: serve
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/src/main.rs
    title: crates/lime-slice/src/main.rs
  - id: run
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/app/slice-run.ts
    title: src/app/slice-run.ts
  - id: pref
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/auto-slice-pref.ts
    title: src/auto-slice-pref.ts
  - id: plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-gpu-slicing.md
    title: docs/plan-gpu-slicing.md
---

# There is no symbol named live slice

The tree has no `live_slice` string. What people mean by a slice that updates while you edit is three mechanisms below, plus the milestone notes in `docs/plan-gpu-slicing.md`.

# Kept stages

`keep_support_bases` keeps the stages of the last interactive slices in memory, so a support edit or a settings change recomputes only what changed. The shelves it clears when turned off are contours, toolpaths, tours, travels, supports, and joins. The function says it is off by default, and turning it off forgets them. It is for long-running shells.[^kept]

The desktop `run()` calls `keep_support_bases(true)`.[^tauri] `lime-slice serve` does too.[^serve] `crates/lime-mcp-engine` does not call it, so an MCP slice does not turn the shelf on by itself.

# Early preview

`Watch::ask_early` asks for an early preview: the toolpaths, drawn before the tour orders them. Only a live watch can carry one.[^progress] The UI sets `request.earlyPreview = true` when a slice result is already on screen.[^run]

# Auto-slice

`scheduleAuto` re-slices after a change when auto-slice is on and the plate has been quick to slice. A change made while the Model tab is open is deferred until the user leaves that tab.[^run] `loadAutoSlice` returns true unless `localStorage` key `lime-slice-auto-slice` is `"0"`. Storage failures also return true. The gear switch is the user's preference and outlives a restart.[^pref] Playwright's default storage state sets that key to `"0"` so specs start with auto-slice off.

# Milestones C0–C5

`docs/plan-gpu-slicing.md` section 10 describes CPU work that landed under those names. The plan's own summary is: C0 uses mimalloc in the long-running engines; C1 guesses tours; C2 orders infill with the same output; C3 draws toolpaths before the tour (`earlyPreview`); C4 keys part stages per layer so a mesh edit replans only the layers it reaches; C5 keeps a single belt part's place out of the plan so a move reuses every stage. Section 10.6 says C5 changes G-code for a belt part off the bed's centre across the belt, and that a centred part is unchanged.[^plan] See [Belt printers](../printers/belt.md) and [Project rules](../conventions/project-rules.md).

[^kept]: crates/lime-slice-core/src/slice/kept.rs
[^progress]: crates/lime-slice-core/src/progress.rs
[^tauri]: src-tauri/src/lib.rs
[^serve]: crates/lime-slice/src/main.rs
[^run]: src/app/slice-run.ts
[^pref]: src/auto-slice-pref.ts
[^plan]: docs/plan-gpu-slicing.md
