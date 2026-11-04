//! ---
//! plugin: fixture-mod
//! title: Fixture with a module file
//! version: 1
//! description: Brings in another file.
//! author: Fixture Author
//! made-by: fixture-client
//! api: 1.1
//! source-sha256: 71d944edcff7b8279d344fcdd53c7ac727ba41f3bf86b1dbdfd2f2174a7ec14e
//! created: 2026-11-04
//! target: new
//! params: [{"name":"width","kind":"number","default":20,"min":5,"max":80,"unit":"mm","label":"Width"}]
//! ---
use lime_recipe::{ops, Session};
mod helpers;

fn main() {
    let mut s = Session::start();
    let w = s.number("width", 20.0).range(5.0, 80.0).unit("mm").label("Width").get();
    let p = s.solid_new(ops::cuboid(w, 10.0, 4.0)).unwrap();
    s.done(&p);
}
