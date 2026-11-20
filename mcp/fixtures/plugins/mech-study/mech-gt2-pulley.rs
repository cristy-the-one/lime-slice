//! ---
//! plugin: mech-gt2-pulley
//! title: GT2 timing pulley
//! version: 1
//! description: GT2 timing pulley at 2 mm pitch; trapezoidal tooth cuts toward the centre, full belt width, OD ≈ pitch diameter − 0.51 mm.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"teeth","kind":"count","default":20,"min":10,"max":60,"label":"Tooth count"},{"name":"width","kind":"number","default":8,"min":4,"max":25,"step":0.1,"unit":"mm","label":"Belt width"},{"name":"bore","kind":"number","default":5,"min":3,"max":20,"step":0.1,"unit":"mm","label":"Bore diameter"}]
//! ---
use lime_recipe::geom2d::sin_cos_deg;
use lime_recipe::{ops, Json, Session};

const GT2_PITCH_MM: f64 = 2.0;
const GT2_OD_DELTA_MM: f64 = 0.51;

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 20).range(10, 60).label("Tooth count").get();
    let width = s.number("width", 8.0).range(4.0, 25.0).step(0.1).unit("mm").label("Belt width").get();
    let bore = s.number("bore", 5.0).range(3.0, 20.0).step(0.1).unit("mm").label("Bore diameter").get();
    let pitch_d = teeth as f64 * GT2_PITCH_MM / std::f64::consts::PI;
    let ro = (pitch_d - GT2_OD_DELTA_MM) / 2.0;
    let part = s.solid_new(ops::cylinder(ro, width)).unwrap();
    let tooth_w = GT2_PITCH_MM * 0.45;
    let tooth_h = GT2_PITCH_MM * 0.55;
    for i in 0..teeth {
        let a = 360.0 * i as f64 / teeth as f64;
        let (sn, cs) = sin_cos_deg(a);
        let ri = (ro - tooth_h).max(ro * 0.45);
        let mid_r = (ro + ri) / 2.0;
        let cx = mid_r * cs;
        let cy = mid_r * sn;
        s.apply(&part, Json::obj()
            .set("kind", "boolean")
            .set("op", "cut")
            .set("centre", [cx, cy, width / 2.0])
            .set("primitive", "box")
            .set("dx", tooth_w)
            .set("dy", tooth_h)
            .set("dz", width + 0.2)
            .set("turn", [0.0, 0.0, a]))
            .unwrap();
    }
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, width], [0.0, 0.0, -1.0], bore)).unwrap();
    }
    let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(
        &part,
        Json::obj()
            .set("teeth", teeth as f64)
            .set("pitch", GT2_PITCH_MM)
            .set("pitchDiameter", pitch_d)
            .set("outerDiameter", pitch_d - GT2_OD_DELTA_MM)
            .set("bmin", bmin)
            .set("bmax", bmax),
    );
}