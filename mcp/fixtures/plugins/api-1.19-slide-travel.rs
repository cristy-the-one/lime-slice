//! ---
//! plugin: corpus-slide-travel-api-1-19
//! title: Corpus slide travel (API 1.19)
//! version: 1
//! description: Key a slide's travel in millimetres with Aim::Travel, alongside a recipe.
//! author: Lime Slice corpus
//! api: 1.19
//! source-sha256: 300c69072a328b297a4d8dad480bfd97e7ec688582d47c9c2072e99c6c0bfec5
//! created: 2026-11-27
//! target: new
//! params: []
//! ---
use lime_recipe::{anim::{Aim, Animation, Pose}, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let mut animation = Animation::new(4);
    animation.key(0.0, Pose::new().set("Ram", Aim::Travel(0.0)));
    animation.key(1.0, Pose::new().set("Ram", Aim::Travel(12.5)));
    let data = animation.to_json();
    let travel0 = data.at("keys.0.set.Ram").unwrap().as_f64().unwrap();
    let travel1 = data.at("keys.1.set.Ram").unwrap().as_f64().unwrap();
    let a = s.solid_new(ops::cuboid(20.0, 10.0, 10.0)).unwrap();
    s.done_with(&a, Json::obj().set("travel0", travel0).set("travel1", travel1));
}
