# Plate placement

Judged against the note on `docs/plate-placement-concepts` and the Prepare code on main. Where the note and the code disagree, the code wins. This does not add a second object list, a floating panel, Euler angles, per-axis scale, a typed lift off the bed, or view state in the undo stack or the `.lime` file.

The order in the note is the order below. A rejection stops the order. Later concepts do not come back to reopen it.

## What was judged

### X and Y scrub — built

`#placeX` and `#placeY` already edit the bounding-box centre through `setPlaceCenter` (`src/app/files.ts`). That writes the bed offset. It does not change `orient` or `partScale`, so the part frame stays and a move stays one re-emit (`docs/part-frame.md`). Dragging the existing X or Y label is the same write, with the move gizmo's step: 0.1 mm, Shift 1 mm, and the same HUD string (`X +1.4 mm`).

The typed step changes from 1 to 0.1 so the field can hold the tenth the drag writes. A typed `12.5` is one step on Enter or blur, which is the commit `placeX` already uses. Digits are not steps.

### Scale scrub — built

The Scale label is the same gesture on the one multiplier that already exists. One percentage point per step, Shift five, clamped to 10–400. The typed step stays 5. Scale still writes `partScale` and still re-slices, because scale is in the part frame. There is no second scale field and no per-axis scale.

### Frame the named solid — adapted

Selecting a row does not move the camera. A Frame control on the row does.

`setMesh` draws one solid, the selection. The others are wire boxes (`setPlateBounds` in `src/prepare-view.ts`). `selectPlateObject` already swaps that mesh in and leaves the camera where it is. `framePart` runs on the first mesh only. Orbit, pan, and zoom are how the user places the camera, and a row click is how they pick which solid the gizmo edits. Framing on every selection would replace a camera they just set. That is the note's reject case. The fallback is a separate control, still with no undo step of its own.

Frame uses the flight `framePart` already uses: the middle of that solid's box, three-quarter view, distance `max(side, 28) × 2.4`. On a narrow canvas the distance only increases, until the solid fits beside the parked gizmo. A canvas narrower than 700px parks a 56px gizmo instead of 88px, and that same three-quarter frame shifts the solid to the right of the gizmo so the ring does not cover its front corner. A desktop view stays at 2.4, at 88px, and centred. The sheet is not resized. Top, front, and isometric are not changed and are not shifted. A click on the mesh still does not move the camera. The ray only hits the selected mesh, which is unchanged.

Clicking Frame on the selected row frames again and does not open an undo step. Clicking it on another row selects that row, which is the one undo step selection already costs, and then frames. The camera is not in the snapshot, so Undo restores the selection and does not try to restore the camera.

Arrange, when it changes an offset, frames the union of the packed boxes once, after the pack. That frame is not its own undo step. Removing solids until one remains frames that solid, again not its own step. On a belt the framed box is the original. Ghost copies are not in the box.

### Marks on the object row — built

Under the size line, one truncated line: `paint`, `seam`, `supports off`, `infill N%`, `walls N`, `speed N`. The line is omitted when every one of those is absent, so a plain solid keeps the row it has today. Off-bed stays the warning line. The tip keeps the triangle count. Marks are text, not buttons, and not a new slice field. Copy already copies paint and settings, so a copy shows the same line.

### Z turn — rejected

X and Y show an absolute centre that stays on the field. The only honest Z control is a relative turn that is multiplied into `orient` and then reads 0, because the pose is a matrix and must not be shown as a heading. That field would sit in the same row as the centres and look like the turn had been discarded. The Z ring already applies that multiply, with the same HUD, and Lay flat, Center on bed, and the X and Y rings stay the tools for the other motions. A second control that does not keep a number is not shipped. There is no Euler readout in its place.

The order stops here.

### Volume name — built afterwards

The owner approved one drag after that stop. The volume's name (Box, Cylinder, Sphere) is the scale scrub: the same gesture, the same `partScale` write, one undo step. It does not change the volume's own size. A click still opens the row. A scrub does not, because that click is swallowed. Height-range labels stay as they are. They already step 0.1 mm, and this approval was the name that scales the part.

### Solo and Lock — not built

Solo is rejected on its own as well. The prepare view has one mesh. The gizmo and the move-on-mesh drag hit that mesh only. Dimming the other wire boxes would not change what can be grabbed, and the note says not to ship a half-dim. After Frame and the marks, a crowded plate is still not hard to grab, which is the gate for Solo and for Lock.

Lock's pack can be defined without rotating or scaling: a locked box keeps its rectangle, and unlocked boxes take the shelf around it. That part of the note is possible. It is not built, because the same gate is closed, and a gizmo block without an Arrange block is the split the note forbids. Neither ships.

## How

The drag math lives in `src/ui/scrub.ts`. Five pixels is still a scroll. Past that, a mostly horizontal drag is a scrub and a mostly vertical drag is left to the sheet. One step is four pixels. Shift changes the quantum, not the pixel size. `beginEdit` runs before the first write, `flushEdit` on pointer-up, and a result equal to the start stores nothing. The HUD is `#gizmoReadout`, the string the move gizmo already builds, painted for the duration of the scrub and cleared on release. While that string is set, `scheduleAuto` waits, which is how a gizmo move re-emits once at the end.

X and Y call `setPlaceCenter`. The typed `change` path is untouched apart from `step="0.1"`. A volume name calls the same scale write as the Scale label. The pointer is captured on the label that started the drag, so a second `data-scrub="scale"` does not grab the Scale field. Pointer-down on that name does not cancel the click. A scrub does.

Frame calls the same camera placement as `framePart`, on the bounds of the named solid (`placeObject`) or, after Arrange, on `plateUnionBounds`. The distance is the largest side times `frameFactor`. That factor stays at 2.4 when the solid already fits beside the parked gizmo, and it only increases on a narrow canvas. Marks are `objectMarks`: paint disks, seam disks, and the per-object settings that already exist, rendered only when the string is non-empty. The row does not add a span when it is empty.

No engine type, request field, or G-code path changes. A move remains an offset. A scale remains a new part frame.

## Risks to existing behaviour

- The X and Y spinner step is 0.1 mm instead of 1 mm. The centre is still the centre. Typing a whole millimetre still lands on it. This is the step the drag and the acceptance text require.
- A scrub that returns to the start must not push Undo. `commitGesture` already drops an equal snapshot.
- A two-pixel drag, and a vertical drag, must not move the solid. The listener does not call `preventDefault` until the drag is a scrub, so the compact sheet can scroll. Peek still ignores pointers on the sheet body.
- Rebuilding the sheet mid-drag would drop the pointer. The scrub writes through `applyPlace(false)`, which does not rebuild. Chrome rebuilds on pointer-up.
- Label focus. Pointer-down on the word does not focus the number, so `paintPlaceFields` can refresh it. The number itself still types, and still commits once on Enter or blur.
- Selection, Arrange, Remove, Center, Lay flat, the gizmo, belt ghosts, sequential Arrange, and the shortcut registry are unchanged by the X/Y scrub. Frame and the marks land in later changes and must keep those paths. Frame must not resize the sheet. The default Prepare canvas stays at least 70%.
- Undo of a selection still restores `selectedId` only. The camera is not in the snapshot, before or after Frame.
- Marks must not add a key to the slice request. A row with no paint, no seam disks, and no per-object settings must not gain an empty line, or the plate specs that read the size span will see two spans.

## Review questions

1. Is the relative Z field confusing enough beside the absolute centres that the order should stop there, with X, Y, and scale only?
2. Is Frame on the row the right fallback, with Arrange and remove-to-one still framing, and with selection itself leaving the camera alone?
3. The volume name now scrubs `partScale`, and height-range labels stay put. Is that the right split?
4. Solo and Lock stay out because the gizmo only hits the selected mesh. Is that the right reading of "hard to grab"?
5. Is 0.1 mm, and a spinner step of 0.1, acceptable on the fields that used to step 1 mm?
