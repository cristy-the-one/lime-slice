//! ---
//! plugin: corpus-frame-grid-api-1-17
//! title: Corpus frame grid (API 1.17)
//! version: 1
//! description: Read the frame times on the 1/fps grid, on and off it, alongside a recipe.
//! author: Lime Slice corpus
//! api: 1.17
//! source-sha256: 89bdbce5df1b8bf0cbec734396f1922d74560fb5155dbbc6d219f35228bd08c1
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::{anim::frame_times, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let on = frame_times(12, 3.0);
    let off = frame_times(12, 2.95);
    let still = frame_times(8, 0.0);
    let mut on_grid = true;
    let mut k = 0usize;
    while k < on.len() {
        if on[k] != k as f64 / 12.0 { on_grid = false; }
        k += 1;
    }
    let a = s.solid_new(ops::cuboid(12.0, 6.0, 3.0)).unwrap();
    s.done_with(&a, Json::obj().set("frames", on.len()).set("last", on[on.len() - 1]).set("offFrames", off.len()).set("offLast", off[off.len() - 1]).set("still", still.len()).set("onGrid", on_grid));
}
