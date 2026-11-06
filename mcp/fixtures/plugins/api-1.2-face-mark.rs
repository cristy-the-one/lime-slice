//! ---
//! plugin: corpus-face-mark-api-1-2
//! title: Corpus face mark (API 1.2)
//! version: 1
//! description: A peg on a face the person picks.
//! author: Lime Slice corpus
//! made-by: lime-slice-corpus
//! api: 1.2
//! lust: c2c1a430
//! source-sha256: fa29381012cb1d380834d016778e4e6c5ca23cdc0718fc3faa50b61b9e4114fd
//! created: 2026-11-06
//! target: object
//! params: [{"name":"face","kind":"face","default":{"rule":"largest_up"},"label":"Face to mark"},{"name":"depth","kind":"number","default":1,"min":0.2,"max":5,"unit":"mm","label":"Depth"}]
//! ---
use lime_recipe::{ops, Json, Session};

// Recipe API 1.2: a face the person picks, the part's bounds, and a plain refusal.
fn main() {
    let mut s = Session::start();
    let f = s.face("face").rule("largest_up").label("Face to mark").get();
    let d = s.number("depth", 1.0).range(0.2, 5.0).unit("mm").label("Depth").get();
    let p = s.object().unwrap();
    let (lo, hi) = s.bounds(&p).unwrap();
    if d >= hi[2] - lo[2] {
        s.refuse("Too deep for this part.");
    }
    let pf = s.pick_face(&p, &f).unwrap();
    let at = pf.point;
    s.apply(&p, ops::boolean("fuse", ops::cylinder(1.0, d), [at[0], at[1], at[2]])).unwrap();
    s.done_with(&p, Json::obj().set("face", pf.index).set("normal", pf.normal).set("area", pf.area).set("height", hi[2] - lo[2]));
}
