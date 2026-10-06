# Flow tower

A hollow single-wall tower, one flow multiplier per band, and a filament field that scales extrusion on a normal slice. Both are off at `1`. A request that omits `flow` keeps the G-code it had before, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- `flow` is a plate setting, beside `ironing`. An object that sets it is refused.
- It is not a field of the printer profile. The profile's debug digest is the preview token, so a new printer field would move that token even at `1`.
- The number lives on the filament. Missing, in a library saved before this, reads as `1`. The slice body carries it only when it is not `1`.
- At emit, every extrusion's filament length is that multiplier times the length it had. `1` times a float is the same float, so the E values do not move. The first layer's `1.06` and a path's own flow still apply, and this multiplies them.
- Speeds stay where the volumetric cap put them for a multiplier of `1`. A multiplier above `1` can print a little over that cap.
- Contour and toolpath keys blank it. The cut and the paths do not move. Only the emitted length changes. Adding the field still changes those keys once, because they hash `Debug` of the settings, including `flow: 1.0`.
- `classic` does not force it off. It is a filament scale, the same kind of thing as pressure advance.
- The tower is a generator beside `calibrate pa`. Each band is one 30 mm square wall. Extrusion length is scaled by the band. `M221` is not sent, so a firmware flow percentage cannot stack on the scaled length. The tower does not add the writer's first-layer `1.06`.
- A band is from `0.5` to `1.5`. The defaults are `0.9` to `1.1` in steps of `0.05`, and each band is 5 mm tall. The chosen band is written onto the filament.

## Cache keys

The disk cache hashes the client JSON. Leaving `flow` out of that JSON leaves the disk key unchanged. `null` is a different JSON object, so a client that sends `null` instead of omitting the field gets a different disk key. `1` serializes as absent.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding `flow: 1.0` changes that text once. The stage copies used for contours and toolpaths set it back to `1.0`, so turning the multiplier away from `1` does not replan those stages. It does not change a stored request or a cartesian file.

## Wire

`flow` is omitted at `1`. A value outside `0.5` to `1.5`, or not finite, is refused: `flow 2 must be from 0.5 to 1.5`.

The G-code header gains `; flow 1.050` when it is not `1`.

`lime-slice calibrate flow` writes the tower. The UI posts `/api/calibrate/flow`. The desktop app invokes `calibrate_flow`.

## UI

A flow field on the filament, default `1`, step `0.01`, from `0.5` to `1.5`. The flow calibration group, expert, generates the tower, lists the bands, and saves the chosen multiplier onto the filament. Off `1`, the slice body does not carry the field.
