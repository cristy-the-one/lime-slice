//! ---
//! plugin: mech-parallel-key
//! title: Parallel key
//! version: 1
//! description: A rectangular machine key for a shaft keyway; width and height follow ISO 8734 proportions.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"shaft","kind":"number","default":20,"min":6,"max":60,"step":0.5,"unit":"mm","label":"Shaft diameter"},{"name":"length","kind":"number","default":30,"min":5,"max":120,"step":0.5,"unit":"mm","label":"Key length"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn key_size(shaft: f64) -> (f64, f64) {
    if shaft <= 10.0 { (3.0, 3.0) }
    else if shaft <= 17.0 { (5.0, 5.0) }
    else if shaft <= 22.0 { (6.0, 6.0) }
    else if shaft <= 30.0 { (8.0, 7.0) }
    else if shaft <= 38.0 { (10.0, 8.0) }
    else { (12.0, 8.0) }
}

fn main() {
    let mut s = Session::start();
    let shaft = s.number("shaft", 20.0).range(6.0, 60.0).step(0.5).unit("mm").label("Shaft diameter").get();
    let length = s.number("length", 30.0).range(5.0, 120.0).step(0.5).unit("mm").label("Key length").get();
    let (w, h) = key_size(shaft);
    let part = s.solid_new(ops::cuboid(w, h, length)).unwrap();
    s.done_with(&part, Json::obj().set("width", w).set("height", h).set("length", length).set("bmin", [0.0, 0.0, 0.0]).set("bmax", [w, h, length]));
}