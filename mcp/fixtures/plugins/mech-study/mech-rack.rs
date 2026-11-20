//! ---
//! plugin: mech-rack
//! title: Gear rack
//! version: 1
//! description: A straight rack with involute teeth along +X, meshing with an external pinion at pitch radius.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"teeth","kind":"count","default":20,"min":3,"max":200,"label":"Teeth shown"},{"name":"module","kind":"number","default":1.5,"min":0.3,"max":5,"step":0.05,"unit":"mm","label":"Module"},{"name":"thickness","kind":"number","default":8,"min":2,"max":40,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"back","kind":"number","default":0,"min":0,"max":20,"step":0.1,"unit":"mm","label":"Bar under roots","help":"0 uses 1.5 modules."}]
//! ---
use lime_recipe::{Json, Session};

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 20).range(3, 200).label("Teeth shown").get();
    let module = s.number("module", 1.5).range(0.3, 5.0).step(0.05).unit("mm").label("Module").get();
    let thickness = s.number("thickness", 8.0).range(2.0, 40.0).step(0.1).unit("mm").label("Thickness").get();
    let back = s.number("back", 0.0).range(0.0, 20.0).step(0.1).unit("mm").label("Bar under roots").get();
    let mut gear = Json::obj()
        .set("teeth", teeth)
        .set("module", module)
        .set("thickness", thickness)
        .set("rack", true);
    if back > 0.05 {
        gear = gear.set("back", back);
    }
    let part = s.solid_new(Json::obj().set("gear", gear)).unwrap();
    let pitch = std::f64::consts::PI * module;
    let u1 = (teeth as f64 - 0.5) * pitch;
    let back_h = if back > 0.05 { back } else { 1.5 * module };
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("teeth", teeth as f64).set("module", module).set("bmin", bmin).set("bmax", bmax));
}