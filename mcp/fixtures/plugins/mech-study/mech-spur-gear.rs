//! ---
//! plugin: mech-spur-gear
//! title: Spur gear
//! version: 1
//! description: An external spur gear with true involute teeth, same primitive as the Model tab gear.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"teeth","kind":"count","default":20,"min":6,"max":120,"label":"Teeth"},{"name":"module","kind":"number","default":1.5,"min":0.3,"max":5,"step":0.05,"unit":"mm","label":"Module"},{"name":"thickness","kind":"number","default":6,"min":1,"max":30,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"bore","kind":"number","default":4,"min":0,"max":40,"step":0.1,"unit":"mm","label":"Bore diameter"}]
//! ---
use lime_recipe::gears::Gear;
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 20).range(6, 120).label("Teeth").get();
    let module = s.number("module", 1.5).range(0.3, 5.0).step(0.05).unit("mm").label("Module").get();
    let thickness = s.number("thickness", 6.0).range(1.0, 30.0).step(0.1).unit("mm").label("Thickness").get();
    let bore = s.number("bore", 4.0).range(0.0, 40.0).step(0.1).unit("mm").label("Bore diameter").get();
    let gear = Gear::new(teeth, module);
    let mut spec = Json::obj()
        .set("teeth", gear.teeth)
        .set("module", gear.module)
        .set("thickness", thickness);
    if bore > 0.2 {
        spec = spec.set("bore", bore);
    }
    let part = s.solid_new(Json::obj().set("gear", spec)).unwrap();
    let reach = gear.pitch_radius() + module * (2.0 + gear.shift);
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("teeth", teeth as f64).set("module", module).set("pitchRadius", gear.pitch_radius()).set("bmin", bmin).set("bmax", bmax));
}