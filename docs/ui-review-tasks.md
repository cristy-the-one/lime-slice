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

- **Seen**: `after-selection-chip.png`. A white "Selection" chip floats above the box, and the "1 face" count is a
  low-contrast pill in the Face/Edge switch.
- **Change**: the chip reads "1 face ▾" (or "3 edges ▾"), uses the dock surface style (dark, not white, in the dark
  theme), and sits next to the selection's screen box, not centred above the canvas. Drop the duplicate count pill,
  or make it match the chip.
- **Accept when**: the chip text matches the selection count in Playwright, and its colour follows the theme
  tokens.

### UX-10 (P2). "Slicing paused while modeling" once, not always

- **Seen**: the chip is in the status bar of every Model screenshot.
- **Change**: show it for 4 s when Model opens with a slice that will need redoing, then keep it as a small dot with
  a tooltip next to the Slice button. On return to Prepare, say "Slice again to include your changes" if the plate
  changed.
- **Accept when**: the chip isn't visible 5 s after entering Model (Playwright with fake timers or a wait).

### UX-11 (P2). Prepare: the Objects toolbar wraps

- **Seen**: `prepare.png`. The Objects card's icon row wraps one icon (↻) onto a second line. The icons have no
  labels.
- **Change**: fit the row on one line with an overflow "⋯" menu for the less-used actions. Give every icon a tooltip
  with its shortcut. "Check" and "Frame" on the object card stay as text buttons.
- **Accept when**: the row's height equals one button's height at 1366×768 and 1440×900.

### UX-12 (P2). Dimension labels on the solid don't collide

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
