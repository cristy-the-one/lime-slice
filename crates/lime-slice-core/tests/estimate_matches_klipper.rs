//! The print time a Klipper slice writes is the time of the moves it writes:
//! the slice's own estimate against the same lookahead run over its G-code,
//! flat and on a belt. And a printer whose `max_velocity` sits below the
//! slice's feeds says so, because that cap is what makes an estimate long.

use base64::Engine;
use lime_slice_core::{estimate_gcode_seconds, slice_request, Job, PrinterProfile, SliceRequest};
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

/// The IR3 V2 as its printer.cfg reads, with `max_velocity` set apart.
fn ir3(max_velocity: f64) -> Value {
    json!({
        "name": "Ideaformer IR3 V2",
        "nozzleDiameter": 0.4,
        "filamentDiameter": 1.75,
        "nozzleTemp": 240,
        "bedTemp": 80,
        "bedX": 250,
        "bedY": 250,
        "maxVolumetricMm3S": 12,
        "maxAccel": 7000,
        "firmware": "klipper",
        "firmwareArcs": false,
        "squareCornerVelocity": 8,
        "minimumCruiseRatio": 0.5,
        "extruderCornerVelocity": 1,
        "maxVelocity": max_velocity,
        "maxZVelocity": 20,
        "maxZAccel": 500,
    })
}

fn request(belt: bool, max_velocity: f64) -> SliceRequest {
    let stl = box_stl(18.0, 12.0, 8.0);
    let mut body = json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": { "mode": "single", "strategy": "speed" },
        "printer": ir3(max_velocity),
        "baseline": false,
        "compare": false,
        "includeGcode": true,
    });
    if belt {
        body["belt"] = json!({
            "angleDeg": 45, "axis": "z", "direction": 1, "widthMm": 250, "copies": 1, "gapMm": 10,
        });
    }
    serde_json::from_value(body).unwrap()
}

fn profile(request: &SliceRequest) -> PrinterProfile {
    request.printer.clone().expect("a printer")
}

fn written_seconds(gcode: &str) -> f64 {
    gcode
        .lines()
        .rev()
        .find_map(|line| {
            line.strip_prefix("; TIME:")?
                .split('s')
                .next()?
                .parse()
                .ok()
        })
        .expect("a TIME line")
}

fn check(belt: bool) {
    let req = request(belt, 400.0);
    let reply = slice_request(&req, Job::default()).unwrap();
    let estimate = reply.estimate.seconds;
    let replayed = estimate_gcode_seconds(&reply.gcode, &profile(&req));
    assert!(
        (estimate - replayed).abs() < replayed * 0.01,
        "belt {belt}: the slice says {estimate:.2} s, its G-code takes {replayed:.2} s"
    );
    assert!((written_seconds(&reply.gcode) - estimate).abs() < 0.06);
    assert!(
        reply.estimate.velocity_cap.is_none(),
        "400 mm/s caps nothing here"
    );
    assert!(reply
        .gcode
        .contains("; estimator: klipper square_corner_velocity=8.0 minimum_cruise_ratio=0.50 extruder_corner_velocity=1.0 max_velocity=400 max_z_velocity=20 max_z_accel=500\n"));
}

#[test]
fn flat_estimate_is_the_time_of_its_own_moves() {
    check(false);
}

#[test]
fn belt_estimate_is_the_time_of_its_own_moves() {
    check(true);
}

#[test]
fn a_max_velocity_below_the_feeds_is_reported_and_timed() {
    let fast = slice_request(&request(true, 400.0), Job::default()).unwrap();
    let req = request(true, 40.0);
    let slow = slice_request(&req, Job::default()).unwrap();
    let strip = |g: &str| {
        g.lines()
            .filter(|l| !l.starts_with("; TIME:") && !l.starts_with("; estimator:"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert_eq!(
        strip(&fast.gcode),
        strip(&slow.gcode),
        "the cap changes no move"
    );
    let cap = slow.estimate.velocity_cap.clone().expect("a cap");
    assert_eq!(cap.max_velocity_mm_s, 40.0);
    assert!(cap.fastest_feed_mm_s > 100.0, "{cap:?}");
    assert!(cap.capped_share > 0.5, "{cap:?}");
    assert!(slow.estimate.seconds > fast.estimate.seconds * 1.3);
    let replayed = estimate_gcode_seconds(&slow.gcode, &profile(&req));
    assert!((slow.estimate.seconds - replayed).abs() < replayed * 0.01);
}
