//! Ironing: `ironing` on the request adds a low-flow pass over the part's
//! top surfaces. Omitted, the slice is the slice it was before the field.

use base64::Engine;
use lime_slice_core::{slice_payload, Ironing, Job};
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

/// A 20 mm square box, 3 mm tall: 15 layers of 0.2 mm, the last one its top.
fn cube() -> String {
    box_stl(10.0, 10.0, 30.0, 30.0, 3.0)
}

/// The box's outline inset by half the 0.45 mm line width.
const INSET: [f64; 2] = [10.225, 29.775];

fn request(filename: &str, stl: &[u8], extra: Value) -> Value {
    let mut req = json!({
        "filename": filename,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
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

fn on_cube(extra: Value) -> Value {
    request("cube.stl", cube().as_bytes(), extra)
}

fn on_ledge(extra: Value) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    let mut req = request("overhang_ledge.stl", &std::fs::read(path).unwrap(), extra);
    req["blend"] = json!({"mode": "single", "strategy": "toughness"});
    req
}

fn slice(req: &Value) -> Result<Value, String> {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text())?;
    Ok(serde_json::from_str(&reply).unwrap())
}

/// One preview path: its layer, kind, and points.
struct Drawn {
    layer: u64,
    kind: String,
    pts: Vec<[f64; 2]>,
}

fn drawn(reply: &Value) -> Vec<Drawn> {
    let mut out = Vec::new();
    for layer in reply["layers"].as_array().unwrap() {
        let cols = &layer["paths"];
        let kinds = cols["kinds"].as_array().unwrap();
        let start = cols["start"].as_array().unwrap();
        let xy = cols["xy"].as_array().unwrap();
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
                pts: (a..b)
                    .map(|p| [xy[2 * p].as_f64().unwrap(), xy[2 * p + 1].as_f64().unwrap()])
                    .collect(),
            });
        }
    }
    out
}

fn ironed(reply: &Value) -> Vec<Drawn> {
    drawn(reply)
        .into_iter()
        .filter(|d| d.kind == "ironing")
        .collect()
}

/// One extruding G1 move of the G-code.
struct Move {
    layer: usize,
    kind: String,
    from: [f64; 2],
    to: [f64; 2],
    e: f64,
    f: f64,
}

impl Move {
    fn len(&self) -> f64 {
        (self.to[0] - self.from[0]).hypot(self.to[1] - self.from[1])
    }
}

/// Every extruding straight move, with the `;LAYER:` and `; TYPE:` it
/// prints under. E is absolute.
fn moves(gcode: &str) -> Vec<Move> {
    let (mut at, mut e, mut f) = ([0.0, 0.0], 0.0, 0.0);
    let (mut layer, mut kind) = (0, String::new());
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer = rest.split_whitespace().next().unwrap().parse().unwrap();
            continue;
        }
        if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.to_string();
            continue;
        }
        let mut words = line.split_whitespace();
        let cmd = words.next().unwrap_or("");
        if !["G0", "G1", "G2", "G3", "G92"].contains(&cmd) {
            continue;
        }
        let (mut to, mut de) = (at, None);
        for w in words {
            let v = || w[1..].parse::<f64>().unwrap();
            match w.as_bytes()[0] {
                b'X' => to[0] = v(),
                b'Y' => to[1] = v(),
                b'E' => de = Some(v()),
                b'F' => f = v(),
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
                    layer,
                    kind: kind.clone(),
                    from: at,
                    to,
                    e: next - e,
                    f,
                });
            }
            e = next;
        }
        at = to;
    }
    out
}

/// Filament per millimetre over every `kind` move on `layer`.
fn e_per_mm(moves: &[Move], layer: usize, kind: &str) -> f64 {
    let picked = moves.iter().filter(|m| m.layer == layer && m.kind == kind);
    let (e, mm) = picked.fold((0.0, 0.0), |(e, mm), m| (e + m.e, mm + m.len()));
    assert!(mm > 0.0, "no {kind} on layer {layer}");
    e / mm
}

/// The X of each ironing line that runs along Y, in order.
fn line_xs(moves: &[Move]) -> Vec<f64> {
    let mut xs: Vec<f64> = moves
        .iter()
        .filter(|m| m.kind == "IRONING" && (m.to[1] - m.from[1]).abs() > 1.0)
        .map(|m| m.from[0])
        .collect();
    xs.sort_by(f64::total_cmp);
    xs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    xs
}

fn gcode(reply: &Value) -> &str {
    reply["gcode"].as_str().unwrap()
}

/// The G-code from the first layer up to the last layer's marker.
fn below_top(gcode: &str) -> &str {
    let first = gcode.find(";LAYER:0 ").unwrap();
    let last = gcode.rfind(";LAYER:").unwrap();
    &gcode[first..last]
}

#[test]
fn omitted_ironing_irons_nothing() {
    let omitted = slice(&on_cube(json!({}))).unwrap();
    let null = slice(&on_cube(json!({"ironing": null}))).unwrap();
    assert!(gcode(&omitted) == gcode(&null), "null is omitted");
    assert!(!gcode(&omitted).contains("IRONING"));
    assert!(
        !gcode(&omitted).contains("ironing"),
        "the header names no ironing"
    );
    assert_eq!(ironed(&omitted).len(), 0);
}

#[test]
fn ironing_a_box_irons_only_its_top_layer_inside_the_inset_outline() {
    let off = slice(&on_cube(json!({}))).unwrap();
    let on = slice(&on_cube(json!({"ironing": {}}))).unwrap();
    assert!(
        gcode(&on).contains("; ironing flow 0.1 speed 20 spacing 0.1"),
        "the header names the ironing"
    );

    let paths = ironed(&on);
    assert!(!paths.is_empty());
    let mut layers: Vec<u64> = paths.iter().map(|d| d.layer).collect();
    layers.dedup();
    assert_eq!(layers, vec![14], "only the top layer irons");
    let pts: Vec<[f64; 2]> = paths.iter().flat_map(|d| d.pts.clone()).collect();
    for p in &pts {
        for c in p {
            assert!(
                (INSET[0] - 1e-3..=INSET[1] + 1e-3).contains(c),
                "{p:?} is outside the inset outline"
            );
        }
    }
    for axis in 0..2 {
        let lo = pts.iter().map(|p| p[axis]).fold(f64::MAX, f64::min);
        let hi = pts.iter().map(|p| p[axis]).fold(f64::MIN, f64::max);
        assert!(
            lo < INSET[0] + 0.2 && hi > INSET[1] - 0.2,
            "axis {axis}: ironing spans {lo} to {hi}"
        );
    }
    assert!(
        below_top(gcode(&off)) == below_top(gcode(&on)),
        "every layer under the top prints as before"
    );
    let on_moves = moves(gcode(&on));
    assert!(on_moves
        .iter()
        .filter(|m| m.kind == "IRONING")
        .all(|m| m.layer == 14));
}

#[test]
fn flow_speed_and_spacing_reach_the_gcode() {
    for (sent, flow, feed, spacing) in [
        (json!({}), 0.1, 1200.0, 0.1),
        (
            json!({"flow": 0.25, "speed": 15, "spacing": 0.2}),
            0.25,
            900.0,
            0.2,
        ),
    ] {
        let reply = slice(&on_cube(json!({"ironing": sent}))).unwrap();
        let moves = moves(gcode(&reply));
        let ratio = e_per_mm(&moves, 14, "IRONING") / e_per_mm(&moves, 14, "TOP");
        assert!(
            (ratio - flow).abs() < flow * 0.01,
            "{sent}: ironing E per mm is {ratio} of a top line's"
        );
        let feeds: Vec<f64> = moves
            .iter()
            .filter(|m| m.kind == "IRONING")
            .map(|m| m.f)
            .collect();
        assert!(feeds.iter().all(|&f| f == feed), "{sent}: feeds {feeds:?}");
        let xs = line_xs(&moves);
        assert!(xs.len() > 40, "{sent}: {} lines", xs.len());
        for w in xs.windows(2) {
            assert!(
                (w[1] - w[0] - spacing).abs() < 2e-3,
                "{sent}: lines at {} and {}",
                w[0],
                w[1]
            );
        }
    }
}

#[test]
fn ironing_adds_to_the_estimate() {
    let off = slice(&on_cube(json!({}))).unwrap();
    let on = slice(&on_cube(json!({"ironing": {}}))).unwrap();
    let seconds = |r: &Value| r["estimate"]["seconds"].as_f64().unwrap();
    let ironing = on["estimate"]["byFeature"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "ironing")
        .expect("an ironing row");
    let ironing_s = ironing["seconds"].as_f64().unwrap();
    // About 195 lines of 19.55 mm at 20 mm/s.
    assert!(ironing_s > 150.0, "ironing takes {ironing_s} s");
    assert!(
        seconds(&on) > seconds(&off) + ironing_s * 0.9,
        "{} s against {} s",
        seconds(&on),
        seconds(&off)
    );
}

#[test]
fn the_support_interface_is_never_ironed() {
    let alone = slice(&on_ledge(json!({"ironing": {}}))).unwrap();
    let supported = slice(&on_ledge(json!({"ironing": {}, "supports": true}))).unwrap();
    let key = |r: &Value| -> Vec<(u64, Vec<[f64; 2]>)> {
        ironed(r).into_iter().map(|d| (d.layer, d.pts)).collect()
    };
    assert!(!key(&alone).is_empty());
    assert!(key(&alone) == key(&supported), "supports change no ironing");
    let interface: Vec<u64> = drawn(&supported)
        .into_iter()
        .filter(|d| d.kind == "support-interface")
        .map(|d| d.layer)
        .collect();
    assert!(!interface.is_empty());
    let ironing: Vec<u64> = key(&supported).into_iter().map(|k| k.0).collect();
    assert!(
        interface.iter().any(|l| !ironing.contains(l)),
        "an interface layer without part roof irons nothing"
    );
}

#[test]
fn a_bad_ironing_is_refused_by_name() {
    let refused = |ironing: Value| slice(&on_cube(json!({ "ironing": ironing }))).unwrap_err();
    assert_eq!(
        refused(json!({"fl0w": 0.1})),
        "ironing.fl0w is not an ironing setting; send flow, speed, or spacing"
    );
    assert_eq!(
        refused(json!({"flow": "high"})),
        "ironing.flow \"high\" is not a number"
    );
    assert_eq!(
        refused(json!(true)),
        "ironing true is not an object; send {} or any of flow, speed, and spacing"
    );
    assert_eq!(
        refused(json!({"flow": 0})),
        "ironing.flow 0 must be above 0 and at most 1"
    );
    assert_eq!(
        refused(json!({"flow": 1.5})),
        "ironing.flow 1.5 must be above 0 and at most 1"
    );
    assert_eq!(
        refused(json!({"speed": -5})),
        "ironing.speed -5 must be above 0 mm/s"
    );
    assert_eq!(
        refused(json!({"spacing": 0.45})),
        "ironing.spacing 0.45 must be above 0 and below the line width, 0.45 mm"
    );
    let nan = Ironing {
        flow: f64::NAN,
        ..Ironing::default()
    };
    assert_eq!(
        nan.check(0.45).unwrap_err(),
        "ironing.flow NaN must be above 0 and at most 1"
    );
    let inf = Ironing {
        speed: f64::INFINITY,
        ..Ironing::default()
    };
    assert_eq!(
        inf.check(0.45).unwrap_err(),
        "ironing.speed inf must be above 0 mm/s"
    );
}

#[test]
fn a_plate_irons_every_object_and_refuses_ironing_per_object() {
    let object = |id: &str, x0: f64, settings: Value| {
        json!({
            "id": id,
            "filename": format!("{id}.stl"),
            "dataB64": base64::engine::general_purpose::STANDARD
                .encode(box_stl(x0, 0.0, x0 + 20.0, 20.0, 2.0)),
            "settings": settings,
        })
    };
    let plate = |ironing: Value, b: Value| {
        let mut req = json!({
            "blend": {"mode": "single", "strategy": "speed"},
            "includeGcode": true,
            "includePreview": true,
            "baseline": false,
            "objects": [object("a", 0.0, json!({})), object("b", 40.0, b)],
        });
        if !ironing.is_null() {
            req["ironing"] = ironing;
        }
        req
    };
    let reply = slice(&plate(json!({}), json!({}))).unwrap();
    let moves = moves(gcode(&reply));
    let top: Vec<&Move> = moves.iter().filter(|m| m.kind == "IRONING").collect();
    assert!(top.iter().all(|m| m.layer == 9), "only the top layer irons");
    assert!(top.iter().any(|m| m.to[0] < 20.0), "the first box irons");
    assert!(top.iter().any(|m| m.to[0] > 40.0), "the second box irons");

    let err = slice(&plate(Value::Null, json!({"ironing": {}}))).unwrap_err();
    assert_eq!(err, "objects[1].settings.ironing is a plate setting");
}
