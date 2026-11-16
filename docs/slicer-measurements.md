# Slicer measurements

Measured timings, the G-code comparison tools, and the notes on scarf seams, true 3D gyroid, Z-hop and pressure-advance calibration. These numbers were measured when each feature landed; later slicer changes can move them.

## Measured timings

Release build (`lto = "thin"`, codegen-units 1, `cargo +stable`), one machine, layer height 0.2 mm, line width 0.45 mm, adaptive layers off. The first table is supports off. **Slice** is plan + G-code for the new path. **Classic** is the same blend on the baseline planner (full-height line infill, one feed, no variable walls, no arcs, no overhang control, no infill combine, no combing). Print time and filament mass come from the motion estimator (trapezoid with junction deviation, volumetric cap 12 mm³/s on the new path). Scores are `speed = 60 / minutes`, `efficiency = 8 / grams`, `toughness` = structural mm³ weighted by pattern (gyroid above lightning).

Each layer is cut at its mid-height. Contours are cut from a welded mesh and stitched by shared edge, not by rounded coordinates. A chain broken by a hole in the mesh is closed across gaps up to 1.25 mm, and overlapping shells are merged with a nonzero union instead of cancelling into holes. A 1.5 mm opening stays open. `slice --audit` reports the sliced volume against the mesh volume with bridged millimetres beside the coverage, repaired and dropped chains, support volume that is inside the part or has trunk or column with nothing under it, top area no solid bead covers, and open skin: outline band that no bead covers, which shows as a hole through the part. A membrane thinner than the narrowest bead, where its two faces meet, still gets one bead down its spine wherever no wall is within half a bead. `--line-width` sets the extrusion width; the UI uses 1.125 × the nozzle. The test `every_sample_audits_clean` holds every sample to those checks. `tools/golden.sh` hashes the G-code for every sample under six configs, so a refactor can prove it left the output byte-identical. `GOLDEN_EXTRA=path/to/mesh.stl` adds meshes.

`samples/dragon_2_5.stl` is checked in. SHA-256 `20733ff536695ec13304c66f642dc1bbd3c2abf8e70ac3c57ae955ba96b3bd91`. `every_sample_audits_clean`, `tools/golden.sh`, and the CI smoke bench skip that filename, so the default run stays on the small samples. The opt-in audit is:

```bash
cargo test -p lime-slice-core --release -- dragon_2_5_headlines --ignored --nocapture
```

`GOLDEN_DRAGON=1 bash tools/golden.sh` runs that same test. It slices speed and toughness with supports on (tree style: `slice --blend speed --supports` and `slice --blend toughness --supports`) and prints core slice milliseconds, coverage percent, support inside the part, floating support, unskinned top area, and open skin. If the file is missing, the harness prints one skip line and exits 0.

`samples/calibration_cube_20mm.stl` — 12 triangles, 100 layers:

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 2.55 | 1.80 | 221.2 | 331.6 | 2.14 | 3.13 | 677 | 3630 | 1 | 200 | 1855 | 2535 |
| toughness | 87.9 | 38.54 | 2134.4 | 6039.1 | 9.98 | 10.32 | 3586 | 53558 | 2 | 4236 | 11577 | 10891 |
| layer blend | 24.37 | 10.15 | 740.4 | 1685.5 | 4.68 | 5.46 | 1622 | 14420 | 2 | 1005 | 4877 | 5173 |
| region blend | 38.19 | 17.67 | 1317.7 | 2933.6 | 6.01 | 6.69 | 5377 | 22554 | 1 | 2653 | 6465 | 6604 |

Cube speed is 33% less print time than classic (221.2 s vs 331.6 s) and 32% less filament (2.14 g vs 3.13 g). The speed floor is solid, so the cube uses more filament than the lightning-only bottom it printed before. Travel and retracts stay with the old lightning path (677 mm, 1 retract). Toughness is on recovered 3D gyroid: arcs, a 110 mm/s infill feed, one full-density lattice, and a two-layer combine.

`samples/lime_hull.stl` — 4800 triangles, 140 layers. The hull is convex, so hole-aware combing matches straight travel: **2001.9 mm and 1 retract** either way. The drop versus classic is the travel planner.

| Mode | Slice ms | Classic ms | Print s | Classic s | Filament g | Classic g | Travel mm | Classic travel | Retracts | Classic retracts | Toughness | Classic tough |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| speed | 45.56 | 33.80 | 772.0 | 1464.8 | 5.72 | 9.76 | 2002 | 29339 | 1 | 828 | 4806 | 7497 |
| toughness | 675.1 | 264.90 | 8727.9 | 29010.5 | 41.90 | 43.73 | 16193 | 270759 | 2 | 11681 | 49182 | 46705 |
| layer blend | 201.10 | 88.53 | 3020.2 | 8321.6 | 17.62 | 20.86 | 6512 | 84190 | 2 | 3309 | 18645 | 19818 |
| region blend | 310.16 | 130.10 | 4838.4 | 14854.7 | 24.01 | 26.86 | 10812 | 137800 | 1 | 7540 | 27389 | 27066 |

Hull speed is 47% less print time than classic (772.0 s vs 1464.8 s) and 41% less filament (5.72 g vs 9.76 g). The speed slice emits 2008 arcs. Toughness is recovered 3D gyroid with the scarf on. A 30 mm window frame (four walls around a 14 mm hole, covered by the combing test) retracts on any travel that enters the hole. Smart z-hop lifts those crossings on toughness and stays down on speed.

`samples/overhang_ledge.stl` speed, supports on, 45°:

| Style | Print s | Filament g | Travel mm | Retracts |
| --- | ---: | ---: | ---: | ---: |
| sparse grid | 494.1 | 3.76 | 5484 | 570 |
| tree | 354.3 | 2.72 | 4416 | 232 |
| tree, shaft ×2 | 331.2 | 2.72 | 3013 | 124 |

Tree uses 28% less filament and 28% less time than the grid on the same ledge. Doubling the sparse shaft height keeps the filament and cuts another 23 s, with the interface still at the model layer height. The cube and hull have no overhang, so grid and tree match there.

### Comparing G-code from different slicers

Each slicer times its own file with its own model, so two estimates are not comparable. `tools/gcode_profile.py` times any file with one move model: a trapezoid per move at the acceleration in force (`M204 S` or Klipper `SET_VELOCITY_LIMIT ACCEL=`), with junction speeds from the angle between moves. It reads `;TYPE:` (Orca, Prusa, Cura) and `; TYPE:` (Lime Slice), relative and absolute E, and G2/G3 arcs. It prints time, length, moves, volume and flow per feature. It ignores layer-time slowdowns and firmware smoothing.

```bash
python tools/gcode_profile.py --max-speed X=500,Y=500,Z=12 --travel-by-feature ours.gcode theirs.gcode
```

`--max-speed` caps each axis (a belt printer's belt axis is slow), `--max-accel` caps acceleration, `--junction-deviation` defaults to 0.02 mm, and `--travel-by-feature` splits travel by the feature it occurs in.

`tools/klipper_time.py` times a file the way a Klipper printer runs it: a port of the toolhead lookahead with junction deviation from `square_corner_velocity`, `minimum_cruise_ratio`, the extruder's corner velocity, extrude-only moves, the Z limits, and the stop at each `SET_PRESSURE_ADVANCE`. Its defaults are the Ideaformer IR3 V2's `printer.cfg`. `--at-layer N` and `--at-fraction 0.76` print the elapsed time at a layer or at that share of the file, for comparing with a print in progress. The engine uses the same model for a printer whose firmware is Klipper (`--firmware klipper` on the CLI); on a Telo cover it agreed with the tool within 0.1%.

## Scarf seams

A scarf replaces a butt seam on a closed wall when the seam is not already on a sharp convex corner. The loop starts at 15% of the layer height and 0.55 flow, rises to a full bead over 10 mm in 8 steps, then retraces that 10 mm at full Z while flow ramps back down. The second pass does not dip below plastic the start ramp already laid down. The seam metric is that overlap length, plus the largest Z step along the ramp. A butt seam has overlap 0. With the defaults the start-ramp step is `(1 − 0.15) × 0.2 / 8 = 0.021` mm, against a 0.20 mm layer. Nozzle Z stays inside the layer slab. The constant-Z body and the full-Z retrace can still be a G2/G3; the start ramp itself is linear.

`blend` (the default) turns this on for toughness and for a weight mix at or above 50% toughness. Speed stays off: forcing it on costs print time and does not save filament. `--classic` is off. The cube's corners hide the seam, so scarf-on and scarf-off match there, and the speed rows above are unchanged (cube 221.2 s, hull 772.0 s).

`samples/arc_post.stl` is the smooth case (64-gon, 12 mm radius, 6 mm tall). `samples/lime_hull.stl` is smooth enough that the outer wall scarfs once the seam is not on a sharp vertex.

| Mesh | Mode | Off s | Outer s | Off g | Outer g | Off arcs | Outer arcs | Off slice ms | Outer slice ms | Overlap mm | Max Z step mm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cube | speed | 221.2 | 221.2 | 2.14 | 2.14 | 2 | 2 | 2.34 | 2.64 | 0 | 0 |
| cube | toughness | 2134.4 | 2134.4 | 9.98 | 9.98 | 19699 | 19699 | 85.1 | 93.0 | 0 | 0 |
| arc post | speed | 122.2 | 134.6 | 0.96 | 0.97 | 118 | 118 | 6.26 | 6.43 | 10.00 | 0.021 |
| arc post | toughness | 941.7 | 968.8 | 3.32 | 3.33 | 7639 | 7660 | 45.9 | 46.8 | 10.00 | 0.021 |
| hull | speed | 772.0 | 813.5 | 5.72 | 5.76 | 2008 | 2109 | 41.29 | 42.18 | 10.00 | 0.021 |
| hull | toughness | 8614.7 | 8727.9 | 41.86 | 41.90 | 109172 | 109224 | 700.0 | 673.2 | 10.00 | 0.021 |

Speed forced to outer is 12.4 s slower on the post (122.2 → 134.6) and 41 s slower on the hull (772.0 → 813.5). That is why the speed blend leaves the scarf off. Toughness pays about 27 s on the post (941.7 → 968.8) and 113 s on the hull (8614.7 → 8727.9), and keeps the 10 mm overlap. The cube's corners hide the seam, so scarf-on and scarf-off match. Classic on the post is 210.5 s / 1.11 g (speed). The default hull toughness row above includes the scarf and recovered 3D gyroid, so that print is 8728 s.

## True 3D gyroid

`--gyroid-3d blend` (the default) cuts `sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0` at the layer Z wherever the pattern is already gyroid. Speed stays on lightning, so the speed rows above are unchanged (cube 221.2 s / 2.14 g, hull 772.0 s / 5.72 g). The 2D sine is `--gyroid-3d off`. Classic is the line planner. The cell period is 2.45 times the infill spacing, which extrudes as much as lines that far apart, so 48% covers 48% of the layer. The 2D sine scales its spacing by 2.2 for the same reason. Sampling runs per layer and per grid row.

Recovered 3D gyroid keeps that section, then spends less time on it. Open ends that clipping split are bridged when the gap stays inside the part. Locally circular runs become one G2/G3. The section is simplified to 0.04 mm so the curve stays long enough to count as toughness and still round enough for those arcs. A looser 0.08 mm kinked it into short chords, which both the estimator and the score treated as less path. Toughness infill uses its own feed and accel (110 mm/s, 4000 mm/s²), still under the 12 mm³/s cap, including when two layers are combined into a bead no thicker than the nozzle. On a 0.45 × 0.40 mm combined bead the cap is about 67 mm/s. The 2D sine keeps 55 mm/s and 1000 mm/s². The lattice is one full-density gyroid. Splitting a 2.4 mm skin from a 0.985 core dropped extruded length and added travel at the boundary, so that grade is gone. Interior gyroid combines every two layers when the bead fits the nozzle. `--gyroid-3d off` does none of this.

The print-time estimator now follows Klipper junction deviation (default 0.02 mm) and carries a feasible exit speed into the next move, still capped by the segment accel and the 12 mm³/s flow limit. A retract, a layer change, or a pure Z move breaks the chain, so those still start from rest. `--classic-estimator` keeps the old model, which stopped at the end of every segment. On the unrecovered cube that model reported 5861 s; a lookahead replay of the same G-code was about 3938 s. The tables above still quote classic-estimator times. On the recovered paths, lookahead vs that classic model (same G-code) is:

| Mesh | Mode | Classic s | Lookahead s | Ratio |
| --- | --- | ---: | ---: | ---: |
| cube | speed | 221.2 | 212.7 | 0.96 |
| cube | toughness 3D | 2134.4 | 1933.6 | 0.91 |
| cube | toughness 2D | 4696.0 | 3440.6 | 0.73 |
| hull | speed | 772.0 | 609.3 | 0.79 |
| hull | toughness 3D | 8727.9 | 7262.3 | 0.83 |
| hull | toughness 2D | 22332.3 | 15160.8 | 0.68 |
| column | speed | 514.0 | 497.2 | 0.97 |
| column | toughness 3D | 5744.3 | 5235.3 | 0.91 |
| column | toughness 2D | 14111.8 | 10268.2 | 0.73 |

Speed stays faster than toughness, and 3D gyroid stays faster than the 2D sine. The estimator does not change the toolpath.

Release bench, same machine, layer height 0.2 mm. Tall column is a 20 × 20 × 60 mm box. "Before" is unrecovered 3D gyroid (short chords, no arcs, 55 mm/s). "Recovered" is this tree. "2D" is `--gyroid-3d off`. The previous recovery (a 2.4 mm skin, 0.985 core, 0.08 mm simplify) was cube 2378.8 s / 11354, hull 9989.4 s / 47924, column 6497.4 s / 33863.

| Mesh | Infill | Slice ms | Print s | Filament g | Travel mm | Retracts | Toughness | Per hour |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cube | 3D before | 128.4 | 5860.7 | 10.05 | 6376 | 2 | 11572 | 7106 |
| cube | 3D recovered | 87.9 | 2134.4 | 9.98 | 3586 | 2 | 11577 | 19526 |
| cube | 2D gyroid | 40.1 | 4696.0 | 10.33 | 6609 | 2 | 10891 | 8349 |
| hull | 3D before | 915.8 | 28705.7 | 42.18 | 29686 | 2 | 49067 | 6154 |
| hull | 3D recovered | 675.1 | 8727.9 | 41.90 | 16193 | 2 | 49182 | 20286 |
| hull | 2D gyroid | 329.3 | 22332.3 | 43.77 | 22939 | 2 | 45642 | 7358 |
| column | 3D before | 362.6 | 17666.9 | 29.94 | 19716 | 2 | — | — |
| column | 3D recovered | 261.8 | 5744.3 | 29.75 | 10433 | 2 | 34594 | 21680 |
| column | 2D gyroid | 122.6 | 14111.8 | 30.82 | 20553 | 2 | 32570 | 8309 |

Cube score is back to the unrecovered 3D number (11577 vs 11572) and prints in 2134 s instead of 5861 s, under the 2D time of 4696 s. Hull is 49182 vs 49067 unrecovered and 8728 s vs 28706 s, under the 2D time of 22332 s. Those print seconds are the classic estimator. Lookahead on the same recovered G-code is 1934 s on the cube and 7262 s on the hull, still under the 2D lookahead times (3441 s and 15161 s). Toughness per hour on the classic model is about 19500 on the cube and 20300 on the hull, against about 8300 and 7400 for the 2D sine and about 17200 for the previous recovery. Speed keeps lightning.

## Z-hop

`--z-hop blend` is smart on toughness and off on speed. Smart on the cube hops 0 times, because combing already stays inside. On the hull it hops 0 times. Forcing smart on the speed blend adds a little time (cube 221.2 → 221.3 s, 3 hops; hull 772.0 → 772.7 s, 13 hops) without a toughness job to pay for, so speed stays off. Always on recovered toughness adds 16 s on the cube (2150 s vs 2134 s) and 86 s on the hull (8814 s vs 8728 s). A hole crossing retracts either way; smart lifts it only when the existing rules already would (not on speed, not on a scarf ramp, not under the hop minimum).

| Mesh | Mode | Print s | Hops | Travel mm | Retracts |
| --- | --- | ---: | ---: | ---: | ---: |
| cube | speed blend (off) | 221.2 | 0 | 677 | 1 |
| cube | speed smart | 221.3 | 3 | 677 | 1 |
| cube | toughness smart | 2134 | 0 | 3586 | 2 |
| cube | toughness always | 2150 | 174 | 3586 | 2 |
| hull | speed blend (off) | 772.0 | 0 | 2002 | 1 |
| hull | speed smart | 772.7 | 13 | 2002 | 1 |
| hull | toughness smart | 8728 | 0 | 16193 | 2 |
| hull | toughness always | 8814 | 1039 | 16193 | 2 |
| ledge, supports | toughness off | 3984 | 0 | 5162 | 179 |
| ledge, supports | toughness smart | 3996 | 116 | 5162 | 179 |

## Pressure-advance calibration

`lime-slice calibrate pa` writes a tower. Each band is a slow 40 mm/s frame and a slow-fast-slow line. The fast feed is the volumetric cap (here 133.3 mm/s at 0.45 × 0.2 mm and 12 mm³/s). A sample `--start 0 --end 0.04 --step 0.02 --band-height 1` produced three Klipper bands and 88.7 mm of filament:

| Band | K | Z |
| --- | ---: | --- |
| 0 | 0.0000 | 0.200–1.000 |
| 1 | 0.0200 | 1.200–2.000 |
| 2 | 0.0400 | 2.200–3.000 |
