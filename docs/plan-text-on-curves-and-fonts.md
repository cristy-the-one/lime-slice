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

### As built (milestone 1)

Built on `main` at v5.1.0, 2026-11-04 (PR "Text with real fonts on flat faces (text milestone 1)"). What a person can do now: open Features, pick
Text, pick a flat face, choose a font (Stroke, Inter, IBM Plex Mono, IBM Plex Serif, Allerta Stencil, each drawn in itself), a style, type several
lines, set size, letter spacing, line spacing, left, centre or right, an angle, a depth and raise or engrave, see the letters on the face as they
type (green raised, red cut, letters too thin for the nozzle drawn apart in the refusal colour and named under Apply), and apply one history
step. The MCP `text` op takes the same fields. A text with no font, or `stroke`, builds the boxes it always did.

- **Reading and layout.** `ttf-parser` 0.25 in `lime-model-occt` (`src/text/`), no Open CASCADE needed: glyph outlines as Bézier pieces, kerning
  from `GPOS` pair adjustments (`kern` feature, format 1 and 2) and the old `kern` table, no shaping. Segments under 2 µm dropped; a glyph that
  overlaps itself, and letters that touch, united in 2D (`lime-recipe`'s `geom2d`, now a dependency of `lime-model-occt`) on polylines about 0.1 mm
  apart, only for those faces. Size is the font's `OS/2` capital height (the height of an H without one).
- **Fonts shipped** (`public/fonts/model/`, compiled in with `include_bytes!`, licences in `third_party/fonts/`, all SIL OFL 1.1): `sans@4.0` Inter 4.0
  (Regular, Bold, Italic, Bold Italic), `mono@1` IBM Plex Mono (Regular, Bold), `serif@1` IBM Plex Serif (Regular, Bold), `stencil@1` Allerta Stencil
  (Regular). 2.4 MB in all.
- **The step.** `{kind: "lettering", op, origin, turn, text, font, style?, height, depth, spacing?, lineSpacing?, align?, angleDeg?}`, one step inside
  the text group (so the row, the source and Edit are the group's, as for every feature), built by `lime_tree_text` (`cpp/text.cpp`). The direct build
  sews the new faces among themselves and puts them where the old face was, so every other face of the part is still the same face (checked: the
  five other faces and the replaced top keep the root as their owner); the boolean build is the fallback.
- **Measured** (release build, this machine, a 200 × 40 × 20 block, "Lime Slice gAO8 2026", 6 mm, 0.8 deep, apply including the reply's mesh): Inter
  raised 0.33 s, engraved 0.31 s; Plex Serif 0.51 s and 0.52 s; two lines of Plex Mono 0.53 s and 0.60 s; all direct. Layout with the thin-letter
  analysis, for the live preview: 0.05 s (mono) to 0.29 s (Inter), the analysis dominating.
- **Tests.** Rust, no kernel (`src/text/tests.rs`, 20): bundled fonts lay out, capital height, holes of A O 8 g B e, loops closed and oriented, kerning,
  letter and line spacing, alignment, angle, missing glyph, style files and slant, overlap union, thin letters, the kernel blob, and a CFF font (Source
  Code Pro OTF) read as cubic curves. Rust with the kernel (`tests/lettering.rs`, 12): raised and engraved letters in every bundled family and in the CFF
  font are valid, one shell, built directly, volume = ink × depth to 0.01 mm³; every other face keeps its owner; lines, alignment, spacing and angle; a
  side face; a cut through the wall (boolean build), an O that would lose its middle (refused), the stencil O (cuts through); text off the face; the
  refusal sentences; replay from a saved group to the same fingerprint; the `textLayout` and `textFonts` calls. TypeScript: `src/modeling/lettering.test.ts`
  (one step per text, the pose, the refusals, the old stroke boxes, the card's spec and what a saved step reopens as, the file round trip),
  `mcp/text-fonts.test.ts` (real engine: the engine's fonts are the app's table, raise and engrave, every field, the refusals, the stroke volume),
  `e2e/model-text-fonts.spec.ts` (in `test:smoke`).

Deviations from this plan, each on purpose or forced:

1. **The op is `lettering`, inside the text group,** not a new top-level node kind `text`. The composite `text` already names the group's source and reopens
   the card; the group keeps the row, undo and Edit unchanged, and `lettering` is the one step it holds. A pattern or mirror of an outline-font text is
   refused ("not supported yet") instead of half built.
2. **Fonts.** The slab is IBM Plex Serif and its id is `serif` (not `slab`); it is not a true slab, so thin strokes still warn at small sizes (the plan allowed
   "IBM Plex Serif or a slab serif"). The stencil is Allerta Stencil, not Big Shoulders Stencil, which ships only as a variable font. `hershey` is not
   shipped: it needs the stroke pipeline, which is milestone 5. Inter ships four files (1.65 MB), so the set is 2.4 MB against "about 2 MB". The Plex files
   were taken from the npm packages as WOFF and repacked as plain sfnt (zlib only, glyph data unchanged).
3. **No weight, no variable fonts, no person's fonts** (milestone 4), and none of `fontFile`, `point`, `along`, `wrap`, `flip` on the MCP op (milestones 2 to 4).
   `model_probe`'s `thin` and `inkMm2` are milestone 5: in milestone 1 the thin-stroke warning is the card's, from `textLayout`; an MCP client sees no thin
   warning yet. The MCP reply of a text op is as before (the build path is in the engine's apply reply, which the MCP composite does not pass on).
4. **The preview draws the letters, not outlines.** The live preview is a prism ghost on the face (the viewer's existing "soup" ghost): green when
   raised, red when cut, and the letters that lose more than a tenth of their area to a nozzle-wide opening apart in the refusal colour, named under Apply.
   Polyline outlines on the face are not drawn. A loop smaller than the line width squared is not left out and named (section 4.4): the warning names the
   letter instead, and a dot that would be lost is a letter that is thin.
5. **Anchor.** The layout block is centred on the anchor vertically for every alignment (the stroke font's `left` put the baseline there), and horizontally by
   line: left starts at the anchor, right ends on it. The line spacing default of 1.3 capital heights is as the plan says; a descender of g then just touches the
   next line's ascenders for some pairs, and touching letters are united in 2D (one solid) rather than refused.
6. **Italic and bold in the card.** Bold and Bold italic are greyed (with the reason as the tip) for a font that would refuse them. Italic stays available for a
   family with no italic file and says it is slanted 12° (D7); the plan's "greyed with a reason where the family lacks one" would have contradicted the slant.
   Changing to a font that lacks the chosen style goes back to Regular.
7. **Old text steps reopen as Stroke.** Edit on a step saved before fonts opens the card on the Stroke font, and Update keeps the boxes; it becomes a lettering
   step once a font is picked (the plan said pressing Update makes a new text step).
8. **What the direct build needs.** The text wholly inside the one coplanar face the anchor is on, 0.02 mm clear of its edges; for a cut, material under every
   letter. A text partly off that face is refused ("The text runs off this face. ...") even where the boolean could build it, as section 6 says; a text on no
   face of the part (a bare workplane) builds by the boolean. An engraving through the wall refuses only for a letter with a counter; letters without one cut
   through (boolean). The wall under a letter is probed at its interior point and its loop starts, not everywhere.
9. **CFF is tested with a debug-only font id** (`test-cff`, Source Code Pro OTF in `crates/lime-model-occt/tests/fonts/`): no CFF font ships in this milestone.
10. **Not done.** A `.lime` fixture with a text group: the repo has none, so "every fixture rebuilds" is the save/load round trip and the replay test above.
    The About licences list does not exist, so the licences are `third_party/fonts/NOTICE.md` and the files beside the fonts.

### As built (milestone 2)

Built on `main` after milestone 1 (PR "Text on cylinders and cones (text milestone 2)"). What a person can do now: pick the side of a cylinder or a
cone (a tube's bore too), open Text, click where the text should sit (or leave it in the middle of the face, across from its seam), choose
**Around** (the default: reads round the part like a label) or **Along** (runs up the axis), **Flip** (a half turn), an angle, a depth, raised or
engraved, and see the letters on the surface as they type; Apply is one history step. The MCP `text` op takes the same on `faceIndex` of a
cylinder or cone, with `point`, `along` and `flip`. A text longer than the way round, running off the face, or too deep for the curve is refused in
one sentence before anything is built.

- **Mapping** (`crates/lime-model-occt/src/text/wrap.rs`, no kernel needed). The layout (mm, centred on the anchor) goes into the face's own `(u, v)`
  through the surface's unrolling, so letters keep their true size. A cylinder is exact and affine in `(u, v)`: lines stay lines and Béziers stay
  Béziers. A cone is not, so each outline piece is first cut to at most `sqrt(8 ρ 0.004)` mm (ρ the anchor's distance from the apex), which keeps the
  bend under 4 µm, then every point goes through the exact polar map (checked: every pairwise distance between mapped points equals the layout's to
  1e-9). Right, up and the outward normal are a right-handed set, so the text reads from outside on a cylinder, a bore (a reversed face) and a
  cone, and "up" is the way the axis runs up in the world even if the face was made pointing down.
- **Depth.** Constant and square to the surface by construction: the top (or floor) is the same `(u, v)` loops on an offset surface, which for a
  cylinder is a cylinder of radius R ± depth and for a cone a cone with the reference radius moved by depth × cos(half angle) and its origin
  slid along the axis (`Geom_OffsetSurface` only when the offset would turn a cone inside out). Measured on the kernel's own mesh at every cap
  vertex, cylinder R 20 and cone R 25 to R 15, raised and engraved 0.8 mm: every point of every letter is between the surface and the cap, and the cap
  is at 0.800 mm to 2 µm.
- **Builds.** `lime_tree_text_face` finds the face under the anchor (a flat face within a micron wins, so a flat text is unchanged; else a cylinder or
  cone within 0.5 mm that contains the point; else "other"), `lime_tree_text_curved` builds. The direct build is milestone 1's sewing, generalized to
  take the surface and its offset (`add_walls_and_cap`, the orientation test as a function), and needs the text wholly inside the face and 0.02 mm
  clear of its edges and its seam. Across the seam of a face that goes all the way round, the boolean build runs: a solid for each letter between two
  offset surfaces (0.2 mm inside the part, or past it for a cut, to the depth), one boolean. Both are valid, closed and one solid on cylinder, cone and
  tube, raised and engraved, with letters that have holes (A, O, B, 8, g, e), and add or take ink × depth × (1 ± depth / 2R) of volume: to 0.2 % on a
  cylinder, 2 % across the seam, 4 % on the cone (the cone's patch is not a prism).
- **Measured** (release build, this machine, shared with other sessions so ±30 %, "Lime Slice gAO8 2026", 6 mm, 0.8 deep, including the reply's
  mesh): cylinder R 20 raised 0.61 s, engraved 0.65 s; cone R 25 to 15 raised 0.67 s, all direct; across the seam by the boolean 1.27 s. The
  preview's `textCurved` call, with the thin-letter analysis, 0.4 s for those 20 letters, 0.02 to 0.2 s for a label.
- **Tests.** Rust, no kernel (`src/text/wrap/tests.rs`, 12): every length kept on a cylinder (exact) and on a cone (to 1e-9), cone strokes cut short,
  loop orientation for both face directions, the right-handed set for around, along, flip, an axis pointing down and a bore, the seam flag, and the
  refusals (the way round with its length, off the face, too deep with the depth that works, past a cone's tip). Rust with the kernel
  (`tests/lettering_curved.rs`, 12): valid closed one-shell solids and measured depth on a cylinder and a cone raised and engraved, letters with
  holes, a seam crossing (boolean) raised and engraved, along and flipped, the inside of a tube, the refusals, a cut through a thin wall, a replay
  from a saved node, and the preview call; a test that writes OBJ files for a render when `LIME_TEXT_CURVES_OBJ` is set. TypeScript:
  `src/modeling/lettering-round.test.ts` (the middle of a face, the step, every refusal, the card's reopening, the pose), `mcp/text-curves.test.ts`
  (real engine: raised, engraved, cone, point, along, flip, the refusals, the guide), `e2e/model-text-curves.spec.ts` (in `test:smoke`; the mocked
  engine: Direction, Flip, the anchor and its note, a second click, Centre on the face, the preview, the refusal, Edit, "Pick one face." for Text and
  "Pick one flat face." for Pocket).

Deviations from this plan, each on purpose or forced:

1. **Show me is not built.** Section 4.8's demo (a Ø 30 cylinder beside the part with "Lime 42" wrapped on it, Apply on the demo only) needs a way to open a
   demo solid from the Features card; the Show me mechanism that exists (`src/sketch/demos.ts`) opens a demo sketch in the sketch editor, not a demo
   part. It is left for a later milestone with that mechanism, not faked with a sketch.
2. **The anchor is the op's `origin`, found again by the nearest cylinder or cone, not a point and a normal.** The step stores `origin` (a point on the
   face; `turn` is not read) and the kernel looks for the face within 0.5 mm of it on rebuild, which survives the mesh's chord (a clicked point lies a
   few hundredths inside the true surface) and costs no normal to store. The plan's `nearPoint` with its normal would tell two coincident faces apart;
   the nearest one wins here.
3. **The op fields are `along: "axis"` and `flip: true`**, absent for around and no flip (section 4.5's `along?`, `flip?`); the engine also reads
   `"around"`, `"u"` and `"v"`. The MCP schema offers `around` and `axis` (the plan listed `u` and `v` for sphere, torus and freeform faces, which are
   milestone 3). The schema's three new fields cost 0 tokens in `tools/list` (the op's fields are served by `guide {kind}`).
4. **Flip is a half turn about the anchor**, which is what "reads the other way round, upside down" asks for on a cup or a ring; it is not a mirror.
5. **A seam is crossed by the boolean, not moved away from the text.** The default anchor sits across from the seam, which is where a click-less text
   goes, so the boolean is for a text the person puts on the seam. Section 6's "moves the seam out of the way when the surface allows it" is not done.
6. **Not measured on the owner's housing and Telo parts**, only on synthetic cylinders and cones (the brief for this milestone allows synthetic parts only).
7. **The card has no position dot or depth arrow on a round face**; a click places the text and Depth, Height and the other numbers stay on the card
   (and their docked knobs are hidden for a round face, as an arrow on a flat plane would be wrong on a wall). U and V are hidden then.
8. **Only a cylinder or a cone, and only an outline font.** A sphere, torus or freeform face says "Text goes on a flat face, a cylinder or a cone for now.
   This face is curved another way." (milestone 3); the stroke font stays on flat faces ("Text on a cylinder or a cone takes an outline font ...").
9. **"Too deep" is 0.9 of the smallest ring radius** (divided by the cone's cosine), on the side the letters grow towards the axis: an engraving on a
   convex face or a raised letter on a concave one. The plan's example number (4.5 mm for R 5) is exactly that.
10. **The cone's tip.** Text that would run past the apex is refused ("The text runs past the tip of the cone. Move it, or make it smaller."), a sentence
    the plan did not list.

### As built (milestone 4)

Built on `main` after milestone 1 (PR "Your own fonts for text (text milestone 4)"). What a person can do now: on the Text card's font
picker, **Add font file…** takes a `.ttf`, `.otf` or `.ttc` from disk (a collection asks which font of it), the font is listed under the
bundled ones with its name drawn in itself, and a text can be set in it like in a bundled font, with a Weight field when the font is variable.
The font stays in the person's font library for every project and can be removed from it with the × beside it. A project that uses it
carries it, so it opens, rebuilds and edits on a computer that does not have the font; if the font's licence forbids embedding it, the
project carries only the outlines of the letters used, and the card says so in one sentence. Over MCP a `text` op takes `fontFile` (a path
in the workspace) or `font` by the name already in the project, and `weight`.

- **Reading.** A font file is data, read by `ttf-parser` (`crates/lime-model-occt/src/text/user.rs`): its names, whether it has outlines
  (`glyf`, `CFF` or `CFF2`; a bitmap-only font is refused), its `wght` axis, its collection's faces and `OS/2 fsType`. The engine keeps the
  fonts it is given in a table by id, `user:` and the first 16 hex digits of the file's SHA-256 (`.n` after it for the n-th face of a
  collection), in `textFontAdd`; a text step names its font by that id, so a rebuild finds the same bytes. The layout reads glyphs through a
  small trait (`Glyphs`), which a parsed face and a pack both fill, so a user font lays out, builds, thin-checks and previews exactly as a
  bundled one does.
- **Embedding (D5).** `fsType` installable (0) or editable (8) with outline embedding allowed, or no `OS/2` table: the project keeps the file
  whole, in a `fonts` map of binary records (packed like a solid, `gzip+base64`) under its SHA-256. Restricted (2), preview and print (4), bitmap
  embedding only (0x200) or a value that cannot be read: the project keeps a **pack**, JSON of the outlines, advances and kerning of the letters
  its texts use, per weight (a space always), cut by `textFontPack` when the project is saved; the "no subsetting" bit (0x100) changes nothing
  because a restricted font is subset anyway. A pack never takes the place of the whole file when this computer has the file (the engine and
  the shelf keep the file), and the font library (the person's own computer) keeps the file as it was added.
- **Variable fonts.** `weight` joins the op, the card (a Weight field in place of Bold and Bold italic) and `textLayout`; bold on a variable
  font is 700 clamped to the axis; a weight outside the axis is refused with its range; a weight on a static font is refused. A glyph drawn from
  overlapping contours is united in 2D and now **refitted to curves** (`text/fit.rs`: corners found where the polyline turns more than 40°, a
  run with no bend becomes one line, a bent run is fitted with cubic Béziers by Schneider's method within 0.004 mm; the polyline stays when the
  area moved more than 0.3 %). A circle of 314 lines becomes 4 to 8 curves. Touching letters (milestone 1's union, bundled fonts too) are refitted
  the same way, so they no longer fall back to polylines about 0.1 mm apart.
- **Where the fonts live.** The library is `~/.lime-slice/fonts/` (or `LIME_FONTS_DIR`), read and written by `src-tauri/src/fonts.rs`
  (`font_library_list`, `font_library_add`, `font_library_remove`); the browser build has none. The project's copies are `LimeProject.fonts`.
  The MCP server keeps the fonts of its project in the same shelf class (`src/modeling/user-fonts.ts`) the app uses, adds them from `fontFile`
  and from `project_open`, and writes them in `project_save` and in the autosave.
- **Schema budget.** `tools/list` is byte for byte what it was (about 17,186 tokens, 17,190 allowed): the three new fields (`fontFile`,
  `weight`, and `font` now a string) live in the full op schema and `guide {kind: "text"}`, as milestone 1's did. No budget changed.
- **Tests.** Rust unit tests with no kernel (`text/user_tests.rs`, 20): the reading, the licence rule for every `fsType` case, unreadable
  files, bitmap-only, missing letters, styles of a static font, a variable font's weight, a collection, a pack that lays out exactly like its
  font (Inter, kerning included), a pack's weights, a pack never replacing the file, a refit circle and a refit rounded box, glyphs from
  overlapping curves; the fonts are built in code (`text/synth.rs`: TrueType with `OS/2`, `name`, `fvar`, `gvar`, collections), plus the bundled
  Inter read as if added. Rust with the kernel (`tests/lettering.rs`, 4 more): a user font builds valid, closed, direct, volume = ink × depth; a
  restricted font's pack rebuilds the same solid; a variable font's weight changes the solid; the refusals. TypeScript:
  `src/modeling/user-fonts.test.ts` (the shelf, what a project keeps, the project file round trip with a font), `src/modeling/lettering-user.test.ts`
  (the step, the weight in the file and the card), `mcp/text-user-fonts.test.ts` (real engine: `fontFile`, a copy of Plex Mono builds the bundled
  solid, the font by name and family, save and open in a new session, a restricted font packed and rebuilt from the pack alone, the refusals),
  `e2e/model-text-user-fonts.spec.ts` (in `test:smoke`). No font of anyone's is in the repository: the test fonts are built in code, or are
  copies of bundled fonts with one table changed in the copy.

Deviations from this plan, each on purpose or forced:

1. **A variable font's "instance" is its weight.** Only the `wght` axis is offered (the Weight field, `weight` on the op); named instances and
   other axes (`wdth`, `slnt`, `ital`) are not. A font with no `wght` axis is a static font.
2. **`.otc`, `.woff` and `.woff2` are not accepted.** They are the same one sentence as any file that is not a font ("Use a TrueType (.ttf) or
   OpenType (.otf) file."); a `.ttc` is.
3. **`font` on the MCP op is a free string**, no longer an enum of the bundled ids: it takes a project font's name. So `font` and `fontFile` are
   text fields the parameter evaluator leaves alone (`TEXT_FIELDS`). A name that is neither bundled nor in the project is the evaluator's
   sentence for fonts, not the schema's.
4. **Missing letters are all named in one sentence** ("This font has no ‘ñ’ and ‘é’. Pick another font, or take them out."); one missing letter
   is the sentence milestone 1 had.
5. **MCP library.** `fontFile` reads a file path the way a mesh path is read (a relative path in the workspace, or an absolute one); the MCP server
   has no font library of its own, the plan's library being the desktop app's. A font reaches a project over MCP only through `fontFile`, or by
   already being in the project.
6. **Autosave and packs.** A restricted font's pack is cut when a text names it and again when the project is saved; the autosave writes the pack
   made so far, and `project_save` writes exactly the letters the texts use now.
7. **A collection is registered by face.** The whole `.ttc` is what the project and the library keep, with the face number in the key and the id.
8. **The test fonts.** The plan's "freely licensed test fonts" are a synthetic font built in code (it has to have a variable axis, which no free
   font in the repository has) and copies of the bundled OFL fonts; the e2e spec marks copies of bundled fonts and has the mock engine read
   the mark.
9. **Not done.** Reading `.woff2`, named instances, a font library the MCP server reads, `hershey` and the stroke fonts through the outline
   pipeline (milestone 5), and curved faces (milestones 2 and 3). An engine that restarts while the app runs is given the fonts again before a
   tree is rebuilt (`restore`); the MCP server runs one engine and has no restart to cover.

## 11. Done for the whole plan

- A person types two lines in Sans Bold, puts them round a Ø 40 cup and on a wavy freeform lid, raised and
  engraved, and each builds in under a second as one step; the slicer shows letters with no gaps.
- The same with a `.ttf` from their disk, saved, reopened on another computer without the font installed.
- Every `.lime` fixture with text rebuilds unchanged.
- An MCP client and a recipe make the same text with the same fields, and get the same solid.
