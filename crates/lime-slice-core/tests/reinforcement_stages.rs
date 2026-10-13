//! Changing only reinforcement replans toolpaths and reuses the contour and
//! support stages. One test: the kept slices are shared by the process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_request, Job, SliceRequest, SliceResponse};
use serde_json::{json, Value};

fn box_stl() -> String {
    let (x, y, z) = (12.0, 12.0, 4.0);
    let v = [
        [0.0, 0.0, 0.0],
        [x, 0.0, 0.0],
        [x, y, 0.0],
        [0.0, y, 0.0],
        [0.0, 0.0, z],
        [x, 0.0, z],
        [x, y, z],
        [0.0, y, z],
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
    for &(i, j, k) in &faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for p in [v[i], v[j], v[k]] {
            out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid s\n");
    out
}

fn request(extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(box_stl()),
        "blend": {"mode": "single", "strategy": "speed"},
        "layerHeight": 0.2,
        "supports": true,
        "supportStyle": "tree",
        "infill": 0,
        "baseline": false,
        "includePreview": true,
        "includeGcode": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn region(density: f64) -> Value {
    json!([{
        "kind": "paint",
        "density": density,
        "depthMm": 3,
        "disks": [{ "p": [6, 6, 4], "n": [0, 0, 1], "r": 3 }],
    }])
}

fn slice(extra: Value) -> SliceResponse {
    let response = slice_request(&request(extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

#[test]
fn changing_reinforcement_reuses_contours_and_supports() {
    keep_support_bases(true);
    let _plain = slice(json!({}));
    let dense = slice(json!({"reinforcement": region(1.0)}));
    let lighter = slice(json!({"reinforcement": region(0.4)}));
    keep_support_bases(false);
    let cold = slice(json!({"reinforcement": region(1.0)}));

    for reply in [&dense, &lighter] {
        let reused = &reply.stages.reused;
        assert!(reused.contains(&"contours"), "{reused:?}");
        assert!(reused.contains(&"supports"), "{reused:?}");
        assert!(reused.contains(&"supportPaths"), "{reused:?}");
        assert!(!reused.contains(&"toolpaths"), "{reused:?}");
    }
    assert_ne!(dense.gcode, lighter.gcode);
    assert_eq!(dense.gcode, cold.gcode, "kept and cold g-code");
}
