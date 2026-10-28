---
type: Reference
title: Profiles
description: Print settings, the machine library, and named settings profiles are separate stores. Factory print settings start at the speed strategy.
tags: [settings, profiles]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: preset
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/presets.ts
    title: src/presets.ts
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-schema.ts
    title: src/ui/settings-schema.ts
  - id: profile
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/profiles.ts
    title: src/profiles.ts
  - id: machines
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library-store.ts
    title: src/ui/machine-library-store.ts
  - id: library
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library.ts
    title: src/ui/machine-library.ts
  - id: named
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-profiles.ts
    title: src/ui/settings-profiles.ts
  - id: store
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-profile-store.ts
    title: src/ui/settings-profile-store.ts
---

# Three stores

They are not one profile type.

| Store | Key or file | What it holds |
| --- | --- | --- |
| Legacy printer profile | `localStorage` `lime-slice.profile.v1` | One `PrinterProfile`. `defaultProfile()` is named "Generic Marlin 0.4 mm PLA", 0.4 mm nozzle, 1.75 mm filament, 200/60 °C, 220 × 220 × 250 mm bed.[3] |
| Machine library | `localStorage` `lime-slice-machines` | Printers, filaments, the selected printer and filament, and the nozzle. Version 3. Start G-code, end G-code, and the printer host stay here and are not added to the slice request.[4] [5] |
| Named settings profiles | `localStorage` `lime-slice-settings-profiles`, export `*.limeprofile.json` | Version 1: a name, a `PresetSettings` object, and a settings level.[6] [7] |

The machine library's built-in printers and filaments are listed in [FDM printers](../printers/fdm.md) and [Belt printers](../printers/belt.md).

# Print settings

`PresetSettings` is what a profile or a project stores, compared with the factory defaults. `DEFAULT_PRESET` is a single blend, strategy `"speed"`, layer height 0.2 mm, adhesion `"skirt"`, supports off, support style `"tree"`, support source `"auto"`. Top surface pattern is `"auto"`. XY compensation fields are 0, which the comments say are omitted from a slice. Adaptive layers are off. Support gap fields are 0, which the comments say are omitted so the engine keeps its own gap.[1]

The settings panel's group ids are `strategy`, `objects`, `quality`, `walls`, `infill`, `speed`, `temperature`, `cooling`, `supports`, `printer`, `calibrate`, and `gear`. The schema file says it is the one table of settings controls: the left panel, search, tier filter, and modified dots all read it.[2]

Strategy cards in that schema are speed, efficiency, toughness, layer, and region. Efficiency is the weight blend. The engine's named strategies are only speed and toughness. See [FDM printers](../printers/fdm.md).

A project file stores the preset overrides on the plate. The deprecated `preset` field is kept for older files. See [Parameters](../modeler/parameters.md) for the separate `parameters` table, which is not a slice setting.

# Citations

[1] [src/presets.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/presets.ts)
[2] [src/ui/settings-schema.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-schema.ts)
[3] [src/profiles.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/profiles.ts)
[4] [src/ui/machine-library-store.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library-store.ts)
[5] [src/ui/machine-library.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/machine-library.ts)
[6] [src/ui/settings-profiles.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-profiles.ts)
[7] [src/ui/settings-profile-store.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/src/ui/settings-profile-store.ts)
