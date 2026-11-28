//! ---
//! plugin: corpus-close-loop-api-1-20
//! title: Corpus closed loop (API 1.20)
//! version: 1
//! description: Pin two members of one assembly with Session::close_loop, and keep a point on a line.
//! author: Lime Slice corpus
//! api: 1.20
//! source-sha256: 3e2621d850a9b19cba6960057610c71fd6377fbddc929452661b3ec154b0c893
//! created: 2026-11-28
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let frame = s.solid_new(ops::cuboid(40.0, 10.0, 10.0)).unwrap();
    let a = s.solid_new(ops::cuboid(20.0, 10.0, 10.0)).unwrap();
    let b = s.solid_new(ops::cuboid(20.0, 10.0, 10.0)).unwrap();
    s.attach(&a, &frame, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]).unwrap();
    s.attach(&b, &frame, [20.0, 0.0, 0.0], [0.0, 0.0, 0.0]).unwrap();
    s.hinge(&a, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
    s.hinge(&b, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
    // a's [20, 0, 0] already meets b's origin, and it also lies on the line through that origin along Z.
    s.close_loop(&a, [20.0, 0.0, 0.0], &b, [0.0, 0.0, 0.0]).unwrap();
    s.close_loop_on_line(&a, [20.0, 0.0, 0.0], &b, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
    s.done_with(&frame, Json::obj().set("closed", 1.0));
}
