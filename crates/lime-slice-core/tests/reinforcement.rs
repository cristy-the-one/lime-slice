//! Painted columns and reinforcement volumes raise infill inside their
//! footprint and leave a slice that does not ask for them byte-identical.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
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

/// A wedge: 4 mm tall at x = 0, 10 mm tall at x = 20, 10 mm wide.
fn ramp_stl() -> String {
    let v = [
        [0.0, 0.0, 0.0],
        [20.0, 0.0, 0.0],
        [20.0, 10.0, 0.0],
        [0.0, 10.0, 0.0],
        [0.0, 0.0, 4.0],
        [0.0, 10.0, 4.0],
        [20.0, 0.0, 10.0],
        [20.0, 10.0, 10.0],
    ];
    let faces = [
        (0, 2, 1),
        (0, 3, 2),
        (0, 1, 6),
        (0, 6, 4),
        (3, 5, 7),
        (3, 7, 2),
        (1, 2, 7),
        (1, 7, 6),
        (0, 4, 5),
        (0, 5, 3),
        (4, 6, 7),
        (4, 7, 5),
    ];
    let mut out = String::from("solid ramp\n");
    for &(i, j, k) in &faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for p in [v[i], v[j], v[k]] {
            out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid ramp\n");
    out
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn speed() -> Value {
    json!({"mode": "single", "strategy": "speed"})
}

/// A 20 × 20 × 10 mm box on the origin, in print space.
fn request(blend: Value, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 20.0, 10.0)),
        "blend": blend,
        "layerHeight": 0.25,
        "lineWidth": 0.45,
        "infillCombine": false,
        "baseline": false,
        "compare": false,
        "supports": false,
        "includePreview": true,
        "includeGcode": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn slice(blend: Value, extra: Value) -> SliceResponse {
    let response = slice_request(&request(blend, extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

fn paint(p: [f64; 3], n: [f64; 3], r: f64, depth: f64, density: f64, fill: bool) -> Value {
    let mut region = json!({
        "kind": "paint",
        "density": density,
        "depthMm": depth,
        "disks": [{ "p": p, "n": n, "r": r }],
    });
    if fill {
        region["fillThrough"] = json!(true);
    }
    region
}

fn length(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()
}

/// Infill length of `kinds` on the layer at `z`, split by `inside`.
fn infill_split(
    reply: &SliceResponse,
    z: f64,
    kinds: &[&str],
    inside: impl Fn([f64; 2]) -> bool,
) -> (f64, f64) {
    let mut inn = 0.0;
    let mut out = 0.0;
    for layer in reply.layers.iter().filter(|l| (l.z - z).abs() < 1e-6) {
        for path in layer
            .paths
            .iter()
            .filter(|p| kinds.contains(&p.kind.as_str()))
        {
            for w in path.pts.windows(2) {
                let len = length(w[0], w[1]);
                if len < 1e-6 {
                    continue;
                }
                let n = (len / 0.05).ceil().max(1.0);
                let step = len / n;
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
    }
    (inn, out)
}

fn solid_inside(reply: &SliceResponse, z: f64, inside: impl Fn([f64; 2]) -> bool) -> (f64, f64) {
    infill_split(reply, z, &["solid", "sparse"], inside)
}

fn note_at(reply: &SliceResponse, z: f64) -> String {
    reply
        .layers
        .iter()
        .find(|l| (l.z - z).abs() < 1e-6)
        .map(|l| l.note.clone())
        .unwrap_or_default()
}

fn disk_top(depth: f64, density: f64, fill: bool) -> Value {
    paint(
        [10.0, 10.0, 10.0],
        [0.0, 0.0, 1.0],
        4.0,
        depth,
        density,
        fill,
    )
}

/// Inside the r = 4 column, clear of the boundary and of the walls.
fn in_column(p: [f64; 2]) -> bool {
    let d = ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt();
    d < 2.6
}

fn out_column(p: [f64; 2]) -> bool {
    let d = ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt();
    d > 5.0 && p[0] > 1.5 && p[0] < 18.5 && p[1] > 1.5 && p[1] < 18.5
}

#[test]
fn an_absent_field_and_an_empty_list_slice_the_same_gcode() {
    let plain = slice(speed(), json!({}));
    let empty = slice(speed(), json!({"reinforcement": []}));
    assert_eq!(empty.gcode, plain.gcode);
    assert!(!plain.gcode.contains("reinforce"));
    let wire = serde_json::to_value(request(speed(), json!({}))).unwrap();
    assert!(wire.get("reinforcement").is_none());
}

#[test]
fn a_hollow_top_disk_is_solid_within_its_depth_only() {
    let reply = slice(
        speed(),
        json!({"infill": 0, "reinforcement": [disk_top(5.0, 1.0, false)]}),
    );
    let (at_7, _) = solid_inside(&reply, 7.0, in_column);
    let (out_7, _) = solid_inside(&reply, 7.0, out_column);
    assert!(at_7 > 15.0, "solid inside the column {at_7}");
    assert!(out_7 < 1.0, "infill outside the column {out_7}");
    let (below, below_out) = solid_inside(&reply, 4.0, |_| true);
    assert!(
        below + below_out < 1.0,
        "no infill below the depth {}",
        below + below_out
    );
    assert!(
        note_at(&reply, 7.0).contains(" · reinforce 0"),
        "{}",
        note_at(&reply, 7.0)
    );
    assert!(!note_at(&reply, 4.0).contains("reinforce"));
}

#[test]
fn fill_through_reaches_a_layer_past_the_depth() {
    let reply = slice(
        speed(),
        json!({"infill": 0, "reinforcement": [disk_top(5.0, 1.0, true)]}),
    );
    let (deep, _) = solid_inside(&reply, 3.0, in_column);
    let (outside, _) = solid_inside(&reply, 3.0, out_column);
    assert!(deep > 15.0, "solid past 5 mm {deep}");
    assert!(outside < 1.0, "still none outside {outside}");
}

#[test]
fn a_disk_on_a_side_wall_reinforces_inward() {
    let reply = slice(
        speed(),
        json!({
            "infill": 0,
            "reinforcement": [paint([20.0, 10.0, 5.0], [1.0, 0.0, 0.0], 3.0, 5.0, 1.0, false)],
        }),
    );
    let inward = |p: [f64; 2]| p[0] > 16.2 && p[0] < 18.6 && (p[1] - 10.0).abs() < 1.2;
    let past = |p: [f64; 2]| p[0] > 8.0 && p[0] < 12.0 && (p[1] - 10.0).abs() < 2.0;
    let (near, _) = solid_inside(&reply, 5.0, inward);
    let (far, _) = solid_inside(&reply, 5.0, past);
    let (below, _) = solid_inside(&reply, 1.0, |_| true);
    assert!(near > 8.0, "inward of the wall {near}");
    assert!(far < 1.0, "past the depth {far}");
    assert!(below < 1.0, "not downward {below}");
}

#[test]
fn a_later_region_wins_the_overlap_and_leaves_the_rest() {
    let wide = paint([10.0, 10.0, 10.0], [0.0, 0.0, 1.0], 6.0, 5.0, 1.0, false);
    let tight = paint([10.0, 10.0, 10.0], [0.0, 0.0, 1.0], 2.5, 5.0, 0.35, false);
    let reply = slice(
        speed(),
        json!({"infill": 0, "reinforcement": [wide, tight]}),
    );
    let centre = |p: [f64; 2]| ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt() < 1.2;
    let ring = |p: [f64; 2]| {
        let d = ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt();
        (3.6..5.0).contains(&d)
    };
    let (solid_mid, sparse_mid) = infill_split(&reply, 6.0, &["solid"], centre);
    let (sparse_only, _) = infill_split(&reply, 6.0, &["sparse"], centre);
    let (ring_solid, _) = infill_split(&reply, 6.0, &["solid"], ring);
    let past_both = |p: [f64; 2]| {
        let d = ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt();
        d > 7.2 && p[0] > 1.5 && p[0] < 18.5 && p[1] > 1.5 && p[1] < 18.5
    };
    let (outside, _) = solid_inside(&reply, 6.0, past_both);
    assert!(
        solid_mid < 1.0 && sparse_only > 2.0,
        "overlap is the later 35%, solid {solid_mid} sparse {sparse_only} other {sparse_mid}"
    );
    assert!(
        ring_solid > 8.0,
        "the first region stays solid {ring_solid}"
    );
    assert!(outside < 1.0, "outside both {outside}");
}

#[test]
fn a_region_at_or_below_the_strategy_matches_the_unreinforced_gcode() {
    let plain = slice(speed(), json!({})).gcode;
    let at = slice(
        speed(),
        json!({"reinforcement": [disk_top(5.0, 0.12, false)]}),
    );
    let below = slice(
        speed(),
        json!({"reinforcement": [disk_top(5.0, 0.05, false)]}),
    );
    assert_eq!(at.gcode, plain);
    assert_eq!(below.gcode, plain);
}

#[test]
fn a_box_and_a_cylinder_raise_infill_only_inside_the_footprint() {
    let box_region = json!({
        "kind": "box",
        "density": 1,
        "center": [10, 10, 5],
        "size": [8, 8, 12],
    });
    let cyl_region = json!({
        "kind": "cylinder",
        "density": 1,
        "center": [10, 10, 5],
        "size": [8, 8, 12],
    });
    let boxed = slice(speed(), json!({"infill": 0, "reinforcement": [box_region]}));
    let round = slice(speed(), json!({"infill": 0, "reinforcement": [cyl_region]}));
    let in_box = |p: [f64; 2]| (p[0] - 10.0).abs() < 2.8 && (p[1] - 10.0).abs() < 2.8;
    let out_box = |p: [f64; 2]| (p[0] - 10.0).abs() > 5.0 && (p[1] - 10.0).abs() < 6.0;
    let (bin, _) = solid_inside(&boxed, 5.0, in_box);
    let (bout, _) = solid_inside(&boxed, 5.0, out_box);
    assert!(bin > 15.0, "box inside {bin}");
    assert!(bout < 1.0, "box outside {bout}");
    let in_cyl = |p: [f64; 2]| ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt() < 2.6;
    let out_cyl = |p: [f64; 2]| ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt() > 5.0;
    let (cin, _) = solid_inside(&round, 5.0, in_cyl);
    let (cout, _) = solid_inside(&round, 5.0, out_cyl);
    assert!(cin > 12.0, "cylinder inside {cin}");
    assert!(cout < 1.0, "cylinder outside {cout}");
}

fn wall_crossings(reply: &SliceResponse, z: f64, y: f64, x_max: f64) -> usize {
    reply
        .layers
        .iter()
        .filter(|l| (l.z - z).abs() < 1e-6)
        .flat_map(|l| l.paths.iter())
        .filter(|p| matches!(p.kind.as_str(), "wall" | "outer" | "inner"))
        .flat_map(|p| p.pts.windows(2))
        .filter(|w| {
            (w[0][1] - y) * (w[1][1] - y) < 0.0 && {
                let t = (y - w[0][1]) / (w[1][1] - w[0][1]);
                w[0][0] + (w[1][0] - w[0][0]) * t < x_max
            }
        })
        .count()
}

#[test]
fn a_modifier_keeps_its_wall_count_inside_an_overlapping_reinforcement() {
    let volume = json!({
        "kind": "box",
        "center": [80, 100, 5],
        "size": [20, 20, 20],
        "walls": 6,
    });
    let region = json!({
        "kind": "box",
        "density": 1,
        "center": [84, 100, 5],
        "size": [16, 16, 20],
    });
    let body = |extra: Value| {
        let mut req = json!({
            "filename": "box.stl",
            "dataB64": b64(&box_stl(80.0, 80.0, 120.0, 120.0, 10.0)),
            "blend": speed(),
            "layerHeight": 0.25,
            "infill": 0,
            "baseline": false,
            "includePreview": true,
            "includeGcode": false,
        });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        let response =
            slice_request(&serde_json::from_value(req).unwrap(), Job::default()).unwrap();
        assert!(response.sanity.ok, "{:?}", response.sanity.notes);
        response
    };
    let walls = body(json!({"modifierVolumes": [volume]}));
    let both = body(json!({"modifierVolumes": [volume], "reinforcement": [region]}));
    assert_eq!(wall_crossings(&walls, 5.0, 100.0, 95.0), 6);
    assert_eq!(wall_crossings(&both, 5.0, 100.0, 95.0), 6);
    assert!(
        note_at(&both, 5.0).contains(" · reinforce 0"),
        "{}",
        note_at(&both, 5.0)
    );
}

#[test]
fn a_rotated_disk_follows_the_part() {
    // 90° about Z moves the +X face to +Y. A forgotten rotation would reinforce +X.
    let req = json!({
        "filename": "box.stl",
        "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 20.0, 10.0)),
        "blend": speed(),
        "layerHeight": 0.25,
        "infill": 0,
        "infillCombine": false,
        "baseline": false,
        "includePreview": true,
        "includeGcode": false,
        "pose": {
            "rotation": [0, -1, 0, 1, 0, 0, 0, 0, 1],
            "pivot": [10, 10, 5],
            "translation": [110, 110, 5],
        },
        "reinforcement": [paint([20.0, 10.0, 5.0], [1.0, 0.0, 0.0], 3.0, 5.0, 1.0, false)],
    });
    let reply = slice_request(&serde_json::from_value(req).unwrap(), Job::default()).unwrap();
    assert!(reply.sanity.ok, "{:?}", reply.sanity.notes);
    let on_y = |p: [f64; 2]| (p[0] - 110.0).abs() < 1.2 && p[1] > 116.2 && p[1] < 118.8;
    let on_x = |p: [f64; 2]| (p[1] - 110.0).abs() < 1.2 && p[0] > 116.2 && p[0] < 118.8;
    let (moved, _) = solid_inside(&reply, 5.0, on_y);
    let (stayed, _) = solid_inside(&reply, 5.0, on_x);
    assert!(moved > 6.0, "column on the rotated face {moved}");
    assert!(stayed < 1.0, "not left on +X {stayed}");
}

#[test]
fn a_belt_moves_the_disk_with_the_mesh() {
    let belt = json!({
        "angleDeg": 45.0,
        "axis": "z",
        "direction": 1,
        "widthMm": 220.0,
        "copies": 1,
        "gapMm": 5.0,
    });
    let run = |extra: Value| {
        let mut body = json!({
            "filename": "box.stl",
            "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 10.0, 10.0)),
            "layerHeight": 0.2,
            "infill": 0,
            "infillCombine": false,
            "baseline": false,
            "includePreview": false,
            "includeGcode": true,
            "belt": belt,
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        let response =
            slice_request(&serde_json::from_value(body).unwrap(), Job::default()).unwrap();
        assert!(response.sanity.ok, "{:?}", response.sanity.notes);
        response.gcode
    };
    let bare = run(json!({}));
    let dab = paint([10.0, 5.0, 10.0], [0.0, 0.0, 1.0], 4.0, 6.0, 1.0, false);
    let painted = run(json!({"reinforcement": [dab]}));
    assert_ne!(painted, bare);
    assert!(painted.contains(" · reinforce 0"));
    assert!(!bare.contains("reinforce"));
}

#[test]
fn adaptive_layers_inside_the_column_are_reinforced() {
    let region = json!({
        "kind": "box",
        "density": 1,
        "center": [12, 5, 4],
        "size": [6, 6, 4],
    });
    let req = json!({
        "filename": "ramp.stl",
        "dataB64": b64(&ramp_stl()),
        "blend": speed(),
        "layerHeight": 0.2,
        "adaptive": true,
        "adaptiveMin": 0.08,
        "adaptiveMax": 0.28,
        "infill": 0,
        "infillCombine": false,
        "baseline": false,
        "includePreview": true,
        "includeGcode": false,
        "reinforcement": [region],
    });
    let reply = slice_request(&serde_json::from_value(req).unwrap(), Job::default()).unwrap();
    assert!(reply.sanity.ok, "{:?}", reply.sanity.notes);
    let mut heights: Vec<i32> = reply
        .layers
        .iter()
        .map(|l| (l.height * 1000.0).round() as i32)
        .collect();
    heights.sort_unstable();
    heights.dedup();
    assert!(heights.len() >= 2, "heights {heights:?}");
    let inside = |p: [f64; 2]| (p[0] - 12.0).abs() < 2.0 && (p[1] - 5.0).abs() < 2.0;
    let hit: Vec<f64> = reply
        .layers
        .iter()
        .filter(|l| (2.4..5.6).contains(&l.z))
        .map(|l| l.z)
        .filter(|&z| solid_inside(&reply, z, inside).0 > 4.0)
        .collect();
    assert!(hit.len() >= 2, "reinforced layers {hit:?}");
    let below: Vec<f64> = reply
        .layers
        .iter()
        .filter(|l| (1.0..1.8).contains(&l.z))
        .map(|l| l.z)
        .collect();
    assert!(!below.is_empty(), "a layer under the box");
    for z in below {
        let (inn, _) = solid_inside(&reply, z, inside);
        assert!(inn < 1.0, "z {z} is under the box and has {inn}");
    }
}

fn segment_angles(reply: &SliceResponse, z: f64, kind: &str) -> Vec<f64> {
    let mut out = Vec::new();
    for layer in reply.layers.iter().filter(|l| (l.z - z).abs() < 1e-6) {
        for path in layer.paths.iter().filter(|p| p.kind == kind) {
            for w in path.pts.windows(2) {
                let len = length(w[0], w[1]);
                if len < 1.5 {
                    continue;
                }
                let mut a = (w[1][1] - w[0][1]).atan2(w[1][0] - w[0][0]).abs();
                if a > std::f64::consts::FRAC_PI_2 {
                    a = std::f64::consts::PI - a;
                }
                out.push(a.to_degrees());
            }
        }
    }
    out
}

fn weight(t: f64) -> Value {
    json!({"mode": "weight", "toughness": t})
}

#[test]
fn lines_grid_and_gyroid_keep_their_pattern_at_the_new_spacing() {
    let region = json!({
        "kind": "box",
        "density": 0.6,
        "center": [10, 10, 5],
        "size": [12, 12, 12],
    });
    let run = |t: f64, extra: Value| {
        let mut body = json!({
            "infillCombine": false,
            "reinforcement": [region.clone()],
        });
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                body[k] = v.clone();
            }
        }
        slice(weight(t), body)
    };
    let lines = run(0.3, json!({}));
    let plain = slice(weight(0.3), json!({"infillCombine": false}));
    let (raised, _) = infill_split(&lines, 5.0, &["sparse"], |p| {
        (p[0] - 10.0).abs() < 4.0 && (p[1] - 10.0).abs() < 4.0
    });
    let (base, _) = infill_split(&plain, 5.0, &["sparse"], |p| {
        (p[0] - 10.0).abs() < 4.0 && (p[1] - 10.0).abs() < 4.0
    });
    assert!(raised > base * 1.6, "denser lines {raised} vs {base}");
    let line_angles = segment_angles(&lines, 5.0, "sparse");
    assert!(line_angles.len() > 4, "{line_angles:?}");
    let flat = line_angles.iter().filter(|a| **a < 8.0).count();
    assert!(
        flat * 5 > line_angles.len() * 4,
        "lines stay horizontal {line_angles:?}"
    );
    assert!(
        line_angles.iter().all(|a| *a < 8.0 || *a > 82.0),
        "line joins stay on the axes {line_angles:?}"
    );

    let grid = run(0.6, json!({}));
    let grid_angles = segment_angles(&grid, 5.0, "sparse");
    let flat = grid_angles.iter().filter(|a| **a < 8.0).count();
    let upright = grid_angles.iter().filter(|a| **a > 82.0).count();
    assert!(flat > 3 && upright > 3, "grid {grid_angles:?}");
    assert!(
        grid_angles.iter().all(|a| *a < 8.0 || *a > 82.0),
        "grid stays on the axes {grid_angles:?}"
    );

    let gyroid = run(0.85, json!({}));
    let mut buckets = [0u32; 6];
    for path_z in [5.0] {
        for layer in gyroid.layers.iter().filter(|l| (l.z - path_z).abs() < 1e-6) {
            for path in layer.paths.iter().filter(|p| p.kind == "sparse") {
                for w in path.pts.windows(2) {
                    if length(w[0], w[1]) < 0.3 {
                        continue;
                    }
                    let mut a = (w[1][1] - w[0][1]).atan2(w[1][0] - w[0][0]).abs();
                    if a > std::f64::consts::FRAC_PI_2 {
                        a = std::f64::consts::PI - a;
                    }
                    let bin = ((a.to_degrees() / 15.0).floor() as usize).min(5);
                    buckets[bin] += 1;
                }
            }
        }
    }
    let spread = buckets.iter().filter(|n| **n > 2).count();
    assert!(spread >= 4, "gyroid angles {buckets:?}");
}

#[test]
fn lightning_becomes_grid_and_full_density_is_solid() {
    let tall = |extra: Value| {
        let mut body = json!({
            "filename": "box.stl",
            "dataB64": b64(&box_stl(0.0, 0.0, 20.0, 20.0, 16.0)),
            "blend": speed(),
            "layerHeight": 0.4,
            "infillCombine": false,
            "baseline": false,
            "includePreview": true,
            "includeGcode": false,
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        let response =
            slice_request(&serde_json::from_value(body).unwrap(), Job::default()).unwrap();
        assert!(response.sanity.ok, "{:?}", response.sanity.notes);
        response
    };
    let region = json!({
        "kind": "box",
        "density": 0.5,
        "center": [10, 10, 8],
        "size": [12, 12, 16],
    });
    let plain = tall(json!({}));
    let raised = tall(json!({"reinforcement": [region]}));
    let inside = |p: [f64; 2]| (p[0] - 10.0).abs() < 4.0 && (p[1] - 10.0).abs() < 4.0;
    let (before, _) = infill_split(&plain, 8.0, &["sparse"], inside);
    let (after, _) = infill_split(&raised, 8.0, &["sparse"], inside);
    assert!(
        after > before * 4.0 + 20.0,
        "grid {after} vs lightning {before}"
    );
    let angles = segment_angles(&raised, 8.0, "sparse");
    assert!(angles.len() > 4, "{angles:?}");
    assert!(
        angles.iter().all(|a| *a < 8.0 || *a > 82.0),
        "lightning became grid {angles:?}"
    );

    let solid = slice(
        weight(0.3),
        json!({"infillCombine": false, "reinforcement": [{
            "kind": "box", "density": 1, "center": [10, 10, 5], "size": [12, 12, 12]
        }]}),
    );
    let (solid_len, _) = infill_split(&solid, 5.0, &["solid"], inside);
    let (sparse_len, _) = infill_split(&solid, 5.0, &["sparse"], inside);
    assert!(solid_len > 20.0, "density 1 is solid {solid_len}");
    assert!(sparse_len < 1.0, "no sparse left inside {sparse_len}");
}

#[test]
fn classic_keeps_the_reinforcement() {
    let plain = slice(speed(), json!({"classic": true, "infill": 0}));
    let reply = slice(
        speed(),
        json!({"classic": true, "infill": 0, "reinforcement": [disk_top(5.0, 1.0, false)]}),
    );
    assert_ne!(reply.gcode, plain.gcode);
    let (inside, _) = infill_split(&reply, 7.0, &["solid", "sparse", "infill"], in_column);
    let (outside, _) = infill_split(&reply, 7.0, &["solid", "sparse", "infill"], out_column);
    assert!(inside > 15.0, "classic still fills the column {inside}");
    assert!(outside < 1.0, "{outside}");
}

#[test]
fn a_top_level_list_beside_objects_is_refused_and_an_object_list_works() {
    let mesh = b64(&box_stl(0.0, 0.0, 20.0, 20.0, 10.0));
    let object = |reinforcement: Value| {
        json!({
            "id": "a",
            "filename": "box.stl",
            "dataB64": mesh.clone(),
            "reinforcement": reinforcement,
        })
    };
    let refused = slice_request(
        &serde_json::from_value(json!({
            "blend": speed(),
            "baseline": false,
            "includePreview": false,
            "includeGcode": true,
            "objects": [object(json!([]))],
            "reinforcement": [disk_top(5.0, 1.0, false)],
        }))
        .unwrap(),
        Job::default(),
    )
    .unwrap_err();
    assert_eq!(
        refused,
        "reinforcement belongs on each object when objects is sent"
    );
    let bare = slice_request(
        &serde_json::from_value(json!({
            "blend": speed(),
            "infill": 0,
            "layerHeight": 0.25,
            "infillCombine": false,
            "baseline": false,
            "includePreview": true,
            "includeGcode": true,
            "objects": [object(json!([]))],
        }))
        .unwrap(),
        Job::default(),
    )
    .unwrap();
    let painted = slice_request(
        &serde_json::from_value(json!({
            "blend": speed(),
            "infill": 0,
            "layerHeight": 0.25,
            "infillCombine": false,
            "baseline": false,
            "includePreview": true,
            "includeGcode": true,
            "objects": [object(json!([disk_top(5.0, 1.0, false)]))],
        }))
        .unwrap(),
        Job::default(),
    )
    .unwrap();
    assert!(painted.sanity.ok, "{:?}", painted.sanity.notes);
    assert_ne!(painted.gcode, bare.gcode);
    assert!(note_at(&painted, 7.0).contains(" · reinforce 0"));
}

#[test]
fn refusals_name_the_field() {
    let refuse =
        |extra: Value| slice_request(&request(speed(), extra), Job::default()).unwrap_err();
    let disk = json!({"p": [0, 0, 0], "n": [0, 0, 1], "r": 1});
    assert_eq!(
        refuse(json!({"reinforcement": [{"kind": "sphere", "density": 1}]})),
        "reinforcement[0].kind \"sphere\" is not paint, box, or cylinder"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1.5, "depthMm": 5, "disks": [disk]}]})
        ),
        "reinforcement[0].density 1.5 is outside 0 to 1"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 0.1, "fillThrough": true, "disks": [disk]}]})
        ),
        "reinforcement[0].depthMm 0.1 is outside 0.2 to 100 mm"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 5, "disks": []}]})
        ),
        "reinforcement[0].disks is empty"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 5, "fillThrough": "yes", "disks": [disk]}]})
        ),
        "reinforcement[0].fillThrough is not a boolean"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 5, "disks": [disk], "nope": 1}]})
        ),
        "reinforcement[0]: unknown field `nope`"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 5, "disks": [{"p": [0, 0, 0], "n": [0, 0, 0], "r": 1}]}]})
        ),
        "reinforcement[0].disks[0].n has zero length"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "paint", "density": 1, "depthMm": 5, "disks": [{"p": [0, 0, 0], "n": [0, 0, 1], "r": 0.1}]}]})
        ),
        "reinforcement[0].disks[0].r 0.1 is outside 0.2 to 40 mm"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "box", "density": 1, "center": [0, 0, 0], "size": [0.1, 10, 10]}]})
        ),
        "reinforcement[0].size 0.1 is outside 0.2 to 10000 mm on x"
    );
    assert_eq!(
        refuse(
            json!({"reinforcement": [{"kind": "box", "density": 1, "center": [0, 200000, 0], "size": [10, 10, 10]}]})
        ),
        "reinforcement[0].center 200000 is not a finite coordinate within 100000 mm"
    );
    let many: Vec<Value> = (0..65).map(|_| json!({})).collect();
    assert_eq!(
        refuse(json!({"reinforcement": many})),
        "reinforcement: 65 entries, at most 64 are allowed"
    );
    let bad = slice_request(
        &serde_json::from_value(json!({
            "baseline": false,
            "objects": [{
                "id": "a",
                "filename": "box.stl",
                "dataB64": b64(&box_stl(0.0, 0.0, 10.0, 10.0, 4.0)),
                "reinforcement": [{"kind": "paint", "density": 1.5, "depthMm": 5, "disks": [disk]}],
            }],
        }))
        .unwrap(),
        Job::default(),
    )
    .unwrap_err();
    assert_eq!(
        bad,
        "objects[0]: reinforcement[0].density 1.5 is outside 0 to 1"
    );
}
