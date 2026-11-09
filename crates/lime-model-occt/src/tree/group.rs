//! Groups of steps (A1/D20) and recipe lattices: the time budget, `build_group`, `build_combined` and their helpers.

use serde_json::{json, Value};
use std::cell::Cell;
use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::build::{build, BuildFail, Built};
use super::ffi::{lime_tree_combine, lime_tree_combine_checked, lime_tree_extrude_cells, lime_tree_set_deadline, RawShape};
use super::k1::{encode_loops, extent_flags};
use super::ops::{BooleanOp, EdgePick, Op};
use super::resolve::{resolve, Steps};
use super::shape::{take_text, Shape};

/// --- D4. How long a new group (an Apply or a probe) may build before it stops at the next step. Every tree
/// shares one store lock, so a group of hundreds of Booleans on a large part would hold up every other part.
/// The edited step of an edit has it too. A replay (open, goto, the steps an edit replays) has no budget: a saved
/// part must open the same on a slower machine.
static GROUP_BUDGET_MS: AtomicU64 = AtomicU64::new(60_000);

/// Sets how long a new group may build before it stops (60 s unless a test or the server changes it).
pub fn set_group_budget(budget: Duration) {
    GROUP_BUDGET_MS.store(
        budget.as_millis().try_into().unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
}

thread_local! {
    /// When the new group being built on this thread must stop; none outside an Apply or a probe.
    static GROUP_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
    /// --- D20. A group built for an Apply, a probe or an edited step, not one replayed: it is refused when every step misses.
    static NEW_GROUP: Cell<bool> = const { Cell::new(false) };
}

/// Marks the op of one Apply, probe or edit as new while it is built, and clears the mark however the call ends.
pub(super) struct NewGroup;

impl NewGroup {
    pub(super) fn start() -> NewGroup {
        NEW_GROUP.set(true);
        NewGroup
    }
}

impl Drop for NewGroup {
    fn drop(&mut self) {
        NEW_GROUP.set(false);
    }
}

/// Holds the group deadline for one Apply or probe, and clears it however the call ends.
pub(super) struct GroupBudget;

impl GroupBudget {
    pub(super) fn start() -> GroupBudget {
        let ms = GROUP_BUDGET_MS.load(Ordering::Relaxed);
        let budget = Duration::from_millis(ms);
        GROUP_DEADLINE.set(Instant::now().checked_add(budget));
        // --- 3.1 F9. One step past the budget stops inside Open CASCADE too, not only between a group's steps. A zero
        // budget is the smallest limit, not none.
        // SAFETY: plain value in, no pointers.
        unsafe { lime_tree_set_deadline(i64::try_from(ms).unwrap_or(i64::MAX).max(1)) };
        GroupBudget
    }
}

impl Drop for GroupBudget {
    fn drop(&mut self) {
        GROUP_DEADLINE.set(None);
        // SAFETY: plain value in, no pointers.
        unsafe { lime_tree_set_deadline(0) };
    }
}

/// The refusal for a group past its deadline, before step `index` of `count`.
fn group_overran(index: usize, count: usize) -> Option<String> {
    let deadline = GROUP_DEADLINE.get()?;
    if Instant::now() < deadline {
        return None;
    }
    let seconds = GROUP_BUDGET_MS.load(Ordering::Relaxed).div_ceil(1000);
    Some(format!(
        "This group stopped after {seconds} s, before step {} of {count}. Use fewer steps, a larger pitch, or a smaller region.",
        index + 1
    ))
}

/// --- A1 group: why a step inside a group was left out instead of refusing the group. ---
fn missed_step(message: &str) -> bool {
    message == "The solids do not overlap"
        || message == "The hole missed this solid"
        || message.ends_with("does not change the part.")
}

/// A boolean the kernel accepts even when the tool never meets the solid: the volume is the one it had.
fn volume_unchanged(before: &Shape, after: &Shape) -> bool {
    let from = before.fingerprint().volume_mm3;
    let tolerance = 1e-6 * from.abs().max(1.0);
    (from - after.fingerprint().volume_mm3).abs() <= tolerance
}

fn step_failed(index: usize, count: usize, message: impl Into<String>, max_mm: Option<f64>) -> BuildFail {
    BuildFail {
        message: format!("Step {} of {count}: {}", index + 1, message.into()),
        max_mm,
        failed_step: Some((index + 1) as u32),
    }
}

/// A step a group may build. Anything else is a sentence, with the step that asked, counting from 1.
fn group_step_refusal(step: &Op) -> Option<&'static str> {
    match step {
        Op::Boolean { .. }
        | Op::Extrude { .. }
        | Op::Revolve { .. }
        | Op::Loft { .. }
        | Op::Hole { .. } => None,
        Op::Fillet { edges, .. } if edges.iter().any(|pick| matches!(pick, EdgePick::Index(_))) => {
            Some("A fillet inside a group needs edges named by their place, not by a number.")
        }
        Op::Chamfer { edges, .. } if edges.iter().any(|pick| matches!(pick, EdgePick::Index(_))) => {
            Some("A chamfer inside a group needs edges named by their place, not by a number.")
        }
        Op::Fillet { .. } | Op::Chamfer { .. } => None,
        Op::Split { .. } => Some("A group cannot contain a split."),
        Op::Join { .. } => Some("A group cannot contain a join."),
        Op::Scale { .. } => Some("A group cannot contain a scale."),
        Op::Unify => Some("A group cannot contain a merge of faces."),
        Op::Root { .. } => Some("A group cannot contain a new solid."),
        Op::Shell { .. } => Some("A group cannot contain a shell."),
        Op::FaceExtrude { .. } => Some("A group cannot contain a face extrude."),
        Op::MoveFaces { .. } => Some("A group cannot contain a face move."),
        Op::Group { .. } => Some("A group cannot contain another group."),
        // --- Split to print.
        Op::Partition { .. } => Some("A group cannot contain a split to print."),
        // --- Print transitions.
        Op::Transition { .. } => Some("A group cannot contain a print transition."),
        // --- Text with real fonts.
        Op::Lettering { .. } => None,
    }
}

/// --- A1 group: each step on the shape the one before left. A step whose tool misses the solid is
/// left out and counted. The first step that fails refuses the group, naming that step. ---
pub(super) fn build_group(
    from: &mut Shape,
    label: String,
    source: Value,
    steps: Vec<Op>,
    probe: bool,
    edge_steps: &Steps,
) -> Result<Built, BuildFail> {
    let count = steps.len();
    if count == 0 {
        return Err(BuildFail::plain("A group needs at least one step."));
    }
    for (index, step) in steps.iter().enumerate() {
        if let Some(message) = group_step_refusal(step) {
            return Err(step_failed(index, count, message, None));
        }
    }
    let parent_faces = from.fingerprint().faces;
    // --- A10. `back[i]` is the original parent's face that the shape in hand still carries as face `i`.
    let mut back: Vec<c_int> = (0..parent_faces).collect();
    let mut current: Option<Shape> = None;
    let mut skipped = 0u32;
    let mut stored: Vec<Op> = Vec::with_capacity(count);
    for (index, step) in steps.iter().enumerate() {
        if let Some(message) = group_overran(index, count) {
            return Err(BuildFail::plain(message));
        }
        let outcome = {
            let shape = match current.as_mut() {
                Some(shape) => shape,
                None => &mut *from,
            };
            let resolved = resolve(shape, step, edge_steps)
                .map_err(|message| step_failed(index, count, message, None))?;
            build(shape, resolved, probe, None, edge_steps)
        };
        match outcome {
            Ok(mut built) => {
                let before = current.as_ref().map_or(&*from, |shape| shape);
                let silent = matches!(step, Op::Boolean { .. }) && volume_unchanged(before, &built.kept);
                if silent {
                    skipped += 1;
                    stored.push(step.clone());
                } else {
                    // --- A10. Compose lineage so the group's faces index the solid the group started from.
                    let lineage = built.kept.face_from();
                    let next: Vec<c_int> = lineage
                        .iter()
                        .map(|&src| {
                            if src >= 0 {
                                back.get(src as usize).copied().unwrap_or(-1)
                            } else {
                                -1
                            }
                        })
                        .collect();
                    built.kept.set_face_from(&next);
                    back = next;
                    stored.push(built.op);
                    current = Some(built.kept);
                }
            }
            Err(fail) if missed_step(&fail.message) => {
                skipped += 1;
                stored.push(step.clone());
            }
            Err(fail) => return Err(step_failed(index, count, fail.message, fail.max_mm)),
        }
    }
    // --- D20. A new group that changes nothing is refused: Apply would store a step that does nothing.
    if current.is_none() && NEW_GROUP.get() {
        let message = if count == 1 {
            "Its one step does not change the part.".to_owned()
        } else {
            format!("None of its {count} steps changes the part.")
        };
        return Err(BuildFail::plain(message));
    }
    // Every step of a replayed group missed: it keeps the solid it started from. A copy, so the parent keeps its own.
    let kept = match current {
        Some(kept) => kept,
        None => {
            let bytes = from.brep_bytes().map_err(BuildFail::plain)?;
            let mut kept = Shape::read_brep(&bytes, false).map_err(BuildFail::plain)?;
            // --- A10. Nothing in the group changed a face, so each face is still the parent's.
            let identity: Vec<c_int> = (0..parent_faces).collect();
            kept.set_face_from(&identity);
            kept
        }
    };
    Ok(Built {
        op: Op::Group {
            label,
            source,
            steps: stored,
            combine: None,
        },
        kept,
        other: None,
        pieces: Vec::new(),
        pins: None,
        numbered: None,
        joined: None,
        skipped,
        sides: Vec::new(),
        report: None,
    })
}

// --- Recipe lattices (docs/plan-recipe-ingredients.md I19–I20). Keep this block together. ---

/// I20: an extrude of cells on `from`, or alone (a new solid, or a combined group's tool) with no `from`. The solid,
/// and what became of the cells: `{cells, clipped, outside, small, failed, corners: {full, reduced, sharp}}`, with
/// `firstFailure` when a cell did not build.
pub(super) fn extrude_cells(from: Option<&Shape>, op: &Op) -> Result<(Shape, Value), String> {
    let Op::Extrude {
        op: which,
        origin,
        turn,
        depth,
        symmetric,
        depth2,
        draft_deg,
        up_to,
        loops,
        clip,
        corner_radius,
        min_area,
        ..
    } = op
    else {
        return Err("Cells are an extrude's.".into());
    };
    let p = [
        origin[0],
        origin[1],
        origin[2],
        turn[0],
        turn[1],
        turn[2],
        *depth,
        f64::from(u8::from(*symmetric)),
        corner_radius.unwrap_or(0.0),
        min_area.unwrap_or(0.0),
    ];
    let mut blob = Vec::new();
    encode_loops(loops, &mut blob);
    let mut region = Vec::new();
    if !clip.is_empty() {
        encode_loops(clip, &mut region);
    }
    let mut counts = [0.0f64; 8];
    let mut note: *mut c_char = std::ptr::null_mut();
    let flags = extent_flags(*depth2, *draft_deg, up_to.as_ref());
    let shape = Shape::made(|error| unsafe {
        lime_tree_extrude_cells(
            from.map_or(std::ptr::null(), Shape::raw),
            which.name().as_ptr(),
            p.as_ptr(),
            blob.as_ptr(),
            blob.len() as c_int,
            region.as_ptr(),
            region.len() as c_int,
            depth2.unwrap_or(0.0),
            draft_deg.unwrap_or(0.0),
            flags,
            counts.as_mut_ptr(),
            &mut note,
            error,
        )
    });
    let first_failure = take_text(note);
    let shape = shape?;
    let mut report = json!({
        "cells": counts[0],
        "clipped": counts[1],
        "outside": counts[2],
        "small": counts[3],
        "failed": counts[4],
        "corners": { "full": counts[5], "reduced": counts[6], "sharp": counts[7] },
    });
    if let (Some(first), Some(fields)) = (first_failure, report.as_object_mut()) {
        fields.insert("firstFailure".into(), json!(first));
    }
    Ok((shape, report))
}

/// I19: one step's tool, built alone, for a combined group of `which`. Only booleans, extrudes, revolves, and lofts
/// of that same boolean are tools.
pub(super) fn step_tool(step: &Op, which: BooleanOp) -> Result<Shape, String> {
    let named = match which {
        BooleanOp::Fuse => "fuse",
        BooleanOp::Cut => "cut",
        BooleanOp::Common => "common",
    };
    let wrong = || format!("A combined batch of {named} takes only {named} steps: boolean, extrude, revolve, or loft.");
    match step {
        Op::Boolean { op, tool, .. } if *op == which => Shape::primitive(tool),
        Op::Extrude { op, .. } | Op::Revolve { op, .. } | Op::Loft { op, .. } if *op == which => {
            let mut alone = step.clone();
            match &mut alone {
                Op::Extrude { op, .. } | Op::Revolve { op, .. } | Op::Loft { op, .. } => *op = BooleanOp::Fuse,
                _ => {}
            }
            Shape::feature(&alone)
        }
        _ => Err(wrong()),
    }
}

/// I19: a group whose steps are all tools of one boolean. Each tool is built alone; one that does not build is left
/// out and reported by its index. Every tool that built meets `from` in one boolean, one history step. The group stores
/// every step as sent, so a replay leaves the same ones out.
pub(super) fn build_combined(from: &mut Shape, label: String, source: Value, steps: Vec<Op>, which: BooleanOp) -> Result<Built, BuildFail> {
    let count = steps.len();
    if count == 0 {
        return Err(BuildFail::plain("A group needs at least one step."));
    }
    let mut tools = Vec::with_capacity(count);
    let mut failed = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        if let Some(message) = group_overran(index, count) {
            return Err(BuildFail::plain(message));
        }
        match step_tool(step, which) {
            Ok(tool) => tools.push(tool),
            Err(message) => failed.push(json!({ "index": index, "reason": message })),
        }
    }
    if tools.is_empty() {
        let first = failed
            .first()
            .and_then(|row| row["reason"].as_str())
            .unwrap_or("No tool built.");
        return Err(BuildFail::plain(if count == 1 {
            first.to_string()
        } else {
            format!("None of its {count} tools built. The first: {first}")
        }));
    }
    let raws: Vec<*const RawShape> = tools.iter().map(Shape::raw).collect();
    // --- docs/plan-native-recipes.md 7.1: a recipe's queued tools also say which of them changed nothing.
    let queued = source.get("kind").and_then(Value::as_str) == Some("queue");
    let mut missed: Vec<c_int> = vec![0; raws.len()];
    // Plain booleans merge faces on one surface after each step: a queued group of them merges once at its end. The
    // host never groups them with ops that do not merge.
    let merge = c_int::from(steps.iter().all(|step| matches!(step, Op::Boolean { merge: true, .. })));
    let kept = Shape::made(|error| unsafe {
        if queued {
            lime_tree_combine_checked(from.raw(), which.name().as_ptr(), raws.as_ptr(), raws.len() as c_int, merge, missed.as_mut_ptr(), error)
        } else {
            lime_tree_combine(from.raw(), which.name().as_ptr(), raws.as_ptr(), raws.len() as c_int, error)
        }
    })
    .map_err(BuildFail::plain)?;
    // Indexes of the steps, not of the tools that built. A plain boolean that misses is an ordinary step (it keeps the
    // solid as it was, built alone too); an extrude, revolve or loft that changes nothing is refused alone, so only
    // those count as missed.
    let built: Vec<usize> = (0..count).filter(|index| !failed.iter().any(|row| row["index"] == json!(index))).collect();
    let gone: Vec<usize> = missed
        .iter()
        .enumerate()
        .filter(|(_, m)| **m != 0)
        .filter_map(|(at, _)| built.get(at).copied())
        .filter(|index| !matches!(steps[*index], Op::Boolean { .. }))
        .collect();
    let mut report = json!({ "tools": tools.len(), "failed": failed });
    if queued {
        report["missed"] = json!(gone);
    }
    Ok(Built {
        op: Op::Group {
            label,
            source,
            steps,
            combine: Some(which),
        },
        kept,
        other: None,
        pieces: Vec::new(),
        pins: None,
        numbered: None,
        joined: None,
        skipped: 0,
        sides: Vec::new(),
        report: Some(("combined", report)),
    })
}

/// --- docs/plan-native-recipes.md 7.1. A plain fuse or cut's tool built alone, and its box: what a recipe's queue reads
/// before it holds the op back. The answer is `{min, max}`, or the sentence why the tool does not build.
pub(super) fn tool_box_reply(op: &Op) -> Result<String, String> {
    let which = match op {
        Op::Boolean { op, .. } | Op::Extrude { op, .. } | Op::Revolve { op, .. } | Op::Loft { op, .. } => *op,
        _ => return Err("Only a boolean, extrude, revolve, or loft has a tool of its own.".into()),
    };
    if !matches!(which, BooleanOp::Fuse | BooleanOp::Cut) {
        return Err("Only a fuse or a cut is queued.".into());
    }
    let tool = step_tool(op, which)?;
    let [x0, y0, z0, x1, y1, z1] = tool.bounds().ok_or_else(|| "The tool has no extent.".to_string())?;
    Ok(json!({ "min": [x0, y0, z0], "max": [x1, y1, z1] }).to_string())
}
// --- end recipe lattices ---
