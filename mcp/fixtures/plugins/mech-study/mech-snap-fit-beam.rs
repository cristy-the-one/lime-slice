//! ---
//! plugin: mech-snap-fit-beam
//! title: Snap-fit cantilever
//! version: 1
//! description: A classic cantilever snap finger for a slot; tuned for typical PETG/PLA beam proportions.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"slotWidth","kind":"number","default":6,"min":3,"max":20,"step":0.1,"unit":"mm","label":"Slot width"},{"name":"beamLength","kind":"number","default":12,"min":5,"max":30,"step":0.1,"unit":"mm","label":"Beam length"},{"name":"thickness","kind":"number","default":2.4,"min":1.2,"max":5,"step":0.05,"unit":"mm","label":"Wall thickness"},{"name":"hook","kind":"number","default":1.2,"min":0.4,"max":3,"step":0.05,"unit":"mm","label":"Hook depth"}]
//! ---
use lime_recipe::geom2d::{Poly, Region};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let slot = s.number("slotWidth", 6.0).range(3.0, 20.0).step(0.1).unit("mm").label("Slot width").get();
    let beam = s.number("beamLength", 12.0).range(5.0, 30.0).step(0.1).unit("mm").label("Beam length").get();
    let t = s.number("thickness", 2.4).range(1.2, 5.0).step(0.05).unit("mm").label("Wall thickness").get();
    let hook = s.number("hook", 1.2).range(0.4, 3.0).step(0.05).unit("mm").label("Hook depth").get();
    let base_w = slot + 2.0 * t + 4.0;
    let part = s.solid_new(ops::cuboid(base_w, t + 4.0, 10.0)).unwrap();
    let outline = Poly::new(vec![
        [0.0, 0.0],
        [beam, 0.0],
        [beam, t],
        [beam - hook, t + hook],
        [0.0, t],
    ]);
    let loops = Region::from_poly(&outline).to_loops();
    if let Some(lp) = loops.first() {
        s.apply(&part, Json::obj()
            .set("kind", "extrude")
            .set("op", "fuse")
            .set("origin", [slot / 2.0 + t, 0.0, 0.0])
            .set("depth", 8.0)
            .set("loops", lp.clone()))
            .unwrap();
    }
    let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("slot", slot).set("beam", beam).set("hook", hook).set("bmin", bmin).set("bmax", bmax));
}