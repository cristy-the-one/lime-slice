//! K1 profile v2: loops, arcs, and holes. A washer and a rounded rectangle against areas worked out by hand,
//! and the refusals for an open loop, crossing loops, and a hole outside the outline.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

/// A circle of `radius` as two semicircle arcs, counter-clockwise from (radius, 0).
fn circle(radius: f64) -> Value {
    json!({
        "start": [radius, 0.0],
        "segments": [
            { "kind": "arc", "through": [0.0, radius], "to": [-radius, 0.0] },
            { "kind": "arc", "through": [0.0, -radius], "to": [radius, 0.0] }
        ]
    })
}

/// A rectangle as four lines, closed.
fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    json!({
        "start": [x0, y0],
        "segments": [
            { "kind": "line", "to": [x1, y0] },
            { "kind": "line", "to": [x1, y1] },
            { "kind": "line", "to": [x0, y1] },
            { "kind": "line", "to": [x0, y0] }
        ]
    })
}

fn extrude(loops: Value, depth: f64) -> Value {
    json!({
        "kind": "extrude",
        "op": "fuse",
        "origin": [20.0, 20.0, 10.0],
        "turn": [0.0, 0.0, 0.0],
        "depth": depth,
        "loops": loops
    })
}

#[test]
fn washer_and_rounded_rectangle_and_the_refusals() {
    let opened = call(json!({ "call": "open", "key": "loops", "box": [40.0, 40.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    let block = 40.0 * 40.0 * 10.0;
    near(volume(&opened), block);

    // A washer on the top face: outer radius 10, hole radius 4, 5 mm tall. Added volume π(R² − r²)·5.
    let washer = extrude(json!([circle(10.0), circle(4.0)]), 5.0);
    let washed = apply("loops", 0, 1, &washer);
    near(volume(&washed), block + PI * (100.0 - 16.0) * 5.0);
    assert!(washed["op"].get("profile").is_none(), "a loops op stores no profile: {}", washed["op"]);
    assert_eq!(washed["op"]["loops"], washer["loops"]);

    // A 20 × 10 rectangle with 2 mm corner arcs. Area 184 + 4π, times the depth.
    let s = 2.0_f64.sqrt();
    let rounded = extrude(
        json!([{
            "start": [2.0, 0.0],
            "segments": [
                { "kind": "line", "to": [18.0, 0.0] },
                { "kind": "arc", "through": [18.0 + s, 2.0 - s], "to": [20.0, 2.0] },
                { "kind": "line", "to": [20.0, 8.0] },
                { "kind": "arc", "through": [18.0 + s, 8.0 + s], "to": [18.0, 10.0] },
                { "kind": "line", "to": [2.0, 10.0] },
                { "kind": "arc", "through": [2.0 - s, 8.0 + s], "to": [0.0, 8.0] },
                { "kind": "line", "to": [0.0, 2.0] },
                { "kind": "arc", "through": [2.0 - s, 2.0 - s], "to": [2.0, 0.0] }
            ]
        }]),
        5.0,
    );
    // Sit it on the block, offset so the outline's min corner is not on the edge of the washer.
    let mut rounded = rounded;
    rounded["origin"] = json!([5.0, 5.0, 10.0]);
    let round = apply("loops", 0, 2, &rounded);
    near(volume(&round), block + (184.0 + 4.0 * PI) * 5.0);

    let open = extrude(
        json!([{
            "start": [0.0, 0.0],
            "segments": [
                { "kind": "line", "to": [10.0, 0.0] },
                { "kind": "line", "to": [10.0, 10.0] }
            ]
        }]),
        5.0,
    );
    refused(&apply("loops", 0, 90, &open), "A loop is open. Its end must meet its start.");
    refused(
        &apply("loops", 0, 90, &extrude(json!([rect(0.0, 0.0, 10.0, 10.0), rect(8.0, 8.0, 14.0, 14.0)]), 5.0)),
        "These loops cross.",
    );
    refused(
        &apply("loops", 0, 90, &extrude(json!([rect(0.0, 0.0, 10.0, 10.0), rect(20.0, 20.0, 24.0, 24.0)]), 5.0)),
        "A hole lies outside the outline. Keep each hole inside.",
    );
    let mut both = extrude(json!([rect(0.0, 0.0, 10.0, 10.0)]), 5.0);
    both["profile"] = json!([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]);
    refused(&apply("loops", 0, 90, &both), "Give a profile or loops, not both.");
    let collinear = extrude(
        json!([{
            "start": [0.0, 0.0],
            "segments": [
                { "kind": "arc", "through": [5.0, 0.0], "to": [10.0, 0.0] },
                { "kind": "line", "to": [10.0, 10.0] },
                { "kind": "line", "to": [0.0, 10.0] },
                { "kind": "line", "to": [0.0, 0.0] }
            ]
        }]),
        5.0,
    );
    refused(
        &apply("loops", 0, 90, &collinear),
        "An arc's three points are in a straight line. Move the middle point off that line.",
    );

    // A point profile still stores no loops, and the profile comes back as sent.
    let square = json!({
        "kind": "extrude",
        "op": "fuse",
        "origin": [0.0, 0.0, 10.0],
        "turn": [0.0, 0.0, 0.0],
        "profile": [[0.0, 0.0], [8.0, 0.0], [8.0, 8.0], [0.0, 8.0]],
        "depth": 4.0
    });
    let plain = apply("loops", 0, 3, &square);
    near(volume(&plain), block + 8.0 * 8.0 * 4.0);
    assert!(plain["op"].get("loops").is_none(), "{}", plain["op"]);
    assert_eq!(plain["op"]["profile"], square["profile"]);

    // Two square loops, 10 mm apart, loft into a 10 × 10 × 10 prism on the block.
    let section = |z: f64| {
        json!({ "origin": [15.0, 15.0, z], "turn": [0.0, 0.0, 0.0], "loops": [rect(0.0, 0.0, 10.0, 10.0)] })
    };
    let loft = json!({
        "kind": "loft",
        "op": "fuse",
        "sections": [section(10.0), section(20.0)]
    });
    let lofted = apply("loops", 0, 4, &loft);
    near(volume(&lofted), block + 1000.0);
    assert!(lofted["op"]["sections"][0].get("profile").is_none(), "{}", lofted["op"]);
}

/// A closed spline through four points, as the sketch's Spline tool closes one: the start passed again at the end.
fn blob(radius: f64) -> Value {
    json!({
        "start": [radius, 0.0],
        "segments": [
            { "kind": "spline", "through": [[0.0, radius], [-radius, 0.0], [0.0, -radius]], "to": [radius, 0.0] }
        ]
    })
}

fn feature(key: &str, op: Value) -> Value {
    call(json!({ "call": "open", "key": key, "feature": op, "chordMm": 0.1 }))
}

/// A cone frustum's volume between radii `a` and `b`, `h` apart.
fn frustum(a: f64, b: f64, h: f64) -> f64 {
    PI * h / 3.0 * (a * a + a * b + b * b)
}

#[test]
fn loops_take_a_second_depth_and_a_draft() {
    let probe = call(json!({ "call": "open", "key": "loops-k3-probe", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return;
    }
    let round = |extra: Value| {
        let mut op = json!({
            "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0],
            "depth": 6.0, "loops": [circle(5.0)]
        });
        for (name, value) in extra.as_object().unwrap() {
            op[name] = value.clone();
        }
        op
    };

    // A circle 6 mm up and 4 mm down is a 10 mm cylinder, and the op keeps its loops and its second depth.
    let sided = feature("loops-k3-sided", round(json!({ "depth2": 4.0 })));
    near(volume(&sided), PI * 25.0 * 10.0);

    // A 5° draft on a 10 mm push: the far end is 10 tan 5° smaller all round, a frustum.
    let taper = (5.0f64).to_radians().tan();
    let drafted = feature("loops-k3-draft", round(json!({ "depth": 10.0, "draftDeg": 5.0 })));
    assert!(
        (volume(&drafted) - frustum(5.0, 5.0 - 10.0 * taper, 10.0)).abs() < 0.5,
        "{} is not a frustum of {}",
        volume(&drafted),
        frustum(5.0, 5.0 - 10.0 * taper, 10.0)
    );

    // The owner's extrude, on a circle: 8.2 mm each way with 3°. The wall is one plane, so the +W end shrinks and
    // the −W end grows by 8.2 tan 3°.
    let lean = 8.2 * (3.0f64).to_radians().tan();
    let centred = feature("loops-k3-centred", round(json!({ "depth": 16.4, "symmetric": true, "draftDeg": 3.0 })));
    assert!(
        (volume(&centred) - frustum(5.0 + lean, 5.0 - lean, 16.4)).abs() < 0.5,
        "{} is not a frustum of {}",
        volume(&centred),
        frustum(5.0 + lean, 5.0 - lean, 16.4)
    );

    // The same on a closed spline: a solid between the straight prism of the outline at its narrow and wide ends.
    let spline = |extra: Value| {
        let mut op = json!({
            "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0],
            "depth": 16.4, "loops": [blob(5.0)]
        });
        for (name, value) in extra.as_object().unwrap() {
            op[name] = value.clone();
        }
        op
    };
    // One spline segment that comes back to its start is the sketch's closed spline: a smooth periodic curve, near the
    // circle through the same four points.
    let straight = volume(&feature("loops-k3-spline-straight", spline(json!({ "symmetric": true }))));
    let disc = PI * 25.0 * 16.4;
    assert!(
        (straight - disc).abs() / disc < 0.1,
        "a closed spline through a circle's four points is near {disc}, not {straight}"
    );
    let spline_draft = feature("loops-k3-spline", spline(json!({ "symmetric": true, "draftDeg": 3.0 })));
    let leaned = volume(&spline_draft);
    assert!(
        (leaned - straight).abs() / straight < 0.05 && (leaned - straight).abs() > 1e-3,
        "a 3° centred draft keeps a spline near its straight volume {straight}, not {leaned}"
    );

    // On a solid: a circle on a 20 mm block's top, 6 up and 4 down, adds only what is above the top.
    let opened = call(json!({ "call": "open", "key": "loops-k3-block", "box": [20.0, 20.0, 10.0] }));
    near(volume(&opened), 4000.0);
    let on_block = json!({
        "kind": "extrude", "op": "fuse", "origin": [10.0, 10.0, 10.0], "turn": [0.0, 0.0, 0.0],
        "depth": 6.0, "depth2": 4.0, "loops": [circle(5.0)]
    });
    let joined = apply("loops-k3-block", 0, 1, &on_block);
    near(volume(&joined), 4000.0 + PI * 25.0 * 6.0);
    assert_eq!(joined["op"]["depth2"], json!(4.0), "{}", joined["op"]);
    assert!(joined["op"]["loops"].is_array(), "{}", joined["op"]);

    // A draft that closes the circle before the depth is refused, as it is on a point profile.
    let closes = feature("loops-k3-closes", round(json!({ "depth": 10.0, "draftDeg": 30.0 })));
    refused(&closes, "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.");
}
