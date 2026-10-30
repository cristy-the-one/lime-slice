//! Support edits through the JSON request, with the kept bases off.

use base64::Engine;
use lime_slice_core::{slice_payload, Job, SliceRequest, SliceSettings};
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
fn support_avoidance_is_omitted_until_it_is_on() {
    let plain: SliceRequest =
        serde_json::from_value(json!({"filename": "a.stl", "dataB64": ""})).unwrap();
    assert!(!plain.support_avoidance);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("supportAvoidance")
        .is_none());

    let off: SliceRequest = serde_json::from_value(json!({
        "filename": "a.stl",
        "dataB64": "",
        "supportAvoidance": false
    }))
    .unwrap();
    assert!(!off.support_avoidance);
    assert!(serde_json::to_value(&off)
        .unwrap()
        .get("supportAvoidance")
        .is_none());

    let on: SliceRequest = serde_json::from_value(json!({
        "filename": "a.stl",
        "dataB64": "",
        "supportAvoidance": true
    }))
    .unwrap();
    assert!(on.support_avoidance);
    assert_eq!(
        serde_json::to_value(&on).unwrap()["supportAvoidance"],
        json!(true)
    );

    let classic = SliceSettings::from_request(&on);
    let mut classic_req = on.clone();
    classic_req.classic = true;
    let cleared = SliceSettings::from_request(&classic_req);
    assert!(classic.support_avoidance);
    assert!(!cleared.support_avoidance);
}

#[test]
fn strict_stacking_is_omitted_until_it_is_on() {
    let plain: SliceRequest =
        serde_json::from_value(json!({"filename": "a.stl", "dataB64": ""})).unwrap();
    assert!(!plain.support_strict_stacking);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("supportStrictStacking")
        .is_none());

    let on: SliceRequest = serde_json::from_value(json!({
        "filename": "a.stl",
        "dataB64": "",
        "supportStrictStacking": true
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&on).unwrap()["supportStrictStacking"],
        json!(true)
    );
    assert!(SliceSettings::from_request(&on).support_strict_stacking);
    let mut classic = on.clone();
    classic.classic = true;
    assert!(!SliceSettings::from_request(&classic).support_strict_stacking);
}

#[test]
fn slow_fragile_supports_is_omitted_until_it_is_on() {
    let plain: SliceRequest =
        serde_json::from_value(json!({"filename": "a.stl", "dataB64": ""})).unwrap();
    assert!(!plain.support_slow_fragile);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("supportSlowFragile")
        .is_none());

    let on: SliceRequest = serde_json::from_value(json!({
        "filename": "a.stl",
        "dataB64": "",
        "supportSlowFragile": true
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&on).unwrap()["supportSlowFragile"],
        json!(true)
    );
    assert!(SliceSettings::from_request(&on).support_slow_fragile);
    let mut classic = on.clone();
    classic.classic = true;
    assert!(!SliceSettings::from_request(&classic).support_slow_fragile);
}

#[test]
fn slow_fragile_supports_slows_support_and_leaves_the_part() {
    let speed = json!({"mode": "single", "strategy": "speed"});
    let base = slice(&request(json!({"blend": speed}))).unwrap();
    let slow = slice(&request(
        json!({"blend": speed, "supportSlowFragile": true}),
    ))
    .unwrap();
    let seconds = |reply: &serde_json::Value| reply["estimate"]["seconds"].as_f64().unwrap();
    assert!(seconds(&slow) > seconds(&base));
    let part = |reply: &serde_json::Value| -> f64 {
        reply["estimate"]["byFeature"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                let kind = f["kind"].as_str().unwrap();
                !kind.starts_with("support") && kind != "travel"
            })
            .map(|f| f["seconds"].as_f64().unwrap())
            .sum()
    };
    assert!((part(&slow) - part(&base)).abs() < 1e-6);
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
    assert_eq!(support_mm(&base).round(), 235.0);
    assert_eq!(support_mm(&pruned).round(), 196.0);

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
        "unknown variant `melt`, expected one of `prune`, `regrow`, `grow`"
    );
    let site = json!([{"xy": [1.0, 1.0], "z": 2.0}]);
    assert_eq!(
        err(json!({"supportEdits": [{"kind": "grow", "sites": site, "count": 0}]})),
        "supportEdits[0]: a grow adds 1 to 200 branches, not 0"
    );
    assert_eq!(
        err(
            json!({"supportEdits": [{"kind": "grow", "sites": site, "count": 2, "spacing": -1.0}]})
        ),
        "supportEdits[0]: grow spacing -1 is not 0 to 50 mm"
    );
    assert_eq!(
        err(json!({"supportEdits": [{"kind": "grow", "sites": [], "count": 2}]})),
        "supportEdits[0]: a grow needs at least one site"
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

#[test]
fn growing_a_tree_prints_more_support_and_names_the_new_limbs() {
    let base = slice(&request(json!({"includeSkeleton": true}))).unwrap();
    let sites = tree_sites(&base["skeleton"]);
    let limbs = base["skeleton"]["id"].as_array().unwrap().len();
    let grown = slice(&request(json!({
        "includeSkeleton": true,
        "supportEdits": [{"kind": "grow", "sites": sites, "count": 3}]
    })))
    .unwrap();
    assert_eq!(
        grown["supportEdits"][0]["status"], "applied",
        "{}",
        grown["supportEdits"]
    );
    assert_ne!(base["gcode"], grown["gcode"]);
    assert!(support_mm(&grown) > support_mm(&base));
    let outcome = &grown["supportEdits"][0];
    assert_eq!(outcome["status"], "applied");
    let ids: Vec<u64> = outcome["grown"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert_eq!(ids.len(), 3, "{outcome}");
    let skeleton = &grown["skeleton"];
    let col = |name: &str| skeleton[name].as_array().unwrap().to_vec();
    let (id, tree) = (col("id"), col("tree"));
    assert_eq!(id.len(), limbs + 3);
    let root = &tree[id
        .iter()
        .position(|v| v == &sites_root(&base["skeleton"]))
        .unwrap()];
    for g in &ids {
        let k = id.iter().position(|v| v.as_u64() == Some(*g)).unwrap();
        assert_eq!(&tree[k], root, "limb {g} grew on the picked tree");
    }
    assert_eq!(grown["coverage"], json!([]));
    // Without `count` the edit is malformed, not a default.
    assert!(slice(&request(json!({
        "supportEdits": [{"kind": "grow", "sites": sites}]
    })))
    .unwrap_err()
    .contains("missing field `count`"));
}

/// Root id of the tree `tree_sites` picks.
fn sites_root(skeleton: &Value) -> Value {
    let tree = skeleton["tree"].as_array().unwrap();
    tree.iter()
        .find(|t| tree.iter().filter(|u| u == t).count() >= 2)
        .cloned()
        .unwrap()
}
