//! ---
//! plugin: corpus-mesh-at-end-api-1-10
//! title: Corpus mesh at the end (API 1.10)
//! version: 1
//! description: Bosses and bores on a block, meshed once when the run ends.
//! author: Lime Slice corpus
//! api: 1.10
//! source-sha256: daff8ec471257868f72240d8acddcf8c50b09634717d9cf423f891ec92de0f9c
//! created: 2026-11-09
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    s.mesh_at_end();
    let a = s.solid_new(ops::cuboid(30.0, 20.0, 6.0)).unwrap();
    for i in 0..3 {
        let x = -10.0 + 10.0 * i as f64;
        s.apply(&a, ops::boolean("fuse", ops::cylinder(3.0, 4.0), [x, 0.0, 6.0])).unwrap();
        s.apply(&a, ops::boolean("cut", ops::cylinder(1.0, 12.0), [x, 0.0, 0.0])).unwrap();
    }
    s.done_with(&a, Json::obj().set("bosses", 3));
}
