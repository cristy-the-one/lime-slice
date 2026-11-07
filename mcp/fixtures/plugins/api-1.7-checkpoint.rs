//! ---
//! plugin: corpus-checkpoint-api-1-7
//! title: Corpus checkpoint (API 1.7)
//! version: 1
//! description: A resumable two-part recipe.
//! author: Lime Slice corpus
//! api: 1.7
//! source-sha256: 2eb2a15acc17b4163d2feeab1e6ab50ca324aabfc146e0134d0ce1bd4655603b
//! created: 2026-11-07
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let a = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.checkpoint().unwrap();
    let _b = s.solid_new(ops::cuboid(6.0, 4.0, 2.0)).unwrap();
    s.done_with(&a, Json::obj().set("parts", 2));
}
