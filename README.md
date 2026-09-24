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
```

Blend names: `speed`, `toughness`, `weight`, `layer`, `region`.

## Samples

| File | What it is |
| --- | --- |
| `samples/calibration_cube_20mm.stl` | 20 mm cube, 12 triangles |
| `samples/calibration_cube_20mm.3mf` | The same cube as 3MF |
| `samples/lime_hull.stl` | Original 60 × 24 × 28 mm superellipse prism, 4800 triangles |

Regenerate with `python3 tools/gen_samples.py`.

## Measured timings

Release build (`lto = "thin"`, codegen-units 1), one machine, layer height 0.2 mm, line width 0.45 mm. **Core** is plan + G-code for that mode. **Baseline** is a second pass of the single-strategy `speed` path on the same mesh.

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Core | Baseline | Filament E |
| --- | ---: | ---: | ---: |
| speed | 1.39 ms | 0.98 ms | 916 mm |
| toughness | 31.52 ms | 1.18 ms | 3462 mm |
| layer blend | 11.03 ms | 1.38 ms | 1809 mm |
| region blend | 14.57 ms | 1.20 ms | 2295 mm |

`samples/lime_hull.stl` — 4800 triangles, 140 layers:

| Mode | Core | Baseline | Filament E |
| --- | ---: | ---: | ---: |
| speed | 24.80 ms | 21.32 ms | 3006 mm |
| toughness | 227.80 ms | 20.31 ms | 14681 mm |
| layer blend | 82.83 ms | 20.14 ms | 7062 mm |
| region blend | 106.30 ms | 19.95 ms | 8983 mm |

The 3MF cube matches the STL cube (same triangle count, same E, ~1.5 ms speed / ~14 ms region). A region-blended cube G-code has 100 `;LAYER:` markers, `M104`/`M140` temperature commands, `M204` acceleration changes, extrusion moves, and XY bounds inside the mesh plus one skirt line (−0.45…20.45 mm).

## Layout

- `crates/lime-slice-core` — mesh load, contour slice, strategy blend, toolpaths, G-code
- `crates/lime-slice` — `slice`, `bench`, `serve`
- `src-tauri` — Tauri 2 shell over the same core
- `src` — TypeScript preview UI
- `samples` — checked-in meshes

## Strategies

- **Speed:** 2 walls, 12% line infill, 140 mm/s, 3500 mm/s², nearest seam, short retract, 1 skirt.
- **Toughness:** 5 walls, 48% gyroid, 45 mm/s, 800 mm/s², seam stacked on +X, longer retract, 2 skirts.
- **Weight:** interpolates those parameters (walls, density, pattern, speed, accel, seam).
- **By layer:** bottom band is toughness, then a linear transition into speed.
- **By region:** each layer is clipped on X or Y. The low side is toughness toolpaths; the high side is speed toolpaths.

Printer profile is a stub: generic Marlin, 0.4 mm nozzle, 1.75 mm PLA, 200 °C / 60 °C.

## Tests

```bash
cargo test -p lime-slice-core
```

## Not in this slice

Supports, adaptive layers, combing, arc fitting (G2/G3), variable width, multi-extruder, and strength-aware infill stay behind the strategy interface. Region splits leave a bead boundary on the cut. Gyroid is a 2D sine approximation, not a volumetric gyroid. The first layer is slowed to 30 mm/s; there is no Z-hop.
