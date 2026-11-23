# Haptic height frames (experimental)

This is a phase-1 experiment. The command and the file format can change. Lime Slice only compiles the table. The pin rig's firmware owns the real-time loop. There is no MPEG-Haptics payload (ISO/IEC 23090-31) and no stiffness channel. Slicing is unchanged.

```bash
lime-slice haptic samples/lime_hull.stl --pitch 1 --travel 28 -o hull.png
lime-slice haptic samples/lime_hull.stl --pitch 0.5 --travel 28 --extent auto --base min -o hull.csv
```

The mesh is read by the slicer's loader (`STL`, `3MF`, or `STEP`) and kept in the file's own coordinates. It is not dropped onto the bed. `STEP` still uses the Open CASCADE bridge when that bridge is installed, and the built-in tessellator otherwise.

## Grid

`--pitch` is the pin spacing in millimetres. The grid covers `--extent`:

- `auto` (the default) is the mesh XY bounding box.
- `x0,y0,x1,y1` is an explicit rectangle, in millimetres.

Pin `(col, row)` is at the centre of its cell:

```text
x = x0 + (col + 0.5) * pitch
y = y0 + (row + 0.5) * pitch
```

Column 0 is minimum X. Row 0 is minimum Y. An extent that is an exact multiple of the pitch gets that many pins. A remainder under 0.0001 mm does not add another pin; anything thicker does. The grid stops at 100000 pins on one axis and 2000000 pins in total.

## Height

Each pin casts one vertical ray and keeps the highest Z on the mesh. Vertical faces have no area, so they do not register.

`--base` chooses the plane that height is measured from:

- `min` (the default) is the mesh minimum Z. Height is how far the top surface sits above the bottom of the part.
- `top` is one stroke below the mesh maximum Z (`maxZ - travel`). The highest point maps to full travel, and anything more than one stroke below the top maps to 0.

Height is `hitZ - base`, clipped to `[0, travel]`. A ray that misses the mesh is height 0 and a set bit in the no-hit mask. A true height of 0 and a miss look the same in the numbers. The mask is what tells them apart.

Rows are sampled in parallel. Each pin is independent, so the table does not depend on how many threads ran.

## Files

`-o` selects the file by its extension.

### CSV

A `.csv` is one row of text per grid row, row 0 first, columns separated by commas. Values are millimetres with three decimal places. The lines above the numbers are comments:

```text
# lime-haptic height frame (experimental)
# format: lime-haptic-height-1
# pitch_mm: 1.000
# travel_mm: 28.000
# origin_mm: -30.000,-12.000
# extent_mm: -30.000,-12.000,30.000,12.000
# base: min
# base_z_mm: 0.000
# cols: 60
# rows: 24
# units: mm
# row_0: min_y
# no_hit_count: 12
# no_hit_mask: <base64>
```

`origin_mm` is the minimum corner of the extent, not the first pin. `no_hit_mask` is the same packing as the PNG sidecar.

### PNG and sidecar

A `.png` is 16-bit grayscale, one pixel per pin. Sample 0 is 0 mm and sample 65535 is `travel`. The integer is `round(height / travel * 65535)`, held to that range. The file is a top view: image row 0 is grid row `rows - 1` (maximum Y), so +X points right and +Y points up.

`<name>.json` is written beside the PNG (`hull.png` writes `hull.json`). It is `lime-haptic-height-1`:

| Field | Meaning |
|---|---|
| `format` | `lime-haptic-height-1` |
| `experimental` | `true` |
| `pitchMm`, `travelMm` | Pitch and stroke, millimetres |
| `originMm` | `[x0, y0]`, the minimum corner |
| `extentMm` | `[x0, y0, x1, y1]` |
| `base` | `min` or `top` |
| `baseZMm` | The plane used in `hitZ - base` |
| `cols`, `rows` | Pin counts |
| `units` | `mm` |
| `row0` | `minY`. Mask bit 0 is this row, column 0 |
| `pngRow0` | `maxY`. The picture is flipped relative to the mask |
| `noHitCount` | How many pins the ray missed |
| `noHitMask` | Base64 of the mask |

The mask is row-major, row 0 (minimum Y) first, column 0 first. Bit 7 of byte 0 is pin `(0, 0)`. A 1 is a miss. Unused bits in the last byte are 0.

## What this is not

The firmware still decides timing, pin dynamics, and how a miss is held. A later phase would be the place for a stiffness channel or an MPEG-Haptics track. This command does not change a slice, a support, or a G-code file.
