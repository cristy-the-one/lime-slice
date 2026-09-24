# Lime Slice

Filament FDM slicer. A Rust core turns an STL or 3MF mesh into toolpaths, and a Tauri 2 desktop UI previews them. Named strategies (`speed`, `toughness`) are real parameter sets — wall count, infill pattern and density, print speed, acceleration, seam, retraction — and blends mix those outputs by weight, by layer, or by region.

## Run the UI

Two processes. The slicer is the Rust binary; the window is either the browser dev server or Tauri.

```bash
cargo run -p lime-slice --release -- serve
npm install
npm run dev
```

Open [http://127.0.0.1:43117](http://127.0.0.1:43117). Load a sample, pick a blend, slice, scrub layers, export G-code.

The stage defaults to **Split**: the existing 2D toolpath preview on the left, and a 3D view of the same slice on the right. **2D** and **3D** hide the other pane. The layer slider (and the wheel over the 2D canvas) moves the active layer in both views. In 3D the active layer is drawn solid, with an amber band of that layer's thickness, and every other layer is ghosted. Drag to orbit, right-drag to pan, wheel to zoom. Support and interface paths use the same colors as the 2D legend. Adaptive layers keep their real Z spacing.

Desktop shell (needs WebKitGTK 4.1 on Linux):

```bash
npm run tauri dev
```

The API listens on `127.0.0.1:43118`. Inside Tauri the UI calls `slice_model` instead of HTTP.

Linux builds of the Clipper2 binding need `g++` and libstdc++ on the linker path. This repo sets that in `.cargo/config.toml`.

## Headless slice and bench

```bash
cargo run -p lime-slice --release -- bench samples/lime_hull.stl
cargo run -p lime-slice --release -- slice samples/calibration_cube_20mm.stl --blend region --at 10 -o cube.gcode
cargo run -p lime-slice --release -- slice samples/slope_ramp.stl --blend speed --adaptive -o ramp.gcode
cargo run -p lime-slice --release -- slice samples/overhang_ledge.stl --blend speed --supports -o ledge.gcode
```

Blend names: `speed`, `toughness`, `weight` (alias `efficiency`), `layer`, `region`.

Feature knobs default on. Turn one off with `--variable-width false`, `--arc-fit false`, `--travel-opt false`, or `--overhang-control false`. `--classic` is the previous planner: line infill for the full height, no variable walls, no arcs, no overhang slowdown, and a full triangle scan.

Adaptive layers and supports are off unless you ask for them, so a bench stays comparable to a fixed 0.2 mm slice. `--adaptive` varies each layer inside `--adaptive-min` (default 0.08 mm) and `--adaptive-max` (default: the nominal layer height). Vertical walls take the thick end of that band; slopes that turn toward horizontal take the thin end. `--supports` builds a sparse grid under overhangs steeper than `--support-angle` (default 45° from horizontal), with three denser interface layers and a one-layer air gap. Support spacing and speed follow the resolved strategy: toughness is denser and slower than speed. Both apply on top of whichever blend is selected.

## Samples

| File | What it is |
| --- | --- |
| `samples/calibration_cube_20mm.stl` | 20 mm cube, 12 triangles |
| `samples/calibration_cube_20mm.3mf` | The same cube as 3MF |
| `samples/lime_hull.stl` | Original 60 × 24 × 28 mm superellipse prism, 4800 triangles |
| `samples/overhang_ledge.stl` | 24 mm base plus a 24 mm shelf at Z = 12, 24 triangles |
| `samples/slope_ramp.stl` | Vertical block with a roof rising from Z = 8 to Z = 20, 12 triangles |
| `samples/thin_fin.stl` | 18 mm pad with a 0.7 mm fin, 24 triangles |
| `samples/bridge_span.stl` | Two towers and a 14 mm deck, 36 triangles |
| `samples/arc_post.stl` | 64-gon cylinder, 12 mm radius, 256 triangles |

Regenerate with `python3 tools/gen_samples.py`.

## Measured timings

Release build (`lto = "thin"`, codegen-units 1, `cargo +stable`), one machine, layer height 0.2 mm, line width 0.45 mm, adaptive layers off, supports off. **Slice** is plan + G-code for the new path. **Classic** is the same blend on the previous planner (full-height line infill for speed, no variable walls, no arcs, no overhang control, full triangle scan). Print time and filament mass come from the motion estimator (trapezoid with junction deviation, volumetric cap 12 mm³/s on the new path). Scores are `speed = 60 / minutes`, `efficiency = 8 / grams`, `toughness` = structural mm³ weighted by pattern (gyroid above lightning).

Contour extraction on the hull (140 layers, 4800 triangles): parallel Z-index **1.60 ms**, single-thread full scan **10.53 ms**. The cube has 12 triangles, so the index does not pay (0.36 ms vs 0.18 ms).

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 1.40 | 1.25 | 184.9 | 328.2 | 1.83 | 2.73 | 1757 | 2309 |
| toughness | 35.56 | 35.11 | 5230.1 | 6251.1 | 10.33 | 10.33 | 10894 | 10894 |
| layer blend | 11.99 | 10.49 | 1573.4 | 1966.7 | 4.73 | 5.33 | 4710 | 5089 |
| region blend | 15.28 | 15.59 | 2497.8 | 3056.2 | 6.44 | 6.84 | 6623 | 6873 |

Speed on the cube is 44% less print time and 33% less filament. The toughness index is unchanged. Classic speed filament is 916 mm; the lightning slice is about 615 mm.

`samples/lime_hull.stl` — 4800 triangles, 140 layers:

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 25.66 | 21.89 | 676.3 | 1433.2 | 4.67 | 8.96 | 4471 | 7046 |
| toughness | 289.55 | 249.78 | 24846 | 29851 | 43.79 | 43.79 | 46764 | 46764 |
| layer blend | 101.91 | 84.96 | 7291 | 9329 | 17.78 | 20.74 | 17950 | 19747 |
| region blend | 138.94 | 117.64 | 12180 | 15219 | 24.72 | 26.79 | 25993 | 27233 |

Hull speed is 53% less print time and 48% less filament (classic 3006 mm). Wall arcs add a few milliseconds of slice time; the contour index is the part that drops, from 10.53 ms single-thread to 1.60 ms. Toughness stays on gyroid and its structural score does not drop. The hull speed slice emits 2248 `G2`/`G3` moves.

`samples/arc_post.stl` speed: 118 arcs, print 80 s vs classic 176 s, filament 0.58 g vs 0.82 g. `samples/bridge_span.stl` speed tags `BRIDGE` spans at ≤ 36 mm/s. `samples/thin_fin.stl` puts a bead that is not 0.45 mm on the 0.7 mm fin.

## Layout

- `crates/lime-slice-core` — mesh load, contour slice, strategy blend, toolpaths, G-code
- `crates/lime-slice` — `slice`, `bench`, `serve`
- `src-tauri` — Tauri 2 shell over the same core
- `src` — TypeScript preview UI (2D layer canvas plus a Three.js 3D slice view)
- `samples` — checked-in meshes

## Strategies

- **Speed:** 2 walls, lightning infill within 4 mm of a roof, 140 mm/s, 3500 mm/s², nearest seam on a sharp corner, short retract, 1 skirt.
- **Efficiency:** the weight mix. Low toughness keeps lightning, the middle band is lines then grid, and the score uses estimated time and filament mass.
- **Toughness:** 5 walls, 48% gyroid for the full height, 45 mm/s, 800 mm/s², seam stacked on +X, longer retract, 2 skirts.
- **Weight:** interpolates walls, density, speed, accel, seam, and the pattern bands above.
- **By layer:** bottom band is toughness, then a linear transition into speed.
- **By region:** each layer is clipped on X or Y. The low side is toughness toolpaths; the high side is speed toolpaths.
- **Adaptive layers:** layer height follows local slope inside a min/max band. The first layer stays at the nominal height. Each `;LAYER:` line records `Z` and `H` (that layer's thickness), and extrusion volume uses `H`.
- **Smart supports:** overhangs past the support angle are projected down to the bed as a sparse grid, stopped against the model with a 0.55 mm XY gap and a nominal-layer Z gap. The top three support layers are a denser interface. Preview kinds are `support` and `support-interface`, drawn separately from walls and infill.

Printer profile: generic Marlin, 0.4 mm nozzle, 1.75 mm PLA at 1.24 g/cm³, 200 °C / 60 °C, volumetric cap 12 mm³/s. UI checkboxes mirror the CLI knobs (variable walls, arc fit, travel and seam, overhang and bridges). The timing bar shows core milliseconds, estimated minutes, and filament grams.

## Tests

```bash
cargo test -p lime-slice-core
cargo run -p lime-slice --release -- bench samples/calibration_cube_20mm.stl
npx tsc --noEmit
```

## Not in this slice

Multi-extruder and tree supports stay out. Region splits leave a bead boundary on the cut. Gyroid is a 2D sine approximation, not a volumetric gyroid. Supports are a sparse grid with interface layers, not trees. The first layer is slowed to 30 mm/s; there is no Z-hop. Combing skips retraction when the travel stays inside the layer; it does not route around holes.
