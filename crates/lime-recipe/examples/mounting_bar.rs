// A mounting bar: a row of through holes, then a top-edge fillet only when
// the bar is long enough to need one. One `recipe_run`; in JSON ops it is a
// probe-and-apply round trip per hole and per decision.
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let width = s.param_f64("width", 60.0);
    let holes = s.param_u32("holes", 4);
    let part = match s.solid_new(ops::cuboid(width, 20.0, 4.0)) {
        Ok(p) => p,
        Err(e) => panic!("{e}"),
    };
    let mut drilled = 0;
    for i in 0..holes {
        let x = -width / 2.0 + width * (i as f64 + 0.5) / holes as f64;
        if s.apply(&part, ops::hole_through([x, 0.0, 4.0], [0.0, 0.0, -1.0], 3.2)).is_ok() {
            drilled += 1;
        }
    }
    if width >= 50.0 {
        // The edges round the top face.
        let top = Json::obj().set("normal", [0.0, 0.0, 1.0]).set("nearPoint", [0.0, 0.0, 4.0]);
        let edges = Json::obj().set("select", Json::obj().set("onFace", top));
        if let Err(e) = s.apply(&part, ops::fillet(edges, 1.0)) {
            s.log(&format!("fillet skipped: {}", e.reason));
        }
    }
    s.done_with(&part, Json::obj().set("holes", drilled));
}
