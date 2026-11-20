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
//! params: [{"name":"nominal","kind":"number","default":6,"min":3,"max":12,"step":1,"unit":"mm","label":"Thread nominal"},{"name":"shank","kind":"number","default":25,"min":5,"max":100,"step":0.5,"unit":"mm","label":"Shank length"},{"name":"headD","kind":"number","default":10,"min":5,"max":24,"step":0.1,"unit":"mm","label":"Head diameter"},{"name":"headH","kind":"number","default":6,"min":3,"max":15,"step":0.1,"unit":"mm","label":"Head height"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{shaft, Fit};

/// ISO 4762 hex key width across flats (mm) for standard metric sizes.
fn iso4762_key_af(nominal_mm: f64) -> Option<f64> {
    match (nominal_mm * 2.0).round() as i32 {
        6 => Some(2.5),  // M3
        8 => Some(3.0),  // M4
        10 => Some(4.0), // M5
        12 => Some(5.0), // M6
        16 => Some(6.0), // M8
        20 => Some(8.0), // M10
        24 => Some(10.0), // M12
        _ => None,
    }
}

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(3.0, 12.0).step(1.0).unit("mm").label("Thread nominal").get();
    let shank_len = s.number("shank", 25.0).range(5.0, 100.0).step(0.5).unit("mm").label("Shank length").get();
    let head_d = s.number("headD", 10.0).range(5.0, 24.0).step(0.1).unit("mm").label("Head diameter").get();
    let head_h = s.number("headH", 6.0).range(3.0, 15.0).step(0.1).unit("mm").label("Head height").get();
    let socket_af = match iso4762_key_af(nominal) {
        Some(v) => v,
        None => s.refuse("Socket key size unknown for this nominal; use M3–M12 (1 mm step)."),
    };
    let shank_d = shaft(nominal, Fit::Sliding, 0.1).unwrap_or(nominal);
    let head = s.solid_new(ops::cylinder(head_d / 2.0, head_h)).unwrap();
    let socket_depth = head_h * 0.55;
    s.apply(&head, Json::obj()
        .set("kind", "boolean")
        .set("op", "cut")
        .set("origin", [0.0, 0.0, head_h - socket_depth])
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", socket_af)
        .set("flats", true)
        .set("height", socket_depth + 0.02))
        .unwrap();
    if shank_len > 0.2 {
        s.apply(&head, ops::boolean("fuse", ops::cylinder(shank_d / 2.0, shank_len), [0.0, 0.0, -shank_len])).unwrap();
    }
    let (bmin, bmax) = s.bounds(&head).unwrap();
    s.done_with(&head, Json::obj().set("nominal", nominal).set("headD", head_d).set("socketAf", socket_af).set("bmin", bmin).set("bmax", bmax));
}