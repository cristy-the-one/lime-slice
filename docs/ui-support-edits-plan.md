# UI plan for support tree edits

Engine steps 1–5 in [support-edits.md](support-edits.md) are in the core. Step 6 is not: the slice request does not take `support_edits` yet, and the response has no tree outline to pick against. This note is only how the UI will call that step. No UI for it is built here.

The part stays primary. Prune and regrow rebuild support layers only. Grid supports keep the coverage warning and get no pick, prune, or regrow.

## What the UI already has

A finished slice can already carry `coverage`: unheld interface, with a Z range, an area, and an outline. The banner shows that warning today. The 3D view is `#view3d` on the desktop shell and the same canvas on the compact phone layout. Both can take a pointer. Neither can name a limb, because the preview only has support toolpaths, not the forest.

## Pick

Picking uses the compact tree outline from step 6, not the extruded beads. A limb in one plan is a walk node. The edit that gets stored is the tip site: birth position plus contact height in millimetres, so it still matches after a re-slice renumbers the walk.

Desktop: a ray from the 3D camera through the pointer. The nearest limb under the cursor highlights. A click selects that limb's tip site. Clicking the trunk of a tree selects every tip that tree still carries. Clicking a branch selects that branch's tip. Branch and tree are the same prune; only the set of sites changes.

Compact: the same ray from a tap on the 3D canvas. The tap must miss the top bar and the sheet. The selected limb gets a short label (branch or tree, and the site) in the sheet, because a phone has no hover.

## Prune

Prune sends `Prune { sites }` for the selection. The UI does not ask the engine to delete "a branch" as a different operation.

If the edit leaves part of the object floating, the slice comes back with a coverage warning and the area that edit newly dropped. The UI shows the warning and draws the gap outline. It does not block the delete. Grid style never offers prune.

A later slice of the same part replays the edit list. A site that no longer matches a born tip is flagged in the sheet and left in the list until the user drops it.

## Regrow

Regrow sends `Regrow { region, z }`. `z` is a range, low then high, not a single top height. The natural range is the coverage gap's own `z`. The region is the gap outline, or a rectangle the user drags.

Desktop: choose the gap in the banner, or drag a rectangle on the 3D view. The drag is the same pointer as the region-blend plane, but it edits supports only while the support tool is on, and it does not move the blend split.

Compact: the sheet lists the coverage gaps. Tapping one arms regrow with that gap's range and outline. A drag on the canvas replaces the outline with the finger's rectangle. The sheet stays at the bottom so the drag stays on the part.

Regrowing a region that holds nothing is `Stale` and must not look like a new slice. The button stays idle and the current preview stays.

## What step 6 has to add

On the request, `support_edits`: a list of prune and regrow values, in the order the user made them. Omit the field when the list is empty, so an untouched slice keeps today's cache key and today's G-code bytes.

Each prune stores tip sites `{ x, y, z }` where `z` is the contact height. Each regrow stores a region in the bed plane and a Z range.

On the response, a compact tree outline for picking: one entry per limb with its tip site, whether it is a branch or the tree root, and a short polyline (or the disk centers) the ray can hit. Support paths for the layers the edit changed come back as they do now. The UI does not need the full knot state.

## What stays mocked until step 6

Until the request accepts `support_edits` and the response includes the outline:

- The support tool can select a coverage gap that is already on the response, and it can draw that gap's outline. That data is real.
- A pick on a tree is fake. The stand-in is the support-coloured preview paths, hit in screen space. It can show a highlight. It must not be sent as a tip site, because a toolpath point is not a birth site.
- Prune and regrow append to a client-side list and show it in the sheet. The list is not posted, and it does not change the recipe key. The slice button still slices the unedited part.
- A regrow preview is the gap outline plus a caption that the engine has not grown tips yet. No second mesh, no invented branches.
