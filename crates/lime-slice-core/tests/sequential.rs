//! Sequential printing finishes every layer of one object, supports included,
//! before the next object starts. All-at-once stays the omitted default.
//! One test toggles the kept slices, which the process shares.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job, SliceRequest};
use serde_json::{json, Value};

fn box_stl() -> String {
    tall_box_stl(2.0)
}

/// A 10 mm square box `z` mm tall, from the origin.
fn tall_box_stl(z: f64) -> String {
    let (x, y) = (10.0, 10.0);
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
    pose_tall(x, 2.0)
}

fn pose_tall(x: f64, z: f64) -> Value {
    json!({
        "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        "pivot": [5.0, 5.0, z * 0.5],
        "translation": [x, 110.0, z * 0.5],
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
    assert!(crowded.contains("\"b\" does not clear \"a\""), "{crowded}");
    let short = slice(&plate(40.0, 50.5, Some("sequential"), Some(1.0))).unwrap_err();
    assert!(short.contains("by 1 mm"), "{short}");

    let exact = slice(&plate(40.0, 51.0, Some("sequential"), Some(1.0))).unwrap();
    let exact_gcode = exact["gcode"].as_str().unwrap();
    let exact_a = object_marks(exact_gcode, "a");
    let exact_b = object_marks(exact_gcode, "b");
    assert!(exact_a.len() > 1 && exact_b.len() == exact_a.len());
    assert!(exact_a.iter().all(|a| exact_b.iter().all(|b| a < b)));

    let together = slice(&plate(40.0, 90.0, None, None)).unwrap();
    let together_gcode = together["gcode"].as_str().unwrap();
    let layer1 = together_gcode.find(";LAYER:1 ").unwrap();
    let first_b = together_gcode.find(";OBJECT:b").unwrap();
    assert!(
        first_b < layer1,
        "all-at-once prints both objects on layer 0"
    );

    let _guard = KeepGuard;
    keep_support_bases(true);
    let apart = plate(40.0, 90.0, Some("sequential"), None);
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

    let mut switched = plate(40.0, 90.0, None, None);
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

/// Two boxes, `a` `za` mm tall centred at X `ax`, then `b` `zb` mm tall at
/// X `bx`, printed one at a time.
fn tall_plate(ax: f64, za: f64, bx: f64, zb: f64) -> Value {
    let object = |id: &str, x: f64, z: f64| {
        json!({
            "id": id,
            "filename": "box.stl",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(tall_box_stl(z).as_bytes()),
            "pose": pose_tall(x, z),
        })
    };
    json!({
        "blend": {"mode": "single", "strategy": "speed"},
        "supports": false,
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
        "objects": [object("a", ax, za), object("b", bx, zb)],
        "printOrder": "sequential",
    })
}

/// Every G-code move after `from`, as the nozzle position it reaches.
fn positions(gcode: &str, from: usize) -> Vec<[f64; 3]> {
    let (mut x, mut y, mut z) = (f64::NAN, f64::NAN, f64::NAN);
    let mut out = Vec::new();
    for (k, line) in gcode.lines().enumerate() {
        if !(line.starts_with("G0")
            || line.starts_with("G1")
            || line.starts_with("G2")
            || line.starts_with("G3"))
        {
            continue;
        }
        let word = |c: char| {
            line.split(';')
                .next()
                .unwrap()
                .split_whitespace()
                .find_map(|w| w.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()))
        };
        x = word('X').unwrap_or(x);
        y = word('Y').unwrap_or(y);
        z = word('Z').unwrap_or(z);
        if k >= from {
            out.push([x, y, z]);
        }
    }
    out
}

#[test]
fn the_next_object_starts_above_the_finished_one() {
    // `a` is 15 mm tall at X 40, `b` 2 mm tall at X 90: a 40 mm gap. Once `a`
    // is done the nozzle must never be inside its footprint below its top,
    // or it drives into the part it just printed.
    let reply = slice(&tall_plate(40.0, 15.0, 90.0, 2.0)).unwrap();
    let gcode = reply["gcode"].as_str().unwrap();
    let b_start = gcode.find(";OBJECT:b").unwrap();
    // `a`'s last move ends its last layer, before `b`'s first layer header.
    let first_b_layer = gcode[..b_start].rfind(";LAYER:").unwrap();
    let a_done = gcode[..first_b_layer].lines().count() - 1;
    let inside_a = |p: &[f64; 3]| (35.0..=45.0).contains(&p[0]) && (105.0..=115.0).contains(&p[1]);
    let low_over_a: Vec<_> = positions(gcode, a_done)
        .into_iter()
        .filter(|p| inside_a(p) && p[2] < 15.0 - 1e-6)
        .collect();
    assert!(
        low_over_a.is_empty(),
        "the nozzle goes down inside a: {low_over_a:?}"
    );
    let climb = gcode[..first_b_layer]
        .rfind("G1 Z17.000")
        .expect("a climb to 2 mm above a");
    let travel = gcode[climb..first_b_layer]
        .find("G1 X")
        .expect("the travel to b at that height");
    assert!(climb + travel < first_b_layer);
}

#[test]
fn the_next_object_gets_the_first_layer_speed_and_fan() {
    let reply = slice(&tall_plate(40.0, 2.0, 90.0, 2.0)).unwrap();
    let gcode = reply["gcode"].as_str().unwrap();
    let b = gcode.find(";OBJECT:b").unwrap();
    let layer = gcode[..b].rfind(";LAYER:").unwrap();
    let next = gcode[b..].find(";LAYER:").map_or(gcode.len(), |n| b + n);
    let first = &gcode[layer..next];
    assert!(
        first.contains("M106 S0"),
        "the part fan is off on b's first layer"
    );
    let feeds: Vec<f64> = first
        .lines()
        .filter(|l| l.contains(" E") && (l.contains(" X") || l.contains(" Y")))
        .filter_map(|l| {
            l.split_whitespace()
                .find_map(|w| w.strip_prefix('F'))
                .and_then(|f| f.parse().ok())
        })
        .collect();
    assert!(!feeds.is_empty());
    assert!(
        feeds.iter().all(|f| *f <= 1800.0),
        "b's first layer prints at 30 mm/s or less: {feeds:?}"
    );
}

#[test]
fn only_the_last_object_may_rise_past_the_gantry() {
    let tall_first = slice(&tall_plate(40.0, 25.0, 90.0, 2.0)).unwrap_err();
    assert_eq!(
        tall_first,
        "printOrder \"sequential\": \"a\" is 25.0 mm tall, above the 20 mm gantry; only the last object may be taller"
    );
    assert!(slice(&tall_plate(40.0, 2.0, 90.0, 25.0)).is_ok());
    let mut high_gantry = tall_plate(40.0, 25.0, 90.0, 2.0);
    high_gantry["sequentialGantryMm"] = json!(30.0);
    assert!(slice(&high_gantry).is_ok());
}

#[test]
fn objects_clear_a_toolhead_unless_told_otherwise() {
    // A 30 mm gap is inside the default 35 mm toolhead reach.
    let near = slice(&tall_plate(40.0, 2.0, 80.0, 2.0)).unwrap_err();
    assert_eq!(
        near,
        "printOrder \"sequential\": \"b\" does not clear \"a\" by 35 mm"
    );
    let mut small_head = tall_plate(40.0, 2.0, 80.0, 2.0);
    small_head["sequentialClearanceMm"] = json!(25.0);
    assert!(slice(&small_head).is_ok());
}

#[test]
fn a_belt_printer_refuses_sequential_order() {
    let mut req = tall_plate(40.0, 2.0, 90.0, 2.0);
    req["belt"] = json!({"angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 220, "copies": 1, "gapMm": 0});
    assert_eq!(
        slice(&req).unwrap_err(),
        "printOrder \"sequential\" is not available on a belt printer"
    );
}
