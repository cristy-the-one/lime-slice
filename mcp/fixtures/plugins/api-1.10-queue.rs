//! ---
//! plugin: corpus-queue-api-1-10
//! title: Corpus queued booleans (API 1.10)
//! version: 1
//! description: Silent and explicit queued booleans, flush, apply_now and queue(false).
//! author: Lime Slice corpus
//! api: 1.10
//! source-sha256: b0ab779583c3563da8b7a26500fd857adc4e2774af14ec05b0c66288bdffd1d5
//! created: 2026-11-09
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(40.0, 20.0, 10.0)).unwrap();
    // Plain cuts whose reply is not read: the host may build them together.
    for i in 0..3 {
        s.apply(&p, ops::boolean("cut", ops::cylinder(2.0, 20.0), [-12.0 + 12.0 * i as f64, 0.0, -5.0])).unwrap();
    }
    // The explicit queue: nothing is built until flush.
    s.apply_later(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [-12.0, 7.0, -5.0])).unwrap();
    s.apply_later(&p, ops::boolean("cut", ops::cuboid(4.0, 4.0, 20.0), [12.0, 7.0, -5.0])).unwrap();
    let c = s.flush(&p).unwrap();
    // A step whose own answer is read.
    let r = s.apply_now(&p, ops::boolean("fuse", ops::cuboid(6.0, 6.0, 4.0), [0.0, 0.0, 10.0])).unwrap();
    s.queue(false);
    s.apply(&p, ops::boolean("cut", ops::cylinder(1.0, 20.0), [0.0, -7.0, -5.0])).unwrap();
    let v = s.volume(&p).unwrap();
    let node = r.get("node").and_then(Json::as_str).unwrap_or("").to_string();
    s.done_with(&p, Json::obj().set("applied", c.applied as f64).set("failed", c.failures.len() as f64).set("lines", c.lines().len() as f64).set("node", node.as_str()).set("volume", v));
}
