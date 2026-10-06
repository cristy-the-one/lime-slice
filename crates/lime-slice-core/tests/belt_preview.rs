//! A belt preview is named, and a later slice of the same belt can be a patch.
//! Copies, axis, direction, and the gap are part of the name. G-code stays
//! the belt file. One test: the kept slices are shared by the process.

use std::collections::HashMap;

use base64::Engine;
use lime_slice_core::{
    keep_support_bases, slice_payload, slice_request, Job, PreviewLayer, SliceCache, SliceRequest,
    SliceResponse,
};
use serde_json::{json, Value};

fn box_stl() -> String {
    let (x, y, z) = (10.0, 10.0, 2.0);
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

fn belt(copies: u32, gap: f64, axis: &str, direction: i32) -> Value {
    json!({
        "angleDeg": 45.0,
        "axis": axis,
        "direction": direction,
        "widthMm": 220.0,
        "copies": copies,
        "gapMm": gap,
    })
}

fn request(extra: Value) -> SliceRequest {
    let stl = box_stl();
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
        "belt": belt(1, 5.0, "z", 1),
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn slice(extra: Value) -> SliceResponse {
    slice_request(&request(extra), Job::start()).unwrap()
}

fn tilted(layer: &PreviewLayer) {
    let step = 0.2 * std::f64::consts::SQRT_2;
    assert!(
        (layer.z - step).abs() < 1e-3 || layer.z.abs() > step - 1e-3,
        "layer z {} is not a belt position",
        layer.z
    );
    let spread = layer.paths.iter().any(|path| {
        let zs: Vec<f64> = path.zs.iter().copied().filter(|z| z.is_finite()).collect();
        zs.len() >= 2 && zs.iter().copied().fold(f64::MIN, f64::max) - zs.iter().copied().fold(f64::MAX, f64::min) > 0.05
    });
    assert!(spread, "preview points are not tilted");
}

fn apply(base: &[PreviewLayer], reply: &SliceResponse) -> Vec<PreviewLayer> {
    let patch = reply.preview_patch.as_ref().expect("patch");
    let by_index: HashMap<usize, &PreviewLayer> = base.iter().map(|layer| (layer.index, layer)).collect();
    let changed: HashMap<usize, _> = patch
        .changed
        .iter()
        .map(|layer| (layer.layer.index, layer))
        .collect();
    patch
        .layers
        .iter()
        .map(|index| {
            let Some(fresh) = changed.get(index) else {
                return (*by_index.get(index).expect("base layer")).clone();
            };
            let was = by_index.get(index);
            let mut paths = Vec::with_capacity(fresh.order.len());
            for ord in &fresh.order {
                if *ord >= 0 {
                    paths.push(was.expect("base path").paths[*ord as usize].clone());
                } else {
                    let at = (-1 - *ord) as usize;
                    paths.push(fresh.layer.paths[at].clone());
                }
            }
            let mut layer = fresh.layer.clone();
            layer.paths = paths;
            layer
        })
        .collect()
}

fn same_preview(a: &[PreviewLayer], b: &[PreviewLayer]) {
    assert_eq!(a.len(), b.len());
    for (left, right) in a.iter().zip(b) {
        assert_eq!(left.index, right.index);
        assert!((left.z - right.z).abs() < 1e-9, "{} vs {}", left.z, right.z);
        assert_eq!(left.paths, right.paths);
    }
}

#[test]
fn a_belt_preview_patches_until_the_belt_stamp_changes() {
    let _off = KeepGuard;
    keep_support_bases(false);
    let cold = slice(json!({}));
    assert!(cold.preview_token.is_none(), "an unkept belt slice has no token");
    assert!(cold.preview_patch.is_none());
    tilted(&cold.layers[0]);

    keep_support_bases(true);
    let first = slice(json!({}));
    let token = first.preview_token.clone().expect("kept belt slice names its preview");
    assert!(first.preview_patch.is_none());
    assert_eq!(first.gcode, cold.gcode, "naming the preview changed the g-code");
    same_preview(&first.layers, &cold.layers);

    let again = slice(json!({ "previewBase": token }));
    let patch = again.preview_patch.expect("the same belt is a patch");
    assert!(again.layers.is_empty());
    assert_eq!(again.preview_token.as_deref(), Some(token.as_str()));
    assert!(patch.changed.is_empty(), "nothing moved: {:?}", patch.changed.len());
    assert_eq!(patch.layers.len(), first.layers.len());
    assert_eq!(again.gcode, first.gcode);

    let retimed = slice(json!({ "previewBase": token, "featureSpeeds": false }));
    let moved = retimed.preview_patch.as_ref().expect("a speed change on the same belt is a patch");
    assert!(retimed.layers.is_empty());
    assert_ne!(retimed.preview_token.as_deref(), Some(token.as_str()));
    assert!(!moved.changed.is_empty(), "feature speeds did not change a layer");
    keep_support_bases(false);
    let cold_slow = slice(json!({ "featureSpeeds": false }));
    same_preview(&apply(&first.layers, &retimed), &cold_slow.layers);
    assert_eq!(cold_slow.gcode, retimed.gcode);

    for (label, extra) in [
        ("copies", json!({ "belt": belt(2, 5.0, "z", 1) })),
        ("gap", json!({ "belt": belt(1, 20.0, "z", 1) })),
        ("direction", json!({ "belt": belt(1, 5.0, "z", -1) })),
        ("axis", json!({ "belt": belt(1, 5.0, "y", 1) })),
    ] {
        keep_support_bases(true);
        let named = slice(json!({}));
        let token = named.preview_token.expect("token");
        let mut body = extra;
        body["previewBase"] = json!(token);
        let reply = slice(body);
        assert!(
            reply.preview_patch.is_none(),
            "{label} reused a patch: {:?}",
            reply.preview_token
        );
        assert!(!reply.layers.is_empty(), "{label} sent no preview");
        assert_ne!(reply.preview_token.as_deref(), Some(token.as_str()), "{label}");
        tilted(&reply.layers[0]);
    }

    let dir = std::env::temp_dir().join(format!("lime-belt-preview-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = SliceCache::new(&dir, 1 << 26);
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(box_stl().as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": false,
        "belt": belt(1, 5.0, "z", 1),
    });
    let stored = slice_payload(&body.to_string(), Some(&cache), Job::start(), |g| g.text()).unwrap();
    cache.flush();
    let stored: Value = serde_json::from_str(&stored).unwrap();
    body["previewBase"] = stored["previewToken"].clone();
    body["featureSpeeds"] = json!(false);
    let patched = slice_payload(&body.to_string(), Some(&cache), Job::start(), |g| g.text()).unwrap();
    cache.flush();
    let patched: Value = serde_json::from_str(&patched).unwrap();
    assert!(patched["previewPatch"].is_object(), "{patched}");
    keep_support_bases(false);
    let hit = slice_payload(&body.to_string(), Some(&cache), Job::start(), |g| g.text()).unwrap();
    let hit: Value = serde_json::from_str(&hit).unwrap();
    assert!(hit["fromCache"].as_bool().unwrap_or(false), "the patch was not stored");
    assert!(hit.get("previewPatch").is_none() || hit["previewPatch"].is_null());
    let z = hit["layers"][0]["z"].as_f64().unwrap();
    let step = 0.2 * std::f64::consts::SQRT_2;
    assert!((z - step).abs() < 1e-3, "stored belt preview z {z}");
    let _ = std::fs::remove_dir_all(&dir);
}

struct KeepGuard;

impl Drop for KeepGuard {
    fn drop(&mut self) {
        keep_support_bases(false);
    }
}
