//! ---
//! plugin: mech-shaft-collar
//! title: Shaft collar
//! version: 1
//! description: A set-screw shaft collar: short tube with a radial screw hole and optional slit.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"bore","kind":"number","default":8,"min":3,"max":25,"step":0.1,"unit":"mm","label":"Shaft bore"},{"name":"od","kind":"number","default":14,"min":6,"max":40,"step":0.1,"unit":"mm","label":"Outside diameter"},{"name":"width","kind":"number","default":6,"min":3,"max":15,"step":0.1,"unit":"mm","label":"Collar width"},{"name":"screw","kind":"number","default":3,"min":2,"max":6,"step":0.1,"unit":"mm","label":"Set screw"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let bore = s.number("bore", 8.0).range(3.0, 25.0).step(0.1).unit("mm").label("Shaft bore").get();
    let od = s.number("od", 14.0).range(6.0, 40.0).step(0.1).unit("mm").label("Outside diameter").get();
    let width = s.number("width", 6.0).range(3.0, 15.0).step(0.1).unit("mm").label("Collar width").get();
    let screw = s.number("screw", 3.0).range(2.0, 6.0).step(0.1).unit("mm").label("Set screw").get();
    let part = s.solid_new(Json::obj()
        .set("primitive", "tube")
        .set("radius", od / 2.0)
        .set("innerRadius", bore / 2.0)
        .set("height", width))
        .unwrap();
    s.apply(&part, ops::hole([0.0, od / 2.0 - screw, width / 2.0], [0.0, -1.0, 0.0], screw, od)).unwrap();
    s.apply(&part, ops::boolean("cut", ops::cuboid(0.6, od, width + 0.2), [0.0, 0.0, -0.1])).unwrap();
    let ro = od / 2.0;
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("bore", bore).set("od", od).set("bmin", bmin).set("bmax", bmax));
}