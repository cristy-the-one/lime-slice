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
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
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
        .enumerate()
        .map(|(k, i)| {
            let index = i.as_u64().unwrap();
            let was = base.iter().find(|l| l.0 == index);
            let Some(changed) = patch["changed"]
                .as_array()
                .unwrap()
                .iter()
                .find(|l| l["index"] == *i)
            else {
                let mut kept = was.expect("an unchanged layer the base has").clone();
                kept.1["seconds"] = patch["seconds"][k].clone();
                return kept;
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
            sent
        ),
        (59, 80, 928),
        "changed layers, layers, paths sent"
    );
    // The part's own path count differs slightly between platforms (7564 on
    // Windows, 7648 on Linux), so only its scale against the patch is pinned.
    assert!(sent * 5 < total, "sent {sent} of {total} paths");

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

    settings_tweaks_are_patches_too();
}

fn printer(nozzle_temp: f64, max_accel: f64) -> Value {
    json!({
        "name": "Generic Marlin 0.4 mm PLA",
        "nozzleDiameter": 0.4,
        "filamentDiameter": 1.75,
        "nozzleTemp": nozzle_temp,
        "bedTemp": 60.0,
        "bedX": 220.0,
        "bedY": 220.0,
        "maxAccel": max_accel,
    })
}

/// A temperature, an acceleration, and a support setting each come back as
/// a patch on the preview before them, and each patch rebuilds the preview
/// a cold slice draws.
fn settings_tweaks_are_patches_too() {
    let steps = [
        json!({"printer": printer(200.0, 5000.0)}),
        json!({"printer": printer(215.0, 5000.0)}),
        json!({"printer": printer(215.0, 3000.0)}),
        json!({"printer": printer(215.0, 3000.0), "supportAngle": 55}),
    ];
    keep_support_bases(true);
    let mut replies: Vec<Value> = Vec::new();
    for step in &steps {
        let mut extra = step.clone();
        if let Some(last) = replies.last() {
            extra["previewBase"] = last["previewToken"].clone();
        }
        replies.push(slice(&request(extra)));
    }
    keep_support_bases(false);
    let cold: Vec<Value> = steps.iter().map(|s| slice(&request(s.clone()))).collect();

    let mut shown = held(&replies[0]["layers"]);
    let mut seen = Vec::new();
    for (k, reply) in replies.iter().enumerate().skip(1) {
        let patch = &reply["previewPatch"];
        assert_eq!(
            patch["base"],
            replies[k - 1]["previewToken"],
            "step {k} is a patch"
        );
        shown = apply(&shown, patch);
        assert_eq!(shown, held(&cold[k]["layers"]), "step {k} rebuilds cold");
        let changed = patch["changed"].as_array().unwrap();
        let sent: usize = changed
            .iter()
            .map(|l| l["paths"]["kind"].as_array().unwrap().len())
            .sum();
        seen.push((changed.len(), sent));
    }
    assert_eq!(
        seen,
        [(0, 0), (0, 0), (56, 2165)],
        "changed layers and paths sent: a temperature and an acceleration change \
         nothing drawn, a support angle the supported layers"
    );
    // How many layer times an acceleration change moves depends on float
    // rounding, so only that some moved is pinned.
    let times = |r: &Value| r["previewPatch"]["seconds"].as_array().unwrap().clone();
    assert_ne!(
        times(&replies[2]),
        times(&replies[1]),
        "an acceleration moves layer times"
    );
}
