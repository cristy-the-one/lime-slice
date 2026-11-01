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
