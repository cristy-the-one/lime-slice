//! Bridges without support: `supportBridgeMm`. A deck the part below holds
//! at both ends, no longer than the limit, asks for no support, and its
//! first rows run across it; a wing held on one side, or a longer deck,
//! still gets support. Omitted, every bridge is supported as before.

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
use serde_json::{json, Value};

type Box3 = ([f64; 3], [f64; 3]);

/// Boxes, z up, as one ASCII STL.
fn boxes_stl(boxes: &[Box3]) -> Vec<u8> {
    let mut s = String::from("solid p\n");
    for &([x0, y0, z0], [x1, y1, z1]) in boxes {
        let v = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        for [a, b, c, d] in [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [1, 2, 6, 5],
            [3, 0, 4, 7],
        ] {
            for [p, q, r] in [[a, b, c], [a, c, d]] {
                s.push_str("facet normal 0 0 0\nouter loop\n");
                for k in [p, q, r] {
                    s.push_str(&format!("vertex {} {} {}\n", v[k][0], v[k][1], v[k][2]));
                }
                s.push_str("endloop\nendfacet\n");
            }
        }
    }
    s.push_str("endsolid p\n");
    s.into_bytes()
}

/// A 12 mm wide deck 15 mm up over a gap of `gap` mm between two 5 mm posts.
fn deck(gap: f64) -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [5.0, 12.0, 15.0]),
        ([5.0 + gap, 0.0, 0.0], [10.0 + gap, 12.0, 15.0]),
        ([0.0, 0.0, 15.0], [10.0 + gap, 12.0, 17.0]),
    ])
}

/// A 12 mm wide deck 15 mm up, `out` mm past the end of one 5 mm post.
fn cantilever(out: f64) -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [5.0, 12.0, 15.0]),
        ([0.0, 0.0, 15.0], [5.0 + out, 12.0, 17.0]),
    ])
}

/// A ledge `out` mm wide along a 20 mm wall 3 mm thick, 15 mm up: held
/// along one long side, its two ends free.
fn ledge(out: f64) -> Vec<u8> {
    boxes_stl(&[
        ([0.0, 0.0, 0.0], [20.0, 3.0, 15.0]),
        ([0.0, 0.0, 15.0], [20.0, 3.0 + out, 17.0]),
    ])
}

fn ir3() -> Value {
    json!({
        "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0,
        "copies": 1, "gapMm": 5.0, "floorSupports": true,
    })
}

#[derive(Clone, Copy, Debug)]
enum Bed {
    Flat,
    Belt,
}

fn request(stl: &[u8], bed: Bed, style: Option<&str>, extra: Value) -> SliceRequest {
    let mut body = json!({
        "filename": "part.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": { "mode": "single", "strategy": "speed" },
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
        "supports": style.is_some(),
        "supportStyle": style.unwrap_or("tree"),
    });
    if let Bed::Belt = bed {
        body["belt"] = ir3();
    }
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    serde_json::from_value(body).unwrap()
}

fn slice(stl: &[u8], bed: Bed, style: Option<&str>, extra: Value) -> SliceResponse {
    let response = slice_request(&request(stl, bed, style, extra), Job::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    response
}

/// Seconds the estimate gives every support feature.
fn support_seconds(r: &SliceResponse) -> f64 {
    r.estimate
        .by_feature
        .iter()
        .filter(|f| f.kind.to_ascii_lowercase().contains("support"))
        .map(|f| f.seconds)
        .sum()
}

fn limit(mm: f64) -> Value {
    json!({ "supportBridgeMm": mm })
}

#[test]
fn a_short_bridge_gets_no_support_once_the_limit_reaches_it() {
    let part = deck(10.0);
    for style in ["tree", "grid"] {
        let held = slice(&part, Bed::Flat, Some(style), json!({}));
        assert!(support_seconds(&held) > 10.0, "{style}");
        let bridged = slice(&part, Bed::Flat, Some(style), limit(10.5));
        assert_eq!(support_seconds(&bridged), 0.0, "{style}");
        assert!(
            bridged.coverage.is_empty(),
            "{style}: {:?}",
            bridged.coverage
        );
        assert!(bridged.estimate.seconds < held.estimate.seconds, "{style}");
        // Under the limit is not enough: an 8 mm limit leaves 10 mm held.
        let longer = slice(&part, Bed::Flat, Some(style), limit(8.0));
        assert!(support_seconds(&longer) > 10.0, "{style}");
    }
}

#[test]
fn a_wing_held_on_one_side_keeps_its_support_whatever_the_limit() {
    for (name, part) in [("cantilever", cantilever(10.0)), ("ledge", ledge(10.0))] {
        for style in ["tree", "grid"] {
            let plain = slice(&part, Bed::Flat, Some(style), json!({}));
            let limited = slice(&part, Bed::Flat, Some(style), limit(18.0));
            assert!(support_seconds(&limited) > 10.0, "{name} {style}");
            // Only the header's settings line names the limit.
            let moves = |g: &str| -> Vec<String> {
                g.lines()
                    .filter(|l| !l.starts_with(';'))
                    .map(str::to_owned)
                    .collect()
            };
            assert_eq!(
                moves(&plain.gcode),
                moves(&limited.gcode),
                "{name} {style}"
            );
        }
    }
}

#[test]
fn the_default_and_a_zero_limit_support_every_bridge_as_before() {
    let part = deck(5.0);
    let plain = slice(&part, Bed::Flat, Some("tree"), json!({}));
    let zero = slice(&part, Bed::Flat, Some("tree"), limit(0.0));
    assert!(support_seconds(&plain) > 10.0);
    assert_eq!(plain.gcode, zero.gcode);
    let wire = serde_json::to_value(request(&part, Bed::Flat, Some("tree"), json!({}))).unwrap();
    assert!(wire.get("supportBridgeMm").is_none());
}

#[test]
fn a_short_bridge_on_the_belt_gets_no_support_either() {
    let part = deck(10.0);
    for style in ["tree", "grid"] {
        let held = slice(&part, Bed::Belt, Some(style), json!({}));
        let bridged = slice(&part, Bed::Belt, Some(style), limit(10.5));
        assert!(
            support_seconds(&bridged) < support_seconds(&held),
            "{style}: {} vs {}",
            support_seconds(&bridged),
            support_seconds(&held)
        );
    }
}

/// With supports off, the warning counts a bridge longer than the limit as
/// printing in the air, and a shorter one not. Without a limit it keeps its
/// own 18 mm rule.
#[test]
fn the_in_air_warning_follows_the_limit() {
    let part = deck(14.0);
    let air = |extra: Value| {
        slice(&part, Bed::Flat, None, extra)
            .in_air
            .expect("supports off")
    };
    assert_eq!(air(json!({})).overhangs, 0);
    assert_eq!(air(limit(18.0)).overhangs, 0);
    assert_eq!(air(limit(10.0)).overhangs, 1);
}

/// Extruded bridge segments of the first layer over the gap, in the G-code:
/// how much of their length runs along X, anchor to anchor, and along Y.
fn bridge_rows(gcode: &str) -> (f64, f64) {
    let (mut along_x, mut along_y) = (0.0, 0.0);
    let mut bridge = false;
    let (mut x, mut y, mut last_e) = (0.0f64, 0.0f64, 0.0f64);
    for line in gcode.lines() {
        if let Some(kind) = line.strip_prefix(';').map(str::trim) {
            if let Some(kind) = kind.strip_prefix("TYPE:") {
                bridge = kind.trim() == "BRIDGE";
            }
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G0 ")) {
            continue;
        }
        let (mut nx, mut ny, mut e) = (x, y, false);
        for word in line.split_whitespace().skip(1) {
            let (key, value) = word.split_at(1);
            let Ok(v) = value.parse::<f64>() else {
                continue;
            };
            match key {
                "X" => nx = v,
                "Y" => ny = v,
                // Absolute E: a move extrudes when E grows.
                "E" => {
                    e = v > last_e + 1e-9;
                    last_e = v;
                }
                _ => {}
            }
        }
        if bridge && e && line.starts_with("G1 ") {
            along_x += (nx - x).abs();
            along_y += (ny - y).abs();
        }
        (x, y) = (nx, ny);
    }
    (along_x, along_y)
}

/// The deck's first layer over an unsupported short bridge lays its rows
/// across the gap, post to post, whatever the layer's turn would be.
#[test]
fn the_rows_over_an_unsupported_bridge_run_across_it() {
    for gap in [5.0, 10.0] {
        let part = deck(gap);
        let r = slice(&part, Bed::Flat, Some("tree"), limit(10.5));
        let (along_x, along_y) = bridge_rows(&r.gcode);
        // About 25 rows a bead apart across the 12 mm deck, each spanning the gap.
        assert!(along_x > 20.0 * gap, "gap {gap}: {along_x:.0} along X");
        assert!(along_y < along_x * 0.2, "gap {gap}: {along_y:.0} along Y");
    }
}
