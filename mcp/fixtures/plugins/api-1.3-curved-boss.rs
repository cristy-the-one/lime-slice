//! ---
//! plugin: corpus-curved-boss-api-1-3
//! title: Corpus curved boss (API 1.3)
//! version: 1
//! description: A boss on a face that may be curved.
//! author: Lime Slice corpus
//! made-by: lime-slice-corpus
//! api: 1.3
//! lust: c2c1a430
//! source-sha256: 672cd86acb6a118b946971b02fbc7a3760b0ad008a712acc7ab262fbb14abe0a
//! created: 2026-11-06
//! target: object
//! params: [{"name":"face","kind":"face","default":{"rule":"top"},"label":"Face for the boss","curved":true},{"name":"height","kind":"number","default":3,"min":1,"max":10,"unit":"mm","label":"Boss height"}]
//! ---
use lime_recipe::{ops, Json, Session};

// Recipe API 1.3: a face parameter that takes a curved face too, and what the picked face is.
fn main() {
    let mut s = Session::start();
    let face = s.face("face").curved().rule("top").label("Face for the boss").get();
    let height = s.number("height", 3.0).range(1.0, 10.0).unit("mm").label("Boss height").get();
    let p = s.object().unwrap();
    let pf = s.pick_face(&p, &face).unwrap();
    let round = pf.kind != "plane";
    let r = pf.radius.unwrap_or(0.0);
    s.apply(&p, ops::boolean("fuse", ops::cylinder(3.0, height), pf.point)).unwrap();
    s.done_with(&p, Json::obj().set("kind", pf.kind.as_str()).set("round", round).set("radius", r));
}
