//! Plates: several objects on one bed, each sliced in its own part frame.
//! One test per process-wide state change, because the kept slices are
//! shared by the whole test binary.

use base64::Engine;
use lime_slice_core::{load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");

fn bytes(name: &str) -> Vec<u8> {
    std::fs::read(format!("{SAMPLES}{name}")).unwrap()
}

/// A pose that seats `name` on the bed with its box centre over `(x, y)`.
fn pose(name: &str, x: f64, y: f64) -> Value {
    let mesh = load_slice_mesh_tol(name, &bytes(name), true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    json!({
        "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        "pivot": pivot,
        "translation": [x, y, pivot[2] - min[2]],
    })
}

fn object(id: &str, name: &str, x: f64, y: f64) -> Value {
    json!({
        "id": id,
        "filename": name,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes(name)),
        "pose": pose(name, x, y),
    })
}

/// The plate settings every test shares: tree supports, the G-code inline.
fn plate(extra: Value) -> Value {
    let mut req = json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn slice(req: &Value) -> Result<Value, String> {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text())?;
    Ok(serde_json::from_str(&reply).unwrap())
}

/// The `;OBJECT:` labels of layer `n`, in print order.
fn labels_on(gcode: &str, n: usize) -> Vec<String> {
    let start = gcode.find(&format!(";LAYER:{n} ")).unwrap();
    let end = gcode[start + 1..]
        .find(";LAYER:")
        .map_or(gcode.len(), |e| start + 1 + e);
    gcode[start..end]
        .lines()
        .filter_map(|l| l.strip_prefix(";OBJECT:"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_one_object_plate_writes_the_bytes_of_the_plain_request() {
    let ledge = object("part", "overhang_ledge.stl", 100.0, 120.0);
    let plain = plate(json!({
        "filename": ledge["filename"],
        "dataB64": ledge["dataB64"],
        "pose": ledge["pose"],
    }));
    let listed = plate(json!({ "objects": [ledge] }));

    let plain = slice(&plain).unwrap();
    let listed = slice(&listed).unwrap();

    assert!(plain["gcode"].as_str().unwrap().contains(";LAYER:1 "));
    assert_eq!(plain["gcode"], listed["gcode"], "same G-code bytes");
    assert!(!listed["gcode"].as_str().unwrap().contains(";OBJECT:"));
    assert_eq!(listed["objects"][0]["id"], json!("part"));
    assert_eq!(listed["objects"][0]["offset"], plain["offset"]);
    assert_eq!(listed["collisions"], json!([]));
    assert!(plain.get("objects").is_none() && plain.get("collisions").is_none());
}

#[test]
fn two_objects_print_each_layer_in_plate_order() {
    let req = plate(json!({
        "objects": [
            object("a", "calibration_cube_20mm.stl", 70.0, 110.0),
            object("b", "overhang_ledge.stl", 150.0, 110.0),
        ],
    }));
    let reply = slice(&req).unwrap();
    let gcode = reply["gcode"].as_str().unwrap();

    assert_eq!(labels_on(gcode, 0), ["a", "b"]);
    assert_eq!(labels_on(gcode, 1), ["a", "b"]);
    let layer1 = gcode.find(";LAYER:1 ").unwrap();
    let first_b = gcode.find(";OBJECT:b").unwrap();
    assert!(first_b < layer1, "layer 1 starts after both objects");

    let ids: Vec<&str> = reply["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(reply["objects"][0]["offset"], json!([-40.0, 0.0]));
    assert_eq!(reply["objects"][1]["offset"], json!([40.0, 0.0]));
    assert_eq!(reply["collisions"], json!([]));
    assert!(reply.get("offset").is_none());
    let objects: Vec<u64> = reply["layers"][0]["paths"]["object"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_u64().unwrap())
        .collect();
    assert!(objects.contains(&0) && objects.contains(&1));
}

#[test]
fn overlapping_objects_are_reported() {
    let req = plate(json!({
        "supports": false,
        "objects": [
            object("a", "calibration_cube_20mm.stl", 100.0, 110.0),
            object("b", "calibration_cube_20mm.stl", 115.0, 110.0),
        ],
    }));
    let reply = slice(&req).unwrap();
    let hit = &reply["collisions"][0];
    assert_eq!(
        (hit["a"].as_str(), hit["b"].as_str()),
        (Some("a"), Some("b"))
    );
    let overlap: Vec<f64> = hit["overlap"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v.as_f64().unwrap() * 1000.0).round() / 1000.0)
        .collect();
    assert_eq!(overlap, [105.0, 100.0, 110.0, 120.0]);
}

#[test]
fn refused_requests_name_the_field() {
    let a = object("a", "calibration_cube_20mm.stl", 70.0, 110.0);
    let with = |extra: Value| {
        let mut req = plate(json!({ "objects": [a.clone()] }));
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        slice(&req).unwrap_err()
    };
    let setting = |key: &str, value: Value| {
        let mut obj = a.clone();
        obj["settings"] = json!({ key: value });
        slice(&plate(json!({ "objects": [obj] }))).unwrap_err()
    };
    assert_eq!(
        with(json!({"printOrder": "sequential"})),
        "printOrder \"sequential\" is not supported yet; omit it or send \"all-at-once\""
    );
    assert_eq!(
        with(json!({"objects": []})),
        "objects is empty; send at least one object"
    );
    assert_eq!(
        with(json!({"pose": a["pose"]})),
        "pose belongs on each object when objects is sent"
    );
    assert_eq!(
        with(json!({"objects": [a.clone(), a.clone()]})),
        "objects[1].id \"a\" is used twice"
    );
    assert_eq!(
        setting("layerHeight", json!(0.1)),
        "objects[0].settings.layerHeight is a plate setting"
    );
    assert_eq!(
        setting("zHop", json!("always")),
        "objects[0].settings.zHop is a plate setting"
    );
    assert_eq!(
        setting("walls", json!(3)),
        "objects[0].settings.walls is not supported yet"
    );
    assert_eq!(
        setting("colour", json!("red")),
        "objects[0].settings.colour is not a setting"
    );
}
