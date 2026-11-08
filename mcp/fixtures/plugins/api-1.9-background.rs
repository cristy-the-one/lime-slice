//! ---
//! plugin: corpus-background-api-1-9
//! title: Corpus animation background (API 1.9)
//! version: 1
//! description: Choose an animation's background alongside a recipe.
//! author: Lime Slice corpus
//! api: 1.9
//! source-sha256: cb067def9be4ce86d53fd2129b5cef46d1da7c09de08804661ac837bc3fcd6c2
//! created: 2026-11-08
//! target: new
//! params: []
//! ---
use lime_recipe::{anim::Animation, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let mut animation = Animation::new(12);
    animation.background("#204060");
    let a = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.done_with(&a, Json::obj().set("background", animation.to_json().get("background").unwrap().clone()));
}
