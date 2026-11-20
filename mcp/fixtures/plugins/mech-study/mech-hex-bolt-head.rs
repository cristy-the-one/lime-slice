//! ---
//! plugin: mech-hex-bolt-head
//! title: Hex bolt head
//! version: 1
//! description: An ISO 4017 hex cap head plus optional shank; no thread helix (pair with a threaded insert or tap).
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":6,"min":3,"max":16,"step":0.5,"unit":"mm","label":"Thread nominal"},{"name":"shank","kind":"number","default":20,"min":0,"max":120,"step":0.5,"unit":"mm","label":"Shank length"},{"name":"headHeight","kind":"number","default":4,"min":2,"max":12,"step":0.1,"unit":"mm","label":"Head height"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{shaft, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(3.0, 16.0).step(0.5).unit("mm").label("Thread nominal").get();
    let shank_len = s.number("shank", 20.0).range(0.0, 120.0).step(0.5).unit("mm").label("Shank length").get();
    let head_h = s.number("headHeight", 4.0).range(2.0, 12.0).step(0.1).unit("mm").label("Head height").get();
    let across = if nominal <= 4.0 { nominal * 1.5 + 1.5 } else { nominal * 1.5 + 1.0 };
    let shank_d = shaft(nominal, Fit::Sliding, 0.1).unwrap_or(nominal);
    let head = s.solid_new(Json::obj()
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", across)
        .set("flats", true)
        .set("height", head_h))
        .unwrap();
    let part = if shank_len > 0.2 {
        let shank = s.solid_new(ops::cylinder(shank_d / 2.0, shank_len)).unwrap();
        s.apply(&head, ops::boolean("fuse", ops::cylinder(shank_d / 2.0, shank_len), [0.0, 0.0, -shank_len])).unwrap();
        head
    } else {
        head
    };
    let half = across / 2.0;
    let top = if shank_len > 0.2 { head_h } else { head_h };
    let bot = if shank_len > 0.2 { -shank_len } else { 0.0 };
    let reach = half.max(shank_d / 2.0);
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("nominal", nominal).set("across", across).set("shankD", shank_d).set("bmin", bmin).set("bmax", bmax));
}