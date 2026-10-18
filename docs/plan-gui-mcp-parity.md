# Plan A: the MCP's modelling operations in the app

Status: plan, for implementation by agents. Written 2026-10-18 against `main` at v2.8.1.
Companion: `docs/plan-gui-cad-modeling.md` (Plan B, sketches and push/pull). The two plans share work package A0 and
the group-op foundation in A1. Read both before starting either.

## 1. Goal

Everything a Claude session can do to a solid through the MCP server, a person can do in the app's Model workspace,
with the same results, the same history, and the same `.lime` file. Nothing the MCP builds should open in the app as
a step the app cannot show, edit, or explain.

Out of scope here: drawing 2D shapes and turning them into solids, and push/pull on faces and edges. Those are Plan B.
This plan gives Plan B its foundations (the shared modelling module and group ops) and leaves the extrude, revolve,
loft and sweep panels to it.

## 2. Where things stand

### 2.1 The app's Model workspace today

- **Toolbar** (`src/app/markup.ts`, lines ~127-144): New solid, Boolean, Split, Fillet, Chamfer, Hole, Scale,
  Measure, Place, Workplane. `ModelTool` and `MODEL_TOOLS` in `src/model-drag.ts` list them. A checklist test fails
  when a tool has no drag handles.
- **Tool anatomy.** Every tool is the same five parts, and new tools must follow the pattern:
  1. panel fields in `src/app/markup.ts`, shown per tool by `data-for` and `data-prim`;
  2. a local ghost (`ModelGhost` in `src/model-view.ts`) drawn while numbers change;
  3. drag handles (`specsFor` in `src/model-drag.ts`) that write the same fields;
  4. `toolOp(tool)` in `src/app/model.ts`, which builds a `ModelOp` from the fields and picks;
  5. a probe (`src/model-feasibility.ts`, debounced by `PROBE_WAIT_MS`) whose dry-run mesh is drawn in the solid's
     place, then Apply (`applyTool` and `applyOp` in `src/app/model.ts`), which adds a history node.
- **Picks**: `ModelView.onPick` gives faces and edges (`ModelPick`), and shift-click adds more (`src/model-select.ts`).
- **History** (`src/ui/model-history.ts`): rows per node, with rename (double-click), branches, delete, and edit. An
  edit opens the step's panel through `editPanel(op)` in `src/model-edit.ts`. `editRefusal` turns away extrude,
  revolve, loft and shell: "no edit panel yet".
- **Engine calls**: `src/model-request.ts` builds them, and `POST /api/model/tree` (the browser engine) or the
  `model_tree` command (Tauri) carries them. Ops and their storage are in `src/model-tree.ts`. Reading and writing
  them in `.lime` files is `src/model-tree-file.ts`. Pose transforms are `toSolidOp` in `src/model-space.ts`.

### 2.2 What the MCP can do that the app cannot

| MCP capability | Where it lives | App today |
|---|---|---|
| `extrude`, `revolve` (kernel), including `smooth`/`corners` profiles | `crates/lime-model-occt`, `src/model-tree.ts` | Stored and replayed; no panel; not editable |
| `loft` (kernel), `sweep` (MCP lays out loft sections) | `mcp/sweep.ts` | Stored as loft; no panel |
| `shell` with open faces | kernel | Stored; no panel; not editable |
| Fillet/chamfer on `{fromNode, filter}` ("the edges step N made") | kernel `EdgeStep` | Stored; the edit panel shows only picked edges |
| `ellipsoid` primitive | kernel, `src/model-primitive.ts` | Already in the picker (2.5.0) |
| Composite ops: `pocket`, `boss`, `texture`, `array`, `ribs`, `text`, `pattern` (linear, polar, path), `mirror` | `mcp/compose.ts`, `mcp/text.ts`, `mcp/sweep.ts` | None. They expand to many Boolean nodes, which the app shows as dozens of rows |
| Face selectors `{normal, withinDeg, nearPoint}`, coplanar faces | `mcp/session.ts` `expandContext` | The app uses picks, which is fine |
| Named parameters and expressions in any number field | `mcp/expr.ts`, `model_params`, saved in `mcpModel` | None |
| Labels on steps, anchors `{anchor, point, offset}`, `model_anchors` | `mcp/anchors.ts` | Rename only |
| Loops (`each`), parts (`model_define`/`use`), recipes (rerun with new params) | `mcp/macro.ts`, `mcpModel.recipes` | None. A recipe in a file is kept but not usable |
| `model_check`: overhang regions, ceilings, islands, fit, thin walls with positions | `mcp/inspect.ts`, `mcp/thin.ts` | Prepare shows overhang colouring; no thin walls, no located list |
| Located refusals (`where: {voids, pieces}`) | kernel `piece_report`, `mcp/compose.ts` | The readout shows the kernel's sentence; no location |
| Render looks: section view, colour by step, highlight a step | `mcp/render.ts` | Prepare has a section plane; Model has none |
| Resume a refused build, `onError: skip` | `mcp/session.ts` | Not needed in a UI (each step applies on its own) |

## 3. Architecture decisions

### D1. One implementation, shared: move the MCP's modelling helpers into `src/modeling/`

The composite expansion, sweep layout, text strokes, anchors, expressions, macros and thin-wall measure are pure
TypeScript that only the MCP imports today. The app must use the same code, so a pocket from the app and a pocket from
the MCP are the same steps.

- Move into a new folder `src/modeling/`, without changing behaviour:
  - `mcp/compose.ts` → `src/modeling/compose.ts`
  - `mcp/sweep.ts` → `src/modeling/sweep.ts`
  - `mcp/text.ts` → `src/modeling/text.ts`
  - `mcp/anchors.ts` → `src/modeling/anchors.ts`
  - `mcp/expr.ts` → `src/modeling/expr.ts`
  - `mcp/macro.ts` → `src/modeling/macro.ts`
  - `mcp/thin.ts` → `src/modeling/thin.ts`
- Leave a one-line re-export at each old path (`export * from "../src/modeling/compose.ts";`), so MCP imports, tests
  and the bundle keep working. A follow-up can switch the imports and delete the shims.
- Constraint: `src/modeling/*` must not import from `mcp/` or `src/app/` (no DOM, no session state), so the browser
  bundle and the MCP bundle can both include it. `compose.ts` depends on an `ExpandContext` interface (face frames,
  face selectors); the app implements it from the open solid's reply, as `mcp/session.ts` does today.

### D2. Group ops: a composite edit is one history node, not dozens

A pocket with bars is 3 Boolean steps; a texture can be 300. In the MCP these are separate nodes, tied together only by
an undo group the session keeps in memory, which is not saved. The app needs one row per edit, one undo step, an edit
panel that reopens with the composite's own fields, and a file that keeps all of that.

Decision: a new kernel op `group`, built step by step inside one node.

- **Rust** (`crates/lime-model-occt/src/tree.rs`), `Op::Group`:

  ```rust
  Group {
      /// The history row's name, e.g. "Pocket 10 × 10, 2 bars".
      label: String,
      /// The composite as typed (`{kind: "pocket", ...}`), kept opaque. Read back for an edit; never built.
      #[serde(default, skip_serializing_if = "Value::is_null")]
      source: serde_json::Value,
      steps: Vec<Op>,
  }
  ```

  Allowed steps: boolean, extrude, revolve, loft, hole. No join, split, scale or root: refuse those with a sentence.
  Fillet and chamfer are only allowed with index-free picks.
- **Build**: apply each step to the previous shape. On the first failure, return `{error, failedStep: i}`. The error
  is the kernel's sentence for that step, prefixed "Step i of n:". A step whose tool misses the solid entirely is
  skipped and counted (as `skipped` is in the MCP), not refused. The probe returns the same metrics as a single op,
  plus `skipped`. The `pieces`/`voids` report (from `piece_report`) is taken on the whole group's result against its
  parent.
- **TypeScript** (`src/model-tree.ts`): `GroupOp { kind: "group"; label: string; source?: unknown; steps: ModelOp[] }`,
  added to the `ModelOp` union. `opLabel` returns `label`.
  - `toSolidOp` maps each step.
  - `src/model-tree-file.ts` reads and writes it: validate each step with the existing readers, and keep `source` as
    is.
  - The client-side probe-key and feasibility helpers treat it as one probed tool (`PROBED_TOOLS` gains `group`,
    checking "Checking these steps…", fits "These steps change the solid.").
- **MCP (optional, later)**: `applyMany` could store composites as groups too, so MCP-built parts open in the app as
  one row per composite. That is a behaviour change for MCP resume and undo, so it is a separate work package (A9).
  Until then the app shows MCP composites as the many rows they are; A8 makes those rows readable.

### D3. Expressions and parameters are the project's, not the MCP's

- Parameters: a project-level table, name → number or expression, evaluated in order, as `mergeParams` does.
- Storage: lift them out of `mcpModel` into a top-level `parameters` field in `.lime` (`src/project.ts`). The field is
  optional and kept by both the app and the MCP. The MCP reads `mcpModel.params` from older files as a fallback, and
  writes `parameters`.
- Number fields: every numeric input in a Model panel accepts an expression (`wallH / 2 + 1`), evaluated with
  `src/modeling/expr.ts`.
  - The op stores the evaluated number, which is what the kernel needs.
  - The panel remembers the text per field in a new optional op field, `exprs?: Record<string, string>`, kept by
    `model-tree-file.ts` and ignored by the kernel. Rust `Op` must tolerate it: use `#[serde(default)]`, or strip it
    before sending, which is the simpler choice. Strip in `src/model-request.ts`.
  - Editing a parameter offers to rebuild the steps whose `exprs` use it, as one edit that replays the chain
    (`replayChain`, `forked`).

### D4. Shared look

New panels use the existing panel layout and classes, the scrub fields (`src/ui/field-scrub.ts`), the probe/readout
line, and Apply/Cancel. No new design system. Each new tool gets drag handles (the checklist test demands it), but
handles are a convenience: every number is typeable.

## 4. Work packages

Each package is one PR. It bumps the version in the usual files, adds unit tests (node scripts listed in
`package.json` `test:unit`) and, for UI, a Playwright spec added to `test:smoke`, and updates
`docs/step-modeler.md` (app behaviour) or `docs/mcp-server.md` (MCP behaviour). Write user-facing text as plain
sentences, and phrase refusals as what to change, as the existing code does.

### A0. Shared modelling module (foundation, do first)

- Scope: D1. Move only; no behaviour change.
- Files: `src/modeling/*` (new), shims at the old `mcp/*.ts` paths, `tools/mcp/bundle.mjs` if it lists files.
- Tests: the existing `mcp/*.test.ts` pass unchanged. Add `src/modeling/index.test.ts`, which imports every module in
  a browser-safe way (no `node:` imports in `src/modeling`).
- Accept when: `npm run build` (tsc and vite) succeeds with `src/modeling` imported from a small app file, and every
  MCP test passes.

### A1. Group ops in the kernel and the tree (foundation)

- Scope: D2, kernel and TypeScript, with no UI.
- Files:
  - `crates/lime-model-occt/src/tree.rs`: `Op::Group`, build, probe, `same_request` and `same_build` (compare steps
    recursively, ignore `source`), and replay.
  - `src/model-tree.ts`, `src/model-tree-file.ts`, `src/model-space.ts`, `src/model-feasibility.ts`,
    `src/model-edit.ts` (`editPanel` for group: see A3).
- Tests:
  - Rust `tests/group.rs`: three box cuts in one group equal three separate nodes in volume. A failing second step
    names "Step 2 of 3". A missing step is skipped. A group replays from saved nodes with the same fingerprint.
  - TS: the round trip through `.lime`, and `toSolidOp` under a turned pose.
- Accept when: a group node opens in the app (built from a test file) as one history row labelled with its `label`.

### A2. Shell panel

- Toolbar: "Shell", after Hole.
- Panel:
  - Thickness: a number, drag knob, expressions allowed.
  - Open faces: the current face picks, listed as a count ("2 faces open").
  - A checkbox, "Keep it closed (hollow inside)", which ignores picks.
- Ghost: none, because the kernel probe preview is the honest view. Draw picked faces in the "removed" colour (a
  dashed outline).
- Op: `shellOp(thickness, faceIndexes)` already exists in `src/model-request.ts`.
- Edit: allow it (remove shell from `editRefusal`). The panel opens with the stored face refs re-picked by
  `{index, mid, areaMm2}` (mirror `matchEdges` with a `matchFaces`).
- Handles: one knob along the first picked face's inward normal, for thickness.
- Tests: Playwright: pick the top face of a box, thickness 2, Apply → volume as the MCP gives it. Edit → change to 3 →
  rebuilds.

### A3. Composite tools: Pocket, Boss, Texture, Array, Ribs, Text (group-based)

- One toolbar entry, "Features ▾", with a menu of: Pocket, Boss, Texture, Array, Ribs, Text. That keeps the toolbar
  from growing six buttons; the last-used one stays on the button.
- Each panel mirrors the MCP schema fields (see `mcp/schema.ts` for exact names, ranges and descriptions; reuse
  those strings):
  - **Pocket and Boss:**
    - shape: rect, circle or arch;
    - width, height or diameter;
    - depth;
    - bars: vertical count, horizontal count, width (pocket only);
    - position: drag on the face (a surface handle, as Hole has) or typed u, v;
    - `from`: centre, corner, bottom or top.
  - **Texture:** pattern (lines, grid, brick, shingle), pitch u and v, groove width, depth.
  - **Array:**
    - cell: shape (rect, circle, polygon), width and height, diameter, or sides and across;
    - turn; pitch u and v; stagger; angle; margin; fit (inside, centre);
    - depth; op (raise or cut).
  - **Ribs:** along u or v, angle, width, pitch or count, depth, margin, op.
  - **Text:** text, height, stroke width, spacing, align, angle, depth, raise or engrave, position on the face.
- Face: the picked face. Exactly one flat face must be picked; otherwise the note says "Pick one flat face." Texture,
  Array and Ribs cover the picked face's whole coplanar plane, as in the MCP.
- Building the op:
  1. Call `expand(spec, ctx, toPart)` from `src/modeling/compose.ts`, with an app-side `ExpandContext` built from the
     open solid's reply: face frames via `facePlane` plus `levelFrame` (move `levelFrame` and `pointTriangleDistance`
     from `mcp/session.ts` into `src/modeling/frames.ts` in this package).
  2. Wrap the pieces as `GroupOp { label, source: spec, steps: pieces→boolean ops }`.
- Ghost: draw every piece's primitive mesh (`primitiveMesh` plus `planePrimitive`) as one merged ghost. That's cheap,
  and it's what the user is placing. Cap the ghost at 2,000 pieces, beyond which it shows outlines only.
- Probe: the group probe from A1. A refusal with a failed step highlights that piece's ghost in red, and the readout
  zooms to it.
- Edit: `editPanel` for a group with `source.kind` in this set reopens the panel from `source`. On Apply it
  re-expands against the parent node's solid (fetch with `gotoRequest(parent)` if it isn't cached) and replaces the
  node (the existing `forked`/edit path).
- Handles: depth knob along the face normal, a position surface handle, and pitch knobs for Array, Ribs and Texture
  along the face's U and V.
- Tests:
  - Unit: the app's `ExpandContext` gives the same pieces as the MCP's for the same solid and spec. Use a stand-in
    reply fixture.
  - Playwright: a pocket with bars on a box face → one history row "Pocket …" → volume matches. Edit the pocket's
    width → rebuilt.

### A4. Pattern and Mirror of steps

- MCP semantics: `pattern` and `mirror` wrap an inner op. In the app the natural form is to pick history steps
  (Boolean, Hole, Pocket and the other group features) and repeat them.
- Panel "Pattern": a source (one or more history rows, picked in the history list with Ctrl-click, defaulting to the
  last step) and a mode:
  - Linear: step x, y, z and count; optional second direction.
  - Polar: count, axis (X/Y/Z or a picked edge or cylinder face), centre, and angle.
  - Path: points picked on the solid or typed; count; align.
- Panel "Mirror": a source as above; a plane (X, Y, Z through the solid's centre, or a picked flat face); keep the
  original.
- Build: take each source step's op (or each step of a group), move it with `movedSpec` and the motions from
  `src/modeling/compose.ts` (`patternMotions`, `pathMotions`, `mirrorMotion`), and emit one `GroupOp` whose
  `source` is `{kind: "pattern" | "mirror", of: [node ids], ...fields}`.
  - Only Boolean-primitive steps and groups of them can be repeated in this package.
  - Holes are allowed as booleans of a cylinder (convert `HoleOp` to a cutting cylinder), or refused with "Holes
    cannot be patterned yet."
- Edit: from `source`. If a referenced step was deleted, the edit panel says so.
- Tests: polar pattern of a hole-cylinder 6 times around Z → one row, volume matches six single cuts. Mirror of a
  pocket.

### A5. Edges a step made (fillet/chamfer by step)

- In the Fillet and Chamfer panels, add an "Edges" choice:
  - Picked (today's behaviour);
  - All edges a step made: pick a history row; the filter is all, convex or concave.
- Op: `edges: [stepEdges(nodeId, filter)]` (already in `src/model-request.ts`).
- Edit: show which mode a stored op used. Today `editPanel` drops step picks; fix it so it shows "Edges of: <row>
  (convex)".
- Ghost: highlight the step's edges. Ask the engine for that step's created edges (the tree already knows them). If
  there is no call for that, add a tree call `stepEdges {key, node, filter}` → edge indexes on the current solid,
  which also lets A2 and A3 preview.
- Tests: fillet "convex edges of the roof step" on the house-roof example → same volume as the MCP.

### A6. Parameters and expressions

- Scope: D3.
- UI:
  - A "Parameters" panel, reached from the Model toolbar overflow and Ctrl+Alt+P. It's a table of rows (name,
    value/expression, evaluated value, used-by count), with add, delete and reorder. An error shows inline, in the
    expression evaluator's words.
  - Every Model number field accepts an expression. While focused it shows the expression; while not focused it
    shows the evaluated value with a small "ƒ" mark.
- Storage: `.lime` `parameters` (top level). The op's `exprs` are kept in the tree and stripped before the engine
  call.
- Rebuild: changing a parameter lists the affected steps. "Rebuild 3 steps" replays them, as one edit, from the
  earliest.
- MCP: the session uses `parameters` when present (read and write), and keeps reading `mcpModel.params` for old
  files.
- Tests: set `wallH = 30`, make a box with `dz = wallH`, change to 40 → rebuild → the box is 40 tall. Save, reopen →
  the parameter and expression are kept.

### A7. Model check panel, and located refusals in the view

- "Check" button in the Model toolbar (and in Prepare's object menu). It runs the same checks as `model_check`
  (`mcp/inspect.ts` `printCheck` plus `src/modeling/thin.ts`) on the open solid's mesh, in a web worker:
  - overhang regions, ceilings, islands, fit, thin walls;
  - a list, each row with its size and position. Clicking a row frames that box and outlines it in the view.
- Thin-wall threshold: twice the nozzle diameter by default (from the selected machine), editable in the panel.
- Located refusals: when a probe or apply fails with `pieces`/`voids` in its reply (the kernel adds them to probe
  metrics), draw those boxes red in the view and add "Show where" to the readout, which frames them. Today the app
  shows only the sentence.
- Tests: unit for the mapping; Playwright with the stand-in engine reply containing `voids` → a red box appears.

### A8. Readable history for MCP-built parts

- Until A9, MCP composites arrive as many rows labelled `label k/n` (e.g. "rim leaves 3/12").
- History panel: fold consecutive rows whose names share a prefix and run `1/n … n/n` into one collapsible row
  ("rim leaves · 12 steps"). Expanding it shows the rows. Undo from the folded row's last step goes to its first
  step's parent. The view of "current" stays per node.
- Show an MCP recipe: if the object has `mcpModel.recipes[id]`, the history header shows "Built by a recipe" with
  "Edit parameters…". That opens the recipe's params in the Parameters panel and reruns the recipe in the app.
  Rerunning needs the macro expansion (`src/modeling/macro.ts`) plus the composite expansion: implement it as a
  client-side "replay recipe" that builds group ops. If that's too large, make it a separate package and show the
  recipe read-only here.
- Tests: a fixture tree with "texture 1/40 … 40/40" folds into one row; undo from it lands before the first.

### A9. (MCP) store composites as group ops

- `mcp/session.ts` `applyMany`: when a composite's pieces all apply, replace them with one `GroupOp` node, or build
  the group directly with one probe. Keep `buildLog` and resume working: a group is one checkpoint.
- Located refusals still name the failing piece (`failedStep`).
- Tests: the existing MCP suites, updated for one node per composite. The fountain build opens in the app as about 25
  rows instead of 325.

### A10. Section view, colour by step, and highlight a step in Model

- View menu in Model:
  - **Section**: a plane (X, Y or Z, or a picked face), dragged with a single arrow. The cut-away side is hidden and
    cut faces are drawn in the inside colour. The probe and the solid are unchanged; this is view-only, like
    `render_view`'s `section`.
  - **Colour by step**: each history row gets a colour swatch, and faces take their step's colour.
    - The kernel knows which faces each node created, as it does edges. Add `stepFaces` to the solid reply (per face,
      the node that made it) so colouring is exact, not by bounding box as in `mcp/render.ts`.
    - This is a kernel change in `tree.rs` (face provenance across steps via `BRepTools_History` / `Modified` /
      `Generated`, which the edge tracking already uses).
  - **Highlight**: hovering a history row tints its faces.
- Tests: a Rust test that face provenance survives a later boolean. Playwright: colour by step shows two colours on a
  box with a fused cylinder.

## 5. Order and parallel work

```text
A0 ──┬── A3 ──┬── A4
     │        └── (B-series uses A0)
A1 ──┘
A2   (independent; needs face ref matching only)
A5   (independent)
A6   (after A0; touches src/project.ts and mcp/session.ts)
A7   (after A0)
A8   (independent; history panel only)
A9   (after A1 and A3, MCP only)
A10  (independent; kernel face provenance)
```

- Run in parallel: A2, A5, A7, A8 and A10 touch disjoint files. A0 and A1 first, in parallel with each other.
- Then A3, then A4.
- A6 touches `src/project.ts`, `mcp/session.ts` and every panel's number field. Run it alone, after A3.
- Every package that adds a toolbar button touches `src/app/markup.ts`, `src/model-drag.ts` (`MODEL_TOOLS`,
  `DRAG_FIELDS`) and `src/ui/model-chrome.ts`. Agents working in parallel must rebase on `main` before opening the
  PR and keep their additions in separate, clearly marked blocks.

## 6. Done for the whole plan

- Every MCP op and composite is reachable from the app, previewed, applied as one undo step, editable from history,
  saved and reopened.
- An MCP-built part opens in the app with readable history (A8 now, one row per composite after A9).
- A part built in the app with the same steps as an MCP build gives the same volume and the same faces.
- `docs/step-modeler.md` describes each tool. The MCP's `ops` guide links to the app tool of the same name.
