//! ---
//! plugin: mech-washer
//! title: Flat washer
//! version: 1
//! description: A thin annulus for bolts; ISO 7089 style proportions from nominal bolt size.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":6,"min":2,"max":24,"step":0.5,"unit":"mm","label":"Bolt nominal"},{"name":"thickness","kind":"number","default":1.2,"min":0.4,"max":6,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"allowance","kind":"number","default":0.2,"min":0,"max":1,"step":0.05,"unit":"mm","label":"Hole allowance","help":"Extra on the hole for FDM shrink."}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{hole, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 6.0).range(2.0, 24.0).step(0.5).unit("mm").label("Bolt nominal").get();
    let thickness = s.number("thickness", 1.2).range(0.4, 6.0).step(0.1).unit("mm").label("Thickness").get();
    let allowance = s.number("allowance", 0.2).range(0.0, 1.0).step(0.05).unit("mm").label("Hole allowance").get();
    let bore = hole(nominal, Fit::Running, allowance).unwrap_or(nominal + 0.5);
    let outer = nominal * 2.0 + 1.0;
    let part = s.solid_new(Json::obj()
        .set("primitive", "tube")
        .set("radius", outer / 2.0)
        .set("innerRadius", bore / 2.0)
        .set("height", thickness))
        .unwrap();
    let ro = outer / 2.0;
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("nominal", nominal).set("bore", bore).set("outer", outer).set("bmin", bmin).set("bmax", bmax));
}