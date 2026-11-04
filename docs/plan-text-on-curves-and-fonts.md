# Plan: text on curved surfaces, and more than one font

Status: plan, for review. Written 2026-11-04 against `main` at v5.1.0 (`3568d130`). Nothing here is built yet.
Companions: `docs/step-modeler.md` (Features, the group node, face picks), `docs/plan-sketch-for-people.md` (the
card style, Show me demos, reasons in the person's words), `docs/plan-recipe-plugins.md` and
`docs/plan-recipe-ingredients.md` (the recipe API and `geom2d`).

The owner, on 2026-11-04: "I need to be able to put text on curved surfaces too. And have more than 1 font."

## 1. Goal

A person can put lettering on any face of a part, flat or curved, in a font they choose, and get a part that prints:

- **Curved faces too.** A cylinder, a cone, a sphere or torus patch, and a freeform (B-spline) face, as well as a
  flat face. The letters follow the surface and stand a constant depth off it, measured square to the surface.
- **More than one font.** A few good bundled fonts with their licences, the current single-stroke font kept for
  engraving-style lettering, and the person's own TrueType or OpenType files, saved with the project so it opens
  the same on another computer.
- **Real typography where it matters for parts:** size, bold and italic (or a weight for a variable font), letter
  spacing, line spacing, left, centre or right, several lines.
- **Prints.** Strokes too thin for the nozzle are shown before Apply, nothing leaves a sliver, and the result is one
  valid, closed solid.
- **One step.** A text edit is one history step that builds in well under a second for a typical label, not one
  boolean per stroke as today.

### Non-goals

- No complex shaping: no ligatures, no right-to-left, no Indic or Arabic joining. Latin, Greek and Cyrillic letters,
  digits and symbols that a font maps one character to one glyph. (Section 9, D6.)
- No text spanning several faces in the first milestones (across a fillet onto the next face). Section 6 says what
  happens instead.
- No colour or multi-material text. A raised or engraved letter is geometry; painting it is the slicer's job.
- No change to the split-to-print part numbers and the fit coupon labels: they keep the stroke font as built.
- Old projects rebuild byte for byte as before (section 5.4).

### Words used here

| Word | Meaning |
|---|---|
| outline font | A font whose letters are closed shapes (TrueType `glyf`, OpenType `CFF`): what nearly every font file is. |
| stroke font | A font whose letters are lines with a pen width: today's 4 × 6 grid font, or a Hershey font. |
| wrap | Lay the text along the surface keeping true lengths, as a label wraps round a bottle. |
| project | Lay the text flat in front of the face and push it onto the surface along one direction, like a slide projector. |
| direct build | Building raised or engraved letters by sewing new faces into the part, with no boolean (section 4.3). |

## 2. Where things stand

Checked on `main` at `3568d130`:

- **The font.** `src/modeling/text.ts` draws A–Z, 0–9 and `- + . , : ! ? / ' &` as polylines on a 4 × 6 grid.
  Lowercase reads as capitals. There is one font and no way to add another.
- **How text is built.** `text` is a composite (`src/modeling/compose.ts`, `textPieces`): every stroke segment
  becomes a box primitive, raised or cut, each its own boolean step, folded into one group node with
  `source.kind: "text"` so Edit reopens the tool. "LIME SLICE 2026" is 69 boxes, so 69 booleans, each probed
(the spike's "Lime Slice gAO8 2026" would be 106). A composite
  stops at 400 steps (`MAX_PIECES`) and a group at 60 s.
- **Only flat faces.** `faceFrame` reads a flat face's plane; the Features card says "Pick one flat face."
- **The card.** Text, Height (capitals), Stroke, Spacing, Angle, Align (centre, start), Raise or Engrave, Depth, and
  a position dot on the face (`src/app/markup.ts`, `src/model-features.ts`).
- **MCP.** `text {text, height, depth, face, at, from, op, strokeWidth, spacing, align, angleDeg}`, `text` up to
  80 characters, described as "A-Z, 0-9, space, -+.,:!?/'&." (`mcp/schema.ts`).
- **Other users of the stroke font.** Split-to-print part numbers (`src/modeling/partition.ts`, and
  `engrave_numbers` in `cpp/kernel.cpp`) and the fit coupon labels (`src/modeling/fit-coupon.ts`).
- **Fonts in the app.** `public/fonts/` holds IBM Plex Sans and Mono and Inter (OFL, `OFL.txt`), as `.woff2` for
  the UI. None is used for modelling, and `.woff2` is Brotli-compressed, so a modelling font reader cannot use
  those files as they are.
- **The kernel cannot draw fonts.** Open CASCADE 7.9.2 here and in CI is built with `-DUSE_FREETYPE=OFF`
  (`tools/occt/install.py`; `lib/cmake/opencascade/OpenCASCADEConfig.cmake` says `OpenCASCADE_WITH_FREETYPE OFF`).
  `Font_BRepFont`, `Font_BRepTextBuilder` and `StdPrs_BRepFont` headers ship, and `TKService` is linked for STEP,
  but the library answers "FreeType library is unavailable". So outlines must come from our own reader, or from
  rebuilding Open CASCADE with FreeType on three platforms (section 9, D1).
- **Recipes.** `lime-recipe` is at API 1.2 (#561): a parameter can be a face the person picks, but only a flat one.
  There is no text call; a recipe that wants letters calls the `text` op as a raw model call.

## 3. What the spike proved

A scratch spike (not in the repo) read real font files with `ttf-parser` 0.25 in Rust, built glyph loops on Open
CASCADE 7.9.2 (the same build as `~/.lime-slice/occt-7.9.2`), and measured every case on synthetic parts: a
200 × 40 × 20 block, a cylinder R 20, a cone R 25 to R 15, a sphere R 30, a torus 30 / 10, and a wavy B-spline
face 120 × 60 on a block. Text "Lime Slice gAO8 2026" (20 characters, with holes in g, A, O, 8, e and lowercase g's
two counters), Arial, capitals 6 mm, 0.8 mm deep, raised and engraved. Windows 11, one machine.

### 3.1 Outline glyphs become clean loops

- Arial (TrueType quadratics), Georgia, Consolas, David CLM (OpenType CFF cubics) and Bahnschrift (a variable font)
  all read; layout of 20 characters takes 0.3 to 1.9 ms.
- Each glyph's contours become faces with holes by nesting depth (outer, hole, island in a hole). Quadratic and
  cubic pieces go to the kernel as Bézier curves, not polylines: Arial's 20 characters are 19 faces, 28 loops,
  335 curves.
- **Two traps found and fixed in the spike:**
  - A CFF font carries a few segments of under 2 µm. Kept, they gave 8 sliver faces and 8 edges under 0.01 mm
    (boolean build) or an invalid solid (direct build) on the B-spline face. Dropping segments under 2 µm fixes
    both: 0 small faces, 0 short edges, valid.
  - A variable font draws a letter from overlapping contours (Bahnschrift: 22 faces for 19 letters). Built as they
    are, both build methods give invalid solids. A 2D union of each glyph's contours first (with `lime-recipe`'s
    `geom2d`, the nonzero rule) gives 19 clean faces and valid solids on flat, cylinder and B-spline. The union
    works on polylines (0.1 mm steps), which makes 7 to 10 times more edges; see 3.4.
- **Weight on a variable font works**: Bahnschrift at weight 300 has 112 mm² of ink, at 700 it has 194 mm²
  (`wght` axis through `ttf-parser`).

### 3.2 Curved faces: the approach

Every face, flat or curved, is a surface S(u, v). The layout's 2D loops are mapped into S's (u, v) one glyph at a
time:

1. Walk the baseline from the anchor along the surface by arc length to the glyph's middle (0.05 mm steps).
2. Read the surface's stretch there (|∂S/∂u|, |∂S/∂v|) and map the glyph with that one scale, so the glyph keeps its
   true size on the surface. Lines stay lines and Béziers stay Béziers in (u, v): the map is exact per glyph.
3. Flip v when the face's normal points the other way, so the text reads from outside, not mirrored (checked in
   the renders).
4. Each glyph face lies on S. Its top (raised) or floor (engraved) is the same (u, v) loop on S offset by the depth
   (`Geom_OffsetSurface`), so the depth is constant square to the surface by construction.

Two ways to turn that into the part were measured:

- **Boolean build.** Each glyph face made solid normal to the surface (`BRepOffset_MakeSimpleOffset`, from 0.2 mm
  inside to the depth, so it overlaps), then one boolean with all glyphs as tools, run in parallel as the kernel
  runs its booleans.
- **Direct build.** No boolean and no intersecting at all. The face being lettered gets each glyph's outline as a
  hole, each counter (the inside of an O) becomes its own face on S, and each outline edge gets a wall: a ruled face
  from the edge on S to the same (u, v) curve on the offset surface. The top (or floor) is the loop on the offset
  surface. Everything is sewn into one closed solid. It needs the text wholly inside one face and away from the
  face's seam (section 6).

### 3.3 Numbers

20 characters, Arial, 6 mm, 0.8 mm deep. Every result: valid (`BRepCheck_Analyzer`), one solid, 0 edges not shared
by exactly two faces, 0 faces under 0.01 mm², and letter depth 0.800 mm at every sampled point of every top and
floor (25 points a face, distance to the original surface).

| Surface | Boolean build, parallel | Boolean, serial | Direct build | Volume raised / engraved (mm³) |
|---|---|---|---|---|
| Flat | 0.49 s / 0.37 s | 0.96 s | 0.15 s / 0.14 s | +122.75 / −122.75 |
| Cylinder R 20 | 0.57 s / 0.49 s | 1.9 s | 0.18 s / 0.18 s | +125.20 / −120.29 |
| Cone R 25 → 15 | 0.68 s / 0.62 s | | 0.18 s / 0.17 s | +125.73 / −120.97 |
| Sphere R 30 | 0.63 s / 0.58 s | | 0.28 s / 0.29 s | +125.81 / −119.28 |
| Torus 30 / 10 | 1.35 s / 1.29 s | | 0.19 s / 0.18 s | +129.07 / −117.09 |
| B-spline, wavy | 7.1 s / 7.1 s | 72 s | 0.32 s / 0.34 s | +122.76 / −122.64 |

(Boolean times are the boolean alone; building the glyph solids adds 0.1 to 0.3 s. Direct times are everything.)

- The flat volume is the ink area times the depth (153.4 mm² × 0.8 = 122.7 mm³). On a convex surface a raised
  letter is wider at its top and an engraved one narrower at its floor, which is why the cylinder gives +125.2 and
  −120.3: that is the geometry of a constant normal depth, not an error. Both builds give the same volumes to
  0.01 mm³.
- **Direct build is 3 to 22 times faster** than the boolean and never intersects surfaces, which is where the
  B-spline case spends its 7 s.
- More text, direct build: 54 characters at 2.5 mm, 47 glyph faces, 854 curves: 0.41 s flat, 0.90 s on the B-spline.
- Other fonts, direct build, 20 characters: Georgia (596 curves) 0.9 s cylinder, 0.6 s B-spline; Consolas 0.7 s
  cylinder; David CLM (CFF) 0.3 s cylinder and B-spline after the 2 µm clean-up.
- Variable font after the union (polylines): 1.2 s flat, 1.3 s cylinder, 2.1 s B-spline, all valid.
- STEP size of the result, 20 characters: direct 1.6 / 2.0 / 2.6 MB (flat, cylinder, B-spline) against 2.1 / 2.6 /
  3.4 MB from the boolean build.
- Renders (scratch): right-reading on the cylinder, sphere, torus and the wavy face, letters standing square to the
  surface.

### 3.4 What failed, and what that means

| Case | Result | Consequence for the plan |
|---|---|---|
| Overlapping contours (variable fonts) | Invalid solids, both builds | Union each glyph that overlaps itself before building (3.1). Only those glyphs: static fonts keep their curves. Refit the union's polylines to curves so edge counts stay low. |
| Text across a periodic surface's seam (torus at v = 0) | Direct build: sewing leaves two shells. Boolean build: fine (1.3 s, valid). | Move the seam away from the text where the surface allows it; otherwise use the boolean build for that step. |
| Text longer than the way round (143 mm on a 126 mm circumference) or off the face | Fails | Refuse before building, in one sentence (section 6). |
| Raised text on the sphere, display mesh | Long thin triangles in the sphere face's display mesh around many holes | Display only (the B-rep is valid); check the app's mesher settings on such faces in M2. |

### 3.5 Thin strokes

The spike also measured how much of each letter is narrower than a 0.4 mm line (a morphological opening with
`geom2d`'s rounded offset: shrink by 0.2 mm, grow back, compare):

| Font | 6 mm caps | 4 mm | 2.5 mm |
|---|---|---|---|
| Arial Regular | under 1 % | i 4 %, g 3 % | e, i, m, 2 gone entirely |
| Arial Bold | under 1 % | i 3 % | 3–7 % of e, i, m, l |
| Georgia (serif) | e 16 %, i 7 %, m 6 % | e 37 %, 2 23 %, m 17 % | e, m, 2 gone, i 82 % |
| Consolas | under 1 % | m 6 % | e, m, 2 gone, i 84 % |

So the bundled fonts should be even-stroke (sans, mono, slab), high-contrast serifs need a warning even at 6 mm,
and the card must say which letters will not print before Apply.

## 4. Design

### 4.1 Font sources

**Bundled fonts** (section 9, D2). Static TrueType files, each with its licence, in `public/fonts/model/` for the UI
and compiled into the modelling crate (`include_bytes!`) so the engine, the MCP server and the desktop app all have
the same bytes with no path to find. About 2 MB in all.

| Id | Font | Licence | Why |
|---|---|---|---|
| `stroke` | Today's 4 × 6 grid font | ours (MIT) | Engraving and CNC-like lettering, part numbers; the default for old ops. Gains lowercase only if D3 says so. |
| `hershey` | Hershey Simplex (single stroke, with lowercase) | Hershey fonts' permissive notice | Real single-stroke lettering with lowercase, for fine engraving and pen-like text. Built with a round pen width. |
| `sans` | Inter (Regular, Bold, Italic, Bold Italic, static) | OFL 1.1 | Clear sans, even strokes, prints small. Already the app's UI face. |
| `mono` | IBM Plex Mono (Regular, Bold) | OFL 1.1 | Serial numbers, codes, labels that line up. Already in the UI. |
| `slab` | IBM Plex Serif or a slab serif such as Roboto Slab (Regular, Bold) | OFL 1.1 / Apache 2.0 | A serif that still prints: no hairlines (3.5). |
| `stencil` | A stencil sans such as Big Shoulders Stencil | OFL 1.1 | Text cut **through** a wall without losing the middle of O, A, 8 (section 6). |

The files are versioned and never replaced in place: a new release of Inter is a new id (`sans@4.1`), so an old
project rebuilds with the bytes it was made with. The licence texts go to `third_party/fonts/` and the About
licences list.

**The person's fonts** (M4). Add font file… on the font picker opens a `.ttf`, `.otf` or `.ttc` (a collection: pick
the face). The file is read without running anything (it is data), checked (it parses, it has the glyphs typed, its
`OS/2 fsType` embedding bits), and added to the project's `fonts` map by its SHA-256, as a compressed record like a
`brep`. A copy goes to the person's font library (`~/.lime-slice/fonts/`), so it is in the picker for every project.
A font whose licence forbids embedding (fsType "restricted") is still usable, but the project keeps only the outlines
of the letters used, and the card says so in one sentence (D5).

**Reading fonts** (D1). `ttf-parser` (MIT or Apache 2.0, no dependencies, no unsafe code, reads TrueType, CFF, CFF2
and variable fonts) in `lime-model-occt`'s Rust side. Open CASCADE stays without FreeType.

**Layout.** Rust, beside the reader: characters to glyphs through the font's `cmap`, advances, kerning from the
`kern` table and GPOS pair kerning, letter spacing added, lines broken at newlines (no automatic wrapping), each line
aligned left, centre or right, lines `lineSpacing × size` apart. Size is the capital height in millimetres, as today
(`height`), read from the font's `OS/2` cap height. Bold and italic pick the family's file; a variable font takes a
`weight`; a family without italic gets a 12° slant, and one without bold is refused for Bold (D7). A character the
font lacks is refused by name, never drawn as a box.

**Stroke fonts** go through the same pipeline: each stroke polyline becomes an outline at the pen width with round
ends (`geom2d` offset), the letter's strokes are united, and from there it is an outline glyph. So a stroke font
also works on curved faces, and is one step, not one boolean per stroke.

### 4.2 Placement

- **Anchor.** A point picked on the face (the position dot, as today), stored as a model-space point with the face's
  normal there (`nearPoint`), and found again on the face at rebuild. On a flat face `at {u, v}` and `from` keep
  working.
- **Direction.** The way the baseline runs. On a flat face: the angle, as today. On a cylinder or cone: **Around**
  (the default: reads round the part, like a label) or **Along** (up the axis). On a sphere, torus or freeform face:
  along the face's U or V at the anchor, turned by the angle; the baseline is then walked straight on the surface
  (a geodesic: step along the tangent, project back), so the text does not follow a skewed parameter line.
- **Wrap or project** (curved faces only). Wrap is the default and keeps true letter sizes on the surface. Project
  lays the text out on a plane square to a direction (default: the anchor's normal) and pushes each point onto the
  surface along it, so the text looks undistorted from that direction and stretches on slopes. Both end as (u, v)
  loops on S, so the build is the same.
- **Flip.** Reads the other way round (for text inside a ring or a cup) and upside down.
- **Raise or engrave**, and the **depth**, measured square to the surface.

### 4.3 The kernel step

A new history node kind, `text`, built in one kernel call:

1. Rust lays out the loops (4.1) and maps them to the face's (u, v) (3.2).
2. C++ (`lime_tree_text` in `cpp/tree.cpp`) builds the **direct build** when the text lies inside one face, clear
   of its seam and its edges by a margin. Otherwise, when the face's surface extends past the face (any analytic
   surface), the **boolean build**. Otherwise it refuses.
3. The result is checked like every step (valid, closed, one solid, no part left behind), and its faces get
   provenance: the letter faces belong to the text step.

The step has the usual 60 s budget, and a text of up to 400 characters in one step.

### 4.4 Nozzle, overlaps and slivers

- **Too thin.** After layout, each glyph's outline is opened by half the line width (3.5). A letter that loses more
  than 10 % is red in the preview and named under the Apply button ("e, m and 2 are thinner than your 0.4 mm line.
  Use 3.2 mm or larger, or Bold."). It is a warning, not a refusal: engraving a sharp hairline can be on purpose.
  The line width is the active machine's nozzle.
- **Overlaps.** Letters that touch (tight spacing, a script font) are united in 2D before building, as overlapping
  contours are, so the build never sees two outlines crossing.
- **Slivers.** Segments under 2 µm are dropped (3.1). A loop smaller than the line width squared is left out and
  named.

### 4.5 Stored in history and rebuilt

The op as typed is the step:

```
{kind: "text", text, font, style?, weight?, height, depth, op, face, at | point, along?, angleDeg?,
 align?, spacing?, lineSpacing?, wrap?, flip?, strokeWidth?}
```

- `font` is a bundled id with its version (`sans@4.0`) or a project font's SHA-256 prefix. The bytes are found by
  hash: bundled fonts, the project's `fonts` map, then the font library. A missing font leaves the step built as it
  was saved (the B-rep is in the file) with a warning on the row ("The font ‘Avenir Next’ is not on this computer.
  Pick another to edit this step."), and Edit asks for a font first.
- A text step without `font` (every project saved before this) still expands into today's group of boxes, built
  exactly as before. Opening it in the card and pressing Update makes it a new `text` step.
- The `.lime` gains a `fonts` map of compressed records, written only when a project uses a person's font.

### 4.6 MCP (lean)

The existing `text` op grows instead of a new kind. New fields, each a short schema line, inside the budget that
`mcp/schema.test.ts` holds (the PR states the token change):

- `font` (enum of bundled ids, or a project font id), `style` (`regular`, `bold`, `italic`, `bold-italic`),
  `weight` (100–900, variable fonts), `lineSpacing`, `align` gains `right`, `along` (`around`, `axis`, `u`, `v`),
  `wrap` (`wrap`, `project`), `flip`, `point` (a model-space point on the face, the anchor on a curved face).
- `text` takes up to 400 characters with `\n` for new lines; its description stops listing the stroke font's
  letters and says "any letters the font has".
- `fontFile`: a path to a `.ttf` or `.otf`; the server reads it, adds it to the project, and the stored op names it
  by id.
- `guide {kind: "text"}` lists the bundled fonts with one line each, and the refusals.
- `model_probe` of a text op also returns `thin: [{char, lostPct}]` and `inkMm2`.

### 4.7 Recipes

API 1.3 (`lime_recipe::API`, kept equal to `RECIPE_API` by its unit test):

- `s.face(name).curved()`: a face parameter may be a curved face; `pick_face` returns its kind (plane, cylinder,
  cone, sphere, torus, freeform) and, for a cylinder or cone, its axis and radius.
- `model.text(&part, &face, "LOT 42", Text::new(6.0, 0.8).font("mono").around())`: the `text` op as a typed call.
- `geom2d::Region` from text: `model.text_outline("LIME", "sans", 10.0) -> Region`, answered by the host (the recipe
  crate has no dependencies and never reads fonts), so a recipe can extrude letters, cut a stencil, or test a fit.

### 4.8 The Model tab card

The Text card keeps its place under Features and its fields, and adds:

- **Font picker** at the top: each font's name drawn in that font (the UI loads the same files), a sample line of
  the person's own text under the list, "Stroke" first for old habits, then the bundled fonts, then the project's and
  the library's, then **Add font file…**.
- **Style**: Regular, Bold, Italic, Bold Italic as four toggles, greyed with a reason where the family lacks one;
  a **Weight** slider instead for a variable font.
- **Text** becomes a two-line box that grows: Enter is a new line, Ctrl+Enter applies.
- **Size** (capitals, mm), **Letter spacing** (mm, default 0 for outline fonts, height / 3 for Stroke as today),
  **Line spacing** (× size, default 1.3), **Align**: left, centre, right.
- On a curved face: **Around / Along** (cylinder, cone) or **U / V** and the angle, **Wrap / Project**, **Flip**.
- **Live preview**: the outlines are drawn on the face as you type (the engine answers a layout call in a few
  milliseconds with 3D polylines), too-thin letters in red; the probe's ghost follows as for other features.
- **Show me** in the How popover, as `plan-sketch-for-people.md` P2 does it: a demo Ø 30 cylinder beside the part
  with "Lime 42" in Sans Bold wrapped round it, ready for Apply; Apply builds it on the demo only, says "Done.
  Nothing was added to your part.", and Back returns everything as it was.
- The "Pick one flat face." reason becomes "Pick one face." for Text only (Pocket, Boss, Texture, Array and Ribs
  stay on flat faces).

### 4.9 Refusals, one sentence each

- "This font has no ‘ñ’. Pick another font, or take it out."
- "The text runs off this face. Move it, make it smaller, or put it on one face."
- "The text is longer than the way round this cylinder (126 mm). Make it smaller or use two lines."
- "Letters this deep would fold over inside this curve. Use a depth under 4.5 mm." (an engraving deeper than a convex
  radius, or a raised letter on a concave face deeper than its radius)
- "This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file."
- "‘Avenir Next’ has no bold. Pick Regular, or another font."
- "The font ‘Avenir Next’ is not on this computer. Pick another to edit this step."

## 5. Compatibility

### 5.1 Old projects

A text step saved before this has no `font`. It expands to boxes exactly as today, so every saved `.lime` rebuilds
with the same faces and volume (a unit test opens the fixtures that hold text groups and compares).

### 5.2 Other users of the stroke font

Split-to-print numbers and fit coupon labels keep calling `textStrokes`. Moving them to the new step is not part of
this plan.

### 5.3 The browser build

The browser build talks to the same engine, so it gets fonts and curved text too. Add font file… there reads the file
through the browser and sends its bytes; nothing is written to a font library.

### 5.4 Determinism

A rebuild uses the stored font bytes (by hash) and the same reader version, so a step rebuilds to the same solid.
Updating `ttf-parser` is a reviewed change with an A/B of the text fixtures.

## 6. Limits the person meets

- **One face at a time** (M1–M3). Text that would cross onto the next face is refused (4.9). Text over a fillet
  between two faces is a later plan.
- **Seams.** Text across a cylinder's, cone's or torus's seam moves the seam out of the way when the surface allows
  it, or builds with the boolean build (3.4); on a freeform face crossing its own edge it is refused.
- **Cut through.** Engraving deeper than the wall drops the middle of O, A, B, D, P, Q, R, 4, 6, 8, 9 as loose
  pieces; the step refuses that ("The middle of O would fall out. Use the Stencil font, or engrave less deep.").
- **Small text.** Below the size where the font's strokes reach the line width, the warning in 4.4 says so.

## 7. Risks

- **Sewing on hard faces.** The direct build sews hundreds of faces. Faces with tight tolerances from STEP files
  may not sew; the fallback is the boolean build, then a refusal. M2 runs it on the owner's housing and Telo parts,
  not only on primitives.
- **Speed on long text on freeform faces.** 0.9 s for 54 characters on the B-spline; the boolean build there took
  7 s for 20. A freeform face from a STEP file may be heavier. The step's 60 s budget stops it with a sentence.
- **Variable fonts cost more** (1.2–2.1 s for 20 characters with the polyline union). Refitting curves after the
  union is in M4's scope; until then, bundled fonts are static files.
- **Kerning without shaping.** Fonts that kern only through GPOS class pairs need that table read; a font that needs
  real shaping (ligature-only scripts) is out of scope (D6).
- **Font licences.** Bundled fonts are OFL or Apache; a person's font goes into their project under their licence,
  and restricted fonts keep only the outlines used (D5).
- **Distortion on doubly curved faces.** Each glyph keeps its size at its middle; on a sphere R 30 a 6 mm letter is
  slightly wider at the equator than at its top. Measured in M3 against a tolerance (letters within 2 % of size).
- **Display mesh around many holes** (3.4): check the mesher on a face with 30+ holes.
- **Schema budget.** The new fields cost tokens; the PR states the change.

## 8. What does not change

- The MCP's other tools and ops. `text` keeps every field it has, with the same meaning.
- The stroke font's look, and every split number and coupon label.
- Open CASCADE's build (no FreeType), unless D1 says otherwise.

## 9. Decisions

The owner answered on 2026-11-04: the plan's choice for every decision below, and each milestone is built by the cheapest subagent that can do it.

Each has the plan's choice; the plan goes ahead on it unless the owner says otherwise.

1. **D1. Who reads fonts.** (a) `ttf-parser` in Rust, a small dependency-free crate; (b) our own TrueType/CFF reader
   (about 1500 lines, CFF is the long part); (c) rebuild Open CASCADE with FreeType on Windows, macOS and Linux and use
   `Font_BRepFont`. **Plan: (a).** It reads every font the spike tried, including variable and CFF, with nothing to
   ship per platform; (c) adds a native library to every installer and still needs the union and the curved-face
   mapping.
2. **D2. Which fonts ship.** Stroke (kept), Hershey Simplex, Inter, IBM Plex Mono, a slab or Plex Serif, a stencil
   sans; about 2 MB. **Plan: those six.** Fewer is fine; more can come as a font pack later.
3. **D3. Lowercase for the stroke font.** (a) Keep it capitals only and add Hershey for lowercase single-stroke; (b)
   draw lowercase on the 4 × 6 grid. **Plan: (a).**
4. **D4. Default font for a new text step.** (a) Sans Bold; (b) Stroke as today. **Plan: (a)**: it prints at 3 mm
   with a 0.4 mm nozzle and reads as people expect; Stroke stays one click away.
5. **D5. Saving a person's font.** (a) The font file in the project (outlines only for restricted fonts); (b)
   only the outlines used, always; (c) nothing, the font must be installed. **Plan: (a).** The project opens and
   edits anywhere; restricted fonts are still respected.
6. **D6. Shaping.** (a) No shaping, kerning only; (b) add a shaping engine (`rustybuzz`) for ligatures and complex
   scripts. **Plan: (a).** Parts carry labels and numbers; shaping can come with a real need.
7. **D7. Missing bold or italic.** (a) Slant for a missing italic, refuse a missing bold; (b) fake both (bold by
   growing the outline); (c) refuse both. **Plan: (a).** A grown outline changes counters and spacing in ways that
   print badly at small sizes.
8. **D8. Too-thin strokes.** (a) Warn and allow; (b) refuse. **Plan: (a)**, with the letters named and red.
9. **D9. Direction default on a cylinder.** (a) Around; (b) along the axis. **Plan: (a).**
10. **D10. Cut-through engraving.** (a) Refuse when a letter's middle would fall out, pointing at Stencil; (b) allow
    and leave loose pieces. **Plan: (a).**

## 10. Milestones

Each is one PR to `main`, smallest useful first. Each updates `docs/step-modeler.md`, `docs/mcp-server.md` and
`guide {kind: "text"}` for what it adds, and adds an "As built" note here.

1. **Outline fonts on flat faces.** `ttf-parser` reading, layout (size, style, spacing, lines, align, kerning), the
   bundled static fonts with licences, the `text` kernel node with the direct build on flat faces (boolean build as
   fallback), the thin-stroke warning, `font`/`style`/`lineSpacing`/`align: right` on the MCP op, the font picker and
   the multi-line box on the card, old text steps unchanged. Tests: real-OCCT tests on the five letters with holes and
   a CFF font (valid, closed, volume = ink × depth), a fixture rebuild, an e2e spec in `test:smoke`.
2. **Curved faces: cylinder and cone.** The (u, v) mapping, Around/Along, Flip, depth square to the surface, seam
   handling, the refusals for too long, off the face, and too deep; "Pick one face." for Text; Show me. Measured on
   the owner's housing and Telo parts as well as primitives.
3. **Sphere, torus and freeform faces.** The geodesic baseline, Wrap/Project, the distortion check (letters within
   2 % of size), the boolean fallback across seams; the display mesh check.
4. **The person's fonts.** Add font file…, the project's `fonts` map and the font library, `.ttc` faces, variable
   weights with the 2D union refitted to curves, restricted-font handling, `fontFile` on the MCP op.
5. **Stroke fonts through the new step, recipes and MCP polish.** Stroke and Hershey through the outline pipeline
   (one step, curved faces), recipe API 1.3 (`curved()` faces, `model.text`, `text_outline`), `model_probe`'s `thin`
   and `inkMm2`, the guide's font list, a recipe sample.

## 11. Done for the whole plan

- A person types two lines in Sans Bold, puts them round a Ø 40 cup and on a wavy freeform lid, raised and
  engraved, and each builds in under a second as one step; the slicer shows letters with no gaps.
- The same with a `.ttf` from their disk, saved, reopened on another computer without the font installed.
- Every `.lime` fixture with text rebuilds unchanged.
- An MCP client and a recipe make the same text with the same fields, and get the same solid.
