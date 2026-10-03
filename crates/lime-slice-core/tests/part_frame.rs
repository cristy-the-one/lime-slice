//! The part frame: moving a posed part in X/Y on the bed reuses every kept
//! stage, leaves the reply frame where it was, and only shifts the G-code.
//! One test, because the kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const STL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);
const DX: f64 = 23.5;
const DY: f64 = -17.25;

/// The ledge's bounding-box centre, and the Z lift that seats it on the bed.
fn pivot_and_lift() -> ([f64; 3], f64) {
    let bytes = std::fs::read(STL).unwrap();
    let mesh = load_slice_mesh_tol("overhang_ledge.stl", &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    (pivot, pivot[2] - min[2])
}

fn request(x: f64, y: f64, extra: Value) -> Value {
    let (pivot, lift) = pivot_and_lift();
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(STL).unwrap()),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "includeSkeleton": true,
        "baseline": false,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, y, lift],
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn at_t0(extra: Value) -> Value {
    request(100.0, 120.0, extra)
}

fn at_t1(extra: Value) -> Value {
    request(100.0 + DX, 120.0 + DY, extra)
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn reused(reply: &Value) -> Vec<&str> {
    reply["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

fn layer_indices(reply: &Value) -> Vec<u64> {
    reply["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["index"].as_u64().unwrap())
        .collect()
}

/// `moved` is `base` with every X word shifted by `DX` and every Y word by
/// `DY`, to the printed precision, and every other word the same.
fn assert_shifted(base: &str, moved: &str) {
    let (base, moved): (Vec<&str>, Vec<&str>) = (base.lines().collect(), moved.lines().collect());
    assert_eq!(base.len(), moved.len(), "g-code line count");
    for (n, (a, b)) in base.iter().zip(&moved).enumerate() {
        let (wa, wb): (Vec<&str>, Vec<&str>) = (
            a.split_whitespace().collect(),
            b.split_whitespace().collect(),
        );
        assert_eq!(wa.len(), wb.len(), "line {n}: {a} | {b}");
        let is_move = wa
            .first()
            .is_some_and(|w| ["G0", "G1", "G2", "G3"].contains(w));
        for (x, y) in wa.iter().zip(&wb) {
            let shift = match x.as_bytes()[0] {
                b'X' if is_move => DX,
                b'Y' if is_move => DY,
                _ => {
                    assert_eq!(x, y, "line {n}: {a} | {b}");
                    continue;
                }
            };
            let (p, q): (f64, f64) = (x[1..].parse().unwrap(), y[1..].parse().unwrap());
            assert!((q - (p + shift)).abs() < 0.0015, "line {n}: {a} | {b}");
        }
    }
}

const ALL: [&str; 6] = [
    "contours",
    "toolpaths",
    "order",
    "comb",
    "supports",
    "supportPaths",
];

#[test]
fn moving_a_part_on_the_bed_only_shifts_the_gcode() {
    keep_support_bases(true);
    let t0 = slice(&at_t0(json!({})));
    let t1 = slice(&at_t1(json!({"previewBase": t0["previewToken"]})));
    let prune = json!({"kind": "prune", "sites": tree_sites(&t0["skeleton"])});
    let pruned_t0 = slice(&at_t0(json!({"supportEdits": [prune]})));
    let pruned_t1 = slice(&at_t1(json!({"supportEdits": [prune]})));
    let region = |at: f64| json!({"blend": {"mode": "byRegion", "axis": "x", "atMm": at}});
    let region_t0 = slice(&at_t0(region(100.0)));
    let region_t1 = slice(&at_t1(region(100.0 + DX)));
    let region_left = slice(&at_t1(region(100.0)));
    keep_support_bases(false);
    let cold_t1 = slice(&at_t1(json!({})));
    let cold_pruned_t1 = slice(&at_t1(json!({"supportEdits": [prune]})));
    let mut unposed = at_t0(json!({"includeGcode": false, "includePreview": false}));
    unposed.as_object_mut().unwrap().remove("pose");
    let unposed = slice(&unposed);

    assert_eq!(t0["offset"], json!([-10.0, 10.0]));
    assert_eq!(t1["offset"], json!([13.5, -7.25]));
    assert_eq!(unposed.get("offset"), None, "no pose, no offset");

    assert_eq!(reused(&t0), Vec::<&str>::new());
    assert_eq!(reused(&t1), ALL.to_vec());
    let layers = layer_indices(&t0).len() as u64;
    assert_eq!(layers, 80);
    assert_eq!(t1["stages"]["layersReused"], json!(layers));
    assert_eq!(t1["previewPatch"]["changed"], json!([]));
    assert_eq!(t1["previewPatch"]["layers"], json!(layer_indices(&t0)));
    assert_eq!(t1["previewToken"], t0["previewToken"]);

    assert!(t1["sanity"]["ok"].as_bool().unwrap(), "{}", t1["sanity"]);
    assert_eq!(t1["gcode"], cold_t1["gcode"], "kept and cold g-code");
    assert_eq!(
        cold_t1["layers"], t0["layers"],
        "the reply frame does not move"
    );
    assert_eq!(cold_t1["coverage"], t0["coverage"]);
    assert_eq!(cold_t1["skeleton"], t0["skeleton"]);
    assert_eq!(cold_t1["estimate"], t0["estimate"]);
    assert_eq!(t1["estimate"], t0["estimate"]);
    assert_shifted(t0["gcode"].as_str().unwrap(), t1["gcode"].as_str().unwrap());

    for (name, reply) in [
        ("kept t0", &pruned_t0),
        ("kept t1", &pruned_t1),
        ("cold t1", &cold_pruned_t1),
    ] {
        assert_eq!(reply["supportEdits"][0]["status"], "applied", "{name}");
    }
    assert_eq!(
        pruned_t1["supportEdits"][0]["changedLayers"],
        pruned_t0["supportEdits"][0]["changedLayers"]
    );
    assert_eq!(
        cold_pruned_t1["supportEdits"][0]["changedLayers"],
        pruned_t0["supportEdits"][0]["changedLayers"]
    );

    assert_eq!(
        region_t1["blend"],
        json!("by region X = 123.50 mm (low toughness, high speed)")
    );
    assert_eq!(
        reused(&region_t1),
        ALL.to_vec(),
        "the plane moved with the part"
    );
    assert!(
        !reused(&region_left).contains(&"toolpaths"),
        "the plane stayed on the bed: {:?}",
        reused(&region_left)
    );
    assert_eq!(reused(&region_t0), vec!["contours"]);
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
