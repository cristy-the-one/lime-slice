//! Supports on a plate: trees of one object grow around the others, a far
//! move keeps them, and support edits survive moves. One test, because the
//! kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, load_slice_mesh_tol, slice_payload, Job};
use serde_json::{json, Value};

const SAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/");

fn object(id: &str, name: &str, x: f64, y: f64, extra: Value) -> Value {
    let bytes = std::fs::read(format!("{SAMPLES}{name}")).unwrap();
    let mesh = load_slice_mesh_tol(name, &bytes, true, 0.0).unwrap();
    let (min, max) = mesh.bounds().unwrap();
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let mut obj = json!({
        "id": id,
        "filename": name,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": pivot,
            "translation": [x, y, pivot[2] - min[2]],
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        obj[k] = v.clone();
    }
    obj
}

/// The ledge, whose 12 mm high shelf needs supports, at `a`, and a 6 mm high
/// round post of radius 12 at `b`.
fn plate(a: [f64; 2], a_extra: Value, b: [f64; 2]) -> Value {
    json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "includeSkeleton": true,
        "baseline": false,
        "objects": [
            object("ledge", "overhang_ledge.stl", a[0], a[1], a_extra),
            object("post", "arc_post.stl", b[0], b[1], json!({})),
        ],
    })
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn reused(reply: &Value, object: usize) -> Vec<&str> {
    reply["objects"][object]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

/// Every support point object 0 prints below `z`, in its part frame.
fn support_points(reply: &Value, below: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for layer in reply["layers"].as_array().unwrap() {
        if layer["z"].as_f64().unwrap() >= below {
            continue;
        }
        let cols = &layer["paths"];
        let kinds = cols["kinds"].as_array().unwrap();
        let start = cols["start"].as_array().unwrap();
        let xy = cols["xy"].as_array().unwrap();
        for (i, kind) in cols["kind"].as_array().unwrap().iter().enumerate() {
            let name = kinds[kind.as_u64().unwrap() as usize].as_str().unwrap();
            let object = cols["object"].get(i).and_then(Value::as_u64).unwrap_or(0);
            if object != 0 || !name.starts_with("support") {
                continue;
            }
            let (a, b) = (
                start[i].as_u64().unwrap() as usize,
                start[i + 1].as_u64().unwrap() as usize,
            );
            out.extend(
                (a..b).map(|k| [xy[2 * k].as_f64().unwrap(), xy[2 * k + 1].as_f64().unwrap()]),
            );
        }
    }
    out
}

/// Support points of the ledge below the post's top that fall inside the
/// post, 1 mm in from its edge. The post stands at `post` on the bed.
fn inside_post(reply: &Value, post: [f64; 2]) -> usize {
    let offset = &reply["objects"][0]["offset"];
    let (dx, dy) = (offset[0].as_f64().unwrap(), offset[1].as_f64().unwrap());
    let centre = [post[0] - dx, post[1] - dy];
    support_points(reply, 6.0)
        .iter()
        .filter(|p| (p[0] - centre[0]).hypot(p[1] - centre[1]) < 11.0)
        .count()
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
fn supports_grow_around_other_objects_and_keep_through_far_moves() {
    const ALL: [&str; 6] = [
        "contours",
        "toolpaths",
        "order",
        "comb",
        "supports",
        "supportPaths",
    ];
    let a = [100.0, 110.0];
    // Under the middle of the ledge's shelf.
    let under = [113.0, 110.0];
    keep_support_bases(true);
    let far = slice(&plate(a, json!({}), [180.0, 40.0]));
    let farther = slice(&plate(a, json!({}), [185.0, 45.0]));
    let near = slice(&plate(a, json!({}), under));
    let prune = json!({"kind": "prune", "sites": tree_sites(&far["objects"][0]["skeleton"])});
    let edits = json!({"supportEdits": [prune]});
    let pruned = slice(&plate(a, edits.clone(), [180.0, 40.0]));
    let pruned_b_moved = slice(&plate(a, edits.clone(), [185.0, 45.0]));
    let pruned_a_moved = slice(&plate([90.0, 120.0], edits.clone(), [185.0, 45.0]));
    keep_support_bases(false);
    let cold_near = slice(&plate(a, json!({}), under));

    assert!(
        inside_post(&far, under) > 0,
        "alone, the ledge's trees stand where the post would be"
    );
    assert_eq!(
        inside_post(&near, under),
        0,
        "with the post there, no tree of the ledge goes through it"
    );
    assert_eq!(near["gcode"], cold_near["gcode"], "kept equals cold");

    assert_eq!(
        reused(&farther, 0),
        ALL,
        "a far move keeps the ledge's supports"
    );
    assert!(
        !reused(&near, 0).contains(&"supports"),
        "moving the post under the shelf regrows the ledge's supports"
    );
    assert_eq!(reused(&near, 1), ALL, "the post itself is reused");

    for (name, reply) in [
        ("edited", &pruned),
        ("post moved", &pruned_b_moved),
        ("ledge moved", &pruned_a_moved),
    ] {
        assert_eq!(
            reply["objects"][0]["supportEdits"][0]["status"], "applied",
            "{name}"
        );
    }
    assert_eq!(reused(&pruned_b_moved, 0), ALL);
    assert_eq!(reused(&pruned_a_moved, 0), ALL);
}
