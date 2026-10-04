//! Support paint through the JSON request, with the kept stages off: enforce
//! disks add demand, block disks remove it, later disks win, and the reply
//! counts the disks.

use base64::Engine;
use lime_slice_core::{slice_payload, Job};
use serde_json::{json, Value};

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn ledge_b64() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    b64(&std::fs::read(path).unwrap())
}

/// A prism with the outline `xz` in the XZ plane, from y = 0 to y = `depth`.
/// `xz` is convex from its first point, counter-clockwise seen from -Y.
fn prism_stl(xz: &[[f64; 2]], depth: f64) -> String {
    let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
    let at = |p: [f64; 2], y: f64| [p[0], y, p[1]];
    for k in 1..xz.len() - 1 {
        tris.push([at(xz[0], 0.0), at(xz[k], 0.0), at(xz[k + 1], 0.0)]);
        tris.push([at(xz[0], depth), at(xz[k + 1], depth), at(xz[k], depth)]);
    }
    for k in 0..xz.len() {
        let (a, b) = (xz[k], xz[(k + 1) % xz.len()]);
        tris.push([at(a, 0.0), at(b, depth), at(b, 0.0)]);
        tris.push([at(a, 0.0), at(a, depth), at(b, depth)]);
    }
    let mut out = String::from("solid prism\n");
    for t in tris {
        out.push_str(" facet normal 0 0 0\n  outer loop\n");
        for v in t {
            out.push_str(&format!("   vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("  endloop\n endfacet\n");
    }
    out.push_str("endsolid prism\n");
    out
}

/// 30° past vertical, so its underside is 60° from horizontal: steeper than
/// the 45° support angle, so it prints without support.
const LEAN_DX: f64 = 11.547_005_383_792_516;

/// A 10 mm column that leans out from z = 10 to z = 30.
fn lean_b64() -> String {
    let xz = [
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [10.0 + LEAN_DX, 30.0],
        [0.0, 30.0],
    ];
    b64(prism_stl(&xz, 10.0).as_bytes())
}

/// The middle of the lean's underside, and its outward normal.
fn lean_face() -> ([f64; 3], [f64; 3]) {
    let s = 30f64.to_radians();
    ([10.0 + LEAN_DX * 0.5, 5.0, 20.0], [s.cos(), 0.0, -s.sin()])
}

/// A tree-support toughness slice with `extra` request fields.
fn request(filename: &str, data: String, extra: Value) -> Value {
    let mut req = json!({
        "filename": filename,
        "dataB64": data,
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": false,
        "includeSkeleton": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn ledge(extra: Value) -> Value {
    request("overhang_ledge.stl", ledge_b64(), extra)
}

fn lean(extra: Value) -> Value {
    request("lean.stl", lean_b64(), extra)
}

fn slice(req: &Value) -> Result<Value, String> {
    slice_payload(&req.to_string(), None, Job::default(), |g| g.text())
        .map(|s| serde_json::from_str(&s).unwrap())
        .map_err(String::from)
}

fn sliced(req: &Value) -> Value {
    slice(req).unwrap()
}

/// Filament the supports print, mm. Zero when no support prints.
fn support_mm(reply: &Value) -> f64 {
    reply["estimate"]["byFeature"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "support" || row["kind"] == "support-interface")
        .map(|row| row["filamentMm"].as_f64().unwrap())
        .sum()
}

/// Limbs of the grown trees, by birth site.
fn sites(reply: &Value) -> Vec<[f64; 3]> {
    let col = |name: &str| -> Vec<f64> {
        reply["skeleton"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (x, y, z) = (col("siteX"), col("siteY"), col("siteZ"));
    (0..x.len()).map(|k| [x[k], y[k], z[k]]).collect()
}

fn disk(kind: &str, p: [f64; 3], n: [f64; 3], r: f64) -> Value {
    json!({"kind": kind, "p": p, "n": n, "r": r})
}

/// The whole ledge underside: a ball of 15 mm reaches every corner of it.
fn under_ledge(kind: &str) -> Value {
    disk(kind, [36.0, 12.0, 12.0], [0.0, 0.0, -1.0], 15.0)
}

#[test]
fn paint_left_out_or_empty_or_out_of_reach_slices_as_before() {
    let plain = sliced(&ledge(json!({})));
    let empty = sliced(&ledge(json!({"supportPaint": []})));
    let far = sliced(&ledge(json!({
        "supportPaint": [disk("block", [36.0, 12.0, 90.0], [0.0, 0.0, -1.0], 5.0)]
    })));
    assert!(support_mm(&plain) > 0.0);
    assert_eq!(empty["gcode"], plain["gcode"]);
    assert_eq!(far["gcode"], plain["gcode"]);
    assert!(plain.get("supportPaint").is_none());
    assert!(empty.get("supportPaint").is_none());
    assert_eq!(
        far["supportPaint"],
        json!({"enforce": 0, "block": 0, "enforceUnhit": 0, "blockUnhit": 1})
    );
}

#[test]
fn an_enforce_disk_on_a_steep_face_grows_tips_there() {
    let (p, n) = lean_face();
    let plain = sliced(&lean(json!({})));
    let painted = sliced(&lean(json!({"supportPaint": [disk("enforce", p, n, 4.0)]})));
    assert_eq!(sites(&plain).len(), 0);
    assert_eq!(support_mm(&plain), 0.0);
    let grown = sites(&painted);
    assert!(!grown.is_empty(), "no tips grew under the enforce disk");
    for s in &grown {
        let d = ((s[0] - p[0]).powi(2) + (s[1] - p[1]).powi(2) + (s[2] - p[2]).powi(2)).sqrt();
        assert!(d < 4.0 + 1.0, "tip at {s:?} is {d:.2} mm from the disk");
    }
    assert!(support_mm(&painted) > 0.0);
    assert_eq!(
        painted["supportPaint"],
        json!({"enforce": 1, "block": 0, "enforceUnhit": 0, "blockUnhit": 0})
    );
}

#[test]
fn a_block_disk_drops_the_tips_under_it() {
    let plain = sliced(&ledge(json!({})));
    let whole = sliced(&ledge(json!({"supportPaint": [under_ledge("block")]})));
    let p = [42.0, 12.0, 12.0];
    let part = sliced(&ledge(json!({
        "supportPaint": [disk("block", p, [0.0, 0.0, -1.0], 6.0)]
    })));
    let before = sites(&plain).len();
    assert!(before > 0);
    assert_eq!(sites(&whole).len(), 0);
    assert_eq!(support_mm(&whole), 0.0);
    let left = sites(&part);
    assert!(
        !left.is_empty() && left.len() < before,
        "{} of {before}",
        left.len()
    );
    for s in &left {
        assert!(
            (s[0] - p[0]).hypot(s[1] - p[1]) > 6.0 - 0.5,
            "tip at {s:?} under the block"
        );
    }
}

#[test]
fn the_later_disk_wins_where_two_overlap() {
    let block_then_enforce = sliced(&ledge(json!({
        "supportPaint": [under_ledge("block"), under_ledge("enforce")]
    })));
    let enforce_then_block = sliced(&ledge(json!({
        "supportPaint": [under_ledge("enforce"), under_ledge("block")]
    })));
    assert!(!sites(&block_then_enforce).is_empty());
    assert!(support_mm(&block_then_enforce) > 0.0);
    assert_eq!(sites(&enforce_then_block).len(), 0);
    assert_eq!(support_mm(&enforce_then_block), 0.0);
}

#[test]
fn grid_supports_honor_paint() {
    let grid = json!({"supportStyle": "grid", "includeSkeleton": false});
    let with = |paint: Value| {
        let mut extra = grid.clone();
        extra["supportPaint"] = paint;
        extra
    };
    let (p, n) = lean_face();
    assert!(support_mm(&sliced(&ledge(grid.clone()))) > 0.0);
    assert_eq!(
        support_mm(&sliced(&ledge(with(json!([under_ledge("block")]))))),
        0.0
    );
    assert_eq!(support_mm(&sliced(&lean(grid.clone()))), 0.0);
    assert!(support_mm(&sliced(&lean(with(json!([disk("enforce", p, n, 4.0)]))))) > 0.0);
}

/// The ledge turned a quarter about Z around its middle, placed on a 220 mm bed.
fn turned(extra: Value) -> Value {
    let mut req = ledge(extra);
    req["pose"] = json!({
        "rotation": [0, -1, 0, 1, 0, 0, 0, 0, 1],
        "pivot": [24.0, 12.0, 8.0],
        "translation": [110.0, 110.0, 8.0],
    });
    req
}

#[test]
fn paint_turns_with_the_part() {
    let plain = sliced(&turned(json!({})));
    let painted = sliced(&turned(json!({"supportPaint": [under_ledge("block")]})));
    assert!(!sites(&plain).is_empty());
    assert_eq!(sites(&painted).len(), 0);
    assert_eq!(
        painted["supportPaint"],
        json!({"enforce": 0, "block": 1, "enforceUnhit": 0, "blockUnhit": 0})
    );
}

#[test]
fn the_reply_counts_disks_that_missed_the_part() {
    let reply = sliced(&ledge(json!({
        "supportPaint": [
            under_ledge("block"),
            disk("enforce", [36.0, 12.0, 5.0], [0.0, 0.0, -1.0], 2.0),
            disk("enforce", [12.0, 12.0, 12.0], [0.0, 0.0, 1.0], 2.0),
            disk("block", [48.0, 12.0, 14.0], [1.0, 0.0, 0.0], 1.0),
        ]
    })));
    assert_eq!(
        reply["supportPaint"],
        json!({"enforce": 2, "block": 2, "enforceUnhit": 1, "blockUnhit": 0})
    );
}

#[test]
fn a_prune_saved_before_paint_goes_stale_when_its_tips_are_blocked() {
    let plain = sliced(&ledge(json!({})));
    let col = |name: &str| plain["skeleton"][name].as_array().unwrap().to_vec();
    let (x, y, z) = (col("siteX"), col("siteY"), col("siteZ"));
    let prune = json!([{"kind": "prune", "sites": [{"xy": [x[0], y[0]], "z": z[0]}]}]);
    let pruned = sliced(&ledge(json!({"supportEdits": prune})));
    assert_eq!(pruned["supportEdits"][0]["status"], "applied");
    let blocked = sliced(&ledge(json!({
        "supportEdits": prune,
        "supportPaint": [under_ledge("block")],
    })));
    assert_eq!(blocked["supportEdits"][0]["status"], "stale");
    assert_eq!(blocked["supportEdits"][0]["missed"], 1);
    assert_eq!(support_mm(&blocked), 0.0);
}

#[test]
fn enforce_paint_never_turns_supports_on() {
    let (p, n) = lean_face();
    let reply = sliced(&lean(json!({
        "supports": false,
        "supportPaint": [disk("enforce", p, n, 4.0)],
    })));
    assert_eq!(support_mm(&reply), 0.0);
    assert_eq!(
        reply["supportPaint"],
        json!({"enforce": 1, "block": 0, "enforceUnhit": 0, "blockUnhit": 0, "supportsOff": true})
    );
    assert!(reply.get("inAir").is_some());
}

#[test]
fn refusals_name_the_field() {
    let refuse = |paint: Value| slice(&ledge(json!({"supportPaint": paint}))).unwrap_err();
    let many: Vec<Value> = (0..20_001)
        .map(|_| disk("block", [36.0, 12.0, 12.0], [0.0, 0.0, -1.0], 1.0))
        .collect();
    assert_eq!(
        refuse(json!(many)),
        "supportPaint has 20001 disks, at most 20000 are allowed"
    );
    assert_eq!(
        refuse(json!([disk(
            "paint",
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            1.0
        )])),
        "supportPaint[0].kind \"paint\" is not enforce or block"
    );
    assert_eq!(
        refuse(json!([
            under_ledge("block"),
            disk("block", [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1)
        ])),
        "supportPaint[1].r is 0.1 mm, it must be 0.2 to 40 mm"
    );
    assert_eq!(
        refuse(json!([disk(
            "block",
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            41.0
        )])),
        "supportPaint[0].r is 41 mm, it must be 0.2 to 40 mm"
    );
    assert_eq!(
        refuse(json!([disk(
            "enforce",
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            1.0
        )])),
        "supportPaint[0].n has no length"
    );
    assert_eq!(
        refuse(json!([disk(
            "enforce",
            [0.0, 1e9, 0.0],
            [0.0, 0.0, 1.0],
            1.0
        )])),
        "supportPaint[0].p is out of range"
    );
}

/// The ledge as a one-object plate.
fn plate(object: Value, top: Value) -> Value {
    let mut req = ledge(top);
    for key in ["filename", "dataB64"] {
        req.as_object_mut().unwrap().remove(key);
    }
    let mut one = json!({"id": "a", "filename": "overhang_ledge.stl", "dataB64": ledge_b64()});
    for (k, v) in object.as_object().unwrap() {
        one[k] = v.clone();
    }
    req["objects"] = json!([one]);
    req
}

#[test]
fn a_plate_object_carries_its_own_paint() {
    let reply = sliced(&plate(
        json!({"supportPaint": [under_ledge("block")]}),
        json!({}),
    ));
    assert_eq!(
        reply["objects"][0]["supportPaint"],
        json!({"enforce": 0, "block": 1, "enforceUnhit": 0, "blockUnhit": 0})
    );
    assert!(reply.get("supportPaint").is_none());
    assert_eq!(support_mm(&reply), 0.0);
    assert_eq!(
        slice(&plate(
            json!({}),
            json!({"supportPaint": [under_ledge("block")]})
        ))
        .unwrap_err(),
        "supportPaint belongs on each object when objects is sent"
    );
    assert_eq!(
        slice(&plate(
            json!({"supportPaint": [disk("block", [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 50.0)]}),
            json!({})
        ))
        .unwrap_err(),
        "objects[0]: supportPaint[0].r is 50 mm, it must be 0.2 to 40 mm"
    );
}
