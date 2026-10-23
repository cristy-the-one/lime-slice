# Lime Slice: notes for agents

Lime Slice is a filament slicer and a solid modeler in one Tauri 2 window, with an MCP server. The owner works with several agents at once (Claude Code, Cursor/Grok). Work lands through PRs to `main`; the owner tags releases and publishes them.

## Skills in this repo

`.claude/skills/` holds the procedures this project repeats. Each one fires on its own when its job comes up:

| Skill | Use it to |
|---|---|
| `land-pr` | open a PR, watch its CI, and merge it. Auto-merge waits for only three required checks, so arm it after the smoke shards pass. |
| `verify-ui` | prove a UI, e2e, unit, or MCP change on this machine: build first, headless Chromium only, the right specs, screenshots in the owner's view. |
| `release` | bump the version everywhere (`Cargo.lock` included), tag the merge commit, and attach notes to the draft. Never publish. |

Project memory (`~/.claude/projects/C--Users-marius-lime-slice/memory/`) holds the owner's preferences and the history behind these rules. Read its index at the start of a session.

## Tools, by role

| Role | Tool | Notes |
|---|---|---|
| GitHub (PRs, CI, releases) | `gh` CLI (logged in) | PR state through the desktop app's `ccd_pr` tools: bind, monitor, auto-merge |
| UI tests | Playwright, headless Chromium | never Edge or Chrome; see `verify-ui` |
| Rust build | `cargo`, `CARGO_BUILD_JOBS=4` | OCCT at `C:\Users\marius\.lime-slice\occt-7.9.2` for `lime-model-occt` |
| Slicer A/B | `tools/golden.sh`, stored runs in `~/.lime-slice/golden` | never re-slice old code for a baseline |
| Driving the app | the lime-slice MCP server | the installed `server.mjs`; never edit the owner's MCP config |
| Plans | `docs/plan-*.md`, reviewed as docs-only PRs | the plan is the spec an implementation follows |

## Change history

| Date | Change | Target | Reason |
|---|---|---|---|
| 2026-10-23 | Added `land-pr`, `verify-ui`, `release` and this file | `.claude/skills/`, `CLAUDE.md` | A harness review found the repeated procedures living only as notes in memory. #407 merged with red smoke shards, and the 3.6.0 bump failed every `--locked` CI job on a stale `Cargo.lock`. |
