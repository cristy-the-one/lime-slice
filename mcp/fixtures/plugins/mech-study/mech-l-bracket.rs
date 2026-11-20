//! ---
//! plugin: mech-l-bracket
//! title: L bracket
//! version: 1
//! description: An angle bracket with mounting holes on both legs; common 90 degree corner brace.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"leg","kind":"number","default":40,"min":15,"max":120,"step":0.5,"unit":"mm","label":"Leg length"},{"name":"width","kind":"number","default":30,"min":10,"max":80,"step":0.5,"unit":"mm","label":"Leg width"},{"name":"thickness","kind":"number","default":3,"min":1.5,"max":10,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"holes","kind":"count","default":2,"min":0,"max":4,"label":"Holes per leg"},{"name":"holeD","kind":"number","default":4.2,"min":2,"max":12,"step":0.1,"unit":"mm","label":"Hole diameter"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let leg = s.number("leg", 40.0).range(15.0, 120.0).step(0.5).unit("mm").label("Leg length").get();
    let width = s.number("width", 30.0).range(10.0, 80.0).step(0.5).unit("mm").label("Leg width").get();
    let t = s.number("thickness", 3.0).range(1.5, 10.0).step(0.1).unit("mm").label("Thickness").get();
    let holes = s.count("holes", 2).range(0, 4).label("Holes per leg").get();
    let hole_d = s.number("holeD", 4.2).range(2.0, 12.0).step(0.1).unit("mm").label("Hole diameter").get();
    let part = s.solid_new(ops::cuboid(leg, width, t)).unwrap();
    s.apply(&part, ops::boolean("fuse", ops::cuboid(t, width, leg), [0.0, 0.0, 0.0])).unwrap();
    for i in 0..holes {
        let x = -leg / 2.0 + leg * (i as f64 + 1.0) / (holes as f64 + 1.0);
        let _ = s.apply(&part, ops::hole_through([x, 0.0, t], [0.0, 0.0, -1.0], hole_d));
        let _ = s.apply(&part, ops::hole_through([t / 2.0, 0.0, leg * (i as f64 + 1.0) / (holes as f64 + 1.0)], [1.0, 0.0, 0.0], hole_d));
    }
    s.done_with(&part, Json::obj().set("leg", leg).set("width", width).set("bmin", [-leg / 2.0, -width / 2.0, 0.0]).set("bmax", [leg / 2.0, width / 2.0, leg]));
}