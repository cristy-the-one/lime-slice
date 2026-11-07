//! ---
//! plugin: corpus-progress-api-1-5
//! title: Corpus progress (API 1.5)
//! version: 1
//! description: A block with host context and progress.
//! author: Lime Slice corpus
//! api: 1.5
//! source-sha256: f1a82fa7d92329e1c2a12c2e1e999968bba6a4c879283dd985157beb9b71dac6
//! created: 2026-11-07
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let host = s.context().get("host").and_then(Json::as_str).unwrap_or("unknown").to_string();
    s.progress(0.5, "halfway");
    let p = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.done_with(&p, Json::obj().set("host", host.as_str()));
}
