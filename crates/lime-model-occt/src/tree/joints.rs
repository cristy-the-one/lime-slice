//! Split to print, connectors: the stored joints, how their answers are read back, and the stateless `partition_joints` call.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

use super::lock;
use super::build::build;
use super::ffi::lime_tree_surfaces;
use super::group::GroupBudget;
use super::ops::{Op, Solid};
use super::partition::{connectors_on, partition_fields, PartitionCut};
use super::resolve::{resolve, Steps};
use super::shape::{take_text, Shape};

// --- Split to print, connectors (plan sections 7, 8 and 9). The planner places them (`placeConnectors` in
// src/modeling/partition.ts) and stores `placed` on each cut; the kernel builds each one on the real solids and keeps
// the ones that build (D6). ---

/// The numbers `lime_tree_partition` reads for one connector (`kJointStride` in kernel.h).
const JOINT_STRIDE: usize = 18;

/// One placed connector of a stored op: the cut it is on, counting from 0, its id `c{cut}-{index}`, its type, and the
/// numbers the kernel builds it from.
pub(super) struct Joint {
    cut: usize,
    id: String,
    index: usize,
    kind: &'static str,
    pub(super) numbers: [f64; JOINT_STRIDE],
}

/// A connector type's names in a sentence, and its code in kernel.h. The planner's `TYPE_NAMES` say the same.
fn joint_kind(kind: &str) -> Option<(&'static str, &'static str, f64)> {
    match kind {
        "dowel" => Some(("dowel", "dowels", 0.0)),
        "plug" => Some(("plug", "plugs", 1.0)),
        "hardware" => Some(("hardware hole", "hardware holes", 2.0)),
        "key" => Some(("key", "keys", 3.0)),
        "dovetail" => Some(("dovetail", "dovetails", 4.0)),
        _ => None,
    }
}

/// Every placed connector of the op's cuts, in order. A cut whose connectors are off, or whose `placed` is empty, has
/// none: it is a plain cut.
pub(super) fn stored_joints(cuts: &[PartitionCut]) -> Result<Vec<Joint>, String> {
    let number = |spec: &Value, field: &str| spec.get(field).and_then(Value::as_f64);
    let mut joints = Vec::new();
    for (at, cut) in cuts.iter().enumerate() {
        if !connectors_on(cut) {
            continue;
        }
        let types = cut
            .connectors
            .get("types")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let placed = cut
            .connectors
            .get("placed")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (order, row) in placed.iter().enumerate() {
            let kind = row.get("type").and_then(Value::as_str).unwrap_or("dowel");
            let Some((name, _, code)) = joint_kind(kind) else {
                return Err(format!("Cut {}: a placed connector is a {kind}, which is not a connector type.", at + 1));
            };
            let Some(spec) = types
                .iter()
                .find(|spec| spec.get("type").and_then(Value::as_str) == Some(kind))
            else {
                return Err(format!(
                    "Cut {}: a placed {name} has no {kind} in its types.",
                    at + 1
                ));
            };
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .map_or_else(|| format!("c{}-{}", at + 1, order + 1), str::to_owned);
            let index = id
                .rsplit('-')
                .next()
                .and_then(|tail| tail.parse().ok())
                .unwrap_or(order + 1);
            let pair = |field: &str| {
                row.get(field)
                    .and_then(Value::as_array)
                    .filter(|pair| pair.len() == 2)
                    .and_then(|pair| Some([pair[0].as_f64()?, pair[1].as_f64()?]))
            };
            let (fraction, [a, b]) = match (pair("fraction"), pair("uvMm")) {
                (Some(fraction), _) => (1.0, fraction),
                (None, Some(at_mm)) => (0.0, at_mm),
                (None, None) => {
                    return Err(format!("Connector {id} needs a fraction or uvMm."));
                }
            };
            // A key and a dovetail send their width as the radius slot, and a key its height as well.
            let radius = match kind {
                "hardware" => number(spec, "diameter").map(|diameter| diameter / 2.0),
                "key" | "dovetail" => number(spec, "width"),
                _ => number(spec, "radius"),
            };
            let (Some(radius), Some(depth)) = (radius, number(spec, "depth")) else {
                return Err(format!("Connector {id} needs its size and its depth."));
            };
            let Some(clearance) = number(spec, "clearance") else {
                continue;
            };
            let end_gap = number(spec, "endGap").unwrap_or(0.0);
            let teardrop = spec.get("hole").and_then(Value::as_str) == Some("teardrop");
            let side = if spec.get("side").and_then(Value::as_str) == Some("negative") {
                -1.0
            } else {
                1.0
            };
            // A connector on a flat of a shaped cut: the flat's point (u, w) of the cut and its tilt in degrees.
            let flat = row.get("flat").filter(|flat| flat.is_object());
            let flat_number = |field: &str| flat.and_then(|flat| flat.get(field)).and_then(Value::as_f64).unwrap_or(0.0);
            joints.push(Joint {
                cut: at,
                id,
                index,
                kind: name,
                numbers: [
                    at as f64,
                    code,
                    fraction,
                    a,
                    b,
                    radius,
                    clearance,
                    depth,
                    end_gap,
                    f64::from(u8::from(teardrop)),
                    side,
                    number(spec, "height").unwrap_or(0.0),
                    number(spec, "angle").unwrap_or(0.0),
                    if spec.get("slide").and_then(Value::as_str) == Some("v") {
                        1.0
                    } else {
                        0.0
                    },
                    f64::from(u8::from(flat.is_some())),
                    flat_number("u"),
                    flat_number("w"),
                    flat_number("tilt"),
                ],
            });
        }
    }
    Ok(joints)
}

/// What the kernel answered for one connector (`JointResult` in kernel.h).
#[derive(Clone, Debug, Deserialize)]
pub(super) struct JointAnswer {
    status: i32,
    at: [f64; 3],
    teardrop: bool,
}

/// --- Split to print. What became of an op's connectors: the reply's `connectors`, its sentences, and the ids built.
#[derive(Clone, Debug, Default)]
pub(super) struct Joined {
    pub(super) reply: Value,
    pub(super) notes: Vec<String>,
    pub(super) kept: HashSet<String>,
}

/// The reply's `placed` and `dropped`, with the planner's sentences (section 9): one per connector left out, and "Cut
/// N: no dowel fits. It is a plain cut." for a cut whose every connector was.
pub(super) fn joined_of(joints: &[Joint], answers: &[JointAnswer]) -> Joined {
    let mut placed = Vec::new();
    let mut dropped = Vec::new();
    let mut notes = Vec::new();
    let mut kept = HashSet::new();
    for (joint, answer) in joints.iter().zip(answers) {
        if answer.status == 0 {
            kept.insert(joint.id.clone());
            placed.push(json!({ "id": joint.id, "at": answer.at, "teardrop": answer.teardrop }));
            continue;
        }
        let head = format!("Cut {}: {} {}", joint.cut + 1, joint.kind, joint.index);
        let (reason, sentence) = if answer.status == 1 {
            ("outside", format!("{head} lies outside the section. It was left out."))
        } else {
            (
                "breaks",
                format!("{head} would break through the outline or a neighbour. It was left out."),
            )
        };
        notes.push(sentence.clone());
        dropped.push(json!({ "id": joint.id, "reason": reason, "sentence": sentence }));
    }
    let mut cuts: Vec<usize> = joints.iter().map(|joint| joint.cut).collect();
    cuts.dedup();
    for cut in cuts {
        let mine: Vec<&Joint> = joints.iter().filter(|joint| joint.cut == cut).collect();
        if mine.iter().all(|joint| !kept.contains(&joint.id)) {
            let one = mine.first().map_or("connector", |joint| joint.kind);
            notes.push(format!("Cut {}: no {one} fits. It is a plain cut.", cut + 1));
        }
    }
    Joined {
        reply: json!({ "placed": placed, "dropped": dropped }),
        notes,
        kept,
    }
}

/// The stored op keeps only the connectors that were built (D6), so a replay builds those and finds no new set.
pub(super) fn keep_built(cuts: &mut [PartitionCut], kept: &HashSet<String>) {
    for cut in cuts.iter_mut() {
        if let Some(Value::Array(placed)) = cut.connectors.get_mut("placed") {
            placed.retain(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| kept.contains(id))
            });
        }
    }
}

/// --- Split to print, connectors, for tests. A primitive cut by a stored partition op as the tree builds it: each
/// piece and the pins as `{volumeMm3, solids, valid, closed, surfaces}` (`lime_tree_surfaces`), each pin's volume, the
/// reply's `connectors` and `notes`, and the op the tree would store.
pub fn partition_joints(solid: &str, op: &str) -> Result<String, String> {
    let text: Value = serde_json::from_str(solid).map_err(|err| err.to_string())?;
    // A test part with holes or walls: the primitive, then each op of `before` (a boolean, say) on it, in order.
    let before: Vec<Op> = match text.get("before") {
        Some(list) => serde_json::from_value(list.clone()).map_err(|err| err.to_string())?,
        None => Vec::new(),
    };
    let solid: Solid = serde_json::from_value(text).map_err(|err| err.to_string())?;
    let op: Op = serde_json::from_str(op).map_err(|err| err.to_string())?;
    let _store = lock();
    let mut whole = Shape::primitive(&solid)?;
    let _budget = GroupBudget::start();
    let steps = Steps::new();
    for first in &before {
        let resolved = resolve(&mut whole, first, &steps)?;
        whole = build(&mut whole, resolved, false, None, &steps)
            .map_err(|fail| fail.message)?
            .kept;
    }
    let resolved = resolve(&mut whole, &op, &steps)?;
    let built = build(&mut whole, resolved, false, None, &steps).map_err(|fail| fail.message)?;
    let report = |shape: &Shape| -> Result<Value, String> {
        let check = shape.check();
        let surfaces = take_text(unsafe { lime_tree_surfaces(shape.raw()) })
            .ok_or_else(|| "No surfaces".to_string())?;
        Ok(json!({
            "volumeMm3": check.volume_mm3,
            "solids": check.solids,
            "valid": check.valid,
            "closed": check.closed,
            "surfaces": serde_json::from_str::<Value>(&surfaces).map_err(|err| err.to_string())?,
        }))
    };
    let pieces = std::iter::once(&built.kept)
        .chain(&built.pieces)
        .map(report)
        .collect::<Result<Vec<_>, _>>()?;
    let pins = match built.pins.as_ref() {
        Some(pins) => {
            let mut one = report(pins)?;
            let each: Vec<Value> = pins
                .solids()?
                .iter()
                .map(|pin| json!(pin.check().volume_mm3))
                .collect();
            one["each"] = json!(each);
            one
        }
        None => Value::Null,
    };
    let mut out = json!({ "pieces": pieces, "pins": pins, "op": built.op });
    for (name, value) in partition_fields(built.numbered.as_deref(), built.joined.as_ref()) {
        out[name] = value;
    }
    Ok(out.to_string())
}
