//! ---
//! plugin: mech-gt2-pulley
//! title: GT2 timing pulley
//! version: 1
//! description: A timing pulley with trapezoidal tooth cuts at 2 mm pitch; approximates GT2 for printed prototypes.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"teeth","kind":"count","default":20,"min":10,"max":60,"label":"Tooth count"},{"name":"pitch","kind":"number","default":2,"min":2,"max":3,"step":0.1,"unit":"mm","label":"Tooth pitch"},{"name":"width","kind":"number","default":8,"min":4,"max":25,"step":0.1,"unit":"mm","label":"Belt width"},{"name":"bore","kind":"number","default":5,"min":3,"max":20,"step":0.1,"unit":"mm","label":"Bore diameter"}]
//! ---
use lime_recipe::geom2d::sin_cos_deg;
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 20).range(10, 60).label("Tooth count").get();
    let pitch = s.number("pitch", 2.0).range(2.0, 3.0).step(0.1).unit("mm").label("Tooth pitch").get();
    let width = s.number("width", 8.0).range(4.0, 25.0).step(0.1).unit("mm").label("Belt width").get();
    let bore = s.number("bore", 5.0).range(3.0, 20.0).step(0.1).unit("mm").label("Bore diameter").get();
    let pitch_d = teeth as f64 * pitch / std::f64::consts::PI;
    let r = pitch_d / 2.0;
    let part = s.solid_new(ops::cylinder(r + pitch * 0.4, width)).unwrap();
    let tooth_w = pitch * 0.45;
    let tooth_h = pitch * 0.6;
    for i in 0..teeth {
        let a = 360.0 * i as f64 / teeth as f64;
        let (sn, cs) = sin_cos_deg(a);
        let x = (r + pitch * 0.15) * cs;
        let y = (r + pitch * 0.15) * sn;
        let _ = s.apply(&part, ops::boolean("cut", ops::cuboid(tooth_w, tooth_h, width * 0.5), [x - tooth_w / 2.0, y, width * 0.25]));
    }
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, width], [0.0, 0.0, -1.0], bore)).unwrap();
    }
    let ro = r + pitch * 0.4;
    s.done_with(&part, Json::obj().set("teeth", teeth as f64).set("pitchDiameter", pitch_d).set("bmin", [-ro, -ro, 0.0]).set("bmax", [ro, ro, width]));
}