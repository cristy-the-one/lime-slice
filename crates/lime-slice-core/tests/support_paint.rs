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

/// 25° from horizontal: the gentle slope of the rear cover's sloped overhang.
const WEDGE_SLOPE_DEG: f64 = 25.0;

/// A 30 mm deep wedge on a 10 mm post. Its underside rises at 25° from
/// x = 10, z = 10 out to x = 40.
fn wedge_b64() -> String {
    let rise = 30.0 * WEDGE_SLOPE_DEG.to_radians().tan();
    let xz = [
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [40.0, 10.0 + rise],
        [40.0, 12.0 + rise],
        [0.0, 12.0 + rise],
    ];
    b64(prism_stl(&xz, 30.0).as_bytes())
}

/// A speed slice of the wedge with tree supports, as on the rear cover.
fn wedge(extra: Value) -> Value {
    let mut req = request("wedge.stl", wedge_b64(), extra);
    req["blend"] = json!({"mode": "single", "strategy": "speed"});
    req
}

#[test]
fn a_block_disk_inside_a_sloped_overhang_adds_no_tips() {
    let plain = sliced(&wedge(json!({})));
    let (before, before_mm) = (sites(&plain).len(), support_mm(&plain));
    assert!(before > 0 && before_mm > 0.0);
    let s = WEDGE_SLOPE_DEG.to_radians();
    let p = [25.0, 15.0, 10.0 + 15.0 * s.tan()];
    let grown: Vec<(f64, usize, f64)> = [1.0, 3.0, 8.0]
        .into_iter()
        .map(|r| {
            let blocked = sliced(&wedge(json!({
                "supportPaint": [disk("block", p, [s.sin(), 0.0, -s.cos()], r)]
            })));
            (r, sites(&blocked).len(), support_mm(&blocked))
        })
        .collect();
    assert!(
        grown
            .iter()
            .all(|&(_, n, mm)| n <= before && mm <= before_mm),
        "unpainted {before} limbs, {before_mm:.0} mm; blocked (r, limbs, mm): {grown:.0?}"
    );
}

/// A 10 mm stem with a 20 mm ledge out of each side of its top, from z = 10
/// to z = 14 and y = 0 to y = 10. The left ledge spans x -10 to 10 and the
/// right one x 20 to 40, so each underside needs support on its own.
fn two_ledges_b64() -> String {
    let xz: [[f64; 2]; 10] = [
        [10.0, 0.0],
        [20.0, 0.0],
        [20.0, 10.0],
        [40.0, 10.0],
        [40.0, 14.0],
        [20.0, 14.0],
        [10.0, 14.0],
        [-10.0, 14.0],
        [-10.0, 10.0],
        [10.0, 10.0],
    ];
    let caps = [
        [0, 1, 2],
        [0, 2, 9],
        [9, 2, 5],
        [9, 5, 6],
        [2, 3, 4],
        [2, 4, 5],
        [9, 6, 7],
        [9, 7, 8],
    ];
    let depth = 10.0;
    let at = |p: [f64; 2], y: f64| [p[0], y, p[1]];
    let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
    for [a, b, c] in caps {
        tris.push([at(xz[a], 0.0), at(xz[b], 0.0), at(xz[c], 0.0)]);
        tris.push([at(xz[a], depth), at(xz[c], depth), at(xz[b], depth)]);
    }
    for k in 0..xz.len() {
        let (a, b) = (xz[k], xz[(k + 1) % xz.len()]);
        tris.push([at(a, 0.0), at(b, depth), at(b, 0.0)]);
        tris.push([at(a, 0.0), at(a, depth), at(b, depth)]);
    }
    let mut out = String::from("solid ledges\n");
    for t in tris {
        out.push_str(" facet normal 0 0 0\n  outer loop\n");
        for v in t {
            out.push_str(&format!("   vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("  endloop\n endfacet\n");
    }
    out.push_str("endsolid ledges\n");
    b64(out.as_bytes())
}

fn ledges(extra: Value) -> Value {
    request("ledges.stl", two_ledges_b64(), extra)
}

/// A disk on the underside of the left ledge, `r` mm wide.
fn under_left(kind: &str, x: f64, r: f64) -> Value {
    disk(kind, [x, 5.0, 10.0], [0.0, 0.0, -1.0], r)
}

fn in_air(reply: &Value) -> [u64; 2] {
    let air = &reply["inAir"];
    [
        air["islands"].as_u64().unwrap(),
        air["overhangs"].as_u64().unwrap(),
    ]
}

#[test]
fn support_source_left_out_or_auto_keeps_every_byte() {
    let plain = sliced(&ledges(json!({})));
    let auto = sliced(&ledges(json!({"supportSource": "auto"})));
    let painted_auto = sliced(&ledges(json!({
        "supportSource": "auto",
        "supportPaint": [under_left("enforce", 0.0, 6.0)],
    })));
    let painted_plain = sliced(&ledges(json!({
        "supportPaint": [under_left("enforce", 0.0, 6.0)],
    })));
    let both = sites(&plain);
    assert!(both.iter().any(|s| s[0] < 10.0) && both.iter().any(|s| s[0] > 20.0));
    assert_eq!(auto["gcode"], plain["gcode"]);
    assert_eq!(painted_auto["gcode"], painted_plain["gcode"]);
    assert!(plain.get("inAir").is_none());
}

#[test]
fn painted_only_with_nothing_painted_prints_no_support() {
    for style in ["tree", "grid"] {
        let reply = sliced(&ledges(json!({
            "supportSource": "paint",
            "supportStyle": style,
        })));
        assert_eq!(support_mm(&reply), 0.0, "{style}");
        // Both ledges are still reported as printing over air.
        assert_eq!(in_air(&reply), [0, 2], "{style}");
        assert!(reply.get("supportPaint").is_none());
    }
}

#[test]
fn painted_only_supports_the_painted_ledge_and_not_the_other() {
    let reply = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportPaint": [under_left("enforce", 0.0, 15.0)],
    })));
    let grown = sites(&reply);
    assert!(!grown.is_empty(), "no tips grew under the enforce disk");
    for s in &grown {
        assert!(
            (-16.0..16.0).contains(&s[0]) && (-1.0..11.0).contains(&s[1]),
            "tip at {s:?} is outside the painted circle"
        );
    }
    let auto = sliced(&ledges(json!({})));
    assert!(support_mm(&reply) > 0.0 && support_mm(&reply) < support_mm(&auto));
    // The painted ledge is held, so only the other one is still in the air.
    assert_eq!(in_air(&reply), [0, 1]);
    assert_eq!(
        reply["supportPaint"],
        json!({"enforce": 1, "block": 0, "enforceUnhit": 0, "blockUnhit": 0})
    );
}

#[test]
fn painted_only_grid_supports_stand_only_under_the_paint() {
    let none = sliced(&ledges(json!({"supportSource": "paint", "supportStyle": "grid"})));
    let some = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportStyle": "grid",
        "supportPaint": [under_left("enforce", 0.0, 6.0)],
    })));
    let auto = sliced(&ledges(json!({"supportStyle": "grid"})));
    assert_eq!(support_mm(&none), 0.0);
    assert!(support_mm(&some) > 0.0 && support_mm(&some) < support_mm(&auto) * 0.75);
}

#[test]
fn a_block_disk_inside_the_enforced_area_leaves_that_spot_bare() {
    let enforced = under_left("enforce", 0.0, 12.0);
    let all = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportPaint": [enforced.clone()],
    })));
    let holed = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportPaint": [enforced.clone(), under_left("block", -3.0, 3.0)],
    })));
    assert!(sites(&all)
        .iter()
        .any(|s| (s[0] + 3.0).hypot(s[1] - 5.0) < 2.5));
    let left = sites(&holed);
    assert!(!left.is_empty(), "the block disk took the whole ledge");
    assert!(left.iter().all(|s| s[0] < 13.0), "tips off the painted ledge");
    for s in &left {
        assert!(
            (s[0] + 3.0).hypot(s[1] - 5.0) > 3.0 - 0.5,
            "tip at {s:?} under the block"
        );
    }
    // A block painted before the enforce disk is overpainted, as in auto mode.
    let overpainted = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportPaint": [under_left("block", -3.0, 3.0), enforced],
    })));
    assert_eq!(sites(&overpainted), sites(&all));
}

#[test]
fn block_paint_alone_in_painted_only_mode_adds_nothing() {
    let reply = sliced(&ledges(json!({
        "supportSource": "paint",
        "supportPaint": [under_left("block", 0.0, 6.0)],
    })));
    assert_eq!(support_mm(&reply), 0.0);
    assert_eq!(in_air(&reply), [0, 2]);
}

#[test]
fn painted_only_with_supports_off_prints_nothing_and_says_so() {
    let reply = sliced(&ledges(json!({
        "supports": false,
        "supportSource": "paint",
        "supportPaint": [under_left("enforce", 0.0, 6.0)],
    })));
    assert_eq!(support_mm(&reply), 0.0);
    assert_eq!(reply["supportPaint"]["supportsOff"], true);
}

#[test]
fn a_plate_object_may_choose_painted_only_for_itself() {
    let object = |id: &str, x: f64, settings: Value| {
        json!({
            "id": id,
            "filename": "ledges.stl",
            "dataB64": two_ledges_b64(),
            "pose": {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [0, 0, 0],
                     "translation": [x, 50.0, 0.0]},
            "settings": settings,
        })
    };
    let mut req = ledges(json!({}));
    for key in ["filename", "dataB64"] {
        req.as_object_mut().unwrap().remove(key);
    }
    req["objects"] = json!([
        object("a", 60.0, json!({"supportSource": "paint"})),
        object("b", 140.0, json!({})),
    ]);
    let mixed = sliced(&req);
    req["objects"][0]["settings"] = json!({});
    let both_auto = sliced(&req);
    // The first object grows nothing of its own, so the plate prints less.
    assert!(support_mm(&mixed) > 0.0 && support_mm(&mixed) < support_mm(&both_auto));
    assert_eq!(in_air(&mixed["objects"][0]), [0, 2]);
    assert!(mixed["objects"][1].get("inAir").is_none());
}

#[test]
fn an_unknown_support_source_is_refused_by_name() {
    assert_eq!(
        slice(&ledges(json!({"supportSource": "everywhere"}))).unwrap_err(),
        "supportSource \"everywhere\" is not auto or paint"
    );
    assert_eq!(
        slice(&ledges(json!({"supportSource": ""}))).unwrap_err(),
        "supportSource \"\" is not auto or paint"
    );
}

#[test]
fn joined_dabs_hold_the_gap_between_them_and_change_nothing_unpainted() {
    let plain = sliced(&ledges(json!({})));
    let asked = sliced(&ledges(json!({"supportPaintJoin": true})));
    assert_eq!(asked["gcode"], plain["gcode"]);
    let dabs = json!([
        under_left("enforce", -4.5, 3.0),
        under_left("enforce", 4.5, 3.0)
    ]);
    let hold = |join: bool| {
        let reply = sliced(&ledges(json!({
            "supportSource": "paint",
            "supportPaint": dabs,
            "supportPaintJoin": join,
            "partHold": true,
        })));
        let unheld = reply["partHold"]["unheldMm"].as_f64().unwrap();
        (reply, unheld)
    };
    let (apart, apart_mm) = hold(false);
    let (joined, joined_mm) = hold(true);
    assert!(support_mm(&apart) > 0.0);
    assert!(
        joined_mm < apart_mm - 5.0,
        "unheld part beads: joined {joined_mm:.1} mm, apart {apart_mm:.1} mm"
    );
    assert!(sites(&joined).iter().all(|s| s[0] < 10.0));
}
