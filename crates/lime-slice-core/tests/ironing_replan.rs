//! Turning ironing on, or changing it, keeps the cut and re-plans only the
//! layers that iron: a box irons its top layer alone, so every other layer
//! keeps its toolpaths, tour, combing, and join. One test, because the kept
//! slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn cube_stl() -> String {
    let (x0, y0, x1, y1, z1) = (10.0, 10.0, 30.0, 30.0, 3.0);
    let v = [
        [x0, y0, 0.0],
        [x1, y0, 0.0],
        [x1, y1, 0.0],
        [x0, y1, 0.0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
    ];
    let faces = [
        (0, 2, 1),
        (0, 3, 2),
        (4, 5, 6),
        (4, 6, 7),
        (0, 1, 5),
        (0, 5, 4),
        (3, 7, 6),
        (3, 6, 2),
        (0, 4, 7),
        (0, 7, 3),
        (1, 2, 6),
        (1, 6, 5),
    ];
    let mut out = String::from("solid s\n");
    for (i, j, k) in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for p in [v[i], v[j], v[k]] {
            out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid s\n");
    out
}

fn request(extra: Value) -> Value {
    let mut req = json!({
        "filename": "cube.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(cube_stl()),
        "blend": {"mode": "single", "strategy": "speed"},
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

/// The stages reused whole, and the layers the toolpaths, tour, combing,
/// and join took from the kept slice.
fn reuse(reply: &Value) -> (Vec<&str>, [u64; 4]) {
    let st = &reply["stages"];
    let names = st["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let n = |k: &str| st[k].as_u64().unwrap();
    (
        names,
        [
            n("toolpathLayersReused"),
            n("orderLayersReused"),
            n("combLayersReused"),
            n("layersReused"),
        ],
    )
}

fn changed(reply: &Value) -> Vec<u64> {
    reply["previewPatch"]["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["index"].as_u64().unwrap())
        .collect()
}

#[test]
fn an_ironing_change_replans_only_the_top_layer() {
    let steps = [
        json!({}),
        json!({"ironing": {}}),
        json!({"ironing": {"flow": 0.2}}),
        json!({"ironing": {"flow": 0.2, "spacing": 0.15}}),
        json!({}),
    ];
    keep_support_bases(true);
    let mut replies: Vec<Value> = Vec::new();
    for step in &steps {
        let mut extra = step.clone();
        if let Some(last) = replies.last() {
            extra["previewBase"] = last["previewToken"].clone();
        }
        replies.push(slice(&request(extra)));
    }
    keep_support_bases(false);
    let cold: Vec<Value> = steps.iter().map(|s| slice(&request(s.clone()))).collect();

    let part = ["contours", "supports", "supportPaths"].to_vec();
    for k in 1..steps.len() {
        assert!(
            replies[k]["gcode"] == cold[k]["gcode"],
            "step {k}: kept and cold g-code"
        );
        assert_eq!(
            reuse(&replies[k]),
            (part.clone(), [14, 14, 14, 14]),
            "step {k}"
        );
        assert_eq!(changed(&replies[k]), vec![14], "step {k}");
    }
}
