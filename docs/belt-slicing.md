# Belt slicing

A belt printer (Creality CR-30, iFactory3D One, BlackBelt, PowerBelt3D) lays each layer on a plane tilted to an endless belt, usually at 45°. The belt advances one step per layer and the part can be as long as the belt. This note is the engine plan. The UI can store a belt profile and draw a stand-in before any of it lands. Nothing under `crates/` changes for that.

## Decisions

- Slice with the planar pipeline. Rotate the mesh so the nozzle plane is horizontal, plan, then map toolpaths back. A shear is what BeltEngine feeds Cura, and it is the wrong frame for this planner.
- Belt advance per layer is `layer_height / sin(α)`. `α` is the angle between the belt and the nozzle plane. 45° is the default. At 45° the step is `layer_height * √2`.
- Belt fields live on the machine profile (`.limemachine.json`), not on `SliceRequest`, until the engine reads them. A cartesian request keeps its cache key and its G-code bytes.
- Supports stay off on a belt slice until they are grown in the rotated frame. Today's supports assume a horizontal bed.
- Copies are one planned part, emitted again with a belt shift. They do not enter the contour key.
- With no belt field, G-code is byte-identical. `tools/golden_ab.sh` is the check.

## How a belt printer prints

The nozzle moves in a plane that is tilted to the belt by `α`. The belt is the bed. It is level. Gravity still points down, but the previous layer is not directly underneath in the lab frame. It is one belt step behind, and the nozzle plane is what the new layer sits on.

On the CR-30, on BlackBelt, and on the printers ideaMaker's belt mode targets, the firmware axis that advances the belt is Z. X runs across the belt. The other gantry axis runs along the nozzle plane, up the slope. A layer is a move in that plane. Z is constant for the layer, then the belt steps. The step is `h / sin(α)`, where `h` is the bead thickness measured perpendicular to the nozzle plane, which is the layer height a user means.

The belt has a usable width and no natural length. A profile can cap the length or leave it open. Back-to-back copies are the reason the length is open: the same part repeats along the belt with a gap. Creality shipped the CR-30 on that idea, and BlackBelt Cura is built around it.

`α` is not the same number in every slicer. BeltEngine's `blackbelt_gantry_angle` is the angle whose sine scales layer height (below). The BirthT port of the BlackBelt plugin defaults to 35° for the Leee printer and tells a CR-30 owner to set 45°. OrcaSlicer's belt work talks about `layer_height / cos θ` because its `θ` is measured from the other leg of the right angle. At 45° the two formulas agree. This plan uses `α` from the belt up to the nozzle plane, and `sin`.

## What other slicers do

BeltEngine ([Autodrop3d/BeltEngine](https://github.com/Autodrop3d/BeltEngine), the fieldOfView BlackBelt preprocessor, with a `CR30.cfg.ini`) does not teach CuraEngine about tilted planes. `MeshPretransformer` shears and scales the mesh so a horizontal Cura slice is a tilted belt slice: Z is scaled by `1/sin(α)`, sheared into Y by `-1/tan(α)`, then the axes swap so the front of the volume is Cura's floor. Before that, `layer_height` and `layer_height_0` are divided by `sin(α)`, and `material_flow` is multiplied by `sin(α)`. Supports are forced off inside Cura. A separate mesh is built in the tilted frame, with a down vector biased by the gantry angle, and handed to Cura as a support mesh. A raft mesh and a belt-wall post-process (slower, more flow on the loops that touch the belt) are optional. The same plugin lives in [BlackBelt3D/Cura](https://github.com/BlackBelt3D/Cura). [tokoshie3d/BeltPrinterSlicing](https://github.com/tokoshie3d/BeltPrinterSlicing) is that plugin on a current Cura, and it is what a CR-30 runs when the gantry angle is set to 45°. Creality's PrintMill slicer is that Cura fork.

ideaMaker's belt mode ([Belt Printer](https://support.raise3d.com/ideaMaker/4-5-1-2-belt-printer-15-1389.html)) keeps the tilt inside the slicer. It adds a belt offset, a belt raft (a few layers on the belt before the part, with their own speed and flow), a belt wall (the outer-shell segments that touch the belt, again with their own speed and flow, and a minimum length), and "place seam on belt edge", which starts outer shell, inner shell, and support outline on the belt-contact edge. The CR-30 profile in the ideaMaker library is a 45° machine and asks for relative extrusion.

[OrcaSlicer #12998](https://github.com/OrcaSlicer/OrcaSlicer/pull/12998) started as a rotation, `R(-α, X)`, so the existing slicer never learned a new plane, then moved the mesh transform to a shear (`Y += Z * cot(α)` by default) and put the inverse on the G-code writer. It splits firmware in two. A CR-30-style machine applies the tilt itself, so the file is a logical gantry frame plus an axis remap. A machine that does not compensate needs the shear as well, or the part comes out skewed. Doing both skews it twice.

## Where it meets this engine

The cut is horizontal. `ZIndex::slice` builds one band per layer height from Z 0 (`crates/lime-slice-core/src/slice.rs`). Toolpaths, the tour, combing, and supports all consume those bands. `emit_gcode` (`crates/lime-slice-core/src/gcode.rs`) writes a Marlin preamble (`G28`, absolute E, bed and nozzle temperatures from `PrinterProfile`) and one `;LAYER:{n} Z:{z} H:{h}` per layer. On layer 0 the feed is capped at 30 mm/s and the flow is 1.06. Preview paths are `PreviewPath` (`slice.rs`): a `kind` from `PathKind` (`toolpath.rs`: skirt, wall, outer, inner, thin-wall, gap-fill, infill, sparse, solid, top, bridge, support, support-interface, ironing), XY points, and `zs`. Empty `zs` means the layer Z. The UI draws `zs` as height (`src/preview-geom.ts`).

`PrinterProfile` (`strategy.rs`) is nozzle, temperatures, bed size, flow cap, accel, density, cost, pressure advance, and linear advance. Serde drops fields it does not know. The disk cache does not: `slice_cache::feed` hashes the request body, and `recipeKey` in `src/slice-action.ts` copies that. An extra field on the request is a different slice even if the engine ignores it.

Kept stages are `kept::keys` (`slice/kept.rs`). One SHA-256 per stage over the posed triangles, the nozzle, the layer bands, and a `SliceSettings` with later fields blanked:

- `contours` has no blend. Seam, ironing, overrides, feature speeds, and the emit flags are blank.
- `toolpaths`, `order`, and `comb` add those back in pipeline order. `arc_fit`, the estimator, and junction deviation are blanked before `comb` (`no_emit`), so they never join a contour key.
- `grow` and `paint` are the supports. `whole` is everything except the edits, the skeleton flag, `previewBase`, and the job.
- `kept::LayerKeys` is the part stages again with overrides and ironing blanked, so a layer whose own inputs match is taken from a kept plan.

A new setting lands in every stage key unless it is blanked the way `feature_speeds` is blanked on `contours`.

## Coordinate approach

**Rotation, then the existing pipeline, then the inverse.** Rotate the posed mesh about the across-belt axis until the nozzle plane is horizontal. The cutter, the walls, the infill, the seams, and the combing run unchanged. Rotate each toolpath point back. Lengths in the nozzle plane are the lengths the planner used. A 0.45 mm wall is 0.45 mm on the plane. A 100 mm/s feed is 100 mm/s along that path. Extrusion volume is `width * height * length` with `height` the perpendicular bead. The volumetric cap stays honest.

**Shear, which is what BeltEngine does, is a different trade.** The shear-and-scale above maps the tilted plane to Cura's floor, but it is not an isometry. Path length in the slice plane is not nozzle-plane length, so a circle becomes an ellipse and a commanded feed is not the nozzle speed. BeltEngine's `flow *= sin(α)` and `layer_height /= sin(α)` put the volume and the layer count back and leave the speed and the ellipse. This planner derives width from the nozzle and speed from the strategy, then caps speed by volume. Compensating inside those stages means touching every one of them. Compensating outside, by rotating, touches none.

**Emit is a second, smaller map**, after the inverse rotation has put points back in the gantry frame:

- Across-belt axis: the slice X.
- Axis along the nozzle plane: the slice Y. Rotation preserved it, so it is the rail length.
- Belt axis: constant on a layer, `n * h / sin(α)` from the start of the belt. The sign is the profile direction.
- The profile names which firmware axis is the belt. Z is the usual one. X and Y are there for a machine that wired it differently.

That is the gantry frame the CR-30 and BlackBelt firmwares run: the tilt is the mechanics, and the file does not also shear into world coordinates. A firmware that expected vertical Z would need a further shear. None of the four machines this note is for do. Orca's split is the warning: do not apply that shear on top of a firmware that already compensates.

Layer height in the slice is `h`, the perpendicular bead. The belt step is longer than `h` by `1/sin(α)`. Line width is unchanged. Speeds stay nozzle-plane speeds. The short belt step between layers is a travel on the belt axis, timed by the estimator that already times segments (`emit_estimates` is the same scan as `emit_gcode` with the text omitted). It is not a cartesian Z hop.

## First layers and the sliver

The first tilted plane meets a part that sits on the belt in a thin polygon. `drop_slivers` (`poly.rs`) throws away a loop under a minimum area. Skin uses 0.05 mm² (`SKIN_SLIVER_MM2` in `toolpath.rs`). A true first contact can be thinner than that, and on a belt that sliver is the adhesion, not noise.

BeltEngine and ideaMaker do not solve this by keeping every speck. They put a raft on the belt, a few layers before the part, so the first real plane has area, and they mark the belt-contact edge of the part as its own feature (belt wall): slower, more flow. ideaMaker also pulls the seam onto that edge.

On this engine the "first layer" is `layer.index == 0` only: 30 mm/s, flow 1.06, fan off (`gcode.rs`). On a belt every layer has a belt-contact edge. That edge is the first layer, on every layer. Phase 2 applies the layer-0 speed and flow there, and adds the raft. Phase 1 of the engine keeps `drop_slivers` as it is. Lowering the global threshold would keep specks in cartesian slices. A belt raft is the adhesion answer, not a quieter sliver filter.

## Overhangs

In the rotated frame, down is the nozzle normal, not gravity. The previous layer supports the next one along that normal. A face that leans with the belt (the side the belt carries away) can pass vertical in the lab and still sit on plastic. A face that leans against the belt (back toward the gantry) loses the previous layer sooner.

Support generation therefore runs after the rotation, against a belt floor in that frame. BeltEngine builds an extra mesh with `down_vector` tilted by the gantry angle and refuses Cura's own supports. Orca clips supports to a belt-floor polygon for the same reason. Phase 2 here does the same with the existing tree walk: the floor is the rotated belt, not Z 0. Until that exists a belt slice forces supports off. Emitting today's horizontal supports would plant them on a bed the printer does not have.

## Profile and the machine file

`.limemachine.json` and the stored library are version 2. Version 2 added the Prusa Link host (`migrateMachineVersion1` in `src/ui/machine-library.ts`). Version 3 adds the belt, the same way: a function at index 2 of `machineMigrations` rewrites a version-2 document into version 3.

A version-2 printer gains:

- `kind`: `"cartesian"`.
- `belt`: angle 45°, axis `"z"`, direction `+1`, width copied from `bedX`, `maxLengthMm` null (unlimited), copies 1, gap 5 mm.

Nothing else moves. Bed, temperatures, start and end G-code, and the host stay. A version-1 file still climbs through version 2, then this step. A newer version is still refused. `enginePrinter` keeps returning only the fields `PrinterProfile` knows. Belt, start G-code, end G-code, and the host stay off the slice request, so `recipeKey` and `slice_cache::feed` do not move.

When the engine accepts a belt, the request gains one object, omitted unless `kind` is belt, the same way empty `supportEdits` are omitted:

```json
"belt": { "angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 200, "maxLengthMm": null, "copies": 1, "gapMm": 5 }
```

`maxLengthMm: null` is omitted rather than sent as null, so a missing cap is the same bytes as an unlimited belt. `deny_unknown_fields` on that object, as on a support edit. A bad angle (outside 10° to 80°, where `sin` collapses) is an error that names the field.

`bedZ` stays the printable height above the belt. `bedX` stays the cartesian width. The belt's usable width is `widthMm`, which defaults from `bedX` and can be narrower. `bedY` is unused on a belt; the length is `maxLengthMm` or none.

## G-code, preview, and time

The preamble stays the one `write_preamble` writes, plus one comment when the request has a belt: `; belt: angle 45 axis Z dir +1`. No belt comment, no other change, so a cartesian file is the same bytes. Start and end G-code already live on the printer and are not sent today. `G28` in the preamble homes whatever the firmware maps to Z. That is a belt home on these machines. It stays the firmware's start G-code to replace, not a second homing policy in the emitter.

Each layer's Z in `;LAYER:` and in the motion is the belt position. H stays `h`, the perpendicular height, and extrusion volume keeps using H. XY in the file are the gantry plane. Absolute E is unchanged, so a kept stage still cannot skip emit above an edit: E depends on every layer below (`docs/support-edits.md`).

Preview points carry `zs` as height above the belt in the lab frame, so a layer draws as a tilted plane. The layer's own `z` stays the belt position the scrubber already prints. A later toggle can show the machine frame. The UI mock is not this. It draws outlines only, and it is labelled.

Print time is the existing estimator on the transformed segments. There is no second model. The belt step is a short travel. Feeds on the nozzle plane are the feeds the estimator already uses.

## Cache keys

The rotation is part of the mesh the contour key hashes. Angle, axis, and direction change those triangles or the emitted coordinates.

- Angle changes the rotated mesh, so it belongs in the mesh hash. It also changes the belt step, which is emit.
- Axis and direction change only emit. They are blanked with `arc_fit` and the estimator, in `no_emit`, so a direction change re-emits and does not recut.
- Copies and gap are emit-only too. The part is planned once. Emit repeats it, shifted along the belt by the part's extent along the belt plus the gap. The extent is already in the mesh hash. The count and the gap are not.
- A request with no `belt` field builds the keys it builds today. Golden covers that.
- The disk key is the request. Omitting `belt` on a cartesian slice is what keeps the key. `previewBase` stays out of it, as now.

`bedY` is not a stand-in for belt length. Putting the length in `bedY` would change the part frame (`docs/part-frame.md` centers the pivot on `bedX / 2, bedY / 2`) and would look like a different cartesian printer.

## Test plan

- `tools/golden_ab.sh`: a request with no belt field matches today's G-code, byte for byte, including a cube.
- Once the engine flag is on: a 20 mm cube at 45°, 0.2 mm layers. Belt step `0.2 * √2`. The XY length of a wall matches the nozzle-plane length, not the sheared length. A second cube at 35° checks that the step is `h / sin(35°)`, not `h / cos(35°)`.
- An overhang part: supports forced off, and the face that leans against the belt is the one a later support phase has to hold. The golden file records the unsupported toolpath so phase 2 has a diff to explain.
- Copies: two copies, one contour plan (`stages.reused` or a layer count that does not double the cut), two placements in the file separated by extent plus gap.
- Profile: a version-2 `.limemachine.json` loads as cartesian with the default belt block, and its bed numbers are unchanged. A version-3 belt file round-trips. `enginePrinter` still has today's keys.
- UI, until the engine: the mock's `gcode` is empty, export and send stay off, and a cartesian slice still calls the engine.

## Phases

1. UI only. Version 3 of the machine file, a Belt kind, the fields above, the prepare view as a belt with the tilted plane and N copies, and a mock adapter on the UI side. The mock does not produce G-code. Export and send stay off. No crate changes.
2. Engine. Rotate, slice, inverse-rotate, emit the gantry frame. Supports forced off. Golden cube and overhang. `golden_ab.sh` for a request with no belt field.
3. Belt contact. Raft, belt wall (layer-0 speed and flow on the contact edge of every layer), seam on that edge. Sliver policy stays global.
4. Supports in the rotated frame, on a belt floor, with the down vector tilted by `α`.
5. Lab-frame preview from real `zs`, and print time from the transformed segments. The mock goes away.

## Review questions

1. Is rotation of the mesh, so the nozzle plane is horizontal, the slice frame, with the gantry-axis remap only at emit, so widths, speeds, and flow stay the planner's nozzle-plane numbers?
2. Is belt advance per layer `layer_height / sin(α)`, with `α` the angle between the belt and the nozzle plane, default 45°? At 35° that disagrees with a formula written as `h / cos θ`.
3. Do belt fields stay off `SliceRequest` and off `enginePrinter` until the engine reads them, so a cartesian request keeps its cache key and its G-code bytes?
4. Is version 3 of `.limemachine.json` the right bump, with a version-2 file migrating to `kind: "cartesian"` and a default belt block that is stored and not sent?
5. Is the emit frame the gantry frame (belt axis constant per layer, the other two axes spanning the nozzle plane), with no extra world-space shear, for the CR-30, iFactory3D, BlackBelt, and PowerBelt3D?
6. Should `drop_slivers` stay at its present areas, and the first-contact sliver be handled by a belt raft in phase 3, rather than by lowering the threshold for every slice?
7. Is the belt-contact edge of every layer the first layer (today 30 mm/s and flow 1.06 on `layer.index == 0` only), and is that phase 3 with the belt wall?
8. Should a belt slice force supports off until they are grown in the rotated frame against a belt floor, so today's horizontal supports are never emitted for a belt?
9. Are back-to-back copies one planned part emitted N times with a belt shift, so the count and the gap stay out of the contour key?
10. Is a belt preview's `zs` the height above the belt, is the print time the existing estimator on the transformed segments, and is the UI mock forbidden from standing in for either once phase 2 exists?
11. Is the bar a golden cube, a golden overhang with supports off, a 35° step check, and `tools/golden_ab.sh` byte-identical for a request with no belt field, before the engine flag turns on?
