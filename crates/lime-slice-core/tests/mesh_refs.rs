//! Meshes named by `meshRef` instead of sent as `dataB64`. The kept stages
//! are shared by the whole process, so everything that reads them is one test.

use std::fs;

use base64::Engine;
use lime_slice_core::{
    keep_support_bases, load_slice_mesh_tol, slice_payload, Job, PayloadError, SliceCache,
};
use serde_json::{json, Value};

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");
const LEDGE_ID: &str = "42b357ff56064b737856a126389fa39d89ba198fb0cbfa9f0ef3629c2bccbefa";
const CUBE_ID: &str = "c6c1a3014d41a9d0a49430dbf5e5568e1ac39f67c44ce66b4b7f97724b0f5bfe";

const ALL: [&str; 6] = [
    "contours",
    "toolpaths",
    "order",
    "comb",
    "supports",
    "supportPaths",
];

enum Sent {
    Data,
    Ref(&'static str),
}

/// `name` posed at (x, y), its mesh sent as `sent` says.
fn mesh_fields(name: &str, x: f64, y: f64, sent: &Sent) -> Value {
    let bytes = fs::read(format!("{SAMPLES}{name}")).unwrap();
    let mesh = load_slice_mesh_tol(name, &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let mut fields = json!({
        "filename": name,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, y, pivot[2] - min[2]],
        },
    });
    match sent {
        Sent::Data => {
            fields["dataB64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        Sent::Ref(id) => fields["meshRef"] = json!(id),
    }
    fields
}

fn ledge(x: f64, sent: Sent, extra: Value) -> Value {
    let mut req = json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in mesh_fields("overhang_ledge.stl", x, 120.0, &sent)
        .as_object()
        .unwrap()
        .iter()
        .chain(extra.as_object().unwrap())
    {
        req[k] = v.clone();
    }
    req
}

/// The ledge's cube at (70, 110) and the ledge at (150, 110).
fn plate(a: Sent, b: Sent, extra: Value) -> Value {
    let object = |id: &str, name: &str, x: f64, sent: Sent| {
        let mut fields = mesh_fields(name, x, 110.0, &sent);
        fields["id"] = json!(id);
        fields
    };
    let mut req = json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "objects": [
            object("a", "calibration_cube_20mm.stl", 70.0, a),
            object("b", "overhang_ledge.stl", 150.0, b),
        ],
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn slice_in(cache: Option<&SliceCache>, req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), cache, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn slice(req: &Value) -> Value {
    slice_in(None, req)
}

fn reused(stages: &Value) -> Vec<&str> {
    stages["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

/// What a reply prints and draws, without its timings.
fn printed(reply: &Value) -> Value {
    json!({
        "gcode": reply["gcode"],
        "layers": reply["layers"],
        "estimate": reply["estimate"],
        "mesh": reply["mesh"],
        "coverage": reply["coverage"],
        "offset": reply["offset"],
        "previewToken": reply["previewToken"],
    })
}

#[test]
fn a_mesh_ref_slices_as_its_bytes_do() {
    keep_support_bases(true);
    let sent = slice(&ledge(100.0, Sent::Data, json!({})));
    let named = slice(&ledge(100.0, Sent::Ref(LEDGE_ID), json!({})));
    let moved = slice(&ledge(
        125.0,
        Sent::Ref(LEDGE_ID),
        json!({"previewBase": sent["previewToken"]}),
    ));

    assert_eq!(sent["meshId"], LEDGE_ID);
    assert_eq!(named["meshId"], LEDGE_ID);
    assert_eq!(printed(&named), printed(&sent));
    assert!(sent["previewToken"].is_string());
    assert_eq!(reused(&named["stages"]), ALL.to_vec());

    assert_eq!(moved["previewPatch"]["changed"], json!([]));
    assert_eq!(moved["stages"]["layersReused"], json!(80));
    assert_eq!(reused(&moved["stages"]), ALL.to_vec());
    assert_eq!(moved["offset"], json!([15.0, 10.0]));

    let plate_sent = slice(&plate(Sent::Data, Sent::Data, json!({})));
    let plate_named = slice(&plate(
        Sent::Ref(CUBE_ID),
        Sent::Ref(LEDGE_ID),
        json!({"previewBase": plate_sent["previewToken"]}),
    ));
    let plate_mixed = slice(&plate(Sent::Ref(CUBE_ID), Sent::Data, json!({})));

    assert_eq!(plate_sent["meshIds"], json!({"a": CUBE_ID, "b": LEDGE_ID}));
    assert_eq!(plate_named["meshIds"], json!({"a": CUBE_ID, "b": LEDGE_ID}));
    assert_eq!(plate_named.get("meshId"), None);
    assert_eq!(plate_named["previewPatch"]["changed"], json!([]));
    assert_eq!(plate_named["previewToken"], plate_sent["previewToken"]);
    assert_eq!(plate_named["gcode"], plate_sent["gcode"]);
    for object in 0..2 {
        assert_eq!(
            reused(&plate_named["objects"][object]),
            ALL.to_vec(),
            "object {object}"
        );
    }
    assert_eq!(printed(&plate_mixed), printed(&plate_sent));

    let dir = std::env::temp_dir().join(format!("lime-slice-mesh-refs-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let cache = SliceCache::new(&dir, 1 << 30);
    let stored = slice_in(Some(&cache), &ledge(60.0, Sent::Data, json!({})));
    cache.flush();
    let loaded = slice_in(Some(&cache), &ledge(60.0, Sent::Ref(LEDGE_ID), json!({})));
    cache.flush();
    keep_support_bases(false);
    let entries = fs::read_dir(&dir).unwrap().count();
    let _ = fs::remove_dir_all(&dir);

    assert_eq!(stored["fromCache"], false);
    assert_eq!(loaded["fromCache"], true, "the named mesh found the sent one's entry");
    assert_eq!(entries, 1);
    assert_eq!(loaded["meshId"], LEDGE_ID);
    assert_eq!(loaded["gcode"], stored["gcode"]);
}

#[test]
fn an_unknown_mesh_ref_is_refused_by_name() {
    let unknown = "0".repeat(64);
    let lone = json!({"filename": "a.stl", "meshRef": unknown}).to_string();
    let plate = json!({"objects": [
        {"id": "a", "filename": "a.stl", "meshRef": "1".repeat(64)},
        {"id": "b", "filename": "b.stl", "meshRef": "2".repeat(64)},
    ]})
    .to_string();
    let both = json!({"filename": "a.stl", "meshRef": unknown, "dataB64": "AAAA"}).to_string();
    let run = |payload: &str| slice_payload(payload, None, Job::default(), |g| g.text());

    let err = run(&lone).unwrap_err();
    assert_eq!(err, PayloadError::UnknownMesh(vec![unknown.clone()]));
    assert_eq!(err.status(), 409);
    let body: Value = serde_json::from_str(&err.json()).unwrap();
    assert_eq!(body["code"], "unknownMeshRef");
    assert_eq!(body["meshRefs"], json!([unknown]));
    assert_eq!(
        body["error"],
        format!("meshRef {unknown} is not held by this engine; send dataB64 instead")
    );
    assert_eq!(
        run(&plate).unwrap_err(),
        PayloadError::UnknownMesh(vec!["1".repeat(64), "2".repeat(64)])
    );
    let err = run(&both).unwrap_err();
    assert_eq!(
        err,
        PayloadError::Failed("send dataB64 or meshRef, not both".into())
    );
    assert_eq!(err.status(), 400);
}
