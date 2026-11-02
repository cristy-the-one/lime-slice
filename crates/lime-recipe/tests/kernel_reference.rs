//! `geom2d` booleans against Open CASCADE: region A is extruded onto a block, then region B is fused, cut, and
//! intersected with it, and each added volume divided by the depth is the area `geom2d` must give.
//! Skips without the kernel; `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use lime_recipe::geom2d::{circle, rect, regular, Poly, Pt, Region, Size};
use lime_recipe::Json;

const DEPTH: f64 = 5.0;
const BLOCK: f64 = 200.0 * 200.0 * 10.0;

fn call(request: Json) -> Json {
    let text = lime_model_occt::tree(&request.to_string());
    Json::parse(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

/// The volume after an op; an op that removes or changes nothing is refused, and then `unchanged` is the answer.
fn volume_or(reply: &Json, unchanged: f64) -> f64 {
    match reply.get("error").and_then(Json::as_str) {
        Some(e) if e.contains("does not change") || e.contains("do not overlap") => unchanged,
        _ => volume(reply),
    }
}

fn volume(reply: &Json) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply.get("volumeMm3").and_then(Json::as_f64).expect("volumeMm3")
}

/// One piece (an outline and its holes) extruded from the block's top face with `op`.
fn extrude(region: &Region, op: &str) -> Json {
    let loops = region.to_loops();
    assert_eq!(loops.len(), 1, "one piece per extrude");
    Json::obj()
        .set("kind", "extrude")
        .set("op", op)
        .set("origin", [100.0, 100.0, 10.0])
        .set("turn", [0.0, 0.0, 0.0])
        .set("depth", DEPTH)
        .set("loops", loops[0].clone())
}

fn apply(key: &str, parent: u32, node: u32, op: Json) -> Json {
    call(Json::obj().set("call", "apply").set("key", key).set("parent", parent).set("node", node).set("op", op))
}

fn poly(pts: &[Pt]) -> Region {
    Region::from_poly(&Poly::new(pts.to_vec()))
}

#[test]
fn booleans_match_the_kernel() {
    let opened = call(Json::obj().set("call", "open").set("key", "geom2d").set("box", [200.0, 200.0, 10.0]));
    if opened.get("error").is_some() {
        assert!(std::env::var_os("LIME_REQUIRE_OCCT").is_none(), "OCCT was required: {opened}");
        eprintln!("skipped: {opened}");
        return;
    }
    assert!((volume(&opened) - BLOCK).abs() < 1e-6);
    let ring = Region::from_poly(&rect(60.0, 60.0)).difference(&Region::from_poly(&rect(24.0, 24.0)));
    let star: Vec<Pt> = (0..10)
        .map(|k| {
            let r = if k % 2 == 0 { 40.0 } else { 15.0 };
            let a = (90.0 + 36.0 * k as f64).to_radians();
            [r * a.cos(), r * a.sin()]
        })
        .collect();
    let comb = poly(&[[-40.0, -30.0], [40.0, -30.0], [40.0, 30.0], [25.0, 30.0], [25.0, -10.0], [10.0, -10.0], [10.0, 30.0], [-10.0, 30.0], [-10.0, -10.0], [-25.0, -10.0], [-25.0, 30.0], [-40.0, 30.0]]);
    let cases: Vec<(&str, Region, Region)> = vec![
        ("L and a square over its notch", poly(&[[-30.0, -30.0], [30.0, -30.0], [30.0, 0.0], [0.0, 0.0], [0.0, 30.0], [-30.0, 30.0]]), Region::from_poly(&rect(30.0, 30.0))),
        ("ring and a bar inside it", ring.clone(), Region::from_poly(&rect(10.0, 80.0).translate(20.0, 0.0))),
        ("star and a circle", Region::from_poly(&Poly::new(star)), Region::from_poly(&circle(28.0, 96))),
        ("comb and a slanted bar", comb, Region::from_poly(&rect(100.0, 12.0).rotate(17.0, [0.0, 0.0]))),
        ("hexagons sharing an edge", Region::from_poly(&regular(6, Size::Side(20.0), [0.0, 0.0], 90.0)), Region::from_poly(&regular(6, Size::Side(20.0), [20.0 * 3f64.sqrt(), 0.0], 90.0))),
        ("square over the ring's hole edge", ring, Region::from_poly(&rect(20.0, 20.0).translate(12.0, 12.0))),
    ];
    let mut node = 1;
    for (name, a, b) in cases.iter() {
        let base = apply("geom2d", 0, node, extrude(a, "fuse"));
        let added_a = volume(&base) - BLOCK;
        assert!((added_a / DEPTH - a.area()).abs() < 1e-6, "{name}: A {} vs {}", added_a / DEPTH, a.area());
        let parent = node;
        let union = volume_or(&apply("geom2d", parent, node + 1, extrude(b, "fuse")), BLOCK + added_a) - BLOCK;
        let cut = volume_or(&apply("geom2d", parent, node + 2, extrude(b, "cut")), BLOCK + added_a) - BLOCK;
        let common = volume_or(&apply("geom2d", parent, node + 3, extrude(b, "common")), 0.0);
        node += 4;
        for (what, kernel, ours) in [("union", union, a.union(b).area()), ("difference", cut, a.difference(b).area()), ("intersection", common, a.intersect(b).area())] {
            assert!((kernel / DEPTH - ours).abs() < 1e-6, "{name}, {what}: kernel {} vs geom2d {}", kernel / DEPTH, ours);
        }
        eprintln!("{name}: union {:.6}, difference {:.6}, intersection {:.6} mm² agree", a.union(b).area(), a.difference(b).area(), a.intersect(b).area());
    }
}
