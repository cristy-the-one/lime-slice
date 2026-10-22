//! The bridge slices one object and runs a study of it as sliced, in the
//! model frame.

use base64::Engine;
use lime_sim::study::provisional_cards;
use serde_json::{json, Value};

type V = [f64; 3];

/// A closed prism: the polygon `outline` in X–Z (counter-clockwise seen
/// from −Y), extruded from y = 0 to `depth`. Caps are fanned from the first
/// corner, which suits the shapes here.
fn prism_stl(outline: &[[f64; 2]], depth: f64) -> String {
    let mut tris: Vec<[V; 3]> = Vec::new();
    let at = |p: [f64; 2], y: f64| -> V { [p[0], y, p[1]] };
    let n = outline.len();
    for i in 1..n - 1 {
        // y = 0 faces −Y; y = depth faces +Y.
        tris.push([
            at(outline[0], 0.0),
            at(outline[i], 0.0),
            at(outline[i + 1], 0.0),
        ]);
        tris.push([
            at(outline[0], depth),
            at(outline[i + 1], depth),
            at(outline[i], depth),
        ]);
    }
    for i in 0..n {
        let (a, b) = (outline[i], outline[(i + 1) % n]);
        tris.push([at(a, 0.0), at(b, depth), at(b, 0.0)]);
        tris.push([at(a, 0.0), at(a, depth), at(b, depth)]);
    }
    let mut out = String::from("solid p\n");
    for t in tris {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for v in t {
            out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid p\n");
    out
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

fn card() -> Value {
    let mut card = serde_json::to_value(&provisional_cards()[0]).unwrap();
    card.as_object_mut().unwrap().remove("beads");
    card
}

/// The two triangles of the rectangle `a`, `b`, `c`, `d`, counter-clockwise
/// seen from outside the part, as a model's faces wind.
fn quad(a: V, b: V, c: V, d: V) -> Value {
    json!({ "kind": "faces", "triangles": [[a, b, c], [a, c, d]] })
}

fn floats(value: &Value) -> Vec<f32> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap();
    raw.chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn study(body: Value) -> Value {
    let reply: Value =
        serde_json::from_str(&lime_sim_bridge::study_json(&body.to_string())).unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    reply
}

/// A 20 × 6 × 4 bar turned a quarter turn about Z and placed on the bed.
/// The study is given in its own frame, held at x = 0 and pushed down at
/// x = 20, and every point that comes back is in that frame too.
#[test]
fn a_placed_turned_part_answers_in_its_own_frame() {
    let stl = prism_stl(&[[0.0, 0.0], [20.0, 0.0], [20.0, 4.0], [0.0, 4.0]], 6.0);
    let reply = study(json!({
        "request": {
            "objects": [{
                "id": "bar",
                "filename": "bar.stl",
                "dataB64": b64(&stl),
                "pose": {
                    "rotation": [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                    "pivot": [0.0, 0.0, 0.0],
                    "translation": [70.0, 40.0, 0.0]
                }
            }],
            "layerHeight": 0.2, "lineWidth": 0.45, "infill": 1.0,
            "baseline": false, "compare": false, "includePreview": false, "includeGcode": false
        },
        "study": {
            "hXy": 1.0,
            "card": card(),
            "holds": [{ "kind": "region", "region": quad([0.0, 0.0, 0.0], [0.0, 0.0, 4.0], [0.0, 6.0, 4.0], [0.0, 6.0, 0.0]) }],
            "loads": [{ "kind": "force", "region": quad([20.0, 0.0, 0.0], [20.0, 6.0, 0.0], [20.0, 6.0, 4.0], [20.0, 0.0, 4.0]), "force": [0.0, 0.0, -5.0] }],
            "constraints": [{ "kind": "maxDeflectionMm", "value": 1.0 }, { "kind": "minSafetyFactor", "value": 2.0 }],
            "checkResolution": false
        }
    }));
    let positions = floats(&reply["surface"]["positionsB64"]);
    let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for p in positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    // The model's box, to the grid's half cell.
    let expect = [[0.0, 20.0], [0.0, 6.0], [0.0, 4.0]];
    for k in 0..3 {
        assert!(
            (f64::from(lo[k]) - expect[k][0]).abs() < 0.8,
            "axis {k}: {lo:?} {hi:?}"
        );
        assert!(
            (f64::from(hi[k]) - expect[k][1]).abs() < 0.8,
            "axis {k}: {lo:?} {hi:?}"
        );
    }
    // The tip, at x = 20 in the model frame, moves most, and moves down.
    let margins = reply["report"]["margins"].as_array().unwrap();
    let tip = margins[0]["hotSpot"]["at"].as_array().unwrap();
    assert!((tip[0].as_f64().unwrap() - 20.0).abs() < 1.0, "{tip:?}");
    let disp = floats(&reply["surface"]["displacementB64"]);
    let lowest = disp.chunks_exact(3).map(|u| u[2]).fold(0.0f32, f32::min);
    assert!(lowest < 0.0);
    // The bending peak is at the held root.
    let root = margins[1]["hotSpot"]["at"].as_array().unwrap();
    assert!(root[0].as_f64().unwrap() < 4.0, "{root:?}");
    assert_eq!(reply["report"]["representation"], "sliced");
    assert_eq!(
        reply["surface"]["triangles"].as_u64().unwrap() as usize * 9,
        positions.len()
    );
}

/// An L bracket: a 40 × 10 × 4 foot and a 4 × 10 × 30 upright at one end,
/// standing on its foot and pushed sideways at the top. Its weakest point is
/// the corner of the L.
#[test]
fn a_bracket_is_weakest_at_the_corner_of_its_l() {
    let outline = [
        [0.0, 0.0],
        [40.0, 0.0],
        [40.0, 4.0],
        [4.0, 4.0],
        [4.0, 30.0],
        [0.0, 30.0],
    ];
    let stl = prism_stl(&outline, 10.0);
    let reply = study(json!({
        "request": {
            "filename": "bracket.stl", "dataB64": b64(&stl),
            "layerHeight": 0.2, "lineWidth": 0.45, "infill": 1.0,
            "baseline": false, "compare": false, "includePreview": false, "includeGcode": false
        },
        "study": {
            "hXy": 1.2,
            "card": card(),
            "holds": [{ "kind": "bed" }],
            "loads": [{ "kind": "force", "region": quad([0.0, 0.0, 30.0], [4.0, 0.0, 30.0], [4.0, 10.0, 30.0], [0.0, 10.0, 30.0]), "force": [2.0, 0.0, 0.0] }],
            "constraints": [{ "kind": "minSafetyFactor", "value": 2.0 }],
            "checkResolution": false
        }
    }));
    let spot = &reply["report"]["margins"][0]["hotSpot"];
    let at: Vec<f64> = spot["at"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    // In the upright's root, just above the foot: not up the arm, not out on the foot.
    assert!(
        at[0] < 6.0 && at[2] > 2.0 && at[2] < 10.0,
        "hot spot at {at:?}"
    );
    assert!(spot["layer"].is_u64());
}

#[test]
fn a_refusal_is_a_sentence() {
    let reply: Value = serde_json::from_str(&lime_sim_bridge::study_json("{}")).unwrap();
    assert_eq!(reply["ok"], false);
    assert!(reply["reason"]
        .as_str()
        .unwrap()
        .starts_with("The study could not be read."));
}
