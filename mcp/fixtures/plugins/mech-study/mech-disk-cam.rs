//! ---
//! plugin: mech-disk-cam
//! title: Disk cam
//! version: 1
//! description: A disk cam with one radial rise lobe for a follower; single-lobe rise fused on a disc.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"baseRadius","kind":"number","default":20,"min":10,"max":80,"step":0.5,"unit":"mm","label":"Base radius"},{"name":"lift","kind":"number","default":5,"min":1,"max":20,"step":0.1,"unit":"mm","label":"Max lift"},{"name":"thickness","kind":"number","default":8,"min":3,"max":25,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"bore","kind":"number","default":6,"min":3,"max":20,"step":0.1,"unit":"mm","label":"Shaft bore"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let base = s.number("baseRadius", 20.0).range(10.0, 80.0).step(0.5).unit("mm").label("Base radius").get();
    let lift = s.number("lift", 5.0).range(1.0, 20.0).step(0.1).unit("mm").label("Max lift").get();
    let thick = s.number("thickness", 8.0).range(3.0, 25.0).step(0.1).unit("mm").label("Thickness").get();
    let bore = s.number("bore", 6.0).range(3.0, 20.0).step(0.1).unit("mm").label("Shaft bore").get();
    let part = s.solid_new(ops::cylinder(base, thick)).unwrap();
    let lobe_w = base * 0.35;
    s.apply(&part, ops::boolean("fuse", ops::cuboid(lobe_w, lift, thick), [base - lobe_w / 2.0, 0.0, 0.0])).unwrap();
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, thick], [0.0, 0.0, -1.0], bore)).unwrap();
    }
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("base", base).set("lift", lift).set("bmin", bmin).set("bmax", bmax));
}