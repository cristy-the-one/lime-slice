# UI tasks for `dev/ui-review`: from "it works" to "it is comfortable to use"

Status: task list for implementation (Grok 4.7). Written 2026-10-20 by reviewing:

- the screenshots in `docs/screenshots/` (Prepare, Preview, Model, sketch, push/pull, holes, history, parameters,
  loft, revolve, sweep, and the phone layouts);
- `docs/screenshots/tutorials/` (revolve, loft and sweep step by step);
- `docs/screenshots/ui-review-3-1/`;
- the branch `dev/ui-review` at `acbe7c5`.

What is on the branch beyond `main` (merge-base `90f4440`): one feature, "parameter handles"
(`src/handle-emphasis.ts`, `src/model-view.ts`, `src/styles.css`, the last section of `docs/ui-review-3-1.md`), plus
a fix keeping a refused extrude retryable. The earlier findings in `docs/ui-review-3-1.md` (sketch dimension field,
selection chip, phone "Show controls", drawer hints, disabled tools, feature opener, focus rings) are already on
`main`. The branch type-checks and `src/handle-emphasis.test.ts` passes.

## How to work

- Branch from `dev/ui-review` and keep the branch name. Merge `origin/main` into it first: the branch is 3 commits
  behind, with the tutorial docs.
- One commit per task, with the task ID in the subject, for example `UX-03: …`. Each task lists its acceptance
  checks; add or update the Playwright spec it names. Run, before each push:
  - `npx tsc --noEmit`;
  - `npm run test:unit`;
  - the specs named in the task, plus `e2e/window-fit.spec.ts` and `e2e/compact-layout.spec.ts`, so the layout
    doesn't regress.
- No engine changes: these are UI tasks only. Write user-facing text as plain sentences, as the rest of the app does.
- When all P0 and P1 tasks are done: bump the version (minor), update `docs/ui-review-3-1.md` (or add
  `docs/ui-review-3-2.md`) with before and after screenshots, and open a PR to `main`.

Priority: **P0** blocks merging the branch; **P1** is needed for an ergonomic standard; **P2** is polish.

---

## Part 1. The branch's own feature: parameter handles (fix before merging)

### PH-01 (P0). The lit edges must stand out, and the solid must not wash out

Status: done. Aspect lines are 4 px axis colour (`depthTest: false`) with a dashed hidden pass. The solid stays at opacity 1 (`data-solid-opacity`). Ghost edges dim to 0.35 and ghost faces by 20%. Screenshots: `ph01-before-axis.png` (the previous pale edges) and `ph01-after-axis.png`.

- **Seen**: `after-handle-axis.png`, `after-handle-field.png`.
  - The four "Depth (Y)" edges are thin, pale green, and hard to see.
  - The whole solid and ghost go translucent (`aspectDim`: the solid at 0.55, the ghost at 0.45×), so the picture
    gets *less* readable when the user is trying to read one dimension.
- **Change**:
  - Draw aspect lines at full axis colour (`--axis-x` / `-y` / `-z`), 4 px screen width, with `depthTest: false` so
    they read through the ghost. Draw the hidden part of each line dashed: a second pass with depth test on and a
    dashed `LineMaterial`.
  - Keep the solid opaque. Dim only the ghost's other edges (already in `restyleGhostLines`) to 0.35, and the ghost's
    faces by at most 20%.
  - Don't change the solid's material at all while a sketch isn't open.
- **Accept when**:
  - A pixel sample at a lit edge's midpoint in the screenshot has the axis colour (ΔE < 10).
  - `data-aspect-dim` no longer changes the solid's opacity. Assert `solidMaterial.opacity === 1` through a debug
    hook, or a canvas data attribute `data-solid-opacity`.
  - Update `e2e/model-drag.spec.ts`.

### PH-02 (P0). Show the value once, as a real dimension

Status: done. A mapped handle draws extension lines, a dimension line with arrowheads, and one label. The knob tooltip stays hidden while that dimension is up, and the dimension flips to the far side when the label would cover the knob. Screenshot: `ph02-after-dimension.png`.

- **Seen**: two identical labels ("Depth (Y) 10 mm"), one at the knob and one floating mid-face. Neither has
  extension lines or arrows.
- **Change**:
  - When an aspect has a `dimension`, draw it as a dimension: two extension lines from the measured edges, a
    dimension line with arrowheads, and the label centred on it, offset from the part by `gap`.
  - Hide the knob tooltip while that dimension is shown. Keep the tooltip only for controls with `mapped: false`.
  - The label never overlaps the knob: if their screen boxes intersect, move the dimension to the far side.
- **Accept when**: exactly one element contains the tip text while hovering a mapped knob. Test it with
  `page.getByText('Depth (Y) 10 mm')` and a count of 1.

### PH-03 (P0). One vocabulary for one number

Status: done. Box, wedge, and ellipsoid fields and handles say Width X, Depth Y, and Height Z. `SIZE_NAME` is gone, so the dimension uses that label. Modifier volumes say Extent X/Y/Z mm, which is the volume's size, not the primitive. `grep` of `src` finds no "Size X/Y/Z". Screenshot: `ph03-after-labels.png`.

- **Seen**: the panel calls the field "Size Y", while the handle, the dimension and the tooltip call it "Depth (Y)"
  (`SIZE_NAME` in `src/handle-emphasis.ts`). Users see two names for one value.
- **Change**: rename the panel labels for box, wedge and ellipsoid to "Width X", "Depth Y" and "Height Z" (markup in
  `src/app/markup.ts`, and every `Size X`/`Size Y`/`Size Z` string in `src/model-drag.ts`). Then drop `SIZE_NAME`, so
  `aspectTip` uses the handle label as is. Update the history labels if they say "size", and update the docs
  (`docs/step-modeler.md`) and the tutorials text.
- **Accept when**: `grep -rn "Size X\|Size Y\|Size Z" src` finds nothing user-facing, and the panel label, handle
  tooltip and dimension text match in a Playwright assertion.

### PH-04 (P0). No per-frame rebuilds while dragging

Status: done. Aspect lines keep their `LineSegments2` and update positions in place. The aspect is recomputed only when the handle, its values, the dimension side, or the ghost changes. Dock inputs are cached when the handles are set. `setAspectDim` does not rebuild the ghost. Dev builds record `window.__frameTimes`.

- **Seen in code**: `paintHandles()` runs on every pointer move during a drag (`moveDrag`, the face drag, the edge
  drag). Each call goes through `paintAspect()`, which:
  - disposes and recreates two `LineSegments2` objects with fresh geometry and a fresh `LineMaterial`
    (`replaceAspect`);
  - runs `document.querySelectorAll("input.is-aspect")` over the whole document;
  - can call `rebuildGhost()` through `setAspectDim`.
- **Change**:
  - Keep one `LineSegments2` per space. Update its geometry in place (`LineSegmentsGeometry.setPositions`) and its
    colour on the material.
  - Recompute the aspect only when the active handle id, its values, or the ghost changes: compare against the last
    key.
  - Keep a `Map<fieldId, HTMLInputElement>` of the Model dock's inputs, built when the tool opens, instead of
    querying the document.
  - `setAspectDim` must not rebuild the ghost: only material opacities change.
- **Accept when**:
  - In `e2e/model-speed.spec.ts`, a 2-second knob drag on the 3,000-face part keeps median frame time ≤ 17 ms.
    Measure with `performance.now()` in a `requestAnimationFrame` loop exposed on `window.__frameTimes` in dev
    builds.
  - The JS heap after the drag grows by < 5 MB.

### PH-05 (P1). No dimming flicker when the pointer crosses handles

Status: done. The lit aspect stays for 120 ms after the pointer leaves a handle, and a move onto the next handle cancels that wait, so the view does not pass through an unlit frame.

- **Seen in code**: moving from one knob to the next toggles `aspectDim` off and on, which flashes the whole view.
- **Change**: keep the lit state for 120 ms after the pointer leaves a handle. Switch straight to the next handle's
  aspect without passing through "none".
- **Accept when**: a pointer path across the three size knobs doesn't toggle `data-aspect-dim` more than once (the
  spec records the attribute's changes through a `MutationObserver`).

### PH-06 (P1). Focus listeners belong to the Model dock, and are removed

Status: done. Focus listeners sit on `#modelPanel` only. `data-focus-syncs` counts calls. Focusing the auto-slice setting does not increment it. The view is created once and is not disposed.

- **Seen in code**: `document.addEventListener("focusin" | "focusout", () => queueMicrotask(syncFocusedField))` in
  `createModelView`. It runs for every focus change anywhere in the app (settings, dialogs, the G-code tab) and is
  never removed.
- **Change**: listen on the Model dock's root element only. Add the listener when the Model view mounts and remove it
  in the view's dispose path, or keep the handler idempotent behind a module-level flag if the view is never disposed.
- **Accept when**: a unit or Playwright check confirms focusing a Settings field doesn't call `syncFocusedField`
  (count the calls through a debug counter).

### PH-07 (P1). Every hole lights the right hole

Status: done. A sketch with several holes gets one depth knob per hole (`holeIndex` on the handle). Focusing "Hole 2 depth" lights hole 2. `data-aspect-at` is that hole's centre.

- **Seen in code**: `aspectContext` uses `current.holes[0]` for a ghost of several holes, so a knob for the third
  hole lights the first.
- **Change**: pass the hole index the handle belongs to (the handle id or seat carries it) and light that one.
- **Accept when**: a Playwright test with two holes from sketch points, focusing hole 2's depth, finds the lit circle
  at hole 2's centre (`data-aspect-at` or a lines-bbox attribute).

### PH-08 (P1). Not by colour alone

Status: done. The field keeps its 2 px ring, gains an X/Y/Z badge, and `aria-describedby` points at a visually hidden sentence. Contrast of the three axis colours against the stage and the ghost is at least 3:1 in dark and light (`e2e/a11y-errors.spec.ts`).

- **Change**:
  - Besides the colour, the lit lines are thicker and the field gets a 2 px ring with a small axis badge ("Y") in the
    field's corner.
  - Link the field to the tip text with `aria-describedby` pointing at a visually hidden element, so screen readers
    say "Depth Y, 10 millimetres, lights the four edges along Y".
  - Check the three axis colours against the ghost and the background in the dark and light themes for 3:1
    contrast.
- **Accept when**: an axe check in `e2e/a11y-errors.spec.ts` covers a Model tool with a focused field, and the
  contrast numbers are recorded in the doc.

### PH-09 (P1). Wider test coverage for the feature

Status: done. `e2e/model-aspect.spec.ts` covers cylinder radius, cone top radius, hole depth, a picked-edge fillet, push/pull distance, the split plane, Tab into Depth and Shift+Tab out, and a pattern count (`mapped: false`).

Playwright cases, in the existing `e2e/model-drag.spec.ts` or a new `e2e/model-aspect.spec.ts`:

- cylinder radius (the rim circle is lit);
- cone top radius (the top rim);
- hole depth;
- fillet radius on a picked edge;
- push/pull distance;
- Split plane;
- a keyboard-only path (Tab into Depth → lit; Shift+Tab out → nothing lit);
- the `mapped: false` case (a count field: tooltip only, solid not dimmed).

Each asserts `data-aspect-field`, `data-aspect-lines > 0` (or 0 for unmapped) and the tip text.

---

## Part 2. The rest of the UI, as the screenshots show it today

### UX-01 (P1). The Model rail needs groups and names, not a column of 20 icons

Status: done. Headings Create, Shape, Features, Inspect, Frame, and Edit stay visible at 1440×900, including while a sketch is open. Tips name the shortcut (hover within 250 ms, and on keyboard focus). Show tool labels is a setting, off by default, and widens the rail to 132 px. Fillet uses the radius icon and Mirror uses a flip icon, so they no longer match Split's square.

- **Seen**: `model-push.png`, `model-history.png`. The left rail is about 20 icon-only buttons. The group headings
  (CREATE, INSPECT) appear only in some states; in others there are only thin separators. Several icons look alike
  (the two "documents", the two squares).
- **Change**:
  - Always show group headings in the rail: Create, Shape, Features, Inspect, Frame, Edit. Use the existing small
    caps style from Prepare (PLACE / VIEW / PAINT).
  - Each button shows its name on hover *and* on keyboard focus within 300 ms, with its shortcut. The tooltips
    already exist; make sure every button has one with the shortcut.
  - Add an optional "Show labels" mode (a setting, off by default) that widens the rail to 132 px with text labels.
  - Swap any icon pair that's hard to tell apart for distinct Lucide icons: list the pairs in the PR.
- **Accept when**: at 1440×900 the rail shows headings in every Model state (sketch, tool open, idle), and
  `e2e/model-layout` asserts each rail button has a non-empty `aria-label` and a tooltip that names its shortcut.

### UX-02 (P1). A disabled control should be quiet, not striped

Status: done. Disabled controls use dim text, a dashed border, and no stripe. Slice and Export keep the stripe only when the part is larger than the bed (`is-error`). The reason tooltip still shows on hover. Screenshots: `after-disabled-stripe.png` (before), `ux02-after-disabled.png`.

- **Seen**: `after-disabled-stripe.png`, `model-history.png`. Disabled buttons get a full-size diagonal stripe:
  Fillet, Chamfer, Undo, Redo, Slice and Export at once. The stripes are the loudest thing on screen when nothing
  can be done.
- **Change**:
  - Disabled: icon and text at `--text-dim`, a 1 px dashed border, no fill pattern, `cursor: not-allowed`.
  - Keep the stripe only on Slice and Export when the reason is an error state (for example "The part is larger than
    the bed"), not for "nothing loaded yet".
  - The "why" tooltip on hover and focus stays as is.
- **Accept when**: screenshots before and after are in the doc, and the a11y spec still finds the reason tooltip on
  focus.

### UX-03 (P1). The sketch card: group the tools, stop the layout shifting, never truncate

Status: done. The card is Draw, Edit, Make, and a footer. Draw is seven icon buttons in a fixed grid. A feature replaces Make with a strip (name, Join/Cut/New object, value, Apply, Cancel). `e2e/model-sketch.spec.ts` checks that Draw does not move and that no button overflows. Screenshots: `ux03-before-sketch-card.png`, `ux03-after-sketch-card.png`.

- **Seen**: `model-sketch.png`, and the tutorials `bowl-03-axis-pick.png` and `handle-05-typed-scale.png`.
  - 11–13 equal buttons in a 3-column grid mix drawing tools (Line, Rectangle, Draw/Arc), modes (Constrain, Select),
    features (Extrude, Revolve, Loft, Sweep), feature options ("Auto · Join (M)") and actions (Look around, Lock
    view, Apply, Finish sketch).
  - The third button changes between "Draw" and "Arc" from one state to the next, so the grid shifts under the
    pointer.
  - "uto · New object (I" is cut off on both sides.
- **Change**: restructure the card into sections, each with a small heading:
  1. **Draw**: Line, Rectangle, Circle, Arc, Spline, Polygon, Slot. These are icon buttons with tooltips and
     shortcuts, in a fixed order that never reflows.
  2. **Edit**: Select, Trim, Offset, Constrain, Construction.
  3. **Make**: Extrude (E), Revolve (V), Loft (⇧L), Sweep (W), Holes. These are text buttons.
  4. While a feature is active, a **feature strip** replaces Make:
     - the feature's name;
     - a segmented control for Join / Cut / New object, with a tooltip that explains M;
     - Flip;
     - the typed value field;
     - Apply (primary) and Cancel.

     Nothing is truncated; long labels wrap to two lines.
  5. **Footer**: Look around / Lock view (one toggle) and Finish sketch (primary when no feature is active).

  The Loft/Sweep pick prompt ("Pick at least two sections to loft.") stays as the strip's first line.
- **Accept when**:
  - No button's text overflows: assert `scrollWidth <= clientWidth` for every button in the card.
  - The Draw section's button positions are identical in every sketch state (a Playwright test compares bounding
    boxes).
  - `e2e/model-sketch` is updated.

### UX-04 (P1). Instructions belong next to the work, not in a status line that gets cut off

Status: done. Feature status titles stay within 40 characters (`featureTitle` in `src/sketch/hints.ts`). The numbered steps sit in a How popover on the feature strip, open the first three times, then behind ?. `src/sketch/hints.test.ts` checks the hint table. The loft Playwright test focuses How and reads the first step.

- **Seen**: `bowl-03-axis-pick.png`, `handle-05-typed-scale.png`. The status bar holds a 200-character paragraph
  ("Revolve 360°, New object. Drag the ring or type the angle. Typing 360 is a full turn. Click a region… Esc
  returns to the sk…"), truncated with an ellipsis.
- **Change**:
  - Split the hint into a **title** (≤ 40 characters: "Revolve 360° · New object") shown in the status bar, and
    **steps**, shown in a small "How" popover next to the HUD or the feature strip. The popover is open the first 3
    times a user starts that feature, then collapses to a "?" button (count in localStorage, try/catch).
  - Write the hints as numbered steps: "1. Click a region. 2. Drag the ring or type the angle. 3. Enter applies, Esc
    cancels."
- **Accept when**: no status bar text is longer than 80 characters (a unit test over the hint table, wherever the
  hints are defined: `src/app/sketch.ts` and the model hint strings), and the popover is reachable by keyboard.

### UX-05 (P1). Put the typed value at the thing being changed

Status: done. The HUD anchors to the handle, 16 px along its screen direction, and stays on the canvas. The unit and the ƒ mark sit inside the field. Playwright checks extrude, revolve, and sweep scale stay within 120 px of the handle.

- **Seen**:
  - `handle-05-typed-scale.png`: the sweep's "0.6 ×" box floats at an unrelated spot, far from the path's end it
    scales.
  - `bowl-03-axis-pick.png`: the revolve "360" field has its "°" outside the box.
- **Change**:
  - The HUD (`src/interact/hud.ts`) anchors to the active handle's screen point, offset 16 px along the handle's
    screen direction, and stays inside the canvas.
  - The unit ("°", "×", "mm") is inside the field, as a suffix.
  - The field shows the value with the expression mark "ƒ" inside when the value came from a parameter. Today the
    mark sits under the field: `model-parameters.png`, below Size Z.
- **Accept when**: in Playwright, the HUD's bounding box is within 120 px of the handle's projected point for
  extrude, revolve and sweep scale, and the unit element is a child of the input's wrapper.

### UX-06 (P1). Boolean and New solid: handles on the ghost, not a gizmo at the side

Status: done. Move arrows and turn rings sit on the ghost's centre, and size knobs sit on its faces. The side gizmo is only the fallback when that centre is off the canvas or the ghost is under 24 px. `data-handle-seat` is inside the ghost's screen box plus 40 px. Screenshots: `before-handle-ghost.png`, `ux06-after-handles.png`.

- **Seen**: `before-handle-ghost.png`. The ghost cube sits on the part while its move/turn gizmo floats at the right
  edge of the view, far from it. This goes against the "drag the thing itself" rule in `docs/plan-gui-cad-modeling.md`
  D6.
- **Change**:
  - Draw the move arrows and turn rings seated on the ghost's centre, scaled to the ghost's size on screen, as the
    push/pull arrow is.
  - Keep the docked gizmo only as a fallback when the ghost is off screen or smaller than 24 px.
  - The size knobs sit on the ghost's faces (one per axis) and drag along their axis.
- **Accept when**: the handle's seat is within the ghost's screen bounding box, expanded by 40 px. Assert through
  `data-handle-seat` on the canvas, or the existing handle data attributes.

### UX-07 (P1). The Parameters section shouldn't take a third of the Model panel when it's empty

Status: done. With no parameters the section starts collapsed (`Parameters · 0`), History sits above it, and one click or Ctrl+Alt+P opens it. The fold is stored per project. An empty section hides while a sketch is open; the Features menu and Ctrl+Alt+P still open it. Screenshots: `ux07-before-params.png` (the old expanded empty section), `ux07-after-params.png`.

- **Seen**: every Model screenshot shows "PARAMETERS · 0", empty Name and Value fields, and "Add parameter", even
  while sketching, where it pushes the history down.
- **Change**:
  - Collapse the section by default when it has 0 parameters. The header reads "Parameters · 0", and clicking it
    opens it.
  - Remember the open state per project.
  - In sketch mode, hide the section unless a parameter is in use by the sketch.
  - The Features menu entry and Ctrl+Alt+P still open it.
- **Accept when**: with no parameters, the Model panel shows History directly under the tool card (a Playwright
  bbox check), and the section opens with one click or Ctrl+Alt+P.

### UX-08 (P2). History rows say what the user did

Status: done. History shows "Extrude Sketch 1, 20 mm" (and the same shape for revolve and loft). A file pose is the line "Placed as in the file", and a changed pose stays the Position row. The plate chip's tip is "This step is what the plate slices." Stored `opLabel` is unchanged. Screenshots: `ux08-before-history.png`, `ux08-after-history.png`.

- **Seen**: "Revolve 1-loop profile 270°", "Loft through 2 sections", "Position At file position", and "Box
  30×30×16" with a "Plate" chip.
- **Change**:
  - Feature labels use the sketch name and the main value: "Revolve Sketch 1, 270°", "Loft Sketch 1 → Sketch 2",
    "Extrude Sketch 1, 20 mm, cut".
  - "Position" reads "Placed as in the file" and moves into the header as a small line, not a history row, unless it
    was changed.
  - "Plate" gets a tooltip: "This step is what the plate slices."
  - Keep `opLabel` as the fallback for MCP-made steps.
- **Accept when**: unit tests in `src/model-tree.test.ts` cover the new labels, and the history screenshots are
  updated.

### UX-09 (P2). The selection chip should say what is selected

Status: done. The faded chip reads "1 face ▾" (or "3 edges ▾") in the dock surface colour, and sits beside the solid. The pick-filter count uses the same surface. Screenshots: `ux09-before-chip.png`, `ux09-after-chip.png`.

- **Seen**: `after-selection-chip.png`. A white "Selection" chip floats above the box, and the "1 face" count is a
  low-contrast pill in the Face/Edge switch.
- **Change**: the chip reads "1 face ▾" (or "3 edges ▾"), uses the dock surface style (dark, not white, in the dark
  theme), and sits next to the selection's screen box, not centred above the canvas. Drop the duplicate count pill,
  or make it match the chip.
- **Accept when**: the chip text matches the selection count in Playwright, and its colour follows the theme
  tokens.

### UX-10 (P2). "Slicing paused while modeling" once, not always

Status: done. With a slice already on screen, the line shows for 4 seconds when Model opens, then a dot beside Slice keeps the tooltip. Leaving Model for Prepare after a change says "Slice again to include your changes". Screenshots: `ux10-before-pause.png`, `ux10-after-pause-dot.png`.

- **Seen**: the chip is in the status bar of every Model screenshot.
- **Change**: show it for 4 s when Model opens with a slice that will need redoing, then keep it as a small dot with
  a tooltip next to the Slice button. On return to Prepare, say "Slice again to include your changes" if the plate
  changed.
- **Accept when**: the chip isn't visible 5 s after entering Model (Playwright with fake timers or a wait).

### UX-11 (P2). Prepare: the Objects toolbar wraps

Status: done. The Objects toolbar is one line. What does not fit moves into the ⋯ menu. Tips name a shortcut when the command has one: Arrange (A), Duplicate (Ctrl+D), Lay flat (F). Check and Frame stay text. Screenshots: `ux11-before-tools.png`, `ux11-after-tools.png`.

- **Seen**: `prepare.png`. The Objects card's icon row wraps one icon (↻) onto a second line. The icons have no
  labels.
- **Change**: fit the row on one line with an overflow "⋯" menu for the less-used actions. Give every icon a tooltip
  with its shortcut. "Check" and "Frame" on the object card stay as text buttons.
- **Accept when**: the row's height equals one button's height at 1366×768 and 1440×900.

### UX-12 (P2). Dimension labels on the solid don't collide

Status: done. Bounding-box callouts stand 12 px off the edge, and a label that would still meet the solid's projected box is pushed until it clears that box by 12 px. A shorter label is hidden when it would overlap a longer label or that label's leader. Screenshots: `ux12-before-dims.png`, `ux12-after-dims.png`.

- **Seen**: on the box and loft shots the "30.0 mm" and "18.0 mm" labels sit on the part's silhouette edges and touch
  the outline. On the revolve, "8.0 mm" crowds the "60.0 mm" leader.
- **Change**: offset the bounding-box dimensions outside the silhouette (a screen-space 12 px gap), and hide a label
  when it would overlap another (keep the longer axis).
- **Accept when**: a Playwright test confirms the three dimension labels' screen boxes don't intersect each other or
  the solid's projected box, on the standard iso view.

---

## Order

1. PH-01 to PH-04 (P0). The branch can merge after these.
2. PH-05 to PH-09.
3. UX-03, UX-04 and UX-05 together, because they share the sketch card, the hints and the HUD.
4. UX-01, UX-02, UX-06 and UX-07.
5. The P2 tasks, in any order.

PH-01 to PH-04 and UX-01 to UX-07 each come with screenshots before and after, added to
`docs/screenshots/ui-review-3-2/` and described in the review doc.

---

## Round 2: review of `586f1de..affa39a` (2026-10-21)

Round 1 is a clear step forward:

- one name for each dimension;
- an opaque solid;
- quiet disabled tools;
- a folded empty Parameters section;
- handles on the ghost.

These findings come from reading the diff and the new screenshots, and from running the specs. The typecheck and
unit tests pass. In `model-drag`, `model-sketch`, `model-layout`, `model-speed`, `model-holes`, `ui-review`,
`window-fit` and `compact-layout`, 49 of 50 tests pass. The one failure is R2-01.

The same rules as round 1 apply:

- one commit per task, with its ID in the subject (`R2-03: …`);
- the named specs must pass;
- checks count only in the build Playwright runs (`vite build` plus `vite preview`). Don't mark a task done until
  its check has passed in that build.

### R2-01 (P0). The frame-time check must run in the build Playwright tests

- **Seen**:
  - `recordFrame` in `src/model-view.ts` writes `window.__frameTimes` only when `import.meta.env.DEV` is set.
  - Playwright serves `vite preview`, which is a production build, so the list stays empty.
  - As a result, `e2e/model-speed.spec.ts:312` fails with "Expected: > 10, Received: 0". PH-04's "≤ 17 ms" was never
    measured.
- **Change**:
  - Measure from the test instead of the app. Before the drag, `page.evaluate` starts a `requestAnimationFrame` loop
    that records the gap between frames. Read the times and stop the loop after the drag.
  - Delete `recordFrame` and `__frameTimes` from `src/model-view.ts`.
  - If an in-app hook is truly needed, gate it on a query flag the spec sets (`?perf=1`), not on `DEV`, and cap the
    list at 600 entries.
- **Accept when**: `npx playwright test e2e/model-speed.spec.ts` passes against the preview build, and the assertion
  message prints the median it measured. Record that number in the task status.

### R2-02 (P0). `preserveDrawingBuffer` off for users

- **Seen**: `new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })` at
  `src/model-view.ts:254`. It was added so a test can read a pixel, but it slows every Model frame for every user.
- **Change**:
  - Create the renderer without it.
  - For PH-01's pixel check, read the pixel within the frame: `page.evaluate` waits for the next
    `requestAnimationFrame`, then calls `gl.readPixels` before the browser composites.
  - Or use `canvas.toDataURL()` right after a forced render, through a test hook gated as in R2-01.
- **Accept when**: `grep -n preserveDrawingBuffer src` finds nothing, and the PH-01 colour check in
  `e2e/model-drag.spec.ts` still passes.

### R2-03 (P0). Draw the lit edges once: solid where seen, dashed where hidden

- **Seen**: in `replaceAspect`:
  - The visible pass has `depthTest: false`, so it draws the whole edge through the solid.
  - The hidden pass (`GreaterEqualDepth`, dashed, darkened to 35%) then draws over it, with `renderOrder 9`.
  - Behind the solid, users see a full-colour line with dark dashes on top. That's the pale, broken look in
    `ph01-after-axis.png`, `ph02-after-dimension.png` and `ph08-after-badge.png`.
- **Change**:
  - Visible pass: `depthTest: true` and `depthFunc: LessEqualDepth`. The ghost has `depthWrite: false`, so the line
    still reads through the ghost.
  - Hidden pass: stays dashed, with `GreaterDepth`, at 60% of the axis colour rather than 35%, so it reads on the
    dark stage.
  - Keep `renderOrder` above the solid's.
- **Accept when**:
  - The PH-01 pixel check passes at a visible edge's midpoint.
  - A new check samples a point on an edge behind the solid. That point isn't the full axis colour, and along 20 px
    the samples alternate between line and background (dashed).
  - `ph01-after-axis.png` and `ph08-after-badge.png` are retaken.

### R2-04 (P0). Typed-value boxes light their handle again

- **Seen**:
  - PH-06 moved the `focusin`/`focusout` listeners to `#modelPanel`.
  - The typed-value box (`src/interact/hud.ts`) is mounted on the canvas's parent, outside the panel. It's mounted by
    `src/app/sketch.ts:611`, `src/push-pull-ui.ts:117` and `src/app/edge-drag.ts:135`.
  - So focusing that box no longer lights its handle.
- **Change**:
  - Listen on the panel and on each mounted HUD element.
  - Either `mountHud` takes an `onFocusChange` callback, or the view exposes `watchFocus(element)`, called when a HUD
    mounts and undone when it unmounts.
  - Settings fields must still not trigger a sync.
- **Accept when**:
  - A Playwright test opens extrude in a sketch, Tabs into the HUD's distance field, and sees `data-aspect-field`
    name it.
  - Focusing a Settings field still leaves `data-focus-syncs` unchanged.

### R2-05 (P1). Work out the ghost seats once per ghost, not per frame

- **Seen**: `sizeHandles()` runs every frame (`src/model-view.ts:1464`) and on every pointer move (`handleAt`). It
  now calls:
  - `readGhost()`, which runs `Box3.setFromObject` over the ghost;
  - `facePoint()` for every face knob, which walks every ghost vertex;
  - `placeAspectLabel()` → `labelCoversKnob()`, which calls `getBoundingClientRect` on the label and the canvas.
    That forces a layout each frame.
- **Change**:
  - Cache the ghost's world box and its six face points, keyed on `ghostSerial`. Only re-project them per frame.
  - Skip `readGhost` when no handle has `seat.at === "ghost"`.
  - Run `labelCoversKnob` only when the label moves by more than 2 px or the aspect key changes. Use the label's size
    cached when its text changes.
- **Accept when**:
  - The measured median frame time is ≤ 17 ms on the 3,000-face part (R2-01's test), and on a 40-hole sketch ghost
    as a second case.
  - A Performance trace of a 2 s drag shows no "Forced reflow" warning from `model-view.ts`.

### R2-06 (P1). Take out the "Hole N depth" buttons

- **Seen**: PH-07 added a row of buttons, "Hole 1 depth", "Hole 2 depth" and so on (`paintHolePicks` in
  `src/ui/model-chrome.ts`). Their only job is to take focus. Clicking one changes nothing, and with 20 holes there are
  20 of them.
- **Change**:
  - Remove `paintHolePicks` and `#modelHolePicks`.
  - Keep `holeIndex` on the handles, so hovering or dragging hole 2's own depth knob lights hole 2.
  - The panel's single depth field (one number for the group) lights every hole in the group. Show each lit hole's
    rim, not just the first.
- **Accept when**:
  - The `e2e/model-holes.spec.ts` test "focusing hole 2's depth lights hole 2" is rewritten to hover hole 2's knob
    (from `data-handles`), and checks `data-aspect-at` against `data-hole-centres`.
  - Focusing the panel's depth field gives `data-aspect-lines` that cover all the holes.
  - No element has an id starting with `modelHoleDepth-`.

### R2-07 (P1). Remember Parameters open or closed per project, keyed properly

- **Seen**: the key comes from
  `projectId: () => state.plate.objects.map((object) => object.id).join(",")` in `src/app/model.ts:575`. That key:
  - changes whenever a part is added or removed;
  - can match between two projects with the same ids;
  - leaves a new localStorage entry each time.
- **Change**:
  - Key on the project's saved path, or on the `.lime` file's own id if it has one.
  - For a project that hasn't been saved, use one shared key.
  - Keep at most 50 such keys: drop the oldest when writing the 51st.
  - Re-run `syncSketchVisibility` when a parameter is added or removed, not only when `data-sketch` changes.
- **Accept when**: a unit test in `src/ui/parameters` (or `src/params.test.ts`) shows:
  - the open state survives adding a part;
  - the state differs between two saved paths;
  - the key count stays at 50 or fewer after 60 projects.

### R2-08 (P1). Rail headings fit, and stay on laptop screens

- **Seen**:
  - "FEATURES" is clipped at the left edge in `ux02-after-disabled.png` and `ux09-after-chip.png`.
  - Below 820 px tall the headings are hidden (`@media (min-height: 820px)` in `src/ui/model-dock.css`). So at
    1280×800 and 1366×768 there are none (`ux10-after-pause-dot.png`).
- **Change**:
  - Make the headings fit the rail's width. Use smaller letter-spacing, or shorter words ("Make", "Shape", "Feat.",
    "Check", "Frame", "Edit") with the full name in the heading's `title`.
  - Show the headings down to 720 px tall, by using the 2 px dense spacing first. Drop headings only when a whole
    group has to fold into the flyout.
- **Accept when**: in `e2e/model-layout.spec.ts`, at 1440×900, 1366×768 and 1280×800, every heading is visible with
  `scrollWidth <= clientWidth`, and every rail tool is still reachable.

### R2-09 (P1). The sketch card's feature strip reads as a form, not a centred stack

- **Seen**: in `ux03-after-feature-strip.png`, while Loft is active:
  - the prompt, the name, Join/Cut/New object, Smooth, Apply and Cancel are a centred column of different widths;
  - Smooth sits alone on its line;
  - Apply isn't styled as the main button;
  - the prompt is centred text.
- **Change**: lay the strip out left-aligned, at the full card width:
  1. the prompt, as a note (the same style as other panel notes);
  2. the name and the segmented Join / Cut / New object, on one row;
  3. options (Smooth, Flip, the value field), on one row;
  4. Apply (primary) and Cancel, on one row and right-aligned, as in the other Model tools.
- **Accept when**: in `e2e/model-sketch.spec.ts`, with Loft active and again with Extrude active:
  - Apply and Cancel share a top edge, within 1 px;
  - Apply has the primary class;
  - every strip control's left edge matches the card's content edge, within 1 px, except buttons on a shared row.

  Retake both `ux03-after-*` screenshots after UX-02, so they show the dashed disabled style.

### R2-10 (P2). Small fixes

- **Screenshot for UX-05**: `ux05-after-hud.png` is a 40 px crop of the field. Replace it with a canvas shot that
  shows the box next to the extrude arrow it belongs to.
- **Selection chip spacing**:
  - `ux09-after-chip.png` renders "1face ▾". Check the chip's CSS (letter-spacing, `white-space`, or a font without a
    regular space) so the label reads "1 face ▾".
  - Add a Playwright check that the chip's `innerText` is `1 face ▾`.
- **Screenshots left in the tree**: the specs write to `docs/screenshots/` on every run, so a local test run leaves
  changed PNGs in the tree. Write screenshots only when `UPDATE_SCREENSHOTS=1` is set.
- **Engine check**: run the byte-for-byte engine comparison on a machine with the slicer binary before the PR, or say
  in the PR that it wasn't run.

### Round 2 order

1. R2-01 to R2-04 (P0). Open the PR after these. Round 1's P2 tasks and R2-05 onward can follow in the same PR.
2. R2-05 to R2-09.
3. R2-10.

---

## Round 3: keyboard shortcuts (2026-10-21)

This round comes from an audit of every shortcut on `dev/ui-review` at `3c4c6e7`. It covers:

- the registry in `src/ui/commands.ts`, which feeds the `?` sheet, the palette, tooltips and `src/ui/keys.ts`;
- the keys handled locally in `src/app/sketch.ts`, `src/sketch/session.ts`, `src/app/edge-drag.ts`,
  `src/interact/hud.ts`, and the paint and support-edit UIs.

Within one context, no key press runs two commands; `src/ui/commands.test.ts` checks that. The problems are:

- Prepare keys that still fire in other stages, clicking buttons that aren't on screen;
- a whole set of sketch keys the registry doesn't know about;
- a few keys that mean different things in different places.

Rules:

- The same as rounds 1 and 2: one commit per task, with its ID in the subject (`R3-02: …`).
- The registry stays the single list of keys. A local handler may still do a key's work, but the key must be declared
  in `COMMANDS`.
- Every new or moved key appears in the `?` sheet and in its button's tooltip.

### R3-01 (P0). Prepare's keys stop firing in other stages

- **Seen**: these commands have scope `always`, but the buttons they click (`target`) live in a rail set shown only in
  some stages (`railSet(...)` in `src/ui/chrome.ts`). In other stages, `runCommand` clicks a hidden button: nothing
  changes on screen, but the state of the other stage does.

  | Keys | Commands | Where the button is | What goes wrong elsewhere |
  |---|---|---|---|
  | M, R | `tool-move`, `tool-rotate` | Prepare | In Model, they switch Prepare's gizmo mode unseen |
  | F | `tool-layflat` | Prepare | Clicks Prepare's Lay flat from Model or Preview |
  | B, K, N | `paint-supports`, `paint-seam`, `paint-reinforce` | Prepare | They turn a brush on in Model or Preview. Brushes only switch off when the stage *leaves* Prepare |
  | E | `edit-supports` | Preview, G-code | Hidden click in Prepare and Model |
  | C, Shift+M | `tool-section`, `measure` | Prepare, Preview, G-code | In Model they act on hidden controls. Model has its own Measure tool |
  | T, Y, I | `view-top`, `view-front`, `view-iso` | `#viewPresets` (Prepare's viewer) | In Model they move a camera nobody can see |
  | / and Ctrl+F | `search` (`find` scope) | Settings search | In Model the left dock is the Model panel, so focus goes to a hidden field |
  | Shift+1 to Shift+5 | `strategy-*` | Prepare's strategy cards | They change the slicing strategy from Model, with nothing on screen to show it |

- **Change**:
  - Let `when` take a list of stages as well as a named scope, for example `when: ["prepare", "preview", "gcode"]`.
    `SCOPES` gains a helper that checks `!c.helpOpen && list.includes(c.stage)`.
  - New scopes:
    - M, R, F, B, K, N: `prepare`. A already is.
    - E: `["preview", "gcode"]`, matching its rail set.
    - C and Shift+M: `["prepare", "preview", "gcode"]`. Shift+M in Model is R3-04.
    - T, Y, I: the stages whose viewer `#viewPresets` drives. Check `src/app/viewer.ts` for whether that's Prepare
      only or Prepare and Preview. Model's views are R3-04.
    - `find`: also requires `stage !== "model"`.
    - `strategy-*`: `["prepare", "preview"]`.
  - In `runCommand`'s default branch, don't click a target that isn't rendered (`!el.isConnected || el.closest("[hidden]")`
    or `getClientRects().length === 0`). This is a safety net. The scopes are the fix.
- **Accept when**: a new unit test in `src/ui/commands.test.ts` builds a `KeyContext` for each stage (prepare,
  preview, gcode, model) and checks:
  - `resolveKey` for M, R, F, B, K, N, E, C, T, Y, I, "/", Ctrl+F and Shift+1 returns `null` in every stage the
    command's button isn't in;
  - in the stages where the button is, each still returns the same command as before.

  A Playwright check in `e2e/model-layout.spec.ts` opens Model and presses M, then returns to Prepare: the Prepare
  rail's pressed tool is unchanged.

### R3-02 (P0). Declare the sketch's keys in the registry

- **Seen**: the sketch handles its own keys in `src/app/sketch.ts:417` and in `sketchKey` and `sketchHandlesKey`
  (`src/sketch/session.ts:457`). The keys are:
  - drawing tools: L Line, R Rectangle, C Circle, A Arc (Shift+A tangent arc), N Polygon, Shift+S Slot, B Spline;
  - editing tools: T Trim, F Offset, G Fillet corner, U Use, X Construction;
  - view: O Look around;
  - features: E Extrude, V Revolve, Shift+L Loft, W Sweep, H Holes;
  - while a feature is active: M Join/Cut/New object, R Smooth (loft only), Enter, Esc, Tab;
  - Del and Backspace (delete), Ctrl+Z and Ctrl+Y (sketch undo).

  None of these is in `COMMANDS`, so:
  - the `?` sheet doesn't list them;
  - the overlap test never checks them;
  - Model rail tooltips show the Model meaning while the sketch has taken the key. "Pick edges (W)" and
    "Chamfer (Shift+L)" show while W is Sweep and Shift+L is Loft.
- **Change**:
  - Add `"sketch"` and `"sketch-feature"` to `KeyScope`. Add `sketchOpen` and `sketchFeature` to `KeyContext`,
    read from `#model[data-sketch="editing"]` and the active feature.
  - The `model` scope requires `!c.sketchOpen`. `sketch` requires `stage === "model" && c.sketchOpen`.
    `sketch-feature` requires a feature to be active.
  - Add one `COMMANDS` entry per sketch key above: group "Sketch", labels as on the sketch card,
    `show: "help"`. Their `runCommand` cases call into the sketch module through a small exported dispatcher, for
    example `runSketchKey(id)`, so `sketch.ts` keeps the behaviour.
  - Remove the matching `if (ev.key === …)` branches from the sketch's window listener, so each key has exactly one
    handler. The sketch's text-field and HUD rules (a letter in a field is text) move into `fires()` as they already
    exist there (`typing`).
  - Tooltips are worked out per scope: a rail button whose command is shadowed by an active sketch command shows no
    key while the sketch is open.
- **Accept when**:
  - The `?` sheet has a "Sketch" group listing every key above. Playwright opens the sheet during a sketch and finds
    "Loft" next to "Shift+L".
  - `src/ui/commands.test.ts`: with `sketchOpen: true`, every letter key resolves to a sketch command or `null`, never
    a `model` command.
  - The existing `e2e/model-sketch*.spec.ts`, `model-loft`, `model-revolve`, `model-sweep` and `model-holes` specs
    pass unchanged.
  - `grep -n 'ev.key === "w"' src/app/sketch.ts` finds nothing.

### R3-03 (P0). Number keys don't leave Model in the middle of a sketch

- **Seen**: `tab-prepare` to `tab-model` (1 to 4) are `always` and not `typing`. The sketch doesn't take digits, so
  typing "25" for a line's length before clicking into the size box switches the app to Preview mid-sketch.
- **Change**: while `sketchOpen`, a digit, ".", "-" or "(" focuses the active tool's size box and goes into it, as
  `src/app/edge-drag.ts:547` already does for the edge drag. With no size box to take it, the key does nothing. The
  stage keys get `when` that excludes `sketchOpen`. Ctrl+1 to Ctrl+4 are not added: the stage tabs stay one click
  away.
- **Accept when**: a Playwright test opens a sketch, picks Line, clicks one point, and types `2` `5` Enter. The stage
  is still Model (`#tabModel[aria-selected="true"]`), and the line is 25 mm.

### R3-04 (P1). Same job, same key, in Model too

- **Measure**:
  - Seen: Shift+M toggles Prepare's rulers (`#measureField`). Model's own Measure tool (`#modelToolMeasure`) has no
    key.
  - Change: add `model-measure`, Shift+M, scope `model`, target `#modelToolMeasure`, placed before `measure` in
    `COMMANDS`.
- **Camera views**:
  - Seen: T, Y and I are Top, Front and Iso in Prepare but do nothing visible in Model, which has only Home.
  - Change: add `model-view-top`, `model-view-front` and `model-view-iso` (T, Y, I, scope `model`), wired to the Model
    view's camera presets. Expose them from `createModelView` if they don't exist. Inside a sketch, T stays Trim:
    the `sketch` scope wins.
- **Scale**:
  - Seen: Scale is S in Prepare and X in Model (S is Sketch).
  - Change: keep both keys. Label the Model command "Scale solid" with its key in every place it appears (rail tip,
    palette, sheet), so the difference is plain.
- **Loft's R**:
  - Seen: the card says "Smooth", the code says `ruled`, and R is Rectangle the rest of the time.
  - Change: the button reads "Smooth (R)" and its tooltip says R toggles it. The `R3-02` entry is labelled "Smooth
    loft".
- **Export**:
  - Seen: Ctrl+E is G-code export everywhere. Model's STEP export has no key.
  - Change: no new key. In Model, the Ctrl+E tooltip and palette row say "Export G-code", so nobody expects a STEP.
- **Accept when**:
  - Unit tests: in Model with no sketch, Shift+M resolves to `model-measure`, T to `model-view-top`, and so on. In a
    sketch, T resolves to the sketch's Trim.
  - Playwright: in Model, pressing T then I changes `data-camera` (or whichever attribute `publishCamera` writes) to
    the top and then the iso pose.

### R3-05 (P1). One test that keeps keys honest

- **Change**: extend `src/ui/commands.test.ts` with a table-driven check over every combination of:
  - stage (4);
  - sketch open or not;
  - a sketch feature active or not;
  - a brush on or not;
  - help open or not;
  - a slice running or not;
  - typing or not.

  For each, and for every chord in `COMMANDS`:
  1. at most one command fires;
  2. a command with a `target` fires only in stages where that target's rail set or panel is shown. Keep a small map
     from target selector to stages in the test, and fail when a new target is missing from the map.
- **Accept when**:
  - The test fails on today's registry, because of the R3-01 leaks, and passes after R3-01 to R3-04.
  - It runs from `tools/unit-tests.txt` (`npm run test:unit`).

### R3-06 (P2). Small fixes

- **Duplicate icon**: after UX-01, the sketch's Arc button and Model's Fillet both use Lucide's `Radius`. Give Arc
  its own icon (a quarter-arc SVG drawn in the Lucide style; Spline already uses `Spline`) so the two never look the
  same.
- **The sheet's mouse hints**: `MOUSE_HINTS` lists "Shift+click" twice with two meanings. Name the context: "Model:
  add or remove a face or edge" and "Paint: a straight line from the last dab".
- **Sketch tool tips**: the Edit section's buttons (Select, Trim, Offset, Constrain, Construction, Fillet corner,
  Use) show their key in the tooltip as the Draw buttons do, from the R3-02 entries rather than hand-written strings.

### Round 3 order

1. R3-01 and R3-05 together: the test shows the leaks, then the scopes close them.
2. R3-02, then R3-03, since R3-03 needs `sketchOpen` from R3-02.
3. R3-04.
4. R3-06.

Round 3 can land in the same PR as round 2, or in a PR of its own straight after it.
