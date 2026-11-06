//! ---
//! plugin: corpus-bar-api-1-0
//! title: Corpus bar (API 1.0)
//! version: 1
//! description: A bar with pegs and a rib, read with param_*.
//! author: Lime Slice corpus
//! made-by: lime-slice-corpus
//! api: 1.0
//! lust: c2c1a430
//! source-sha256: 32b83bff97e820dec7cfb44e91dd3250dabde05b57ee2de343aaf1b48fe718b7
//! created: 2026-11-06
//! target: new
//! params: [{"name":"length","kind":"number","default":60},{"name":"pegs","kind":"count","default":4},{"name":"rib","kind":"toggle","default":true}]
//! ---
use lime_recipe::{ops, Json, Session};

// Recipe API 1.0: values read with param_*, the calls, a read, and a metric.
fn main() {
    let mut s = Session::start();
    let length = s.param_f64("length", 60.0);
    let pegs = s.param_u32("pegs", 4);
    let rib = s.param_bool("rib", true);
    let bar = s.solid_new(ops::cuboid(length, 12.0, 6.0)).unwrap();
    for i in 0..pegs {
        let x = -length / 2.0 + length * (i as f64 + 0.5) / pegs as f64;
        s.apply(&bar, ops::boolean("fuse", ops::cylinder(2.0, 4.0), [x, 0.0, 6.0])).unwrap();
    }
    if rib {
        s.apply(&bar, ops::boolean("fuse", ops::cuboid(length, 2.0, 3.0), [0.0, -7.0, 0.0])).unwrap();
    }
    let v = s.volume(&bar).unwrap();
    s.log("bar built");
    s.done_with(&bar, Json::obj().set("pegs", pegs).set("volume", v));
}
