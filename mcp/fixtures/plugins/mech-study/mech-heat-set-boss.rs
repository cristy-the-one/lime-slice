//! ---
//! plugin: mech-heat-set-boss
//! title: Heat-set insert boss
//! version: 1
//! description: A tapered boss for brass M3 heat-set inserts; bore sized for press-in with print allowance.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":3,"min":2,"max":6,"step":0.1,"unit":"mm","label":"Insert nominal"},{"name":"bossOd","kind":"number","default":6,"min":4,"max":12,"step":0.1,"unit":"mm","label":"Boss OD"},{"name":"height","kind":"number","default":5,"min":3,"max":15,"step":0.1,"unit":"mm","label":"Boss height"},{"name":"taper","kind":"number","default":0.4,"min":0,"max":1.5,"step":0.05,"unit":"mm","label":"Top taper reduction"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{hole, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 3.0).range(2.0, 6.0).step(0.1).unit("mm").label("Insert nominal").get();
    let od = s.number("bossOd", 6.0).range(4.0, 12.0).step(0.1).unit("mm").label("Boss OD").get();
    let height = s.number("height", 5.0).range(3.0, 15.0).step(0.1).unit("mm").label("Boss height").get();
    let taper = s.number("taper", 0.4).range(0.0, 1.5).step(0.05).unit("mm").label("Top taper reduction").get();
    let bore = hole(nominal, Fit::Press, 0.05).unwrap_or(nominal - 0.1);
    let part = s.solid_new(ops::cylinder(od / 2.0, height)).unwrap();
    let top_r = (od - taper).max(bore + 0.8) / 2.0;
    let cone = Json::obj()
        .set("primitive", "cone")
        .set("radius", od / 2.0)
        .set("topRadius", top_r)
        .set("height", height * 0.35);
    s.apply(&part, ops::boolean("fuse", cone, [0.0, 0.0, height * 0.65])).unwrap();
    s.apply(&part, ops::hole([0.0, 0.0, height], [0.0, 0.0, -1.0], bore, height + 0.5)).unwrap();
    let ro = od / 2.0;
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("nominal", nominal).set("bore", bore).set("bmin", bmin).set("bmax", bmax));
}