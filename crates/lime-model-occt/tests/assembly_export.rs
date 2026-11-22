//! Assemblies M9: three trees written as one STEP file of named solids, each at its pose in model space, read back
//! through the multi-solid STEP reader as three named solids at those poses, with their volumes and boxes.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The store is process-wide, so everything runs in one test, in order.

use base64::Engine;
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

    // A piece the engine does not hold is a tool to open, named, not the exported tree gone (Pose's Save pose as
    // STEP after a restart, v6.0.1).
    let unheld = call(json!({
        "call": "export", "key": "body", "node": 0, "format": "step",
        "pieces": [{ "key": "hook", "node": 0 }, { "key": "never-opened", "node": 3 }], "names": ["body", "hook", "x"],
    }));
    assert_eq!(unheld["missingTool"], json!({ "key": "never-opened", "node": 3 }), "{unheld}");
    assert!(unheld.get("missing").is_none(), "{unheld}");

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

    // --- Pose export E1: STEP AP242 assembly tree via XCAF.
    // Four members from three distinct parts (two clips share part 2), nested body -> hook -> clip & clip-2.
    let tree_names = ["body", "hook", "clip", "clip-2"];
    let tree_pieces = json!([
        { "key": "hook", "node": 0 },
        { "key": "clip", "node": 0 },
        { "key": "clip", "node": 0 }
    ]);
    let tree_poses = [
        (identity, [5.0, -2.0, 0.0]),
        (about_z, [35.0, 3.0, 10.0]),
        (about_x, [-20.0, 15.0, 22.0]),
        (identity, [12.0, -7.0, 22.0]),
    ];
    let tree_exported = ok(json!({
        "call": "export",
        "key": "body",
        "node": 0,
        "format": "step",
        "pieces": tree_pieces,
        "names": tree_names,
        "poses": tree_poses.iter().map(|(m, t)| json!({ "m": m, "t": t })).collect::<Vec<_>>(),
        "assembly": {
            "name": "LED cover",
            "parents": [-1, 0, 1, 1],
            "partIds": [0, 1, 2, 2],
            "partNames": ["body", "hook", "clip"],
            "colors": ["#4080c0", "#e07040", "#50a060", "#50a060"]
        }
    }));
    assert_eq!(tree_exported["solids"], 4, "{tree_exported}");
    assert_eq!(tree_exported["parts"], 3, "{tree_exported}");

    // Verify strict AP242 FILE_SCHEMA header in the written STEP text.
    let step_bytes = base64::engine::general_purpose::STANDARD
        .decode(tree_exported["bytesBase64"].as_str().unwrap())
        .unwrap();
    let step_text = String::from_utf8_lossy(&step_bytes);
    let schema_section = step_text
        .find("FILE_SCHEMA")
        .and_then(|start| step_text[start..].find(';').map(|end| &step_text[start..start + end]))
        .unwrap_or("");
    assert!(
        schema_section.contains("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"),
        "expected AP242 FILE_SCHEMA in STEP header, got: {schema_section}"
    );

    // Read back with XCAF: one instance per member, nested joint tree, placements within 1e-6 mm, names, and shared product for clip & clip-2.
    let asm_read = ok(json!({ "call": "stepAssembly", "dataB64": tree_exported["bytesBase64"] }));
    assert_eq!(asm_read["assemblyName"].as_str(), Some("LED cover"), "{asm_read}");
    let instances = asm_read["instances"].as_array().expect("instances");
    assert_eq!(instances.len(), 4, "{asm_read}");
    let products = asm_read["products"].as_array().expect("products");
    assert_eq!(products.len(), 3, "two clips must share one product: {asm_read}");
    assert_eq!(
        instances[2]["productId"], instances[3]["productId"],
        "clip and clip-2 must share the same productId: {asm_read}"
    );
    assert_ne!(instances[0]["productId"], instances[1]["productId"]);
    // Assert joint-tree nesting: body under root assembly, hook under body, both clips under hook.
    let expected_parents = ["LED cover", "body", "hook", "hook"];
    for (idx, ((m, t), expected_name)) in tree_poses.iter().zip(tree_names.iter()).enumerate() {
        let inst = &instances[idx];
        assert_eq!(inst["name"].as_str(), Some(*expected_name), "{inst}");
        assert_eq!(
            inst["parent"].as_str(),
            Some(expected_parents[idx]),
            "instance {idx} ({expected_name}) parent mismatch: {asm_read}"
        );
        let got_m: Vec<f64> = inst["pose"]["m"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let got_t: Vec<f64> = inst["pose"]["t"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        for k in 0..9 {
            within(got_m[k], m[k], 1e-6);
        }
        for k in 0..3 {
            within(got_t[k], t[k], 1e-6);
        }
    }
    // Also check stepSolids reads back all 4 placed solids in order with names, volumes, and posed boxes.
    let tree_solids = solids(&ok(json!({ "call": "stepSolids", "dataB64": tree_exported["bytesBase64"] })));
    assert_eq!(tree_solids.len(), 4, "{tree_solids:?}");
    assert_eq!(
        tree_solids.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(),
        tree_names
    );
    same_box(tree_solids[2].2, posed_box(own[2].2, tree_poses[2].0, tree_poses[2].1));
    same_box(tree_solids[3].2, posed_box(own[2].2, tree_poses[3].0, tree_poses[3].1));

    for key in ["body", "hook", "clip"] {
        ok(json!({ "call": "close", "key": key }));
    }
}
