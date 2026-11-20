//! ---
//! plugin: mech-cable-clip
//! title: Cable clip
//! version: 1
//! description: A push-in cable clip with flexible jaws, sized for common wire OD.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"cable","kind":"number","default":5,"min":2,"max":15,"step":0.1,"unit":"mm","label":"Cable OD"},{"name":"baseWidth","kind":"number","default":14,"min":8,"max":40,"step":0.5,"unit":"mm","label":"Base width"},{"name":"height","kind":"number","default":12,"min":6,"max":30,"step":0.1,"unit":"mm","label":"Clip height"},{"name":"screw","kind":"number","default":3.2,"min":0,"max":6,"step":0.1,"unit":"mm","label":"Mount screw","help":"0 for no screw hole."}]
//! ---
use lime_recipe::geom2d::{rect, Region};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let cable = s.number("cable", 5.0).range(2.0, 15.0).step(0.1).unit("mm").label("Cable OD").get();
    let base_w = s.number("baseWidth", 14.0).range(8.0, 40.0).step(0.5).unit("mm").label("Base width").get();
    let height = s.number("height", 12.0).range(6.0, 30.0).step(0.1).unit("mm").label("Clip height").get();
    let screw = s.number("screw", 3.2).range(0.0, 6.0).step(0.1).unit("mm").label("Mount screw").get();
    let gap = cable + 0.6;
    let jaw = gap / 2.0 + 1.5;
    let part = s.solid_new(ops::cuboid(base_w, jaw * 2.0 + 2.0, 3.0)).unwrap();
    let slot = Region::from_poly(&rect(gap, height)).translate(0.0, 0.0);
    let loops = slot.to_loops();
    if let Some(lp) = loops.first() {
        s.apply(&part, Json::obj()
            .set("kind", "extrude")
            .set("op", "cut")
            .set("origin", [0.0, 0.0, 3.0])
            .set("depth", -height)
            .set("loops", lp.clone()))
            .unwrap();
    }
    if screw > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, 3.0], [0.0, 0.0, -1.0], screw)).unwrap();
    }
    let half_y = jaw + 1.0;
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("cable", cable).set("gap", gap).set("bmin", bmin).set("bmax", bmax));
}