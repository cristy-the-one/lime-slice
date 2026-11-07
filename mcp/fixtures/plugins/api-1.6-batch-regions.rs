//! ---
//! plugin: corpus-batch-regions-api-1-6
//! title: Corpus batch regions (API 1.6)
//! version: 1
//! description: Batched 2D unions and cuts.
//! author: Lime Slice corpus
//! api: 1.6
//! source-sha256: 5c9ce0b69ecc86d3980d290604eecd3cf5800bfbcde01d21bbbbf0bdf2bc5af8
//! created: 2026-11-07
//! target: new
//! params: []
//! ---
use lime_recipe::{geom2d::{rect, Region}, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let a = Region::from_poly(&rect(4.0, 4.0));
    let b = Region::from_poly(&rect(4.0, 4.0).translate(2.0, 0.0));
    let united = Region::union_all(&[a.clone(), b.clone()]);
    let cut = united.difference_all(&[Region::from_poly(&rect(2.0, 2.0))]);
    let p = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.done_with(&p, Json::obj().set("area", cut.area()));
}
