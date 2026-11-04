//! ---
//! plugin: fixture-future
//! title: Fixture from the future
//! version: 1
//! description: Needs a newer recipe API.
//! author: Fixture Author
//! made-by: fixture-client
//! api: 9.0
//! source-sha256: fbe5b9a122aa07b9169bb80eaa3cd42d1ff8fa6995d5d98d2018301ce91cd637
//! created: 2026-11-04
//! target: new
//! params: [{"name":"width","kind":"number","default":20,"min":5,"max":80,"unit":"mm","label":"Width"}]
//! ---
use lime_recipe::{ops, Session};

fn main() {
    let mut s = Session::start();
    let w = s.number("width", 20.0).range(5.0, 80.0).unit("mm").label("Width").get();
    let p = s.solid_new(ops::cuboid(w, 10.0, 4.0)).unwrap();
    s.done(&p);
}
