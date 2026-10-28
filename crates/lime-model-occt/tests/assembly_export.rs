//! Assemblies M9: three trees written as one STEP file of named solids, each at its pose in model space, read back
//! through the multi-solid STEP reader as three named solids at those poses, with their volumes and boxes.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn solids(reply: &Value) -> Vec<(String, f64, [f64; 6])> {
    reply["solids"]
        .as_array()
        .unwrap_or_else(|| panic!("solids in {reply}"))
        .iter()
        .map(|row| {
            let bounds: Vec<f64> = row["bounds"]
                .as_array()
                .unwrap_or_else(|| panic!("bounds in {row}"))
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect();
            (
                row["name"].as_str().unwrap().to_string(),
                row["volumeMm3"].as_f64().unwrap(),
                bounds.try_into().unwrap(),
            )
        })
        .collect()
}

/// The box of `bounds` (min x, y, z, then max) under `m` (row by row) and `t`, from its eight corners.
fn posed_box(bounds: [f64; 6], m: [f64; 9], t: [f64; 3]) -> [f64; 6] {
    let mut out = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    for corner in 0..8 {
        let p = [
            if corner & 1 == 0 {
                bounds[0]
            } else {
                bounds[3]
            },
            if corner & 2 == 0 {
                bounds[1]
            } else {
                bounds[4]
            },
            if corner & 4 == 0 {
                bounds[2]
            } else {
                bounds[5]
            },
        ];
        for axis in 0..3 {
            let q = m[3 * axis] * p[0] + m[3 * axis + 1] * p[1] + m[3 * axis + 2] * p[2] + t[axis];
            out[axis] = out[axis].min(q);
            out[axis + 3] = out[axis + 3].max(q);
        }
    }
    out
}

fn same_box(actual: [f64; 6], expected: [f64; 6]) {
    for (got, want) in actual.iter().zip(expected) {
        within(*got, want, 1e-3);
    }
}

#[test]
fn an_assembly_exports_as_named_solids_at_their_poses() {
    let opened = call(json!({ "call": "open", "key": "body", "box": [40.0, 30.0, 10.0] }));
    if opened["error"]
        .as_str()
        .is_some_and(|error| error.contains("OCCT_ROOT"))
    {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "Open CASCADE is required"
        );
        return;
    }
    assert!(opened.get("error").is_none(), "{opened}");
    ok(json!({ "call": "open", "key": "hook", "box": [6.0, 4.0, 12.0] }));
    ok(json!({ "call": "open", "key": "clip", "box": [8.0, 8.0, 2.0] }));
    let names = ["body", "hook", "clip"];
    let pieces = json!([{ "key": "hook", "node": 0 }, { "key": "clip", "node": 0 }]);

    let flat = ok(json!({
        "call": "export", "key": "body", "node": 0, "format": "step", "pieces": pieces, "names": names,
    }));
    let own = solids(&ok(
        json!({ "call": "stepSolids", "dataB64": flat["bytesBase64"] }),
    ));
    assert_eq!(own.len(), 3);

    let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    // A quarter turn about Z, then about X.
    let about_z = [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let about_x = [1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0];
    let poses = [
        (identity, [5.0, -2.0, 0.0]),
        (about_z, [35.0, 3.0, 10.0]),
        (about_x, [-20.0, 15.0, 22.0]),
    ];
    let exported = ok(json!({
        "call": "export", "key": "body", "node": 0, "format": "step", "pieces": pieces, "names": names,
        "poses": poses.iter().map(|(m, t)| json!({ "m": m, "t": t })).collect::<Vec<_>>(),
    }));
    assert_eq!(exported["solids"], 3, "{exported}");
    let read = solids(&ok(
        json!({ "call": "stepSolids", "dataB64": exported["bytesBase64"] }),
    ));
    assert_eq!(
        read.iter()
            .map(|(name, _, _)| name.as_str())
            .collect::<Vec<_>>(),
        names
    );
    let volumes = [40.0 * 30.0 * 10.0, 6.0 * 4.0 * 12.0, 8.0 * 8.0 * 2.0];
    for (((_, volume, bounds), (_, _, at_home)), ((m, t), want)) in
        read.iter().zip(&own).zip(poses.iter().zip(volumes))
    {
        within(*volume, want, 1e-3);
        same_box(*bounds, posed_box(*at_home, *m, *t));
    }
    // The quarter turns reached the file: the hook's 6 mm side lies along Y, and the clip's 8 mm side stands along Z.
    within(read[1].2[4] - read[1].2[1], 6.0, 1e-3);
    within(read[2].2[5] - read[2].2[2], 8.0, 1e-3);

    // One uniform scale, as a pose in model space may carry, reaches the file too.
    let scaled = ok(json!({
        "call": "export", "key": "clip", "node": 0, "format": "step", "names": ["clip"],
        "poses": [{ "m": [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0], "t": [1.0, 2.0, 3.0] }],
    }));
    let one = solids(&ok(
        json!({ "call": "stepSolids", "dataB64": scaled["bytesBase64"] }),
    ));
    within(one[0].1, volumes[2] * 8.0, 1e-3);
    same_box(
        one[0].2,
        posed_box(
            own[2].2,
            [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0],
            [1.0, 2.0, 3.0],
        ),
    );

    let short = call(json!({
        "call": "export", "key": "body", "node": 0, "format": "step", "pieces": pieces, "names": names,
        "poses": [{ "m": identity, "t": [0.0, 0.0, 0.0] }],
    }));
    assert!(
        short["error"]
            .as_str()
            .is_some_and(|error| error.contains("a pose for each")),
        "{short}"
    );
    let sheared = call(json!({
        "call": "export", "key": "clip", "node": 0, "format": "step", "names": ["clip"],
        "poses": [{ "m": [1.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] }],
    }));
    assert!(
        sheared["error"]
            .as_str()
            .is_some_and(|error| error.contains("no shear")),
        "{sheared}"
    );
    let mirrored = call(json!({
        "call": "export", "key": "clip", "node": 0, "format": "step", "names": ["clip"],
        "poses": [{ "m": [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "t": [0.0, 0.0, 0.0] }],
    }));
    assert!(mirrored.get("error").is_some(), "{mirrored}");

    for key in ["body", "hook", "clip"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
