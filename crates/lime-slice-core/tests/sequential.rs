//! Sequential printing finishes every layer of one object, supports included,
//! before the next object starts. All-at-once stays the omitted default.
//! One test toggles the kept slices, which the process shares.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job, SliceRequest};
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

fn pose(x: f64) -> Value {
    json!({
        "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        "pivot": [5.0, 5.0, 1.0],
        "translation": [x, 110.0, 1.0],
    })
}

fn object(id: &str, stl: &str, x: f64) -> Value {
    json!({
        "id": id,
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "pose": pose(x),
    })
}

/// Two 10 mm boxes whose centres sit at `ax` and `bx` on the bed.
fn plate(ax: f64, bx: f64, order: Option<&str>, clearance: Option<f64>) -> Value {
    let stl = box_stl();
    let mut req = json!({
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": false,
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "objects": [object("a", &stl, ax), object("b", &stl, bx)],
    });
    if let Some(order) = order {
        req["printOrder"] = json!(order);
    }
    if let Some(clearance) = clearance {
        req["sequentialClearanceMm"] = json!(clearance);
    }
    req
}

fn slice(req: &Value) -> Result<Value, String> {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text())?;
    Ok(serde_json::from_str(&reply).unwrap())
}

fn object_marks(gcode: &str, id: &str) -> Vec<usize> {
    let needle = format!(";OBJECT:{id}");
    gcode.match_indices(&needle).map(|(i, _)| i).collect()
}

#[test]
fn an_omitted_order_stays_out_of_the_request_json() {
    let req: SliceRequest = serde_json::from_str("{}").unwrap();
    let wire = serde_json::to_value(&req).unwrap();
    assert!(wire.get("printOrder").is_none());
    assert!(wire.get("sequentialClearanceMm").is_none());
    let set: SliceRequest =
        serde_json::from_str(r#"{"printOrder":"sequential","sequentialClearanceMm":2}"#).unwrap();
    let wire = serde_json::to_value(&set).unwrap();
    assert_eq!(wire["printOrder"], json!("sequential"));
    assert_eq!(wire["sequentialClearanceMm"], json!(2.0));
}

#[test]
fn sequential_finishes_one_object_before_the_next() {
    let stl = box_stl();
    let mut one = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "pose": pose(110.0),
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": false,
        "includeGcode": true,
        "baseline": false,
    });
    let plain = slice(&one).unwrap();
    one["printOrder"] = json!("sequential");
    let sequenced = slice(&one).unwrap();
    assert_eq!(
        plain["gcode"], sequenced["gcode"],
        "one object is the same file either way"
    );

    let crowded = slice(&plate(40.0, 50.0, Some("sequential"), None)).unwrap_err();
    assert!(
        crowded.contains("\"b\" does not clear \"a\""),
        "{crowded}"
    );
    let short = slice(&plate(40.0, 50.5, Some("sequential"), Some(1.0))).unwrap_err();
    assert!(short.contains("by 1 mm"), "{short}");

    let exact = slice(&plate(40.0, 51.0, Some("sequential"), Some(1.0))).unwrap();
    let exact_gcode = exact["gcode"].as_str().unwrap();
    let exact_a = object_marks(exact_gcode, "a");
    let exact_b = object_marks(exact_gcode, "b");
    assert!(exact_a.len() > 1 && exact_b.len() == exact_a.len());
    assert!(exact_a.iter().all(|a| exact_b.iter().all(|b| a < b)));

    let together = slice(&plate(40.0, 80.0, None, None)).unwrap();
    let together_gcode = together["gcode"].as_str().unwrap();
    let layer1 = together_gcode.find(";LAYER:1 ").unwrap();
    let first_b = together_gcode.find(";OBJECT:b").unwrap();
    assert!(first_b < layer1, "all-at-once prints both objects on layer 0");

    let _guard = KeepGuard;
    keep_support_bases(true);
    let apart = plate(40.0, 80.0, Some("sequential"), None);
    let first = slice(&apart).unwrap();
    let token = first["previewToken"].as_str().unwrap().to_owned();
    assert!(first.get("previewPatch").is_none() || first["previewPatch"].is_null());
    let gcode = first["gcode"].as_str().unwrap();
    let a = object_marks(gcode, "a");
    let b = object_marks(gcode, "b");
    assert!(a.len() > 1 && b.len() == a.len(), "a {a:?} b {b:?}");
    assert!(
        a.iter().all(|at| b.iter().all(|bt| at < bt)),
        "every layer of a before b"
    );
    assert_ne!(gcode, together_gcode);

    let mut switched = plate(40.0, 80.0, None, None);
    switched["previewBase"] = json!(token);
    let whole = slice(&switched).unwrap();
    assert!(
        whole.get("previewPatch").is_none() || whole["previewPatch"].is_null(),
        "all-at-once against a sequential preview is a whole preview"
    );
    assert_ne!(whole["previewToken"].as_str().unwrap(), token);

    let held = slice(&apart).unwrap();
    assert_eq!(held["previewToken"].as_str().unwrap(), token);
    let mut again = apart;
    again["previewBase"] = json!(token);
    again["featureSpeeds"] = json!(false);
    let patched = slice(&again).unwrap();
    assert!(
        patched["previewPatch"].is_object(),
        "the same sequential plate can still be a patch: {patched}"
    );
    keep_support_bases(false);
}

struct KeepGuard;

impl Drop for KeepGuard {
    fn drop(&mut self) {
        keep_support_bases(false);
    }
}
