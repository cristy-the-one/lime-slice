//! The kept bases: a prune after a plain slice reuses the part and its
//! supports, a longer edit list extends the last edited state, and a shorter
//! one replays from the base. One test, because the kept slices are shared by
//! the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn ledge_b64() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap())
}

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

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g).unwrap();
    serde_json::from_str(&reply).unwrap()
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

/// One regrow over the boxes of `gaps`, across every layer they span.
fn regrow_over(gaps: &[Value]) -> Value {
    let f = |v: &Value| v.as_f64().unwrap();
    let region: Vec<Value> = gaps
        .iter()
        .map(|g| {
            let (lo, hi) = (&g["min"], &g["max"]);
            json!([
                [f(&lo[0]), f(&lo[1])],
                [f(&hi[0]), f(&lo[1])],
                [f(&hi[0]), f(&hi[1])],
                [f(&lo[0]), f(&hi[1])]
            ])
        })
        .collect();
    let z0 = gaps
        .iter()
        .map(|g| f(&g["z"][0]))
        .fold(f64::INFINITY, f64::min);
    let z1 = gaps
        .iter()
        .map(|g| f(&g["z"][1]))
        .fold(f64::NEG_INFINITY, f64::max);
    json!({"kind": "regrow", "region": region, "z": [z0, z1]})
}

/// `(objectReused, supportBaseReused, editsReused)`.
fn reuse(reply: &Value) -> (bool, bool, u64) {
    let s = &reply["stages"];
    (
        s["objectReused"].as_bool().unwrap(),
        s["supportBaseReused"].as_bool().unwrap(),
        s["editsReused"].as_u64().unwrap(),
    )
}

#[test]
fn edits_extend_the_kept_state_and_undo_replays_from_the_base() {
    keep_support_bases(true);
    let base = slice(&request(json!({"includeSkeleton": true})));
    let prune = json!({"kind": "prune", "sites": tree_sites(&base["skeleton"])});
    let pruned = slice(&request(json!({"supportEdits": [prune]})));
    let regrow = regrow_over(pruned["supportEdits"][0]["floating"].as_array().unwrap());
    let both = slice(&request(json!({"supportEdits": [prune, regrow]})));
    assert_eq!(reuse(&base), (false, false, 0));
    assert_eq!(reuse(&pruned), (true, true, 0));
    assert_eq!(reuse(&both), (true, true, 1));
    assert_eq!(both["supportEdits"][0]["status"], "applied");
    assert_eq!(both["supportEdits"][1]["status"], "applied");
    assert_eq!(both["supportEdits"][1]["changedLayers"], 57);
    assert_eq!(both["supportEdits"][1]["floating"], json!([]));
    assert_eq!(
        both["coverage"],
        json!([]),
        "the regrow holds the pruned gap again"
    );

    keep_support_bases(false);
    let cold_both = slice(&request(json!({"supportEdits": [prune, regrow]})));
    assert_eq!(reuse(&cold_both), (false, false, 0));
    assert_eq!(cold_both["gcode"], both["gcode"]);
    assert_eq!(cold_both["supportEdits"], both["supportEdits"]);

    keep_support_bases(true);
    let again = slice(&request(json!({"supportEdits": [prune, regrow]})));
    let undone = slice(&request(json!({"supportEdits": [prune]})));
    keep_support_bases(false);
    let cold_pruned = slice(&request(json!({"supportEdits": [prune]})));
    assert_eq!(
        reuse(&again),
        (false, false, 0),
        "turning keeping off forgot the bases"
    );
    assert_eq!(
        reuse(&undone),
        (true, true, 0),
        "a shorter edit list replays from the base"
    );
    assert_eq!(undone["gcode"], cold_pruned["gcode"]);
    assert_eq!(undone["gcode"], pruned["gcode"]);

    keep_support_bases(true);
    let _ = slice(&request(json!({})));
    let other_tip = slice(&request(json!({"tipDiameter": 1.2})));
    keep_support_bases(false);
    assert_eq!(
        reuse(&other_tip),
        (true, false, 0),
        "a support setting reuses the part only"
    );
}
