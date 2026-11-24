//! ---
//! plugin: corpus-organic-surfaces-api-1-18
//! title: Corpus organic surfaces (API 1.18)
//! version: 1
//! description: Exact NURBS profile and spine, kernel sweep, G2, conic and variable fillets, an apex loft, open sheets, sew, thicken, trim, replace and split, patch and blend, from lime_recipe::ops.
//! author: Lime Slice corpus
//! api: 1.18
//! source-sha256: a264b7df22025dd21d550aac3151cf98492c4f1f7f4c1cc2b1b65d9feb0e251f
//! created: 2026-11-23
//! target: new
//! params: []
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let a = s.solid_new(ops::cuboid(40.0, 40.0, 20.0)).unwrap();
    let w = 0.7071067811865476;
    let arc = ops::nurbs_seg(vec![[10.0, 10.0]], Some(vec![1.0, w, 1.0]), Some(2), None, None, [0.0, 10.0]);
    let quarter = Json::obj().set("start", [0.0, 0.0]).set("segments", Json::arr(vec![Json::obj().set("kind", "line").set("to", [10.0, 0.0]), arc, Json::obj().set("kind", "line").set("to", [0.0, 0.0])]));
    s.apply(&a, Json::obj().set("kind", "extrude").set("op", "fuse").set("origin", [0.0, 0.0, 20.0]).set("depth", 4.0).set("loops", Json::arr(vec![quarter]))).unwrap();
    let ring = Json::obj().set("origin", [0.0, 0.0, 20.0]).set("radius", 2.0);
    let spine = ops::curve3d_nurbs(vec![[0.0, 0.0, 20.0], [0.0, 0.0, 30.0], [10.0, 0.0, 30.0]], Some(vec![1.0, w, 1.0]), Some(2), Some(vec![0.0, 1.0]), Some(vec![3, 3]), false);
    s.apply(&a, ops::sweep("fuse", vec![ring.clone()], spine).set("transition", "round").set("scale", Json::arr(vec![Json::from([0.0, 1.0]), Json::from([1.0, 1.5])]))).unwrap();
    let hoop = ops::curve3d_nurbs(vec![[12.0, 0.0, 10.0], [0.0, 12.0, 10.0], [-12.0, 0.0, 10.0], [0.0, -12.0, 10.0]], None, Some(3), None, None, true);
    s.apply(&a, ops::sweep("cut", vec![Json::obj().set("origin", [12.0, 0.0, 10.0]).set("turn", [-90.0, 0.0, 0.0]).set("radius", 1.0)], hoop)).unwrap();
    s.apply(&a, ops::fillet_g2(Json::arr(vec![Json::from(0.0)]), 2.0)).unwrap();
    s.apply(&a, ops::fillet_conic(Json::arr(vec![Json::from(1.0)]), 2.0, 0.6)).unwrap();
    s.apply(&a, ops::fillet_variable(Json::arr(vec![Json::from(2.0)]), &[[0.0, 1.0], [1.0, 3.0]], Some("g1"))).unwrap();
    s.apply(&a, ops::loft("fuse", vec![Json::obj().set("origin", [0.0, 0.0, 20.0]).set("radius", 4.0), ops::loft_apex([0.0, 0.0, 30.0])]).set("maxDegree", 6)).unwrap();
    let line = ops::curve3d_polyline(vec![[-20.0, -20.0, 25.0], [20.0, -20.0, 25.0]], false);
    let cutter = ops::sheet_extrude_spec(line.clone(), [0.0, 1.0, 0.0], 40.0);
    s.apply(&a, ops::trim_split(cutter.clone(), "below")).unwrap();
    s.apply(&a, ops::replace_face(Json::obj().set("normal", [0.0, 0.0, 1.0]).set("nearPoint", [0.0, 0.0, 25.0]), cutter)).unwrap();
    s.apply(&a, ops::split_face(vec![Json::from(0.0)], line.clone(), Some([0.0, 0.0, -1.0]))).unwrap();
    let b = s.solid_new(ops::cuboid(10.0, 10.0, 10.0)).unwrap();
    let square = ops::curve3d_polyline(vec![[-10.0, -10.0, 100.0], [10.0, -10.0, 100.0], [10.0, 10.0, 100.0], [-10.0, 10.0, 100.0]], true);
    s.apply(&b, ops::sheet(ops::sheet_planar_spec(square.clone()))).unwrap();
    s.apply(&b, ops::sheet(ops::sheet_revolve_spec(ops::curve3d_polyline(vec![[30.0, 0.0, 100.0], [30.0, 0.0, 110.0]], false), [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 360.0))).unwrap();
    s.apply(&b, ops::sheet(ops::sheet_loft_spec(vec![line.clone(), ops::curve3d_polyline(vec![[-20.0, 20.0, 25.0], [20.0, 20.0, 25.0]], false)], true))).unwrap();
    s.apply(&b, ops::patch(vec![ops::surface_boundary(Json::arr(vec![Json::from(0.0)]), "g1"), ops::surface_boundary(Json::arr(vec![Json::from(1.0)]), "g0")])).unwrap();
    s.apply(&b, ops::blend_surface(ops::surface_boundary(Json::arr(vec![Json::from(2.0)]), "g1"), ops::surface_boundary(Json::arr(vec![Json::from(3.0)]), "g2"), "g2", 1.0, 1.5)).unwrap();
    s.apply(&b, ops::sew(true, true)).unwrap();
    s.apply(&b, ops::thicken(2.0, "both")).unwrap();
    s.done_with(&a, Json::obj().set("helpers", 20.0));
}
