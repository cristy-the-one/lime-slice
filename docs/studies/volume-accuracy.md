# Study: volume accuracy (E5a)

2026-11-25. The volume code measured is `main` at `9282f1088a1267bb541b3b7e4929df7cc7eb5e07`. The next commit on main, `9dea8590`, adds `docs/plan-mcp-2026-07-28.md` only and does not change `kernel.cpp`, the fuse-volume test, or the Open CASCADE install. This study changes no kernel, measure, or test expectation. The scripts that produced the numbers are `docs/studies/volume-accuracy-shapes.ts` and `docs/studies/volume-accuracy-bench.cpp`.

E5a is the volume half of the follow-up named in #842. `volume_of` integrates each face with `BRepGProp_Vinert::Perform` and no epsilon: a fixed-order Gauss rule (`BRepGProp_Face::UIntegrationOrder` / `VIntegrationOrder`, at most `math::GaussPointsMax()`, which is 61 in this Open CASCADE) and no error bound. `BRepGProp::VolumeProperties(shape, props)` with no epsilon takes that same path (`Eps = 1.0`). The overload that takes an epsilon adapts until its own estimate is under that epsilon. Its header says that an epsilon above 0.001 is not adaptive. At exactly 0.001 the implementation's error test is `theEps < 0.001`, so 1e-3 is the boundary: every shape below returned `returned_error=0.001` for that call.

The bar in this study is the one in the card, applied as the fuse guard already applies a slack: a readout passes when its absolute error is at most the larger of 0.01 % of the reference and 0.01 mm³, that is `abs_err <= max(|ref| * 1e-4, 0.01)`. On these four solids the 0.01 % term is the larger one. The printed bars run from 1.56379886269504164709 mm³ (the sheet, against the Gauss-Kronrod value) to 22.421524620034983 mm³ (the loft).

## Recommendation

No `VolumeProperties` epsilon in {1e-3, 1e-4, 1e-5, 1e-6} keeps every solid inside that bar.

On the cylinder, the bare loft, and the trimmed tub, epsilon 1e-3 already does, and it is the cheapest of the four. On the trimmed tub, which is the solid whose quick volume #842 quoted as 203,548 mm³, the absolute error at 1e-3 is 2.8470094548538327e-5 mm³ against the settled reference 204762.14572283957 mm³. The bar there is 20.476214572283958 mm³. The median call is 122.7314 ms. `volume_of` on that solid is 203547.65454857951 mm³, off by 1214.4911742600671 mm³ (0.59312289875296043 %), in 17.9598 ms.

The thickened NURBS sheet stops a single setting. `VolumeProperties` from 1e-3 through 1e-12 does not settle on it. The gap between 1e-11 and 1e-12 is 53.078636481406647 mm³, after earlier gaps of 117.12836741039973, 50.288488533586133 and 74.620711721514454 mm³. The bench still prints `SUGGESTED method=VolumeProperties eps=1.0e-12`. That line is provisional (`provisional=1`, `references_settled=0`): the sheet's reference is that same 1e-12 value, so the row is scored against itself.

The call that did settle on the sheet is `BRepGProp::VolumePropertiesGK` with spans (`IsUseSpan` true). At 1e-6 it returns 15638.000518995885 mm³ and at 1e-8 it returns 15637.988626950415 mm³. The difference is 0.01189204546972177923 mm³, which is 0.00007604587618913535 % of the 1e-8 value, inside 0.01 %. On the three solids whose `VolumeProperties` reference settled, GK at 1e-6 is also inside the bar (cylinder 4.7293724492192268e-11 mm³, loft 0.00058637303300201893 mm³, tub 0.00059181731194257736 mm³). Median times: cylinder 0.0441 ms, loft 75.8329 ms, tub 404.0536 ms, sheet 26.1544 ms. On the tub that is 404.0536 / 17.9598 = 22.49766701188209 times `volume_of`, and 404.0536 / 122.7314 = 3.2921778778698854 times `VolumeProperties` at 1e-3.

`volume_about` about the vertex mean prints the same value as `volume_of` on all four solids, so its absolute error is the same error. About the origin it moves (loft by 162.24168941105017438531 mm³, tub by 96.32586236542556434870 mm³) and still misses the bar on the loft and the tub. It is the right tool for a delta of two solids measured about one point. It is not a more accurate absolute volume.

Step 2 should not replace `volume_of` with `VolumeProperties` at 1e-6. On the tub that epsilon is far inside the bar and costs 380.6109 ms. On the sheet, 1e-6 is one of the unsettled clusters (15629.705435541715 mm³). It sits 8.295083454169799 mm³ under the GK 1e-6 value and 8.283191408700077 mm³ under the GK 1e-8 value, while the returned error estimate says 5.6872995579895618e-7. That estimate is not a bound on this sheet. #842's re-measure stays the fuse guard. It is not a general exact volume.

## How the numbers were taken

Open CASCADE is 7.9.2, `OCC_VERSION_COMPLETE` in the installed `Standard_Version.hxx`. The libraries are the Release shared build configured by `tools/occt/install.py` (the script the "Folded shell against real Open CASCADE" job runs) and built with `cmake --build --parallel 4`. `libTKernel.so` is a shared library. There is no `libTKernel.a`.

The four solids were built by the debug engine (`cargo build -p lime-mcp-engine -p lime-model-occt --locked` with `OCCT_ROOT` pointing at that install) through the same session calls the app uses. Each current node was exported as `LIMEBREP` (a header line, then `BinTools`). `HEADER_DELTA` is 0 on every solid: the bench's `volume_of` matches the volume the engine wrote into the header, to the last printed bit. The bench copies `faces_volume`, `integrated_volume`, `volume_of` and `volume_about` from `crates/lime-model-occt/cpp/kernel.cpp` and leaves out the `g_stats` counter lines. It is compiled at `-O2` against the Release Open CASCADE libraries. The integration itself runs in those libraries.

Each timed method is one untimed warmup, then 5 timed calls. The median is the middle of those five after sorting. `threads=4` is `std::thread::hardware_concurrency()`. `volume_of` and `volume_about` integrate faces with `OSD_Parallel`, as the kernel does. The machine was `Linux cursor 6.12.113+ #1 SMP PREEMPT_DYNAMIC Mon Nov 23 16:05:51 UTC 2026 x86_64`, `nproc` 4, `Intel(R) Xeon(R) Processor` at 2400 MHz, `MemTotal` 16387328 kB, `g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.

A reference is settled when the two tightest successful `VolumeProperties` epsilons differ by at most `max(|tighter| * 1e-6, 0.0001)` mm³. The cylinder's reference is analytic, `acos(-1) * 12.5^2 * 40`, which the bench printed as 19634.954084936206. Python's `math.pi` gives 19634.95408493620925582945, which matches the engine header 19634.954084936209. The two pis differ by a few units in the last place. The absolute errors below use the bench's printed reference.

## The four solids

All four are synthetic.

| Name | What it is | Faces (trimmed) | Engine `volume_of` in the brep header |
|---|---|---|---|
| cylinder | `solid_new` cylinder, radius 12.5 mm, height 40 mm, axis through the origin along +Z | 3 (3) | 19634.954084936209 |
| loft | The bare loft in `mcp/fuse-volume-occt.test.ts`, before the cuts | 3 (3) | 222888.63011330436 |
| tub | That loft, then the test's cockpit box and four side holes | 17 (17) | 203547.65454857951 |
| sheet | A 6×6 degree-3 NURBS sheet, poles `z = 12 sin(πu) sin(πv) + 4 sin(2πu) sin(3πv)` on an 80×60 mm rectangle, thickened 3 mm along the normal | 6 (6) | 15645.086495969883 |

#842's "203,548 against 204,762" is this tub, not the bare loft. The tub's quick volume is 203547.65454857951 mm³ and the settled `VolumeProperties` value is 204762.14572283957 mm³. The bare loft's quick volume is 222888.63011330436 mm³ against 224215.24620034982 mm³.

## References

| Solid | Reference | Settled |
|---|---|---|
| cylinder | analytic 19634.954084936206 | yes |
| loft | `VolumeProperties` 1e-12 = 224215.24620034982. Gap to 1e-11 is 2.9103830456733704e-11 mm³, tolerance 0.2242152462003498 mm³ | yes |
| tub | `VolumeProperties` 1e-12 = 204762.14572283957. Gap to 1e-11 is 6.4028427004814148e-10 mm³, tolerance 0.20476214572283957 mm³ | yes |
| sheet | `VolumeProperties` 1e-12 = 15658.447632262067. Gap to 1e-11 is 53.078636481406647 mm³, tolerance 0.015658447632262065 mm³ | no |

On the loft, 1e-3 already matches 1e-12 to 1.4551915228366852e-10 mm³. On the tub, 1e-3 matches 1e-12 to 2.8470094548538327e-5 mm³. Further tightening does not move either solid by anything near the bar. On the sheet it does.

## `volume_of` and `volume_about`

`volume_about` in the table is about the mean of the vertices, which is the point `volume_of` uses. `volume_about_origin` is about (0, 0, 0). Absolute error and the pass bit use the reference above. For the sheet that reference is not settled, so those pass bits are not a verdict.

| Solid | Method | Value mm³ | Abs error mm³ | Rel % | Bar mm³ | Pass | Median ms |
|---|---|---|---|---|---|---|---|
| cylinder | volume_of | 19634.954084936209 | 3.637978807091713e-12 | 1.8528073920390493e-14 | 1.9634954084936207 | yes | 0.4090 |
| cylinder | volume_about | 19634.954084936209 | 3.637978807091713e-12 | 1.8528073920390493e-14 | 1.9634954084936207 | yes | 0.0463 |
| loft | volume_of | 222888.63011330436 | 1326.6160870454623 | 0.5916707759739277 | 22.421524620034983 | no | 0.4950 |
| loft | volume_about | 222888.63011330436 | 1326.6160870454623 | 0.5916707759739277 | 22.421524620034983 | no | 0.4706 |
| tub | volume_of | 203547.65454857951 | 1214.4911742600671 | 0.59312289875296043 | 20.476214572283958 | no | 17.9598 |
| tub | volume_about | 203547.65454857951 | 1214.4911742600671 | 0.59312289875296043 | 20.476214572283958 | no | 17.8818 |
| sheet | volume_of | 15645.086495969883 | 13.361136292183801 | 0.085328613704049608 | 1.5658447632262067 | no | 0.6604 |
| sheet | volume_about | 15645.086495969883 | 13.361136292183801 | 0.085328613704049608 | 1.5658447632262067 | no | 0.6590 |

`VolumeProperties` with no epsilon prints the same value as `volume_of` on every solid. The cylinder's `volume_of` median is the slow one of the five samples (0.4092, 0.4090, 0.4188, 0.3994, 0.0832). The other three solids do not show that split.

Origin minus vertex-mean, from the printed values: cylinder 0.00000000000363797881 mm³, loft 162.24168941105017438531 mm³, tub 96.32586236542556434870 mm³, sheet 0.51342221746381255798 mm³. The loft's origin measure is still 1164.3743976344122 mm³ (0.51931098235575535 %) off the settled reference.

## `VolumeProperties` at each epsilon

Median milliseconds, and absolute error against the reference in the table above. Sheet errors are against an unsettled reference, so a "pass" there is not a pass.

| eps | cylinder abs mm³ / median ms | loft abs mm³ / median ms | tub abs mm³ / median ms | sheet value mm³ / median ms |
|---|---|---|---|---|
| 1e-3 | 3.637978807091713e-12 / 0.2522 | 1.4551915228366852e-10 / 2.8144 | 2.8470094548538327e-05 / 122.7314 | 15512.632651559132 / 1.0983 |
| 1e-4 | 3.637978807091713e-12 / 0.3551 | 2.9103830456733704e-11 / 7.0772 | 2.8469221433624625e-05 / 294.1499 | 15512.249482560961 / 3.6348 |
| 1e-5 | 0 / 0.4018 | 3.4924596548080444e-10 / 8.7585 | 8.7398802861571312e-08 / 336.2981 | 15629.377849971361 / 5.2321 |
| 1e-6 | 3.637978807091713e-12 / 0.4605 | 8.7311491370201111e-11 / 11.1745 | 8.7457010522484779e-08 / 380.6109 | 15629.705435541715 / 7.9799 |
| 1e-7 | 3.637978807091713e-12 / 0.5059 | 2.6193447411060333e-10 / 13.0538 | 8.7515218183398247e-08 / 416.4559 | 15629.701599891008 / 11.5421 |
| 1e-8 | 7.2759576141834259e-12 / 0.5608 | 3.7834979593753815e-10 / 15.8525 | 5.2386894822120667e-10 / 464.2075 | 15679.990088424594 / 15.7119 |
| 1e-9 | 0 / 0.6038 | 1.4551915228366852e-10 / 18.3961 | 4.9476511776447296e-10 / 521.2490 | 15679.989707312265 / 19.5729 |
| 1e-10 | 7.2759576141834259e-12 / 0.6753 | 6.6938810050487518e-10 / 21.5070 | 1.4551915228366852e-10 / 556.6856 | 15605.36899559075 / 26.6802 |
| 1e-11 | 0 / 0.7788 | 2.9103830456733704e-11 / 24.5887 | 6.4028427004814148e-10 / 614.6262 | 15605.36899578066 / 32.8920 |
| 1e-12 | 3.637978807091713e-12 / 0.7844 | 0 / 28.5410 | 0 / 673.1709 | 15658.447632262067 / 40.8057 |

The cylinder, loft and tub columns are absolute errors. The sheet column is the value, because the error against 1e-12 would hide the jumps. Full printed errors, returned error estimates, and all five times are in the bench output below.

Returned error estimates on the sheet stay under the requested epsilon (1e-6 returns 5.6872995579895618e-7, 1e-12 returns 3.6861621243350787e-13) while the value moves by tens of mm³. The estimate is not a certificate on this solid.

## Gauss-Kronrod with spans

Not one of the four epsilons the card named. Run because `VolumeProperties` did not settle on the sheet. `IsUseSpan` is true. Errors are against the same references as the rows above, so the sheet's pass bit is against the unsettled 1e-12 value and is not the comparison that matters. The comparison that matters on the sheet is the two GK values against each other.

| Solid | eps | Value mm³ | Abs error vs that solid's reference | Median ms |
|---|---|---|---|---|
| cylinder | 1e-6 | 19634.954084936158 | 4.7293724492192268e-11 | 0.0441 |
| loft | 1e-6 | 224215.24561397679 | 0.00058637303300201893 | 75.8329 |
| tub | 1e-6 | 204762.14513102226 | 0.00059181731194257736 | 404.0536 |
| sheet | 1e-6 | 15638.000518995885 | (see below) | 26.1544 |
| sheet | 1e-8 | 15637.988626950415 | (see below) | 116.3064 |

Sheet, GK 1e-6 minus GK 1e-8 = 0.01189204546972177923 mm³ = 0.00007604587618913535 % of 15637.988626950415. The bar at that volume is 1.56379886269504164709 mm³. The two calls agree inside the bar.

`volume_of` minus the sheet's GK 1e-8 value is 7.09786901946790749207 mm³, 0.04538863142051070831 %. The bar is 1.56379886269504164709 mm³, so the quick measure misses it on the sheet as well as on the loft and the tub.

## What step 2 would be deciding

This run does not change the measure. If the decision is only the fuse-volume tub, `VolumeProperties` at 1e-3 meets the bar and is the cheap one: 2.8470094548538327e-5 mm³ and 122.7314 ms, against 1214.4911742600671 mm³ and 17.9598 ms for `volume_of`. That is 122.7314 / 17.9598 = 6.833672980768159 times the quick measure. If the decision is every readout, including a thickened NURBS sheet, none of 1e-3 through 1e-6 (and none through 1e-12) has a settled value on that sheet. The call that settled there is `VolumePropertiesGK` with spans at 1e-6, at the times in the table above, and #842's 1e-6 re-measure stays the fuse guard either way.

## Command output

Shapes, from the debug engine:

```
step cylinder ok=true object=obj_1 volumeMm3= faces= reason=
step loft ok=true object=obj_2 volumeMm3= faces= reason=
step tub-loft ok=true object=obj_3 volumeMm3= faces= reason=
step tub-cut-0 ok=true object= volumeMm3= faces= reason=
step tub-cut-1 ok=true object= volumeMm3= faces= reason=
step tub-cut-2 ok=true object= volumeMm3= faces= reason=
step tub-cut-3 ok=true object= volumeMm3= faces= reason=
step tub-cut-4 ok=true object= volumeMm3= faces= reason=
step sheet ok=true object=obj_4 volumeMm3= faces= reason=
step sheet-thicken ok=true object= volumeMm3= faces= reason=
plate id=obj_1 name=cylinder volumeMm3=19634.954085000001 faces=3 editable=true
wrote /tmp/volume-accuracy/cylinder.brep bytes=1673 header=LIMEBREP 1 7.9.2 19634.95408493621 *
plate id=obj_2 name=loft volumeMm3=222888.63011299999 faces=3 editable=true
wrote /tmp/volume-accuracy/loft.brep bytes=29466 header=LIMEBREP 1 7.9.2 222888.63011330436 *
plate id=obj_3 name=tub volumeMm3=203547.65454900000 faces=17 editable=true
wrote /tmp/volume-accuracy/tub.brep bytes=100048 header=LIMEBREP 1 7.9.2 203547.6545485795 0,1,2,4,5,18,19
plate id=obj_4 name=sheet volumeMm3=15645.086496000000 faces=6 editable=true
wrote /tmp/volume-accuracy/sheet.brep bytes=37337 header=LIMEBREP 1 7.9.2 15645.086495969883 *
cylinder analytic pi*12.5^2*40 = 19634.954084936209 mm3
```

The plate line prints JavaScript's default `toPrecision(17)`, which rounds the header value. The header line is the engine's decimal. `faces=` on the `step` lines is empty because those replies do not carry a solid view; the plate lines do.

Bench, after one warmup and five timed calls. `pass` on the sheet uses the unsettled 1e-12 reference.

```
BENCH repeats=5 warmup=1 threads=4 cylinder_analytic_mm3=19634.954084936206 formula=pi*12.5^2*40 bar=max(abs(ref)*1e-4, 0.01 mm3)
SHAPE name=cylinder faces=3 trimmed=3 solids=1 shells=1 vertices=12 header=LIMEBREP 1 7.9.2 19634.95408493621 * header_volume_mm3=19634.954084936209 vertex_mean_mm=12.5,-3.061616997868383e-15,20
REF name=cylinder kind=analytic pi*12.5^2*40 settled=1 value_mm3=19634.954084936206
GAP name=cylinder VolumeProperties eps=1.0e-03 minus VolumeProperties eps=1.0e-04 mm3=7.2759576141834259e-12
GAP name=cylinder VolumeProperties eps=1.0e-04 minus VolumeProperties eps=1.0e-05 mm3=-3.637978807091713e-12
GAP name=cylinder VolumeProperties eps=1.0e-05 minus VolumeProperties eps=1.0e-06 mm3=-3.637978807091713e-12
GAP name=cylinder VolumeProperties eps=1.0e-06 minus VolumeProperties eps=1.0e-07 mm3=0
GAP name=cylinder VolumeProperties eps=1.0e-07 minus VolumeProperties eps=1.0e-08 mm3=-3.637978807091713e-12
GAP name=cylinder VolumeProperties eps=1.0e-08 minus VolumeProperties eps=1.0e-09 mm3=7.2759576141834259e-12
GAP name=cylinder VolumeProperties eps=1.0e-09 minus VolumeProperties eps=1.0e-10 mm3=7.2759576141834259e-12
GAP name=cylinder VolumeProperties eps=1.0e-10 minus VolumeProperties eps=1.0e-11 mm3=-7.2759576141834259e-12
GAP name=cylinder VolumeProperties eps=1.0e-11 minus VolumeProperties eps=1.0e-12 mm3=3.637978807091713e-12
ROW name=cylinder method=volume_of candidate=1 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.4090 mean_ms=0.3439 times_ms=0.4092,0.4090,0.4188,0.3994,0.0832
ROW name=cylinder method=volume_about candidate=1 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.0463 mean_ms=0.0469 times_ms=0.0494,0.0469,0.0463,0.0461,0.0461
ROW name=cylinder method=volume_about_origin candidate=0 ok=1 value_mm3=19634.954084936213 abs_mm3=7.2759576141834259e-12 rel_pct=3.7056147840780986e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.0457 mean_ms=0.0457 times_ms=0.0458,0.0457,0.0457,0.0457,0.0457
ROW name=cylinder method=VolumeProperties candidate=0 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.0623 mean_ms=0.0625 times_ms=0.0631,0.0626,0.0622,0.0622,0.0623
ROW name=cylinder method=VolumePropertiesGK span eps=1.0e-06 candidate=0 ok=1 value_mm3=19634.954084936158 abs_mm3=4.7293724492192268e-11 rel_pct=2.4086496096507644e-13 bar_mm3=1.9634954084936207 pass=1 median_ms=0.0441 mean_ms=0.0444 times_ms=0.0459,0.0444,0.0439,0.0441,0.0437 returned_error=6.0483010360567553e-10
ROW name=cylinder method=VolumePropertiesGK span eps=1.0e-08 candidate=0 ok=1 value_mm3=19634.954084936158 abs_mm3=4.7293724492192268e-11 rel_pct=2.4086496096507644e-13 bar_mm3=1.9634954084936207 pass=1 median_ms=0.0436 mean_ms=0.0437 times_ms=0.0440,0.0438,0.0436,0.0436,0.0435 returned_error=6.0483010360567553e-10
ROW name=cylinder method=VolumeProperties eps=1.0e-03 candidate=1 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.2522 mean_ms=0.2524 times_ms=0.2545,0.2522,0.2527,0.2519,0.2508 returned_error=0.001
ROW name=cylinder method=VolumeProperties eps=1.0e-04 candidate=1 ok=1 value_mm3=19634.954084936202 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.3551 mean_ms=0.3552 times_ms=0.3550,0.3565,0.3543,0.3553,0.3551 returned_error=3.4740138600732176e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-05 candidate=1 ok=1 value_mm3=19634.954084936206 abs_mm3=0 rel_pct=0 bar_mm3=1.9634954084936207 pass=1 median_ms=0.4018 mean_ms=0.4137 times_ms=0.4104,0.4018,0.4557,0.4003,0.4002 returned_error=7.275957614183429e-17
ROW name=cylinder method=VolumeProperties eps=1.0e-06 candidate=1 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.4605 mean_ms=0.4618 times_ms=0.4603,0.4605,0.4581,0.4690,0.4610 returned_error=7.2759576141834277e-17
ROW name=cylinder method=VolumeProperties eps=1.0e-07 candidate=1 ok=1 value_mm3=19634.954084936209 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.5059 mean_ms=0.5088 times_ms=0.5189,0.5081,0.5055,0.5057,0.5059 returned_error=3.4740138600732157e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-08 candidate=1 ok=1 value_mm3=19634.954084936213 abs_mm3=7.2759576141834259e-12 rel_pct=3.7056147840780986e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.5608 mean_ms=0.5705 times_ms=0.5608,0.5648,0.5567,0.5581,0.6121 returned_error=5.2110207901098225e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-09 candidate=1 ok=1 value_mm3=19634.954084936206 abs_mm3=0 rel_pct=0 bar_mm3=1.9634954084936207 pass=1 median_ms=0.6038 mean_ms=0.6046 times_ms=0.6071,0.6038,0.6051,0.6031,0.6037 returned_error=1.7370069300366083e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-10 candidate=1 ok=1 value_mm3=19634.954084936198 abs_mm3=7.2759576141834259e-12 rel_pct=3.7056147840780986e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.6753 mean_ms=0.6768 times_ms=0.6816,0.6780,0.6751,0.6753,0.6743 returned_error=6.9480277201464373e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-11 candidate=1 ok=1 value_mm3=19634.954084936206 abs_mm3=0 rel_pct=0 bar_mm3=1.9634954084936207 pass=1 median_ms=0.7788 mean_ms=0.7567 times_ms=0.7880,0.7850,0.7788,0.7163,0.7154 returned_error=2.1827872842550288e-16
ROW name=cylinder method=VolumeProperties eps=1.0e-12 candidate=1 ok=1 value_mm3=19634.954084936202 abs_mm3=3.637978807091713e-12 rel_pct=1.8528073920390493e-14 bar_mm3=1.9634954084936207 pass=1 median_ms=0.7844 mean_ms=0.7880 times_ms=0.7844,0.7858,0.7838,0.7833,0.8028 returned_error=5.2110207901098275e-16
HEADER_DELTA name=cylinder volume_of_minus_header_mm3=0
SHAPE name=loft faces=3 trimmed=3 solids=1 shells=1 vertices=12 header=LIMEBREP 1 7.9.2 222888.63011330436 * header_volume_mm3=222888.63011330436 vertex_mean_mm=-41,18,17
SETTLE name=loft tighter=VolumeProperties eps=1.0e-12 looser=VolumeProperties eps=1.0e-11 gap_mm3=2.9103830456733704e-11 tol_mm3=0.2242152462003498 settled=1
REF name=loft kind=VolumeProperties eps=1.0e-12 settled settled=1 value_mm3=224215.24620034982
GAP name=loft VolumeProperties eps=1.0e-03 minus VolumeProperties eps=1.0e-04 mm3=-1.1641532182693481e-10
GAP name=loft VolumeProperties eps=1.0e-04 minus VolumeProperties eps=1.0e-05 mm3=3.2014213502407074e-10
GAP name=loft VolumeProperties eps=1.0e-05 minus VolumeProperties eps=1.0e-06 mm3=-4.3655745685100555e-10
GAP name=loft VolumeProperties eps=1.0e-06 minus VolumeProperties eps=1.0e-07 mm3=3.4924596548080444e-10
GAP name=loft VolumeProperties eps=1.0e-07 minus VolumeProperties eps=1.0e-08 mm3=1.1641532182693481e-10
GAP name=loft VolumeProperties eps=1.0e-08 minus VolumeProperties eps=1.0e-09 mm3=-5.2386894822120667e-10
GAP name=loft VolumeProperties eps=1.0e-09 minus VolumeProperties eps=1.0e-10 mm3=8.149072527885437e-10
GAP name=loft VolumeProperties eps=1.0e-10 minus VolumeProperties eps=1.0e-11 mm3=-6.9849193096160889e-10
GAP name=loft VolumeProperties eps=1.0e-11 minus VolumeProperties eps=1.0e-12 mm3=2.9103830456733704e-11
ROW name=loft method=volume_of candidate=1 ok=1 value_mm3=222888.63011330436 abs_mm3=1326.6160870454623 rel_pct=0.5916707759739277 bar_mm3=22.421524620034983 pass=0 median_ms=0.4950 mean_ms=0.5107 times_ms=0.4950,0.4807,0.4845,0.5226,0.5706
ROW name=loft method=volume_about candidate=1 ok=1 value_mm3=222888.63011330436 abs_mm3=1326.6160870454623 rel_pct=0.5916707759739277 bar_mm3=22.421524620034983 pass=0 median_ms=0.4706 mean_ms=0.4702 times_ms=0.4706,0.4695,0.4689,0.4710,0.4713
ROW name=loft method=volume_about_origin candidate=0 ok=1 value_mm3=223050.87180271541 abs_mm3=1164.3743976344122 rel_pct=0.51931098235575535 bar_mm3=22.421524620034983 pass=0 median_ms=0.4625 mean_ms=0.4662 times_ms=0.4628,0.4625,0.4831,0.4609,0.4615
ROW name=loft method=VolumeProperties candidate=0 ok=1 value_mm3=222888.63011330436 abs_mm3=1326.6160870454623 rel_pct=0.5916707759739277 bar_mm3=22.421524620034983 pass=0 median_ms=0.6936 mean_ms=0.7166 times_ms=0.6936,0.6872,0.6984,0.6870,0.8170
ROW name=loft method=VolumePropertiesGK span eps=1.0e-06 candidate=0 ok=1 value_mm3=224215.24561397679 abs_mm3=0.00058637303300201893 rel_pct=2.61522373227938e-07 bar_mm3=22.421524620034983 pass=1 median_ms=75.8329 mean_ms=75.8027 times_ms=76.0375,75.8329,75.7078,75.5567,75.8787 returned_error=8.4013272747109435e-07
ROW name=loft method=VolumePropertiesGK span eps=1.0e-08 candidate=0 ok=1 value_mm3=224215.2461842724 abs_mm3=1.6077421605587006e-05 rel_pct=7.1705300500488095e-09 bar_mm3=22.421524620034983 pass=1 median_ms=219.6755 mean_ms=223.4787 times_ms=237.8144,219.6755,219.3668,221.4544,219.0822 returned_error=9.5826530141478564e-09
ROW name=loft method=VolumeProperties eps=1.0e-03 candidate=1 ok=1 value_mm3=224215.24620034968 abs_mm3=1.4551915228366852e-10 rel_pct=6.4901542044843101e-14 bar_mm3=22.421524620034983 pass=1 median_ms=2.8144 mean_ms=2.8228 times_ms=2.8144,2.8246,2.8837,2.7959,2.7953 returned_error=0.001
ROW name=loft method=VolumeProperties eps=1.0e-04 candidate=1 ok=1 value_mm3=224215.24620034979 abs_mm3=2.9103830456733704e-11 rel_pct=1.2980308408968621e-14 bar_mm3=22.421524620034983 pass=1 median_ms=7.0772 mean_ms=7.0722 times_ms=7.1066,7.0772,7.0157,7.0541,7.1074 returned_error=6.1694499067374402e-16
ROW name=loft method=VolumeProperties eps=1.0e-05 candidate=1 ok=1 value_mm3=224215.24620034947 abs_mm3=3.4924596548080444e-10 rel_pct=1.5576370090762345e-13 bar_mm3=22.421524620034983 pass=1 median_ms=8.7585 mean_ms=8.7524 times_ms=8.7154,8.7623,8.7953,8.7585,8.7306 returned_error=1.23388998134749e-15
ROW name=loft method=VolumeProperties eps=1.0e-06 candidate=1 ok=1 value_mm3=224215.24620034991 abs_mm3=8.7311491370201111e-11 rel_pct=3.8940925226905862e-14 bar_mm3=22.421524620034983 pass=1 median_ms=11.1745 mean_ms=11.1595 times_ms=11.1905,11.1073,11.1977,11.1273,11.1745 returned_error=2.4677799626949745e-15
ROW name=loft method=VolumeProperties eps=1.0e-07 candidate=1 ok=1 value_mm3=224215.24620034956 abs_mm3=2.6193447411060333e-10 rel_pct=1.1682277568071758e-13 bar_mm3=22.421524620034983 pass=1 median_ms=13.0538 mean_ms=13.0421 times_ms=13.0382,12.9925,13.0595,13.0664,13.0538 returned_error=1.5423624766843618e-16
ROW name=loft method=VolumeProperties eps=1.0e-08 candidate=1 ok=1 value_mm3=224215.24620034944 abs_mm3=3.7834979593753815e-10 rel_pct=1.6874400931659207e-13 bar_mm3=22.421524620034983 pass=1 median_ms=15.8525 mean_ms=15.8333 times_ms=15.9864,15.7105,15.8525,15.6944,15.9229 returned_error=9.2541748601061761e-16
ROW name=loft method=VolumeProperties eps=1.0e-09 candidate=1 ok=1 value_mm3=224215.24620034997 abs_mm3=1.4551915228366852e-10 rel_pct=6.4901542044843101e-14 bar_mm3=22.421524620034983 pass=1 median_ms=18.3961 mean_ms=18.4232 times_ms=18.3843,18.3961,18.4894,18.3048,18.5413 returned_error=4.3966380604288045e-17
ROW name=loft method=VolumeProperties eps=1.0e-10 candidate=1 ok=1 value_mm3=224215.24620034915 abs_mm3=6.6938810050487518e-10 rel_pct=2.985470934062783e-13 bar_mm3=22.421524620034983 pass=1 median_ms=21.5070 mean_ms=21.5379 times_ms=21.5846,21.4476,21.6776,21.4729,21.5070 returned_error=2.1593074673581112e-15
ROW name=loft method=VolumeProperties eps=1.0e-11 candidate=1 ok=1 value_mm3=224215.24620034985 abs_mm3=2.9103830456733704e-11 rel_pct=1.2980308408968621e-14 bar_mm3=22.421524620034983 pass=1 median_ms=24.5887 mean_ms=24.6185 times_ms=24.6031,24.4861,24.5887,24.5857,24.8290 returned_error=1.0796537336790516e-15
ROW name=loft method=VolumeProperties eps=1.0e-12 candidate=1 ok=1 value_mm3=224215.24620034982 abs_mm3=0 rel_pct=0 bar_mm3=22.421524620034983 pass=1 median_ms=28.5410 mean_ms=28.8095 times_ms=29.1363,29.3705,28.5016,28.5410,28.4982 returned_error=1.3881262290159237e-15
HEADER_DELTA name=loft volume_of_minus_header_mm3=0
SHAPE name=tub faces=17 trimmed=17 solids=1 shells=1 vertices=140 header=LIMEBREP 1 7.9.2 203547.6545485795 0,1,2,4,5,18,19 header_volume_mm3=203547.65454857951 vertex_mean_mm=-30.456900405965026,17.852166619772973,26.340176719998531
SETTLE name=tub tighter=VolumeProperties eps=1.0e-12 looser=VolumeProperties eps=1.0e-11 gap_mm3=6.4028427004814148e-10 tol_mm3=0.20476214572283957 settled=1
REF name=tub kind=VolumeProperties eps=1.0e-12 settled settled=1 value_mm3=204762.14572283957
GAP name=tub VolumeProperties eps=1.0e-03 minus VolumeProperties eps=1.0e-04 mm3=-8.7311491370201111e-10
GAP name=tub VolumeProperties eps=1.0e-04 minus VolumeProperties eps=1.0e-05 mm3=-2.8556620236486197e-05
GAP name=tub VolumeProperties eps=1.0e-05 minus VolumeProperties eps=1.0e-06 mm3=-5.8207660913467407e-11
GAP name=tub VolumeProperties eps=1.0e-06 minus VolumeProperties eps=1.0e-07 mm3=-5.8207660913467407e-11
GAP name=tub VolumeProperties eps=1.0e-07 minus VolumeProperties eps=1.0e-08 mm3=8.8039087131619453e-08
GAP name=tub VolumeProperties eps=1.0e-08 minus VolumeProperties eps=1.0e-09 mm3=-2.9103830456733704e-11
GAP name=tub VolumeProperties eps=1.0e-09 minus VolumeProperties eps=1.0e-10 mm3=-3.4924596548080444e-10
GAP name=tub VolumeProperties eps=1.0e-10 minus VolumeProperties eps=1.0e-11 mm3=4.9476511776447296e-10
GAP name=tub VolumeProperties eps=1.0e-11 minus VolumeProperties eps=1.0e-12 mm3=-6.4028427004814148e-10
ROW name=tub method=volume_of candidate=1 ok=1 value_mm3=203547.65454857951 abs_mm3=1214.4911742600671 rel_pct=0.59312289875296043 bar_mm3=20.476214572283958 pass=0 median_ms=17.9598 mean_ms=17.9891 times_ms=18.2891,17.9598,17.9042,17.9786,17.8137
ROW name=tub method=volume_about candidate=1 ok=1 value_mm3=203547.65454857951 abs_mm3=1214.4911742600671 rel_pct=0.59312289875296043 bar_mm3=20.476214572283958 pass=0 median_ms=17.8818 mean_ms=17.8743 times_ms=17.7013,18.0037,17.9061,17.8818,17.8786
ROW name=tub method=volume_about_origin candidate=0 ok=1 value_mm3=203643.98041094493 abs_mm3=1118.1653118946415 rel_pct=0.54608009109660305 bar_mm3=20.476214572283958 pass=0 median_ms=17.9286 mean_ms=17.9279 times_ms=17.9286,17.8968,18.1179,17.9586,17.7377
ROW name=tub method=VolumeProperties candidate=0 ok=1 value_mm3=203547.65454857951 abs_mm3=1214.4911742600671 rel_pct=0.59312289875296043 bar_mm3=20.476214572283958 pass=0 median_ms=19.7438 mean_ms=19.7661 times_ms=19.7182,19.8208,19.8170,19.7438,19.7309
ROW name=tub method=VolumePropertiesGK span eps=1.0e-06 candidate=0 ok=1 value_mm3=204762.14513102226 abs_mm3=0.00059181731194257736 rel_pct=2.890267191982082e-07 bar_mm3=20.476214572283958 pass=1 median_ms=404.0536 mean_ms=404.3488 times_ms=403.1902,404.0536,403.7861,405.0122,405.7017 returned_error=8.6176927559796406e-07
ROW name=tub method=VolumePropertiesGK span eps=1.0e-08 candidate=0 ok=1 value_mm3=204762.14574524091 abs_mm3=2.2401334717869759e-05 rel_pct=1.0940173848437587e-08 bar_mm3=20.476214572283958 pass=1 median_ms=581.7481 mean_ms=595.6390 times_ms=580.9630,580.2928,582.9551,581.7481,652.2357 returned_error=9.6363779232741385e-09
ROW name=tub method=VolumeProperties eps=1.0e-03 candidate=1 ok=1 value_mm3=204762.14569436948 abs_mm3=2.8470094548538327e-05 rel_pct=1.3903983301227301e-08 bar_mm3=20.476214572283958 pass=1 median_ms=122.7314 mean_ms=123.2217 times_ms=122.7045,122.8383,125.8947,122.7314,121.9396 returned_error=0.001
ROW name=tub method=VolumeProperties eps=1.0e-04 candidate=1 ok=1 value_mm3=204762.14569437035 abs_mm3=2.8469221433624625e-05 rel_pct=1.3903556896771234e-08 bar_mm3=20.476214572283958 pass=1 median_ms=294.1499 mean_ms=294.4591 times_ms=294.2332,294.1499,293.7812,294.0058,296.1253 returned_error=3.6216252808537463e-10
ROW name=tub method=VolumeProperties eps=1.0e-05 candidate=1 ok=1 value_mm3=204762.14572292697 abs_mm3=8.7398802861571312e-08 rel_pct=4.2683086052376074e-11 bar_mm3=20.476214572283958 pass=1 median_ms=336.2981 mean_ms=336.3418 times_ms=336.7602,334.9847,336.2981,335.5211,338.1451 returned_error=5.448961300106826e-12
ROW name=tub method=VolumeProperties eps=1.0e-06 candidate=1 ok=1 value_mm3=204762.14572292703 abs_mm3=8.7457010522484779e-08 rel_pct=4.2711513016113919e-11 bar_mm3=20.476214572283958 pass=1 median_ms=380.6109 mean_ms=382.2204 times_ms=386.6779,379.6165,380.3650,383.8316,380.6109 returned_error=5.4489613001068583e-12
ROW name=tub method=VolumeProperties eps=1.0e-07 candidate=1 ok=1 value_mm3=204762.14572292709 abs_mm3=8.7515218183398247e-08 rel_pct=4.2739939979851764e-11 bar_mm3=20.476214572283958 pass=1 median_ms=416.4559 mean_ms=417.5653 times_ms=416.4559,414.8496,422.9377,417.5550,416.0282 returned_error=5.4489613001068785e-12
ROW name=tub method=VolumeProperties eps=1.0e-08 candidate=1 ok=1 value_mm3=204762.14572283905 abs_mm3=5.2386894822120667e-10 rel_pct=2.5584267364061583e-13 bar_mm3=20.476214572283958 pass=1 median_ms=464.2075 mean_ms=464.2070 times_ms=462.8603,465.6311,463.1460,464.2075,465.1902 returned_error=5.4489836148155093e-12
ROW name=tub method=VolumeProperties eps=1.0e-09 candidate=1 ok=1 value_mm3=204762.14572283908 abs_mm3=4.9476511776447296e-10 rel_pct=2.4162919177169274e-13 bar_mm3=20.476214572283958 pass=1 median_ms=521.2490 mean_ms=522.8820 times_ms=516.1174,522.0431,538.4673,521.2490,516.5333 returned_error=5.4489836148155077e-12
ROW name=tub method=VolumeProperties eps=1.0e-10 candidate=1 ok=1 value_mm3=204762.14572283943 abs_mm3=1.4551915228366852e-10 rel_pct=7.1067409344615514e-14 bar_mm3=20.476214572283958 pass=1 median_ms=556.6856 mean_ms=557.0097 times_ms=555.1624,556.4979,556.6856,557.0388,559.6637 returned_error=5.448961319061194e-12
ROW name=tub method=VolumeProperties eps=1.0e-11 candidate=1 ok=1 value_mm3=204762.14572283893 abs_mm3=6.4028427004814148e-10 rel_pct=3.1269660111630823e-13 bar_mm3=20.476214572283958 pass=1 median_ms=614.6262 mean_ms=614.3097 times_ms=614.6262,615.8960,611.0548,618.2732,611.6983 returned_error=5.4489613190611899e-12
ROW name=tub method=VolumeProperties eps=1.0e-12 candidate=1 ok=1 value_mm3=204762.14572283957 abs_mm3=0 rel_pct=0 bar_mm3=20.476214572283958 pass=1 median_ms=673.1709 mean_ms=671.6767 times_ms=673.1709,675.4043,674.4456,670.4252,664.9374 returned_error=4.7530730645708766e-13
HEADER_DELTA name=tub volume_of_minus_header_mm3=0
SHAPE name=sheet faces=6 trimmed=6 solids=1 shells=1 vertices=48 header=LIMEBREP 1 7.9.2 15645.086495969883 * header_volume_mm3=15645.086495969883 vertex_mean_mm=0,-7.4014868308343765e-17,1.5
SETTLE name=sheet tighter=VolumeProperties eps=1.0e-12 looser=VolumeProperties eps=1.0e-11 gap_mm3=53.078636481406647 tol_mm3=0.015658447632262065 settled=0
REF name=sheet kind=VolumeProperties eps=1.0e-12 NOT settled settled=0 value_mm3=15658.447632262067
GAP name=sheet VolumeProperties eps=1.0e-03 minus VolumeProperties eps=1.0e-04 mm3=0.38316899817073136
GAP name=sheet VolumeProperties eps=1.0e-04 minus VolumeProperties eps=1.0e-05 mm3=-117.12836741039973
GAP name=sheet VolumeProperties eps=1.0e-05 minus VolumeProperties eps=1.0e-06 mm3=-0.32758557035413105
GAP name=sheet VolumeProperties eps=1.0e-06 minus VolumeProperties eps=1.0e-07 mm3=0.0038356507066055201
GAP name=sheet VolumeProperties eps=1.0e-07 minus VolumeProperties eps=1.0e-08 mm3=-50.288488533586133
GAP name=sheet VolumeProperties eps=1.0e-08 minus VolumeProperties eps=1.0e-09 mm3=0.00038111232970550191
GAP name=sheet VolumeProperties eps=1.0e-09 minus VolumeProperties eps=1.0e-10 mm3=74.620711721514454
GAP name=sheet VolumeProperties eps=1.0e-10 minus VolumeProperties eps=1.0e-11 mm3=-1.899097696878016e-07
GAP name=sheet VolumeProperties eps=1.0e-11 minus VolumeProperties eps=1.0e-12 mm3=-53.078636481406647
ROW name=sheet method=volume_of candidate=1 ok=1 value_mm3=15645.086495969883 abs_mm3=13.361136292183801 rel_pct=0.085328613704049608 bar_mm3=1.5658447632262067 pass=0 median_ms=0.6604 mean_ms=0.6696 times_ms=0.6820,0.6594,0.6883,0.6604,0.6579
ROW name=sheet method=volume_about candidate=1 ok=1 value_mm3=15645.086495969883 abs_mm3=13.361136292183801 rel_pct=0.085328613704049608 bar_mm3=1.5658447632262067 pass=0 median_ms=0.6590 mean_ms=0.6943 times_ms=0.6662,0.6590,0.6533,0.6553,0.8377
ROW name=sheet method=volume_about_origin candidate=0 ok=1 value_mm3=15645.599918187347 abs_mm3=12.847714074719988 rel_pct=0.082049730448687963 bar_mm3=1.5658447632262067 pass=0 median_ms=0.6762 mean_ms=0.6804 times_ms=0.6762,0.6883,0.6693,0.6603,0.7080
ROW name=sheet method=VolumeProperties candidate=0 ok=1 value_mm3=15645.086495969883 abs_mm3=13.361136292183801 rel_pct=0.085328613704049608 bar_mm3=1.5658447632262067 pass=0 median_ms=1.5781 mean_ms=1.5795 times_ms=1.5781,1.5862,1.5771,1.5767,1.5792
ROW name=sheet method=VolumePropertiesGK span eps=1.0e-06 candidate=0 ok=1 value_mm3=15638.000518995885 abs_mm3=20.447113266181987 rel_pct=0.13058199475696133 bar_mm3=1.5658447632262067 pass=0 median_ms=26.1544 mean_ms=26.4428 times_ms=27.8397,25.9550,26.2021,26.0626,26.1544 returned_error=2.2725073897010937e-06
ROW name=sheet method=VolumePropertiesGK span eps=1.0e-08 candidate=0 ok=1 value_mm3=15637.988626950415 abs_mm3=20.459005311651708 rel_pct=0.13065794127317421 bar_mm3=1.5658447632262067 pass=0 median_ms=116.3064 mean_ms=116.3741 times_ms=116.3006,116.3064,116.3784,116.9207,115.9642 returned_error=2.9211981503481738e-08
ROW name=sheet method=VolumeProperties eps=1.0e-03 candidate=1 ok=1 value_mm3=15512.632651559132 abs_mm3=145.81498070293492 rel_pct=0.93122245657675096 bar_mm3=1.5658447632262067 pass=0 median_ms=1.0983 mean_ms=1.1238 times_ms=1.0916,1.0993,1.2423,1.0874,1.0983 returned_error=0.001
ROW name=sheet method=VolumeProperties eps=1.0e-04 candidate=1 ok=1 value_mm3=15512.249482560961 abs_mm3=146.19814970110565 rel_pct=0.93366949990549875 bar_mm3=1.5658447632262067 pass=0 median_ms=3.6348 mean_ms=3.6254 times_ms=3.6411,3.6348,3.5735,3.7075,3.5701 returned_error=4.6321928057363542e-05
ROW name=sheet method=VolumeProperties eps=1.0e-05 candidate=1 ok=1 value_mm3=15629.377849971361 abs_mm3=29.069782290705916 rel_pct=0.18564919699199076 bar_mm3=1.5658447632262067 pass=0 median_ms=5.2321 mean_ms=5.2193 times_ms=5.2888,5.2626,5.1765,5.2321,5.1365 returned_error=8.4892544066476475e-06
ROW name=sheet method=VolumeProperties eps=1.0e-06 candidate=1 ok=1 value_mm3=15629.705435541715 abs_mm3=28.742196720351785 rel_pct=0.1835571277265855 bar_mm3=1.5658447632262067 pass=0 median_ms=7.9799 mean_ms=7.9811 times_ms=7.9799,7.8288,8.0496,7.9647,8.0824 returned_error=5.6872995579895618e-07
ROW name=sheet method=VolumeProperties eps=1.0e-07 candidate=1 ok=1 value_mm3=15629.701599891008 abs_mm3=28.746032371058391 rel_pct=0.18358162345436571 bar_mm3=1.5658447632262067 pass=0 median_ms=11.5421 mean_ms=11.5457 times_ms=11.4887,11.5421,11.5662,11.7179,11.4139 returned_error=3.2007759138042015e-08
ROW name=sheet method=VolumeProperties eps=1.0e-08 candidate=1 ok=1 value_mm3=15679.990088424594 abs_mm3=21.542456162527742 rel_pct=0.13757721498612985 bar_mm3=1.5658447632262067 pass=0 median_ms=15.7119 mean_ms=15.7111 times_ms=15.8857,15.5858,15.7119,15.7405,15.6319 returned_error=6.2624992144736784e-09
ROW name=sheet method=VolumeProperties eps=1.0e-09 candidate=1 ok=1 value_mm3=15679.989707312265 abs_mm3=21.542075050198036 rel_pct=0.13757478107736279 bar_mm3=1.5658447632262067 pass=0 median_ms=19.5729 mean_ms=19.6094 times_ms=19.6702,19.5603,19.6804,19.5632,19.5729 returned_error=4.5848524743255936e-10
ROW name=sheet method=VolumeProperties eps=1.0e-10 candidate=1 ok=1 value_mm3=15605.36899559075 abs_mm3=53.078636671316417 rel_pct=0.33897764272593167 bar_mm3=1.5658447632262067 pass=0 median_ms=26.6802 mean_ms=26.7504 times_ms=26.6003,26.6802,26.9551,26.6628,26.8536 returned_error=3.9243464646631921e-11
ROW name=sheet method=VolumeProperties eps=1.0e-11 candidate=1 ok=1 value_mm3=15605.36899578066 abs_mm3=53.078636481406647 rel_pct=0.33897764151310539 bar_mm3=1.5658447632262067 pass=0 median_ms=32.8920 mean_ms=32.9363 times_ms=33.1261,32.8660,32.9200,32.8776,32.8920 returned_error=2.3533621916536475e-12
ROW name=sheet method=VolumeProperties eps=1.0e-12 candidate=1 ok=1 value_mm3=15658.447632262067 abs_mm3=0 rel_pct=0 bar_mm3=1.5658447632262067 pass=1 median_ms=40.8057 mean_ms=40.7870 times_ms=40.8057,40.8070,40.8230,40.7319,40.7673 returned_error=3.6861621243350787e-13
HEADER_DELTA name=sheet volume_of_minus_header_mm3=0
REF_OK name=cylinder settled=1
REF_OK name=loft settled=1
REF_OK name=tub settled=1
REF_OK name=sheet settled=0
SUGGESTION bar=abs_err<=max(abs(ref)*1e-4, 0.01) cost=sum of median_ms references_settled=0
CANDIDATE method=volume_of all_measured=1 all_pass=0 sum_median_ms=19.5243
CANDIDATE method=volume_about all_measured=1 all_pass=0 sum_median_ms=19.0576
CANDIDATE method=VolumeProperties eps=1.0e-03 all_measured=1 all_pass=0 sum_median_ms=126.8964
CANDIDATE method=VolumeProperties eps=1.0e-04 all_measured=1 all_pass=0 sum_median_ms=305.2169
CANDIDATE method=VolumeProperties eps=1.0e-05 all_measured=1 all_pass=0 sum_median_ms=350.6905
CANDIDATE method=VolumeProperties eps=1.0e-06 all_measured=1 all_pass=0 sum_median_ms=400.2258
CANDIDATE method=VolumeProperties eps=1.0e-07 all_measured=1 all_pass=0 sum_median_ms=441.5577
CANDIDATE method=VolumeProperties eps=1.0e-08 all_measured=1 all_pass=0 sum_median_ms=496.3327
CANDIDATE method=VolumeProperties eps=1.0e-09 all_measured=1 all_pass=0 sum_median_ms=559.8218
CANDIDATE method=VolumeProperties eps=1.0e-10 all_measured=1 all_pass=0 sum_median_ms=605.5481
CANDIDATE method=VolumeProperties eps=1.0e-11 all_measured=1 all_pass=0 sum_median_ms=672.8856
CANDIDATE method=VolumeProperties eps=1.0e-12 all_measured=1 all_pass=1 sum_median_ms=743.3020
SUGGESTED method=VolumeProperties eps=1.0e-12 sum_median_ms=743.3020 provisional=1
```

Derived from those printed values:

```
gk_gap 0.01189204546972177923
gk_gap_pct 0.00007604587618913535
vof_minus_gk8 7.09786901946790749207
vof_rel_pct 0.04538863142051070831
sheet_bar 1.56379886269504164709
tub_1e3_abs 0.00002847009454853833
tub_vof_abs 1214.49117426006705500185
tub_vof_pct 0.59312289875296042574
loft_vof_abs 1326.61608704546233639121
loft_vof_pct 0.59167077597392769839
loft origin_minus_vertex_mean 162.24168941105017438531
tub origin_minus_vertex_mean 96.32586236542556434870
sheet origin_minus_vertex_mean 0.51342221746381255798
cylinder origin_minus_vertex_mean 0.00000000000363797881
analytic math.pi*12.5^2*40 19634.95408493620925582945
gk6_over_vof_tub 22.49766701188209
vp1e3_over_vof_tub 6.833672980768159
gk6_over_vp1e3_tub 3.2921778778698854
sheet_gk6_minus_vp1e6 8.295083454169799
sheet_gk8_minus_vp1e6 8.283191408700077
```
