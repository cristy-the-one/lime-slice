//! Height ranges and modifier volumes: infill, walls, and a speed cap that
//! apply only to the layers of a range or the inside of a volume. Omitted
//! lists keep a slice's bytes.

use base64::Engine;
use lime_slice_core::{slice_payload, Job};
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

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// A 40 × 40 × 10 mm box over `[80, 120]²`, in print space.
fn request(blend: Value, extra: Value) -> Value {
    let mut req = json!({
        "filename": "box.stl",
        "dataB64": b64(&box_stl(80.0, 80.0, 120.0, 120.0, 10.0)),
        "blend": blend,
        "layerHeight": 0.25,
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn speed() -> Value {
    json!({"mode": "single", "strategy": "speed"})
}

fn slice(req: &Value) -> Result<Value, String> {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text())?;
    Ok(serde_json::from_str(&reply).unwrap())
}

/// One preview path: its layer z, kind, speed, object, and points.
struct Drawn {
    z: f64,
    kind: String,
    speed: f64,
    object: u64,
    pts: Vec<[f64; 2]>,
}

fn drawn(reply: &Value) -> Vec<Drawn> {
    let mut out = Vec::new();
    for layer in reply["layers"].as_array().unwrap() {
        let cols = &layer["paths"];
        let kinds = cols["kinds"].as_array().unwrap();
        let start = cols["start"].as_array().unwrap();
        let xy = cols["xy"].as_array().unwrap();
        let speeds = cols["speed"].as_array().unwrap();
        let objects = cols.get("object").and_then(Value::as_array);
        for (i, k) in cols["kind"].as_array().unwrap().iter().enumerate() {
            let (a, b) = (
                start[i].as_u64().unwrap() as usize,
                start[i + 1].as_u64().unwrap() as usize,
            );
            out.push(Drawn {
                z: layer["z"].as_f64().unwrap(),
                kind: kinds[k.as_u64().unwrap() as usize]
                    .as_str()
                    .unwrap()
                    .to_string(),
                speed: speeds[i].as_f64().unwrap(),
                object: objects.map_or(0, |o| o[i].as_u64().unwrap()),
                pts: (a..b)
                    .map(|p| [xy[2 * p].as_f64().unwrap(), xy[2 * p + 1].as_f64().unwrap()])
                    .collect(),
            });
        }
    }
    out
}

fn is_wall(kind: &str) -> bool {
    matches!(kind, "wall" | "outer" | "inner")
}

/// `(z, walls)` of every layer, as the preview counts them.
fn walls_by_layer(reply: &Value) -> Vec<(f64, u64)> {
    reply["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["z"].as_f64().unwrap(),
                l["speedWalls"].as_u64().unwrap() + l["toughnessWalls"].as_u64().unwrap(),
            )
        })
        .collect()
}

/// How many wall beads the horizontal line `y` crosses left of `x_max` on
/// the layer at `z`.
fn wall_crossings(reply: &Value, z: f64, y: f64, x_max: f64) -> usize {
    drawn(reply)
        .iter()
        .filter(|d| (d.z - z).abs() < 1e-6 && is_wall(&d.kind))
        .flat_map(|d| d.pts.windows(2).map(|w| (w[0], w[1])).collect::<Vec<_>>())
        .filter(|(a, b)| {
            (a[1] - y) * (b[1] - y) < 0.0 && {
                let t = (y - a[1]) / (b[1] - a[1]);
                a[0] + (b[0] - a[0]) * t < x_max
            }
        })
        .count()
}

fn length(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
        .sum()
}

/// Sparse infill length of `object` on the layer at `z`, split into the
/// length `inside` holds, to 0.05 mm, and the rest.
fn sparse_split(
    reply: &Value,
    object: u64,
    z: f64,
    inside: impl Fn([f64; 2]) -> bool,
) -> (f64, f64) {
    let (mut inn, mut out) = (0.0, 0.0);
    for d in drawn(reply)
        .iter()
        .filter(|d| (d.z - z).abs() < 1e-6 && d.kind == "sparse" && d.object == object)
    {
        for w in d.pts.windows(2) {
            let n = (length(w) / 0.05).ceil().max(1.0);
            let step = length(w) / n;
            for i in 0..n as usize {
                let t = (i as f64 + 0.5) / n;
                let p = [
                    w[0][0] + (w[1][0] - w[0][0]) * t,
                    w[0][1] + (w[1][1] - w[0][1]) * t,
                ];
                if inside(p) {
                    inn += step;
                } else {
                    out += step;
                }
            }
        }
    }
    (inn, out)
}

#[test]
fn empty_lists_and_out_of_reach_entries_keep_the_bytes() {
    let plain = slice(&request(speed(), json!({}))).unwrap();
    let empty = slice(&request(
        speed(),
        json!({"heightRanges": [], "modifierVolumes": []}),
    ))
    .unwrap();
    let missed = slice(&request(
        speed(),
        json!({
            "heightRanges": [{"z": [40, 50], "walls": 6}],
            "modifierVolumes": [{"kind": "box", "center": [20, 20, 5], "size": [10, 10, 10], "infill": 1}],
        }),
    ))
    .unwrap();
    assert_eq!(empty["gcode"], plain["gcode"]);
    assert_eq!(missed["gcode"], plain["gcode"]);
    assert_eq!(missed["layers"], plain["layers"]);
}

#[test]
fn a_range_with_four_walls_prints_four_walls_on_its_layers_only() {
    let reply = slice(&request(
        speed(),
        json!({"heightRanges": [{"z": [1.9, 4.1], "walls": 4}]}),
    ))
    .unwrap();
    let layers = walls_by_layer(&reply);
    assert_eq!(layers.len(), 40);
    for &(z, walls) in &layers {
        let want = if (1.9..=4.1).contains(&z) { 4 } else { 2 };
        assert_eq!(walls, want, "walls at z {z}");
    }
    assert_eq!(layers.iter().filter(|l| l.1 == 4).count(), 9);
    let at_3 = reply["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["z"] == json!(3.0))
        .unwrap();
    assert!(
        at_3["note"].as_str().unwrap().starts_with("speed walls=4 "),
        "{}",
        at_3["note"]
    );

    // 0.2 mm layers land a hair off 2.0 and 4.0, and the ends still count.
    let fine = slice(&request(
        speed(),
        json!({"layerHeight": 0.2, "heightRanges": [{"z": [2, 4], "walls": 4}]}),
    ))
    .unwrap();
    let four: Vec<f64> = walls_by_layer(&fine)
        .into_iter()
        .filter(|l| l.1 == 4)
        .map(|l| (l.0 * 1000.0).round() / 1000.0)
        .collect();
    assert_eq!(four.len(), 11, "{four:?}");
    assert_eq!((four[0], four[10]), (2.0, 4.0));
}

#[test]
fn a_range_with_no_infill_keeps_walls_and_solid_skins() {
    let blend = json!({"mode": "weight", "toughness": 0.6});
    let base = slice(&request(blend.clone(), json!({}))).unwrap();
    let hollow = slice(&request(
        blend,
        json!({"heightRanges": [{"z": [0, 10], "infill": 0}]}),
    ))
    .unwrap();
    let layers_with = |reply: &Value, kinds: &[&str]| -> Vec<f64> {
        let mut zs: Vec<f64> = drawn(reply)
            .iter()
            .filter(|d| kinds.contains(&d.kind.as_str()))
            .map(|d| d.z)
            .collect();
        zs.dedup();
        zs
    };
    assert_eq!(layers_with(&base, &["sparse"]).len(), 35);
    assert_eq!(layers_with(&hollow, &["sparse"]), Vec::<f64>::new());
    let skins = layers_with(&hollow, &["solid", "top"]);
    assert_eq!(skins, vec![0.25, 0.5, 9.5, 9.75, 10.0]);
    assert_eq!(skins, layers_with(&base, &["solid", "top"]));
    assert_eq!(walls_by_layer(&hollow), walls_by_layer(&base));
}

#[test]
fn a_dense_box_changes_infill_only_inside_its_footprint() {
    let blend = json!({"mode": "weight", "toughness": 0.6});
    let base = slice(&request(blend.clone(), json!({}))).unwrap();
    let dense = slice(&request(
        blend,
        json!({"modifierVolumes": [{"kind": "box", "center": [100, 100, 5], "size": [16, 16, 20], "infill": 1}]}),
    ))
    .unwrap();
    let inside = |p: [f64; 2]| (p[0] - 100.0).abs() < 8.0 && (p[1] - 100.0).abs() < 8.0;
    let (base_in, base_out) = sparse_split(&base, 0, 5.0, inside);
    let (dense_in, dense_out) = sparse_split(&dense, 0, 5.0, inside);
    assert!(base_in > 50.0, "base inside {base_in}");
    let ratio_in = dense_in / base_in;
    assert!(
        (2.5..3.2).contains(&ratio_in),
        "inside {dense_in} / {base_in}"
    );
    let ratio_out = dense_out / base_out;
    assert!(
        (0.99..1.01).contains(&ratio_out),
        "outside {dense_out} / {base_out}"
    );
    assert_eq!(walls_by_layer(&dense), walls_by_layer(&base));
}

#[test]
fn walls_in_a_volume_follow_the_part_outline_not_the_volume_edge() {
    let reply = slice(&request(
        speed(),
        json!({"modifierVolumes": [{"kind": "box", "center": [80, 100, 5], "size": [20, 20, 20], "walls": 6}]}),
    ))
    .unwrap();
    assert_eq!(
        wall_crossings(&reply, 5.0, 100.0, 95.0),
        6,
        "inside the volume"
    );
    assert_eq!(
        wall_crossings(&reply, 5.0, 85.0, 95.0),
        2,
        "below the volume"
    );
    let stray = drawn(&reply)
        .iter()
        .filter(|d| is_wall(&d.kind))
        .flat_map(|d| d.pts.clone())
        .filter(|p| p[0] > 84.0 && p[0] < 116.0 && p[1] > 84.0 && p[1] < 116.0)
        .count();
    assert_eq!(
        stray, 0,
        "no wall runs along the volume's edge inside the part"
    );
}

/// A bead of the part. Travels, the skirt, and supports stay global.
fn part(kind: &str) -> bool {
    !matches!(kind, "travel" | "skirt" | "support" | "support-interface")
}

/// Every printed path point at least 0.05 mm from a zone edge has the
/// speed its zone gives.
fn check_speeds(reply: &Value, want: impl Fn([f64; 2]) -> Option<f64>) -> usize {
    let mut checked = 0;
    for d in drawn(reply).iter().filter(|d| part(&d.kind)) {
        for p in &d.pts {
            if let Some(speed) = want(*p) {
                assert_eq!(d.speed, speed, "{} at {p:?} z {}", d.kind, d.z);
                checked += 1;
            }
        }
    }
    checked
}

/// `Some(true)` inside the box `c ± h`, `Some(false)` outside, `None` within
/// 0.05 mm of its edge.
fn in_box(p: [f64; 2], c: [f64; 2], h: f64) -> Option<bool> {
    let d = (p[0] - c[0]).abs().max((p[1] - c[1]).abs()) - h;
    (d.abs() >= 0.05).then_some(d < 0.0)
}

#[test]
fn a_speed_cap_applies_inside_its_volume_only() {
    let base = slice(&request(speed(), json!({}))).unwrap();
    let capped = slice(&request(
        speed(),
        json!({"modifierVolumes": [{"kind": "cylinder", "center": [80, 80, 5], "size": [30, 30, 20], "speed": 20}]}),
    ))
    .unwrap();
    let r2 = |p: [f64; 2]| ((p[0] - 80.0).powi(2) + (p[1] - 80.0).powi(2)).sqrt() - 15.0;
    let mut inside = 0;
    for d in drawn(&capped).iter().filter(|d| part(&d.kind)) {
        for p in &d.pts {
            if r2(*p) < -0.05 {
                assert_eq!(d.speed, 20.0, "{} at {p:?}", d.kind);
                inside += 1;
            }
        }
    }
    assert!(inside > 500, "{inside} points checked inside");
    let outside = |reply: &Value| -> Vec<f64> {
        drawn(reply)
            .iter()
            .filter(|d| part(&d.kind) && d.pts.iter().all(|p| r2(*p) > 0.05))
            .map(|d| d.speed)
            .collect()
    };
    let (mut was, mut now) = (outside(&base), outside(&capped));
    was.sort_by(f64::total_cmp);
    was.dedup();
    now.sort_by(f64::total_cmp);
    now.dedup();
    assert_eq!(now, was);
    assert!(now.iter().all(|&s| s > 100.0), "{now:?}");
}

#[test]
fn the_later_volume_wins_and_a_range_applies_outside_every_volume() {
    let a = json!({"kind": "box", "center": [95, 100, 5], "size": [10, 10, 20], "speed": 50});
    let b = json!({"kind": "box", "center": [100, 100, 5], "size": [10, 10, 20], "speed": 60});
    let range = json!([{"z": [0, 10], "speed": 40}]);
    let ab = slice(&request(
        speed(),
        json!({"heightRanges": range, "modifierVolumes": [a, b]}),
    ))
    .unwrap();
    let ba = slice(&request(
        speed(),
        json!({"heightRanges": range, "modifierVolumes": [b, a]}),
    ))
    .unwrap();
    let zone = |p: [f64; 2], later_b: bool| -> Option<f64> {
        let in_a = in_box(p, [95.0, 100.0], 5.0)?;
        let in_b = in_box(p, [100.0, 100.0], 5.0)?;
        Some(match (in_a, in_b) {
            (true, true) if later_b => 60.0,
            (true, true) => 50.0,
            (false, true) => 60.0,
            (true, false) => 50.0,
            (false, false) => 40.0,
        })
    };
    assert!(check_speeds(&ab, |p| zone(p, true)) > 1000);
    assert!(check_speeds(&ba, |p| zone(p, false)) > 1000);
}

#[test]
fn refusals_name_their_field() {
    let refused = |extra: Value| slice(&request(speed(), extra)).unwrap_err();
    assert!(
        refused(json!({"heightRanges": [{"z": [0, 4], "layerHeight": 0.1}]}))
            .contains("unknown field `layerHeight`"),
    );
    assert!(
        refused(json!({"modifierVolumes": [{"kind": "box", "center": [0, 0, 0], "size": [1, 1, 1], "infil": 1}]}))
            .contains("unknown field `infil`"),
    );
    assert_eq!(
        refused(json!({"heightRanges": [{"z": [0, 4], "walls": 0}]})),
        "heightRanges[0]: walls 0 is outside 1 to 12"
    );
    assert_eq!(
        refused(json!({"heightRanges": [{"z": [4, 0]}]})),
        "heightRanges[0]: z runs low to high, got 4 to 0"
    );
    assert_eq!(
        refused(json!({"heightRanges": [{"z": [0, 4]}, {"z": [0, 4], "infill": 1.5}]})),
        "heightRanges[1]: infill 1.5 is outside 0 to 1"
    );
    assert_eq!(
        refused(
            json!({"modifierVolumes": [{"kind": "sphere", "center": [0, 0, 0], "size": [300, 10, 10]}]})
        ),
        "modifierVolumes[0]: size x 300 is outside 0.2 to 220 mm"
    );
    assert_eq!(
        refused(
            json!({"modifierVolumes": [{"kind": "box", "center": [0, 200000, 0], "size": [10, 10, 10]}]})
        ),
        "modifierVolumes[0]: center y 200000 is not a finite coordinate within 100000 mm"
    );
    assert_eq!(
        refused(
            json!({"modifierVolumes": [{"kind": "box", "center": [0, 0, 0], "size": [10, 10, 10], "speed": 0}]})
        ),
        "modifierVolumes[0]: speed 0 is outside 0 to 1000 mm/s"
    );
    let many: Vec<Value> = (0..65).map(|_| json!({"z": [0, 1]})).collect();
    assert_eq!(
        refused(json!({"heightRanges": many})),
        "heightRanges: 65 entries, at most 64 are allowed"
    );
}

/// A pose that seats the 20 mm box `box_stl(0, 0, 20, 20, 10)` with its
/// centre over `(x, y)`.
fn object(id: &str, x: f64, y: f64) -> Value {
    json!({
        "id": id,
        "filename": "box.stl",
        "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 20.0, 10.0)),
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": [10, 10, 5],
            "translation": [x, y, 5],
        },
    })
}

#[test]
fn a_plate_volume_reaches_each_object_it_meets_in_bed_coordinates() {
    let plate = |extra: Value| {
        let mut req = json!({
            "blend": {"mode": "weight", "toughness": 0.6},
            "layerHeight": 0.25,
            "includeGcode": true,
            "includePreview": true,
            "baseline": false,
            "objects": [object("a", 60.0, 110.0), object("b", 160.0, 110.0)],
        });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        slice(&req).unwrap()
    };
    let base = plate(json!({}));
    // Over b only, in bed millimetres: b's part frame is 50 mm left of it.
    let dense = plate(json!({
        "modifierVolumes": [{"kind": "box", "center": [160, 110, 5], "size": [8, 8, 20], "infill": 1}],
    }));
    assert_eq!(dense["objects"][0]["offset"], json!([-50.0, 0.0]));
    assert_eq!(dense["objects"][1]["offset"], json!([50.0, 0.0]));
    let of = |reply: &Value, object: u64| -> Vec<Value> {
        reply["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                let cols = &l["paths"];
                let objects = cols["object"].as_array().unwrap();
                let starts = cols["start"].as_array().unwrap();
                let xy = cols["xy"].as_array().unwrap();
                let picked: Vec<Value> = (0..objects.len())
                    .filter(|&i| objects[i] == json!(object))
                    .map(|i| {
                        let (a, b) = (
                            starts[i].as_u64().unwrap() as usize,
                            starts[i + 1].as_u64().unwrap() as usize,
                        );
                        json!(xy[2 * a..2 * b].to_vec())
                    })
                    .collect();
                json!(picked)
            })
            .collect()
    };
    assert_eq!(of(&dense, 0), of(&base, 0), "a is out of reach");
    assert!(of(&dense, 1) != of(&base, 1), "b prints the volume");
    let inside = |p: [f64; 2]| (p[0] - 110.0).abs() < 4.0 && (p[1] - 110.0).abs() < 4.0;
    let (base_in, _) = sparse_split(&base, 1, 5.0, inside);
    let (dense_in, _) = sparse_split(&dense, 1, 5.0, inside);
    assert!(
        dense_in > 2.5 * base_in,
        "b's part frame centre: {dense_in} vs {base_in}"
    );
    let refused = slice(&json!({
        "objects": [{
            "id": "a",
            "filename": "box.stl",
            "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 20.0, 10.0)),
            "settings": {"heightRanges": [{"z": [0, 1], "walls": 3}]},
        }],
    }))
    .unwrap_err();
    assert_eq!(
        refused,
        "objects[0].settings.heightRanges is a plate setting"
    );
}
