//! Partial previews: a reply names its preview, and a request that names it
//! back gets only the changed layers, which rebuild the whole preview.
//! One test, because the kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn request(extra: Value) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap()),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": false,
        "includePreview": true,
        "includeSkeleton": true,
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

/// A layer's paths, one JSON value each, whatever slot tables the columns use.
fn paths(cols: &Value) -> Vec<Value> {
    let col = |name: &str| cols[name].as_array().unwrap().clone();
    let (kinds, strategies, kind, strategy, start, xy, z) = (
        col("kinds"),
        col("strategies"),
        col("kind"),
        col("strategy"),
        col("start"),
        col("xy"),
        col("z"),
    );
    (0..kind.len())
        .map(|i| {
            let (a, b) = (
                start[i].as_u64().unwrap() as usize,
                start[i + 1].as_u64().unwrap() as usize,
            );
            let zs: Vec<Value> = if z.is_empty() || z[a..b].iter().all(Value::is_null) {
                Vec::new()
            } else {
                z[a..b].to_vec()
            };
            let rest = [
                "width",
                "speed",
                "effectiveSpeed",
                "toughness",
                "beadHeight",
            ]
            .map(|k| cols[k][i].clone());
            json!({
                "kind": kinds[kind[i].as_u64().unwrap() as usize],
                "strategy": strategies[strategy[i].as_u64().unwrap() as usize],
                "xy": xy[2 * a..2 * b],
                "z": zs,
                "rest": rest,
            })
        })
        .collect()
}

/// `layers` as index to (fields without paths, paths).
fn held(layers: &Value) -> Vec<(u64, Value, Vec<Value>)> {
    layers
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let mut meta = l.clone();
            let cols = meta.as_object_mut().unwrap().remove("paths").unwrap();
            (l["index"].as_u64().unwrap(), meta, paths(&cols))
        })
        .collect()
}

fn apply(base: &[(u64, Value, Vec<Value>)], patch: &Value) -> Vec<(u64, Value, Vec<Value>)> {
    patch["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            let index = i.as_u64().unwrap();
            let was = base.iter().find(|l| l.0 == index);
            let Some(changed) = patch["changed"]
                .as_array()
                .unwrap()
                .iter()
                .find(|l| l["index"] == *i)
            else {
                return was.expect("an unchanged layer the base has").clone();
            };
            let mut meta = changed.clone();
            let obj = meta.as_object_mut().unwrap();
            let fresh = paths(&obj.remove("paths").unwrap());
            let order = obj.remove("order").unwrap();
            let rebuilt = order
                .as_array()
                .unwrap()
                .iter()
                .map(|k| match k.as_i64().unwrap() {
                    k if k >= 0 => was.unwrap().2[k as usize].clone(),
                    k => fresh[(-1 - k) as usize].clone(),
                })
                .collect();
            (index, meta, rebuilt)
        })
        .collect()
}

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

#[test]
fn a_named_preview_gets_only_its_changed_layers() {
    keep_support_bases(true);
    let base = slice(&request(json!({})));
    let token = base["previewToken"].as_str().unwrap().to_string();
    assert!(base.get("previewPatch").is_none(), "no base was named");
    let prune = json!({"kind": "prune", "sites": tree_sites(&base["skeleton"])});

    let patched = slice(&request(
        json!({"supportEdits": [prune], "previewBase": token}),
    ));
    let patch = &patched["previewPatch"];
    assert_eq!(patch["base"], json!(token));
    assert_eq!(patched["layers"], json!([]));
    let full = slice(&request(json!({"supportEdits": [prune]})));
    assert_eq!(full["previewToken"], patched["previewToken"]);
    assert!(full.get("previewPatch").is_none());
    let rebuilt = apply(&held(&base["layers"]), patch);
    assert_eq!(
        rebuilt,
        held(&full["layers"]),
        "the patch rebuilds the full preview"
    );
    let changed = patch["changed"].as_array().unwrap();
    let sent: usize = changed
        .iter()
        .map(|l| l["paths"]["kind"].as_array().unwrap().len())
        .sum();
    let total: usize = held(&full["layers"]).iter().map(|l| l.2.len()).sum();
    assert_eq!(
        (
            changed.len(),
            patch["layers"].as_array().unwrap().len(),
            sent,
            total
        ),
        (59, 80, 1073, 7564),
        "changed layers, layers, paths sent, paths in the preview"
    );

    let stale = slice(&request(json!({
        "supportEdits": [prune],
        "previewBase": "00000000000000000000000000000000",
    })));
    keep_support_bases(false);
    assert!(
        stale.get("previewPatch").is_none(),
        "an unknown base gets the whole preview"
    );
    assert_eq!(held(&stale["layers"]), held(&full["layers"]));
}
