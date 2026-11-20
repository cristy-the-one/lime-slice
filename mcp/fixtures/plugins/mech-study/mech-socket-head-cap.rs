//! ---
//! plugin: mech-socket-head-cap
//! title: Socket head cap screw body
//! version: 1
//! description: ISO 4762 style cylindrical head with hex socket and shank; no thread helix.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":6,"min":3,"max":12,"step":0.5,"unit":"mm","label":"Thread nominal"},{"name":"shank","kind":"number","default":25,"min":5,"max":100,"step":0.5,"unit":"mm","label":"Shank length"},{"name":"headD","kind":"number","default":10,"min":5,"max":24,"step":0.1,"unit":"mm","label":"Head diameter"},{"name":"headH","kind":"number","default":6,"min":3,"max":15,"step":0.1,"unit":"mm","label":"Head height"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{shaft, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(3.0, 12.0).step(0.5).unit("mm").label("Thread nominal").get();
    let shank_len = s.number("shank", 25.0).range(5.0, 100.0).step(0.5).unit("mm").label("Shank length").get();
    let head_d = s.number("headD", 10.0).range(5.0, 24.0).step(0.1).unit("mm").label("Head diameter").get();
    let head_h = s.number("headH", 6.0).range(3.0, 15.0).step(0.1).unit("mm").label("Head height").get();
    let shank_d = shaft(nominal, Fit::Sliding, 0.1).unwrap_or(nominal);
    let socket_af = nominal * 1.1 + 1.5;
    let head = s.solid_new(ops::cylinder(head_d / 2.0, head_h)).unwrap();
    s.apply(&head, Json::obj()
        .set("kind", "boolean")
        .set("op", "cut")
        .set("origin", [0.0, 0.0, head_h])
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", socket_af)
        .set("flats", true)
        .set("height", head_h * 0.55))
        .unwrap();
    if shank_len > 0.2 {
        s.apply(&head, ops::boolean("fuse", ops::cylinder(shank_d / 2.0, shank_len), [0.0, 0.0, -shank_len])).unwrap();
    }
    let rh = head_d / 2.0;
    let reach = rh.max(shank_d / 2.0);
    s.done_with(&head, Json::obj().set("nominal", nominal).set("headD", head_d).set("bmin", [-reach, -reach, if shank_len > 0.2 { -shank_len } else { 0.0 }]).set("bmax", [reach, reach, head_h]));
}