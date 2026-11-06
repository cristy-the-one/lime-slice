//! Split to print: the cut and target types, the numbers handed to the kernel, the reply fields that report them, and `Shape::partition`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;

use super::{lock, ROOT};
use super::ffi::{lime_tree_partition, RawShape};
use super::group::GroupBudget;
use super::joints::{Joined, Joint, JointAnswer};
use super::ops::{Op, Solid};
use super::outcome::{Failure, Part};
use super::shape::{take_text, Shape};

/// --- Split to print, part numbers (plan sections 2 and 10). Each piece's number as `textStrokes` draws it, centred
/// on the label: `digits[i]` is piece `i + 1`'s strokes, each `[u, v, length, angleDeg]`. The strokes are `strokeMm`
/// wide and cut `depthMm` deep, and the label keeps `insetMm` from a face's edge.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionNumbers {
    pub digits: Vec<Vec<[f64; 4]>>,
    pub stroke_mm: f64,
    pub depth_mm: f64,
    #[serde(default)]
    pub inset_mm: f64,
}

/// --- Split to print. One cut: the plane through `origin` square to `normal`. `u`, `profile` and `connectors` are
/// stored as sent. Only a straight cut is built yet; its connectors are `{on, types, placed}` (plan section 11, D6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionCut {
    pub origin: [f64; 3],
    pub normal: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub u: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub profile: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub connectors: Value,
}

/// --- Split to print (D11). The printer the pieces are for, as it was at Apply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionTarget {
    pub printer: String,
    pub process: PrintProcess,
    pub volume_mm: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintProcess {
    Fdm,
    Resin,
}

const PARTITION_PROFILE_KIND: &str =
    "A cut's profile is straight, lap, tongue, zigzag, dovetail or sketch.";

/// The numbers a cut's profile gives the kernel (`kProfileStride` in kernel.h): its kind, eight sizes, and the cut's U.
const PROFILE_STRIDE: usize = 14;

/// The numbers of one segment of a sketched cut's chain (`kChainStride` in kernel.h): 0 for a line or 1 for an arc, the
/// arc's through point, and the end, each (U, W).
const CHAIN_STRIDE: usize = 5;

/// The most segments a sketched cut's chain may have.
const CHAIN_MAX: usize = 200;

/// The most segments a changed zig-zag's chain may have: four a period, as many periods as the kernel's own zig-zag.
const ZIGZAG_CHAIN_MAX: usize = 16_000;

/// The planner's Max pieces (`clampPieces` in `src/modeling/partition.ts`): 12 when absent, from 2 to 24.
pub(super) fn partition_max(max_pieces: Option<f64>) -> usize {
    let wanted = max_pieces
        .filter(|value| value.is_finite())
        .unwrap_or(12.0)
        .round();
    wanted.clamp(2.0, 24.0) as usize
}

/// Why a partition is not built, before anything is cut: a profile of no known kind. It is a sentence, and the solid is
/// unchanged. A resin target cuts: its pieces are exported, not sliced (D12).
pub(super) fn partition_refusal(cuts: &[PartitionCut]) -> Option<&'static str> {
    let kind = |profile: &Value| {
        profile
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("straight")
            .to_string()
    };
    if !cuts
        .iter()
        .all(|cut| matches!(
                kind(&cut.profile).as_str(),
                "straight" | "lap" | "tongue" | "zigzag" | "dovetail" | "sketch"
            ))
    {
        return Some(PARTITION_PROFILE_KIND);
    }
    None
}

/// Each cut's profile as the kernel reads it. A lap: depth, carried to the side that has it (side, positive by
/// default), and at, where the step sits along V from the cut's origin. A tongue: width, depth, clearance, endGap,
/// side, its ends along U (u0, u1) and its middle along V (v). The planner fills every one from the section at Apply,
/// so a replay builds the same joint. A sketch: its chain's `start` and segments, `{kind: line | arc, to, through}`, each
/// point [u, w] in millimetres from the cut's origin, appended to the chain numbers its profile points into.
pub(super) fn profile_numbers(cuts: &[PartitionCut]) -> Result<(Vec<[f64; PROFILE_STRIDE]>, Vec<f64>), String> {
    let mut chains = Vec::new();
    let profiles = cuts
        .iter()
        .enumerate()
        .map(|(at, cut)| {
            let mut out = [0.0; PROFILE_STRIDE];
            let number = |field: &str| {
                cut.profile.get(field).and_then(Value::as_f64).ok_or_else(|| {
                    format!("Cut {}'s profile needs {field}, a number. Apply it from the planner.", at + 1)
                })
            };
            let side = if cut.profile.get("side").and_then(Value::as_str) == Some("negative") {
                -1.0
            } else {
                1.0
            };
            match cut.profile.get("kind").and_then(Value::as_str).unwrap_or("straight") {
                "lap" => {
                    out[0] = 1.0;
                    out[1] = side * number("depth")?;
                    out[2] = number("at")?;
                }
                "tongue" => {
                    out[0] = 2.0;
                    out[1] = number("width")?;
                    out[2] = number("depth")?;
                    out[3] = number("clearance")?;
                    out[4] = number("endGap")?;
                    out[5] = side;
                    out[6] = number("u0")?;
                    out[7] = number("u1")?;
                    out[8] = number("v")?;
                }
                "dovetail" => {
                    out[0] = 4.0;
                    out[1] = number("width")?;
                    out[2] = number("depth")?;
                    out[3] = number("clearance")?;
                    out[4] = number("endGap")?;
                    out[5] = side;
                    out[6] = number("u0")?;
                    out[7] = number("u1")?;
                    out[8] = number("v")?;
                    out[9] = number("angle")?;
                    out[10] = if cut.profile.get("slide").and_then(Value::as_str) == Some("v") {
                        1.0
                    } else {
                        0.0
                    };
                }
                "zigzag" if cut.profile.get("chain").is_some() => {
                    // A zig-zag whose teeth the planner changed to keep its walls (`planZigzag`) is its chain, cut
                    // as a sketch's is.
                    let segments = profile_chain(&cut.profile, at, ZIGZAG_CHAIN_MAX)?;
                    let [su, sw] = chain_point(cut.profile.get("start"))
                        .ok_or_else(|| format!("Cut {}'s zig-zag needs start, [u, w].", at + 1))?;
                    out[0] = 5.0;
                    out[1] = chains.len() as f64;
                    out[2] = (segments.len() / CHAIN_STRIDE) as f64;
                    out[3] = su;
                    out[4] = sw;
                    chains.extend(segments);
                }
                "zigzag" => {
                    out[0] = 3.0;
                    out[1] = side * number("depth")?;
                    out[2] = number("pitch")?;
                    out[3] = number("angle")?;
                    out[4] = number("u0")?;
                }
                "sketch" => {
                    let segments = profile_chain(&cut.profile, at, CHAIN_MAX)?;
                    let [su, sw] = chain_point(cut.profile.get("start"))
                        .ok_or_else(|| format!("Cut {}'s sketch needs start, [u, w].", at + 1))?;
                    out[0] = 5.0;
                    out[1] = chains.len() as f64;
                    out[2] = (segments.len() / CHAIN_STRIDE) as f64;
                    out[3] = su;
                    out[4] = sw;
                    chains.extend(segments);
                }
                _ => {}
            }
            let [ux, uy, uz] = cut.u.unwrap_or([0.0; 3]);
            out[11] = ux;
            out[12] = uy;
            out[13] = uz;
            Ok(out)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((profiles, chains))
}

/// A point of a sketched cut's chain: [u, w], two finite numbers.
fn chain_point(value: Option<&Value>) -> Option<[f64; 2]> {
    let list = value?.as_array()?;
    match list.as_slice() {
        [u, w] => {
            let (u, w) = (u.as_f64()?, w.as_f64()?);
            (u.is_finite() && w.is_finite()).then_some([u, w])
        }
        _ => None,
    }
}

/// A sketched cut's chain as the kernel reads it, `CHAIN_STRIDE` numbers a segment, at most `max` segments. Lines and
/// arcs only.
fn profile_chain(profile: &Value, at: usize, max: usize) -> Result<Vec<f64>, String> {
    let cut = at + 1;
    let Some(rows) = profile.get("chain").and_then(Value::as_array) else {
        return Err(format!("Cut {cut}'s sketch needs chain, a list of lines and arcs."));
    };
    if rows.is_empty() || rows.len() > max {
        return Err(format!("Cut {cut}'s sketch has {} segments; it takes 1 to {max}.", rows.len()));
    }
    let mut out = Vec::with_capacity(rows.len() * CHAIN_STRIDE);
    for row in rows {
        let to = chain_point(row.get("to"))
            .ok_or_else(|| format!("Each segment of cut {cut}'s sketch needs to, [u, w]."))?;
        match row.get("kind").and_then(Value::as_str).unwrap_or("line") {
            "line" => out.extend([0.0, 0.0, 0.0, to[0], to[1]]),
            "arc" => {
                let through = chain_point(row.get("through"))
                    .ok_or_else(|| format!("An arc of cut {cut}'s sketch needs through, [u, w]."))?;
                out.extend([1.0, through[0], through[1], to[0], to[1]]);
            }
            _ => return Err(format!("Cut {cut}'s sketch is lines and arcs.")),
        }
    }
    Ok(out)
}

pub(super) fn connectors_on(cut: &PartitionCut) -> bool {
    cut.connectors.get("on").and_then(Value::as_bool) == Some(true)
}

/// Where an apply's other pieces go: a split's `otherKey`, or a split to print's `pieceKeys`.
pub(super) struct PieceKeys {
    pub(super) other: Option<String>,
    pub(super) list: Vec<Option<String>>,
    /// --- Split to print: where the pins' tree opens.
    pub(super) pins: Option<String>,
}

/// Every key a split to print names for its pieces is a tree of its own, apart from `key` and from each other.
pub(super) fn piece_keys_refusal(key: &str, op: &Op, piece_keys: &[Option<String>]) -> Result<(), Failure> {
    if piece_keys.is_empty() {
        return Ok(());
    }
    if !matches!(op, Op::Partition { .. }) {
        return Err(Failure::Message(
            "pieceKeys is only for a split to print".into(),
        ));
    }
    let mut seen = HashSet::new();
    for piece in piece_keys.iter().flatten() {
        if piece == key || !seen.insert(piece.as_str()) {
            return Err(Failure::Message("Each piece needs a key of its own".into()));
        }
    }
    Ok(())
}

/// A cut that makes more pieces than keys were sent for keeps nothing: a piece with nowhere to go would be lost.
pub(super) fn partition_keys_cover(more: usize, piece_keys: &[Option<String>]) -> Result<(), Failure> {
    if piece_keys.is_empty() || more <= piece_keys.len() {
        return Ok(());
    }
    Err(Failure::Message(format!(
        "This cut makes {} pieces, and keys came for {}.",
        more + 1,
        piece_keys.len() + 1
    )))
}

/// Each keyed piece's reply as the root of its own tree; none for a piece sent no key.
pub(super) fn piece_replies(
    pieces: &mut [Shape],
    piece_keys: &[Option<String>],
    chord: f64,
) -> Result<Vec<Option<String>>, Failure> {
    pieces
        .iter_mut()
        .enumerate()
        .map(|(index, piece)| match piece_keys.get(index) {
            Some(Some(_)) => piece.reply(ROOT, chord).map(Some),
            _ => Ok(None),
        })
        .collect()
}

pub fn partition_primitive(
    solid: &str,
    planes: &[[f64; 6]],
) -> Result<Vec<crate::PartitionPiece>, String> {
    let solid: Solid = serde_json::from_str(solid).map_err(|err| err.to_string())?;
    let _store = lock();
    let whole = Shape::primitive(&solid)?;
    let _budget = GroupBudget::start();
    let plain = JointCut {
        us: vec![[0.0; 3]; planes.len()],
        joints: Vec::new(),
        up: [0.0, 0.0, 1.0],
        profiles: vec![[0.0; PROFILE_STRIDE]; planes.len()],
        chains: Vec::new(),
    };
    Ok(whole
        .partition(planes, None, &plain)?
        .pieces
        .iter()
        .map(Shape::check)
        .collect())
}

/// --- Split to print. Where each piece's number was cut, in partition order.
pub(super) type Numbered = Vec<Vec<NumberPlace>>;

/// --- Split to print. A part number cut on the face of cut `cut`, or on a side face when `cut` is None.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct NumberPlace {
    #[serde(deserialize_with = "side_or_cut")]
    cut: Option<usize>,
    at: [f64; 3],
    normal: [f64; 3],
}

fn side_or_cut<'de, D: serde::Deserializer<'de>>(from: D) -> Result<Option<usize>, D::Error> {
    let index = i64::deserialize(from)?;
    Ok(usize::try_from(index).ok())
}

/// --- Split to print. What `Shape::partition` needs to cut the part numbers: the strokes.
pub(super) struct Labels<'a> {
    pub(super) numbers: &'a PartitionNumbers,
}

/// --- Split to print. Each cut's U, the connectors to build, and the print's up in the solid's frame.
pub(super) struct JointCut {
    pub(super) us: Vec<[f64; 3]>,
    pub(super) joints: Vec<Joint>,
    pub(super) up: [f64; 3],
    /// Each cut's profile as `PROFILE_STRIDE` numbers (`kProfileStride` in kernel.h).
    pub(super) profiles: Vec<[f64; PROFILE_STRIDE]>,
    /// The segments of every sketched cut's chain, `CHAIN_STRIDE` numbers each, which a sketch's profile points into.
    pub(super) chains: Vec<f64>,
}

/// --- Split to print. What the kernel cut: the pieces in partition order, where each number went, the pins, and what
/// became of each connector, in the order sent.
pub(super) struct Partitioned {
    pub(super) pieces: Vec<Shape>,
    pub(super) numbered: Option<Numbered>,
    pub(super) pins: Option<Shape>,
    pub(super) answers: Vec<JointAnswer>,
}

/// --- Split to print. Each piece's number as the reply sends it, `{part, faces}`, and a sentence for each piece that
/// had no room for its number.
fn number_fields(numbered: &[Vec<NumberPlace>]) -> (Value, Vec<String>) {
    let mut notes = Vec::new();
    let list = numbered
        .iter()
        .enumerate()
        .map(|(index, places)| {
            if places.is_empty() {
                notes.push(format!("Part {} has no room for a number.", index + 1));
            }
            let faces: Vec<Value> = places
                .iter()
                .map(|place| {
                    json!({
                        "face": if place.cut.is_some() { "cut" } else { "side" },
                        "cut": place.cut,
                        "at": place.at,
                        "normal": place.normal,
                    })
                })
                .collect();
            json!({ "part": index + 1, "faces": faces })
        })
        .collect();
    (Value::Array(list), notes)
}

/// --- Split to print. An apply's, an edit's or a probe's `numbers`, `connectors` (`placed` and `dropped`) and
/// `notes`: the connectors' sentences first, then the numbers'. Nothing when neither was asked for.
pub(super) fn partition_fields(numbered: Option<&[Vec<NumberPlace>]>, joined: Option<&Joined>) -> Vec<(&'static str, Value)> {
    let mut fields = Vec::new();
    let mut notes: Vec<String> = joined.map(|joined| joined.notes.clone()).unwrap_or_default();
    if let Some(joined) = joined {
        fields.push(("connectors", joined.reply.clone()));
    }
    if let Some(numbered) = numbered {
        let (numbers, more) = number_fields(numbered);
        fields.push(("numbers", numbers));
        notes.extend(more);
    }
    if numbered.is_some() || joined.is_some() {
        fields.push(("notes", json!(notes)));
    }
    fields
}

pub(super) fn push_numbers(fields: &mut Vec<(&'static str, Part)>, numbered: Option<&[Vec<NumberPlace>]>, joined: Option<&Joined>) {
    for (name, value) in partition_fields(numbered, joined) {
        fields.push((name, Part::Json(value.to_string())));
    }
}

/// --- Split to print. The pins' volume, count and box, for a probe's `pins`.
pub(super) fn pins_metrics(pins: &Shape) -> Value {
    let check = pins.check();
    let mut part = json!({ "volumeMm3": check.volume_mm3, "count": check.solids });
    if let Some([x0, y0, z0, x1, y1, z1]) = pins.bounds() {
        part["min"] = json!([x0, y0, z0]);
        part["max"] = json!([x1, y1, z1]);
    }
    part
}

impl Shape {
    /// Cuts this solid along every plane (x, y, z, nx, ny, nz) at once. The pieces are in partition order, and none is
    /// made unless all are. The caller's budget, if any, applies. `cut.joints` are built on the pieces next, each kept
    /// only when it builds, with the pins of the dowels kept. With `labels`, each piece's number is cut into it last.
    pub(super) fn partition(
        &self,
        planes: &[[f64; 6]],
        labels: Option<&Labels>,
        cut: &JointCut,
    ) -> Result<Partitioned, String> {
        const MAX_PIECES: usize = 24;
        let count = c_int::try_from(planes.len()).map_err(|_| "Too many planes".to_string())?;
        let flat: Vec<f64> = planes.iter().flatten().copied().collect();
        let us: Vec<f64> = cut.us.iter().flatten().copied().collect();
        if us.len() != flat.len() / 2 {
            return Err("Each cut needs its U".into());
        }
        let profiles: Vec<f64> = cut.profiles.iter().flatten().copied().collect();
        let profile_count = c_int::try_from(cut.profiles.len()).map_err(|_| "Too many cuts".to_string())?;
        let chain_count = c_int::try_from(cut.chains.len()).map_err(|_| "This sketch profile is too long".to_string())?;
        let joints: Vec<f64> = cut
            .joints
            .iter()
            .flat_map(|joint| joint.numbers)
            .collect();
        let joint_count =
            c_int::try_from(cut.joints.len()).map_err(|_| "Too many connectors".to_string())?;
        let digits = labels.map_or(&[][..], |labels| &labels.numbers.digits[..]);
        let stroke_counts: Vec<c_int> = digits
            .iter()
            .map(|digit| c_int::try_from(digit.len()).unwrap_or(0))
            .collect();
        let strokes: Vec<f64> = digits.iter().flatten().flatten().copied().collect();
        let sizes = labels.map_or([0.0; 3], |labels| {
            let numbers = labels.numbers;
            [numbers.stroke_mm, numbers.depth_mm, numbers.inset_mm]
        });
        let digit_count = c_int::try_from(digits.len()).map_err(|_| "Too many numbers".to_string())?;
        let mut out = [std::ptr::null_mut::<RawShape>(); MAX_PIECES];
        let mut placed: *mut c_char = std::ptr::null_mut();
        let mut pins: *mut RawShape = std::ptr::null_mut();
        let mut joined: *mut c_char = std::ptr::null_mut();
        let mut error: *mut c_char = std::ptr::null_mut();
        // SAFETY: `flat` holds `count` planes and `us` a U for each; `strokes` holds the strokes `stroke_counts` counts;
        // `joints` holds `joint_count` connectors of `JOINT_STRIDE` numbers, and `up` three; `out` has room for the most
        // pieces the kernel returns.
        let made = unsafe {
            lime_tree_partition(
                self.raw(),
                flat.as_ptr(),
                count,
                us.as_ptr(),
                stroke_counts.as_ptr(),
                digit_count,
                strokes.as_ptr(),
                sizes.as_ptr(),
                joints.as_ptr(),
                joint_count,
                cut.up.as_ptr(),
                profiles.as_ptr(),
                profile_count,
                cut.chains.as_ptr(),
                chain_count,
                out.as_mut_ptr(),
                &mut placed,
                &mut pins,
                &mut joined,
                &mut error,
            )
        };
        let message = take_text(error);
        let placed = take_text(placed);
        let joined = take_text(joined);
        let pins = NonNull::new(pins).map(Shape);
        let Ok(made) = usize::try_from(made) else {
            return Err(message.unwrap_or_else(|| "Open CASCADE failed".into()));
        };
        let pieces = out[..made]
            .iter()
            .filter_map(|piece| NonNull::new(*piece).map(Shape))
            .collect();
        let numbered = match placed {
            Some(text) => Some(serde_json::from_str(&text).map_err(|err| err.to_string())?),
            None => None,
        };
        let answers = match joined {
            Some(text) => serde_json::from_str(&text).map_err(|err| err.to_string())?,
            None => Vec::new(),
        };
        Ok(Partitioned {
            pieces,
            numbered,
            pins,
            answers,
        })
    }
}
