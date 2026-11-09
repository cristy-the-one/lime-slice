# lime-recipe

The crate a recipe uses: a short Rust program the MCP tool `recipe_run`
builds with `lust build --sandbox` and runs, talking to the MCP server over
stdin and stdout (protocol v1, `docs/plan-recipes.md`).

It has no dependencies and its own small JSON type, so lust (no proc
macros, edition 2024) and rustc build it the same way, and a recipe sends
the same calls under both (`cargo test -p lime-recipe` checks the JSON;
`mcp/recipe.test.ts` checks a whole recipe against a scripted host).

```rust
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let width = s.param_f64("width", 60.0);
    let part = s.solid_new(ops::cuboid(width, 20.0, 4.0)).unwrap();
    for i in 0..4 {
        let x = -width / 2.0 + width * (i as f64 + 0.5) / 4.0;
        s.apply(&part, ops::hole_through([x, 0.0, 4.0], [0.0, 0.0, -1.0], 3.2)).unwrap();
    }
    s.done(&part);
}
```

Every op an MCP edit takes can be sent as JSON: `Json::obj().set("kind",
"fillet").set("edges", ...)`. The `ops` helpers cover the common ones.

## Geometry

`geom2d` and `lattice` do the 2D work a recipe would otherwise write by
hand: polygons and regions with holes, booleans, offsets, rounded corners,
cleanup, the `loops` an `extrude` takes, and cell patterns clipped to a
region (`examples/vent_plate.rs`). They use their own sine, cosine and
arctangent, so a recipe sends the same bytes under lust and rustc, whose
libm differ in the last bit on Windows (`mcp/recipe-geom2d.test.ts`).
`tests/kernel_reference.rs` checks the booleans against Open CASCADE.
Everything stays in `src/lib.rs`: the recipe host copies only that file.

## Values a person picks (API 1.2)

`s.face("face").rule("largest_up").get()` declares a face of the part and
`s.outline("shape").default_poly(&geom2d::rect(80.0, 60.0)).get()` a closed
outline; `s.pick_face(&part, &face)` and `s.pick_outline(&shape)` resolve them
through the host's `pick` call, giving the face's index, normal, point, area
and outline, or the outline as a `Section`. The person picks them in the
Plugins panel and History (a face clicked in the view, a sketch, a face's
outline); an agent passes an index, `{normal, nearPoint}`, `{sketch}`,
`{face}`, `{loops}` or `{data}`. `s.refuse(sentence)` ends a run with a plain
reason; `s.bounds(&part)` is the part's box.

## Text and curved faces (API 1.3)

`s.face("wall").curved().get()` declares a face parameter that takes any face, not only a flat one. `s.pick_face` then says what it
got: `kind` (`plane`, `cylinder`, `cone`, `sphere`, or `other` for a torus or a freeform face), and for a cylinder or a cone its
`axis` and `radius`. A curved face has no one normal (`normal` is zero), no outline (`outline` is empty), and a point on it
(`point`); it is kept in a plugin step as `{surface, nearPoint}` and found again by the face of that surface under the point. A
parameter without `.curved()` refuses a curved face in the 1.2 sentence.

`s.lettering(&part, &face, "LOT 42", &Lettering::new(6.0, 0.8).font("mono").around())` is the `text` op as a typed call, on the face
`pick_face` gave, flat or curved (one history step; `Lettering` also takes `.style`, `.weight`, `.spacing`, `.line_spacing`,
`.align`, `.angle`, `.stroke_width`, `.axis`, `.u`, `.v`, `.project`, `.flip`, `.engrave`). The plan called the struct `Text`,
which `s.text(name, default)`'s parameter builder already is, and the method `model.text`, which a recipe has no `model` for.

`s.text_outline("LIME", "sans", 10.0)` is the letters as a `Section`: `.region` for `geom2d`, `.loops` for `extrude`, centred on the
origin with U right and V up. The host lays the text out, since this crate reads no fonts. `text_outline_with(text, &Lettering)` takes
the style, weight, spacing, line spacing, alignment, angle and pen width too. A letter the font lacks is a `Refusal` with the
layout's sentence.

## One frame for reads and cuts (API 1.4)

Every read answers in the frame `s.apply` takes its numbers in: model space, where a part `model_place` moved or turned stands
(the part's own frame when it was placed with `frame: "part"`). `s.bounds`, `s.pick_face`, and the raw `faces_find`, `edges_find`,
`surface_at`, `model_describe` and `section` calls all do, so measure the part, compute a point, and cut at it: no offset to add.
Before 1.4 the reads answered in the solid's own frame, so on a moved part such a cut missed by the pose. `PickedFace` gains
`centre` (a sphere's) and `axis_point` (a point on a cylinder's or a cone's axis, or a sphere's centre). A picked face is still kept
in the part's own frame, so it stays on the part when the part moves.

## Gears (API 1.12)

`gears` is the library's `involute-gears` v1, adopted with the same names and the same numbers bit for bit
(`gear_outline`, `mate_phase`, `idler_centre`, `rack_outline`, ...; `tests/gears.rs` and `mcp/recipe-gears.test.ts`
compare them with the library copy in `tests/fixtures`), and `Gear`, true involute outlines: splines on the flanks, the
cutting rack's root fillet and undercut, arcs at tip and root, any pressure angle and profile shift, in the crate's own
trig. `ops::gear` is the kernel's gear step, which builds the same outline (`guide {kind:"gear"}`).
