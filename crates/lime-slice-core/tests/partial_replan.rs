//! Override changes re-plan only the layers they reach: each part stage
//! that runs again takes every other layer from the kept slice, and the
//! reply equals a cold slice of the same request, byte for byte, in G-code
//! and in the preview its patch rebuilds. One test, because the kept slices
//! are shared by the whole process.

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
        "blend": {"mode": "single", "strategy": "speed"},
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

/// What the reply took from memory: the stages reused whole, and the layers
/// the toolpaths, tour, combing, and join took from the kept slice.
fn reuse(reply: &Value) -> (Vec<&str>, [u64; 4]) {
    let st = &reply["stages"];
    let names = st["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let n = |k: &str| st[k].as_u64().unwrap();
    (
        names,
        [
            n("toolpathLayersReused"),
            n("orderLayersReused"),
            n("combLayersReused"),
            n("layersReused"),
        ],
    )
}

fn range(z: [f64; 2], walls: u32) -> Value {
    json!({"heightRanges": [{"z": z, "walls": walls}]})
}

fn volume(infill: f64) -> Value {
    json!({"modifierVolumes": [{"kind": "box", "center": [0, 0, 7], "size": [8, 8, 2.2], "infill": infill}]})
}

#[test]
fn an_override_change_replans_only_the_layers_it_reaches() {
    // The ledge is 16 mm tall, 80 layers of 0.2 mm. Every range and the
    // volume spans 11 of them, with its ends between two layers.
    let steps = [
        json!({}),
        range([13.9, 20.0], 5),
        range([13.9, 20.0], 6),
        range([5.9, 8.1], 6),
        volume(1.0),
        volume(0.5),
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
    for (k, reply) in replies.iter().enumerate().skip(1) {
        assert!(
            reply["gcode"] == cold[k]["gcode"],
            "step {k}: kept and cold g-code"
        );
        let patch = &reply["previewPatch"];
        assert_eq!(
            patch["base"],
            replies[k - 1]["previewToken"],
            "step {k} is a patch"
        );
        shown = apply(&shown, patch);
        assert!(shown == held(&cold[k]["layers"]), "step {k} rebuilds cold");
    }
    let changed = |k: usize| {
        replies[k]["previewPatch"]["changed"]
            .as_array()
            .unwrap()
            .len()
    };
    let part = ["contours", "supports", "supportPaths"].to_vec();
    // A range over the top 11 layers: every layer below keeps its toolpaths,
    // its tour from the same start, its combing, and its join.
    assert_eq!(reuse(&replies[1]), (part.clone(), [69, 69, 69, 69]));
    assert_eq!(changed(1), 11);
    assert_eq!(reuse(&replies[2]), (part.clone(), [69, 69, 69, 69]));
    assert_eq!(changed(2), 11);
    // Moving the range down re-plans the 11 layers it left and the 11 it
    // reached; the volume then replaces it on the same 11. The tour above a
    // change runs again until it starts where it did before, which depends
    // on float rounding, so only the 30 layers under it are pinned there.
    for (k, want) in [(3, 58), (4, 69), (5, 69)] {
        let (names, [toolpaths, order, comb, joined]) = reuse(&replies[k]);
        assert_eq!(names, part, "step {k}");
        assert_eq!(toolpaths, want, "step {k} toolpath layers");
        assert!(
            (30..=toolpaths).contains(&order),
            "step {k} tour layers {order}"
        );
        assert!(
            comb >= order && joined >= 30,
            "step {k} combed {comb} joined {joined}"
        );
    }
}
