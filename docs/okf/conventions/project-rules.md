---
type: Practice
title: Project rules as written
description: What the repository actually states about byte-identical G-code, licences, network use, keyboard keys, and defaults.
tags: [conventions, gcode, licence, defaults]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: slice
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice-core/src/slice.rs
    title: crates/lime-slice-core/src/slice.rs
  - id: readme
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/README.md
    title: README.md
  - id: progress
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/slice-progress.md
    title: docs/slice-progress.md
  - id: plan
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-gpu-slicing.md
    title: docs/plan-gpu-slicing.md
  - id: claude
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/CLAUDE.md
    title: CLAUDE.md
  - id: cargo
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/Cargo.toml
    title: Cargo.toml
  - id: ci
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/.github/workflows/ci.yml
    title: .github/workflows/ci.yml
  - id: notice
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/third_party/occt/NOTICE.md
    title: third_party/occt/NOTICE.md
  - id: solve
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/sketch/solve.ts
    title: src/sketch/solve.ts
  - id: commands
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/commands.ts
    title: src/ui/commands.ts
  - id: review
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/ui-review-tasks.md
    title: docs/ui-review-tasks.md
  - id: assemblies
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/plan-assemblies.md
    title: docs/plan-assemblies.md
  - id: usability
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/docs/usability-review-1-2-0.md
    title: docs/usability-review-1-2-0.md
  - id: serve
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/crates/lime-slice/src/main.rs
    title: crates/lime-slice/src/main.rs
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: bridge
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/bridge-client.ts
    title: mcp/bridge-client.ts
  - id: pref
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/auto-slice-pref.ts
    title: src/auto-slice-pref.ts
  - id: groups
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/groups.ts
    title: mcp/groups.ts
---

# How to read this

These are the sentences and checks that are in the tree. A few phrases people use for the project ("offline only", "no casual keyboard shortcuts", "defaults must be good") are not written as those words. The sections below say what is written, and where a blanket reading would be wrong.

# G-code stays byte-identical

`slice.rs` says an omitted top-skin pattern keeps rectilinear scanlines, "so a default request stays byte-identical. Monotonic and concentric are opt-in."[^slice] `docs/slice-progress.md` says that with no sink, and with a sink that is never cancelled, the G-code is byte-identical, and `tools/golden_ab.sh` is the check against the previous tree.[^progress] The README says `tools/golden.sh` hashes the G-code for every sample under six configs, so a refactor can prove it left the output byte-identical.[^readme] `CLAUDE.md` says never re-slice old code for a baseline.[^claude]

`docs/plan-gpu-slicing.md` says each of its CPU milestones keeps G-code byte-identical, and then section 10.6 records one output change: a belt part off the bed's centre across the belt now prints the centred part's toolpaths shifted. A part at the centre is unchanged, and the plan says golden has no belt rows and stays 60/60 identical.[^plan] See [Belt printers](/printers/belt.md).

# Licences

The workspace `license` field is MIT.[^cargo]

The CI step "New engine dependencies stay MIT or Apache-2.0" fails if `cargo tree -p lime-mcp-engine` matches `GPL`, `AGPL`, or `SSPL`, with the message "a GPL-family licence is not allowed". The same step fails if `cargo tree -p lime-sim` matches `GPL`, `AGPL`, `SSPL`, or `LGPL`, with "a GPL-family licence is not allowed on the stress solver".[^ci]

Open CASCADE is the exception that is shipped, not linked into the slicer. `third_party/occt/NOTICE.md` says OCCT 7.9.2 is LGPL-2.1 with the Open CASCADE exception 1.0, the slicer does not link those libraries, the modeling crate loads them when `OCCT_ROOT` is set, and the rest of Lime Slice remains MIT.[^notice] The sketch solver's header says it is not PlaneGCS or FreeCAD, so the app stays MIT plus the dynamically linked OCCT.[^solve]

# Network

There is no single "offline only" rule in `CLAUDE.md` or the README.

What the code does:

- `lime-slice serve` defaults `--host` to `127.0.0.1`. Binding `0.0.0.0` is allowed, and the server warns if that listen has no token.[^serve] The README tells a phone on the LAN to open that host.[^readme]
- The MCP bridge client accepts only `127.0.0.1`, `localhost`, `::1`, and `[::1]`.[^bridge]
- MCP `session_info` says "Nothing is sent to a printer."[^schema] The desktop has a Send to printer command for a Prusa Link, Moonraker, or OctoPrint host stored on the printer.[^readme]

`docs/step-modeler-evaluation.md` says "The desktop app already runs offline. The modeler does too." That sentence is about not needing a network to model, not about the send-to-printer command.

# Keyboard

`src/ui/commands.ts` opens with "The one list of commands. The palette, the shortcut sheet, button tooltips and the keyboard dispatcher (`keys.ts`) all read it."[^commands]

`docs/ui-review-tasks.md`, round 3, says the registry stays the single list of keys. A local handler may still do a key's work, but the key must be declared in `COMMANDS`. Every new or moved key appears in the `?` sheet and in its button's tooltip. The UX-11 follow-up in that file says "no new shortcuts."[^review] `docs/plan-assemblies.md` says "No new rail button and no new shortcut" for that plan.[^assemblies]

The words "no casual keyboard shortcuts" do not appear. The written rule is the registry, plus those two "no new shortcut" lines in a review task and a plan.

# Defaults

`docs/usability-review-1-2-0.md` says "All new engine features are opt-in and off by default (`tools/golden_ab.sh` stays byte-identical)."[^usability] That matches the omitted-field comments in `slice.rs`.[^slice] Factory print settings are the speed strategy with supports off. See [Profiles](/settings/profiles.md).

Some switches default the other way, and are opt-out:

- Auto-slice loads as on unless `lime-slice-auto-slice` is `"0"`.[^pref]
- MCP tool groups are off unless `LIME_MCP_TOOL_GROUPS=1`. Without the variable every tool is listed, as before.[^groups]
- The live desktop bridge is off unless its two variables are set. See [Desktop shell](/architecture/desktop.md).

The phrase "defaults must be good" is not a sentence in the repository. The enforced pattern is the one above: a new slice field that would change G-code is omitted until asked for, and a few UI or server switches default on and store an off value.

[^slice]: crates/lime-slice-core/src/slice.rs
[^readme]: README.md
[^progress]: docs/slice-progress.md
[^plan]: docs/plan-gpu-slicing.md
[^claude]: CLAUDE.md
[^cargo]: Cargo.toml
[^ci]: .github/workflows/ci.yml
[^notice]: third_party/occt/NOTICE.md
[^solve]: src/sketch/solve.ts
[^commands]: src/ui/commands.ts
[^review]: docs/ui-review-tasks.md
[^assemblies]: docs/plan-assemblies.md
[^usability]: docs/usability-review-1-2-0.md
[^serve]: crates/lime-slice/src/main.rs
[^schema]: mcp/schema.ts
[^bridge]: mcp/bridge-client.ts
[^pref]: src/auto-slice-pref.ts
[^groups]: mcp/groups.ts
