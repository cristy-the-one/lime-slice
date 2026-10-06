//! A small belt slice: advance, copies, fit errors, and a tilted preview.
//! Cartesian requests are covered by `cartesian_lock`.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest};
use serde_json::{json, Value};

fn box_stl(x: f64, y: f64, z: f64) -> String {
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

fn belt(angle: f64, axis: &str, copies: u32, gap: f64) -> Value {
    json!({
        "angleDeg": angle,
        "axis": axis,
        "direction": 1,
        "widthMm": 220.0,
        "copies": copies,
        "gapMm": gap,
    })
}

fn request(stl: &str, name: &str, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": name,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn layer_zs(gcode: &str) -> Vec<f64> {
    gcode
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix(";LAYER:")?;
            let z = rest.split_whitespace().nth(1)?;
            let z = z.strip_prefix("Z:")?;
            z.parse().ok()
        })
        .collect()
}

fn steps_of(zs: &[f64]) -> Vec<f64> {
    zs.windows(2).map(|w| w[1] - w[0]).collect()
}

#[test]
fn a_45_degree_belt_steps_by_layer_height_over_sine() {
    let req = request(
        &box_stl(10.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": belt(45.0, "z", 1, 5.0) }),
    );
    let response = slice_request(&req, Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    assert!(response.gcode.contains("; belt: angle 45 axis Z dir +1\n"));
    assert!(response.gcode.contains("; TYPE:"));
    assert!(
        response.estimate.seconds > 0.0,
        "{}",
        response.estimate.seconds
    );
    let zs = layer_zs(&response.gcode);
    assert!(zs.len() > 4, "{}", zs.len());
    let step = 0.2 * std::f64::consts::SQRT_2;
    let dzs = steps_of(&zs);
    // The top band can be a short remainder. Every other step is h / sin(α).
    for (i, dz) in dzs.iter().take(dzs.len() - 1).enumerate() {
        assert!(
            (dz - step).abs() < 1e-3,
            "layer {i} stepped {dz}, want {step}"
        );
    }
    let first = zs[0];
    assert!((first - step).abs() < 1e-3, "first belt position {first}");
    // Lab height, not the belt position: the box is 2 mm tall.
    assert!(response.mesh.max[2] < 3.0, "{:?}", response.mesh.max);
    assert!(response.mesh.max[2] > 1.5, "{:?}", response.mesh.max);
    let tilted = response.layers.iter().any(|layer| {
        layer.paths.iter().any(|path| {
            let zs = &path.zs;
            zs.len() >= 2
                && (zs.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                    - zs.iter().copied().fold(f64::INFINITY, f64::min))
                    > 0.2
        })
    });
    assert!(tilted, "preview zs should slant");
    let belt_z = response.layers[0].z;
    assert!((belt_z - first).abs() < 1e-3, "scrubber z {belt_z}");
    // Later layers still slow the belt-contact edge to 30 mm/s. The rest stays faster.
    let (slow, fast) = belt_wall_feeds(&response.gcode);
    assert!(slow, "no 30 mm/s extrusion after layer 0");
    assert!(fast, "belt wall slowed every extrusion");
}

/// `(saw 30 mm/s, saw something faster)` on extrusions after layer 0.
fn belt_wall_feeds(gcode: &str) -> (bool, bool) {
    let mut slow = false;
    let mut fast = false;
    let mut past_first = false;
    for line in gcode.lines() {
        if line.starts_with(";LAYER:") {
            past_first = !line.starts_with(";LAYER:0 ");
        }
        if !past_first || !line.starts_with("G1 ") || !line.contains(" E") {
            continue;
        }
        let Some(feed) = line
            .split_whitespace()
            .find_map(|word| word.strip_prefix('F'))
        else {
            continue;
        };
        let Ok(feed) = feed.parse::<f64>() else {
            continue;
        };
        if (feed - 1800.0).abs() < 1.0 {
            slow = true;
        } else if feed > 3000.0 {
            fast = true;
        }
    }
    (slow, fast)
}

#[test]
fn a_35_degree_step_is_sine_not_cosine() {
    let req = request(
        &box_stl(8.0, 8.0, 1.6),
        "box.stl",
        json!({ "belt": belt(35.0, "z", 1, 5.0) }),
    );
    let response = slice_request(&req, Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let zs = layer_zs(&response.gcode);
    let step = 0.2 / 35.0_f64.to_radians().sin();
    let cosine = 0.2 / 35.0_f64.to_radians().cos();
    let dz = zs[1] - zs[0];
    assert!((dz - step).abs() < 1e-3, "{dz} vs sine {step}");
    assert!((dz - cosine).abs() > 1e-3, "{dz} matched cosine {cosine}");
}

#[test]
fn copies_repeat_the_plan_one_stride_apart() {
    let req = request(
        &box_stl(10.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": belt(45.0, "z", 2, 5.0) }),
    );
    let one = request(
        &box_stl(10.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": belt(45.0, "z", 1, 5.0), "includePreview": false }),
    );
    let copied = slice_request(&req, Job::default()).unwrap();
    let single = slice_request(&one, Job::default()).unwrap();
    assert!(copied.sanity.ok, "{:?}", copied.sanity.notes);
    let zs = layer_zs(&copied.gcode);
    let one_zs = layer_zs(&single.gcode);
    assert_eq!(zs.len(), one_zs.len() * 2);
    // 10 mm along the belt plus 2 mm of height, at 45°, is a 12 mm footprint.
    let stride = 12.0 + 5.0;
    let jump = zs[one_zs.len()] - zs[0];
    assert!(
        (jump - stride).abs() < 1e-2,
        "copy gap {jump}, stride {stride}"
    );
    assert!(copied.estimate.seconds > single.estimate.seconds);
}

#[test]
fn axis_y_writes_the_belt_step_on_y() {
    let mut spec = belt(45.0, "y", 1, 5.0);
    spec["direction"] = json!(-1);
    let req = request(
        &box_stl(8.0, 8.0, 1.6),
        "box.stl",
        json!({ "belt": spec, "includePreview": false }),
    );
    let response = slice_request(&req, Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    assert!(response.gcode.contains("; belt: angle 45 axis Y dir -1\n"));
    let layer = response
        .gcode
        .lines()
        .skip_while(|line| !line.starts_with(";LAYER:"))
        .nth(1)
        .unwrap();
    assert!(layer.starts_with("G1 Y"), "{layer}");
    assert!(layer_zs(&response.gcode)[0] < 0.0);
}

#[test]
fn fit_errors_name_the_field() {
    let wide = request(
        &box_stl(20.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": { "angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 10, "copies": 1, "gapMm": 0 } }),
    );
    let err = slice_request(&wide, Job::default()).unwrap_err();
    assert!(err.contains("belt.widthMm"), "{err}");

    let long = request(
        &box_stl(10.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": { "angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 220, "maxLengthMm": 10, "copies": 1, "gapMm": 0 } }),
    );
    let err = slice_request(&long, Job::default()).unwrap_err();
    assert!(err.contains("belt.maxLengthMm"), "{err}");

    let angle = request(
        &box_stl(10.0, 10.0, 2.0),
        "box.stl",
        json!({ "belt": { "angleDeg": 5, "axis": "z", "direction": 1, "widthMm": 220, "copies": 1, "gapMm": 0 } }),
    );
    let err = slice_request(&angle, Job::default()).unwrap_err();
    assert!(err.contains("belt.angleDeg"), "{err}");
}

#[test]
fn supports_edits_and_compare_are_refused() {
    let ledge = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/overhang_ledge.stl"),
    )
    .unwrap();
    let mut body = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(ledge),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "supports": true,
        "belt": belt(45.0, "z", 1, 5.0),
    });
    let sliced = slice_request(
        &serde_json::from_value(body.clone()).unwrap(),
        Job::default(),
    )
    .unwrap();
    assert!(sliced.sanity.ok, "{:?}", sliced.sanity.notes);
    assert!(
        !sliced.gcode.contains("TYPE:SUPPORT"),
        "horizontal supports were emitted"
    );

    body["compare"] = json!(true);
    let err = slice_request(
        &serde_json::from_value(body.clone()).unwrap(),
        Job::default(),
    )
    .unwrap_err();
    assert!(err.contains("compare"), "{err}");

    body["compare"] = json!(false);
    body["supportEdits"] = json!([{ "kind": "prune", "sites": [{ "xy": [1.0, 1.0], "z": 0.2 }] }]);
    let err = slice_request(
        &serde_json::from_value(body.clone()).unwrap(),
        Job::default(),
    )
    .unwrap_err();
    assert!(err.contains("support edits"), "{err}");

    body.as_object_mut().unwrap().remove("supportEdits");
    body["supportPaint"] =
        json!([{ "kind": "block", "p": [1.0, 1.0, 1.0], "n": [0.0, 0.0, 1.0], "r": 1.0 }]);
    let err = slice_request(&serde_json::from_value(body).unwrap(), Job::default()).unwrap_err();
    assert!(err.contains("support paint"), "{err}");
}

#[test]
fn seam_on_the_belt_edge_is_opt_in() {
    use sha2::{Digest, Sha256};
    let stl = box_stl(20.0, 10.0, 2.0);
    let aligned = belt(45.0, "z", 1, 5.0);
    let off = request(
        &stl,
        "box.stl",
        json!({ "belt": aligned, "seam": "aligned", "includePreview": false }),
    );
    let wire = serde_json::to_value(&off).unwrap();
    assert!(wire["belt"].get("seamOnEdge").is_none(), "{}", wire["belt"]);
    let off_gcode = slice_request(&off, Job::default()).unwrap().gcode;
    let hash = off_gcode
        .as_bytes()
        .iter()
        .fold(Sha256::new(), |mut h, b| {
            h.update([*b]);
            h
        });
    // Aligned, with the flag omitted. Captured after the flag existed and
    // stayed off, so this is the belt file a request without the flag writes.
    let hex: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex,
        "ec5ebbe00e225386353f1090c1dc86bb8514a2f1491944cd4712a1ae2b8fe5c3"
    );

    let mut on_belt = aligned.clone();
    on_belt["seamOnEdge"] = json!(true);
    let on = request(
        &stl,
        "box.stl",
        json!({ "belt": on_belt, "seam": "aligned", "includePreview": false }),
    );
    let on_reply = slice_request(&on, Job::default()).unwrap();
    assert!(on_reply.sanity.ok, "{:?}", on_reply.sanity.notes);
    assert_ne!(on_reply.gcode, off_gcode);
    let placed = layer_seam_ys(&on_reply.gcode);
    assert!(placed.len() > 4, "layers {}", placed.len());
    let missed: Vec<_> = placed
        .iter()
        .copied()
        .filter(|(start, back)| (start - back).abs() >= 1.0)
        .collect();
    assert!(
        missed.is_empty(),
        "the first outer start is not the belt edge: {missed:?}"
    );
}

/// `(first outer seam Y, max outer Y)` per layer, in gantry coordinates.
/// A wall the fan change splits is still one seam: the first outer start.
fn layer_seam_ys(gcode: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut seam: Option<f64> = None;
    let mut cursor_y = 0.0;
    let mut in_outer = false;
    let mut saw_outer = false;
    let flush = |ys: &mut Vec<f64>, seam: &mut Option<f64>, saw: &mut bool, out: &mut Vec<(f64, f64)>| {
        if *saw {
            if let (Some(y0), Some(back)) = (*seam, ys.iter().copied().reduce(f64::max)) {
                out.push((y0, back));
            }
        }
        ys.clear();
        *seam = None;
        *saw = false;
    };
    for line in gcode.lines() {
        if line.starts_with(";LAYER:") {
            flush(&mut ys, &mut seam, &mut saw_outer, &mut out);
            in_outer = false;
            continue;
        }
        if line == "; TYPE:OUTER" {
            in_outer = true;
            saw_outer = true;
            continue;
        }
        if line.starts_with("; TYPE:") {
            in_outer = false;
            continue;
        }
        if !line.starts_with("G0 ") && !line.starts_with("G1 ") {
            continue;
        }
        let y = gcode_word(line, 'Y');
        if in_outer && gcode_word(line, 'E').is_some() {
            if seam.is_none() {
                seam = Some(cursor_y);
            }
            if let Some(y) = y {
                ys.push(y);
            }
            ys.push(cursor_y);
        }
        if let Some(y) = y {
            cursor_y = y;
        }
    }
    flush(&mut ys, &mut seam, &mut saw_outer, &mut out);
    out
}

fn gcode_word(line: &str, axis: char) -> Option<f64> {
    line.split_whitespace()
        .find_map(|word| word.strip_prefix(axis)?.parse().ok())
}

#[test]
fn an_omitted_belt_is_absent_from_the_request_json() {
    let req = request(
        &box_stl(8.0, 8.0, 1.6),
        "box.stl",
        json!({ "includePreview": false }),
    );
    let value = serde_json::to_value(&req).unwrap();
    assert!(value.get("belt").is_none(), "{value}");
    let with = request(
        &box_stl(8.0, 8.0, 1.6),
        "box.stl",
        json!({ "includePreview": false, "belt": belt(45.0, "z", 1, 5.0) }),
    );
    let value = serde_json::to_value(&with).unwrap();
    assert!(
        value["belt"].get("maxLengthMm").is_none(),
        "{}",
        value["belt"]
    );
}
