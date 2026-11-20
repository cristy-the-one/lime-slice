# Mechanical parts in the Model tab

Status: plan. Not built. Implementation waits until after the 6.13.0 release. This file is the spec an implementation follows. The catalogue and the lust fixtures on `study/mech-components` (`docs/studies/mechanical-components.md`, PR #773) stay study material. They are not the product, and they are not copied into the kernel.

The owner's direction on that PR: each part is a native Model-tab part, built by the modelling kernel the way the gear primitive is (`crates/lime-model-occt/src/tree/gear.rs`, `docs/plan-native-recipes.md` milestone 8).

## 1. What native means

The gear is the pattern. A person with no agent and no script picks the part in the Add dialog, scrubs its fields, and gets one History step. That step edits later, survives save and reopen, and works as a boolean tool.

- **Kernel.** A `Primitive` in `lime-model-occt`, or one primitive with a `kind`, the way `Primitive::Gear` is one primitive and external / ring / rack are kinds. The solid is exact where a standard gives a shape (a hexagon of the table's across-flats, a cylinder of the table's diameters, an involute the gear crate already builds). A size that comes from a standard is a row in a table in the kernel. It is not a formula of the nominal.
- **Window.** An entry in the Add dialog (`src/app/model/markup.ts`), fields scrubbable like the gear's. The ghost in `src/model-primitive.ts` is drawn from the sizes alone and does not ask the engine.
- **MCP.** `solid_new` and the boolean tool take the same fields. No new tool. `guide` carries the tables. First contact stays inside the 1,500-token budget in `mcp/schema.test.ts`, and a guide reply stays inside the 3,000-token reply budget there.
- **Files.** An older project stays valid: new fields are written only when sent, as `Solid` already does for the gear.

Cylinders, polygon prisms and boxes grow in +Z from their origin. A box's origin is its minimum corner. A cylinder's or a polygon's origin is the centre of its base. A turn is degrees about X, then Y, then Z, about the primitive's centre. The socket, the pulley teeth and the bracket in this plan are placed with that rule.

## 2. Order

Two waves, then a list that waits on a table or a kernel feature. Rack and ring already exist as gear kinds and are not rebuilt.

**Wave 1, fasteners and structure.** Hex nut, socket-head cap screw, hex-head screw, washer, spacer, shaft, shaft collar, plate, L-bracket, and the heat-set boss. The Ruthex insert table is in section 4.10, so the boss ships in milestone 2.

**Wave 2, drives.** GT2 pulley. The V-belt pulley follows only after the ISO 4183 groove table is copied into section 5.

**Later.** Parallel key, flat pulley, bearing housing, 2020 T-nut, cable clip, snap-fit, knob, disk cam, and a modelled thread. Section 7 says what each one is waiting on. Springs, worms, bevels, helical gears, a ball-bearing solid and a wave washer stay out: the kernel has no helix sweep and no worm or bevel outline.

## 3. Shared geometry rules

These are the defects in the study fixtures. The native parts are specified against them.

- A hex socket is a prism whose base is at `z = head height − socket depth` and whose top is above the head, so the pocket opens the top face and removes metal inside the head. A prism that starts at `z = head height` cuts empty space above the head.
- A socket's across-flats is the ISO 4762 key size. For M6 that is 5 mm.
- A nut's hole is the coarse tap-drill diameter, or a modelled thread in the milestone that builds threads. It is not a running-clearance hole (`Fit::Running`), which is a spacer.
- Across-flats, head height, washer diameters and tap-drill diameters come from the tables in this file. `nominal * 1.5 + 1` is not a wrench size.
- A GT2 tooth cut is turned so its depth points at the centre, and it crosses the whole belt width, breaking both side faces. The outside diameter is the pitch diameter minus 0.508 mm. The pitch is 2 mm and is not a parameter.
- A V-belt groove is a revolved trapezoid in the rim. A cone subtracted along the pulley axis is a centre hole, not a groove.
- An apply that fails is a refusal with a sentence. Nothing is discarded.

The bounding box the tests expect is the analytic box of the solid, computed in the test from the same tables. It is not a number the part writes down about itself.

A cut that must break a face extends 0.2 mm past that face (`OVERSHOOT_MM`). That 0.2 mm is a boolean clearance, not a dimension from a standard. Metal outside the part is unchanged, so the solid's box stays on the part.

A hexagon with across-flats `s` and one flat facing −Y (the polygon primitive's orientation) has vertices on ±X. Its box is `x = ±s/√3`, `y = ±s/2`. The area is `(√3/2) s²`. The standard's minimum across-corners `e` is the tolerance of a chamfered nut and is smaller than this sharp hex. The kernel builds the sharp hex of width `s`.

## 4. Wave 1

Nominal sizes are a choice, spelled `M3`, `M6`, and so on. A number with a step of 0.5 mm cannot land on these tables. An unknown size is refused in one sentence naming the table.

`height: 0` on a fastener means the table's height. A positive height replaces it, so a person can still tune, and the default stays the standard.

### 4.1 Hex nut

ISO 4032 style 1. The solid uses across-flats `s` max (the wrench size) and thickness `m` max. Sources checked for this table: the ISO 4032 style-1 sheets published by ASMC and by Mech Codex, which agree on these rows. M14 and M18 are non-preferred and are not in the picker.

| Nominal | Pitch | s | m max | Tap drill |
|---|---:|---:|---:|---:|
| M3 | 0.5 | 5.5 | 2.4 | 2.5 |
| M4 | 0.7 | 7 | 3.2 | 3.3 |
| M5 | 0.8 | 8 | 4.7 | 4.2 |
| M6 | 1 | 10 | 5.2 | 5.0 |
| M8 | 1.25 | 13 | 6.8 | 6.8 |
| M10 | 1.5 | 16 | 8.4 | 8.5 |
| M12 | 1.75 | 18 | 10.8 | 10.2 |
| M16 | 2 | 24 | 14.8 | 14.0 |
| M20 | 2.5 | 30 | 18 | 17.5 |
| M24 | 3 | 36 | 21.5 | 21.0 |

The tap-drill column is the coarse-series drill (nominal minus pitch), stored as a row. M6's drill of 5.0 mm is the figure published with the ISO 4762 M6 data (PartXT). The kernel does not compute the drill from the pitch at runtime.

Parameters: nominal, default `M6`. Height, default 0 (table). Allowance, millimetres added to the tap drill for a printed hole, default 0, range 0 to 1. Bore kind `tap` only, until section 8.

Geometry: polygon prism, 6 sides, flats, across `s`, height `m`. Through hole on the axis, diameter = tap drill + allowance. The hole is smaller than `s`, so it stays inside the hex.

Default M6 box, from the rule in section 3: `x = ±10/√3`, `y = ±5`, `z` from 0 to 5.2. Volume `(√3/2) * 10² * 5.2 − π * 2.5² * 5.2`.

### 4.2 Socket-head cap screw

ISO 4762. Head diameter `dk` and head height `k` are the maximum head in the published chart. Key `s` is the hex key. Socket depth is `t` min. Sources checked: the Baouch ISO 4762 table and the HEXVARO DIN 912 / ISO 4762 chart, which agree on these rows. RoyMech prints a deeper M6 socket (3.30 mm against 3 mm here). This plan uses the `t` min column those two charts share. A check of the ISO PDF that differs updates this table before the code PR.

| Nominal | dk | k | s | t min |
|---|---:|---:|---:|---:|
| M3 | 5.5 | 3 | 2.5 | 1.3 |
| M4 | 7 | 4 | 3 | 2 |
| M5 | 8.5 | 5 | 4 | 2.5 |
| M6 | 10 | 6 | 5 | 3 |
| M8 | 13 | 8 | 6 | 4 |
| M10 | 16 | 10 | 8 | 5 |
| M12 | 18 | 12 | 10 | 6 |
| M16 | 24 | 16 | 14 | 8 |
| M20 | 30 | 20 | 17 | 10 |
| M24 | 36 | 24 | 19 | 12 |

Parameters: nominal, default `M6`. Length under the head, default 25, range 0 to 200, step 0.5. Zero is a head with no shank. Head diameter, head height and socket depth default to 0, meaning the row. A positive value replaces that one field.

Geometry, for table values `dk`, `k`, `s`, `t` and length `L`:

- Head: cylinder, radius `dk/2`, height `k`, base on `z = 0`.
- Socket: hex prism, across-flats `s`, height `t + OVERSHOOT_MM`, base centre at `(0, 0, k − t)`. The prism runs from `k − t` up through the top face. It does not start at `z = k`.
- Shank, when `L > 0`: cylinder, radius `nominal/2` (the major diameter; this milestone has no thread), height `L`, base centre at `(0, 0, −L)`, fused to the head. It occupies `z` from `−L` to 0.

Default M6 × 25 box: `x` and `y` are `±5` (the head; the M6 key's across-corners is `5 * 2/√3`, inside the 10 mm head), `z` from −25 to 6. Volume is the head cylinder plus the shank cylinder minus the socket prism that lies inside the head, `(√3/2) * 5² * 3`.

### 4.3 Hex-head screw

ISO 4017 head, which is the same head as ISO 4014. The solid uses across-flats `s` max and nominal head height `k`. Sources checked: RoyMech's ISO 4014/4017 table and the AskMachinist ISO 4017 chart, which agree. The product is fully threaded in the standard. This milestone draws a plain shank of the major diameter, the same as the socket screw, and says so in the guide.

| Nominal | s | k |
|---|---:|---:|
| M3 | 5.5 | 2.0 |
| M4 | 7 | 2.8 |
| M5 | 8 | 3.5 |
| M6 | 10 | 4.0 |
| M8 | 13 | 5.3 |
| M10 | 16 | 6.4 |
| M12 | 18 | 7.5 |
| M16 | 24 | 10.0 |
| M20 | 30 | 12.5 |
| M24 | 36 | 15.0 |

Parameters: nominal, default `M6`. Length under the head, default 20, range 0 to 200, step 0.5. Height override as on the socket screw, default 0.

Geometry: hex prism of across-flats `s` and height `k`, base on `z = 0`, one flat facing −Y. Shank fused at `(0, 0, −L)` with radius `nominal/2` and height `L`. The box is the hex's box in X and Y (section 3) and `z` from `−L` to `k`. The shank is narrower than the hex on every row above.

Default M6 × 20: `x = ±10/√3`, `y = ±5`, `z` from −20 to 4.

### 4.4 Washer

ISO 7089:2000 normal series, product grade A, the nominal hole `d1`, nominal outside `d2` and nominal thickness `h` from Table 1 of the ISO text (the iteh preview of that table). The hole is `d1`, not a running fit and not `2 * nominal + 1`.

| Nominal | d1 | d2 | h |
|---|---:|---:|---:|
| M3 | 3.2 | 7 | 0.5 |
| M4 | 4.3 | 9 | 0.8 |
| M5 | 5.3 | 10 | 1 |
| M6 | 6.4 | 12 | 1.6 |
| M8 | 8.4 | 16 | 1.6 |
| M10 | 10.5 | 20 | 2 |
| M12 | 13 | 24 | 2.5 |
| M16 | 17 | 30 | 3 |
| M20 | 21 | 37 | 3 |
| M24 | 25 | 44 | 4 |

Parameters: nominal, default `M6`. Allowance added to `d1`, default 0, range 0 to 1. Thickness override, default 0 (the table).

Geometry: one tube, outer radius `d2/2`, inner radius `(d1 + allowance)/2`, height `h`. The inner radius must stay below the outer radius; a larger allowance is refused. Default M6 box: `x` and `y` `±6`, `z` from 0 to 1.6.

### 4.5 Spacer

No standard. A round standoff.

Parameters: outside diameter, default 10, range 3 to 80. Length, default 12, range 1 to 200. Hole diameter, default 4.2, range 0 to 79. Hollow, default on.

Geometry: a tube when hollow is on and the hole is at least 0.4 mm smaller than the outside diameter. Otherwise a solid cylinder of the outside diameter. One solid. A second hole through a tube that already has that hole is not cut.

Default box: `x` and `y` `±5`, `z` from 0 to 12.

### 4.6 Shaft

A plain cylinder at the printed diameter `lime_recipe::horology::shaft` already computes (ISO 286 hole-basis fits: running H9/d9, sliding H7/h6, press H7/p6). The kernel calls that function. It does not keep a second copy of the clearance table. Outside 0 to 30 mm the function returns nothing and the part is refused with the crate's limit.

Parameters: nominal diameter, default 8, range 2 to 30, step 0.1. Length, default 40, range 5 to 300. Fit, default sliding. Allowance, how much the printer makes a shaft oversize, default 0.1, range 0 to 0.5.

The default asks `shaft(8, Sliding, 0.1)`. The test's expected diameter is that return value, and the box is ±half of it in X and Y, length 40 in Z.

### 4.7 Shaft collar

Parametric. Decided 2026-11-20: no DIN 705 table. The study fixture's set-screw hole started inside the wall and ran the whole outside diameter, so it exited the far side, and its slit occupied one quadrant.

Parameters: bore, default 8, range 3 to 25. Outside diameter, default 14, range 6 to 40, and at least 2 mm above the bore. Width, default 6, range 3 to 15. Set-screw diameter, default 3, range 2 to 6, and small enough to sit in the width.

Geometry: tube, outer radius `od/2`, inner radius `bore/2`, height `width`. Set-screw hole from the outer surface `(0, od/2, width/2)` along −Y, depth `(od − bore)/2 + OVERSHOOT_MM`, so it breaks into the bore and stops there. Slit: one box, 0.6 mm in X, from just inside the bore to just past the outside radius, full width plus the overshoot, centred on +Y. The box of the solid stays `±od/2` and `z` from 0 to `width`.

### 4.8 Plate

No standard. A rectangular plate and a hole pattern.

Parameters: width, default 80, range 30 to 250. Depth, default 60, range 20 to 200. Thickness, default 4, range 2 to 15. Hole count, default 4, range 0 to 12. Pitch-circle diameter, default 0, range 0 to 200. Zero lays the holes on the rectangle inset 8 mm from the edges, up to the count. A positive pitch circle lays them equally around that circle. A hole centre that falls off the plate, or a hole that breaks an edge, is refused.

Holes are sized by the screw, decided 2026-11-20. **Hole for** is a choice: M3, M4, M5, M6, M8, M10, M12, M16, M20, M24, or Free diameter. Default M4. A screw choice drills the ISO 273 medium clearance below, plus a printer allowance. Allowance default 0.2 mm, range 0 to 1. Free diameter shows a number field, range 2 to 30 mm, step 0.1. Switching to Free leaves the number at the diameter the screw choice was using, so the M4 default opens that field at 4.7 mm. The old 4.2 mm default is not used: it is tight for an M4 screw before a printed hole shrinks.

ISO 273 medium series (DIN EN 20273, mittel), the clearance a screw passes through. Checked 2026-11-20 against three published tables that agree on every row: Mech Codex, "Metric Clearance Hole Sizes (ISO 273)", updated October 2026 (https://mechcodex.com/reference/metric-clearance-hole-sizes); the DIN EN 20273 mittel column (https://cad-markt.de/index.php/cad-tutuorials/normen/364-20273-din-iso-20273-durchgangsl); and, through M20, pickedshares' DIN EN 20273 middle column (https://pickedshares.com/en/characteristics-of-a-bolted-connection-acc-din-en-iso-4014/). M14, M18 and M22 are in those tables and are not in this choice.

| Screw | Medium clearance |
|---|---:|
| M3 | 3.4 |
| M4 | 4.5 |
| M5 | 5.5 |
| M6 | 6.6 |
| M8 | 9 |
| M10 | 11 |
| M12 | 13.5 |
| M16 | 17.5 |
| M20 | 22 |
| M24 | 26 |

The drilled diameter is that clearance plus the allowance. Default M4 with 0.2 mm allowance is 4.7 mm.

Geometry: one box, centred on X and Y, standing on `z = 0`. Through holes along −Z from the top face. Default box: `x ±40`, `y ±30`, `z` 0 to 4.

### 4.9 L-bracket

No standard. Two legs of equal length at a right angle, with holes.

Parameters: leg length, default 40, range 15 to 120. Width, default 30, range 10 to 80. Thickness, default 3, range 1.5 to 10, and less than the leg. Holes per leg, default 2, range 0 to 4. **Hole for** is the same control as the plate (section 4.8): M3 to M24 from the ISO 273 medium table, or Free diameter, plus the same allowance (default 0.2 mm, range 0 to 1). Default M4, so each hole is 4.7 mm.

Geometry:

- Base: box `leg × width × thickness`, centred on X and Y, on `z = 0`. It occupies `x` from `−leg/2` to `leg/2` and `y` from `−width/2` to `width/2`.
- Upright: box `thickness × width × leg`, minimum corner at `(leg/2 − thickness, −width/2, 0)`, fused. It shares the base's Y span and rises to `z = leg` at the +X end. A box whose corner is the origin and whose Y size is the full width sticks out past the base; that is not this part.
- Holes in the base: through −Z, on `y = 0`, at `x` spaced along the base and clear of the upright.
- Holes in the upright: through −X from the outer face `x = leg/2`, on `y = 0`, at `z` spaced from above the base to below the top.

Default box: `x ±20`, `y ±15`, `z` 0 to 40.

### 4.10 Heat-set boss

Ruthex RX metric inserts. There is no ISO table for these. The study fixture sized the hole with `Fit::Press` on the thread nominal, which is the screw size and not the insert's outside diameter, and fused a cone that sat inside the boss cylinder, so the taper added no surface.

Source: Ruthex Produktdatenblatt "RX-Reihe – Metrisches ISO-Gewinde", status 14.12.2023, fetched 2026-11-20 from https://asset.conrad.com/media10/add/160267/c1/-/de/003398929DS00/tehnicni-podatki-3398929-ruthex-navojni-vlozek-primerno-za-3d-tiskalnik-pla-zdruzljive-naprave-rx-m5sx58-ge-m5sx58-001.pdf. The drawing on that sheet labels `d1` on the knurled outside, `d2` on the lead-in, `d3` on the blind or through hole ("Sack- oder Durchgangsloch"), `L` as the length, and `W` min as the minimum wall. An older copy of the same sheet, status 15.08.2022 (https://www.igo3d.com/mediafiles/Sonstiges/Ruthex/ruthex_Datenblatt_RX-Serie.pdf), prints the short M5 as `RX-M5Sx9,5` while its length column is 5.8 and its order number is `GE-M5Sx58-001`. The 14.12.2023 sheet names that row `RX-M5Sx5,8`. This plan uses the 2023 name. The sheet's UNC page is not in the picker. M10 and above are not on the sheet, so they are not in the choice.

Where the sheet draws one `W` and one `d3` across a pair, both articles in the pair take that cell. That is M4 (`W` 2.1, `d3` 5.6) and M5 (`W` 2.6, `d3` 6.4).

| Article | Thread | Outside d1 | Lead-in d2 | Length L | Wall W min | Hole d3 |
|---|---|---:|---:|---:|---:|---:|
| RX-M2x4 | M2 | 3.6 | 3.1 | 4.0 | 1.3 | 3.2 |
| RX-M2,5x5,7 | M2.5 | 4.6 | 3.9 | 5.7 | 1.6 | 4.0 |
| RX-M3Sx4,0 | M3 | 4.6 | 3.9 | 4.0 | 1.6 | 4.0 |
| RX-M3x5x4 | M3 | 5.0 | 4.25 | 4.0 | 1.3 | 4.4 |
| RX-M3x5,7 | M3 | 4.6 | 3.9 | 5.7 | 1.6 | 4.0 |
| RX-M4Sx4,0 | M4 | 6.3 | 5.5 | 4.0 | 2.1 | 5.6 |
| RX-M4x8,1 | M4 | 6.3 | 5.5 | 8.1 | 2.1 | 5.6 |
| RX-M5Sx5,8 | M5 | 7.1 | 6.3 | 5.8 | 2.6 | 6.4 |
| RX-M5x9,5 | M5 | 7.1 | 6.3 | 9.5 | 2.6 | 6.4 |
| RX-M6x12,7 | M6 | 8.7 | 7.9 | 12.7 | 3.3 | 8.0 |
| RX-M8x12,7 | M8 | 10.1 | 9.5 | 12.7 | 4.5 | 9.6 |

The choice is the article, not the thread size. One thread has more than one outside diameter (M3 is 4.6 mm on `RX-M3x5,7` and 5.0 mm on `RX-M3x5x4`). Default article `RX-M3x5,7`, the M3 in the assortment box `GE-KASTEN-001` on the same sheet.

Parameters: article, as above. Boss outside diameter, default `d1 + 2 * W` (the sheet's minimum wall placed outside the knurl; a larger boss is allowed, a smaller one is refused). Height, default `L`, range from `L` to 40. Taper, the reduction of the top diameter, default 0, range 0 to 2. Allowance added to `d3`, default 0, range 0 to 1. The published `d3` is already Ruthex's installation hole, so the allowance stays 0 until the person sets it. It is not the plate's 0.2 mm.

Geometry: one cone, base radius `bossOd/2`, top radius `(bossOd − taper)/2`, height as given. With the default taper of 0 that cone is a cylinder. Through hole on the axis, diameter `d3 + allowance`. The sheet allows a blind hole or a through hole; this milestone drills through, so the depth is the boss height and no second depth is invented. Default `RX-M3x5,7` box: `x` and `y` `±3.9` (outside diameter 4.6 + 2 × 1.6 = 7.8), `z` from 0 to 5.7, hole 4.0 mm.

## 5. Wave 2

### 5.1 GT2 pulley

2 mm pitch only. Pitch is not a parameter, and there is no 2-to-3 mm range.

Pitch diameter `PD = teeth * 2 / π`. Outside diameter `OD = PD − 0.508`. The 0.508 mm is twice the 0.254 mm pitch-line differential. The review's "about 0.51 mm" is this figure. Sources checked: Misumi's 2GT table as collated against `OD = PD − 0.508` (the xemstudio 2GT sheet, which also cites SDP-SI) and the orinovate GT2 generator. Both give 20 teeth as PD 12.73 mm and OD 12.22 mm.

Parameters: teeth, default 20, range 10 to 60, whole. Belt width, default 6, range 4 to 15. Bore, default 5, range 3 to 20, and at least 1 mm of material inside the root.

Geometry:

- Body: cylinder, radius `OD/2`, height = belt width, base on `z = 0`.
- One groove per tooth. The cut is a box placed by its centre at angle `360° * i / teeth`, radius `OD/2 − depth/2`, `z = width/2`, turned `[0, 0, angle]` so the box's X axis is radial. Radial size `depth + OVERSHOOT_MM` (the extra breaks the outside surface). Tangential size is the groove width below. Axial size `width + 2 * OVERSHOOT_MM`, so the groove crosses the full width and breaks both side faces.
- Bore: through hole, diameter as given.

The groove cross-section in this milestone is a rectangle, depth 0.75 mm and width 1.41 mm. Those two numbers are the orinovate generator's published approximation (it describes the real groove as arcs, about 0.75 mm deep and about 1.41 mm wide at the OD, and it says the shape is not a Gates drawing). Gates does not publish the pulley groove. The part's label and the guide say "approximate GT2 groove". Decided 2026-11-20: this rectangle ships. A later milestone may replace it with the arc profile once the points are copied from a named drawing into the kernel.

Flanges are not in this milestone.

Default 20-tooth box: `x` and `y` `±(PD − 0.508)/2`, `z` 0 to 6. The test checks that box, and the tooth tests in section 9. Volume is below the plain cylinder of diameter `OD` and above the plain cylinder of diameter `OD − 2 * 0.75`.

### 5.2 V-belt pulley

The study cited ISO 5291. ISO 5291:2011 is grooved pulleys for joined classical V-belts, sections AJ, BJ, CJ and DJ. A single classical or narrow belt uses ISO 4183:2026 (sections Y, Z, A, B, C, D, E and SPZ, SPA, SPB, SPC, datum width).

This part is not built until this section holds the ISO 4183 rows the picker offers: section, datum width, groove angle by datum diameter, and the outside diameter relative to the datum. No groove width is invented here to fill the gap.

The geometry, once that table is in, is one revolve about Z. The profile plane is `turn: [90, 0, 0]` (the plane used by the revolve box in `mcp/anchors.test.ts`: profile `[radius, z]`, axis along Z). The profile is the hub, the rim, and one trapezoidal groove of the table's angle and depth. It is not a cone subtracted on the axis.

Parameters beside the table: section choice, datum diameter, bore, number of grooves (default 1).

## 6. The Add dialog, History, and MCP

Decided 2026-11-20: the picker (`PRIMITIVES` in `src/model-primitive.ts`, drawn by `src/app/model/markup.ts`) gains one button after Gear, **Part**. One kind select, grouped the way a menu groups its entries:

| Group | Kinds |
|---|---|
| Fasteners | Hex nut, Socket screw, Hex screw, Washer |
| Fittings | Spacer, Shaft, Collar, Heat-set boss |
| Brackets | Plate, L-bracket |
| Pulleys | GT2 pulley, V pulley |

The fields under the select change with the kind, as the gear card's fields change with external, ring and rack. V pulley is in the list and is refused with the section 5.2 sentence until that table is in this file.

**One primitive.** The kernel primitive is `part`, with a `kind`. The groups are labels on the select, not four primitives. One `Solid` variant stores every kind, the way `Primitive::Gear` stores external, ring and rack. Splitting the families into four primitives would repeat the origin, the turn and the boolean path for a difference the select already shows.

Kind ids and History labels:

| Kind | Label |
|---|---|
| `nut` | Nut |
| `socket` | Socket screw |
| `hex` | Hex screw |
| `washer` | Washer |
| `spacer` | Spacer |
| `shaft` | Shaft |
| `collar` | Collar |
| `heat-set` | Heat-set boss |
| `plate` | Plate |
| `bracket` | L-bracket |
| `gt2` | GT2 pulley |
| `v` | V pulley |

Fields follow the gear card: the choice and the sizes a person always sets are visible; an override that defaults to "table" sits under More. Scrub steps match the parameter steps above. Changing the nominal, the article or **Hole for** rewrites the table-driven fields that are still on "table". A field the person has typed a number into keeps that number. The heat-set card's article select lists the eleven rows in section 4.10. The plate and the bracket show **Hole for**, the allowance, and the free-diameter field only when the choice is Free.

Editing the History step reopens the same card (`model_edit`), one rebuild, one undo. Save and reopen round-trips the `Solid` fields.

As a boolean tool the same primitive takes `origin` or `centre` and `turn`, and fuse, cut or common. A nut fused onto a plate is one step on the plate.

MCP, no new tool:

- `solid_new {primitive:"part", kind:"nut", nominal:"M6"}`, and the same `primitive` for every kind above. A heat-set is `kind:"heat-set"` with `article:"RX-M3x5,7"`. A plate is `kind:"plate"` with `holeFor:"M4"`.
- A boolean op carries the same `primitive`, `kind` and fields.
- The sentences in section 4 and 5 are the refusals (`gear.rs` is the pattern: one sentence, the limit it names).
- The size tables are in `guide`, not in the default tool list. The guide's GT2 entry says "approximate GT2 groove", the same words as the card.

The ghost is the analytic box of section 3, plus a hex outline for a nut or a hex head and a circle for a round part. It does not ask the engine. Groove and hole detail can be a coarser ghost: the box and the outer profile must match; the ghost may omit the socket.

## 7. Later parts

Each of these gets its own milestone only after the gap named here is filled in this file. None of them is ported from the study fixture as it stands.

| Part | Waiting on |
|---|---|
| Modelled thread | Section 8. The kernel has no helix. `primitive: "helix"` is an unknown variant. |
| Parallel key | The study cited ISO 8734. That standard is hardened parallel pins (dowel pins). A key is ISO 2491 / DIN 6885-1. The section (`b` × `h` by shaft diameter) is copied from that standard into this file first. The solid is a box centred on X and Y, so the box is `±b/2`, `±h/2`, length in Z. The study fixture's box ran from the origin to `(b, h, L)`, which is not a centred cuboid. Its shaft steps also skip the 2×2 and 4×4 rows of the usual table. |
| Flat pulley | A crowned rim is a revolve (section 5.2's plane) whose radius at mid-face is the edge radius plus the crown. The study fixture subtracted a smaller cylinder through the whole width, which hollows the disc. |
| Bearing housing | `horology::bearing` already holds the ISO 15 sizes the study listed (608, 625, 626, MR63, MR85). The seat is a counterbore of depth equal to the bearing width. The shaft hole is the bearing bore and is cut through the shoulder that the counterbore leaves. A second through-hole of the bore, drilled inside a through-hole of the seat, cuts no material. |
| 2020 T-nut | A published slot drawing: opening, channel width, lip thickness. The study fixture's 20 mm square is the extrusion, not the nut, and its neck cut and hex pocket are not centred in the block. |
| Cable clip, snap-fit, knob, disk cam | No ISO. They can be parametric parts once their geometry is specified here. The study fixtures do not yet specify them: the clip's "jaws" are a slot through a 3 mm plate; the knob's flats are axis-aligned boxes; the cam lobe's box is not centred on the rise. |

Out of scope until a kernel outline exists: compression and torsion springs, worm and worm wheel, bevel and helical gears, a printable ball bearing, a wave washer. Rack, ring and spur stay the gear primitive.

## 8. Modelled thread

A later milestone, after wave 1. The nut and both screws gain bore kind `thread` beside `tap`.

The profile is the ISO 68-1 basic metric form: 60° flank angle, fundamental triangle height `H = (√3/2) * pitch`, crest truncated by `H/8`, root truncated by `H/4`. Pitch is the coarse pitch in the nut table. The helix is a new kernel path (a sweep of that profile along the shank or through the nut). Until it exists, `thread` is refused with "A modelled thread is not available yet. Use tap drill." The tap-drill solid stays the default, so wave 1 does not wait on this.

A cosmetic thread (a groove that is not the ISO 68-1 form) is not a substitute. Either the profile above is cut, or the part says it has a plain tap-drill hole.

## 9. Tests

Measured against the analytic solid, at the default and at two other nominals (M3 and M12 on every fastener table; 16 and 36 teeth on the GT2 pulley). The part's own metrics are not the oracle.

**Kernel** (`cargo test -p lime-model-occt`, which the Rust tests job and the Windows Open CASCADE job already run with `LIME_REQUIRE_OCCT=1`):

- Bounds within 0.02 mm of the analytic box. That tolerance is for the kernel's box against exact cylinders and planar hexes, not for a mesh.
- Volume within 0.5 mm³ of the closed-form volume in sections 4 and 5, where one is given.
- `model_check` equivalent in the kernel: the solid is closed, 0 open edges, 0 non-manifold edges.
- The socket test places a point at `(0, 0, k − t/2)` outside the material, and a point at `(0, 0, k + 1)` outside the solid's box. A socket that starts at `z = k` fails the first point.
- The GT2 test places, for a tooth that is not on an axis (tooth 1 of 20, at 18°), a point at radius `OD/2 − 0.2` on that angle, at `z = width/2` and at `z = 0.2`, outside the material, and a point 12° off that angle at the same radius inside the material. Axis-aligned cuts fail the off-axis tooth. A groove that covers only the middle half of the width fails the `z = 0.2` point.
- Refusals: unknown nominal, washer allowance that eats the wall, shaft nominal 40 mm, a heat-set boss smaller than `d1 + 2 * W`, V-pulley and `thread` while their sections say they are absent. The default heat-set hole is `d3` of `RX-M3x5,7` (4.0 mm) and its outside diameter is 7.8 mm.

**MCP**, in the existing job "MCP server against real Open CASCADE" (`rust-mcp-occt`). No new job, and the job keeps its name. `solid_new` of each wave's default, then `model_describe` bounds against the same analytic box (0.02 mm) and `model_check` with `edges` `{open: 0, nonManifold: 0}`. One boolean: a washer cut by a nut's prism, or a plate fused with a spacer, still closed.

**Window.** One Playwright spec per family (`e2e/model-fastener.spec.ts`, and the fitting, bracket and pulley specs as those milestones land), added to `test:smoke`. Headless Chromium. Create the default, scrub the nominal, read the History step, save and reopen, and use the part as a boolean tool. Unit tests of the ghost's box go in `src/model-primitive.test.ts` and `tools/unit-tests.txt`.

**Study fixtures.** `mcp/recipe-mech-study.test.ts` is not the test of these parts. It is not extended to stand in for the kernel tests. When a native part has landed, the matching fixture can be deleted in that PR or left on the study branch. It is not promoted into the plugin library.

## 10. Milestones

Each one is a PR to `main`, after 6.13.0, and each updates this file where the code decides otherwise. None of them renames a CI job or adds one.

1. **Fasteners.** Section 4.1 to 4.4. Kernel, ghost, card, MCP in the Open CASCADE job, `e2e/model-fastener.spec.ts`.
2. **Fittings.** Section 4.5 to 4.7 and the heat-set boss (4.10). The Ruthex table is in this file, so the boss ships here.
3. **Brackets.** Section 4.8 and 4.9, including **Hole for** and the ISO 273 medium table.
4. **GT2 pulley.** Section 5.1, including the off-axis and full-width point tests, with the card and the guide saying "approximate GT2 groove".
5. **V-belt pulley.** Blocked on the ISO 4183 table in section 5.2.
6. **Thread.** Section 8. Adds `thread` beside `tap` on the nut and both screws.

## 11. Decided 2026-11-20

1. **Picker.** One Part button after Gear. One kind select, grouped Fasteners, Fittings, Brackets, Pulleys. One kernel primitive `part` with a `kind` (section 6). History labels stay per kind.
2. **Heat-set.** Ruthex RX, the 14.12.2023 Produktdatenblatt copied into section 4.10. The boss is in milestone 2.
3. **GT2.** The 0.75 mm by 1.41 mm rectangle ships, labelled "approximate GT2 groove" on the card and in the guide.
4. **Shaft collar.** Stays parametric. No DIN 705 table.
5. **Plate and L-bracket holes.** Sized by screw: **Hole for** is M3–M24 or Free diameter. A screw choice uses the ISO 273 medium clearance in section 4.8, plus a printer allowance (default 0.2 mm, range 0 to 1). Default M4, which drills 4.7 mm.
