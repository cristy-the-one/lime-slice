//! Seam paint: disks on the mesh pull a wall's start into the painted ball.
//! An omitted list keeps the picker's seam and the request's bytes.

use base64::Engine;
use lime_slice_core::{slice_payload, Job, SliceRequest};
use serde_json::{json, Value};

fn box_stl(x0: f64, y0: f64, x1: f64, y1: f64, z1: f64) -> String {
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
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(box_stl(0.0, 0.0, 10.0, 10.0, 1.2)),
        "blend": {"mode": "single", "strategy": "speed"},
        "seam": "aligned",
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
        "arcFit": false,
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

fn gcode(reply: &Value) -> &str {
    reply["gcode"].as_str().unwrap()
}

/// The first XY the nozzle travels to after each `; TYPE:OUTER`. That is the seam.
fn outer_starts(gcode: &str) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    let (mut x, mut y) = (0.0, 0.0);
    let mut outer = false;
    let mut took = false;
    for line in gcode.lines() {
        if line.starts_with(";LAYER:") {
            outer = false;
            took = false;
        }
        if line.contains("TYPE:") {
            outer = line.contains("TYPE:OUTER");
            took = false;
        }
        if !outer || took || !(line.starts_with("G0 ") || line.starts_with("G1 ")) {
            continue;
        }
        let mut moved = false;
        for word in line.split_whitespace() {
            if let Some(v) = word.strip_prefix('X').and_then(|v| v.parse::<f64>().ok()) {
                x = v;
                moved = true;
            }
            if let Some(v) = word.strip_prefix('Y').and_then(|v| v.parse::<f64>().ok()) {
                y = v;
                moved = true;
            }
        }
        if moved {
            out.push([x, y]);
            took = true;
        }
    }
    out
}

fn disk(p: [f64; 3], r: f64) -> Value {
    json!({ "p": p, "n": [0.0, 0.0, 1.0], "r": r })
}

#[test]
fn an_omitted_seam_paint_is_absent_and_an_empty_list_matches() {
    let plain = request(json!({}));
    let empty = request(json!({ "seamPaint": [] }));
    let typed: SliceRequest = serde_json::from_value(plain.clone()).unwrap();
    let wire = serde_json::to_value(&typed).unwrap();
    assert!(wire.get("seamPaint").is_none(), "{wire}");
    let a = slice(&plain).unwrap();
    let b = slice(&empty).unwrap();
    assert_eq!(gcode(&a), gcode(&b));
    assert!(!gcode(&a).contains("seam paint"));
}

#[test]
fn seam_paint_pulls_the_outer_start_into_the_disk() {
    let off = slice(&request(json!({}))).unwrap();
    let on = slice(&request(json!({
        "seamPaint": [disk([0.2, 0.2, 0.4], 2.0)]
    })))
    .unwrap();
    assert_ne!(gcode(&off), gcode(&on));
    assert!(gcode(&on).contains("; seam paint 1 disks"));
    let starts = outer_starts(gcode(&on));
    assert!(!starts.is_empty());
    for start in &starts {
        assert!(
            start[0] < 2.0 && start[1] < 2.0,
            "outer start {start:?} is outside the painted corner"
        );
    }
    let aligned = outer_starts(gcode(&off));
    assert!(
        aligned.iter().any(|s| s[0] > 8.0),
        "the unpainted seam was not on +X: {aligned:?}"
    );
}

#[test]
fn a_bad_seam_disk_is_refused_by_name() {
    let err = slice(&request(json!({
        "seamPaint": [{ "p": [0.0, 0.0, 0.2], "n": [0.0, 0.0, 1.0], "r": 0.05 }]
    })))
    .unwrap_err();
    assert!(
        err.contains("seamPaint[0].r is 0.05 mm"),
        "{err}"
    );
}

#[test]
fn seam_paint_on_a_plate_belongs_on_the_object() {
    let stl = base64::engine::general_purpose::STANDARD.encode(box_stl(0.0, 0.0, 8.0, 8.0, 0.8));
    let err = slice(&json!({
        "blend": {"mode": "single", "strategy": "speed"},
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
        "seamPaint": [disk([1.0, 1.0, 0.2], 2.0)],
        "objects": [{
            "id": "a",
            "filename": "a.stl",
            "dataB64": stl,
        }],
    }))
    .unwrap_err();
    assert_eq!(err, "seamPaint belongs on each object when objects is sent");
}

#[test]
fn a_disk_on_a_straight_side_starts_the_wall_inside_it() {
    // Mid-way along the -X side, 5 mm from either corner: no wall vertex is
    // inside the disk, so the seam needs a point of its own.
    let on = slice(&request(json!({
        "seamPaint": [disk([0.0, 5.0, 0.6], 1.0)]
    })))
    .unwrap();
    let starts = outer_starts(gcode(&on));
    assert!(!starts.is_empty());
    for start in &starts {
        assert!(
            start[0] < 1.0 && (start[1] - 5.0).abs() < 1.0,
            "outer start {start:?} is outside the painted disk"
        );
    }
}
