# Temperature tower

A hollow single-wall tower, one nozzle temperature per band. The chosen band is written onto the filament's existing nozzle temperature. There is no new slice field. A request that does not change that temperature keeps the G-code it had before, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- The tower is a generator beside `calibrate pa`. It does not add a field to `SliceSettings` or to the printer profile. Nozzle temperature is already on the profile, and the profile's debug digest is the preview token, so a new field would move that token even when unused.
- Each band is one 30 mm square wall at (20, 20). The nozzle sends `M104` and then `M109` before the wall, so the band prints fully at that temperature. The first band is also the temperature the preamble waits for.
- Temperatures are integer degrees. A band must be from 150 °C to 320 °C. The step is at least 1 °C. The defaults are 190 °C to 230 °C in steps of 5, and each band is 5 mm tall, at 40 mm/s. A range longer than 40 bands stops at 40.
- Bed temperature stays the filament's bed temperature. The tower does not step it.
- Saving a band writes that integer onto the active filament. A normal slice then sends it as `nozzleTemp`, the field the printer profile already had. Undo writes the same number back onto the filament.
- `classic` has nothing to force off. There is no new request field.

## Cache keys

The disk cache hashes the client JSON. This generator is not part of a slice request, so it does not change a disk key. Changing the filament nozzle temperature changes the printer profile, which already changed the preview token and the slice before this tower existed.

## Wire

`lime-slice calibrate temp` writes the tower. The UI posts `/api/calibrate/temp`. The desktop app invokes `calibrate_temp`.

A start, end, or step that is not finite is refused: `temperature start, end, and step must be finite`. A step under 1 °C is refused: `temperature step must be at least 1 °C`. An end below the start is refused: `temperature end is below the start`. A band outside 150 °C to 320 °C is refused: `temperature 100 °C must be from 150 to 320`.

The tower header is `; TEMP_CALIBRATION`. Each band is `; TEMP_BAND`. The wall is `TYPE:TEMP_WALL`.

## UI

An expert group, Temperature calibration, generates the tower, lists the bands, and saves the chosen °C onto the filament. The machine line already shows that nozzle temperature. A slice body does not gain a temperature field of its own.
