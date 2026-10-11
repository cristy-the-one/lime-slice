# Plate placement concepts

This note is the whole brief for a later change to Prepare. It is written so the work can be judged and built from the Lime Slice tree alone. Do not open any other repository, and do not look for a component elsewhere to port. Read this note, then read the Lime Slice files it names, then decide which concepts apply. A concept that does not make the existing plate clearer is rejected. A concept that applies is adapted to the behaviour below, not added as a second way to do the same job.

Nothing in this note is an instruction to implement all of it. Ship a concept only when its acceptance checks pass and its non-goals stay intact.

## What the app already is

Lime Slice is an FDM slicer. A Rust core turns an STL, 3MF, or STEP mesh into toolpaths. The Prepare view places one or more solids on a bed or a belt, paints supports and seams, and edits modifier volumes. Preview shows the toolpaths. Placement is in millimetres.

The Prepare camera is a perspective orbit over a finite bed. Drag orbits, right-drag pans, the wheel zooms. On a compact layout, one finger orbits and two fingers pinch. The canvas is the working surface. The settings sheet must leave that canvas at least 70% of the screen in the default Prepare layout (`src/ui/compact/viewport-share.ts`, `docs/roadmap.md`). New controls belong in the sheet the plate already uses. They do not become a floating panel over the mesh.

## Evidence of the current plate

These are facts about this tree. Verify them in the named files before changing them. If a fact and the code disagree, the code wins, and this note is stale.

**Objects.** A plate is `PlateState`: a list of `PlateObject` and `selectedId` (`src/plate.ts`). Each solid has a name, mesh bytes, a 3×3 `orient`, one `partScale`, `centered`, an `offset` in millimetres, a STEP chord tolerance, support edits, support-paint disks, seam disks, and optional per-object settings (`supports`, `supportAngle`, `supportStyle`, `infillCombine`, `variableWidth`, `scarfSeam`, `gyroid3d`, `infill`, `walls`, `speed`). Layer height is not a per-object setting. Geometry bytes stay in the session. Undo stores the rest.

**One scale, one bed rotation.** `partScale` is a single multiplier for the whole solid, from 10% to 400% in the typed field, step 5 (`src/app/settings.ts`, `partScale`). There are not three scale axes. Orientation is a 3×3 matrix, not three Euler angles.

**X and Y are cheap. Rotation and scale are not.** Moving a solid in bed X or Y does not re-slice it. The engine slices in the part frame and adds the bed offset when it writes G-code (`docs/part-frame.md`). The part frame keeps rotation, pivot, and the Z translation. Only the X/Y offset changes on a move. Changing `orient` or `partScale` changes the part frame and re-slices. Z is part of the slice, not a free lift.

**Typed placement.** The sheet shows Position X, Position Y, and Scale % for the selected solid (`#placeX`, `#placeY`, `#partScale` in `objectPlaceHtml`, `src/app/settings.ts`). X and Y are the centre of the solid's bounding box, step 1 mm. A change event calls `setPlaceCenter` (`src/app/wire.ts`). Off-bed text uses `offBed` (`src/mesh-place.ts`). Center on bed and Lay flat are existing tools.

**Gizmo.** The part gizmo is move and rotate, in print axes (`src/prepare-view.ts`). Handles stay about 88 px tall (`GIZMO_SCREEN_PX` in `src/gizmo-math.ts`). A free drag is continuous. Shift snaps to 1 mm or 15°. A wheel or touchpad notch steps 0.1 mm or 1° (`GIZMO_NUDGE_MM`, `GIZMO_NUDGE_DEG`). During a drag the HUD shows the running delta, such as `X +1.4 mm` or `Z +15°` (`src/app/viewer.ts`). Pointer-up ends the gesture. Modifier volumes have their own move and scale handles (`src/modifier-scene.ts`). The part has no scale handles.

**Object list.** `#objectList` lives in the settings sheet (`objectListHtml`, `src/app/settings.ts`). A row shows the file name, the bounding size in millimetres, and an off-bed note. Clicking the row calls `selectPlateObject` (`src/app/plate-actions.ts`). With two or more solids, a row can Remove. Overlap text can Arrange. Arrange packs axis-aligned boxes left to right, then a new row, with a 2 mm gap, or the sequential toolhead clearance when that mode is on (`arrangeBoxes` in `src/plate.ts`). Arrange does not rotate. It moves every solid.

**Camera.** `framePart()` in `src/prepare-view.ts` moves the orbit target to the middle of the current mesh bounds and places the camera on a three-quarter view at about 2.4 times the largest side. `setMesh(part, frameCamera)` calls it only when `frameCamera` is true, which is the first time a mesh is shown. Selecting another solid does not frame. Top, front, and isometric presets frame the current mesh bounds, or the bed when there is no mesh.

**Undo.** One document snapshot, 40 deep (`src/ui/edit-history.ts`, `src/app/history.ts`). A snapshot holds every solid's placement, paint, seam disks, per-object settings, the modifier document, which object or volume is selected, the preset, the settings level, the machine, and the print order. Mesh bytes are not in the snapshot. `noteEdit` opens a gesture and commits it after 280 ms if nothing calls `flushEdit`. `beginEdit` holds a gesture open until `flushEdit`, which is how a brush stroke stays one step. A gizmo drag calls `noteEdit` at the start and `flushEdit` at pointer-up. An identical snapshot stores nothing. Undo restores the whole document. Selection is inside the snapshot: `selectPlateObject` calls `noteEdit`, changes `selectedId`, and `flushEdit`, so choosing a row is one undo step.

**Modifiers.** Height ranges and volumes live in `state.overrides`, edited from the sheet (`src/ui/overrides-panel.ts`). A volume card already has X, Y, Z and size X, Y, Z, step 0.1 mm. A height range already has From Z and To Z. Those numbers are typed. They are not a second object list.

**Belt.** A belt printer draws the original and ghosts the copies. Pose, paint, and lock, if lock is added, belong to the original. Copies follow. Framing looks at the original. `docs/belt-slicing.md` and `docs/part-frame.md` describe the two frames. Do not invent a lab-space yaw that ignores that split.

**Compact.** The phone sheet peeks, then drags to half or full. A drag that starts on a label must not move a solid until the pointer has clearly left a scroll. The canvas share stays at least 70% in the default Prepare layout.

## Principles

1. **One control, one meaning.** If the sheet already edits a value, extend that control. Do not add a twin field, a floating panel, or a second list of the same solids.
2. **The canvas stays the plate.** Orbit, pan, and zoom stay as they are. A list action may move the camera only in the ways this note allows. A viewport click does not move the camera.
3. **A gesture is one undo step.** Pointer-down opens the gesture. Pointer-up commits it. A result equal to the start stores nothing. Typing commits once, on Enter or blur, not per digit. Camera framing and view-only dimming are not undo steps.
4. **Do not lie about the slice.** A control that hides a solid must not leave that solid in the G-code, and a control that only changes the picture must not drop it from the G-code. Remove is the way off the plate.
5. **Respect the part frame.** Bed X and Y are an offset. Rotation, scale, and Z change the slice. A new numeric control uses the path the gizmo already uses for that axis. It does not write a second pose.
6. **The matrix stays a matrix.** Do not store orientation as three Euler angles. Do not display one absolute heading as if it were the pose.
7. **Belt copies are not objects.** Anything new is stored on the original solid. Ghosts follow the original.
8. **Phone scroll wins until the drag is real.** A label drag captures the pointer only after a few pixels of movement. Until then the sheet scrolls.
9. **Fit the tests that already exist.** Placement, plate, undo, belt, and compact layout have unit tests and Playwright checks. A change that moves X/Y must keep a move as an emit, not a re-slice. A change that turns the solid must re-slice, as the rotate gizmo does.

## Concept A. Frame the solid named in the list

**Intent.** After the user chooses a solid in `#objectList`, the Prepare camera shows that solid, using the flight `framePart()` already uses.

**Behaviour.**

- Clicking a row still selects that solid, with the one undo step selection already costs. In addition, the camera frames that solid's bounds.
- Clicking the row that is already selected frames again and does not push another undo step.
- The flight targets that solid's box, with the same padding as `framePart()`. A solid past the bed edge is framed on its own box.
- Top, front, and isometric stay what they are. Framing does not change which of those is armed.
- A click on the mesh still selects and does not move the camera.
- Arrange, when it moves anything, frames the union of the packed boxes once, after the pack. That frame is not its own undo step. Arrange itself remains one undo step.
- Removing a solid until one remains frames that solid.
- On a belt, frame the original. Ghost copies stay ghosts.
- Compact layout does not resize the sheet. If the remaining canvas is short, increase the camera distance until the solid fits. Do not shrink the sheet to make room.

**Reject this concept when** selecting a row already leaves the solid obvious, and a second frame would fight a camera the user has just placed. The fallback is a separate "show this solid" control on the row, still without its own undo step, rather than framing on every selection change.

**Acceptance.** Selecting a non-selected row selects it, frames its box, and is one undo step whose only document change is `selectedId` plus any pose sync the selection already does. The camera position is not in the snapshot. Pressing Undo restores the previous selection and does not try to restore the camera. A second click on the same row frames again and leaves the undo stack unchanged. The default Prepare canvas share stays at least 70%.

## Concept B. Marks on the object row

**Intent.** The object row states the slicer facts already stored on that solid, so the list identifies which solid was edited.

**Behaviour.** Under the size line, show a single truncated line of marks. Omit the line when every mark is absent.

| Mark text | Condition |
|---|---|
| `paint` | At least one support-paint disk |
| `seam` | At least one seam disk |
| `supports off` | Per-object `supports` is false |
| `infill N%` | Per-object `infill` is set. N is the stored fraction shown as a percent |
| `walls N` | Per-object `walls` is set |
| `speed N` | Per-object `speed` is set, in mm/s |

Off-bed stays the warning line it is now. It is not a mark. The existing tip keeps the triangle count.

Marks are not buttons. Editing infill, walls, speed, paint, or seams stays where it is. Copy already copies paint and settings, so a copy shows the same marks. Volumes and height ranges do not gain these marks.

**Reject a mark** that would require a new slice field. Do not invent icons that are the only way to read the fact. Text is the source.

**Acceptance.** A solid with no paint, no seam disks, and no per-object settings renders the row it renders today, with no empty mark line. A solid with seam disks and `walls: 4` shows `seam · walls 4`. Removing the disks or clearing the walls removes that text on the next render. The mark line does not change the slice request.

## Concept C. Scrub the numbers that already exist

**Intent.** The typed placement fields gain the gizmo's gesture: one drag, one undo step, the same deltas the gizmo already applies.

**X and Y.** Dragging the X label moves the selected solid along bed X. Y is the same. The step is 0.1 mm. Shift-drag snaps to 1 mm. The HUD is the move gizmo's HUD. The number shown remains the bounding-box centre. The typed step becomes 0.1 mm. Do not add a second pair of fields. This path is `setPlaceCenter`. It must remain an offset update: no re-slice, one re-emit, as a gizmo move is today.

**Scale.** Dragging the Scale label changes `partScale` by 1 percentage point per step, Shift by 5, clamped to 10–400. It is still one multiplier. This re-slices, because scale is in the part frame. There is no per-axis scale.

**Z turn.** A single field, labeled as a turn about print Z, not as the pose's heading. Dragging it rotates about print Z by 1° per step, Shift by 15°, through the same rotation the gizmo's Z ring applies (`onRotate` in `src/app/viewer.ts`). The HUD shows `Z +15°` while the gesture is open. The field shows the degrees added during this gesture. On commit the turn is multiplied into `orient` and the field returns to 0. Typing a number and pressing Enter applies that many degrees once, then clears the field. This re-slices, as the Z ring does. Do not decompose `orient` into an absolute yaw, pitch, and roll. Do not add a typed lift off the bed. Lay flat, Center on bed, and the X and Y rings stay the tools for those motions.

**Commit.** Pointer-down on a label calls `beginEdit` or `noteEdit` before the first write, and pointer-up calls `flushEdit`. Enter or blur on a typed value commits one step. A no-op stores nothing. Digits that have not been committed are not steps.

**Sheet scroll.** On a pointer that can scroll the sheet, ignore the scrub until the pointer has moved past a small threshold. Then capture it. A captured scrub does not scroll the sheet.

**Volumes and height ranges.** The same label-drag may be added to a volume's X, Y, Z and sizes, and to a height range's From Z and To Z. Those fields already exist and already step 0.1 mm. One scrub is one undo step. Do this only if Concept C has already landed on the solid's X and Y. Do not build a separate volume panel.

**Reject the Z-turn field** if the only honest version (a relative turn that clears on commit) is confusing next to X and Y, which show an absolute centre. In that case ship X, Y, and scale scrub only. Do not replace the rejection with an Euler readout.

**Acceptance.**

- Dragging X by 1.4 mm moves the box centre by 1.4 mm, shows the move HUD, and is one undo step. Undo restores the centre. The slice cache for that solid is reused the way a gizmo move reuses it (`docs/part-frame.md`).
- Shift-drag of X moves in 1 mm steps.
- Dragging scale from 100% to 110% sets `partScale` to 1.1, is one undo step, and invalidates the part frame.
- A Z-turn of 15° matches a 15° drag of the Z ring, including the matrix multiply, and is one undo step. After pointer-up the field reads 0. Undo restores the previous `orient`.
- Typing `12.5` into X and blurring commits one step. Pressing Undo once restores the previous centre, not the previous digit.
- A two-pixel drag on a label in the compact sheet scrolls the sheet and does not move the solid.

## Concept D. Solo

**Intent.** When solids overlap on screen, dim every solid except the selected one so the gizmo is grabbed on purpose.

**Behaviour.** Solo is a pressed control on the selected row, or one control for the plate that applies to the selection. Dimmed solids stay in the scene, stay in the overlap test, stay in Arrange, and stay in the slice. Paint and seam marks for the selected solid stay bright. Pressing Solo again, or clearing the selection, restores full strength. Solo is view state. It is not in the undo snapshot, not in the `.lime` project, and not in the slice request. Belt ghosts of other solids dim with those solids. The original of the selected solid stays bright, and its ghosts may dim or stay. Prefer dimming other originals and their ghosts, and keeping the selected original and its ghosts bright, so a belt copy is not mistaken for a second part.

**Reject Solo** if a dimmed solid can still be grabbed and the dim does not make the target obvious. In that case do not ship a half-dim. Also reject any version that omits a dimmed solid from G-code.

**Acceptance.** With three solids and Solo on, the preview and the slice still contain three solids. Toggling Solo does not enable Undo. Reload of a project does not restore Solo.

## Concept E. Lock against the gizmo and against Arrange

**Intent.** A solid that is already placed stays put while another solid is moved or the plate is packed.

**Behaviour.** Lock is a boolean on the solid. A locked solid ignores the move gizmo, the rotate gizmo, the X and Y scrubs, the scale scrub, and the Z-turn. Arrange does not change its offset or its orientation. The pack places the unlocked boxes in the gaps around the locked boxes. A locked solid still slices, still accepts paint and seams, and still copies. The copy is locked too. Unlock is the same control. Lock is an undo step, because it changes the next Arrange. A plate of one solid may be locked. Belt copies have no lock of their own.

Arrange's packing today writes a new minimum corner for every box (`arrangeBoxes`). The adapted pack treats a locked box as already occupying its rectangle. Unlocked boxes flow into the remaining span. If the unlocked boxes cannot fit, Arrange does what it does today for a box wider than the bed: it still places them, and the existing off-bed note reports them. Do not rotate a locked or an unlocked solid to make room.

**Reject Lock** if the pack cannot be defined without rotating or scaling. Do not leave Lock as a gizmo block while Arrange still slides the locked solid. Both refusals ship together, or neither does.

**Acceptance.** Two solids, the first locked. A gizmo drag on the first does not change its offset, does not open an undo step, and the HUD does not pretend it moved. Arrange moves only the second. Undo of the lock, then Arrange, moves both. A locked solid is present in the slice request. Copy produces a locked solid.

## Decision order

Judge in this order. Stop at a concept you reject. Later concepts do not pull a rejected one back in.

1. Concept C for X and Y only. It uses fields and a path that exist, and it does not re-slice.
2. Concept C for scale, if the label-drag from step 1 is sound.
3. Concept A, unless selection-plus-frame fights the camera. Use the fallback control if it does.
4. Concept B. Independent of the camera and of scrubbing.
5. Concept C for the Z-turn, only under the relative-turn rule.
6. Concept C extended to volume and height-range fields, only after X and Y scrub exists.
7. Concept D, then Concept E. Only when a crowded plate is still hard to grab after A and B. E ships gizmo refusal and Arrange refusal together.

## Non-goals

- A second object list, a floating outliner, or a panel of raw position, Euler angles, and three scale axes.
- Per-axis scale, a typed Z lift, or an absolute yaw read out of the matrix.
- Hiding a solid from the viewport while it still slices, or hiding it from the slice without Remove.
- Changing Preview's layer scrubber, playback, or toolpath colours.
- A new camera mode, a saved camera, or letterboxing.
- Storing view-only state (Solo, the last frame) in the project file or the undo stack.
- Reading or copying any other application's source to implement this note.
