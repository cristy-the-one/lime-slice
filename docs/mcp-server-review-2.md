# Review, round 2: the MCP server on `feature/mcp-server`

Reviewed head: `664e481` (14 commits ahead of `main`, merge base `933869d`). Round 1 is `docs/mcp-server-review.md`. This report adds findings `R2-F-n` (functional) and `R2-U-n` (usability), a verification row for each of the 37 round-1 findings, a feature-parity plan, and a ranked fix plan. The reviewer changed no code on the branch. Scratch scripts lived in `/tmp/r2` and are not committed.

The sections below are the review as written. The resolution table is the follow-up on `feature/mcp-server` after that review.

## Resolution

| Finding | Resolution | Commit |
|---|---|---|
| R2-F-1 | Fixed. Commit and STEP export read `bytesBase64` and `byteLength`. The stand-in returns that shape, and a contract test checks every call. | `5057733` |
| R2-F-2 | Fixed. A second commit of the same node does not export again, and plate scale resets only when a Model scale is new. | `5057733` |
| R2-F-3 | Fixed. The stale stamp includes the mesh hash, the tree node, the layer actions, and the session generation. Export, summary, and the latest-slice resource check it. | `5057733` |
| R2-F-4 | Fixed. A version 2 save writes the committed mesh and the history. Opening it loads that tree. | `5057733` |
| R2-F-5 | Partly fixed. The slice body sends overrides, paint, support edits, reinforcement, per-object settings, and print order, and a test deep-equals that body to the app's builder. A real-engine slice of an opened project was not run on this machine. | `7eda1be`, `a7aa4f8` |
| R2-F-6 | Fixed. A missing addon answers `session_info` with no engine and refuses a mesh with the build hint. It does not hang. | `5057733` |
| R2-F-7 | Fixed. A tilted plane outside the part is refused. A tilted plane through the part uses the true normal. | `5057733` |
| R2-F-8 | Fixed on the stand-in. The modeler runs on its own worker with a time budget and respawns after a hang. A multi-edge fillet probes with a preview. The slow-op case on real Open CASCADE was not run here. | `5057733` |
| R2-F-9 | Fixed. Plate undo does not keep the Model tree. Undo after remove reopens the solid. The desktop's own history is not a second undo stack. | `5057733` |
| R2-F-10 | Fixed. Place snapshots share the mesh buffer. Forty places of a 2 MB mesh stay under 20 MB of buffer growth. | `5057733` |
| R2-F-11 | Fixed. A boolean that misses the part is refused. One that touches a face is accepted. | `5057733` |
| R2-F-12 | Partly fixed. Progress stays at or under five notes a second. A ping during a 100 MB import was not measured. | `5057733` |
| R2-F-13 | Partly fixed. Only the latest slice keeps layer paths. A 30-slice dragon soak and the idle-memory bound were not re-run. | `5057733` |
| R2-F-14 | Fixed. An edge centre is the middle of its span. A 10 mm cube has 12 distinct centres. | `5057733` |
| R2-F-15 | Fixed. `layer_summary` and `lime://slice/latest` use the same stale stamp as export. | `5057733` |
| R2-F-16 | Fixed. Face measure calls the modeler's distance, not centre to centre. The stand-in answers that call. Real Open CASCADE distance was not re-run. | `5057733` |
| R2-F-17 | Fixed. A profile with layer height 0.9 is refused with "Layer height must be from 0.08–0.4 mm." | `5057733` |
| R2-F-18 | Fixed. A custom `M104` line is listed under `custom`, including when the code is otherwise known. | `5057733` |
| R2-F-19 | Partly fixed. Every plate change carries a sequence and the full plate. A skipped sequence returns "The MCP session changed the plate; reload from it?". Undo, remove, and print-up match `plate_list` in the headless mirror. The Tauri listener was not run. | `117bb1f` |
| R2-F-20 | Fixed. The echo shows `counterboreDiameterMm` under `typed`. | `5057733` |
| R2-F-21 | Fixed. The schema maximum is 0.4, and the schema test asserts it. | `5057733` |
| R2-F-22 | Partly fixed. `mcp/occt.test.ts` is in the `rust` job and uses `CARGO_BUILD_JOBS=2`. Open CASCADE is not installed on this machine, so the test was not run. CI stays idle until Marius opens the pull request. | `5057733` |
| R2-U-1 | Fixed. Face rows include centre, bounds, and kind. The upper face of a step is the one with the greatest centre Z. | `9b5e4cd` |
| R2-U-2 | Partly fixed. Guides and prompts carry the call sequences. The tool list is under 51 KB. Not every description names the previous and next tool; the long text is on `lime://guide/*`. | `9b5e4cd` |
| R2-U-3 | Fixed. `isError` is for protocol errors. A domain refusal is `{ok:false, reason}`. | `9b5e4cd` |
| R2-U-4 | Fixed. A split keeps both halves, and the reply names them. | `7eda1be` |

Round-1 rows the review left open:

| Round 1 | Resolution |
|---|---|
| F-3 commit reaches the plate | Fixed with R2-F-1, R2-F-2, and R2-F-4 (`5057733`). The real-engine time and weight were not re-measured here. |
| F-4 lossless save | Fixed with R2-F-4 (`5057733`). |
| F-6 split check | Fixed with R2-F-7 (`5057733`). |
| F-13 bridge | Partly fixed with R2-F-19 (`117bb1f`). The window was not opened. |
| F-15 stale export | Fixed with R2-F-3 (`5057733`). |
| F-20 blocking and progress | Partly fixed with R2-F-12. The 100 MB ping was not measured. |
| F-21 memory | Partly fixed with R2-F-13. The soak was not re-run. |
| F-23 app custom G-code | Still not verified. The desktop window was not opened. The app's layer-action test still passes. |
| F-24 Windows addon | Still not verified. The Windows job runs when the pull request into `main` is opened. |
| F-27 tests prove claims | Partly fixed. The stand-in matches the real reply shape, and `mcp/occt.test.ts` is in the `rust` job. That job has not run. |
| U-8 setup docs | Partly fixed. The missing-addon path is R2-F-6. A fresh `tools/occt/install.py` checkout was not run. |

### Part B batches

| Batch | Resolution | Commit |
|---|---|---|
| 1 Settings, typed `op`, selectors, guides | Fixed. | `9b5e4cd` |
| 2 Whole-plate slice, arrange, shells, profiles, workplane, bed | Fixed. The plate body is deep-equaled to the app's builder. | `7eda1be` |
| 3 Paint, seams, reinforcement, support edits, layer files, G-code read, calibration, Pareto | Fixed against the stand-in, with the limits below. | `a7aa4f8` |
| 4 Live bridge | Partly fixed. See R2-F-19. | `117bb1f` |

### What this machine did not prove

- `mcp/occt.test.ts` against real Open CASCADE. The job is wired. Open CASCADE is not installed here, and the pull request was not opened, so CI did not run.
- A real slicer pass for paint (the unhit tally, and a blocker removing trees), for Pareto, and for the layer paths of a sliced cube. The stand-in returns those shapes. Disk coverage within 10% of a hand brush is `src/paint-region.test.ts` on `samples/overhang_ledge.stl`. The session paints the preview mesh, which is what the slice body sends.
- The Tauri `lime-bridge` listener. `mirrorPlate` applies undo, remove, print-up, and a commit whose STEP carries the stand-in mesh mark. A real STEP file has no mark, so the headless mirror asks to reload rather than invent a mesh. The webview does not read the STEP file; `bridge-mount.ts` asks to reload when a commit arrives. That listener was not started.
- The slicer crates were not edited. After this follow-up, `tools/golden_ab.sh` against `origin/main` (`933869d`) was 48 same, 0 different, and `LIME_MCP_GOLDEN=1` matched the CLI on all six configs.

The capability inventory in section 4.1 is the reviewer's reading of `664e481`. Batches 1 to 4 above are the state after the follow-up.

## 1. Summary and verdict

**Verdict: not ready for Marius.** The stand-in tests are green and most round-1 fixes hold, but the first run against real Open CASCADE found a blocker that the stand-in engine hides.

- **Blocker (R2-F-1).** `model_commit` and `model_export_step` read `reply.step`, while the real modeler answers `export` with `bytesBase64`. With real Open CASCADE, one Model call on a STEP part (even `model_describe`) makes `slice_start`, `project_save`, `export_3mf`, `render_view`, `model_commit`, and `model_export_step` fail for the whole plate. The reply is "The solid was not exported." A `solid_new` part can never be sliced. CI cannot catch this: no job runs the MCP against the real bridge, and no CI run exists on this branch.
- **Ten high findings.** The most serious:
  - A Prepare scale is silently reset to 100 % after a Model scale.
  - The stale-slice stamp misses Model edits and project changes, so `gcode_export` can write the wrong part's G-code with `ok: true`.
  - Saving a version 2 project after a commit keeps the old mesh.
  - An opened project's overrides, paint, and support edits are dropped from the slice without a note. The same `.lime` gives 264 s in the MCP and 4518 s with the override the app sends.
  - A missing addon now hangs every engine call.
  - The tilted-split check passes a plane outside the part.
  - An impossible fillet passes the probe, then wedges the single engine worker at 5 GB.
  - Plate undo and the Model tree disagree.
  - Plate undo costs about 164 MB per step on a 100 MB mesh.
- **What holds.**
  - The six golden configs are byte-identical through the addon.
  - The stdio framing works, and cancelling a wait returns in 1.0 s.
  - A 200-slice soak keeps threads flat at 17 and RSS at 141–187 MB.
  - Real Open CASCADE refuses an oversized fillet ("largest that fits is 9.97 mm") and an oversized chamfer (4.92 mm).
  - Holes, counterbores, joins, edit replay, and history undo and redo give the right volumes.
  - 17 of 18 reverted round-1 fixes are caught by their tests. The 18th, F-18, is caught once its three overlapping guards are all removed.
- **Feature parity is far from "anything the app can do".**
  - Missing entirely: paint (supports, seams, reinforcement), support-tree edits, height ranges and modifier volumes, per-object settings, layer actions, the whole-plate slice, print order, calibration, Pareto, layer polylines and images, machine editing, the extra primitives, and the Bed and typed workplane.
  - About 70 preset keys can be set only through a profile file.

Part A counts: 1 blocker, 10 high, 6 medium, 9 low (26 findings). Round 1: 26 verified, 7 reopened, 4 not verifiable here.

## 2. Method and what ran

Environment: Linux x86-64, 4 cores, 15 GB RAM, Node 22.14. Builds used `CARGO_BUILD_JOBS=2`, LTO off, and 16 codegen units to keep memory under about 6 GB.

| What | How | Result |
|---|---|---|
| Stand-in suite | every `mcp/*.test.ts`, `npm run test:unit`, `npx tsc --noEmit`, `npx tsc -p mcp` | all pass |
| Golden | `LIME_MCP_GOLDEN=1 mcp/golden.test.ts` on the built addon | 6 configs byte-identical |
| `tools/golden_ab.sh` | not run | The branch changes no slicer crate: compared with `933869d`, only `crates/lime-mcp-engine`, `src-tauri/src/{bridge,lib}.rs`, `Cargo.toml`, and `Cargo.lock` change. The slicer binary is therefore unchanged by construction. |
| Real Open CASCADE 7.9.2 | Libraries from the v1.8.0 `.deb` release asset. Headers from the pinned V7_9_2 tarball, whose sha256 matches `tools/occt/install.py`. The branch's `lime-model-occt` was built against them and loaded with `LIME_OCCT_BRIDGE`. | `session_info` reports `occt: true`. All Model scenarios below ran on it. |
| Mutation check | `/tmp/r2/mutate.py` copied `mcp/`, `src/`, and `samples/` aside, reverted one round-1 fix at a time, and ran the matching test. | 17 of 18 caught. F-18 is caught only with all three guards removed (see the table). |
| Stress | 50 MB (1 M triangles) and 100 MB (2 M triangles) torus STLs, the dragon sample, a raw stdio client measuring ping latency, RSS, and thread count | numbers in R2-F-12 and R2-F-13 |
| Soak | 200 cube slices in one process | RSS 141–187 MB, threads flat at 17 |
| Not run | the desktop window and live bridge (no GTK/WebKit here; building Tauri plus OCCT is a separate heavy build), Windows and macOS (no runner; no CI run on this branch), and a fresh `tools/occt/install.py` build of OCCT | see the verification table |

A review-only shim (`/tmp/r2/shim.ts`) copied `bytesBase64` into `step` on export replies. It let the commit, slice, save, and reopen scenarios run past R2-F-1. Results marked "with the shim" depend on it.

## 3. Part A: findings

### R2-F-1 — blocker — commit and STEP export read a field the real modeler does not send

**Evidence.**
- `mcp/session.ts:1691` (`commitObject`) and `:1723` (`exportStep`) read `reply.step ?? reply.data`.
- The real bridge answers `export` with `{bytesBase64, byteLength}`. See `crates/lime-model-occt/src/tree.rs` and the app at `src/app/model.ts:2175`.
- The stand-in answers `{ok, step}` (`mcp/engine.ts:323`), so every stand-in test passes.

On real OCCT, with `samples/step_cube.step`:

```text
slice before any Model call: done
model_describe: ok
slice_start:        {"ok":false,"reason":"The solid was not exported."}
project_save:       same
export_3mf:         same
render_view:        same
model_commit:       same
model_export_step:  same
solid_new, then slice_start: same
```

`commitAll` walks every object. One touched STEP part therefore blocks slicing and saving for the whole plate, and a `solid_new` part can never be sliced.

**Fix.**
- Decode `bytesBase64` with `base64ToBytes`, as the app does, and keep `obj.bytes` as those bytes. Do not re-encode them as text.
- Make the stand-in answer the real shape (`bytesBase64`, `byteLength`), so the stand-in cannot drift from the bridge again.
- Add a contract test that runs one request of each `call` (open, probe, apply, edit, goto, export, close) through the stand-in and checks the reply keys against a fixture recorded from the real bridge.

**Acceptance.**
- On real OCCT: import `step_cube.step`, then describe, hole, commit, slice, 3MF, save, and reopen all return `ok: true`.
- The reopened volume is 874.34 mm³.
- The stand-in contract test fails if `export` loses `bytesBase64`.

### R2-F-2 — high — a Prepare scale after a Model scale is reset at the next slice or save

**Evidence.**
- `commitObject` runs on every `slice_start`, `project_save`, `export_3mf`, and `render_view` through `commitAll`, even when `tree.committed === tree.current`.
- Each run ends with `if (this.pathHasScale(tree)) obj.scale = 1` (`session.ts:1699`).
- With the shim: Model scale 2, commit, then `object_place scalePercent: 50`. The next `slice_start` sliced the part at 20 mm, with scale back to 100 %.

The repeated commit also re-exports and re-tessellates the STEP on every slice.

**Fix.**
- Return early from `commitObject` when `tree.committed === tree.current` and `obj.bytes` already holds that node.
- Reset the scale only on the commit that moves `committed` across a scale node.

**Acceptance.**
- Model scale 2, commit, Prepare 50 %, slice: the part is 20 mm × 0.5 per side, and `plate_list` still says 50 %.
- A second `slice_start` sends no `export` call; count the calls on the stand-in.

### R2-F-3 — high — the stale-slice stamp misses Model edits and project identity, so export writes the wrong G-code

**Evidence.** `sliceStamp(obj)` covers settings, machine, and placement, but not the mesh hash, the tree's current node, the layer actions, or which project is open.
- (a) On the stand-in, slice, then `model_apply` a hole and `model_commit`, then `gcode_export`: the file is the pre-hole G-code, and the reply is `ok: true`.
- (b) Open `a.lime` (cube, ids `part` and `other`), slice, then open `b.lime` (dragon, same ids) and `gcode_export`. The file has 100 `;LAYER:` lines, which is the cube, under the dragon project.

**Fix.**
- Add to the stamp: `fnv1aHex(obj.bytes)`, `tree?.current`, `tree?.committed`, a hash of `this.actions`, and a session generation counter that increments on `project_open` and `project_create`.
- Apply the same check in `gcodeSummary`, `layer_summary`, and `lime://slice/latest` (see R2-F-15).

**Acceptance.**
- After a commit, `gcode_export` refuses with the stale-slice sentence.
- After `project_open` of a project with matching ids, `gcode_export`, `gcode_summary`, and `layer_summary` all refuse until a new slice.

### R2-F-4 — high — saving a version 2 project after a commit keeps the old mesh; an opened project's history is never loaded

**Evidence.** In `projectDocument` (`session.ts:559–574`), objects that came from the opened file are kept as `{...obj, placement}`. Their `mesh` and `modelTree` are the file's, not the session's. With the shim, on a two-object v2 project of `step_cube.step`:

```text
hole applied, committed, session volume 874.34
project_save two-holed.lime -> ok
saved first mesh hash == original hash: true; modelTree in file: false
reopened volume: 1000
```

`ensureTree` (`:1243`) always opens a fresh tree from the mesh bytes, so an opened project's `modelTree` is never read, and `model_history` shows only the root. The version 1 path (`:576–581`) does replace the mesh.

`docs/mcp-server.md` says "A committed edit replaces the plate mesh, so … the saved `.lime` see[s] it" and "A save keeps model history". Both statements are inaccurate today.

**Fix.**
- In the v2 branch, rebuild each kept object's `mesh` from `obj.bytes` when its hash differs, as the v1 branch does.
- Write `modelTree` from the session tree. Reuse the app's writer in `src/project.ts`, which the app's `project-io` calls.
- When opening, seed `obj.tree` from the file's `modelTree`. Use `wholeTreeRequest` from `src/model-request.ts`, as the app does on restore.
- Until that is done, `project_open` should say "Model history in this file is not loaded; edits start from the saved shape", and `lossy()` should name "model history" when the session edited a part that had a saved tree.

**Acceptance.**
- v2 open, hole, commit, save, reopen gives volume 874.34, and `model_history` lists the hole.
- Saving over the source after an edit either keeps both the tree and the mesh, or refuses with a reason.

### R2-F-5 — high — an opened project's overrides, paint, support edits, reinforcement, per-object settings, and print order are not sliced, and nothing says so

**Evidence.** `sessionSliceRequest` (`mcp/request.ts:93–119`) always sends `plate: {}`, `order: {}`, and `overrides: emptyOverrides()`. It sends no `supportPaint`, `seamPaint`, `reinforcement`, or `supportEdits`. `project_open` keeps those fields only for saving.

On the 20 mm cube, a v1 project with one height range (z 0–20, infill 1.0, walls 6, speed 20):

| Slice | Seconds | Grams |
|---|---|---|
| MCP, project without the range | 264.0 | 2.41 |
| MCP, project with the range | 264.0 | 2.41 |
| Same cube with the `heightRanges` the app sends (injected into the engine body) | 4518.3 | 9.94 |

Neither `project_open` nor `slice_wait` mentions the difference. This breaks "numeric parity with the UI" for any real project.

**Fix.** Build the slice body the way `payload()` does (`src/app/slice-run.ts:165–219`):
- `sliceOverrideFields(project.overrides)`.
- For the one-object case, `editRequestFields`, `paintRequestFields`, `seamRequestFields`, and `reinforcementRequestFields`, each with `sourceFrame(source, scale)`.
- `slicePlateFields` plus `orderFields` when the object carries settings or the plate is listed.

Until each field is wired, `project_open` and `slice_start` must return `notSliced: ["height ranges", "support paint", …]` with the sentence "This project has … that this server does not slice yet. The G-code will differ from the app's."

**Acceptance.**
- Through the MCP, the override project gives 4518 s and 9.94 g, within the app's rounding.
- A project with support paint gives the same `supportPaint` tally in the reply as the app.
- Anything still unsupported is listed in `notSliced`.

### R2-F-6 — high — with the addon missing, every engine call hangs (regression)

**Evidence.** In a scratch copy without `target/`, `initialize` and `ping` answer, but `session_info` and `mesh_import` never answer.
- Round 1's server (`1e4f1d1`) loaded the addon in-process and threw "The in-process engine was not found. Build it with cargo build -p lime-mcp-engine --release."
- Since `2c956be` (the F-20 fix), `mcp/engine-worker.ts` calls `loadNativeEngine` at module load and throws. The parent's `worker.on("error", fail)` (`mcp/engine.ts:100`) rejects only the calls pending at that moment.
- Every later call is posted to a dead worker and waits forever.

**Fix.**
- In `loadEngineWorker`, keep the load error, and listen for `exit` as well as `error`.
- After either, reject every pending and future call at once with that error's text (the build hint above).
- `session_info` should still answer, with `engine: null` and the reason.

**Acceptance.**
- In a copy without `target/`, `session_info` answers within 1 s with the reason.
- `mesh_import` returns `isError: true` with the build hint.
- `native-load.test.ts` gains this case, using an empty `LIME_MCP_ENGINE` path or a renamed addon.

### R2-F-7 — high — reopens F-6: a tilted split plane outside the part passes the check

**Evidence.** On real OCCT with the 10 mm cube:
- Origin `(20,20,20)` with normal `(1,1,1)` probes `ok: true`, "From -10 to 20 mm".
- Axis-aligned planes are judged correctly. Slight tilts near the part are also correct.

In `splitCheck` (`session.ts:1434–1463`), `along` is measured on the nearest world axis (`base.dir`), while `range` comes from the extent along the true normal. For a large tilt the two measures differ.

**Fix.**
- Use `const d = dot(op.origin, normal)` and require `extent.min + ε < d < extent.max − ε`, using `extentAlong(positions, normal)`, which is already computed.
- Report the range in the same measure.

**Acceptance.**
- On the 10 mm cube, `(20,20,20)/(1,1,1)` is refused.
- `(5,5,5)/(1,1,1)` is accepted, and its range is 0 to 17.32 mm along the normal.
- A model test covers both planes on the stand-in, and the real-OCCT test in R2-F-22 covers them too.

### R2-F-8 — high — an impossible fillet passes the probe, and the apply wedges the engine with no time or memory limit

**Evidence.** On real OCCT with the 10 mm cube, fillet r6 on all 12 edges:
- `model_probe` answers "fits" in 141 ms. It sends no `preview`; the app's probe at `src/app/model.ts:546` does.
- `model_apply` then ran for over 4 minutes at 100 % CPU and reached about 5 GB. The reviewer killed it.
- The same probe with `preview: true, chordMm: 0.05`, as the app sends it, did not return in 90 s and reached 1.8 GB.

The OCCT stall itself predates this branch: neither the app nor the bridge has a time budget. But the MCP runs every engine call on one serial worker, so after this call `slice_start`, `mesh_import`, and every Model call hang until the server is restarted. The probe gate is not a safe feasibility check for blends on many edges.

**Fix (MCP side only; no engine change).**
- Run `modelTree` calls on their own worker, separate from slicing.
- Give each call a wall-clock budget: `LIME_MCP_MODEL_TIMEOUT_S`, default 30. Optionally add an RSS ceiling sampled once per second.
- On timeout, call `worker.terminate()`, start a new worker, mark every open tree lost (`obj.tree = undefined`, keeping `obj.bytes` of the last commit), and return: "This fillet did not finish in 30 s. Nothing changed. Try a smaller size or fewer edges."
- For fillet and chamfer on more than one edge, probe with `preview: true` at the object's chord, as the app does. Treat a timeout as a refusal.

**Acceptance.**
- Fillet r6 on all 12 edges returns a refusal within the budget.
- The next `slice_start` of another object succeeds without a restart.
- A test with a stand-in `modelTree` that never resolves checks the timeout, the respawn, and the "tree lost" message.

### R2-F-9 — high — plate undo and the Model tree disagree

**Evidence.**
- (a) Place, then Model scale 1.5 and apply, then `plate_undo` back over the Place. The snapshot holds the old `tree`, so history went back to the root and the volume back to 1000. The bridge tree was still at the scaled node, and no message said so.
- (b) `object_remove` closes the engine tree (`close`). `plate_undo` then restores an object whose `tree.key` is closed, and the next `model_apply` returns reason "unknown". The same happens after undoing over `project_open`.

**Fix.**
- Leave `tree`, `solid`, and `probes` out of plate snapshots, as the app keeps Model history outside the plate history (`src/app/history.ts`).
- On restore, keep each surviving object's live tree.
- For a revived object, set `tree = undefined` so the next Model call reopens it from `bytes`.

**Acceptance.**
- Place, Model scale, plate undo restores the pose and keeps the Model scale.
- Remove, undo, `model_apply` works.
- A scenario test covers both.

### R2-F-10 — high — plate undo snapshots copy every mesh on every step

**Evidence.** `remember()` uses `structuredClone` on every object's `bytes` and `source`, 32 snapshots deep. With the 100 MB torus (2 M triangles), each `object_place` adds about 164 MB:

| Places | RSS | arrayBuffers |
|---|---|---|
| 0 | 663 MB | — |
| 8 | 1975 MB | 1545 MB |
| 16 | 3288 MB | 2857 MB |
| 32 | 5912 MB | 5482 MB |
| 40 | 6055 MB (stack full) | 5550 MB |

A user who nudges a large part a few dozen times exhausts a 16 GB machine.

**Fix.**
- Snapshot only pose, settings, and object identity.
- Share `bytes` and `source` by reference; they are replaced, never mutated in place, and `commitObject` assigns new arrays.
- Hold removed objects' buffers in the snapshot by reference.

**Acceptance.**
- 40 places of the 100 MB torus stay within 200 MB of the post-import RSS.
- Undo still restores the pose (F-25 test).

### R2-F-11 — medium — a boolean that misses the part passes the probe

**Evidence.** On real OCCT, a 2 mm box at `(300,300,300)` probes "This boolean changes the solid." for both `cut` and `fuse`. The cut is a no-op. The fuse makes a two-body solid that prints as a stray cube 300 mm away, or is refused later by the bed check.

The app has the same gap: `src/model-feasibility.ts` has no overlap test, and the bridge's probe answers `ok`.

**Fix.**
- Add a pure bounding-box overlap test to `src/model-feasibility.ts`, so the app and the MCP share it.
- In the MCP, compare the baked tool's box with `obj.solid.bounds` before the probe.
- Refuse a disjoint `cut` or `common` with "The tool does not touch the part.".
- Refuse a disjoint `fuse` with "This would add a separate body; place it touching the part.".
- Wiring the test into the app is an app change; keep it behind the same refusal text, and run the app's model e2e specs.

**Acceptance.** Both far-away probes are refused. A tool overlapping one face is still accepted.

### R2-F-12 — medium — reopens F-20: the main thread still blocks on large payloads, and progress floods

**Evidence.**

| Ping worst case | Measured during |
|---|---|
| 1.9 s | the 50 MB import |
| 3.8 s | the 100 MB import |
| 4.1 s | `slice_start` of the 100 MB part |

The time goes to base64 and `JSON.stringify` on the main thread before and after the worker call. The stdio test only delays inside the native call, so it does not cover this. Progress arrives at about 50 notifications per second on the 100 MB slice.

**Fix.**
- Do the base64 and JSON work in the worker: pass `Uint8Array` with a transfer list, and build the body there.
- Throttle progress to one notification per 250 ms, or per 1 % step.

**Acceptance.**
- Ping stays under 250 ms during a 100 MB import and slice.
- At most 5 progress notifications per second.
- `stdio.test.ts` gains a case with a large real payload, or a stand-in that spends main-thread time.

### R2-F-13 — medium — reopens F-21 in part: retained jobs keep the full preview wire

**Evidence.**
- 30 dragon slices raise RSS from 246 to 548 MB.
- One large dragon slice leaves 2.9 GB resident while idle.

Eight jobs are kept (`JOB_KEEP`), and each holds the whole reply, including `layers[].paths`. The session also keeps eight. Threads are fixed: the soak above is flat at 17.

**Fix.**
- When a job finishes, keep the summary, the G-code, and a per-layer index (z, seconds), and drop `layers[].paths`.
- Keep one full wire, for the latest job only, if layer tools (Part B) need it.

**Acceptance.**
- 30 dragon slices end within 100 MB of the first.
- An idle server after one large slice is under 1 GB.

### R2-F-14 — medium — an edge `mid` is an endpoint for straight edges

**Evidence.** `midAt = floor(len/6)*3` (`session.ts:119`). For a two-point edge (6 floats) that is index 3, the second endpoint. Every `mid` on the cube is a corner, so an LLM that picks "the vertical edge at x = 10, y = 0" by its `mid` cannot tell vertical from horizontal edges.

**Fix.** Use the midpoint along the polyline by arc length. Add `start`, `end`, and a unit `dir` for straight edges.

**Acceptance.** The cube's 12 edges report 12 distinct `mid` values at edge centres, such as `(10,0,5)`.

### R2-F-15 — low — `layer_summary` and `lime://slice/latest` are not stale-checked

**Evidence.** After `project_open` of another project, both still describe the old slice. `gcode_export` is checked; these two are not.

**Fix.** Use the same stamp check as `gcode_export` (see R2-F-3).

**Acceptance.** Both refuse, or mark `stale: true`, after a change.

### R2-F-16 — low — `measure` between faces is centre to centre

**Evidence.** Opposite faces of the cube give 10, which is correct. Adjacent faces give 7.07, where a user expects 0 or an angle. The description says "Distance … between two faces".

**Fix.** Either call the bridge's `distance` call (`aKind: "face"`), which returns the true minimum distance and is already accepted by `tree.rs`, or describe the result as "distance between face centres" and add `angleDeg` and `parallel`.

**Acceptance.** Adjacent faces give 0, or the description and the field names say "centres".

### R2-F-17 — low — a profile file bypasses the setting ranges

**Evidence.** `settings_apply` checks `layerHeight` only when it is passed directly. A `.limeprofile.json` with `layerHeight: 0.9` is accepted.

**Fix.** Validate the merged settings against `CONTROLS` in `src/ui/settings-schema.ts`, the same ranges the panel uses, and refuse with the field name and range.

**Acceptance.** The 0.9 profile is refused with "Layer height must be from 0.08–0.4 mm."

### R2-F-18 — low — the G-code review hides heater and fan commands from custom lines

**Evidence (by reading).** `mcp/review.ts:3` (`KNOWN`) treats `M104`, `M109`, `M140`, `M190`, and `M106` as known, so a layer action's `M104 S300` is not listed as unusual.

**Fix.** List every line that comes from a layer action or from machine start or end G-code, whatever its code, under `custom`. Flag temperatures above the filament's limit.

**Acceptance.** A project with a `customGcode` action of `M104 S300` shows that line in `gcode_summary`.

### R2-F-19 — low — the bridge mirrors only place and some settings

**Evidence (by reading `mcp/bridge-client.ts`; the desktop was not run).** These are not mirrored: `plate_undo`, `plate_redo`, `object_remove`, `workplane_print_up`, a settings profile's fields other than preset, layer height, and supports, and Model edits. The desktop then diverges without a message.

**Fix.** Mirror every plate change as a full plate snapshot message with a sequence number. The desktop applies it only if its own sequence matches, and otherwise shows "The MCP session changed the plate; reload from it?". This stays a mirror, not a second undo stack.

**Acceptance.** Run manually with the desktop: after undo, remove, and print-up, the desktop matches `plate_list`.

### R2-F-20 — low — the counterbore echo names a radius for a diameter input

**Evidence.** The input is `counterboreDiameterMm: 6`, and the `stored` echo shows `counterboreRadius: 3`. Correct, but the LLM sees two names for one value.

**Fix.** Add `typed`, the input as given, next to `stored`, which `probe` already returns for some kinds, and document that `stored` is engine units.

**Acceptance.** The echo shows `counterboreDiameterMm: 6` under `typed`.

### R2-F-21 — low — the `layerHeight` schema maximum is 1, while the text says 0.4

**Evidence.** `mcp/schema.ts:271` gives `maximum: 1`, and the description says "0.08 to 0.4". The handler refuses 0.9 correctly.

**Fix.** Set `minimum: 0.08, maximum: 0.4`.

**Acceptance.** The schema test asserts the range.

### R2-F-22 — high — CI never ran on this branch, and no job runs the MCP against real Open CASCADE

**Evidence.**
- `gh run list --branch feature/mcp-server` is empty. The workflow triggers only on pushes to `main` and on PRs into `main`, so `mcp`, `mcp-windows`, and `mcp-macos` have never run.
- The `mcp` job (`ci.yml:162–173`) sets no `LIME_OCCT_BRIDGE`. The `rust` job builds and caches OCCT but runs no MCP test.

This is how R2-F-1 shipped. It also leaves round-1 F-24 (Windows addon load) and F-27 unverified.

**Fix.**
- Add `mcp/occt.test.ts` and run it in the `rust` job after the OCCT build, with `LIME_OCCT_BRIDGE` pointing at the built bridge. It runs, on real OCCT:
  - import `step_cube.step`, describe, hole, counterbore, an oversized fillet refused with `maxMm`, an outside split refused, commit, slice, 3MF, save v1 and v2, reopen, and STEP export with the byte length checked;
  - a timeout case for R2-F-8 using a deliberately slow op, or the stand-in.
- Do not trigger workflows from a review. Marius or the fixer opens the PR into `main` when ready, which runs everything.

**Acceptance.** The new test fails on `664e481` (R2-F-1) and passes after the fix. All MCP jobs are green on the PR.

### R2-U-1 — medium — face rows give no position, but the prompt says to pick by position

**Evidence.**
- `model_describe` faces have only `index`, `areaMm2`, and `normal`.
- The `hole-on-face` prompt says "pick a face from its centre and bounding box". Neither field exists.
- On a part with several faces sharing a normal (a stepped block, a holed plate), the LLM cannot tell them apart.

**Fix.**
- Add `centre`, `bbox`, and `kind` (`plane`, `cylinder`, `other`) to each face row. The centre can be area-weighted from the face's triangles, which the session already has in `solid.triangles` (face index per triangle).
- For cylinders, add `radiusMm` and `axis`.
- Add a `select` filter (see Part B, `faces_find`).

**Acceptance.** The stepped-block scenario picks the upper face by `centre.z` without trial and error.

### R2-U-2 — medium — descriptions are terse fragments, and the 20 KB `tools/list` budget is used up

**Evidence.**
- `tools/list` is 20 495 bytes on the wire. The test measures the tools array only, 15 bytes under its 20 KB cap.
- Many field texts are one or two words ("Edit.", "Direction.", "Point, mm.") and give no frame, default, or workflow.
- `model_apply.op` is an untyped `{type: object}`, so a client cannot validate it.

**Fix.** Part B section 4.6 has the plan: workflow text in resources and prompts, examples, and typed `op`. Raise the budget to about 32 KB, or keep it and move the long text to `lime://guide/*`.

**Acceptance.** Every tool says which tool comes before it and which after, and every coordinate field names its frame.

### R2-U-3 — low — refusals are sometimes `ok: false` and sometimes `isError`

**Evidence.**
- A missing file throws (`isError: true`, "That file was not found: …").
- An unknown handle returns `ok: false` with a reason.
- A path outside the workspace throws.

A model has to handle both shapes.

**Fix.** Use `isError: true` only for protocol and validation errors, and return every domain refusal as `{ok:false, reason, hint?, next?}`. See section 4.6.

**Acceptance.** The schema test checks the shape for one example of each refusal class.

### R2-U-4 — low — a split keeps one half; the other half is dropped without a note

**Evidence (by reading).**
- The session never sends `otherKey` on `apply` for a split (no `otherKey` in `mcp/session.ts`). The bridge builds the second half only when asked.
- The app keeps both halves as two plate objects.
- The MCP keeps the side the bridge returns first, and the reply does not say which.

**Fix.** Send `otherKey` and add the second half as a new plate object (`object` in the reply), or add `keep: "above" | "below" | "both"` and say which side was kept.

**Acceptance.** A split at z = 5 on the 10 mm cube gives two objects of 500 mm³ each, or one object and a reply that names the kept side.

### Round-1 verification

Mutation column: "caught" means reverting the fix made its test fail; "—" means it was not mutated.

| Round 1 | Status | Evidence | Mutation |
|---|---|---|---|
| F-1 stdio framing | verified | `stdio.test.ts` passes, and the raw client got two replies from one write. | caught |
| F-2 bad input | verified | A bad line gets `-32700`, then `ping` is answered. | caught (same mutation as F-1) |
| F-3 commit reaches the plate | **reopened** | Passes with the shim (slice 68 s → 105 s, 0.53 g → 0.73 g; 3MF 12 → 120 triangles; reopen 874.34). Fails on the real modeler: R2-F-1. Also R2-F-2 and R2-F-4. | caught |
| F-4 lossless save | **reopened** | Saving over a rich project is refused, and a changed file is refused. A v2 save after a commit keeps the old mesh: R2-F-4. | caught |
| F-5 project printer | verified | An IR3 V2 project names that printer. The IR3 selection slices (228 s, belt sent). | caught |
| F-6 split check | **reopened** | Axis-aligned planes are right on real OCCT. A tilted outside plane is accepted: R2-F-7. | caught (axis case) |
| F-7 face hole | verified | Real OCCT: origin `[10,5,5]`, axis `[-1,0,0]`, volume 874.34. | caught |
| F-8 mesh vs STEP | verified | A mesh probe returns the sentence without a modeler call. | caught |
| F-9 counterbore, sized boolean | verified | Real OCCT counterbore volume 886.9 (1000 − π·1.5²·8 − π·3²·2). Cylinder sizing is right. Naming nit: R2-F-20. | — |
| F-10 `model_edit` | verified | Real OCCT: edit replays, the volume changes, undo and redo work. Tool lanes stay deferred. | — |
| F-11 paging | verified | Faces and edges page separately to edge 11. | caught |
| F-12 centre | verified | 50, 60 for the cube and the ledge. | caught |
| F-13 bridge | not verifiable | The desktop was not built. By reading, a mirror gap remains: R2-F-19. | — |
| F-14 layers and M73 | verified | 100 `;LAYER:` lines equal the layer count; M73 present on 73 lines. | caught |
| F-15 stale export | **reopened** | A filament change is caught. A Model edit and a project switch are not: R2-F-3. | caught |
| F-16 request drift | verified | Region 960 s vs speed 264 s; 0.9 is refused. Nits: R2-F-17, R2-F-21. | caught |
| F-17 one-object slice named | verified | The object name and the overlap note are present. | — |
| F-18 symlink writes | verified | File symlink, directory symlink, `..`, and absolute outside paths are refused; no outside directory is created. Three overlapping guards (symlink, regular file, `realpath` containment); the test fails only when all three are removed. | caught when all three are removed |
| F-19 PNG | verified | PNGs decode; the holed iso view shows the hole. | caught |
| F-20 blocking, progress, cancel | **reopened** | Cancelling a wait (1.0 s), `slice_cancel`, and progress work. The main thread still blocks for up to 4.1 s: R2-F-12. | — |
| F-21 memory and threads | **reopened (memory)** | 200-slice soak: threads flat at 17, RSS 141–187 MB. Large previews are retained: R2-F-13. | — |
| F-22 start G-code review | verified | M502 and M500 are listed. | caught |
| F-23 app custom G-code | not verifiable | Desktop not opened. `layer-actions.test.ts` passes. | — |
| F-24 Windows addon | not verifiable | No Windows runner and no CI run on the branch: R2-F-22. | — |
| F-25 plate undo | verified | Place, turn, undo, undo restores the pose. New problems: R2-F-9 and R2-F-10. | caught |
| F-26 turns, measure | verified | An omitted turn stays; opposite faces give 20. Semantics nit: R2-F-16. | caught |
| F-27 tests prove claims | **reopened** | Real OCCT is still not in CI, and the stand-in diverges from the bridge: R2-F-1, R2-F-22. | — |
| U-1 descriptions | verified | No undescribed property. Quality issue: R2-U-2. | — |
| U-2 instructions, prompts | verified | Present and annotated. The prompt names fields that do not exist: R2-U-1. | — |
| U-3 recoverable errors | verified | Kind list and range sentences. | — |
| U-4 relative paths | verified | `x.stl` reads from the workspace; a missing file names the full path. | — |
| U-5 workflow traps | verified | The unknown-handle reply says to call `plate_list`; a join opens its tool. | — |
| U-6 machine list | verified | Two lists with cursors. | — |
| U-7 slice result size | verified | 177 bytes, with the object, printer, and filament. | — |
| U-8 setup docs, fresh checkout | not verifiable | The README text is present, and `occt: true` was reached with a bridge built from this branch. OCCT came from the `.deb` and the pinned headers, not from `tools/occt/install.py`. The missing-addon path regressed: R2-F-6. | — |
| U-9 typecheck | verified | `npx tsc -p mcp` passes. | — |
| U-10 bounded names | verified | 200 bytes in the list; the full name is saved. | caught |

Totals at review time: 26 verified, 7 reopened (F-3, F-4, F-6, F-15, F-20, F-21, F-27), 4 not verifiable here (F-13, F-23, F-24, U-8). The resolution of the reopened and unverified rows is in the table at the top of this file.

## 4. Part B: feature parity

The rule is that anything the app can do by hand, the MCP exposes, at the same depth. Mouse-only gestures become numeric, selector, region, or mesh-query inputs. Every write has a dry run (probe) that returns a plain reason before anything changes.

### 4.1 Capability inventory

Status below is the reviewer's reading of `664e481`: **done** (same depth as the app), **partial**, **missing**, or **excluded** (Marius's rule). Batches 1 to 4 in the resolution table close the missing rows for settings, the plate, paint, calibration, and the headless bridge.

| Area | Capability (app location) | MCP today | Status | Gap |
|---|---|---|---|---|
| Files | Open STL, 3MF, STEP (`app/files.ts`) | `mesh_import` | done | — |
| Files | Open and save `.lime` (`project-io`) | `project_open`, `project_save` | partial | R2-F-4, R2-F-5; history not loaded |
| Files | Export G-code, 3MF, STEP | `gcode_export`, `export_3mf`, `model_export_step` | partial | R2-F-1 |
| Files | Samples | — | missing | low value; `mesh_import` with a sample path works |
| Prepare | Centre X/Y (`setPlaceCenter`) | `object_place centreX/Y` | done | — |
| Prepare | Rx/Ry/Rz typed absolute (`setOrientAngle`) | `object_place turn` (one relative axis per call) | partial | no absolute angles, one axis per call |
| Prepare | Scale 10–400 % | `scalePercent` | done | R2-F-2 |
| Prepare | Lay flat, centre on bed | `layFlat`, `centreOnBed` | done | — |
| Prepare | Lay flat on a chosen face (place face on bed) | — | missing | — |
| Prepare | Arrange (`arrangedObjects`) | — | missing | — |
| Prepare | Duplicate (`addedCopy`, Ctrl+D) | — | missing | — |
| Prepare | Separate shells (`replaceWithShells`) | — | missing | — |
| Prepare | STEP chord per object (`#stepTol`) | import only | partial | cannot change after import |
| Prepare | Plate undo and redo | `plate_undo`, `plate_redo` | partial | R2-F-9, R2-F-10 |
| Prepare | Print order: sequential, clearance, gantry | — | missing | — |
| Plate | Multi-object slice (`slicePlateFields`) | selected object only | missing (deferred) | — |
| Plate | Per-object settings (`PlateObjectSettings`: infill, walls, speed, supports, …) | — | missing | — |
| Settings | About 70 `PresetSettings` keys (`settings-schema.ts CONTROLS`) | preset, layer height, supports; the rest via a profile file | partial | no inline set, no listing, no ranges (R2-F-17) |
| Settings | Strategy cards: speed, efficiency, toughness, by layer, by region, with `toughness`, `bottomMm`, `transitionMm`, `axis`, `atMm` | `preset` only | partial | the blend parameters cannot be set |
| Settings | Ironing, fuzzy skin, seams, scarf, z-hop, adhesion, bridges, XY compensation, adaptive layers, tree-support geometry | profile file only | partial | — |
| Settings | Settings profiles library: save, rename, duplicate, export | load only | partial | — |
| Settings | Settings search (`settings-search.ts`) | — | missing | — |
| Machine | Select printer, filament, nozzle | `machine_select` | done | — |
| Machine | Load `.limemachine.json` | `machine_load` | done | — |
| Machine | Edit printer and filament: flow, retract, temps, heat limits, fan, PA/LA, firmware, arcs, start/end G-code, belt (`machine-library.ts` setters) | — | missing | — |
| Machine | Belt printer (IR3 V2) | selection works | partial | belt copies, gap, raft, and angle not settable |
| Machine | Send to printer (Prusa Link, Moonraker, OctoPrint) | — | excluded | rule: no send-to-printer |
| Supports | Mode off, auto, paint (`support-source.ts`) | `supports` boolean | partial | no paint mode |
| Supports | Paint enforce and block (`support-paint.ts`) | — | missing | — |
| Supports | Tree prune and regrow (`support-edit-list.ts`) | — | missing | — |
| Seams | Seam paint (`seam-paint.ts`) | — | missing | — |
| Reinforce | Paint, edge, and box/cylinder volumes (`reinforcement.ts`) | — | missing | — |
| Modifiers | Height ranges and modifier volumes (`overrides.ts`) | — | missing | also dropped from opened projects: R2-F-5 |
| Layers | Pause, filament change, custom G-code at Z (`layer-actions.ts`) | from a project only | missing | — |
| Preview | Slice, cancel, progress | `slice_start`, `slice_wait`, `slice_cancel` | done | R2-F-12 |
| Preview | Estimate, cost, by-feature, warnings | `gcode_summary`, `slice_wait` | done | — |
| Preview | Layer slider data (per-layer time, slow layers, counts) | `layer_summary`: count, first and last, seconds | partial | no per-layer detail or paging |
| Preview | Layer polylines | — | missing (deferred) | — |
| Preview | Layer images, colour by feature, speed, or weight, legend | — | missing (deferred) | — |
| Preview | Pareto blend compare (`runPareto`) | — | missing | — |
| Preview | G-code text view | review lines only | partial | no paged line read |
| Preview | Section plane | — | missing | display only; served by layer images |
| Model | New solid: box, cylinder, sphere | `solid_new` | done | — |
| Model | New solid: cone, torus, wedge, polygon, tube (`PrimitiveSpec`) | — | missing | — |
| Model | Boolean with a primitive, with turn | box, cylinder, sphere | partial | other primitives; cylinder and sphere ignore `turn` |
| Model | Join with another object | `op.kind = join` | done | tool lanes deferred |
| Model | Hole, through or blind, with counterbore | done | done | — |
| Model | Hole from screw presets (`SCREWS` in `model-hole.ts`) | — | missing | — |
| Model | Split (axis, face, tilt) | `split` origin and normal | partial | R2-F-7, R2-U-4 |
| Model | Fillet, chamfer by edge pick | edge indexes | partial | no selectors (R2-F-14, R2-U-1) |
| Model | Scale solid | done | done | — |
| Model | Edit a primitive root | — | missing | `model_edit` takes ops only |
| Model | History goto, undo, redo, edit, drop | done | done | — |
| Model | Rename a step | — | missing | — |
| Model | Commit to plate | `model_commit` | partial | R2-F-1, R2-F-2 |
| Model | Place in model space | `model_place` | done | — |
| Workplane | Face workplane | `workplane_set faceIndex` | done | — |
| Workplane | Bed and Global sources, typed origin and turn (`workplane.ts`) | — | missing | — |
| Workplane | Print with W up | `workplane_print_up` | done | — |
| Measure | Two points, two faces | `measure` | partial | R2-F-16; no edge or vertex picks |
| Measure | Prepare ruler and size readout | `mesh_stats` bounding box | done | — |
| Calibration | PA, flow, temperature, and retract towers (`lime-slice-core/src/calibrate.rs`) | — | missing (deferred) | — |
| Calibration | Save the result to the filament | — | missing | — |
| Live | Desktop mirror | place and some settings | partial | R2-F-19; Model edits not mirrored |

Of 64 rows, 17 are done, 19 partial, 27 missing (4 of them listed as deferred in `docs/mcp-server.md`), and 1 excluded. The main gaps by user value:
1. Settings depth.
2. Paint and support edits.
3. Overrides and per-object settings.
4. The whole-plate slice.
5. Layer data and images.
6. Calibration.
7. Machine editing.

### 4.2 Proposed tools and parameters

Conventions for every new tool:
- Lengths are in mm and angles in degrees.
- Frames are named: `bed` (printer X/Y/Z), `part` (the object's source frame, as paint disks are stored), or `workplane` (U/V/W).
- Every write returns `{ok, reason?, changed?, stale: true}`, and accepts `dryRun: true`, which returns the same answer and a `diff` without changing anything.
- Lists page with `cursor` and `limit` (≤ 100), and return `nextCursor`.
- Large data is written to the workspace and returned as `{path, bytes, sha256}`, never inline.

**Settings (batch 1).**

```json
{"name":"settings_schema","input":{"query":"string?","level":"simple|advanced|expert?","cursor":"string?","limit":"int?"},
 "output":{"rows":[{"key":"ironingSpeed","label":"Ironing speed","unit":"mm/s","type":"number","min":1,"max":200,"step":1,"default":20,"value":20,"level":"advanced","dependsOn":"ironing","help":"…"}],"nextCursor":"…"}}
{"name":"settings_set","input":{"values":{"ironing":true,"ironingSpeed":15},"object":"handle?","dryRun":"bool?"},
 "output":{"ok":true,"changed":[{"key":"ironingSpeed","from":20,"to":15}],"refused":[{"key":"layerHeight","reason":"Layer height must be from 0.08–0.4 mm."}]}}
```

- **Reuse:** `CONTROLS` and `shownAtLevel` (`src/ui/settings-schema.ts`), `settings-search.ts` for `query`, `settingsRules().coerce`, and `DEFAULT_PRESET`. The strategy keys (`blendKind`, `strategy`, `toughness`, `bottomMm`, `transitionMm`, `axis`, `atMm`) are ordinary keys here, so `preset` becomes a shortcut.
- **Feasibility:** every value is checked against the control's range and enum. `dependsOn` warns when the parent is off ("ironingSpeed has no effect while ironing is off"). Belt and firmware rules come from `settingsRules`.
- **Per-object:** with `object`, only the `PlateObjectSettings` keys are allowed (`src/plate.ts`); any other key is refused with "This setting is plate-wide."
- **Acceptance:** each control round-trips. The request body for each key equals the app's `sliceRequest` for the same state (extend `request.test.ts` over all keys). An out-of-range value is refused with the panel's sentence.

**Profiles and machine (batch 2).**

```json
{"name":"profile_save","input":{"name":"string","includeLevel":"bool?"}}
{"name":"machine_get","input":{"printerId":"string?","filamentId":"string?"}}
{"name":"machine_set","input":{"printer":{"retractLength":0.8,"startGcode":"…","bedX":220},"filament":{"nozzleTemp":205,"flow":0.97,"pressureAdvance":0.04},"dryRun":"bool?"}}
{"name":"machine_save","input":{"name":"string"}}
```

- **Reuse:** the `machine-library.ts` setters (`setFlow`, `setRetract`, `setNozzleTemp`, `setFan`, `setAdvance`, `setGcode`, `setHeatLimits`, firmware, arcs, belt) and `serializeMachineFile`.
- **Security:** never return host URLs or API keys. Refuse fields for printer hosts (send is excluded).
- **G-code edits:** start and end G-code are reviewed with `reviewGcode` on set, and the unusual lines are returned.

**Plate (batch 2).**

```json
{"name":"object_duplicate","input":{"object":"handle","count":"int 1..50?"}}
{"name":"plate_arrange","input":{"gapMm":"number?","dryRun":"bool?"},"output":{"moved":[{"object":"obj_1","centre":[60,60]}],"fits":true}}
{"name":"object_split_shells","input":{"object":"handle"}}
{"name":"object_place", "add":{"rotX":"deg","rotY":"deg","rotZ":"deg","faceDown":"faceIndex (lay this face on the bed)","z":"mm lift for sequential checks"}}
{"name":"plate_print_order","input":{"order":"together|sequential","clearanceMm":"number?","gantryMm":"number?"}}
```

- **Reuse:** `arrangedObjects` (`ARRANGE_GAP_MM`), `addedCopy`, `replaceWithShells`, `setOrientAngle`, `layFlatMatrix` (a face variant is the same matrix from that face's normal), and `orderFields` with `tallestLast`.
- **Feasibility:** arrange reports `fits: false` with the objects that do not fit. Sequential order checks clearance with `sequentialClearance(rules, order)` and names the colliding pair.

**Whole-plate slice (batch 2; deferred item).** Add `slice_start {scope: "plate" | "object", object?}`, default `plate` when the plate has more than one object.
- Build `plate` with `slicePlateFields(objects, pose, …)` and `order` with `orderFields`, exactly as `payload()` does.
- Per-object paint and edits go in each `ObjectSpec`.
- The reply lists `objects[]` with `collisions`.
- **Acceptance:** two cubes slice in one G-code. The layer count equals the taller object's. The reply has no collisions at a 30 mm gap, and names the pair at a 0 mm gap.

**Overrides and layer actions (batch 2).**

```json
{"name":"range_add","input":{"zFromMm":0,"zToMm":4,"infillPercent":"0..100?","walls":"1..12?","speedMmS":"?"}}
{"name":"modifier_add","input":{"kind":"box|cylinder|sphere","centre":[x,y,z],"sizeMm":[sx,sy,sz],"frame":"bed","infillPercent":"?","walls":"?","speedMmS":"?"}}
{"name":"overrides_list","input":{}}   {"name":"override_remove","input":{"id":"string"}}
{"name":"layer_action_set","input":{"zMm":12.4,"kind":"pause|filamentChange|customGcode","gcode":"string? ≤ 400 bytes","note":"string?"}}
{"name":"layer_actions_list","input":{}} {"name":"layer_action_remove","input":{"zMm":12.4}}
```

- **Reuse:** `OverrideDocument` and `sliceOverrideFields` (`src/overrides.ts`), and `layer-actions.ts`. The slider's "snap to a layer" becomes "the nearest layer top at or above `zMm`" from the last slice. The reply names the actual Z.
- **Feasibility:** a range outside the part's height is refused, as is a modifier volume that does not touch the part. Custom G-code is reviewed on set. A line over 400 bytes is refused with that limit, instead of being dropped later.

**Paint, seams, reinforcement, and support edits (batch 3, the risky one).** These are brush gestures in the app. The MCP needs region inputs that compile to the same disk lists:

```json
{"name":"paint_supports","input":{"object":"handle","mode":"enforce|block|erase",
  "region":{"oneOf":[
    {"faces":[3,7]},                               // a solid's faces (STEP parts)
    {"overhangBelowDeg":50,"zRangeMm":[0,30]},     // mesh query: triangles steeper than this
    {"box":{"min":[x,y,z],"max":[x,y,z]},"frame":"bed"},
    {"sphere":{"centre":[x,y,z],"radiusMm":5},"frame":"bed"},
    {"stroke":{"points":[[x,y,z],…],"radiusMm":3},"frame":"bed"}]},
  "dryRun":"bool?"},
 "output":{"ok":true,"disks":412,"areaMm2":318.5,"total":{"enforce":412,"block":0},"limit":20000}}
{"name":"paint_seam","input":{"object":"handle","region":"same","erase":"bool?"}}
{"name":"reinforce_add","input":{"object":"handle","kind":"paint|box|cylinder","region":"same (paint)","centre":"[…] (box/cyl)","sizeMm":"[…]","density":"0..1","depthMm":"0.2..100","fillThrough":"bool?"}}
{"name":"paint_list","input":{"object":"handle","layer":"supports|seam|reinforce"}} {"name":"paint_clear","input":{"object":"handle","layer":"…"}}
{"name":"support_edit","input":{"action":"prune|regrow","site":{"xy":[x,y],"zMm":z},"scope":"branch|tree"}}
{"name":"support_trees","input":{"job":"handle?","cursor":"?"},"output":{"trees":[{"id":3,"baseXY":[x,y],"tipZ":[…],"branches":5}]}}
```

- **Reuse:**
  - `support-paint.ts` (`MAX_PAINT_DISKS`, the radius range 0.2–40, the stroke step 0.5 × r), `seam-paint.ts`, `reinforcement.ts` (64 regions, density and depth ranges).
  - `paintRequestFields`, `seamRequestFields`, and `reinforcementRequestFields` with `sourceFrame`, so the disks are stored in the part frame, as the app stores them.
  - For support edits: `support-pick.ts`, `support-edit-list.ts`, and `editRequestFields`, with `includeSkeleton: true` on the next slice so `support_trees` can list the skeleton.
- **Mesh query:** the session has the source positions (`obj.source`). A region selects triangles by face index, normal angle, box, sphere, or stroke distance, then covers them with disks at the brush spacing. Put this in a new pure module, `src/paint-region.ts`, shared with any future app feature.
- **Feasibility:**
  - Refuse an empty selection ("No surface is inside that box").
  - Refuse when the cap would be exceeded ("That needs 23 000 disks; the limit is 20 000. Use a larger radius.").
  - Warn when `supports` is off: "Paint is kept but not used while supports are off."
- **Acceptance:**
  - Painting the overhang ledge sample's underside with `overhangBelowDeg: 50` gives the same `supportPaint` tally in the reply as a hand-painted app project with a similar area, within 10 %.
  - A blocker box under the ledge removes its trees (`inAir` reported).
  - A prune of the tree at a site removes it in the next slice's skeleton.

**Model additions (batch 2).**

- `solid_new` and `boolean` accept every `PrimitiveSpec` primitive (cone `topRadius`, torus `tubeRadius`, wedge `topX`, polygon `sides`/`across`/`flats`, tube `innerRadius`). Reuse `rootSpec` and `planePrimitive`, and respect `turn` for all.
- `hole.screw`: `"M3" | "M4" | …` with `fit` and `head` from `SCREWS` (`model-hole.ts`). It sets the diameter and counterbore.
- `split.keep: "both" | "above" | "below"`, sending `otherKey` (R2-U-4).
- `model_edit` on the root node takes `{kind: "root", …PrimitiveSpec}`.
- `model_rename {node, label}`.
- `workplane_set {source: "global" | "bed" | "face", faceIndex?, origin?, turn?}`, using `workplaneOnBed`, `workplaneOnFace`, and `framePose`.

**Selectors (batch 2, cheap and high value).**

```json
{"name":"faces_find","input":{"object":"handle","normal":[0,0,1]?,"withinDeg":"5?","kind":"plane|cylinder?","areaMinMm2":"?","nearPoint":[x,y,z]?,"limit":"?"},
 "output":{"faces":[{"index":3,"centre":[…],"bbox":{…},"areaMm2":…,"normal":[…],"kind":"plane"}]}}
{"name":"edges_find","input":{"object":"handle","direction":[0,0,1]?,"withinDeg":"5?","onFace":"int?","lengthMinMm":"?","convex":"bool?"},
 "output":{"edges":[{"index":0,"start":[…],"end":[…],"mid":[…],"lengthMm":10,"dir":[0,0,1]}]}}
```

- `fillet` and `chamfer` accept `edges: {select: {...edges_find input}}` as an alternative to indexes. The probe reply lists the resolved indexes, so the model can check what it hit.
- **Reuse:** `solid.edges` and `solid.faces`, plus per-face triangles for centres. `model-select.ts` holds the app's pick helpers.

**Layer data (batch 3; deferred item).**

```json
{"name":"layer_detail","input":{"job":"handle?","layers":"[from,to]","fields":["seconds","slow","walls","supportArea","features"]},"output":{"rows":[…],"nextCursor":"…"}}
{"name":"layer_paths","input":{"job":"handle?","layer":"int","kinds":["outer","infill",…]?,"simplifyMm":"0.05?","format":"svg|json"},
 "output":{"path":"layer-42.svg","bytes":…,"paths":1234,"bbox":{…}}}
{"name":"layer_image","input":{"job":"handle?","layer":"int","colourBy":"feature|speed|weight","longEdge":"32..1024"},"output":{"path":"…png"}}
{"name":"gcode_read","input":{"job":"handle?","fromLine":"int","count":"≤ 500","grep":"string?"}}
```

- **Reuse:** `decodePaths` (`src/preview-wire.ts`), `colors.ts` for colour by, and `render.ts` for PNG encoding. Files go to the workspace, never inline.
- This needs the latest full wire. Keep exactly one (R2-F-13).
- **Acceptance:** the layer 0 SVG of the cube shows the skirt and the 20 mm square outline. `layer_image` decodes. `gcode_read` with `grep: "M600"` finds a filament change set by `layer_action_set`.

**Calibration (batch 3; deferred item).**

```json
{"name":"calibration_tower","input":{"kind":"pa|flow|temp|retract","start":"number","end":"number","step":"number","bandHeightMm":"?","layerHeight":"?","dryRun":"bool?"},
 "output":{"bands":[{"index":0,"value":0.0,"z0":0.2,"z1":2.2}],"gcodePath":"pa-tower.gcode"}}
{"name":"calibration_apply","input":{"kind":"pa|flow|temp|retract","value":"number"}}  // writes the filament, like the app's "Save to filament"
```

- **Reuse:** `lime_slice_core::{pressure_advance_from_request, flow_from_request, temp_from_request, retract_from_request}`, which are already public and already used by `src-tauri/src/lib.rs:244–268`. Add four N-API exports to `crates/lime-mcp-engine` only. The slicer crates are unchanged, so golden stays byte-identical.
- The app's defaults (`runPaCal` and the others in `src/app/slice-run.ts`) and its `printer()` profile.
- **Feasibility:** refuse more than 40 bands, or a tower taller than the bed Z. The PA tower needs a firmware (from the printer).

**Pareto (batch 3).** `blend_compare {object?}` returns 5–10 points `{toughness, seconds, grams, score}`, and `blend_apply {index}`. Reuse `pareto_request` (public) and `applyPareto`.

**Live bridge (batch 4; deferred item).** Mirror Model edits as "commit happened, here is the new mesh hash and file", not as individual ops. The desktop reloads the object from the session's committed STEP in the workspace. This keeps the desktop's own Model history untouched, and avoids a second undo stack (R2-F-19).

### 4.3 How mouse gestures map to inputs

| Gesture in the app | MCP input |
|---|---|
| Drag a part on the bed | `object_place centreX/centreY` (bed frame) |
| Rotation rings with Shift 15° snap | `rotX/rotY/rotZ` absolute; `turn` relative |
| Click a face to lay it flat | `object_place faceDown: faceIndex` (from `faces_find`) |
| Pick faces and edges (Q/W) | `faces_find` and `edges_find` selectors, or indexes |
| Hole placed by clicking a face | `workplane_set face` plus `at {u,v}`; or `origin` and `axis` in the part frame |
| Split plane drag and tilt | `split origin, normal`; or `{axis: "z", atMm: 5, tiltDeg: [x,y]}`, which compiles to origin and normal |
| Brush strokes (paint, seam, reinforce) | region: faces, overhang query, box, sphere, or stroke polyline with radius |
| Click a support limb to prune | `support_trees`, then `support_edit prune {site, scope}` |
| Layer slider and marker click | `layer_action_set zMm` (snapped to a layer top, reported) |
| Section plane, camera, colour by | `layer_image`, `render_view` |
| Gizmo scale handle | `scalePercent` |

### 4.4 Compact outputs

- Handles stay short (`obj_3`, `job_2`, node ids).
- Lists are paged at 100, with summary counts (`total`) at the top.
- Geometry and toolpaths are files in the workspace. The reply carries `{path, bytes, sha256}` and a two-line summary.
- `slice_wait` stays under 300 bytes. Detail is on demand: `gcode_summary`, `layer_detail`.
- `settings_schema` defaults to the keys that differ from the default, plus the queried rows; the full table only on request.

### 4.5 Feasibility before Apply

Every new write has a `dryRun` answer that names, in one sentence, why it would fail and what would work:
- a range ("Brim width must be from 0.4–30 mm.");
- a dependency ("Ironing is off; turn it on first or pass ironing: true.");
- a geometry check ("No surface is inside that box.");
- a limit ("The limit is 20 000 disks.");
- a printer rule ("Belt printers slice one object at a time.", from `settingsRules`).

Model ops keep the probe gate, plus R2-F-8's time budget and R2-F-11's disjoint check.

### 4.6 Making the LLM efficient

- **Descriptions that teach the order.** Each tool says what comes before and after it. For example, `model_apply`: "After model_probe returned ok for the same op. Then model_commit before slicing." Coordinate fields name their frame: "Bed X in mm, the printer's coordinates", not "Point, mm."
- **Raise the 20 KB budget** to about 32 KB, or keep the short text in `tools/list` and add `lime://guide/{workflow}` resources:
  - `slice`, `model`, `paint`, `calibrate`;
  - each has one worked call sequence with real replies.
- **Example sequences in the prompts:**
  - "slice-for-machine": `machine_list`, then `machine_select`, `slice_start`, `slice_wait`, `gcode_summary`;
  - "hole-on-face": `faces_find`, then `workplane_set`, `model_probe`, `model_apply`, `model_commit`;
  - "paint supports under overhangs";
  - "calibrate PA for a new filament".
  The existing prompts reference fields that do not exist (R2-U-1). Generate the prompt text from a test-checked sequence so it cannot drift.
- **Batching.** `settings_set` takes many keys at once. Add `model_apply_many {ops:[…], stopOnRefusal: true}`, which probes all the ops first and applies none if any is refused.
- **Dry-run diffs.** `dryRun` returns `{diff: [{key, from, to}], estimate?: {secondsDelta?}}`. Leave the estimate out unless cached; never slice implicitly.
- **Error shape** (R2-U-3). Use `{ok:false, reason, field?, allowed?, next?: "Call plate_list for the current handles."}`. Keep `isError` for protocol errors only.
- **State resources.** `lime://plate` (objects, poses, settings differing from default, stale flag) is one read that replaces three calls. `lime://object/{id}/model` gives faces, edges, and history, summarised.
- **Typed `op` in `model_apply` and `model_edit`.** Reuse the `op` `oneOf` so clients validate before calling.

### 4.7 Batches by value and risk

| Batch | Contents | Value | Risk and cost |
|---|---|---|---|
| 0 (required) | Part A fixes below | correctness | low to medium; MCP only |
| 1 | `settings_schema`, `settings_set` (all keys, per-object keys), typed `op`, error shape, face and edge selectors with centres, guide resources and prompts | high: unlocks most of the app's depth | low: pure helpers exist; no engine change |
| 2 | Whole-plate slice, print order, arrange and duplicate and shells, overrides and modifiers, layer actions, profile and machine edit and save, extra primitives and screws and split keep and root edit, Bed and typed workplane | high | medium: the plate slice must match `payload()` exactly; test body equality against the app's builder for each field |
| 3 | Paint, seams, reinforcement, support edits; layer detail, paths, images; G-code read; calibration towers; Pareto | high for real prints | high: needs the new region-to-disk module and skeleton handling; calibration adds N-API exports (no slicer change) |
| 4 | Live bridge mirroring commits and plate snapshots | medium | medium: desktop code; manual test needed |

Cheap and high value: `settings_set` and the selectors. Risky: paint regions, because disk coverage must match a hand brush closely enough to give the same supports.

## 5. Ranked fix plan

### Required before Marius reviews

1. **R2-F-1:** decode `bytesBase64` in commit and STEP export; make the stand-in reply the real shape; add the reply-shape contract test.
2. **R2-F-22:** add `mcp/occt.test.ts` on real OCCT in the `rust` job, covering the round-1 Model scenarios plus R2-F-1, F-2, F-4, F-7, and F-8. Open the PR into `main` so all MCP jobs, including Windows and macOS, actually run (F-24).
3. **R2-F-8:** move the modeler to its own worker with a time budget, respawn, and a "tree lost" message. Probe multi-edge blends with a preview.
4. **R2-F-6:** reject engine calls cleanly when the addon fails to load.
5. **R2-F-3** and **R2-F-15:** add the mesh hash, tree node, layer actions, and session generation to the stale stamp, and check every slice reader.
6. **R2-F-5:** send overrides, paint, edits, and reinforcement as `payload()` does, or return `notSliced` on open and slice.
7. **R2-F-4:** in v2 saves, write the session mesh and tree; load `modelTree` on open, or say it is not loaded.
8. **R2-F-2:** make the commit idempotent, and reset the scale only on a new commit.
9. **R2-F-9** and **R2-F-10:** keep Model state out of plate snapshots, and share buffers by reference.
10. **R2-F-7:** use the true-normal split check.
11. **R2-F-11:** refuse disjoint booleans.
12. Correct `docs/mcp-server.md` "What shipped" for R2-F-1, R2-F-4, and R2-F-5 until they are fixed.

### Later

- R2-F-12 (main-thread work and progress throttling), R2-F-13 (retained previews), R2-F-14 and R2-U-1 (edge and face geometry), R2-U-2 and R2-U-3 (descriptions, budget, error shape), R2-U-4 (split halves).
- R2-F-16, F-17, F-18, F-19, F-20, F-21 (low).
- Part B batches 1 to 4 in order. Batch 1 can start as soon as items 1–3 above are in.

### Top ten actions

1. Fix the `bytesBase64` read (R2-F-1), with a reply-shape contract test.
2. Run a real-OCCT MCP test in CI, and open the PR so every job runs (R2-F-22).
3. Give modeler calls a time budget and a respawn (R2-F-8).
4. Fail fast when the addon is missing (R2-F-6).
5. Complete the stale stamp (R2-F-3, R2-F-15).
6. Slice what the opened project holds, or say what is left out (R2-F-5).
7. Make v2 saves keep committed edits and history (R2-F-4).
8. Make commits idempotent (R2-F-2).
9. Rework plate undo snapshots: no Model state, no buffer copies (R2-F-9, R2-F-10).
10. Ship Part B batch 1: `settings_schema` and `settings_set`, selectors with face centres, typed ops, and guide resources.
