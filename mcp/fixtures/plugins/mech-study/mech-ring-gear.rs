//! ---
//! plugin: mech-ring-gear
//! title: Ring gear
//! version: 1
//! description: An internal ring gear for planetary trains; mates with an external pinion at m(z_ring - z_pinion)/2.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"teeth","kind":"count","default":36,"min":20,"max":120,"label":"Teeth"},{"name":"module","kind":"number","default":1,"min":0.3,"max":5,"step":0.05,"unit":"mm","label":"Module"},{"name":"thickness","kind":"number","default":6,"min":1,"max":30,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"rim","kind":"number","default":0,"min":0,"max":200,"step":0.5,"unit":"mm","label":"Outside diameter","help":"0 uses two modules outside the roots."}]
//! ---
use lime_recipe::{Json, Session};

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 36).range(20, 120).label("Teeth").get();
    let module = s.number("module", 1.0).range(0.3, 5.0).step(0.05).unit("mm").label("Module").get();
    let thickness = s.number("thickness", 6.0).range(1.0, 30.0).step(0.1).unit("mm").label("Thickness").get();
    let rim = s.number("rim", 0.0).range(0.0, 200.0).step(0.5).unit("mm").label("Outside diameter").get();
    let mut gear = Json::obj()
        .set("teeth", teeth)
        .set("module", module)
        .set("thickness", thickness)
        .set("internal", true);
    if rim > 0.5 {
        gear = gear.set("rim", rim);
    }
    let part = s.solid_new(Json::obj().set("gear", gear)).unwrap();
    let od = if rim > 0.5 { rim } else { module * (teeth as f64 + 4.0) };
    s.done_with(&part, Json::obj().set("teeth", teeth as f64).set("module", module).set("bmin", [-od / 2.0, -od / 2.0, 0.0]).set("bmax", [od / 2.0, od / 2.0, thickness]));
}