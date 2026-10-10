# UI plan for support tree edits

Steps 6a and 6b of [support-edits.md](support-edits.md) are in the engine and in the desktop preview. Compact uses the same editor: the same edit list, the same pick, and the same slice request. This note matches what is built.

The part stays primary. Prune and regrow rebuild support layers only. Grid supports keep the coverage warning and get no pick, prune, or regrow.

## What both layouts share

`mountSupportEdits` in `src/ui/support-edit-ui.ts` owns the session. A tap or click builds a ray in print space. `pickLimb` / `pickGap` choose a limb or a coverage gap. Branch and tree are the same prune; `sitesOf` turns the selection into birth sites. `regrowFor` turns a gap into `Regrow { region, z }` using that gap's bounds and its own z range, low then high. `editRequestFields` posts `supportEdits` and `includeSkeleton` only while the support style is tree. The response's `supportEdits` outcomes and `skeleton` drive the badges, the toast, and the amber highlight. `coverageWarning` is the banner line.

Loading a new mesh clears the list. A later slice of the same part replays it. A site that no longer matches is flagged and stays until the user drops it.

## Desktop

Edit mode is the tree button, E, or the command palette. Hover highlights the limb under the cursor. Click selects it. Shift toggles branch and tree. The bar offers Delete and Regrow, and the panel lists edits with Undo, remove, and Clear. Gap outlines draw in the 3D view while editing.

## Compact

The phone layout does not use the desktop bar. After a slice that returned a skeleton, a 36px tree button (44px hit) sits on the preview. The More menu's Edit supports item opens the same mode. The preview sheet opens to the 56px peek, and the 3D view keeps at least 70% of a 390×844 screen.

- Tap a support to select that branch. Long-press selects the whole tree. The tap does not hide the chrome.
- The peek names the selection (branch or tree, and the tip's contact height, or the tip count). A coverage gap with nothing selected shows the real coverage warning.
- A chip at the bottom of the 3D view says Prune or Regrow. Prune appends the selection's sites. Regrow appends `regrowFor` for the selected gap.
- Drag the sheet to half. The edit list, Undo, Clear, and each gap's Regrow button are the desktop panel, reparented into the sheet. The canvas is the area above the sheet, so the model stays framed in what is still visible.
- Grid style, or a slice with no skeleton, does not offer the button. The list explains that tree supports are off.

A one-finger drag still orbits. Compact regrow uses the gap's own bounds and z range, not a rectangle drawn on the canvas.

## What is not mocked

Picking, prune, regrow, undo, clear, the skeleton highlight, the coverage banner, and the slice request are the real API. Nothing in this editor invents a tip site or skips `supportEdits`.

The rest of the compact shell lacks these, and support edits do not depend on them:

- There is no playback speed multiplier.
- On-device slicing is not built. The browser still slices over HTTP.
