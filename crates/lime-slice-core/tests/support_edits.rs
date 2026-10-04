//! Support edits through the JSON request, with the kept bases off.

use base64::Engine;
use lime_slice_core::{slice_payload, Job, SliceRequest};
use serde_json::{json, Value};

fn ledge_b64() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap())
}

/// A tree-support toughness slice of the ledge with `extra` request fields.
fn request(extra: Value) -> Value {
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": ledge_b64(),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn slice(req: &Value) -> Result<Value, String> {
    slice_payload(&req.to_string(), None, Job::default(), |g| g.text())
        .map(|s| serde_json::from_str(&s).unwrap())
        .map_err(String::from)
}

fn support_mm(reply: &Value) -> f64 {
    reply["estimate"]["byFeature"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "support")
        .map(|row| row["filamentMm"].as_f64().unwrap())
        .unwrap()
}

/// Birth sites of every limb in the lowest-numbered tree with at least two limbs.
fn tree_sites(skeleton: &Value) -> Vec<Value> {
    let col = |name: &str| skeleton[name].as_array().unwrap().to_vec();
    let (tree, x, y, z) = (col("tree"), col("siteX"), col("siteY"), col("siteZ"));
    let root = tree
        .iter()
        .find(|t| tree.iter().filter(|u| u == t).count() >= 2)
        .expect("a tree with at least two limbs");
    (0..tree.len())
        .filter(|&k| &tree[k] == root)
        .map(|k| json!({"xy": [x[k], y[k]], "z": z[k]}))
        .collect()
}

fn tenths(v: &Value) -> f64 {
    (v.as_f64().unwrap() * 10.0).round() / 10.0
}

#[test]
fn a_request_without_edits_serializes_without_the_edit_keys() {
    let plain: SliceRequest =
        serde_json::from_value(json!({"filename": "a.stl", "dataB64": ""})).unwrap();
    let plain = serde_json::to_value(&plain).unwrap();
    let mut keys: Vec<&str> = plain
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "adaptive",
            "adaptiveMax",
            "adaptiveMin",
            "arcFit",
            "baseline",
            "blend",
            "branchAngle",
            "classic",
            "classicEstimator",
            "combing",
            "compare",
            "dataB64",
            "featureSpeeds",
            "filename",
            "gyroid3d",
            "includeGcode",
            "includePreview",
            "infillCombine",
            "junctionDeviationMm",
            "layerHeight",
            "lineWidth",
            "overhangControl",
            "pose",
            "printer",
            "scarfLength",
            "scarfSeam",
            "scarfStartFlow",
            "scarfStartHeight",
            "scarfSteps",
            "simplify",
            "simplifyErrorMm",
            "stepToleranceMm",
            "supportAngle",
            "supportHeightMult",
            "supportStyle",
            "supports",
            "tipDiameter",
            "travelOpt",
            "trunkDiameter",
            "variableWidth",
            "zHop",
            "zHopHeight",
            "zHopMinTravel",
        ]
    );

    let edits = json!([
        {"kind": "prune", "sites": [{"xy": [1.5, 2.0], "z": 3.2}]},
        {"kind": "regrow", "region": [[[0.0, 0.0], [4.0, 0.0], [4.0, 4.0]]], "z": [1.0, 2.0]}
    ]);
    let edited: SliceRequest = serde_json::from_value(json!({
        "filename": "a.stl", "dataB64": "", "supportEdits": edits, "includeSkeleton": true
    }))
    .unwrap();
    let edited = serde_json::to_value(&edited).unwrap();
    assert_eq!(edited["supportEdits"], edits);
    assert_eq!(edited["includeSkeleton"], json!(true));
}

#[test]
fn pruning_a_tree_prints_less_support_and_reports_the_gap() {
    let base = slice(&request(json!({"includeSkeleton": true}))).unwrap();
    let sites = tree_sites(&base["skeleton"]);
    assert_eq!(sites.len(), 10);
    assert_eq!(
        sites[0],
        json!({"xy": [25.441, 5.241], "z": 11.79999999999999})
    );
    assert_eq!(base["coverage"], json!([]));

    let pruned = slice(&request(
        json!({"supportEdits": [{"kind": "prune", "sites": sites}]}),
    ))
    .unwrap();
    assert_ne!(base["gcode"], pruned["gcode"]);
    assert_eq!(support_mm(&base).round(), 232.0);
    assert_eq!(support_mm(&pruned).round(), 193.0);

    let outcome = &pruned["supportEdits"][0];
    assert_eq!(pruned["supportEdits"].as_array().unwrap().len(), 1);
    assert_eq!(outcome["status"], "applied");
    assert_eq!(outcome["changedLayers"], 59);
    assert_eq!(outcome["changedSpan"], json!([0, 58]));
    assert_eq!(tenths(&outcome["newlyFloatingMm2"]), 59.9);
    let floating = outcome["floating"].as_array().unwrap();
    assert_eq!(floating.len(), 1);
    assert_eq!(tenths(&floating[0]["areaMm2"]), 59.9);
    assert_eq!(
        floating[0]["z"],
        json!([11.399999999999991, 11.79999999999999])
    );
    assert_eq!(
        pruned["coverage"],
        json!(floating),
        "the new gap is the slice's only coverage warning"
    );
}

#[test]
fn bad_edits_are_refused_with_a_reason() {
    let err = |extra: Value| slice(&request(extra)).unwrap_err();
    assert_eq!(
        err(json!({"supportEdits": [{"kind": "prune", "sites": []}]})),
        "supportEdits[0]: a prune needs at least one site"
    );
    assert_eq!(
        err(json!({"supportEdits": [
            {"kind": "prune", "sites": [{"xy": [1.0, 1.0], "z": 2.0}]},
            {"kind": "regrow", "region": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]], "z": [5.0, 1.0]}
        ]})),
        "supportEdits[1]: z range 5 to 1 has its low end above its high end"
    );
    assert_eq!(
        err(json!({"supportEdits": [{"kind": "melt", "sites": []}]})),
        "unknown variant `melt`, expected `prune` or `regrow`"
    );
    assert_eq!(
        err(
            json!({"supportEdits": [{"kind": "prune", "sites": [{"xy": [1.0, 1.0], "z": 2.0, "r": 1}]}]})
        ),
        "unknown field `r`, expected `xy` or `z`"
    );
}

#[test]
fn grid_supports_have_no_limbs_so_every_edit_is_stale() {
    let reply = slice(&request(json!({
        "supportStyle": "grid",
        "includeSkeleton": true,
        "supportEdits": [{"kind": "prune", "sites": [{"xy": [30.0, 12.0], "z": 11.8}, {"xy": [40.0, 12.0], "z": 11.8}]}]
    })))
    .unwrap();
    assert_eq!(
        reply["supportEdits"],
        json!([{"status": "stale", "missed": 2, "changedLayers": 0, "newlyFloatingMm2": 0.0, "floating": []}])
    );
    assert_eq!(
        reply["skeleton"],
        json!({
            "id": [], "tree": [], "into": [], "live": [],
            "siteX": [], "siteY": [], "siteZ": [],
            "start": [0], "xs": [], "ys": [], "zs": [], "rs": []
        })
    );
}
