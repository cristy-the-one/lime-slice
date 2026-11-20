//! ---
//! plugin: mech-knob
//! title: Control knob
//! version: 1
//! description: A cylindrical knob with grip flats and a D-flat bore for a potentiometer or shaft.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"diameter","kind":"number","default":20,"min":12,"max":50,"step":0.5,"unit":"mm","label":"Knob diameter"},{"name":"height","kind":"number","default":14,"min":8,"max":40,"step":0.1,"unit":"mm","label":"Height"},{"name":"bore","kind":"number","default":6,"min":3,"max":12,"step":0.1,"unit":"mm","label":"Shaft bore"},{"name":"flats","kind":"count","default":6,"min":0,"max":12,"label":"Grip flats","help":"0 for smooth."}]
//! ---
use lime_recipe::geom2d::sin_cos_deg;
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let diameter = s.number("diameter", 20.0).range(12.0, 50.0).step(0.5).unit("mm").label("Knob diameter").get();
    let height = s.number("height", 14.0).range(8.0, 40.0).step(0.1).unit("mm").label("Height").get();
    let bore = s.number("bore", 6.0).range(3.0, 12.0).step(0.1).unit("mm").label("Shaft bore").get();
    let flats = s.count("flats", 6).range(0, 12).label("Grip flats").get();
    let part = s.solid_new(ops::cylinder(diameter / 2.0, height)).unwrap();
    if flats > 0 {
        let cut_r = diameter / 2.0 - 1.2;
        for k in 0..flats {
            let a = 360.0 * k as f64 / flats as f64;
            let (sn, cs) = sin_cos_deg(a);
            let x = cs * cut_r;
            let y = sn * cut_r;
            let _ = s.apply(&part, ops::boolean("cut", ops::cuboid(2.0, diameter * 0.35, height + 0.2), [x, y, -0.1]));
        }
    }
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, height], [0.0, 0.0, -1.0], bore)).unwrap();
        let flat = bore * 0.85;
        s.apply(&part, ops::boolean("cut", ops::cuboid(bore, flat, height + 0.4), [0.0, bore / 2.0 - flat / 4.0, -0.2])).unwrap();
    }
    let r = diameter / 2.0;
    s.done_with(&part, Json::obj().set("diameter", diameter).set("bore", bore).set("bmin", [-r, -r, 0.0]).set("bmax", [r, r, height]));
}