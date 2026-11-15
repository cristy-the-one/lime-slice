//! ---
//! plugin: corpus-rig-reads-api-1-15
//! title: Corpus rig reads (API 1.15)
//! version: 1
//! description: Name a contact read and the frame times alongside a recipe.
//! author: Lime Slice corpus
//! api: 1.15
//! source-sha256: fccc64f94e21427ded1ece98ca67947ec9ac02282d9a0325fcd4bfc2bfc0485c
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::{anim::{frame_times, ContactAsk, Pose, Touch}, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let times = frame_times(8, 2.0);
    let _ask = ContactAsk::new("Wheel", 1).against("Pallet").max(30.0).tolerance(0.01);
    let _at = Pose::new().set("Anchor", 8.0);
    let none: Option<Touch> = None;
    let a = s.solid_new(ops::cuboid(10.0, 8.0, 4.0)).unwrap();
    s.done_with(&a, Json::obj().set("frames", times.len()).set("last", times[times.len() - 1]).set("touched", none.is_some()));
}
