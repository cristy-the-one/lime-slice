//! The seam picker: `seam` on the request places where each wall loop
//! starts. Omitted or `blend` keeps the strategy's placement and its bytes.

use base64::Engine;
use lime_slice_core::{slice_payload, Job, SliceRequest};
use serde_json::{json, Value};

/// An ASCII STL of the box `[x0, x1] × [y0, y1] × [0, z1]`.
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
    stl(faces.iter().map(|&(i, j, k)| [v[i], v[j], v[k]]).collect())
}

/// An ASCII STL of a 64-sided cylinder of radius `r` and height `h` at `c`.
fn cylinder_stl(c: [f64; 2], r: f64, h: f64) -> String {
    let n = 64;
    let at = |i: usize, z: f64| {
        let a = std::f64::consts::TAU * (i % n) as f64 / n as f64;
        [c[0] + r * a.cos(), c[1] + r * a.sin(), z]
    };
    let mut tris = Vec::new();
    for i in 0..n {
        tris.push([[c[0], c[1], 0.0], at(i + 1, 0.0), at(i, 0.0)]);
        tris.push([[c[0], c[1], h], at(i, h), at(i + 1, h)]);
        tris.push([at(i, 0.0), at(i + 1, 0.0), at(i + 1, h)]);
        tris.push([at(i, 0.0), at(i + 1, h), at(i, h)]);
    }
    stl(tris)
}

fn stl(tris: Vec<[[f64; 3]; 3]>) -> String {
    let mut out = String::from("solid s\n");
    for t in tris {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for p in t {
            out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid s\n");
    out
}

fn request(stl: &str, strategy: &str, extra: Value) -> Value {
    let mut req = json!({
        "filename": "part.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "blend": {"mode": "single", "strategy": strategy},
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

/// One preview path: its layer, kind, object, and points.
struct Drawn {
    layer: u64,
    kind: String,
    object: u64,
    pts: Vec<[f64; 2]>,
}

/// Every path of the reply's preview, decoded from its columns.
fn drawn(reply: &Value) -> Vec<Drawn> {
    let mut out = Vec::new();
    for layer in reply["layers"].as_array().unwrap() {
        let cols = &layer["paths"];
        let kinds = cols["kinds"].as_array().unwrap();
        let start = cols["start"].as_array().unwrap();
        let xy = cols["xy"].as_array().unwrap();
        let objects = cols.get("object").and_then(Value::as_array);
        for (i, k) in cols["kind"].as_array().unwrap().iter().enumerate() {
            let (a, b) = (
                start[i].as_u64().unwrap() as usize,
                start[i + 1].as_u64().unwrap() as usize,
            );
            out.push(Drawn {
                layer: layer["index"].as_u64().unwrap(),
                kind: kinds[k.as_u64().unwrap() as usize]
                    .as_str()
                    .unwrap()
                    .to_string(),
                object: objects.map_or(0, |o| o[i].as_u64().unwrap()),
                pts: (a..b)
                    .map(|p| [xy[2 * p].as_f64().unwrap(), xy[2 * p + 1].as_f64().unwrap()])
                    .collect(),
            });
        }
    }
    out
}

fn walls<'a>(reply: &'a [Drawn], kind: &'a str) -> impl Iterator<Item = &'a Drawn> {
    reply.iter().filter(move |d| d.kind == kind)
}

/// Where a loop starts, and the back corner a rear seam should take: the
/// rear-most of its vertices, ties toward +X.
fn start_and_back(pts: &[[f64; 2]]) -> ([f64; 2], [f64; 2]) {
    let back = pts.iter().copied().fold([f64::MIN, f64::MIN], |b, p| {
        if p[1] > b[1] + 1e-6 || ((p[1] - b[1]).abs() <= 1e-6 && p[0] > b[0]) {
            p
        } else {
            b
        }
    });
    (pts[0], back)
}

fn near(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() < 2e-3 && (a[1] - b[1]).abs() < 2e-3
}

#[test]
fn seam_is_left_out_of_the_request_at_blend() {
    let wire = |seam: Option<&str>| {
        let mut req = json!({"filename": "part.stl", "dataB64": ""});
        if let Some(seam) = seam {
            req["seam"] = json!(seam);
        }
        let req: SliceRequest = serde_json::from_value(req).unwrap();
        serde_json::to_value(&req).unwrap().get("seam").cloned()
    };
    assert_eq!(wire(None), None);
    assert_eq!(wire(Some("blend")), None);
    assert_eq!(wire(Some("nearest")), Some(json!("nearest")));
    assert_eq!(wire(Some("aligned")), Some(json!("aligned")));
    assert_eq!(wire(Some("rear")), Some(json!("rear")));
}

#[test]
fn blend_slices_as_an_omitted_seam() {
    let part = box_stl(0.0, 0.0, 30.0, 20.0, 3.0);
    for strategy in ["speed", "toughness"] {
        let omitted = slice(&request(&part, strategy, json!({}))).unwrap();
        let blend = slice(&request(&part, strategy, json!({"seam": "blend"}))).unwrap();
        assert!(omitted["gcode"] == blend["gcode"], "{strategy}: g-code");
        assert!(omitted["layers"] == blend["layers"], "{strategy}: preview");
        assert!(
            !omitted["gcode"].as_str().unwrap().contains("seam "),
            "{strategy}: the header names no seam"
        );
    }
}

#[test]
fn a_bad_seam_is_refused_by_name() {
    let part = box_stl(0.0, 0.0, 30.0, 20.0, 3.0);
    let err = slice(&request(&part, "speed", json!({"seam": "left"}))).unwrap_err();
    assert_eq!(
        err,
        "seam \"left\" is not a seam placement; send blend, nearest, aligned, or rear"
    );
}

#[test]
fn rear_starts_every_wall_at_its_back_corner() {
    let part = box_stl(0.0, 0.0, 30.0, 20.0, 3.0);
    for strategy in ["speed", "toughness"] {
        let reply = slice(&request(&part, strategy, json!({"seam": "rear"}))).unwrap();
        assert!(
            reply["gcode"].as_str().unwrap().contains("seam rear"),
            "{strategy}: the header names the seam"
        );
        let paths = drawn(&reply);
        let outer: Vec<&Drawn> = walls(&paths, "outer").collect();
        assert_eq!(outer.len(), 15, "{strategy}: one outer wall a layer");
        let first = start_and_back(&outer[0].pts).0;
        assert!(near(first, [29.775, 19.775]), "{strategy}: {first:?}");
        for kind in ["outer", "inner"] {
            for d in walls(&paths, kind) {
                let (start, back) = start_and_back(&d.pts);
                assert!(
                    near(start, back),
                    "{strategy} layer {} {kind}: starts at {start:?}, back corner {back:?}",
                    d.layer
                );
            }
        }
    }
}

#[test]
fn rear_on_a_round_wall_starts_at_the_rear_most_vertex() {
    let part = cylinder_stl([15.0, 15.0], 8.0, 2.0);
    let reply = slice(&request(&part, "toughness", json!({"seam": "rear"}))).unwrap();
    let paths = drawn(&reply);
    let outer: Vec<&Drawn> = walls(&paths, "outer").collect();
    assert_eq!(outer.len(), 10);
    for d in outer {
        let (start, back) = start_and_back(&d.pts);
        assert!(
            near(start, back),
            "layer {}: starts at {start:?}, rear-most {back:?}",
            d.layer
        );
    }
}

/// The distinct outer-wall starts across the layers above the first.
fn outer_starts(reply: &Value) -> Vec<[f64; 2]> {
    let mut starts: Vec<[f64; 2]> = Vec::new();
    for d in walls(&drawn(reply), "outer").filter(|d| d.layer > 0) {
        if !starts.iter().any(|s| near(*s, d.pts[0])) {
            starts.push(d.pts[0]);
        }
    }
    starts
}

#[test]
fn aligned_stacks_the_seam_of_a_speed_blend() {
    let part = box_stl(0.0, 0.0, 30.0, 20.0, 3.0);
    let blend = slice(&request(&part, "speed", json!({}))).unwrap();
    let aligned = slice(&request(&part, "speed", json!({"seam": "aligned"}))).unwrap();
    assert!(
        outer_starts(&blend).len() > 1,
        "speed moves its seam: {:?}",
        outer_starts(&blend)
    );
    assert_eq!(outer_starts(&aligned).len(), 1, "{:?}", outer_starts(&aligned));
    assert!(blend["gcode"] != aligned["gcode"]);
}

#[test]
fn nearest_moves_the_seam_of_a_toughness_blend() {
    let part = box_stl(0.0, 0.0, 30.0, 20.0, 3.0);
    let blend = slice(&request(&part, "toughness", json!({}))).unwrap();
    let nearest = slice(&request(&part, "toughness", json!({"seam": "nearest"}))).unwrap();
    assert_eq!(outer_starts(&blend).len(), 1, "{:?}", outer_starts(&blend));
    assert!(
        outer_starts(&nearest).len() > 1,
        "{:?}",
        outer_starts(&nearest)
    );
}

#[test]
fn a_plate_seams_every_object_and_refuses_a_seam_per_object() {
    let object = |id: &str, x0: f64, settings: Value| {
        json!({
            "id": id,
            "filename": format!("{id}.stl"),
            "dataB64": base64::engine::general_purpose::STANDARD
                .encode(box_stl(x0, 0.0, x0 + 20.0, 20.0, 2.0)),
            "settings": settings,
        })
    };
    let plate = |seam: Value, b: Value| {
        let mut req = json!({
            "blend": {"mode": "single", "strategy": "speed"},
            "includeGcode": true,
            "includePreview": true,
            "baseline": false,
            "objects": [object("a", 0.0, json!({})), object("b", 40.0, b)],
        });
        if !seam.is_null() {
            req["seam"] = seam;
        }
        req
    };
    let reply = slice(&plate(json!("rear"), json!({}))).unwrap();
    let paths = drawn(&reply);
    let mut seen = [0, 0];
    for d in walls(&paths, "outer") {
        let (start, back) = start_and_back(&d.pts);
        assert!(near(start, back), "object {} layer {}", d.object, d.layer);
        seen[d.object as usize] += 1;
    }
    assert_eq!(seen, [10, 10]);

    let err = slice(&plate(Value::Null, json!({"seam": "rear"}))).unwrap_err();
    assert_eq!(err, "objects[1].settings.seam is a plate setting");
}
