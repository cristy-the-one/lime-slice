//! ---
//! plugin: mech-hex-nut
//! title: Hex nut
//! version: 1
//! description: A standard hex nut from nominal size; across-flats from ISO 4032 and tap-drill bore (no modelled thread).
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":6,"min":3,"max":20,"step":1,"unit":"mm","label":"Thread nominal"},{"name":"height","kind":"number","default":5.1,"min":2,"max":20,"step":0.1,"unit":"mm","label":"Nut height"},{"name":"allowance","kind":"number","default":0.1,"min":0,"max":0.5,"step":0.05,"unit":"mm","label":"Bore clearance"}]
//! ---
use lime_recipe::{ops, Json, Session};

/// ISO 4032 width across flats (mm).
fn iso4032_af(nominal_mm: f64) -> Option<f64> {
    match (nominal_mm * 2.0).round() as i32 {
        6 => Some(5.5),
        8 => Some(7.0),
        10 => Some(8.0),
        12 => Some(10.0),
        16 => Some(13.0),
        20 => Some(16.0),
        24 => Some(18.0),
        28 => Some(21.0),
        32 => Some(24.0),
        36 => Some(27.0),
        40 => Some(30.0),
        _ => None,
    }
}

/// Metric tap drill diameter (mm) for through clearance before tapping.
fn tap_drill_mm(nominal_mm: f64) -> Option<f64> {
    match (nominal_mm * 2.0).round() as i32 {
        6 => Some(2.5),
        8 => Some(3.3),
        10 => Some(4.2),
        12 => Some(5.0),
        16 => Some(6.8),
        20 => Some(8.5),
        24 => Some(10.2),
        28 => Some(12.0),
        32 => Some(14.0),
        36 => Some(15.5),
        40 => Some(17.5),
        _ => None,
    }
}

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(3.0, 20.0).step(1.0).unit("mm").label("Thread nominal").get();
    let height = s.number("height", 5.1).range(2.0, 20.0).step(0.1).unit("mm").label("Nut height").get();
    let allowance = s.number("allowance", 0.1).range(0.0, 0.5).step(0.05).unit("mm").label("Bore clearance").get();
    let across = match iso4032_af(nominal) {
        Some(v) => v,
        None => s.refuse("Across-flats unknown for this nominal; use M3–M20 (1 mm step)."),
    };
    let bore = match tap_drill_mm(nominal) {
        Some(d) => d + allowance,
        None => s.refuse("Tap drill unknown for this nominal; use M3–M20 (1 mm step)."),
    };
    let part = s.solid_new(Json::obj()
        .set("primitive", "polygon")
        .set("sides", 6u32)
        .set("across", across)
        .set("flats", true)
        .set("height", height))
        .unwrap();
    s.apply(&part, ops::hole_through([0.0, 0.0, height], [0.0, 0.0, -1.0], bore)).unwrap();
    let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("nominal", nominal).set("across", across).set("bore", bore).set("bmin", bmin).set("bmax", bmax));
}