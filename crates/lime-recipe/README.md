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
