//! ---
//! plugin: mech-bearing-housing
//! title: Bearing housing block
//! version: 1
//! description: A block with a bearing seat bore and optional through shaft hole; uses lime_recipe horology bearing tables.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"bearing","kind":"choice","default":"608","label":"Bearing","options":["608","625","626","MR63","MR85"]},{"name":"wall","kind":"number","default":3,"min":1.5,"max":12,"step":0.1,"unit":"mm","label":"Wall thickness"},{"name":"allowance","kind":"number","default":0.15,"min":0,"max":0.5,"step":0.02,"unit":"mm","label":"Seat allowance"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{bearing, Fit};

fn main() {
    let mut s = Session::start();
    let name = s.choice("bearing", &["608", "625", "626", "MR63", "MR85"], "608").label("Bearing").get();
    let wall = s.number("wall", 3.0).range(1.5, 12.0).step(0.1).unit("mm").label("Wall thickness").get();
    let allowance = s.number("allowance", 0.15).range(0.0, 0.5).step(0.02).unit("mm").label("Seat allowance").get();
    let b = bearing(name.as_str()).unwrap_or(bearing("608").unwrap());
    let seat = b.seat(Fit::Press, allowance);
    let dx = b.outer + 2.0 * wall;
    let dy = b.outer + 2.0 * wall;
    let dz = b.width + 2.0 * wall;
    let part = s.solid_new(ops::cuboid(dx, dy, dz)).unwrap();
    s.apply(&part, ops::hole_through([0.0, 0.0, dz], [0.0, 0.0, -1.0], seat)).unwrap();
    s.apply(&part, ops::hole_through([0.0, 0.0, dz], [0.0, 0.0, -1.0], b.bore)).unwrap();
    s.done_with(&part, Json::obj().set("bearing", name.as_str()).set("seat", seat).set("bore", b.bore).set("bmin", [-dx / 2.0, -dy / 2.0, 0.0]).set("bmax", [dx / 2.0, dy / 2.0, dz]));
}