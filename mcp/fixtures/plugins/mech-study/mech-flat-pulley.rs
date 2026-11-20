//! ---
//! plugin: mech-flat-pulley
//! title: Flat belt pulley
//! version: 1
//! description: A crowned flat-belt pulley: a cylinder with a shallow centre groove for belt tracking.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"diameter","kind":"number","default":40,"min":15,"max":150,"step":0.5,"unit":"mm","label":"Tread diameter"},{"name":"width","kind":"number","default":20,"min":5,"max":80,"step":0.1,"unit":"mm","label":"Face width"},{"name":"bore","kind":"number","default":6,"min":2,"max":30,"step":0.1,"unit":"mm","label":"Bore diameter"},{"name":"crown","kind":"number","default":0.5,"min":0,"max":3,"step":0.05,"unit":"mm","label":"Crown depth"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let diameter = s.number("diameter", 40.0).range(15.0, 150.0).step(0.5).unit("mm").label("Tread diameter").get();
    let width = s.number("width", 20.0).range(5.0, 80.0).step(0.1).unit("mm").label("Face width").get();
    let bore = s.number("bore", 6.0).range(2.0, 30.0).step(0.1).unit("mm").label("Bore diameter").get();
    let crown = s.number("crown", 0.5).range(0.0, 3.0).step(0.05).unit("mm").label("Crown depth").get();
    let part = s.solid_new(ops::cylinder(diameter / 2.0, width)).unwrap();
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, width], [0.0, 0.0, -1.0], bore)).unwrap();
    }
    if crown > 0.05 {
        let crown_r = (diameter / 2.0 - crown).max(bore / 2.0 + 0.3);
        let crown_h = width * 0.35;
        s.apply(
            &part,
            ops::boolean("cut", ops::cylinder(crown_r, crown_h), [0.0, 0.0, width - crown_h]),
        )
        .unwrap();
    }
    let r = diameter / 2.0;
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("diameter", diameter).set("width", width).set("bmin", bmin).set("bmax", bmax));
}