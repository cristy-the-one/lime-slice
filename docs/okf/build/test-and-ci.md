---
type: Reference
title: Build, test, and CI
description: CI on pull requests to main runs Rust, the frontend, four Playwright smoke shards, MCP, a release bench, and OCCT link jobs. A docs-only diff skips the rest.
tags: [build, test, ci]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: ci
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/.github/workflows/ci.yml
    title: .github/workflows/ci.yml
  - id: perf
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/.github/workflows/perf.yml
    title: .github/workflows/perf.yml
  - id: pkg
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/package.json
    title: package.json
  - id: rust
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/rust-toolchain.toml
    title: rust-toolchain.toml
  - id: pw
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/playwright.config.ts
    title: playwright.config.ts
  - id: claude
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/CLAUDE.md
    title: CLAUDE.md
  - id: land
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/.claude/skills/land-pr/SKILL.md
    title: .claude/skills/land-pr/SKILL.md
---

# Local commands

`package.json` scripts:[^pkg]

| script | command |
| --- | --- |
| `dev` | `vite --port 43117` |
| `build` | `tsc --noEmit && vite build` |
| `test:unit` | `node tools/run-unit.mjs` |
| `test:smoke` | Playwright, `--grep-invert @perf`, over the spec list in that script |
| `test:perf` | Playwright `--grep @perf` on `e2e/model-speed.spec.ts` |
| `test:engine` | Playwright against a release `lime-slice serve`, workers 1 |
| `build:mcp` | `node tools/mcp/bundle.mjs` |

Playwright's `testDir` is `e2e`, timeout 90 seconds, base URL `http://127.0.0.1:43117`. The default storage state sets auto-slice off.[^pw] `CLAUDE.md` says UI tests are Playwright, headless Chromium, never Edge or Chrome.[^claude]

The Rust toolchain file pins channel 1.88.0 and includes clippy.[^rust] `CLAUDE.md` says local Rust builds use `CARGO_BUILD_JOBS=4`, and that the owner's OCCT tree for `lime-model-occt` is `C:\Users\marius\.lime-slice\occt-7.9.2`.[^claude] CI's "MCP server against real Open CASCADE" step sets `CARGO_BUILD_JOBS` to `"2"`.[^ci]

# CI jobs

`.github/workflows/ci.yml` runs on push and pull request to `main`. The job `what changed` sets `code=false` when every file in the diff is under `docs/` or is a `*.md` file. Every other job needs that output and is skipped when it is false. The comment says a skipped required check counts as passed.[^ci]

Job names and the work they start:[^ci]

| job | what it runs |
| --- | --- |
| what changed | `git diff --name-only` against the base |
| test, clippy, and Tauri | OCCT install, `cargo test --workspace --locked`, an OCCT MCP step, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test -p lime-sim --features gpu --locked --test sliced_study`, `cargo build -p lime-slice-desktop --locked` |
| typecheck and frontend build | `npx tsc --noEmit`, `npm run test:unit`, `npx vite build` |
| Playwright smoke (shard N/4) | `npx vite build`, install Playwright Chromium, `npm run test:smoke -- --shard=N/4` for N in 1..4 |
| MCP server | release build of `lime-slice`, `lime-mcp-engine`, and `lime-sim`; the licence grep in [Project rules](/conventions/project-rules.md); `npx tsc -p mcp`; the MCP test files; `npm run build:mcp` |
| MCP server (Windows) | release engine, Explorer thumbnail handler, `npm run test:unit` |
| MCP server (macOS) | release engine, then the native-load, scenario, and stdio tests |
| release bench smoke | release `lime-slice`, OCCT bridge, bench on bundled samples, `npm run test:engine` |
| OCCT dynamic link (Windows) | build and test `lime-model-occt` against the bundled OCCT |
| OCCT dynamic link (macOS) | the same on macOS |

The land-pr skill says main's ruleset requires only "test, clippy, and Tauri", "release bench smoke", and "typecheck and frontend build", and that the smoke shards are not in that required set.[^land]

`.github/workflows/perf.yml` is separate. It runs nightly, on `workflow_dispatch`, and on a pull request labelled `ci:perf`. It is the frame-timing specs kept out of the per-PR smoke run.[^perf]

`tools/golden.sh` hashes G-code for samples. `CLAUDE.md` says never re-slice old code for a baseline. See [Project rules](/conventions/project-rules.md).

[^ci]: .github/workflows/ci.yml
[^perf]: .github/workflows/perf.yml
[^pkg]: package.json
[^rust]: rust-toolchain.toml
[^pw]: playwright.config.ts
[^claude]: CLAUDE.md
[^land]: .claude/skills/land-pr/SKILL.md
