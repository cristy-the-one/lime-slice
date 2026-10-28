//! The beads a stress study reads: one object's slice, as the G-code writer
//! extrudes it, mapped back onto the part.

use base64::Engine;
use lime_slice_core::{slice_beads, slice_request, Job, SliceRequest, SliceResponse, Watch};
use serde_json::{json, Value};

fn box_stl(x: f64, y: f64, z: f64) -> String {
    let faces = [
        [[0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0]],
        [[0.0, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0]],
        [[0.0, 0.0, z], [x, y, z], [x, 0.0, z]],
        [[0.0, 0.0, z], [0.0, y, z], [x, y, z]],
        [[0.0, 0.0, 0.0], [x, 0.0, z], [x, 0.0, 0.0]],
        [[0.0, 0.0, 0.0], [0.0, 0.0, z], [x, 0.0, z]],
        [[0.0, y, 0.0], [x, y, 0.0], [x, y, z]],
        [[0.0, y, 0.0], [x, y, z], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, 0.0], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, z], [0.0, 0.0, z]],
        [[x, 0.0, 0.0], [x, y, z], [x, y, 0.0]],
        [[x, 0.0, 0.0], [x, 0.0, z], [x, y, z]],
    ];
    let mut out = String::from("solid box\n");
    for face in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for v in face {
            out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid box\n");
    out
}

fn b64(stl: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(stl.as_bytes())
}

fn request(extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": b64(&box_stl(20.0, 10.0, 8.0)),
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
    // A plate request names its files on each object.
    if body.get("objects").is_some() {
        let top = body.as_object_mut().unwrap();
        top.remove("filename");
        top.remove("dataB64");
    }
    serde_json::from_value(body).unwrap()
}

fn beads(req: &SliceRequest) -> SliceResponse {
    slice_beads(req, Job::default(), &Watch::idle()).unwrap()
}

fn to_part(frame: &[[f64; 4]; 4], p: [f64; 3]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (r, row) in frame.iter().take(3).enumerate() {
        out[r] = row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3];
    }
    out
}

/// The part's bead ends, taken back to the part, span its box: inside it
/// within a third of a millimetre, and reaching each face within half one.
fn assert_on_part(reply: &SliceResponse, min: [f64; 3], max: [f64; 3]) {
    let sliced = reply.beads.as_ref().unwrap();
    let part = sliced
        .beads
        .iter()
        .filter(|b| !matches!(b.kind.as_str(), "skirt" | "support" | "support-interface"));
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for bead in part {
        for p in [bead.from, bead.to] {
            let q = to_part(&sliced.frame, p);
            for k in 0..3 {
                lo[k] = lo[k].min(q[k]);
                hi[k] = hi[k].max(q[k]);
            }
        }
    }
    for k in 0..3 {
        assert!(
            lo[k] > min[k] - 0.3 && hi[k] < max[k] + 0.3,
            "axis {k}: beads span {}..{}, part {}..{}",
            lo[k],
            hi[k],
            min[k],
            max[k]
        );
        assert!(
            lo[k] < min[k] + 0.5 && hi[k] > max[k] - 0.5,
            "axis {k}: beads span {lo:?}..{hi:?}, part {min:?}..{max:?}"
        );
    }
}

#[test]
fn a_placed_part_maps_back_to_its_own_frame() {
    let req = request(json!({
        "objects": [{
            "id": "a",
            "filename": "box.stl",
            "dataB64": b64(&box_stl(20.0, 10.0, 8.0)),
            "pose": {
                "rotation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                "pivot": [0.0, 0.0, 0.0],
                "translation": [60.0, 40.0, 0.0]
            }
        }]
    }));
    let reply = beads(&req);
    let sliced = reply.beads.as_ref().unwrap();
    assert_eq!(sliced.layer_normal, [0.0, 0.0, 1.0]);
    // A plate reply's `mesh` is on the bed; each object's view is in its
    // part frame, which is where the frame takes the beads.
    let object = &reply.objects[0];
    assert!(
        reply.mesh.min[0] > 50.0,
        "the pose placed it: {:?}",
        reply.mesh.min
    );
    assert!((object.min[0] + object.offset[0] - reply.mesh.min[0]).abs() < 1e-9);
    assert_on_part(&reply, object.min, object.max);
    // The layer table covers every bead, in order.
    let mut next = 0;
    for layer in &sliced.layers {
        assert_eq!(layer.bead_start, next);
        assert!(sliced.beads[next..next + layer.bead_count]
            .iter()
            .all(|b| b.layer == layer.index));
        next += layer.bead_count;
    }
    assert_eq!(next, sliced.beads.len());
}

#[test]
fn a_belt_slice_maps_back_and_stacks_layers_along_the_belt_normal() {
    let req = request(json!({
        "belt": {
            "angleDeg": 45.0,
            "axis": "z",
            "direction": 1,
            "widthMm": 220.0,
            "copies": 1,
            "gapMm": 0.0,
        }
    }));
    let reply = beads(&req);
    let sliced = reply.beads.as_ref().unwrap();
    // The main plan's §6.1 vector, as `lime-sim`'s `belt_layer_normal` locks it.
    #[allow(clippy::approx_constant)]
    let expect = [0.0, -0.7071067811865476, 0.7071067811865476];
    for (got, want) in sliced.layer_normal.iter().zip(expect) {
        assert!((got - want).abs() < 1e-12, "{:?}", sliced.layer_normal);
    }
    assert_on_part(&reply, [0.0, 0.0, 0.0], [20.0, 10.0, 8.0]);
}

/// A lone belt part keeps its place out of the plan: across the belt the
/// beads carry it as the emit offset, along it not at all. Either way the
/// frame takes them back onto the part.
#[test]
fn a_placed_belt_part_maps_back_to_its_own_frame() {
    let req = request(json!({
        "belt": {
            "angleDeg": 45.0,
            "axis": "z",
            "direction": 1,
            "widthMm": 220.0,
            "copies": 1,
            "gapMm": 0.0,
        },
        "objects": [{
            "id": "a",
            "filename": "box.stl",
            "dataB64": b64(&box_stl(20.0, 10.0, 8.0)),
            "pose": {
                "rotation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                "pivot": [0.0, 0.0, 0.0],
                "translation": [60.0, 40.0, 0.0]
            }
        }]
    }));
    let reply = beads(&req);
    let object = &reply.objects[0];
    assert!(object.offset[0] != 0.0 && object.offset[1] != 0.0, "{:?}", object.offset);
    assert_on_part(&reply, object.min, object.max);
}

#[test]
fn asking_for_beads_changes_no_gcode() {
    let req = request(json!({}));
    let plain = slice_request(&req, Job::default()).unwrap();
    let study = beads(&req);
    assert!(plain.beads.is_none());
    assert!(!plain.gcode.is_empty());
    assert_eq!(plain.gcode, study.gcode);
    assert_eq!(
        serde_json::to_string(&plain.estimate).unwrap(),
        serde_json::to_string(&study.estimate).unwrap()
    );
}

#[test]
fn a_plate_of_two_and_belt_copies_are_refused() {
    let one = json!({"id": "a", "filename": "box.stl", "dataB64": b64(&box_stl(5.0, 5.0, 5.0))});
    let mut two = one.clone();
    two["id"] = json!("b");
    let req = request(json!({ "objects": [one, two] }));
    let err = slice_beads(&req, Job::default(), &Watch::idle()).unwrap_err();
    assert_eq!(
        err,
        "A study slices its object alone. This request has 2 objects."
    );
    let req = request(json!({
        "belt": {"angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 220.0, "copies": 3, "gapMm": 5.0}
    }));
    let err = slice_beads(&req, Job::default(), &Watch::idle()).unwrap_err();
    assert_eq!(err, "A study slices one copy. Set the belt copies to 1.");
}
