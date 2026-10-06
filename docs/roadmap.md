# Competitive roadmap

Ranked against PrusaSlicer, OrcaSlicer, Bambu Studio, and Cura. Status is what this tree already does. A row is **exists** only when a user can do the thing, **partial** when a piece of it is real and the rest is absent, and **missing** when it is not in the app or the engine.

Shipped work that this list does not treat as a gap: one-mesh slice of STL, 3MF, and STEP (`crates/lime-slice-core/src/load.rs`, `crates/lime-slice-core/src/step.rs`); strategy blends (`crates/lime-slice-core/src/strategy.rs`, README); tree and grid supports with prune and regrow (`docs/support-edits.md`, `src/ui/support-edit-ui.ts`); slice jobs, progress, and cancel (`docs/slice-progress.md`); a `.lime` project (`src/project.ts`); named settings profiles that store a preset and a level (`src/ui/settings-profiles.ts`); undo of placement and settings (`src/app/history.ts`); compact layout with a 70% prepare canvas (`src/ui/compact/`).

The [build checklist](#build-checklist-2026-10-06) is the status of this tree. A Status line in a section below is the gap write-up from 2026-10-03. Where the two disagree, the checklist wins.

## Build checklist (2026-10-06)

Standing decisions in [Decisions (2026-10-03)](#decisions-2026-10-03) still hold. This run does not add code signing, a Bambu LAN client, redistributed vendor profiles, or a native iOS shell. The phone layout stays a secondary check that the prepare canvas remains at least 70%.

A row is **done** when a user can do the thing and the engine honors it. **In progress** means a pull request is open for it. **Remaining** means it is not in the app or the engine. Links are the pull request that landed the work.

### Done

- Printer, filament, and nozzle library. Our own profiles. Pressure advance is per filament and nozzle. [#110](https://github.com/cristy-the-one/lime-slice/pull/110)
- Seam picker: blend, nearest, aligned, rear. [#127](https://github.com/cristy-the-one/lime-slice/pull/127)
- Ironing, off unless the request carries `ironing`. [#136](https://github.com/cristy-the-one/lime-slice/pull/136), controls in [#131](https://github.com/cristy-the-one/lime-slice/pull/131)
- Arc fitting and Arachne-style variable-width walls. Both default on. They are not a gap.
- Prusa Link send from the desktop app. [#140](https://github.com/cristy-the-one/lime-slice/pull/140), earlier UI in [#111](https://github.com/cristy-the-one/lime-slice/pull/111)
- Multi-object plates, all-at-once, each object in its own part frame. [#126](https://github.com/cristy-the-one/lime-slice/pull/126), UI plate in [#121](https://github.com/cristy-the-one/lime-slice/pull/121)
- Support painting, enforce and block disks, sliced. [#139](https://github.com/cristy-the-one/lime-slice/pull/139)
- Height ranges and modifier volumes, sliced. [#128](https://github.com/cristy-the-one/lime-slice/pull/128), editor in [#115](https://github.com/cristy-the-one/lime-slice/pull/115), per-layer replan in [#133](https://github.com/cristy-the-one/lime-slice/pull/133)
- Foreign 3MF opens mesh-only. [#113](https://github.com/cristy-the-one/lime-slice/pull/113)
- Pressure-advance tower. `lime-slice calibrate pa`, and the sheet writes the chosen K onto the filament.
- Belt slicing, phases 1, 2, and 5, plus the belt wall and the `blend` seam rewritten to the belt edge. Design [#147](https://github.com/cristy-the-one/lime-slice/pull/147), profile [#148](https://github.com/cristy-the-one/lime-slice/pull/148), engine [#151](https://github.com/cristy-the-one/lime-slice/pull/151), UI [#152](https://github.com/cristy-the-one/lime-slice/pull/152). A cartesian request with no `belt` object keeps its G-code (`crates/lime-slice-core/tests/cartesian_lock.rs`).
- Preview time, cost, layer scrubber, and the layer-time chart.
- Start and end G-code on export and send. Blank text, including the old built-in `; Name` comments, leaves the engine bytes. [#154](https://github.com/cristy-the-one/lime-slice/pull/154)
- Belt seam on the belt edge, opt-in. `belt.seamOnEdge` is omitted when off, so an explicit nearest or aligned seam stays unless the box is checked. [#155](https://github.com/cristy-the-one/lime-slice/pull/155)
- Belt raft, opt-in. `belt.raftLayers` is omitted when 0. A count from 1 to 8 prints a solid pad on the belt before the part. `drop_slivers` stays global. [#156](https://github.com/cristy-the-one/lime-slice/pull/156)
- Fuzzy skin, off by default. `fuzzySkin` is omitted when off. On, it offsets outer walls after the seam is chosen and leaves a scarf ramp alone. [#157](https://github.com/cristy-the-one/lime-slice/pull/157)
- Seam painting. Disks on the mesh, omitted when empty. A painted disk pulls the nearest wall vertex and pins it. The picker stays the default. [#158](https://github.com/cristy-the-one/lime-slice/pull/158)
- Flow tower, and a filament flow multiplier. `flow` is omitted at 1, so a slice that does not scale extrusion keeps its G-code. The tower is a hollow wall per band, and the chosen band is written onto the filament. [#159](https://github.com/cristy-the-one/lime-slice/pull/159)
- Temperature tower. Nozzle temperature steps by height. The chosen band writes the filament's existing nozzle temperature. There is no new slice field. [#160](https://github.com/cristy-the-one/lime-slice/pull/160)
- Retraction length and speed, then a retraction tower. `retractLength` and `retractSpeed` are omitted when unused, so the strategy length and `F1800` stay. The tower is two posts, and the chosen length is written onto the filament. [#161](https://github.com/cristy-the-one/lime-slice/pull/161)
- Belt preview patches. The token includes copies, axis, direction, and the gap, so a later slice of the same belt can be a patch. A different stamp is a whole preview. G-code stays the belt file. [#162](https://github.com/cristy-the-one/lime-slice/pull/162)
- Per-object infill, walls, and speed. Omitted, the strategy stays. A height range or a modifier wins on each field it sets. [#163](https://github.com/cristy-the-one/lime-slice/pull/163)

### In progress

None. The next pull request starts from the remaining list.

### Remaining, in the order this run will build them

Each engine feature is opt-in or default-off, with a cartesian lock so an unused feature leaves G-code bytes and the request cache key unchanged. One feature per pull request. A short design note goes in the same pull request when the feature is small, and as its own note when it is not.

1. **Sequential printing.** `printOrder: "sequential"` is refused until clearance exists. All-at-once stays the omitted default.
3. **Supports grown from the tilted belt floor.** Until this lands, a belt slice forces supports off and refuses support edits and paint. This is the largest belt follow-up, so it waits until the smaller belt flags are in.
4. **Multi-material.** A design note, plus UI groundwork for a second filament on the machine, and no toolpath. Tool changes, a purge tower, and a second extruder stay out of the engine in this run.
5. **Repair audit in the sheet.** The engine already reports repaired and dropped chains. Show that text. No interactive hole fill.

### Deferred, and why

- **Code signing and the updater.** Decided later. Unsigned installers stay ([#103](https://github.com/cristy-the-one/lime-slice/pull/103)).
- **Bambu LAN, Moonraker, and OctoPrint.** Prusa Link is the send path. The others wait.
- **Redistributed Prusa or Bambu profiles.** We ship our own.
- **Native iOS.** The TODOs in `src/platform.ts` stay. On-device slicing (`MOCK_ON_DEVICE_LABEL` in `src/ui/compact/mocks.ts`) stays labelled mock.
- **Playback speed.** The compact chip is a mock 1× (`MOCK_PLAYBACK_SPEED`). It does not change a toolpath and is not in this run.
- **Hollow and text emboss.** Large mesh booleans, low user value next to the rows above.
- **Cut to two bodies, and split-to-objects at load.** Both need a plate slot for the new body. The plate exists, but a mesh boolean and a loader split are their own projects. The section plane stays a view.
- **Localization, crash reporting, and an onboarding tour.** Strings are still moving. No crash vendor. The empty state already says to open a mesh.
- **Foreign settings import.** A foreign 3MF stays mesh-only.
- **G-code emit performance.** Not ahead of the rows above.
- **World-space shear for a belt firmware that does not tilt.** Not used for the machines in `docs/belt-slicing.md`.
- **Per-range layer height, rotated modifier volumes, and mesh modifiers.** Non-goals in `docs/modifiers-and-height-ranges.md`.

### Mocks that stay labelled

- On-device engine button, disabled, "On-device later".
- Playback speed chip, "1×", no effect.
- Slice progress on the invoke path with no job stream uses the estimated curve (`src/ui/slice-progress.ts`). HTTP jobs report a real fraction.

## Multi-object plates and arrange

**Status.** Done for all-at-once ([#126](https://github.com/cristy-the-one/lime-slice/pull/126)). Sequential is remaining. See the [checklist](#build-checklist-2026-10-06). The paragraphs below are the 2026-10-03 gap.

**User value.** High for anyone printing more than one part. The other slicers arrange a bed and keep each body separate. Here a second file replaces the first (`state.mesh` in `src/app/state.ts`). STEP assemblies and 3MF models become one mesh (`crates/lime-slice-core/src/step.rs`, `load_3mf` in `crates/lime-slice-core/src/load.rs`).

**Effort.** Large for a real plate. Small for a mock that only shows several bounds.

**Who.** Needs engine work in `crates/` (Claude) for separate solids, per-object tours, and sequential printing. The UI can list, place, warn on box overlap, and arrange boxes first, behind a mock that still sends one STL.

**Dependencies.** The design note above. Version 2 of `.lime` (`applyMigrations` in `src/project.ts` is the hook; `migrations` is empty). Undo already records one pose.

**Compact.** The object list already sits in the settings sheet (`objectList` in `src/app/settings.ts`). A longer list must stay inside that sheet so the peek canvas stays at least 70%.

## Printer and filament libraries

**Status.** Done ([#110](https://github.com/cristy-the-one/lime-slice/pull/110)). Start and end G-code are spliced into export and send ([#154](https://github.com/cristy-the-one/lime-slice/pull/154)). See the [checklist](#build-checklist-2026-10-06). The paragraph below is the 2026-10-03 gap.

One printer profile is stored and edited: nozzle, filament diameter, temperatures, bed size, volumetric cap, accel, density, cost, pressure advance, and linear advance (`src/profiles.ts`, `profileFields` in `src/app/settings.ts`). Import and export are one JSON file. The default is "Generic Marlin 0.4 mm PLA". Named settings profiles are slice presets, not printers or filaments (`src/ui/settings-profiles.ts`). There is no vendor catalog and no filament that carries its own pressure advance apart from that one profile. The engine already emits Klipper `SET_PRESSURE_ADVANCE` and Marlin `M900` from those two numbers (README, `crates/lime-slice-core/src/strategy.rs`).

**User value.** Highest of the gaps. A wrong bed or a wrong K ruins the first print. PrusaSlicer, Orca, Bambu Studio, and Cura open on a named printer and a named filament.

**Effort.** Medium. The catalog is data plus UI. Per-filament K is a field the emit path already understands, moved off the single profile.

**Who.** UI-only for a bundled catalog, pickers, and save/import of printer and filament files. Needs engine work in `crates/` only if a vendor start G-code or a filament-specific flow model must change the toolpath, not just the header lines.

**Dependencies.** None on plates or painting. Reuses the versioned-file checks from `src/project.ts` and `src/ui/settings-profiles.ts`.

**Compact.** Two pickers in the existing Device page (`devicePage` in `src/ui/compact/mount.ts`) and the printer block in the sheet. The bed size they set is what `offBed` already checks (`src/mesh-place.ts`).

## Print-quality features

### Seam control

**Status.** The picker is done ([#127](https://github.com/cristy-the-one/lime-slice/pull/127)). Seam painting is done ([#158](https://github.com/cristy-the-one/lime-slice/pull/158)). See the [checklist](#build-checklist-2026-10-06). The paragraph below is the 2026-10-03 gap.

Scarfed seams, aligned seams on a sharp corner, and nearest seams are in the planner and on by default (`--scarf-seam`, `--travel-opt` in the README; `scarfSeam` in `src/app/settings.ts`). There is no seam painter and no "rear / random / aligned" picker beyond scarf off, outer, and all.

**User value.** High. Seam position is the first thing people compare on a calibration cube.

**Effort.** Small for a placement picker if the planner already has aligned and nearest. Medium for a painted seam.

**Who.** A picker is UI plus a small engine flag (Claude, `crates/`). A painted seam is engine work.

**Dependencies.** Painted seams share the brush with support painting. The picker does not.

**Compact.** One select in the Strength group, which is already in the sheet.

### Ironing

**Status.** Shipped 2026-10-04. See [seam-and-ironing.md](seam-and-ironing.md#shipped-ironing-2026-10-04).

**User value.** Medium. Expected on top surfaces. Not required to match a bench cube.

**Effort.** Medium. A new pass over top skin.

**Who.** Needs engine work in `crates/` (Claude). The UI is one checkbox and a flow percent.

**Dependencies.** None.

**Compact.** A checkbox in the sheet. No new canvas chrome.

### Arc fitting

**Status.** Exists.

G2/G3 fitting is default on (`arcFit` in `src/app/settings.ts`, `SliceRequest::arc_fit` in `crates/lime-slice-core/src/slice.rs`). The estimate counts `arcMoves`.

**User value.** Already captured. Leave it on.

**Effort.** None.

**Who.** Done.

**Dependencies.** None.

**Compact.** The existing checkbox.

### Variable-width walls

**Status.** Exists.

Arachne-style variable walls, thin walls, and gap fill are default on (`variableWidth` in `src/app/settings.ts`; the field comment on `SliceRequest::variable_width` in `crates/lime-slice-core/src/slice.rs`).

**User value.** Already captured.

**Effort.** None.

**Who.** Done.

**Dependencies.** None.

**Compact.** The existing checkbox.

### Fuzzy skin

**Status.** Missing.

**User value.** Low next to seam and ironing. It is a look, not a fit.

**Effort.** Medium. A surface offset on outer walls.

**Who.** Needs engine work in `crates/` (Claude).

**Dependencies.** None.

**Compact.** A checkbox in the sheet.

## Calibration tools

### Pressure advance

**Status.** Exists.

`lime-slice calibrate pa` writes a Klipper or Marlin tower (`crates/lime-slice-core/src/calibrate.rs`). The UI posts `/api/calibrate/pa`, lists the bands, and saves the chosen K onto the profile (`runPaCal` in `src/app/slice-run.ts`).

**User value.** Already captured for one profile. A filament library should store that K per filament.

**Effort.** Small once filaments exist.

**Who.** UI-only to hang the existing K on a filament. The tower stays.

**Dependencies.** Printer and filament libraries.

**Compact.** The PA block is expert-level in the sheet. A phone can run it. It does not need a new canvas.

### Flow

**Status.** Missing as a calibration print.

The volumetric cap is a profile field (`maxVolumetricMm3S`). There is no flow-rate tower and no single-wall cube that measures extrusion width.

**User value.** High, next to PA. Orca and SuperSlicer lead with it.

**Effort.** Small. A generator beside `calibrate.rs`, plus a UI that writes a flow multiplier.

**Who.** Needs engine work in `crates/` (Claude) for the tower. The multiplier is a header or a line-width scale the UI can send once the field exists.

**Dependencies.** The PA tower is the pattern. A filament library should own the result.

**Compact.** Same as PA: a button in the sheet, G-code out, no extra chrome on the canvas.

### Temperature tower

**Status.** Missing.

Nozzle and bed temperature are two numbers on the profile. Nothing steps them by height.

**User value.** Medium. Useful once, then the filament stores the winner.

**Effort.** Small. M104/M140 changes by Z. No new toolpaths.

**Who.** Needs a thin engine command in `crates/` (Claude), same shape as the PA tower. UI picks the range.

**Dependencies.** Filament library to store the result.

**Compact.** A form in the sheet.

### Retraction

**Status.** Partial.

The planner retracts. Length is inside the strategy (0.35 mm on speed, 0.9 mm on toughness in `crates/lime-slice-core/src/strategy.rs`), not a user field. Combing decides when a travel retracts (README). The estimate reports retract count. There is no retraction tower and no length/speed control.

**User value.** Medium. People tune it after stringing. Less urgent than flow and PA.

**Effort.** Small for a user length and speed. Medium for a tower.

**Who.** Needs engine work in `crates/` (Claude) to read the length from the request instead of only the strategy. The tower matches the PA command.

**Dependencies.** None. A filament library should store the result.

**Compact.** Two number fields in the sheet.

## Multi-material

**Status.** Missing.

The README says multi-extruder stays out. One nozzle, one filament, no AMS, no wipe or prime tower. Region blend still shares one outer wall on the cut.

**User value.** High for Bambu and Prusa MMU owners, and a different product. Low for the first single-extruder users this app already serves.

**Effort.** Large. Tool changes, towers, purge volumes, and a second (or fifth) filament through every layer.

**Who.** Needs engine work in `crates/` (Claude). The UI cannot fake a tool change in the header and keep the G-code honest.

**Dependencies.** Filament library first. Plates and paint do not unblock it.

**Compact.** A material list would live on the Device page. The canvas rule is unchanged until a tower has to be shown on the bed.

## Preview time, cost, and the layer scrubber

**Status.** Exists.

The estimate is seconds, filament grams, and a euro cost from the profile's €/kg (`estimateHtml` in `src/app/settings.ts`). Per-feature time is on the response. The layer range is `#rangeLow` and `#rangeHigh`. Playback is play, stop, and a move slider (`src/playback.ts`). A sparkline shows per-layer time (`#spark` in `src/app/viewer.ts`). Pareto compare is a separate run.

**User value.** Already the daily loop. The other slicers are ahead on filament color in the preview and on cost broken out by material. Those wait on multi-material.

**Effort.** None for the single-filament scrubber.

**Who.** Done.

**Dependencies.** None.

**Compact.** The preview scrubber and progress line are already on the phone layout (`src/ui/compact/`).

## Send to printer

**Status.** Prusa Link is done, desktop first ([#140](https://github.com/cristy-the-one/lime-slice/pull/140)). Moonraker, OctoPrint, and Bambu LAN stay out. See the [checklist](#build-checklist-2026-10-06).

The printer profile stores a Prusa Link host and API key (`host` and `apiKey` on `PrinterRecord` in `src/ui/machine-library.ts`, version 2 of the machine file). After a slice, Send uploads that G-code with `PUT /api/v1/files/local/<name>` and can start the print (`Print-After-Upload`). Export to a file stays (`exportGcode` in `src/app/files.ts`). Moonraker, OctoPrint, and Bambu LAN are not implemented. The phone is not a send target.

Desktop `http://` is sent by a small helper (`src-tauri/src/prusa_http.rs`) because Prusa Link does not grant the webview CORS. The browser, and any `https://` host, use `fetch`. CI never calls a printer: unit tests pass a mock fetch, and the smoke test fulfills the printer routes. That mock is not a device in the UI.

**User value.** High. Orca and Bambu Studio are used because the slice lands on the machine. A download is the step people want to skip.

**Effort.** Medium per protocol still outstanding. Prusa Link does not change the slice.

**Who.** UI-only, plus the desktop HTTP helper. No `crates/` planner work.

**Dependencies.** The host lives on the printer profile. Met for Prusa Link.

**Compact.** Send is on the Device page next to Share. The prepare canvas stays at least 70% at the peek.

## Modifiers and painting

### Support prune and regrow

**Status.** Exists.

Birth-site prune and region regrow are in the engine and the UI (`docs/support-edits.md`, `src/support-edits.ts`, `src/ui/support-edit-ui.ts`). Grid supports warn and do not edit. Compact uses the same list (`docs/ui-support-edits-plan.md`).

**User value.** Already captured for tree supports.

**Effort.** None.

**Who.** Done.

**Dependencies.** None.

**Compact.** Already on the preview, with the canvas kept in front of the peek sheet.

### Support painting

**Status.** Done ([#139](https://github.com/cristy-the-one/lime-slice/pull/139)). See the [checklist](#build-checklist-2026-10-06). The paragraph below is the 2026-10-03 gap.

Demand is the overhang angle (`overhang_at` in `crates/lime-slice-core/src/support.rs`). There is no enforce or block brush. The design is in [multi-object-and-support-painting.md](multi-object-and-support-painting.md).

**User value.** High for organic supports. It is how Orca and Bambu let people fix one overhang without pruning the whole tree.

**Effort.** Medium.

**Who.** The UI can store and draw disks first (mock, no birth sites invented). Needs engine work in `crates/` (Claude) before a slice honors them.

**Dependencies.** The design note. Prune and regrow stay the replay after the walk.

**Compact.** A prepare-sheet brush. The peek canvas stays at least 70%. Painting does not take over the preview editor.

### Seam painting

**Status.** Missing.

Seams are chosen by the planner, not by a stroke on the mesh.

**User value.** Medium. People who care already get scarf and nearest. Painting is the Orca/Bambu extra.

**Effort.** Medium.

**Who.** Needs engine work in `crates/` (Claude). The brush can share the prepare tool with support paint.

**Dependencies.** Seam control above. Do not block the seam picker on this.

**Compact.** Same brush slot as support paint. One tool at a time.

### Modifier volumes

**Status.** Done for box, cylinder, and sphere ([#128](https://github.com/cristy-the-one/lime-slice/pull/128)). Mesh modifiers stay out. See the [checklist](#build-checklist-2026-10-06). The paragraph below is the 2026-10-03 gap.

By-region blend is one plane: low side toughness, high side speed (`byRegion` in `src/app/settings.ts`, drag in Prepare). It is not a box, a mesh, or a stack of modifier shapes. By-layer blend is one height band, below.

**User value.** Medium. Modifier meshes are how the other slicers change infill in one place. The plane covers the simple case.

**Effort.** Large for arbitrary meshes. Small to keep the plane and document it as the modifier we have.

**Who.** Needs engine work in `crates/` (Claude) for a mesh modifier. The plane is done.

**Dependencies.** Per-object settings from the plate design, if a modifier is an object with no walls.

**Compact.** The plane already drags on the prepare canvas. A mesh modifier needs a pick that does not cover the model.

### Height-range settings

**Status.** Done for infill, walls, and a speed cap ([#128](https://github.com/cristy-the-one/lime-slice/pull/128)). Per-range layer height stays out. See the [checklist](#build-checklist-2026-10-06). The paragraph below is the 2026-10-03 gap.

By-layer blend uses a bottom band and a transition (`bottomMm`, `transitionMm`). It mixes two strategies. It is not a list of Z ranges each with its own infill, walls, and speed.

**User value.** Medium. Height ranges are the usual way to strengthen the bottom and loosen the top.

**Effort.** Medium.

**Who.** Needs engine work in `crates/` (Claude) if a range can override more than the blend weight. The current band is done.

**Dependencies.** Decide which keys a range may set. Same question as per-object keys in the plate design.

**Compact.** The band fields are already in the blend panel. A list of ranges belongs in the sheet.

## Mesh tools

### Cut

**Status.** Partial.

A section plane clips the preview (`src/section-plane.ts`). It does not split the mesh into two printable bodies.

**User value.** Medium. Cut-to-parts is a PrusaSlicer habit. The preview plane is a view, and it is already there.

**Effort.** Large for a real cut that writes two meshes. None for the view.

**Who.** Needs engine work in `crates/` (Claude) to emit two meshes. The UI plane exists.

**Dependencies.** Multi-object, or the cut has nowhere to put the second body.

**Compact.** The section slider is a view control. A destructive cut confirms in the sheet.

### Split to objects

**Status.** Missing as a user tool.

Loaders fuse bodies (`crates/lime-slice-core/src/step.rs`, `parse_3mf_model` in `crates/lime-slice-core/src/load.rs`).

**User value.** High once plates exist. Until then a split has one slot to land in.

**Effort.** Medium on top of plates.

**Who.** Needs engine work in `crates/` (Claude) to keep connected components apart at load. The UI lists whatever the loader returns.

**Dependencies.** Multi-object plates.

**Compact.** Results show up in the object list. No new canvas.

### Hollow

**Status.** Missing.

**User value.** Low for FDM. Cura's hollow is not why people leave a slicer.

**Effort.** Large. A shell offset of a triangle mesh.

**Who.** Needs engine work in `crates/` (Claude).

**Dependencies.** None. Do not schedule it ahead of plates or filaments.

**Compact.** One action in the sheet. The preview has to show the cavity or the tool is blind.

### Text emboss

**Status.** Missing.

**User value.** Low next to the gaps above. PrusaSlicer users like it. It does not fix a print.

**Effort.** Large. Fonts, a surface projection, and a mesh boolean.

**Who.** Needs engine work in `crates/` (Claude).

**Dependencies.** None.

**Compact.** A text field in the sheet. The glyphs have to stay visible on the model.

### Repair

**Status.** Partial.

The slicer welds a broken contour and closes gaps up to 1.25 mm, and the audit reports repaired and dropped chains (README, `crates/lime-slice-core/src/audit.rs`). There is no repair button, no hole-fill preview, and no "discarded faces" dialog before the slice.

**User value.** Medium. Cura's repair is why bad STLs still print. The silent weld already covers the small gaps.

**Effort.** Small for a dialog that shows the audit. Large for an interactive hole fill.

**Who.** UI-only for the audit the engine already returns (`slice --audit`). Interactive fill needs engine work in `crates/` (Claude).

**Dependencies.** None.

**Compact.** The audit is text in the sheet. Do not cover the model with a repair wizard.

## Performance

**Status.** Partial, and not a feature gap against the other apps so much as a clock.

Per-layer contours, toolpaths, and support classification already run in rayon (`docs/parallelism-inventory.md`). The UI follows job progress instead of blocking (`docs/slice-progress.md`). G-code emit is still one string per slice. The preview bead mesh is the other cost called out in that inventory.

**User value.** Medium on big STLs. The cube is already fast. The hull and dragon numbers in the inventory are the ones that feel slow.

**Effort.** Medium for an ordered G-code reduce. The inventory says a second split inside a layer does not move a 4-core clock.

**Who.** Needs engine work in `crates/` (Claude) for emit. The preview mesh is UI (`src/` geom worker).

**Dependencies.** None. Do not block the library or send-to-printer on it.

**Compact.** A phone is a client of the remote engine (`src/ui/compact/`). Making emit faster helps the phone only because the job ends sooner. On-device slicing is still the mock labeled in the Device page.

## Product polish

### Signed installers and updater

**Status.** Missing.

`.github/workflows/release.yml` builds unsigned draft installers (deb, AppImage, two dmgs, NSIS). The README lists the Apple and Tauri signing secrets and says nothing reads them. The updater plugin is not wired.

**User value.** High for a download that is not this repo. Low while users build from source.

**Effort.** Medium, and it is release configuration, not a slicer.

**Who.** UI-only in the sense of no `crates/` planner work. Tauri signing is the workflow and `src-tauri`. Claude does not need to change the slice.

**Dependencies.** A published release, not a feature above.

**Compact.** No canvas change. A phone build is not this workflow.

### Crash reporting

**Status.** Missing.

**User value.** Medium once strangers run the binary. Useless until the crash is something we can read.

**Effort.** Small for a desktop reporter. The choice of vendor is the work.

**Who.** UI-only. No `crates/` slice change.

**Dependencies.** Signing, or at least a release people install.

**Compact.** A phone build needs its own reporter. The browser client has the page and nothing else.

### Onboarding tour

**Status.** Missing as a tour.

Samples, the empty state, and the `?` shortcut sheet exist (`src/ui/commands.ts`, `fillHelpShortcuts`). There is no first-run sequence.

**User value.** Low next to a printer profile. The empty state already says to open a mesh.

**Effort.** Small.

**Who.** UI-only.

**Dependencies.** Printer and filament pickers, or the tour points at a generic profile.

**Compact.** A sheet, not a overlay on the canvas. The peek stays at 70%.

### Localization

**Status.** Missing.

Strings are English in the UI and the engine errors.

**User value.** Medium in non-English markets. Cura and PrusaSlicer are ahead here. It does not change a toolpath.

**Effort.** Medium. Every user-facing string, then translators.

**Who.** UI-only for the shell. Engine errors in `crates/` need Claude if they are translated too.

**Dependencies.** None. Do it after the strings stop moving every week.

**Compact.** Same strings. Watch length: a translated label can overflow a 44px tab.

### Settings migration

**Status.** Partial.

`.lime` version 1 has `applyMigrations` and an empty `migrations` list (`src/project.ts`). Settings-profile files are version 1 with the same shape (`src/ui/settings-profiles.ts`). Nothing imports a Prusa, Orca, Bambu, or Cura project.

**User value.** High the day someone arrives with a `.3mf` full of their profiles. Low while the app's own files are still version 1.

**Effort.** Large for foreign projects. Small to keep our own version hook honest, which it already is.

**Who.** UI-only to read a foreign JSON into our preset. Needs engine work in `crates/` (Claude) only if the foreign file must slice the same because of a setting we do not have.

**Dependencies.** Filament and printer libraries, or the import has nowhere to put a vendor printer.

**Compact.** Import is a file button in the sheet.

## Recommended order

Do not rebuild the rows marked exists. This list is the 2026-10-03 order. The [build checklist](#build-checklist-2026-10-06) is the order from here. It follows [Decisions (2026-10-03)](#decisions-2026-10-03).

1. **Printer, filament, and nozzle library.** Our own small catalog, not redistributed Prusa or Bambu profiles. Pressure advance is stored per filament and nozzle size. Vendor start and end G-code is editable header text on the UI side. Mostly UI. The emit path already prints one K.
2. **Ironing and a seam picker.** Rear, nearest, and aligned are enough before seam painting. Ironing before fuzzy skin. Fuzzy skin after those. Arc fitting and variable-width walls stay as they are.
3. **Send to printer: Prusa Link first.** Partial as of 2026-10-04: desktop send, host on the printer profile. Moonraker and OctoPrint still wait. Bambu LAN is out.
4. **Multi-object plates and arrange.** Follow [multi-object-and-support-painting.md](multi-object-and-support-painting.md). UI mock first. Engine when the one-object G-code is still byte-identical.
5. **Support painting, then seam painting.** Same design note. Prune and regrow stay.
6. **Height-range overrides beyond the blend band**, if the per-object key list is settled. Modifier meshes and mesh cut wait on plates.
7. **Repair audit in the UI**, then split-to-objects once plates exist. Hollow and text emboss stay last among mesh tools.
8. **Performance of G-code emit**, when a profile is slow on the inventory's dragon, not before the rows above.
9. **Polish in parallel with whoever owns release:** the tour after the printer picker exists, localization when the strings settle, foreign-project settings import after the libraries exist. Signing trails these rows. Ship unsigned installers until public release.

**Deferred, as of 2026-10-03.** Flow, temperature, and retraction towers waited on the library and the send path. Both exist now, so the [checklist](#build-checklist-2026-10-06) builds the towers after fuzzy skin and seam painting. Multi-material is a design note and UI groundwork only, after the towers. A utility or library for multi-material comes before any toolpath work.

## Questions for Marius

1. For the first printer catalog, do we ship our own profiles, or redistribute Prusa and Bambu profiles and accept their license?
2. Is pressure advance stored per filament, or per filament and nozzle size?
3. Which send-to-printer protocol is first: Moonraker, OctoPrint, Prusa Link, or Bambu LAN?
4. Is Bambu LAN in this stretch at all, given the account and token it implies?
5. Seam work: is a rear/nearest/aligned picker enough before anyone paints a seam?
6. Does ironing outrank fuzzy skin, as this order says?
7. Are flow, temperature, and retraction towers in scope before multi-object, or do they wait?
8. Is multi-material explicitly out until the single-extruder library and send path exist?
9. Should a foreign 3MF (Prusa, Orca, Bambu, Cura) open as mesh-only for now, with settings import later?
10. Who holds the Apple, Windows, and updater keys, and is signing allowed to trail the three feature rows?
11. Is the phone a target for send-to-printer, or desktop first, with compact only required to keep the prepare canvas at or above 70% when a sheet opens?
12. Vendor start G-code: do we run it as text in the header (UI), or is matching a vendor's start sequence engine work?

## Decisions (2026-10-03)

Marius answered the questions above. The [recommended order](#recommended-order) follows these.

1. **Own profiles.** Ship our own printer, filament, and nozzle profiles. Do not redistribute Prusa or Bambu profiles.
2. **Pressure advance.** Store it per filament and per nozzle size, not per filament alone.
3. **Send to printer.** Prusa Link is first. Moonraker and OctoPrint wait behind it.
4. **Bambu LAN.** Out. No account or token client in this stretch.
5. **Seam picker.** Rear, nearest, and aligned are enough before seam painting.
6. **Ironing.** Ironing before fuzzy skin.
7. **Towers.** Flow, temperature, and retraction towers wait. They are not in front of the library, ironing, the seam picker, or Prusa Link.
8. **Multi-material.** Out until the single-extruder library and the send path exist. A utility or library comes before multi-material toolpaths.
9. **Foreign 3MF.** Opens mesh-only for now. Settings import comes later.
10. **Signing keys.** Option A: signing trails the features. Ship unsigned installers for now. At public-release time Marius will get the Apple account, the Windows certificate, and the updater key, and add them as the GitHub secrets the release workflow already names: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The workflow does not read those secrets today. A Windows Authenticode secret is not in that list yet; the certificate joins them at the same time.
11. **Desktop first.** Compact only has to keep the prepare canvas at or above 70% when a sheet opens. The phone is not a send-to-printer target yet.
12. **Vendor start G-code.** UI-side header text. Matching a vendor start sequence is not engine work for now.
