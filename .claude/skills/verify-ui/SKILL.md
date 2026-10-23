---
name: verify-ui
description: Prove a Lime Slice UI, e2e, unit, or MCP change works on this Windows machine before claiming it. Build, run the right Playwright specs in headless Chromium, run the unit chain, rebuild the release engine for MCP tests, and take screenshots in the owner's theme. Use after any change to src/, e2e/, mcp/, or CSS, when reproducing a CI failure locally, when the owner reports a UI bug from a screenshot, or before opening a PR (land-pr). Not for slicer output A/B (that is the golden runs) and not for releases.
---

# Verify a UI change

The owner's rule: when you say it is fixed, show evidence from the same view they used. Reproduce first, change, then show before and after.

## Browser: headless Chromium only

Playwright runs its own headless Chromium. **Never launch Edge or the owner's Chrome.** Each launch logs Windows logon events the owner has to explain at work. The repo's `playwright.config.ts` has no `channel`. Before using any local config (`pw-*.config.ts`, which is never committed), grep it for `channel` and remove one if it is there.

## Build, then test

`playwright.config.ts` serves the **built** app (`vite preview` on port 43117), so a spec run before `npm run build` tests the old code. The order is:

1. `npx tsc --noEmit -p .`, then `npx tsc --noEmit -p mcp` if `mcp/` changed.
2. `npm run build`.
3. `npx playwright test <specs> --reporter=line`.

Which specs to run:

| Change | Specs |
|---|---|
| Model dock, panes, Stress panel | every `e2e/model-*.spec.ts` (not the `*-real` ones), `e2e/compact-*.spec.ts`, `e2e/preview-stress.spec.ts` |
| Prepare or Preview | the matching specs in `test:smoke` in `package.json`, plus `compact-*` for any layout CSS |
| One spec you wrote or fixed | that spec with `--repeat-each=3`; CI's software GL is slower, so a single pass is weak evidence |
| Anything wider | `npm run test:smoke` (all of the CI smoke list) |

Specs that need a real engine are `test:engine`. They run with `--workers=1` against `target/release/lime-slice serve`. Leave them to CI unless the change is in the engine path.

New spec files go into `test:smoke` in `package.json`, or CI never runs them.

## Unit tests

`node tools/run-unit.mjs` runs `tools/unit-tests.txt` as one chain, and **stops at the first failing file**. If a file fails, the files after it never ran; fix or rebuild, then run the chain again. A new test file has to be added to `tools/unit-tests.txt`.

## MCP and engine tests

The MCP tests load `target/release/lime_mcp_engine.dll` and the `lime-sim` binary. Rebuild both after a Rust change or a version bump. A stale engine fails the version check in the unit chain ("the loaded addon reports engine X.Y.Z").

```bash
CARGO_BUILD_JOBS=4 OCCT_ROOT=/c/Users/marius/.lime-slice/occt-7.9.2 cargo build --release -p lime-mcp-engine -p lime-sim
```

Then run each test as `node --experimental-strip-types --no-warnings mcp/<name>.test.ts`. The sim tests are `sim`, `sim-sliced`, `sim-reslice`, `sim-loop` and `layer-stress`. Use one heavy cargo build at a time on this machine.

## Probes and screenshots

- **Probe specs.** For questions no existing spec answers (overlap, sizes, what a header covers), write a throwaway `e2e/zz-<topic>.spec.ts`. It is never committed, and the evidence is the numbers it prints.
- **Screenshots.** Use the owner's view:
  - the dark theme, via `page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"))`;
  - 1440×1000;
  - the dock or the panel they showed.

  Save them under `test-results/<topic>/`, open each one, and look at it before reporting.
- **Auto-slice.** Specs start with it off (`storageState`). A spec that loads a mesh and counts slices calls `autoSliceOff(page)` first.

## Traps on this machine

- A `\n` inside a Bash heredoc can land in a file as a real newline; it broke a `.join("\n")` and a workflow file. Edit code with the Edit/Write tools, then run `tsc`.
- Bash exit codes after a pipe are the last command's, not the test's. Capture the test's own exit code, or read its pass and fail summary.
- `cargo test` G-code hash-lock tests fail on Windows on clean main (float rounding). They are Linux-only guards; use a golden A/B instead.
