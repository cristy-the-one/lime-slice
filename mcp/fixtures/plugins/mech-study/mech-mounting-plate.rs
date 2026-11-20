//! ---
//! plugin: mech-mounting-plate
//! title: Mounting plate
//! version: 1
//! description: A rectangular plate with a bolt-hole pattern on a pitch circle or grid, and optional centre bore.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"width","kind":"number","default":80,"min":30,"max":250,"step":0.5,"unit":"mm","label":"Width"},{"name":"depth","kind":"number","default":60,"min":20,"max":200,"step":0.5,"unit":"mm","label":"Depth"},{"name":"thickness","kind":"number","default":4,"min":2,"max":15,"step":0.1,"unit":"mm","label":"Thickness"},{"name":"holes","kind":"count","default":4,"min":0,"max":12,"label":"Bolt holes"},{"name":"holeD","kind":"number","default":4.2,"min":2,"max":12,"step":0.1,"unit":"mm","label":"Hole diameter"},{"name":"pcd","kind":"number","default":0,"min":0,"max":200,"step":0.5,"unit":"mm","label":"PCD","help":"0 lays holes on a rectangle inset from edges."}]
//! ---
use lime_recipe::geom2d::sin_cos_deg;
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let w = s.number("width", 80.0).range(30.0, 250.0).step(0.5).unit("mm").label("Width").get();
    let d = s.number("depth", 60.0).range(20.0, 200.0).step(0.5).unit("mm").label("Depth").get();
    let t = s.number("thickness", 4.0).range(2.0, 15.0).step(0.1).unit("mm").label("Thickness").get();
    let holes = s.count("holes", 4).range(0, 12).label("Bolt holes").get();
    let hole_d = s.number("holeD", 4.2).range(2.0, 12.0).step(0.1).unit("mm").label("Hole diameter").get();
    let pcd = s.number("pcd", 0.0).range(0.0, 200.0).step(0.5).unit("mm").label("PCD").get();
    let part = s.solid_new(ops::cuboid(w, d, t)).unwrap();
    if holes > 0 {
        if pcd > 1.0 {
            for i in 0..holes {
                let a = 360.0 * i as f64 / holes as f64;
                let (sn, cs) = sin_cos_deg(a);
                let x = pcd / 2.0 * cs;
                let y = pcd / 2.0 * sn;
                s.apply(&part, ops::hole_through([x, y, t], [0.0, 0.0, -1.0], hole_d)).unwrap();
            }
        } else {
            let inset = 8.0;
            let xs = [-w / 2.0 + inset, w / 2.0 - inset];
            let ys = [-d / 2.0 + inset, d / 2.0 - inset];
            let mut n = 0u32;
            'outer: for &x in &xs {
                for &y in &ys {
                    s.apply(&part, ops::hole_through([x, y, t], [0.0, 0.0, -1.0], hole_d)).unwrap();
                    n += 1;
                    if n >= holes { break 'outer; }
                }
            }
        }
    }
        let (bmin, bmax) = s.bounds(&part).unwrap();
    s.done_with(&part, Json::obj().set("holes", holes as f64).set("pcd", pcd).set("bmin", bmin).set("bmax", bmax));
}