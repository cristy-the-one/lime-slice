//! Part beads that stand on nothing, on synthetic belt and flat-bed parts.
//! Each part is a side-view profile in Y and Z, extruded across the belt.

use base64::Engine;
use lime_slice_core::{slice_request, Job, PartHold, SliceRequest};
use serde_json::{json, Value};

/// Ear clipping of a simple counter-clockwise polygon.
fn triangulate(poly: &[[f64; 2]]) -> Vec<[usize; 3]> {
    let cross = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let mut left: Vec<usize> = (0..poly.len()).collect();
    let mut out = Vec::new();
    while left.len() > 3 {
        let n = left.len();
        let ear = (0..n)
            .find(|&i| {
                let (a, b, c) = (left[(i + n - 1) % n], left[i], left[(i + 1) % n]);
                cross(poly[a], poly[b], poly[c]) > 1e-12
                    && left.iter().all(|&p| {
                        p == a
                            || p == b
                            || p == c
                            || !(cross(poly[a], poly[b], poly[p]) >= 0.0
                                && cross(poly[b], poly[c], poly[p]) >= 0.0
                                && cross(poly[c], poly[a], poly[p]) >= 0.0)
                    })
            })
            .expect("a simple polygon has an ear");
        out.push([left[(ear + n - 1) % n], left[ear], left[(ear + 1) % n]]);
        left.remove(ear);
    }
    out.push([left[0], left[1], left[2]]);
    out
}

/// A counter-clockwise side view (Y, Z) extruded from X 0 to `width`.
fn profile_stl(profile: &[[f64; 2]], width: f64) -> String {
    let p3 = |p: [f64; 2], x: f64| [x, p[0], p[1]];
    let mut faces: Vec<[[f64; 3]; 3]> = Vec::new();
    for [a, b, c] in triangulate(profile) {
        // The side view seen from +X is counter-clockwise, so +X is outward there.
        faces.push([p3(profile[a], width), p3(profile[b], width), p3(profile[c], width)]);
        faces.push([p3(profile[a], 0.0), p3(profile[c], 0.0), p3(profile[b], 0.0)]);
    }
    for i in 0..profile.len() {
        let (a, b) = (profile[i], profile[(i + 1) % profile.len()]);
        faces.push([p3(a, 0.0), p3(b, 0.0), p3(b, width)]);
        faces.push([p3(a, 0.0), p3(b, width), p3(a, width)]);
    }
    let mut out = String::from("solid part\n");
    for face in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for v in face {
            out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid part\n");
    out
}

fn request(stl: &str, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "part.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn ir3() -> Value {
    json!({ "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0, "copies": 1, "gapMm": 5.0 })
}

fn hold(stl: &str, extra: Value) -> PartHold {
    let mut extra = extra;
    extra["partHold"] = json!(true);
    let response = slice_request(&request(stl, extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response.part_hold.expect("asked for partHold")
}

/// A wall at low Y with an arm toward +Y. Its underside rises at
/// `underside_deg` from the belt toward +Y: 45° lays it in one nozzle plane,
/// so the arm is born in the air; 0° is a flat roof at the support limit;
/// below 0° the underside is a wall to the slicer.
fn wall_and_arm(underside_deg: f64) -> String {
    let (root, reach) = (12.0, 10.0);
    let tip = root + reach * underside_deg.to_radians().tan();
    let top = root.max(tip) + 3.0;
    profile_stl(
        &[
            [0.0, 0.0],
            [4.0, 0.0],
            [4.0, root],
            [4.0 + reach, tip],
            [4.0 + reach, top],
            [0.0, top],
        ],
        20.0,
    )
}

#[test]
fn a_box_on_the_belt_stands_on_itself() {
    let part = hold(
        &profile_stl(&[[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]], 20.0),
        json!({ "belt": ir3() }),
    );
    assert!(part.part_mm > 1000.0, "{part:?}");
    assert!(part.unheld_mm < 0.01 * part.part_mm, "{part:?}");
}

#[test]
fn an_arm_born_in_one_nozzle_plane_stands_on_nothing() {
    let part = hold(&wall_and_arm(45.0), json!({ "belt": ir3() }));
    let lip = &part.largest[0];
    // The arm is 20 mm across and reaches 14 mm along its first plane.
    assert!(lip.mm > 100.0, "{part:?}");
    assert!(lip.layers[1] - lip.layers[0] <= 3, "{part:?}");
    assert!(lip.at[2] > 11.0 && lip.at[2] < 23.0, "{part:?}");
    assert!(part.dangling_mm > 0.5 * lip.mm, "{part:?}");
}

#[test]
fn an_underside_that_is_a_wall_to_the_slicer_holds_its_rows() {
    let born = hold(&wall_and_arm(45.0), json!({ "belt": ir3() }));
    let steep = hold(&wall_and_arm(-30.0), json!({ "belt": ir3() }));
    // What is left on both is top skin bridging over sparse infill.
    assert!(
        steep.largest[0].mm < 0.2 * born.largest[0].mm && steep.unheld_mm < 0.35 * born.unheld_mm,
        "born {born:?}\nsteep {steep:?}"
    );
}

#[test]
fn a_flat_overhang_on_a_bed_stands_on_nothing() {
    // A T in the side view on a flat bed: a 10 mm shelf at Z 10.
    let t = profile_stl(
        &[
            [8.0, 0.0],
            [12.0, 0.0],
            [12.0, 10.0],
            [20.0, 10.0],
            [20.0, 12.0],
            [0.0, 12.0],
            [0.0, 10.0],
            [8.0, 10.0],
        ],
        20.0,
    );
    let part = hold(&t, json!({}));
    // The shelf's first layer on both sides of the stem. Skin over sparse
    // infill above it bridges between infill lines and counts too.
    let shelf: Vec<_> = part
        .largest
        .iter()
        .filter(|p| p.layers[0] == 50 && (p.at[2] - 10.2).abs() < 0.05)
        .collect();
    assert_eq!(shelf.len(), 2, "{part:?}");
    assert!(shelf.iter().all(|p| p.mm > 300.0), "{part:?}");
}

#[test]
fn the_check_leaves_the_gcode_alone() {
    let stl = wall_and_arm(45.0);
    let plain = slice_request(&request(&stl, json!({ "belt": ir3() })), Job::default()).unwrap();
    let checked = slice_request(
        &request(&stl, json!({ "belt": ir3(), "partHold": true })),
        Job::default(),
    )
    .unwrap();
    assert!(plain.part_hold.is_none());
    assert!(checked.part_hold.is_some());
    assert_eq!(plain.gcode, checked.gcode);
    let wire = serde_json::to_value(&plain).unwrap();
    assert!(wire.get("partHold").is_none());
}
