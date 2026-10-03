# Competitive roadmap

Ranked against PrusaSlicer, OrcaSlicer, Bambu Studio, and Cura. Status is what this tree already does. A row is **exists** only when a user can do the thing, **partial** when a piece of it is real and the rest is absent, and **missing** when it is not in the app or the engine.

Shipped work that this list does not treat as a gap: one-mesh slice of STL, 3MF, and STEP (`crates/lime-slice-core/src/load.rs`, `crates/lime-slice-core/src/step.rs`); strategy blends (`crates/lime-slice-core/src/strategy.rs`, README); tree and grid supports with prune and regrow (`docs/support-edits.md`, `src/ui/support-edit-ui.ts`); slice jobs, progress, and cancel (`docs/slice-progress.md`); a `.lime` project (`src/project.ts`); named settings profiles that store a preset and a level (`src/ui/settings-profiles.ts`); undo of placement and settings (`src/app/history.ts`); compact layout with a 70% prepare canvas (`src/ui/compact/`).

Multi-object plates and support painting are designed, not built. The design is [multi-object-and-support-painting.md](multi-object-and-support-painting.md).

## Multi-object plates and arrange

**Status.** Missing.

**User value.** High for anyone printing more than one part. The other slicers arrange a bed and keep each body separate. Here a second file replaces the first (`state.mesh` in `src/app/state.ts`). STEP assemblies and 3MF models become one mesh (`crates/lime-slice-core/src/step.rs`, `load_3mf` in `crates/lime-slice-core/src/load.rs`).

**Effort.** Large for a real plate. Small for a mock that only shows several bounds.

**Who.** Needs engine work in `crates/` (Claude) for separate solids, per-object tours, and sequential printing. The UI can list, place, warn on box overlap, and arrange boxes first, behind a mock that still sends one STL.

**Dependencies.** The design note above. Version 2 of `.lime` (`applyMigrations` in `src/project.ts` is the hook; `migrations` is empty). Undo already records one pose.

**Compact.** The object list already sits in the settings sheet (`objectList` in `src/app/settings.ts`). A longer list must stay inside that sheet so the peek canvas stays at least 70%.

## Printer and filament libraries

**Status.** Partial.

One printer profile is stored and edited: nozzle, filament diameter, temperatures, bed size, volumetric cap, accel, density, cost, pressure advance, and linear advance (`src/profiles.ts`, `profileFields` in `src/app/settings.ts`). Import and export are one JSON file. The default is "Generic Marlin 0.4 mm PLA". Named settings profiles are slice presets, not printers or filaments (`src/ui/settings-profiles.ts`). There is no vendor catalog and no filament that carries its own pressure advance apart from that one profile. The engine already emits Klipper `SET_PRESSURE_ADVANCE` and Marlin `M900` from those two numbers (README, `crates/lime-slice-core/src/strategy.rs`).

**User value.** Highest of the gaps. A wrong bed or a wrong K ruins the first print. PrusaSlicer, Orca, Bambu Studio, and Cura open on a named printer and a named filament.

**Effort.** Medium. The catalog is data plus UI. Per-filament K is a field the emit path already understands, moved off the single profile.

**Who.** UI-only for a bundled catalog, pickers, and save/import of printer and filament files. Needs engine work in `crates/` only if a vendor start G-code or a filament-specific flow model must change the toolpath, not just the header lines.

**Dependencies.** None on plates or painting. Reuses the versioned-file checks from `src/project.ts` and `src/ui/settings-profiles.ts`.

**Compact.** Two pickers in the existing Device page (`devicePage` in `src/ui/compact/mount.ts`) and the printer block in the sheet. The bed size they set is what `offBed` already checks (`src/mesh-place.ts`).

## Print-quality features

### Seam control

**Status.** Partial.

Scarfed seams, aligned seams on a sharp corner, and nearest seams are in the planner and on by default (`--scarf-seam`, `--travel-opt` in the README; `scarfSeam` in `src/app/settings.ts`). There is no seam painter and no "rear / random / aligned" picker beyond scarf off, outer, and all.

**User value.** High. Seam position is the first thing people compare on a calibration cube.

**Effort.** Small for a placement picker if the planner already has aligned and nearest. Medium for a painted seam.

**Who.** A picker is UI plus a small engine flag (Claude, `crates/`). A painted seam is engine work.

**Dependencies.** Painted seams share the brush with support painting. The picker does not.

**Compact.** One select in the Strength group, which is already in the sheet.

### Ironing

**Status.** Missing.

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

**Status.** Missing.

Export writes a G-code file (`exportGcode` in `src/app/files.ts`). Nothing speaks OctoPrint, Moonraker, Bambu LAN, or Prusa Link.

**User value.** High. Orca and Bambu Studio are used because the slice lands on the machine. A download is the step people want to skip.

**Effort.** Medium per protocol. The slice does not change.

**Who.** UI-only. Each sender is a client of an HTTP API. No `crates/` planner work. A desktop build can use the same fetch the browser uses, unless a vendor SDK is required later.

**Dependencies.** A printer profile that stores the host URL. That is the library row, not a new slicer.

**Compact.** Send belongs on the Device page next to Share. The canvas stays put.

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

**Status.** Missing.

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

**Status.** Partial.

By-region blend is one plane: low side toughness, high side speed (`byRegion` in `src/app/settings.ts`, drag in Prepare). It is not a box, a mesh, or a stack of modifier shapes. By-layer blend is one height band, below.

**User value.** Medium. Modifier meshes are how the other slicers change infill in one place. The plane covers the simple case.

**Effort.** Large for arbitrary meshes. Small to keep the plane and document it as the modifier we have.

**Who.** Needs engine work in `crates/` (Claude) for a mesh modifier. The plane is done.

**Dependencies.** Per-object settings from the plate design, if a modifier is an object with no walls.

**Compact.** The plane already drags on the prepare canvas. A mesh modifier needs a pick that does not cover the model.

### Height-range settings

**Status.** Partial.

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

Do not rebuild the rows marked exists. This list follows [Decisions (2026-10-03)](#decisions-2026-10-03).

1. **Printer, filament, and nozzle library.** Our own small catalog, not redistributed Prusa or Bambu profiles. Pressure advance is stored per filament and nozzle size. Vendor start and end G-code is editable header text on the UI side. Mostly UI. The emit path already prints one K.
2. **Ironing and a seam picker.** Rear, nearest, and aligned are enough before seam painting. Ironing before fuzzy skin. Fuzzy skin after those. Arc fitting and variable-width walls stay as they are.
3. **Send to printer: Prusa Link first.** After the profile can store a host. No slice changes. Moonraker and OctoPrint come after. Bambu LAN is out.
4. **Multi-object plates and arrange.** Follow [multi-object-and-support-painting.md](multi-object-and-support-painting.md). UI mock first. Engine when the one-object G-code is still byte-identical.
5. **Support painting, then seam painting.** Same design note. Prune and regrow stay.
6. **Height-range overrides beyond the blend band**, if the per-object key list is settled. Modifier meshes and mesh cut wait on plates.
7. **Repair audit in the UI**, then split-to-objects once plates exist. Hollow and text emboss stay last among mesh tools.
8. **Performance of G-code emit**, when a profile is slow on the inventory's dragon, not before the rows above.
9. **Polish in parallel with whoever owns release:** the tour after the printer picker exists, localization when the strings settle, foreign-project settings import after the libraries exist. Signing trails these rows. Ship unsigned installers until public release.

**Deferred.** Flow, temperature, and retraction towers wait. Multi-material waits until the single-extruder library and the send path exist. A utility or library for multi-material comes before any toolpath work.

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
