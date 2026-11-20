//! ---
//! plugin: mech-2020-t-nut
//! title: 2020 T-slot nut block
//! version: 1
//! description: A sliding nut block for 20 mm aluminium extrusion (2020) with a captured hex pocket.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"slot","kind":"number","default":6,"min":5,"max":8,"step":0.1,"unit":"mm","label":"Slot width"},{"name":"nominal","kind":"number","default":5,"min":4,"max":8,"step":0.1,"unit":"mm","label":"Bolt nominal"},{"name":"length","kind":"number","default":20,"min":12,"max":40,"step":0.5,"unit":"mm","label":"Block length"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let slot = s.number("slot", 6.0).range(5.0, 8.0).step(0.1).unit("mm").label("Slot width").get();
    let nominal = s.number("nominal", 5.0).range(4.0, 8.0).step(0.1).unit("mm").label("Bolt nominal").get();
    let length = s.number("length", 20.0).range(12.0, 40.0).step(0.5).unit("mm").label("Block length").get();
    let neck = slot - 0.4;
    let head = 20.0;
    let part = s.solid_new(ops::cuboid(head, head, length)).unwrap();
    s.apply(&part, ops::boolean("cut", ops::cuboid(neck, head + 0.2, length + 0.2), [0.0, 0.0, 0.0])).unwrap();
    let across = nominal * 1.5 + 1.0;
    s.apply(&part, Json::obj()
        .set("kind", "boolean")
        .set("op", "cut")
        .set("origin", [0.0, 0.0, length / 2.0])
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", across)
        .set("flats", true)
        .set("height", head))
        .unwrap();
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("slot", slot).set("neck", neck).set("bmin", bmin).set("bmax", bmax));
}