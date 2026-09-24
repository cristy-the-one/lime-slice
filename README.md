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

Feature knobs default on. Turn one off with `--variable-width false`, `--arc-fit false`, `--travel-opt false`, `--overhang-control false`, `--infill-combine false`, `--combing false`, or `--feature-speeds false`. `--scarf-seam blend|off|outer|all` chooses the scarf joint (default `blend`). Length and step count are `--scarf-length` (10 mm) and `--scarf-steps` (8). `--classic` is the baseline planner: line infill for the full height, one feed for every feature, no variable walls, no arcs, no overhang slowdown, no infill combining, no combing, no scarf, grid supports only, and a full triangle scan.

Adaptive layers and supports are off unless you ask for them, so a bench stays comparable to a fixed 0.2 mm slice. `--adaptive` varies each layer inside `--adaptive-min` (default 0.08 mm) and `--adaptive-max` (default: the nominal layer height). Vertical walls take the thick end of that band; slopes that turn toward horizontal take the thin end. `--supports` builds support under overhangs steeper than `--support-angle` (default 45° from horizontal), with three denser interface layers, a 0.55 mm XY gap, and a one-layer air gap. `--support-style grid` is the sparse column. `--support-style tree` grows organic shafts that lean together as they drop, and keeps the same interface tip. `--support-height-mult` (default 1) prints sparse shafts at a thicker layer height; the interface stays at the model layer height. Support spacing and speed still follow the resolved strategy: toughness is denser and slower than speed.

`--infill-combine` (default on) emits sparse and lightning infill every 3 layers on the speed blend and every 2 layers on a low-weight efficiency blend, at that multiple of the layer height. Walls, top skins, and bottom skins stay at the nominal height. Toughness and `--classic` leave combining off.

Per-feature feeds are on unless `--feature-speeds false` or `--classic`. The speed blend runs sparse infill and travel fast and keeps the outer wall slower. The estimator uses those feeds and accels.

Combing (default on) routes travels through an inset of the filled contours and retracts only when that route is blocked. `--combing false` keeps the straight hop.

`--scarf-seam blend` (the default) follows the strategy. Toughness, and a weight mix at or above 50% toughness, scarf outer walls. Speed and lighter efficiency mixes leave the butt seam, because the extra overlap is not free and the speed blend is timed against the previous default. `--scarf-seam outer` forces the joint on every outer wall (and on `wall` paths when per-feature feeds are off). `--scarf-seam all` adds inner walls. `--classic` forces it off. A sharp convex corner still wins: the seam stays on that corner and the scarf is skipped. Smooth loops ramp the start from 15% of the layer height and 0.55 flow up to a full bead over the scarf length, then retrace that length while ramping back down. Loops under 8 mm, the first layer, bridges, and overhang spans stay butt seams. Ramp segments are linear G1 moves with Z; the constant-Z body can still become G2/G3. Nozzle Z on a layer stays inside `[layer Z − layer height, layer Z]`. Extrusion volume for a scarf segment is `width × height × flow`, with height the average nozzle fraction of the layer and flow the average of the segment's flow ramp.

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

Release build (`lto = "thin"`, codegen-units 1, `cargo +stable`), one machine, layer height 0.2 mm, line width 0.45 mm, adaptive layers off. The first table is supports off. **Slice** is plan + G-code for the new path. **Classic** is the same blend on the baseline planner (full-height line infill, one feed, no variable walls, no arcs, no overhang control, no infill combine, no combing, full triangle scan). Print time and filament mass come from the motion estimator (trapezoid with junction deviation, volumetric cap 12 mm³/s on the new path). Scores are `speed = 60 / minutes`, `efficiency = 8 / grams`, `toughness` = structural mm³ weighted by pattern (gyroid above lightning).

Contour extraction on the hull (140 layers, 4800 triangles): parallel Z-index **1.55 ms**, single-thread full scan **10.75 ms**. The cube has 12 triangles, so the index does not pay (0.52 ms vs 0.19 ms).

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 1.53 | 1.43 | 170.7 | 328.0 | 1.84 | 2.73 | 689 | 10211 | 9 | 501 | 1759 | 2309 |
| toughness | 39.80 | 37.50 | 4847.5 | 6251.0 | 10.33 | 10.33 | 6882 | 56802 | 100 | 4500 | 10894 | 10894 |
| layer blend | 12.54 | 11.25 | 1483.3 | 1966.5 | 4.73 | 5.33 | 2771 | 25984 | 45 | 1709 | 4636 | 5089 |
| region blend | 18.01 | 15.77 | 2363.6 | 3056.1 | 6.44 | 6.84 | 5391 | 27071 | 100 | 3100 | 6564 | 6873 |

Cube speed is 48% less print time than classic and faster than main at 5bb93b3 (170.7 s vs 184.9 s) at the same 1.84 g. Travel is 689 mm and 9 retracts, against 1344 mm and 22 retracts on main. Toughness matches the classic structural index (10894).

`samples/lime_hull.stl` — 4800 triangles, 140 layers. The hull is convex, so hole-aware combing matches straight travel: **1830.3 mm and 8 retracts** either way. The drop versus classic is the travel planner.

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 27.3 | 30.1 | 617.4 | 1416.5 | 4.66 | 8.96 | 1830 | 45486 | 8 | 980 | 4470 | 7046 |
| toughness | 340.8 | 276.3 | 22890 | 29754 | 43.79 | 43.79 | 22568 | 282427 | 139 | 12179 | 46764 | 46764 |
| layer blend | 104.81 | 83.59 | 6821 | 9285 | 17.78 | 20.74 | 9236 | 126941 | 58 | 4657 | 17646 | 19747 |
| region blend | 149.42 | 121.16 | 11345 | 15209 | 24.72 | 26.79 | 14709 | 150997 | 140 | 8120 | 25705 | 27233 |

Hull speed is 56% less print time than classic and faster than main (617 s vs 676 s) at 4.66 g. Travel is 1830 mm and 8 retracts, against 7265 mm and 21 retracts on main. The speed slice emits 2248 arcs. Toughness stays on gyroid and matches classic (46764). A 30 mm window frame (four walls around a hole, covered by the combing test) is where the router shows up: travel 3989 mm and 29 retracts with combing, versus 3461 mm and 90 retracts in a straight line. The detour is longer; the retract count drops by about two thirds.

`samples/overhang_ledge.stl` speed, supports on, 45°:

| Style | Print s | Filament g | Travel mm | Retracts |
| --- | ---: | ---: | ---: | ---: |
| sparse grid | 407.2 | 3.25 | 5053 | 405 |
| tree | 272.1 | 2.21 | 4109 | 237 |
| tree, shaft ×2 | 249.8 | 2.21 | 2899 | 135 |

Tree uses 32% less filament and 33% less time than the grid on the same ledge. Doubling the sparse shaft height keeps the filament and cuts another 22 s, with the interface still at the model layer height. The cube and hull have no overhang, so grid and tree match there.

## Scarf seams

A scarf replaces a butt seam on a closed wall when the seam is not already on a sharp convex corner. The loop starts at 15% of the layer height and 0.55 flow, rises to a full bead over 10 mm in 8 steps, then retraces that 10 mm while Z and flow ramp back down. The seam metric is that overlap length, plus the largest Z step along the ramp. A butt seam has overlap 0. With the defaults the ramp step is `(1 − 0.15) × 0.2 / 8 = 0.021` mm, against a 0.20 mm layer. Nozzle Z stays inside the layer slab. The constant-Z body can still be a G2/G3; the ramp itself is linear.

`blend` (the default) turns this on for toughness and for a weight mix at or above 50% toughness. Speed stays off: forcing it on costs print time and does not save filament. `--classic` is off. The cube's corners hide the seam, so scarf-on and scarf-off match there, and the speed rows above are unchanged (cube 170.7 s, hull 617.4 s).

`samples/arc_post.stl` is the smooth case (64-gon, 12 mm radius, 6 mm tall). `samples/lime_hull.stl` is smooth enough that the outer wall scarfs once the seam is not on a sharp vertex.

| Mesh | Mode | Off s | Outer s | Off g | Outer g | Off arcs | Outer arcs | Off slice ms | Outer slice ms | Overlap mm | Max Z step mm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cube | speed | 170.7 | 170.7 | 1.84 | 1.84 | 2 | 2 | 1.55 | 1.33 | 0 | 0 |
| cube | toughness | 4847.5 | 4847.5 | 10.33 | 10.33 | 4 | 4 | 42.07 | 41.63 | 0 | 0 |
| arc post | speed | 62.0 | 74.6 | 0.58 | 0.58 | 118 | 118 | 4.80 | 4.92 | 10.00 | 0.021 |
| arc post | toughness | 1745.4 | 1771.4 | 3.42 | 3.42 | 294 | 294 | 28.65 | 28.99 | 10.00 | 0.021 |
| hull | speed | 617.4 | 666.5 | 4.66 | 4.66 | 2248 | 2109 | 32.69 | 37.00 | 10.00 | 0.021 |
| hull | toughness | 22889.5 | 23002.9 | 43.79 | 43.78 | 5616 | 5477 | 442.77 | 347.96 | 10.00 | 0.021 |

Speed forced to outer is 12.6 s slower on the post (62.0 → 74.6) and 49 s slower on the hull (617.4 → 666.5), at the same filament mass. That is why the speed blend leaves the scarf off. Toughness pays about 26 s on the post and 113 s on the hull, under 1.5% and 0.5% of those prints, and keeps the 10 mm overlap. Classic on the post is 176.4 s / 0.82 g (speed) and 2407.8 s / 3.42 g (toughness), with no scarf and no arcs. Hull toughness with the scarf off matches the previous default (22889.5 s, 43.79 g). The default toughness row above now includes the scarf, so that print is 23003 s and the structural score drops from 46764 to 45689 because the ramp is scored at its real height and flow instead of a full bead.

## Layout

- `crates/lime-slice-core` — mesh load, contour slice, strategy blend, toolpaths, G-code
- `crates/lime-slice` — `slice`, `bench`, `serve`
- `src-tauri` — Tauri 2 shell over the same core
- `src` — TypeScript preview UI (2D layer canvas plus a Three.js 3D slice view)
- `samples` — checked-in meshes

## Strategies

- **Speed:** 2 walls, lightning infill within 4 mm of a roof combined every 3 layers, outer 130 mm/s, inner 160 mm/s, sparse 220 mm/s, travel 300 mm/s, nearest seam on a sharp corner, scarf off, short retract, 1 skirt.
- **Efficiency:** the weight mix. Low toughness keeps lightning and combining (every 2 layers under 45% toughness). The middle band is lines then grid. The score uses estimated time and filament mass.
- **Toughness:** 5 walls, 48% true 3D gyroid for the full height at every layer, outer 40 mm/s, sparse 55 mm/s, seam stacked on +X, scarf on smooth outer walls, longer retract, 2 skirts. `--gyroid-3d blend` (the default) uses the TPMS section `sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0` wherever the pattern is gyroid, including a weight mix at or above 75% toughness. Speed stays on lightning. `--gyroid-3d off` keeps the old 2D sine. `--gyroid-3d on` forces the 3D section. `--classic` is off.
- **Weight:** interpolates walls, density, speed, accel, seam, and the pattern bands above.
- **By layer:** bottom band is toughness, then a linear transition into speed.
- **By region:** each layer is clipped on X or Y. The low side is toughness toolpaths; the high side is speed toolpaths.
- **Adaptive layers:** layer height follows local slope inside a min/max band. The first layer stays at the nominal height. Each `;LAYER:` line records `Z` and `H` (that layer's thickness), and extrusion volume uses `H`.
- **Smart supports:** overhangs past the support angle are projected down to the bed, stopped against the model with a 0.55 mm XY gap and a nominal-layer Z gap. Grid fills that column. Tree keeps an interface tip and replaces the column with leaning shafts. Preview kinds are `support` and `support-interface`.
- **Per-feature speeds:** outer, inner, sparse, solid, top, and travel each have a feed and an accel. The print-time estimator consumes them. Preview kinds are `outer`, `inner`, `sparse`, `solid`, and `top`.
- **Combing:** travels that can stay inside an inset of the layer do, and those hops do not retract.

Printer profile: generic Marlin, 0.4 mm nozzle, 1.75 mm PLA at 1.24 g/cm³, 200 °C / 60 °C, volumetric cap 12 mm³/s. Optional `pressureAdvance` emits Klipper `SET_PRESSURE_ADVANCE` and optional `linearAdvance` emits Marlin `M900`, at the start and again when the feature scale changes (outer and top use the full factor, sparse uses 0.65). Both default to 0, which emits nothing. There is no calibration wizard. UI checkboxes mirror the CLI knobs. The timing bar shows core milliseconds, estimated minutes, and filament grams.

## Tests

```bash
cargo test -p lime-slice-core
cargo run -p lime-slice --release -- bench samples/calibration_cube_20mm.stl
npx tsc --noEmit
```

## Not in this slice

Multi-extruder and Z-hop stay out. Region splits leave a bead boundary on the cut. Tree supports are stacked shafts with an interface tip, not a volumetric organic mesh. Pressure advance is a profile value, not a calibration print. The first layer is slowed to 30 mm/s. A scarf spreads a smooth seam; it does not move a seam that already sits on a sharp corner. `--gyroid-3d off` is the previous 2D sine gyroid.
