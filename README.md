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

Blend names: `speed`, `toughness`, `weight`, `layer`, `region`.

Adaptive layers and supports are off unless you ask for them, so a bench stays comparable to a fixed 0.2 mm slice. `--adaptive` varies each layer inside `--adaptive-min` (default 0.08 mm) and `--adaptive-max` (default: the nominal layer height). Vertical walls take the thick end of that band; slopes that turn toward horizontal take the thin end. `--supports` builds a sparse grid under overhangs steeper than `--support-angle` (default 45° from horizontal), with three denser interface layers and a one-layer air gap. Support spacing and speed follow the resolved strategy: toughness is denser and slower than speed. Both apply on top of whichever blend is selected.

## Samples

| File | What it is |
| --- | --- |
| `samples/calibration_cube_20mm.stl` | 20 mm cube, 12 triangles |
| `samples/calibration_cube_20mm.3mf` | The same cube as 3MF |
| `samples/lime_hull.stl` | Original 60 × 24 × 28 mm superellipse prism, 4800 triangles |
| `samples/overhang_ledge.stl` | 24 mm base plus a 24 mm shelf at Z = 12, 24 triangles |
| `samples/slope_ramp.stl` | Vertical block with a roof rising from Z = 8 to Z = 20, 12 triangles |

Regenerate with `python3 tools/gen_samples.py`.

## Measured timings

Release build (`lto = "thin"`, codegen-units 1), one machine, layer height 0.2 mm, line width 0.45 mm, adaptive layers off, supports off. **Core** is plan + G-code for that mode. **Baseline** is a second pass of the single-strategy `speed` path on the same mesh.

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Core | Baseline | Filament E |
| --- | ---: | ---: | ---: |
| speed | 1.51 ms | 1.55 ms | 916 mm |
| toughness | 33.10 ms | 1.29 ms | 3462 mm |
| layer blend | 10.43 ms | 1.29 ms | 1809 mm |
| region blend | 14.93 ms | 1.23 ms | 2295 mm |

`samples/lime_hull.stl` — 4800 triangles, 140 layers:

| Mode | Core | Baseline | Filament E |
| --- | ---: | ---: | ---: |
| speed | 24.84 ms | 24.84 ms | 3006 mm |
| toughness | 230.02 ms | 17.70 ms | 14681 mm |
| layer blend | 80.80 ms | 17.05 ms | 7062 mm |
| region blend | 103.79 ms | 17.49 ms | 8983 mm |

`samples/overhang_ledge.stl` — 24 triangles, 80 layers, supports off:

| Mode | Core | Baseline | Filament E |
| --- | ---: | ---: | ---: |
| speed | 1.14 ms | 0.96 ms | 899 mm |
| toughness | 34.62 ms | 1.22 ms | 3673 mm |
| layer blend | 12.49 ms | 1.11 ms | 1957 mm |
| region blend | 28.97 ms | 1.16 ms | 3192 mm |

The same ledge with `--supports` and the speed strategy is 80 layers, core 2.55 ms, filament E 1360 mm, and the G-code carries `; TYPE:SUPPORT` and `; TYPE:SUPPORT-INTERFACE` moves that the unsupported slice does not. `samples/slope_ramp.stl` at a fixed 0.2 mm is 99 layers; `--adaptive` (0.08–0.2 mm) is 189 layers, with 0.20 mm bands on the vertical base and 0.08 mm bands on the roof.

The 3MF cube matches the STL cube (same triangle count, same region-blend E, 100 `;LAYER:` markers). A region-blended cube G-code has `M104`/`M140` temperature commands, `M204` acceleration changes, extrusion moves, and XY bounds inside the mesh plus one skirt line (−0.45…20.45 mm).

## Layout

- `crates/lime-slice-core` — mesh load, contour slice, strategy blend, toolpaths, G-code
- `crates/lime-slice` — `slice`, `bench`, `serve`
- `src-tauri` — Tauri 2 shell over the same core
- `src` — TypeScript preview UI (2D layer canvas plus a Three.js 3D slice view)
- `samples` — checked-in meshes

## Strategies

- **Speed:** 2 walls, 12% line infill, 140 mm/s, 3500 mm/s², nearest seam, short retract, 1 skirt.
- **Toughness:** 5 walls, 48% gyroid, 45 mm/s, 800 mm/s², seam stacked on +X, longer retract, 2 skirts.
- **Weight:** interpolates those parameters (walls, density, pattern, speed, accel, seam).
- **By layer:** bottom band is toughness, then a linear transition into speed.
- **By region:** each layer is clipped on X or Y. The low side is toughness toolpaths; the high side is speed toolpaths.
- **Adaptive layers:** layer height follows local slope inside a min/max band. The first layer stays at the nominal height. Each `;LAYER:` line records `Z` and `H` (that layer's thickness), and extrusion volume uses `H`.
- **Smart supports:** overhangs past the support angle are projected down to the bed as a sparse grid, stopped against the model with a 0.55 mm XY gap and a nominal-layer Z gap. The top three support layers are a denser interface. Preview kinds are `support` and `support-interface`, drawn separately from walls and infill.

Printer profile is a stub: generic Marlin, 0.4 mm nozzle, 1.75 mm PLA, 200 °C / 60 °C.

## Tests

```bash
cargo test -p lime-slice-core
```

## Not in this slice

Combing, arc fitting (G2/G3), variable width, multi-extruder, and strength-aware infill stay behind the strategy interface. Region splits leave a bead boundary on the cut. Gyroid is a 2D sine approximation, not a volumetric gyroid. Supports are a sparse grid with interface layers, not trees. The first layer is slowed to 30 mm/s; there is no Z-hop.
