//! The disk cache with the kept slices: a reply loaded from disk warms the
//! kept plan behind it, and a reply sent as a patch is stored whole. One
//! test, because the kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job, SliceCache};
use serde_json::{json, Value};

const STL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);

fn request(x: f64, extra: Value) -> Value {
    let bytes = std::fs::read(STL).unwrap();
    let mesh = load_slice_mesh_tol("overhang_ledge.stl", &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, 120.0, pivot[2] - min[2]],
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

/// Slice through `cache` and wait for its writes and warm-up.
fn slice(cache: &SliceCache, req: &Value, job: Job) -> Value {
    let reply = slice_payload(&req.to_string(), Some(cache), job, |g| g.text()).unwrap();
    cache.flush();
    serde_json::from_str(&reply).unwrap()
}

/// Forget the kept slices, as a restarted engine has none.
fn restart() {
    keep_support_bases(false);
    keep_support_bases(true);
}

fn reused(reply: &Value) -> Vec<&str> {
    reply["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
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
fn a_disk_hit_warms_the_kept_plan_and_a_patch_is_stored_whole() {
    let dir = std::env::temp_dir().join(format!("lime-slice-disk-kept-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = SliceCache::new(&dir, 1 << 30);
    keep_support_bases(true);

    let t0 = slice(&cache, &request(100.0, json!({})), Job::default());

    restart();
    let superseded = Job::start();
    Job::start();
    let stale_hit = slice(&cache, &request(100.0, json!({})), superseded);
    let after_stale = slice(
        &cache,
        &request(150.0, json!({"previewBase": stale_hit["previewToken"]})),
        Job::default(),
    );

    restart();
    let hit = slice(&cache, &request(100.0, json!({})), Job::default());
    let moved = slice(
        &cache,
        &request(123.5, json!({"previewBase": hit["previewToken"]})),
        Job::default(),
    );

    restart();
    let back = slice(
        &cache,
        &request(123.5, json!({"previewBase": "not-held"})),
        Job::default(),
    );
    keep_support_bases(false);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(t0["fromCache"], json!(false));
    assert_eq!(t0["layers"].as_array().unwrap().len(), 80);

    assert_eq!(stale_hit["fromCache"], json!(true));
    assert_eq!(after_stale["fromCache"], json!(false));
    assert_eq!(
        reused(&after_stale),
        Vec::<&str>::new(),
        "a superseded warm-up keeps nothing"
    );
    assert_eq!(after_stale.get("previewPatch"), None);

    assert_eq!(hit["fromCache"], json!(true));
    assert_eq!(hit["previewToken"], t0["previewToken"]);
    assert_eq!(moved["fromCache"], json!(false));
    assert_eq!(reused(&moved), ALL.to_vec());
    assert_eq!(moved["stages"]["layersReused"], json!(80));
    assert_eq!(moved["previewPatch"]["changed"], json!([]));
    assert_eq!(moved["previewToken"], t0["previewToken"]);

    assert_eq!(
        back["fromCache"],
        json!(true),
        "the patched reply was stored"
    );
    assert_eq!(back.get("previewPatch"), None);
    assert_eq!(back["previewToken"], moved["previewToken"]);
    assert_eq!(
        back["layers"], t0["layers"],
        "stored whole, in the part frame"
    );
    assert_eq!(back["gcode"], moved["gcode"]);
    assert_eq!(back["offset"], moved["offset"]);
}
