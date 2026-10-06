# Multi-material, stored only

One nozzle, one filament, no tool change. The slice keeps using the filament selected above the new field. A second filament can be remembered on the machine so a later toolpath has a place to read it. This change does not add that toolpath.

## Decisions

- `secondFilamentId` is optional on the machine library. Omitted when none is chosen, so a library that never set it keeps its JSON.
- The slice request and `enginePrinter` do not gain a field. G-code, the disk cache key, and the settings hash stay what they were.
- Choosing the second filament as the slice filament clears the slot, so the two are never the same id.
- An unknown id, or one whose filament was deleted, is dropped on load.
- There is no purge tower, no `T` command, and no second extruder. The sheet says so next to the control.
- `classic` is unchanged, because the engine never sees the second filament.

## UI

The machine block has a Second filament select. None is the default. The note under it says the slice still uses the first filament.
