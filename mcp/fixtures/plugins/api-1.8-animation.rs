//! ---
//! plugin: corpus-animation-api-1-8
//! title: Corpus animation (API 1.8)
//! version: 1
//! description: Build an animation alongside a recipe.
//! author: Lime Slice corpus
//! api: 1.8
//! source-sha256: fc73f912d23a1069f8be63868cea4f16a4800718e0b6c6fe2cb3c6fde2d21265
//! created: 2026-11-08
//! target: new
//! params: []
//! ---
use lime_recipe::{anim::{Animation, Aim, Pose}, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let mut animation = Animation::new(12);
    animation.key(0.0, Pose::rest().set("Arm", Aim::Aligned).colour("Arm", "#ff0000"));
    let a = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.done_with(&a, Json::obj().set("fps", animation.to_json().get("fps").unwrap().clone()));
}
