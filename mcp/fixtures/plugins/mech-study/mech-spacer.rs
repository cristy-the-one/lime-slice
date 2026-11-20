//! ---
//! plugin: mech-spacer
//! title: Cylindrical spacer
//! version: 1
//! description: A round spacer tube or solid disc, for shafts and standoffs.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"od","kind":"number","default":10,"min":3,"max":80,"step":0.1,"unit":"mm","label":"Outer diameter"},{"name":"length","kind":"number","default":12,"min":1,"max":200,"step":0.1,"unit":"mm","label":"Length"},{"name":"id","kind":"number","default":4.2,"min":0,"max":79,"step":0.1,"unit":"mm","label":"Hole diameter","help":"0 for a solid cylinder."},{"name":"hollow","kind":"toggle","default":true,"label":"Through hole"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let od = s.number("od", 10.0).range(3.0, 80.0).step(0.1).unit("mm").label("Outer diameter").get();
    let length = s.number("length", 12.0).range(1.0, 200.0).step(0.1).unit("mm").label("Length").get();
    let id = s.number("id", 4.2).range(0.0, 79.0).step(0.1).unit("mm").label("Hole diameter").get();
    let hollow = s.toggle("hollow", true).label("Through hole").get();
    let r = od / 2.0;
    let part = if id > 0.2 && id < od - 0.4 {
        s.solid_new(Json::obj()
            .set("primitive", "tube")
            .set("radius", r)
            .set("innerRadius", id / 2.0)
            .set("height", length))
            .unwrap()
    } else {
        s.solid_new(ops::cylinder(r, length)).unwrap()
    };
    if hollow && id > 0.2 && id < od - 0.4 {
        s.apply(&part, ops::hole_through([0.0, 0.0, length], [0.0, 0.0, -1.0], id)).unwrap();
    }
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("od", od).set("length", length).set("id", id).set("bmin", bmin).set("bmax", bmax));
}