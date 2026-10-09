//! Support edits on a belt printer. The reply's skeleton is drawn in the
//! reply frame, so a click on the tilted preview finds a limb, and each knot
//! names the layer it prints on. A prune by the skeleton's sites applies,
//! reuses the kept stages, and equals a fresh slice. One test, because the
//! kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

const ANGLE: f64 = 45.0;

fn ledge_b64() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap())
}

fn cartesian(extra: Value) -> Value {
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

fn request(extra: Value) -> Value {
    let mut req = cartesian(extra);
    req["belt"] = json!({
        "angleDeg": ANGLE,
        "axis": "z",
        "direction": 1,
        "widthMm": 220.0,
        "copies": 1,
        "gapMm": 5.0,
        "floorSupports": true,
    });
    req
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn column(skeleton: &Value, name: &str) -> Vec<f64> {
    skeleton[name]
        .as_array()
        .unwrap_or_else(|| panic!("no {name} column"))
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

/// Birth sites of every limb of each tree, by tree id, as an edit sends them.
fn trees(skeleton: &Value) -> Vec<(u64, Vec<Value>)> {
    let tree: Vec<u64> = skeleton["tree"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    let (x, y, z) = (
        column(skeleton, "siteX"),
        column(skeleton, "siteY"),
        column(skeleton, "siteZ"),
    );
    let mut roots = tree.clone();
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .map(|root| {
            let sites = (0..tree.len())
                .filter(|&k| tree[k] == root)
                .map(|k| json!({"xy": [x[k], y[k]], "z": z[k]}))
                .collect();
            (root, sites)
        })
        .collect()
}

/// Every printed support bead of a Z-axis, +1 belt file, put back in the lab,
/// by layer, and the part's bead ends. A layer is its belt position.
struct Printed {
    support: Vec<(f64, Vec<[[f64; 3]; 2]>)>,
    part: Vec<[f64; 3]>,
}

fn word(line: &str, axis: char) -> Option<f64> {
    line.split_whitespace()
        .find_map(|w| w.strip_prefix(axis)?.parse().ok())
}

fn printed(gcode: &str) -> Printed {
    let (s, c) = (ANGLE.to_radians().sin(), ANGLE.to_radians().cos());
    let (mut b, mut u, mut x) = (0.0, 0.0, 0.0);
    let mut kind = "";
    let mut out = Printed {
        support: Vec::new(),
        part: Vec::new(),
    };
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            let z = rest
                .split_whitespace()
                .nth(1)
                .and_then(|w| w.strip_prefix("Z:"));
            out.support.push((z.unwrap().parse().unwrap(), Vec::new()));
            continue;
        }
        if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.trim();
            continue;
        }
        let Some(first) = line.split_whitespace().next() else {
            continue;
        };
        if !["G0", "G1", "G2", "G3"].contains(&first) {
            continue;
        }
        let from = [x, b - u * c, u * s];
        b = word(line, 'Z').unwrap_or(b);
        u = word(line, 'Y').unwrap_or(u);
        x = word(line, 'X').unwrap_or(x);
        let moved = word(line, 'X').is_some() || word(line, 'Y').is_some();
        if first == "G0" || !moved || word(line, 'E').is_none() {
            continue;
        }
        let to = [x, b - u * c, u * s];
        if kind.starts_with("SUPPORT") {
            out.support.last_mut().unwrap().1.push([from, to]);
        } else {
            out.part.extend([from, to]);
        }
    }
    out
}

fn dist_to_segment(p: [f64; 3], [a, b]: [[f64; 3]; 2]) -> f64 {
    let ab = [0, 1, 2].map(|i| b[i] - a[i]);
    let ap = [0, 1, 2].map(|i| p[i] - a[i]);
    let len2: f64 = ab.iter().map(|v| v * v).sum();
    let t = if len2 > 0.0 {
        (ab.iter().zip(&ap).map(|(u, v)| u * v).sum::<f64>() / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (0..3)
        .map(|i| (ap[i] - ab[i] * t).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn centre(points: impl Iterator<Item = [f64; 3]>) -> [f64; 3] {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in points {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    [0, 1, 2].map(|k| (lo[k] + hi[k]) * 0.5)
}

/// The part's preview points: the reply frame, lab minus the offset.
fn part_preview(reply: &Value) -> Vec<[f64; 3]> {
    let mut points = Vec::new();
    for layer in reply["layers"].as_array().unwrap() {
        for path in layer["paths"].as_array().unwrap() {
            let kind = path["kind"].as_str().unwrap();
            if kind.starts_with("support") || kind == "travel" {
                continue;
            }
            let zs = path["zs"].as_array().unwrap();
            for (pt, z) in path["pts"].as_array().unwrap().iter().zip(zs) {
                points.push([
                    pt[0].as_f64().unwrap(),
                    pt[1].as_f64().unwrap(),
                    z.as_f64().unwrap(),
                ]);
            }
        }
    }
    points
}

fn layer_zs(reply: &Value) -> Vec<f64> {
    reply["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["z"].as_f64().unwrap())
        .collect()
}

/// `reply`'s preview whole: its layers, or its patch laid over `base`.
fn whole_preview(reply: &Value, base: &Value) -> Vec<Value> {
    let Some(patch) = reply.get("previewPatch") else {
        return reply["layers"].as_array().unwrap().clone();
    };
    assert_eq!(patch["base"], base["previewToken"]);
    let seconds = patch["seconds"].as_array().unwrap();
    patch["layers"]
        .as_array()
        .unwrap()
        .iter()
        .zip(seconds)
        .map(|(index, seconds)| {
            let held = base["layers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|l| &l["index"] == index);
            let changed = patch["changed"]
                .as_array()
                .unwrap()
                .iter()
                .find(|l| &l["index"] == index);
            let mut layer = match changed {
                Some(changed) => {
                    let was = held.map_or(&Value::Null, |l| &l["paths"]);
                    let mut layer = changed.clone();
                    layer["paths"] = changed["order"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|k| {
                            let k = k.as_i64().unwrap();
                            if k >= 0 {
                                was[k as usize].clone()
                            } else {
                                changed["paths"][(-1 - k) as usize].clone()
                            }
                        })
                        .collect();
                    layer.as_object_mut().unwrap().remove("order");
                    layer
                }
                None => held
                    .expect("an unchanged layer is one the base holds")
                    .clone(),
            };
            layer["seconds"] = seconds.clone();
            layer
        })
        .collect()
}

fn reused(reply: &Value) -> Vec<&str> {
    reply["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn a_belt_skeleton_is_in_the_reply_frame_and_its_prunes_apply() {
    keep_support_bases(true);

    // A cartesian skeleton has no layer column: its bytes are what they were.
    let flat = slice(&cartesian(json!({"includeSkeleton": true})));
    assert!(flat["skeleton"].get("ls").is_none());

    let base = slice(&request(json!({"includeSkeleton": true})));
    assert!(
        base["sanity"]["ok"].as_bool().unwrap(),
        "{}",
        base["sanity"]["notes"]
    );
    let skeleton = &base["skeleton"];
    let (xs, ys, zs, rs, ls) = (
        column(skeleton, "xs"),
        column(skeleton, "ys"),
        column(skeleton, "zs"),
        column(skeleton, "rs"),
        column(skeleton, "ls"),
    );
    assert!(xs.len() > 10, "{} knots", xs.len());
    assert_eq!(ls.len(), xs.len());

    // Each knot is on a layer the preview has, at the belt position it prints at.
    let layers = layer_zs(&base);
    for l in &ls {
        assert!(
            layers.contains(l),
            "knot layer {l} is not a preview layer {layers:?}"
        );
    }

    // Each knot is inside the support beads of its layer. The gantry frame
    // sits a fixed step from the reply frame along the belt, which the
    // part's own extent gives.
    let gcode = printed(base["gcode"].as_str().unwrap());
    let shown = centre(part_preview(&base).into_iter());
    let part = centre(gcode.part.iter().copied());
    let shift = [0, 1, 2].map(|k| part[k] - shown[k]);
    assert!(shift[0].abs() < 0.05 && shift[2].abs() < 0.05, "{shift:?}");
    let reach = |lab: [f64; 3], layer: f64, r: f64| -> bool {
        let at = [lab[0] + shift[0], lab[1] + shift[1], lab[2]];
        gcode
            .support
            .iter()
            .filter(|(z, _)| (z - layer).abs() < 2e-3)
            .flat_map(|(_, beads)| beads)
            .any(|&bead| dist_to_segment(at, bead) <= r + 0.6)
    };
    let mut missed = Vec::new();
    for k in 0..xs.len() {
        let knot = [xs[k], ys[k], zs[k]];
        if !reach(knot, ls[k], rs[k]) {
            missed.push((knot, ls[k], rs[k]));
        }
        // The same knot shifted a centimetre across the belt is not on a bead.
        assert!(
            !reach([knot[0] + 10.0, knot[1], knot[2]], ls[k], rs[k]),
            "knot {k} has a bead 10 mm off"
        );
    }
    assert!(
        missed.is_empty(),
        "{} of {} knots off their beads: {missed:?}",
        missed.len(),
        xs.len()
    );

    // Prune a tree by its sites.
    let all = trees(skeleton);
    let (_, sites) = all
        .iter()
        .find(|(_, sites)| sites.len() >= 2)
        .expect("a tree with two limbs");
    let prune = json!({"kind": "prune", "sites": sites});
    let pruned = slice(&request(
        json!({"supportEdits": [prune], "previewBase": base["previewToken"]}),
    ));
    assert_eq!(pruned["supportEdits"][0]["status"], "applied");
    assert!(pruned["supportEdits"][0]["changedLayers"].as_u64().unwrap() > 0);
    for stage in ["contours", "toolpaths", "order", "comb"] {
        assert!(
            reused(&pruned).contains(&stage),
            "{stage}: {:?}",
            reused(&pruned)
        );
    }
    let support_mm = |reply: &Value| {
        printed(reply["gcode"].as_str().unwrap())
            .support
            .iter()
            .flat_map(|(_, beads)| beads)
            .map(|&[a, b]| (0..3).map(|i| (b[i] - a[i]).powi(2)).sum::<f64>().sqrt())
            .sum::<f64>()
    };
    assert!(
        support_mm(&pruned) < support_mm(&base) - 1.0,
        "the prune left the supports"
    );

    // It equals a fresh slice of the same request, and the patched preview
    // equals the whole one.
    keep_support_bases(false);
    let cold = slice(&request(json!({"supportEdits": [prune]})));
    assert_eq!(reused(&cold), Vec::<&str>::new());
    assert_eq!(cold["gcode"], pruned["gcode"]);
    assert_eq!(cold["supportEdits"], pruned["supportEdits"]);
    assert!(
        pruned.get("previewPatch").is_some(),
        "a prune that keeps the start patches"
    );
    assert_eq!(
        cold["layers"].as_array().unwrap(),
        &whole_preview(&pruned, &base)
    );

    // Undo: no edits is the original.
    keep_support_bases(true);
    let _ = slice(&request(json!({"supportEdits": [prune]})));
    let undone = slice(&request(json!({"includeSkeleton": true})));
    assert_eq!(undone["gcode"], base["gcode"]);
    assert_eq!(undone["skeleton"], base["skeleton"]);
    assert!(undone.get("supportEdits").is_none());
    keep_support_bases(false);

    // The trees on the lowest layer: without them the belt run starts later,
    // and every preview layer is numbered from the new first one.
    keep_support_bases(true);
    let held = slice(&request(json!({"includeSkeleton": true})));
    let lowest = ls.iter().copied().fold(f64::INFINITY, f64::min);
    let (limb_ls, tree): (Vec<Vec<f64>>, Vec<u64>) = {
        let start: Vec<usize> = skeleton["start"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as usize)
            .collect();
        let tree = skeleton["tree"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        (
            start.windows(2).map(|w| ls[w[0]..w[1]].to_vec()).collect(),
            tree,
        )
    };
    let feet: Vec<u64> = (0..tree.len())
        .filter(|&k| limb_ls[k].contains(&lowest))
        .map(|k| tree[k])
        .collect();
    let low_sites: Vec<Value> = all
        .iter()
        .filter(|(root, _)| feet.contains(root))
        .flat_map(|(_, sites)| sites.clone())
        .collect();
    let drop_feet = json!({"kind": "prune", "sites": low_sites});
    let patched = slice(&request(
        json!({"supportEdits": [drop_feet], "previewBase": held["previewToken"]}),
    ));
    assert_eq!(patched["supportEdits"][0]["status"], "applied");
    keep_support_bases(false);
    let fresh = slice(&request(json!({"supportEdits": [drop_feet]})));
    assert!(
        fresh["layers"].as_array().unwrap().len() < held["layers"].as_array().unwrap().len(),
        "pruning the lowest feet should start the belt run later"
    );
    assert_eq!(fresh["gcode"], patched["gcode"]);
    assert_eq!(
        fresh["layers"].as_array().unwrap(),
        &whole_preview(&patched, &held)
    );
}
