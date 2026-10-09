//! Support edits on a belt printer. The reply's skeleton is drawn in the
//! reply frame, so a click on the tilted preview finds a limb, and each knot
//! names the layer it prints on. A prune by the skeleton's sites applies,
//! reuses the kept stages, and equals a fresh slice. One test, because the
//! kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{
    keep_support_bases, slice_request, EditStatus, Job, PreviewLayer, SliceRequest, SliceResponse,
    SupportSkeleton,
};
use serde_json::{json, Value};

const ANGLE: f64 = 45.0;

fn ledge_b64() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap())
}

fn flat(extra: Value) -> Value {
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

fn belt(extra: Value) -> Value {
    let mut req = flat(extra);
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

fn slice(req: &Value) -> SliceResponse {
    let req: SliceRequest = serde_json::from_value(req.clone()).unwrap();
    slice_request(&req, Job::default()).unwrap()
}

/// Birth sites of every limb of each tree, by tree id, as an edit sends them.
fn trees(skeleton: &SupportSkeleton) -> Vec<(u32, Vec<Value>)> {
    let mut roots = skeleton.tree.clone();
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .map(|root| {
            let sites = (0..skeleton.tree.len())
                .filter(|&k| skeleton.tree[k] == root)
                .map(|k| {
                    json!({
                        "xy": [skeleton.site_x[k], skeleton.site_y[k]],
                        "z": skeleton.site_z[k],
                    })
                })
                .collect();
            (root, sites)
        })
        .collect()
}

/// Every printed bead of a Z-axis, +1 belt file put back in the lab: the
/// support beads by layer, with the layer's belt position, and the part's bead ends.
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

/// The part's preview points, in the reply frame.
fn part_preview(reply: &SliceResponse) -> Vec<[f64; 3]> {
    let mut points = Vec::new();
    for path in reply.layers.iter().flat_map(|layer| &layer.paths) {
        if path.kind.starts_with("support") || path.kind == "travel" {
            continue;
        }
        for (pt, z) in path.pts.iter().zip(&path.zs) {
            points.push([pt[0], pt[1], *z]);
        }
    }
    points
}

/// A preview layer as a test compares it: its place, and its paths as printed.
type Layer = (usize, f64, f64, f64, String);

/// `reply`'s preview whole: its layers, or its patch laid over `base`.
fn whole_preview(reply: &SliceResponse, base: &SliceResponse) -> Vec<Layer> {
    let layer = |l: &PreviewLayer| (l.index, l.z, l.height, l.seconds, format!("{:?}", l.paths));
    let Some(patch) = &reply.preview_patch else {
        return reply.layers.iter().map(layer).collect();
    };
    assert_eq!(Some(&patch.base), base.preview_token.as_ref());
    patch
        .layers
        .iter()
        .zip(&patch.seconds)
        .map(|(&index, &seconds)| {
            let held = base.layers.iter().find(|l| l.index == index);
            let Some(changed) = patch.changed.iter().find(|c| c.layer.index == index) else {
                let held = held.expect("an unchanged layer is one the base holds");
                return (
                    index,
                    held.z,
                    held.height,
                    seconds,
                    format!("{:?}", held.paths),
                );
            };
            let paths: Vec<_> = changed
                .order
                .iter()
                .map(|&k| {
                    if k >= 0 {
                        held.unwrap().paths[k as usize].clone()
                    } else {
                        changed.layer.paths[(-1 - k) as usize].clone()
                    }
                })
                .collect();
            let height = changed.layer.height;
            (
                index,
                changed.layer.z,
                height,
                seconds,
                format!("{paths:?}"),
            )
        })
        .collect()
}

fn support_mm(reply: &SliceResponse) -> f64 {
    printed(&reply.gcode)
        .support
        .iter()
        .flat_map(|(_, beads)| beads)
        .map(|&[a, b]| (0..3).map(|i| (b[i] - a[i]).powi(2)).sum::<f64>().sqrt())
        .sum()
}

/// A tower with an arm reaching up the belt, `[across, along, height]` in mm.
/// The arm's tip meets the nozzle plane before the tower's foot does, 12 mm
/// over the belt, so its supports have to grow below the first part layer.
fn tower_with_arm() -> String {
    let outline: [[f64; 2]; 8] = [
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 12.0],
        [10.0, 20.0],
        [0.0, 20.0],
        [-15.0, 20.0],
        [-15.0, 12.0],
        [0.0, 12.0],
    ];
    let at = |x: f64, [y, z]: [f64; 2]| [x, y, z];
    let mut faces = Vec::new();
    for k in 0..outline.len() {
        let (p, q) = (outline[k], outline[(k + 1) % outline.len()]);
        faces.push([at(0.0, p), at(0.0, q), at(10.0, p)]);
        faces.push([at(0.0, q), at(10.0, q), at(10.0, p)]);
    }
    // The reflex corner sees the whole outline, so a fan from it covers the caps.
    let hub = outline[7];
    for k in 0..6 {
        let (p, q) = (outline[k], outline[k + 1]);
        faces.push([at(10.0, hub), at(10.0, p), at(10.0, q)]);
        faces.push([at(0.0, hub), at(0.0, q), at(0.0, p)]);
    }
    let mut out = String::from("solid arm\n");
    for face in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for v in face {
            out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid arm\n");
    out
}

#[test]
fn a_belt_skeleton_is_in_the_reply_frame_and_its_prunes_apply() {
    keep_support_bases(true);

    // A flat bed's skeleton has no layer column: its bytes are what they were.
    let level = slice(&flat(json!({"includeSkeleton": true})));
    assert!(level.skeleton.unwrap().ls.is_none());

    let base = slice(&belt(json!({"includeSkeleton": true})));
    assert!(base.sanity.ok, "{:?}", base.sanity.notes);
    let skeleton = base.skeleton.as_ref().unwrap();
    let ls = skeleton
        .ls
        .as_ref()
        .expect("a belt skeleton names its layers");
    let knots = skeleton.xs.len();
    assert!(knots > 10, "{knots} knots");
    assert_eq!(ls.len(), knots);

    // Each knot is on a layer the preview has, at the belt position it prints at.
    let layers: Vec<f64> = base.layers.iter().map(|l| l.z).collect();
    for l in ls {
        assert!(layers.contains(l), "knot layer {l} is not in {layers:?}");
    }

    // Each knot is inside the support beads of its layer. The gantry frame
    // sits a fixed step from the reply frame along the belt, which the
    // part's own extent gives.
    let gcode = printed(&base.gcode);
    let shown = centre(part_preview(&base).into_iter());
    let part = centre(gcode.part.iter().copied());
    let shift = [0, 1, 2].map(|k| part[k] - shown[k]);
    assert!(shift[0].abs() < 0.05 && shift[2].abs() < 0.05, "{shift:?}");
    let reach = |knot: [f64; 3], layer: f64, r: f64| {
        let at = [knot[0] + shift[0], knot[1] + shift[1], knot[2]];
        gcode
            .support
            .iter()
            .filter(|(z, _)| (z - layer).abs() < 2e-3)
            .flat_map(|(_, beads)| beads)
            .any(|&bead| dist_to_segment(at, bead) <= r + 0.6)
    };
    let mut missed = Vec::new();
    for (k, &layer) in ls.iter().enumerate() {
        let knot = [skeleton.xs[k], skeleton.ys[k], skeleton.zs[k]].map(f64::from);
        let r = f64::from(skeleton.rs[k]);
        if !reach(knot, layer, r) {
            missed.push((knot, layer, r));
        }
        // The same knot 5 mm higher is off its layer's plane, so off every bead.
        let above = [knot[0], knot[1], knot[2] + 5.0];
        assert!(!reach(above, layer, r), "knot {k} has a bead 5 mm above");
    }
    assert!(
        missed.is_empty(),
        "{} of {knots} knots off their beads: {missed:?}",
        missed.len()
    );

    // Prune a tree by its sites.
    let all = trees(skeleton);
    let (_, sites) = all
        .iter()
        .find(|(_, sites)| sites.len() >= 2)
        .expect("a tree with two limbs");
    let prune = json!({"kind": "prune", "sites": sites});
    let pruned = slice(&belt(json!({
        "supportEdits": [prune],
        "previewBase": base.preview_token,
    })));
    assert_eq!(pruned.support_edits[0].status, EditStatus::Applied);
    assert!(pruned.support_edits[0].changed_layers > 0);
    for stage in ["contours", "toolpaths", "order", "comb"] {
        assert!(pruned.stages.reused.contains(&stage), "{stage}");
    }
    assert!(
        support_mm(&pruned) < support_mm(&base) - 1.0,
        "the prune left the supports"
    );

    // The changed span is in preview layer numbers: the layers that differ.
    let (was, now) = (whole_preview(&base, &base), whole_preview(&pruned, &base));
    let differ: Vec<usize> = was
        .iter()
        .zip(&now)
        .filter(|(a, b)| a.4 != b.4)
        .map(|(a, _)| a.0)
        .collect();
    let edit = &pruned.support_edits[0];
    assert_eq!(differ.len(), edit.changed_layers);
    assert_eq!(
        edit.changed_span,
        Some([differ[0], *differ.last().unwrap()])
    );

    // It equals a fresh slice of the same request, and its patched preview
    // equals the whole one.
    keep_support_bases(false);
    let cold = slice(&belt(json!({"supportEdits": [prune]})));
    assert!(cold.stages.reused.is_empty());
    assert_eq!(cold.gcode, pruned.gcode);
    assert_eq!(
        cold.support_edits[0].changed_span,
        pruned.support_edits[0].changed_span
    );
    assert!(
        pruned.preview_patch.is_some(),
        "a prune that keeps the start patches"
    );
    assert_eq!(whole_preview(&cold, &base), whole_preview(&pruned, &base));

    // Undo: no edits is the original.
    keep_support_bases(true);
    let _ = slice(&belt(json!({"supportEdits": [prune]})));
    let undone = slice(&belt(json!({"includeSkeleton": true})));
    assert_eq!(undone.gcode, base.gcode);
    assert_eq!(undone.skeleton, base.skeleton);
    assert!(undone.support_edits.is_empty());

    // The trees on the lowest layer: without them the belt run starts later,
    // and every preview layer is numbered from the new first one. The arm's
    // tip meets the nozzle plane before its foot does, so its trees go lowest.
    let arm = |extra: Value| {
        let mut req = json!({
            "filename": "arm.stl",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(tower_with_arm()),
            "supportAngle": 60.0,
        });
        req.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        belt(req)
    };
    keep_support_bases(true);
    let held = slice(&arm(json!({"includeSkeleton": true})));
    let skeleton = held.skeleton.as_ref().unwrap();
    let ls = skeleton.ls.as_ref().unwrap();
    let lowest = ls.iter().copied().fold(f64::INFINITY, f64::min);
    let feet: Vec<u32> = skeleton
        .start
        .windows(2)
        .enumerate()
        .filter(|(_, w)| ls[w[0] as usize..w[1] as usize].contains(&lowest))
        .map(|(k, _)| skeleton.tree[k])
        .collect();
    assert!(!feet.is_empty());
    let low_sites: Vec<Value> = trees(skeleton)
        .into_iter()
        .filter(|(root, _)| feet.contains(root))
        .flat_map(|(_, sites)| sites)
        .collect();
    let drop_feet = json!({"kind": "prune", "sites": low_sites});
    let patched = slice(&arm(json!({
        "supportEdits": [drop_feet],
        "previewBase": held.preview_token,
    })));
    assert_eq!(patched.support_edits[0].status, EditStatus::Applied);
    keep_support_bases(false);
    let fresh = slice(&arm(json!({"supportEdits": [drop_feet]})));
    assert!(
        fresh.layers.len() < held.layers.len(),
        "pruning the lowest feet should start the belt run later"
    );
    assert_eq!(fresh.gcode, patched.gcode);
    // The span counts from the new first layer, and leaves out the layers
    // that went with the pruned feet. Layer k now is layer k + dropped before.
    let dropped = held.layers.len() - fresh.layers.len();
    let (was, now) = (whole_preview(&held, &held), whole_preview(&fresh, &held));
    let differ: Vec<usize> = now
        .iter()
        .enumerate()
        .filter(|(k, layer)| was[k + dropped].4 != layer.4)
        .map(|(_, layer)| layer.0)
        .collect();
    let edit = &fresh.support_edits[0];
    assert!(edit.changed_layers > differ.len());
    // A roof layer can change without printing differently, so the span may
    // run a layer or two past the last path that differs, never short of it.
    let [lo, hi] = edit.changed_span.unwrap();
    let last = *differ.last().unwrap();
    assert_eq!(lo, differ[0]);
    assert!((last..=last + 2).contains(&hi), "{hi} after {last}");
    assert_eq!(edit.changed_span, patched.support_edits[0].changed_span);
    assert_eq!(whole_preview(&fresh, &held), whole_preview(&patched, &held));
}
