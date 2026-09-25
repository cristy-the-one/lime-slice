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

Desktop shell:

```bash
npm run tauri dev
```

The API listens on `127.0.0.1:43118`. Inside Tauri the UI calls `slice_model` instead of HTTP.

## Build

`rust-toolchain.toml` pins stable Rust **1.88.0**, and the workspace `rust-version` matches. 1.83 cannot build this lockfile: `serde_spanned` 1.1 and `clap_lex` 1.1 need edition 2024 (Rust 1.85), and the resolved `time`, `icu_*`, `darling`, and `plist` crates require 1.88. `cargo +1.87.0 check` stops on those `rust-version` fields.

Clipper2's C++ binding needs `g++` and libstdc++. `.cargo/config.toml` points the Linux linker at GCC 13 (`/usr/lib/gcc/x86_64-linux-gnu/13`), which is the default on Ubuntu 24.04.

**Linux** (GTK 3 and WebKitGTK 4.1, the Tauri 2 webview):

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  libssl-dev \
  patchelf \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsoup-3.0-dev
cargo build -p lime-slice-desktop
```

`libwebkit2gtk-4.1-dev` pulls in JavaScriptCore and libsoup 3. `libgtk-3-dev` is the window toolkit. `libayatana-appindicator3-dev` is the tray icon, `librsvg2-dev` rasterizes the bundle icons, and `patchelf` is used when packaging a deb.

**Windows:** Visual Studio Build Tools with the "Desktop development with C++" workload, and the WebView2 runtime (already present on current Windows 10 and 11). The NSIS installer target in `src-tauri/tauri.windows.conf.json` needs [NSIS](https://nsis.sourceforge.io/) on `PATH` when bundling. The Windows icon (`icons/icon.ico`) stays in `src-tauri/tauri.conf.json`.

**macOS:** Xcode Command Line Tools (`xcode-select --install`). The shell uses the system WebKit; no extra GTK packages.

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

`--infill-combine` (default on) emits sparse and lightning infill every 3 layers on the speed blend and every 2 layers on a low-weight efficiency blend, at that multiple of the layer height, capped near 0.75 × the nozzle diameter. The thick bead is parked on the top of each group, flush with the next solid shell, so the layers under a top skin are not left empty. Walls, top skins, and bottom skins stay at the nominal height. Toughness and `--classic` leave combining off. Bottom skins are solid rectilinear even when the strategy's interior pattern is lightning.

Per-feature feeds are on unless `--feature-speeds false` or `--classic`. The speed blend runs sparse infill and travel fast and keeps the outer wall slower. The estimator uses those feeds and accels.

Combing (default on) routes travels through an inset of the filled contours and retracts when a straight move would cross a hole or leave the part. The inside test is a segment-versus-polygon intersection, so a long travel cannot jump a hole between sample points. Smart z-hop still lifts only the blocked travels it already would (toughness by default, not speed), and it skips scarf ramps and travels shorter than the hop minimum. `--combing false` keeps the straight hop.

`--z-hop off|blend|always|smart` lifts the nozzle on a travel. The default `blend` is smart for toughness and for a weight mix at or above 50% toughness, and off for speed: a hop costs time and the speed blend's combing already stays inside the part. Smart hops only when a travel longer than `--z-hop-min-travel` (2 mm) crosses a printed top or perimeter that combing could not avoid, or when leaving a top skin. It does not hop inside infill, on scarf ramps, or on short moves. The lift happens with the retract. Travels long enough for a slope rise and fall along the move; shorter hops lift vertically. `--z-hop-height` defaults to 0.4 mm. `--classic` forces z-hop off.

`--scarf-seam blend` (the default) follows the strategy. Toughness, and a weight mix at or above 50% toughness, scarf outer walls. Speed and lighter efficiency mixes leave the butt seam, because the extra overlap is not free and the speed blend is timed against the previous default. `--scarf-seam outer` forces the joint on every outer wall (and on `wall` paths when per-feature feeds are off). `--scarf-seam all` adds inner walls. `--classic` forces it off. A sharp convex corner still wins: the seam stays on that corner and the scarf is skipped. Smooth loops ramp the start from 15% of the layer height and 0.55 flow up to a full bead over the scarf length, then retrace that length at full Z while flow ramps back down. The second pass never drops below the Z already deposited on that overlap. Loops under 8 mm, the first layer, bridges, and overhang spans stay butt seams. The start ramp is linear G1 moves with Z; the constant-Z body and the full-Z retrace can still become G2/G3. Nozzle Z on a layer stays inside `[layer Z − layer height, layer Z]`. Extrusion volume for a scarf segment is `width × height × flow`, with height the average nozzle fraction of the layer and flow the average of the segment's flow ramp.

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

Contour extraction on the hull (140 layers, 4800 triangles): parallel Z-index **3.34 ms**, single-thread full scan **10.70 ms**. The cube has 12 triangles, so the index does not pay (0.47 ms vs 0.19 ms).

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 2.55 | 1.80 | 221.2 | 331.6 | 2.14 | 3.13 | 677 | 3630 | 1 | 200 | 1855 | 2535 |
| toughness | 131.70 | 36.00 | 5860.7 | 6039.1 | 10.05 | 10.32 | 6376 | 53558 | 2 | 4236 | 11572 | 10891 |
| layer blend | 39.84 | 10.11 | 1518.7 | 1685.5 | 4.74 | 5.46 | 2107 | 14420 | 2 | 1005 | 4944 | 5173 |
| region blend | 52.80 | 16.73 | 2681.7 | 2933.6 | 6.04 | 6.69 | 7195 | 22554 | 1 | 2653 | 6466 | 6604 |

Cube speed is 33% less print time than classic (221.2 s vs 331.6 s) and 32% less filament (2.14 g vs 3.13 g). The speed floor is solid, so the cube uses more filament than the lightning-only bottom it printed before. Travel and retracts stay with the old lightning path (677 mm, 1 retract). Toughness is on 3D gyroid.

`samples/lime_hull.stl` — 4800 triangles, 140 layers. The hull is convex, so hole-aware combing matches straight travel: **2001.9 mm and 1 retract** either way. The drop versus classic is the travel planner.

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 45.56 | 33.80 | 772.0 | 1464.8 | 5.72 | 9.76 | 2002 | 29339 | 1 | 828 | 4806 | 7497 |
| toughness | 1032.52 | 279.18 | 28705.7 | 29010.5 | 42.18 | 43.73 | 29686 | 270759 | 2 | 11681 | 49067 | 46705 |
| layer blend | 286.62 | 94.24 | 7374.0 | 8321.6 | 17.65 | 20.86 | 9210 | 84190 | 2 | 3309 | 18585 | 19818 |
| region blend | 426.37 | 135.11 | 13892.3 | 14854.7 | 24.14 | 26.86 | 16684 | 137800 | 1 | 7540 | 27338 | 27066 |

Hull speed is 47% less print time than classic (772.0 s vs 1464.8 s) and 41% less filament (5.72 g vs 9.76 g). The speed slice emits 2008 arcs. Toughness is 3D gyroid with the scarf on. A 30 mm window frame (four walls around a 14 mm hole, covered by the combing test) retracts on any travel that enters the hole. Smart z-hop lifts those crossings on toughness and stays down on speed.

`samples/overhang_ledge.stl` speed, supports on, 45°:

| Style | Print s | Filament g | Travel mm | Retracts |
| --- | ---: | ---: | ---: | ---: |
| sparse grid | 494.1 | 3.76 | 5484 | 570 |
| tree | 354.3 | 2.72 | 4416 | 232 |
| tree, shaft ×2 | 331.2 | 2.72 | 3013 | 124 |

Tree uses 28% less filament and 28% less time than the grid on the same ledge. Doubling the sparse shaft height keeps the filament and cuts another 23 s, with the interface still at the model layer height. The cube and hull have no overhang, so grid and tree match there.

## Scarf seams

A scarf replaces a butt seam on a closed wall when the seam is not already on a sharp convex corner. The loop starts at 15% of the layer height and 0.55 flow, rises to a full bead over 10 mm in 8 steps, then retraces that 10 mm at full Z while flow ramps back down. The second pass does not dip below plastic the start ramp already laid down. The seam metric is that overlap length, plus the largest Z step along the ramp. A butt seam has overlap 0. With the defaults the start-ramp step is `(1 − 0.15) × 0.2 / 8 = 0.021` mm, against a 0.20 mm layer. Nozzle Z stays inside the layer slab. The constant-Z body and the full-Z retrace can still be a G2/G3; the start ramp itself is linear.

`blend` (the default) turns this on for toughness and for a weight mix at or above 50% toughness. Speed stays off: forcing it on costs print time and does not save filament. `--classic` is off. The cube's corners hide the seam, so scarf-on and scarf-off match there, and the speed rows above are unchanged (cube 221.2 s, hull 772.0 s).

`samples/arc_post.stl` is the smooth case (64-gon, 12 mm radius, 6 mm tall). `samples/lime_hull.stl` is smooth enough that the outer wall scarfs once the seam is not on a sharp vertex.

| Mesh | Mode | Off s | Outer s | Off g | Outer g | Off arcs | Outer arcs | Off slice ms | Outer slice ms | Overlap mm | Max Z step mm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cube | speed | 221.2 | 221.2 | 2.14 | 2.14 | 2 | 2 | 2.34 | 2.64 | 0 | 0 |
| cube | toughness | 5860.7 | 5860.7 | 10.05 | 10.05 | 55 | 55 | 126.37 | 124.99 | 0 | 0 |
| arc post | speed | 122.2 | 134.6 | 0.96 | 0.97 | 118 | 118 | 6.13 | 6.01 | 10.00 | 0.021 |
| arc post | toughness | 1932.5 | 1960.1 | 3.34 | 3.35 | 354 | 352 | 52.17 | 54.34 | 10.00 | 0.021 |
| hull | speed | 772.0 | 813.5 | 5.72 | 5.76 | 2008 | 2109 | 44.02 | 45.58 | 10.00 | 0.021 |
| hull | toughness | 28599.0 | 28705.7 | 42.14 | 42.18 | 5793 | 5692 | 988.66 | 1001.57 | 10.00 | 0.021 |

Speed forced to outer is 12.4 s slower on the post (122.2 → 134.6) and 41 s slower on the hull (772.0 → 813.5). That is why the speed blend leaves the scarf off. Toughness pays about 28 s on the post and 107 s on the hull, and keeps the 10 mm overlap. Classic on the post is 210.5 s / 1.11 g (speed). The default hull toughness row above includes the scarf and 3D gyroid, so that print is 28706 s.

## True 3D gyroid

`--gyroid-3d blend` (the default) cuts `sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0` at the layer Z wherever the pattern is already gyroid. Speed stays on lightning, so the speed rows above are unchanged (cube 221.2 s / 2.14 g, hull 772.0 s / 5.72 g). The 2D sine is `--gyroid-3d off`. Classic is the line planner. The cell period is 1.15 times the infill spacing. Sampling runs per layer and per grid row.

Release bench, same machine, layer height 0.2 mm. Tall column is a 20 × 20 × 60 mm box.

| Mesh | Infill | Slice ms | Print s | Filament g | Travel mm | Retracts | Toughness |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cube | 3D gyroid | 131.5 | 5861 | 10.05 | 6376 | 2 | 11572 |
| cube | 2D gyroid | 39.7 | 4696 | 10.33 | 6609 | 2 | 10891 |
| cube | classic | 52.1 | 6039 | 10.32 | 53558 | 4236 | 10891 |
| hull | 3D gyroid | 959.3 | 28706 | 42.18 | 29686 | 2 | 49067 |
| hull | 2D gyroid | 336.7 | 22332 | 43.77 | 22939 | 2 | 45642 |
| hull | classic | 259.8 | 29011 | 43.73 | 270759 | 11681 | 46705 |

The 3D section scores higher and uses a little less filament. It also takes longer to print, because the sheet is a longer curve than the 2D sine, and longer to slice. That trade is what the toughness blend is for. Speed keeps lightning.

## Z-hop

`--z-hop blend` is smart on toughness and off on speed. Smart on the cube hops 0 times, because combing already stays inside. On the hull it hops 0 times and the print time does not move (28705.7 s either way). On the ledge with supports it hops 116 times and adds 12.1 s (7970.0 s vs 7957.9 s). Forcing smart on the speed blend adds a little time (cube 221.2 → 221.3 s, 3 hops; hull 772.0 → 772.7 s, 13 hops) without a toughness job to pay for, so speed stays off. Always is the expensive one: cube 5893 s and 345 hops, hull 28870 s and 1997 hops. A hole crossing retracts either way; smart lifts it only when the existing rules already would (not on speed, not on a scarf ramp, not under the hop minimum).

| Mesh | Mode | Print s | Hops | Travel mm | Retracts |
| --- | --- | ---: | ---: | ---: | ---: |
| cube | speed blend (off) | 221.2 | 0 | 677 | 1 |
| cube | speed smart | 221.3 | 3 | 677 | 1 |
| cube | toughness smart | 5861 | 0 | 6376 | 2 |
| cube | toughness always | 5893 | 345 | 6376 | 2 |
| hull | speed blend (off) | 772.0 | 0 | 2002 | 1 |
| hull | speed smart | 772.7 | 13 | 2002 | 1 |
| hull | toughness smart | 28706 | 0 | 29686 | 2 |
| hull | toughness always | 28870 | 1997 | 29686 | 2 |
| ledge, supports | toughness off | 7958 | 0 | — | — |
| ledge, supports | toughness smart | 7970 | 116 | 7210 | — |

## Pressure-advance calibration

`lime-slice calibrate pa` writes a tower. Each band is a slow 40 mm/s frame and a slow-fast-slow line. The fast feed is the volumetric cap (here 133.3 mm/s at 0.45 × 0.2 mm and 12 mm³/s). A sample `--start 0 --end 0.04 --step 0.02 --band-height 1` produced three Klipper bands and 88.7 mm of filament:

| Band | K | Z |
| --- | ---: | --- |
| 0 | 0.0000 | 0.200–1.000 |
| 1 | 0.0200 | 1.200–2.000 |
| 2 | 0.0400 | 2.200–3.000 |

## Layout

- `crates/lime-slice-core` — mesh load, contour slice, strategy blend, toolpaths, G-code
- `crates/lime-slice` — `slice`, `bench`, `serve`, `calibrate pa`
- `src-tauri` — Tauri 2 shell over the same core
- `src` — TypeScript preview UI (2D layer canvas plus a Three.js 3D slice view)
- `samples` — checked-in meshes

## Strategies

- **Speed:** 2 walls, lightning infill within 4 mm of a roof combined every 3 layers and capped near 0.75 × the nozzle, outer 130 mm/s, inner 160 mm/s, sparse 220 mm/s, travel 300 mm/s, nearest seam on a sharp corner, scarf off, short retract, 1 skirt. The first layers are a solid floor.
- **Efficiency:** the weight mix. Low toughness keeps lightning and combining (every 2 layers under 45% toughness). The middle band is lines then grid. The score uses estimated time and filament mass.
- **Toughness:** 5 walls, 48% true 3D gyroid for the full height at every layer, outer 40 mm/s, sparse 55 mm/s, seam stacked on +X, scarf on smooth outer walls, longer retract, 2 skirts. `--gyroid-3d blend` (the default) uses the TPMS section `sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0` wherever the pattern is gyroid, including a weight mix at or above 75% toughness. Speed stays on lightning. `--gyroid-3d off` keeps the old 2D sine. `--gyroid-3d on` forces the 3D section. `--classic` is off.
- **Weight:** interpolates walls, density, speed, accel, seam, and the pattern bands above.
- **By layer:** bottom band is toughness, then a linear transition into speed.
- **By region:** each layer is clipped on X or Y. The low side is toughness toolpaths; the high side is speed toolpaths. The outer wall on the cut is a single bead.
- **Adaptive layers:** layer height follows local slope inside a min/max band. The first layer stays at the nominal height. Each `;LAYER:` line records `Z` and `H` (that layer's thickness), and extrusion volume uses `H`.
- **Smart supports:** overhangs past the support angle are projected down to the bed, stopped against the model with a 0.55 mm XY gap and a nominal-layer Z gap. Grid fills that column. Tree keeps an interface tip and replaces the column with leaning shafts. Preview kinds are `support` and `support-interface`.
- **Per-feature speeds:** outer, inner, sparse, solid, top, and travel each have a feed and an accel. The print-time estimator consumes them. Preview kinds are `outer`, `inner`, `sparse`, `solid`, and `top`.
- **Combing:** travels that can stay inside an inset of the layer do, and those hops do not retract. A segment that crosses a hole retracts.

Printer profile: generic Marlin, 0.4 mm nozzle, 1.75 mm PLA at 1.24 g/cm³, 200 °C / 60 °C, volumetric cap 12 mm³/s. Optional `pressureAdvance` emits Klipper `SET_PRESSURE_ADVANCE` and optional `linearAdvance` emits Marlin `M900`, at the start and again when the feature scale changes (outer and top use the full factor, sparse uses 0.65). Both default to 0, which emits nothing. `lime-slice calibrate pa` prints a tower of slow-fast-slow lines, one K per band, for Klipper or Marlin. The UI lists the band-to-K map and writes the chosen K back into the profile so the next slice emits it. The fast feed is limited by the volumetric cap so it stays faster than the 40 mm/s anchor. UI checkboxes mirror the CLI knobs. The timing bar shows core milliseconds, estimated minutes, and filament grams.

## Tests

```bash
cargo test -p lime-slice-core
cargo run -p lime-slice --release -- bench samples/calibration_cube_20mm.stl
npx tsc --noEmit
```

## Not in this slice

Multi-extruder stays out. Region splits still keep each side's inner walls; the outer bead on the cut is one wall. Tree supports are stacked shafts with an interface tip, not a volumetric organic mesh. The first layer is slowed to 30 mm/s. A scarf spreads a smooth seam; it does not move a seam that already sits on a sharp corner, and the retrace stays at the layer Z. `--gyroid-3d off` is the previous 2D sine gyroid. Speed leaves z-hop off.
