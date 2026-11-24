//! ---
//! plugin: corpus-nurbs-surface-api-1-18
//! title: Corpus NURBS surface (API 1.18)
//! version: 1
//! description: A part that starts from an S6 NURBS surface (a weighted bicubic 4 x 4 grid, a U knot inserted, V raised to degree 4), then thickened, from lime_recipe::ops::NurbsSurface.
//! author: Lime Slice corpus
//! api: 1.18
//! source-sha256: e1119a37685008af359b13cbd7e9669fbe104261c31a17c134a8194e29111fb8
//! created: 2026-11-24
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let mut poles: Vec<Vec<[f64; 3]>> = Vec::new();
    for i in 0..4 {
        let mut row: Vec<[f64; 3]> = Vec::new();
        for j in 0..4 {
            let x = -15.0 + 10.0 * i as f64;
            let y = -15.0 + 10.0 * j as f64;
            let inner = (i == 1 || i == 2) && (j == 1 || j == 2);
            row.push([x, y, if inner { 6.0 } else { 0.0 }]);
        }
        poles.push(row);
    }
    let weights = vec![vec![1.0, 1.0, 1.0, 1.0], vec![1.0, 1.5, 1.5, 1.0], vec![1.0, 1.5, 1.5, 1.0], vec![1.0, 1.0, 1.0, 1.0]];
    let surface = ops::NurbsSurface::new(poles).degrees(3, 3).weights(weights).insert_u(0.5, 1).elevate(None, Some(4)).op();
    let part = s.solid_new(Json::obj().set("feature", surface)).unwrap();
    s.apply(&part, ops::thicken(2.0, "both")).unwrap();
    s.done_with(&part, Json::obj().set("thickness", 2.0));
}
