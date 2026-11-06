//! ---
//! plugin: corpus-moved-post-api-1-4
//! title: Corpus moved post (API 1.4)
//! version: 1
//! description: A post at the top of a moved part.
//! author: Lime Slice corpus
//! made-by: lime-slice-corpus
//! api: 1.4
//! lust: c2c1a430
//! source-sha256: ede4a26083f1329dc38baf3a805ada274142b4f7805973e772277a8bd3dc444f
//! created: 2026-11-06
//! target: object
//! params: [{"name":"top","kind":"face","default":{"rule":"top"},"label":"Face for the post","curved":true},{"name":"post","kind":"number","default":5,"min":1,"max":20,"unit":"mm","label":"Post height"}]
//! ---
use lime_recipe::{ops, Json, Session};

// Recipe API 1.4: reads in the frame apply takes (a part moved by model_place), and a picked face's centre and axis point.
fn main() {
    let mut s = Session::start();
    let top = s.face("top").curved().rule("top").label("Face for the post").get();
    let post = s.number("post", 5.0).range(1.0, 20.0).unit("mm").label("Post height").get();
    let p = s.object().unwrap();
    let (lo, hi) = s.bounds(&p).unwrap();
    let pf = s.pick_face(&p, &top).unwrap();
    let centre = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, hi[2]];
    let round = pf.centre.is_some() || pf.axis_point.is_some();
    s.apply(&p, ops::boolean("fuse", ops::cylinder(2.0, post), centre)).unwrap();
    s.done_with(&p, Json::obj().set("centre", centre).set("point", pf.point).set("round", round));
}
