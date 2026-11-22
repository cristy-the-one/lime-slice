# Study: ts-rust for Lime Slice

2026-11-22, against `main` at `e6625f97` (7.1.0). The study changes no build or CI file. It tried every tool in a scratch worktree.

## Verdict

ts-rust (`tsc-rs` on npm) is a Rust port of Microsoft's TypeScript 7 compiler. TypeScript 7 is the Go compiler, formerly typescript-go. ts-rust is a type checker and `tsc` replacement. It does not compile TypeScript to Rust, bundle code, or run it, so it cannot change the app's runtime, the bundle, the MCP server or the Rust build. On our code it gives the same diagnostics as Microsoft's own `typescript@7.0.2` and `7.1.0-beta`. It checks `src` in 0.61 s, against 0.93 s for TypeScript 7 and 6.7 s for today's `tsc` 5.9 (11× faster than 5.9). It is one month old, has one maintainer, and its README says the author has "never read a line of this code".

Almost all of the gain comes from moving to TypeScript 7, and Microsoft's TypeScript 7 already gives it. ts-rust only adds 0.3 s per run on top. The typecheck is also 12 s of a CI run that takes about 20 minutes. Recommendation:

- Adopt `typescript@7` (Microsoft's) for `tsc --noEmit` once its four migration items below are handled.
- Keep `typescript@5.9` for ESLint, which cannot use TypeScript 7 yet.
- Leave ts-rust as a drop-in to revisit once it has a longer track record.

The real wins for a faster, leaner Lime Slice are elsewhere:

- Vite 8 (Rolldown): 7.5 s → 1.1 s per frontend build here.
- The bundled MCP server: 417 → 82 ms to start.
- Parallel unit tests.
- The Rust release profile and the test jobs, where most CI time goes.

## What ts-rust is

Every claim here comes from the repo at `91f3d02` (README.md, `npm/typescript-readme.md`, `npm/wasm/README.md`) or from `gh release list`.

| Question | Answer | Source |
|---|---|---|
| What it is | "a direct port of Microsoft's native TypeScript compiler, which is written in Go … It keeps Go's algorithms and behavior and has the same command line (`tsc`), language server and API." | README, "What actually is this?" |
| What it isn't | Not a TS-to-Rust translator, not a bundler, not a runtime. Emit is TypeScript's emit (TS → JS, d.ts), compared byte for byte with Go. | README, Conformance table ("emit 13,654 of 13,654") |
| Pin | microsoft/TypeScript `3e9236361fa9`, which is `typescript@7.1.0-beta`. `--version` prints 7.1.0. | README, Status |
| Conformance | The README reports that 13,728 of 13,728 corpus configurations match, and that all 186,890 tests pass. | README, Conformance |
| Speed | The README reports about half of Go's check time (geometric mean over 60 projects), 2.10× `tsc` 7 on six apps, and a `--fast` mode with one checker per core. | README, Status and benchmarks |
| Maturity | Created 2026-10-07. Eight releases from 0.1.0 (10-07) to 0.8.0 (10-21). Last push 10-28. "This is an early release." Most of the code is LLM-written. | `gh repo view`, `gh release list`, README |
| License | MIT. The npm package says `MIT AND Apache-2.0` and keeps TypeScript's Apache-2.0 notice and Go's BSD-3-Clause notice. | README, License; `package.json` of `tsc-rs@0.8.0` |
| Platforms | Linux x64/arm64, macOS arm64/x64, Windows x64/arm64. 0.8.0 ships `tsc-rs-win32-x64`. | README, Install; release assets |
| JS API | The **TypeScript 7** API (`typescript/sync`, `typescript/async`), through `@tsc-rs/typescript` installed as `typescript`. It does not provide the TypeScript 5/6 compiler API. | `npm/typescript-readme.md` |
| Editor | The TS 7 VS Code extension can run its language server. | `npm/typescript-readme.md`, VS Code |
| WASM | `ts-rust-wasm` type-checks and emits in Node, Deno, Bun and browsers. "Nothing here publishes": you build it yourself. | `npm/wasm/README.md` |
| DOM, Node APIs, async, workers, npm interop | Not applicable at run time, since it never runs our code. For checking, it reads the same `lib.dom.d.ts` and `@types/node` as `tsc` 7 and resolves modules the way `tsc` 7 does. | follows from the above |
| Known problems | monorepo `rootDir` output, `tsc -b` timing between projects without references, and slow memory growth in the editor. None of them applies to us: we have no `-b` and no workspaces. | README, Known problems |

## What Lime Slice relies on (the TypeScript side)

| Area | Size | What it uses |
|---|---|---|
| `src/` (Tauri 2 webview UI) | 751 `.ts` files, 192k lines | three.js 0.180 with addons (OrbitControls, Line2, ViewHelper, BufferGeometryUtils), lucide, @floating-ui/dom, fflate, `@tauri-apps/api`. DOM. 10 Web Workers via `new Worker(new URL(…, import.meta.url))` (auto-ribs, motion, pose, model check …). 95 dynamic `import()` for the lazy workspaces. Side-effect `.css` imports. No WASM. |
| `mcp/` (Node MCP server) | 254 files, 58k lines | `node --experimental-strip-types`; `node:fs`, `path`, `os`, `url`, `crypto`, `child_process`, `zlib`, `http`, `worker_threads` (`engine-worker.ts`), `SharedArrayBuffer`/`Atomics`. The engine is a Node-API addon loaded with `process.dlopen(mod, path)` (`mcp/engine.ts:232`). esbuild bundles it to `server.mjs` for the installer (`tools/mcp/bundle.mjs`). @modelcontextprotocol/sdk. |
| `e2e/` | 254 Playwright specs | `@playwright/test`, headless Chromium |
| `tools/` | `.mjs` CI scripts, `run-unit.mjs` (332 unit files, one Node process each), shell and Python | Node built-ins |
| Config | `tsconfig.json` (`moduleResolution: bundler`, `allowImportingTsExtensions`, `isolatedModules`, `strict`, `noEmit`), `mcp/tsconfig.json`, `tsconfig.lint.json` | ESLint 9 + typescript-eslint 8 with three type-aware rules |

These are the language features in use, counted as lines in `src` / `mcp`:

- discriminated unions on `kind: "…"`: 1,943 / 1,009;
- typed arrays: 1,117 / 259;
- `as const`: 447 / 88;
- top-level or statement `await`: 76 / 1,860, mostly in the MCP tests;
- `structuredClone`: 88 / 101;
- `import.meta`: 42 / 154;
- `keyof`: 42 / 6;
- `infer`: 45 / 0;
- `satisfies`: 11 / 1.

There are no decorators, no `enum`s and no `namespace`s, so the code already suits type stripping. Every one of these features is ordinary TypeScript 7, and ts-rust checks them the same way.

## Gap table

Two different things can fail when a project moves onto ts-rust. Some gaps come from TypeScript 7 itself, so `typescript@7` from Microsoft has them too. Others are specific to ts-rust. The first kind was found by running all three TS 7 checkers on `main`. All three reported exactly the same error codes and counts.

| Dependency | Status | What happens and the workaround |
|---|---|---|
| Type checking `src` and `mcp` | Supported after 4 changes | With today's tsconfigs, TS 7 reports 215 errors on `-p .` and 1 on `-p mcp`. These are TS 5 → 7 default changes, not ts-rust bugs. See the next three rows. |
| `@types/node` in `src/**/*.test.ts` | Workaround | TS 7 no longer loads every `@types/*` package: `types` defaults to `[]`. That caused 166 TS2591 and 13 TS2305 errors, plus knock-on TS2345, TS7006 and TS18048. Fix: add `"types": ["node"]` to `tsconfig.json`, or give the unit tests their own tsconfig so that `src` keeps `lib: DOM` without Node globals (better). |
| Side-effect `import "./x.css"` | Workaround | `noUncheckedSideEffectImports` defaults to on, which gave 15 TS2882 in `src` and 1 in `mcp`. Fix: a `src/vite-env.d.ts` with `declare module "*.css";`, or set the option to `false`. |
| `HTMLElement.hidden` | Two one-line source fixes | The TS 7 `lib.dom` types it as `boolean \| "until-found"`. `src/context-bar-ui.ts:77` and `src/app/sketch/feature-strip.ts:183` return it as `boolean`. Fix: `node.hidden === true`. |
| typescript-eslint (`npm run lint`, CI's ESLint step) | Blocking for ts-rust and for TS 7 | The type-aware rules use the TS 5/6 compiler API. typescript-eslint 8.73.0 has the peer `typescript >=4.8.4 <6.1.0`, and ts-rust ships only the TS 7 API. Workaround: keep `typescript@5.9` as the package that ESLint loads, and run the TS 7 checker under its own name (`tsc-rs`, or `@typescript/native-preview`). Don't use the `npm:@tsc-rs/typescript` alias, because it replaces the `typescript` package that ESLint needs. |
| Vite build (TS → JS) | Not applicable | Vite strips types with esbuild (Rolldown/Oxc in Vite 8) and never calls `tsc`. ts-rust can neither help nor block it. |
| `node --experimental-strip-types` (MCP server, unit tests) | Not applicable | Node strips the types itself, so ts-rust has no role in running them. |
| `process.dlopen` engine, Node built-ins, workers, `SharedArrayBuffer`, DOM, WebGL, three.js | Not applicable at run time | These only have to type-check, and they do: `lib.dom` and `@types/node` are read the same way. |
| esbuild MCP bundle | Not applicable | esbuild does it. |
| Editor (VS Code) | Optional | Either the TS 7 extension with ts-rust as `tsdk`, or Microsoft's TS 7. Not needed for a CI change. |
| ts-rust WASM | Not useful here | Its only use for us would be a type checker inside the app (for example, checking plugins). Lime's plugins are lust, not TypeScript. |

Nothing that Lime Slice relies on blocks ts-rust as a type checker except ESLint, and keeping 5.9 for ESLint works around it. The same is true of Microsoft's TypeScript 7.

## Measurements

The machine has 24 logical cores and 63 GB of RAM, and runs Windows 11, Node 24.16.0 and cargo 1.88.0 with `CARGO_BUILD_JOBS=4`. Rust used a fresh target directory and `OCCT_ROOT=D:\occt-7.9.2`. Unless a row says otherwise, each figure is the median of 5 runs after a warmup. For the TS 7 rows, the proof of concept was a scratch `tsconfig` that extends the real one with `"types": ["node"], "noUncheckedSideEffectImports": false`. It was deleted afterwards. The two `hidden` errors stayed in, so these runs still report 2 diagnostics.

### TypeScript: before and after (the proof of concept)

| Command | `src` (`-p .`) | `mcp` (`-p mcp`) |
|---|---:|---:|
| `tsc` 5.9.3 (today) | **6,730 ms** | **5,513 ms** |
| `tsc` 5.9.3 `-p tsconfig.lint.json` (all folders, what ESLint loads) | 11,254 ms | |
| `typescript@7.0.2` (Microsoft, via its Node shim) | 933 ms | 776 ms |
| `typescript@7.0.2` native `tsc.exe` | 796 ms | |
| `tsc-rs` 0.8.0 (via its Node shim) | 609 ms | 494 ms |
| `tsc-rs` 0.8.0 native `tsc.exe` | 505 ms | |
| `tsc-rs` 0.8.0 `--fast` | 448 ms | 360 ms |

`tsc` 5.9 `--extendedDiagnostics` on `src` reads 1,217 files and spends 0.75 s parsing, 0.37 s binding and 4.71 s checking, using 954 MB.

### Frontend, bundle, lint and MCP

| What | Today | Note |
|---|---:|---|
| `npm run build` (`tsc --noEmit && vite build`) | 13.8 s | single run |
| `vite build` (Vite 6.4.3, esbuild + Rollup) | 7.5 s | |
| `vite build` with Vite 8.3.8 (Rolldown), same `vite.config.ts`, scratch output | **1.1 s** | all JS 3.80 MB vs 3.86 MB; first chunk 1,442,132 B (431 kB gzip) vs 1,443,413 B (418 kB gzip). Not run against e2e. |
| First chunk (`tools/ci/bundle-budget.mjs`) | 1,443,413 B, 418 kB gzip | +2.39 % over the stored budget (limit +5 %). `model-workspace` is 1.12 MB lazy, `dist/` is 8.7 MB (4.0 MB assets, the rest is `samples/`) |
| `npx eslint` (type-aware) | 24.2 s | single run, the slowest TS step |
| MCP server start to `initialize` reply, `node --experimental-strip-types mcp/server.ts` | **417 ms** | median of 7, debug engine |
| Same, esbuild bundle `server.mjs` (`tools/mcp/bundle.mjs`) | **82 ms** | `tools/list` answers 1 ms later in both |
| Bare `node --experimental-strip-types -e ""` | 48 ms | |
| 40 `src` unit tests, serial (as `tools/run-unit.mjs` runs them) | 23.5 s | |
| Same 40, 8 at a time | 13.0 s | 1.8× faster; a few long tests set the floor |

### Rust

| Build | Time |
|---|---:|
| Cold debug, `-p lime-mcp-engine -p lime-model-occt -p lime-slice-desktop` | **158 s** wall (552 s summed over 601 units) |
| No-op rebuild | 0.7 s |
| Debug, after an edit in `lime-slice-core`, `-p lime-mcp-engine` | 54 s |
| Debug, after an edit in `lime-sim`, `-p lime-mcp-engine` | 5.9 s |
| Debug, after an edit in `src-tauri`, `-p lime-slice-desktop` | 12.2 s |
| Switching between `-p lime-mcp-engine` and `-p lime-mcp-engine -p lime-slice-desktop` with nothing changed | 3.7–5.1 s: feature unification differs, so `lime-mcp-engine` is rebuilt every time |
| Cold release `-p lime-mcp-engine` (`lto = "thin"`, `codegen-units = 1`) | **190 s** (455 s summed) |
| Release, after an edit in `lime-slice-core` | **91 s** |

These are the slowest units of the cold debug build, in seconds:

- `windows` 0.61: 25.3;
- `lime-slice-core`: 20.6;
- `faer`: 16.2;
- the `lime-slice-desktop` link: 15.9;
- `naga`: 14.3;
- `clipper2c-sys` build script (C++): 13.8;
- `lime-sim`: 13.3;
- `lime-model-occt`: 12.4, plus 5.8 for its C++ bridge build script;
- `wgpu-core`: 10.9;
- `tauri-utils` (two builds): 10.0 and 8.2.

These are the slowest units of the cold release engine build, in seconds:

- `faer`: 68.6;
- `lime-slice-core`: 51.6;
- `lime-mcp-engine`: 43.1, which is the thin-LTO and single-codegen-unit link of everything;
- `naga`: 28.6;
- `lime-sim`: 23.6;
- `wgpu-core`: 17.7;
- `truck-stepio`: 14.4.

### Where CI time goes

These figures are from main's last full CI run (`45000251089`). It took 20 min of wall time and 172 job-minutes. These are the longest jobs:

| Job | Minutes | Where the time goes |
|---|---:|---|
| MCP server (Windows) | 20.2 | release engine 211 s, unit tests 468 s, recipes with `lust --opt` 303 s |
| Rust tests | 19.5 | `cargo test` 1,044 s |
| Auto ribs against real Open CASCADE | 19.0 | one step, 1,098 s |
| Playwright smoke shard 2/4 | 16.1 | specs 917 s (frontend build 12 s) |
| MCP server against real Open CASCADE | 11.5 | |
| typecheck and frontend build | 6.1 | **Typecheck 12 s**, unit tests 282 s, ESLint 42 s, frontend build 9 s |

The TypeScript compiler costs CI about 12 s plus `tsc -p mcp` (about 10 s) per run. Switching it to TypeScript 7 or to ts-rust would save about 20 s of job time. The critical path would not move at all, because the 20-minute jobs are Rust tests, OCCT studies and the Windows MCP tests.

## What else would make Lime Slice faster and leaner

Ranked by what each change saves on the evidence above. Each one would be its own PR. This study changes none of them.

1. **Vite 8 (Rolldown).** It saves 6.4 s per frontend build. That build runs in at least 5 CI jobs (typecheck, the 4 smoke shards and the release-engine Playwright job) and on every local `npm run build` and `verify-ui`. The bundle comes out the same size (−1.7 % JS; first chunk −0.1 %, +3 % gzip). Rolldown warns about one ineffective dynamic import (`src/ui/model-history.ts`), which Rollup already hit silently. Risks: Vite 6 → 8 changes plugin hooks and `build.rollupOptions` becomes `rolldownOptions`, though the two plugins here use only `configureServer`, `writeBundle` and `generateBundle`. Gate it on the full smoke suite.
2. **Run the MCP server from its bundle, and the unit tests in parallel.** The bundled `server.mjs` starts 5× faster (82 vs 417 ms). Node spends the difference resolving and stripping about 250 modules. The installed app already runs the bundle; dev clients and the tests that spawn `server.ts` pay the 417 ms each time. `tools/run-unit.mjs` runs 332 files one after another, and the 282 s and 468 s unit steps are the biggest share of the typecheck job and of the Windows MCP job. Running them in a small pool (for example, 4–8 at a time with output buffered per file) was 1.8× faster here on a sample. Tests that share a port or a temp folder have to be found first, and none can be loosened.
3. **The Rust release profile.** `codegen-units = 1` with thin LTO makes `faer` take 69 s and the engine link 43 s. A release edit in `lime-slice-core` costs 91 s. Options, in order of safety:
   - give heavy dependencies their own `[profile.release.package.faer] codegen-units = 16` (and the same for `naga`, `wgpu-core`);
   - add a `ci` profile that inherits `release` but drops LTO, for the jobs that test the engine rather than ship it (MCP server, real OCCT, bench smoke);
   - keep `release` exactly as it is for the installers.

   Check any change against the golden runs, since codegen units can move float results in vectorised code.
4. **Rust tests (17 min) and the OCCT studies (18 min).** These set the CI wall time. `cargo nextest` runs test binaries in parallel per test and reports slow ones. The auto-ribs OCCT step is a single 18-minute step and would gain most from a split into parallel jobs. Both need their own study; this one did not profile them.
5. **Cargo feature unification.** Building `-p lime-mcp-engine` alone and with `-p lime-slice-desktop` rebuilds the engine each time (4–5 s in debug; in release it would repeat the 43 s LTO step). Always building the same package set locally avoids it. Cargo's `resolver.feature-unification = "workspace"` would fix it for good, but it is not stable on the pinned 1.88.
6. **sccache.** It is not installed here. It helps CI more than local builds, because `Swatinem/rust-cache` already restores `target/`. It cannot cache the incremental crates or the link, which is where the local time goes. Low priority.
7. **Linker.** mold does not target Windows. On Windows the option is `lld-link` (`-C link-arg=-fuse-ld=lld` or `linker = "rust-lld"`), which would cut the 16 s `lime-slice-desktop` link and the debug relinks. On the Linux CI jobs, mold or the default `rust-lld` of newer toolchains would do the same. That needs a toolchain bump past 1.88 to get `rust-lld` by default. Measure it before adopting it.
8. **Per-crate split.** `lime-slice-core` (74k lines) is the crate every engine edit goes through: 21 s in debug and 52 s in release, plus everything downstream. Splitting out its leaf modules (G-code writer, infill patterns, support trees) would make edits cheaper, but it is a large refactor. Do it only if one area changes far more often than the rest. `lime-model-occt` (40k Rust and 15k C++ lines) already stands apart, and its C++ bridge rebuilds only when it changes.
9. **TypeScript 7 for the typecheck.** It cuts the TS check from 6.7 + 5.5 s to 0.9 + 0.8 s locally (about 20 s of CI job time), with the four migration items in the gap table. Use Microsoft's `typescript@7` or `@typescript/native-preview` under its own bin name. ts-rust would save another 0.3 s per run, which isn't worth an early-release dependency yet. ESLint stays on 5.9, and its 24 s (42 s in CI) is the bigger TS cost: typescript-eslint has to support TS 7 before that improves.
10. **The bundle.** The first chunk is 1.44 MB (418 kB gzip), 2.4 % over its stored budget. `npm run build:analyze` shows what is in it. Startup in the Tauri webview reads from disk, so the gain is parse time rather than download time. Moving more code into lazy chunks is worth it only once a profile of the first paint shows the parse is what's slow.

## Reproduce

- ts-rust: `npm i tsc-rs@0.8.0` in a scratch folder, then `node <that>/node_modules/tsc-rs/bin/tsc-rs --noEmit -p <tsconfig>`.
- TS 7: `npm i typescript@7.0.2` in another scratch folder.
- Vite 8: `npm i vite@8.3.8` in a scratch folder, then `node <that>/node_modules/vite/bin/vite.js build --outDir <scratch>` from the checkout.
- MCP start: spawn the server, send `initialize` and `tools/list` as newline-delimited JSON, and time the replies, with `LIME_MCP_ENGINE` pointing at a debug `lime_mcp_engine.dll`.
- Rust: `cargo build … --timings` with a fresh `CARGO_TARGET_DIR`. The per-unit tables come from that report's `UNIT_DATA`.
