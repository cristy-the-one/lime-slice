//! ---
//! plugin: mech-hex-nut
//! title: Hex nut
//! version: 1
//! description: A standard hex nut from nominal size; across-flats and height follow ISO 4032 proportions.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":6,"min":3,"max":20,"step":0.5,"unit":"mm","label":"Thread nominal"},{"name":"height","kind":"number","default":5.1,"min":2,"max":20,"step":0.1,"unit":"mm","label":"Nut height"},{"name":"allowance","kind":"number","default":0.2,"min":0,"max":1,"step":0.05,"unit":"mm","label":"Bore allowance"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{hole, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(3.0, 20.0).step(0.5).unit("mm").label("Thread nominal").get();
    let height = s.number("height", 5.1).range(2.0, 20.0).step(0.1).unit("mm").label("Nut height").get();
    let allowance = s.number("allowance", 0.2).range(0.0, 1.0).step(0.05).unit("mm").label("Bore allowance").get();
    let across = if nominal <= 4.0 { nominal * 1.5 + 1.5 } else { nominal * 1.5 + 1.0 };
    let bore = hole(nominal, Fit::Running, allowance).unwrap_or(nominal + 0.4);
    let part = s.solid_new(Json::obj()
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", across)
        .set("flats", true)
        .set("height", height))
        .unwrap();
    s.apply(&part, ops::hole_through([0.0, 0.0, height], [0.0, 0.0, -1.0], bore)).unwrap();
    let half = across / 2.0;
    s.done_with(&part, Json::obj().set("nominal", nominal).set("across", across).set("bore", bore).set("bmin", [-half, -half, 0.0]).set("bmax", [half, half, height]));
}