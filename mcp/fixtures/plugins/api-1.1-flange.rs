//! ---
//! plugin: corpus-flange-api-1-1
//! title: Corpus flange (API 1.1)
//! version: 1
//! description: A flange with pegs and a bore, from typed values.
//! author: Lime Slice corpus
//! made-by: lime-slice-corpus
//! api: 1.1
//! lust: c2c1a430
//! source-sha256: 0ff54d8d87f6d8870dd3f6ce2da429f699f5a84f97e5e2d80753eccf97345776
//! created: 2026-11-06
//! target: new
//! params: [{"name":"diameter","kind":"number","default":80,"min":20,"max":250,"step":0.5,"unit":"mm","label":"Outer diameter"},{"name":"holes","kind":"count","default":6,"min":3,"max":24,"label":"Bolt holes"},{"name":"bore","kind":"toggle","default":true,"label":"Centre bore"},{"name":"edge","kind":"choice","default":"chamfer","label":"Edge","options":["fillet","chamfer","sharp"]},{"name":"tag","kind":"text","default":"F1","label":"Tag","maxLen":12}]
//! ---
use lime_recipe::{ops, Json, Session};

// Recipe API 1.1: typed values (number, count, toggle, choice, text) declared before the first call.
fn main() {
    let mut s = Session::start();
    let d = s.number("diameter", 80.0).range(20.0, 250.0).step(0.5).unit("mm").label("Outer diameter").get();
    let holes = s.count("holes", 6).range(3, 24).label("Bolt holes").get();
    let bore = s.toggle("bore", true).label("Centre bore").get();
    let edge = s.choice("edge", &["fillet", "chamfer", "sharp"], "chamfer").label("Edge").get();
    let tag = s.text("tag", "F1").max_len(12).label("Tag").get();
    let p = s.solid_new(ops::cuboid(d, 20.0, 4.0)).unwrap();
    for i in 0..holes {
        let x = -d / 2.0 + d * (i as f64 + 0.5) / holes as f64;
        s.apply(&p, ops::boolean("fuse", ops::cylinder(1.5, 3.0), [x, 0.0, 4.0])).unwrap();
    }
    if bore {
        s.apply(&p, ops::hole_through([0.0, 0.0, 4.0], [0.0, 0.0, -1.0], 8.0)).unwrap();
    }
    s.log(&tag);
    s.done_with(&p, Json::obj().set("holes", holes).set("edge", edge.as_str()));
}
