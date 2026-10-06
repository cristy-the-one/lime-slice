//! Fuzzy skin: `fuzzySkin` on the request offsets outer walls. Omitted, the
//! slice is the slice it was before the field.

use base64::Engine;
use lime_slice_core::{slice_payload, SliceRequest, Job};
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

fn request(filename: &str, stl: &[u8], extra: Value) -> Value {
    let mut req = json!({
        "filename": filename,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "blend": {"mode": "single", "strategy": "speed"},
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

fn on_box(extra: Value) -> Value {
    request("box.stl", box_stl(0.0, 0.0, 8.0, 8.0, 0.6).as_bytes(), extra)
}

fn slice(req: &Value) -> Result<Value, String> {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text())?;
    Ok(serde_json::from_str(&reply).unwrap())
}

fn gcode(reply: &Value) -> &str {
    reply["gcode"].as_str().unwrap()
}

struct Move {
    kind: String,
    from: [f64; 2],
    to: [f64; 2],
}

/// Extruding straight moves under `; TYPE:`.
fn moves(gcode: &str) -> Vec<Move> {
    let (mut at, mut e) = ([0.0, 0.0], 0.0);
    let mut kind = String::new();
    let mut out = Vec::new();
    for line in gcode.lines() {
        if line.starts_with(";LAYER:") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.to_string();
            continue;
        }
        let mut words = line.split_whitespace();
        let cmd = words.next().unwrap_or("");
        if !["G0", "G1", "G92"].contains(&cmd) {
            continue;
        }
        let (mut to, mut de) = (at, None);
        for w in words {
            let v = || w[1..].parse::<f64>().unwrap();
            match w.as_bytes()[0] {
                b'X' => to[0] = v(),
                b'Y' => to[1] = v(),
                b'E' => de = Some(v()),
                _ => {}
            }
        }
        if cmd == "G92" {
            e = de.unwrap_or(e);
            continue;
        }
        if let Some(next) = de {
            if cmd == "G1" && next > e && to != at {
                out.push(Move {
                    kind: kind.clone(),
                    from: at,
                    to,
                });
            }
            e = next;
        }
        at = to;
    }
    out
}

fn polylines(gcode: &str, kind: &str) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    for m in moves(gcode).into_iter().filter(|m| m.kind == kind) {
        if cur.last().is_none_or(|p| dist(*p, m.from) > 1e-4) {
            if cur.len() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
            cur.push(m.from);
        }
        cur.push(m.to);
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn dist_seg(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1]];
    let ap = [p[0] - a[0], p[1] - a[1]];
    let ab2 = ab[0] * ab[0] + ab[1] * ab[1];
    if ab2 < 1e-18 {
        return ap[0].hypot(ap[1]);
    }
    let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / ab2).clamp(0.0, 1.0);
    (p[0] - (a[0] + ab[0] * t)).hypot(p[1] - (a[1] + ab[1] * t))
}

fn dist_poly(p: [f64; 2], poly: &[[f64; 2]]) -> f64 {
    poly.windows(2)
        .map(|w| dist_seg(p, w[0], w[1]))
        .fold(f64::MAX, f64::min)
}

#[test]
fn an_omitted_fuzzy_skin_is_absent_from_the_request_and_the_gcode() {
    let parsed: SliceRequest = serde_json::from_value(json!({})).unwrap();
    assert!(parsed.fuzzy_skin.is_none());
    let wire = serde_json::to_value(&parsed).unwrap();
    assert!(wire.get("fuzzySkin").is_none(), "{wire}");

    let omitted = slice(&on_box(json!({}))).unwrap();
    let null = slice(&on_box(json!({"fuzzySkin": null}))).unwrap();
    assert_eq!(gcode(&omitted), gcode(&null));
    assert!(!gcode(&omitted).contains("fuzzy skin"));
}

#[test]
fn fuzzy_skin_moves_outer_walls_within_the_thickness_and_pins_the_ends() {
    let off = slice(&on_box(json!({}))).unwrap();
    let on = slice(&on_box(json!({"fuzzySkin": {}}))).unwrap();
    assert_ne!(gcode(&off), gcode(&on));
    assert!(gcode(&on).contains("; fuzzy skin 0.3 mm / 0.8 mm"));
    assert_eq!(polylines(gcode(&off), "INNER"), polylines(gcode(&on), "INNER"));

    let before = polylines(gcode(&off), "OUTER");
    let after = polylines(gcode(&on), "OUTER");
    assert_eq!(before.len(), after.len());
    assert!(!before.is_empty());
    for (was, now) in before.iter().zip(after.iter()) {
        assert_eq!(now[0], was[0]);
        assert_eq!(*now.last().unwrap(), *was.last().unwrap());
        for p in now {
            let d = dist_poly(*p, was);
            assert!(d <= 0.3 + 1e-3, "{p:?} is {d} mm off the wall");
        }
    }
}

#[test]
fn classic_forces_fuzzy_skin_off() {
    let plain = slice(&on_box(json!({"classic": true}))).unwrap();
    let asked = slice(&on_box(json!({"classic": true, "fuzzySkin": {}}))).unwrap();
    assert_eq!(gcode(&plain), gcode(&asked));
    assert!(!gcode(&asked).contains("fuzzy skin"));
}

#[test]
fn a_bad_fuzzy_skin_is_refused_by_name() {
    let refused = |fuzzy: Value| slice(&on_box(json!({ "fuzzySkin": fuzzy }))).unwrap_err();
    assert_eq!(
        refused(json!({"thick": 0.3})),
        "fuzzySkin.thick is not a fuzzy skin setting; send thickness or pointDistance"
    );
    assert_eq!(
        refused(json!({"thickness": "wide"})),
        "fuzzySkin.thickness \"wide\" is not a number"
    );
    assert_eq!(
        refused(json!(true)),
        "fuzzySkin true is not an object; send {} or thickness and pointDistance"
    );
    assert_eq!(
        refused(json!({"thickness": 0})),
        "fuzzySkin.thickness 0 must be above 0 and at most 1 mm"
    );
    assert_eq!(
        refused(json!({"thickness": 1.5})),
        "fuzzySkin.thickness 1.5 must be above 0 and at most 1 mm"
    );
    assert_eq!(
        refused(json!({"pointDistance": 0.05})),
        "fuzzySkin.pointDistance 0.05 must be from 0.1 to 5 mm"
    );
}

#[test]
fn a_plate_refuses_fuzzy_skin_per_object() {
    let object = |id: &str, x0: f64, settings: Value| {
        json!({
            "id": id,
            "filename": format!("{id}.stl"),
            "dataB64": base64::engine::general_purpose::STANDARD
                .encode(box_stl(x0, 0.0, x0 + 8.0, 8.0, 0.4)),
            "settings": settings,
        })
    };
    let err = slice(&json!({
        "blend": {"mode": "single", "strategy": "speed"},
        "includeGcode": true,
        "includePreview": false,
        "baseline": false,
        "objects": [object("a", 0.0, json!({})), object("b", 20.0, json!({"fuzzySkin": {}}))],
    }))
    .unwrap_err();
    assert_eq!(err, "objects[1].settings.fuzzySkin is a plate setting");
}
