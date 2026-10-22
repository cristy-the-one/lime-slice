//! The one place that links the slicer and the stress solver.
//!
//! `lime-sim` doesn't link the slicer (the main plan's D1), and the slicer
//! doesn't know about stress. This crate slices one object, turns its beads
//! into a `slice-field-1`, and runs a study of the part as sliced. The
//! Tauri command and the MCP engine both call [`study_json`], so the desktop
//! and an LLM get the same numbers.
//!
//! Every point and direction a caller sends or reads is in the **model
//! frame**: the object's own mesh, before its pose put it on the plate. The
//! slice field's frame is composed with the inverse of that pose before the
//! study runs, so regions, hot spots and the drawn surface need no mapping.

// Matrix loops index a fixed slot on purpose, as in lime-sim.
#![allow(clippy::needless_range_loop)]

use base64::Engine;
use lime_sim::slice_field::{role_index, Header, LayerRow, Segment, SliceField, ROLES};
use lime_sim::sliced_study::{draw_surface, run, SlicedStudy};
use lime_slice_core::{slice_beads, Job, SliceRequest, Watch};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// `slice-field-1` of one object: the beads its G-code extrudes, less the
/// skirt, supports and ironing, which carry no load (the sliced plan's
/// P-D4). The slicer is asked for the same slice an ordinary one-object
/// request makes.
pub fn slice_field(req: &SliceRequest, job: Job, watch: &Watch) -> Result<SliceField, String> {
    let reply = slice_beads(req, job, watch)?;
    let sliced = reply.beads.as_ref().expect("slice_beads keeps the beads");
    let mut segments = Vec::with_capacity(sliced.beads.len());
    let mut layers: Vec<LayerRow> = Vec::new();
    for bead in &sliced.beads {
        let Some(role) = role_index(bead.kind.as_str()) else {
            continue;
        };
        let index = bead.layer as u32;
        match layers.last_mut() {
            Some(row) if row.index == index => row.bead_count += 1,
            _ => {
                let layer = sliced
                    .layers
                    .iter()
                    .find(|l| l.index == bead.layer)
                    .expect("a bead's layer is listed");
                layers.push(LayerRow {
                    index,
                    z_mm: layer.z_mm,
                    height_mm: layer.height_mm,
                    bead_start: segments.len() as u32,
                    bead_count: 1,
                });
            }
        }
        let f = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        segments.push(Segment {
            layer: index,
            role,
            from: f(bead.from),
            to: f(bead.to),
            width_mm: bead.width as f32,
            bead_height_mm: bead.height as f32,
            flow: bead.flow as f32,
        });
    }
    if segments.is_empty() {
        return Err("The slice has no beads that carry load.".into());
    }
    let hash = Sha256::digest(serde_json::to_vec(req).map_err(|e| e.to_string())?);
    Ok(SliceField {
        header: Header {
            format: lime_sim::slice_field::FORMAT.into(),
            slice_hash: hash.iter().map(|b| format!("{b:02x}")).collect(),
            frame: sliced.frame,
            layer_normal: sliced.layer_normal,
            layers,
            roles: ROLES.iter().map(|r| r.to_string()).collect(),
            segment_count: segments.len() as u32,
        },
        segments,
    })
}

type M4 = [[f64; 4]; 4];

fn identity() -> M4 {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn multiply(a: &M4, b: &M4) -> M4 {
    let mut out = [[0.0; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            out[r][c] = (0..4).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    out
}

/// The part frame to the model frame. A posed object was moved by
/// `p' = R (p − pivot) + t'`, where `t'` is the pose's translation with its
/// X and Y replaced by the bed's centre (`RigidPose::part_frame`); an
/// object with no pose is sliced as given.
pub fn part_to_model(req: &SliceRequest) -> Result<M4, String> {
    let pose = req
        .objects
        .as_ref()
        .and_then(|objects| objects.first())
        .and_then(|o| o.pose)
        .or(req.pose);
    let Some(pose) = pose else {
        return Ok(identity());
    };
    let profile = req.printer.clone().unwrap_or_default();
    let centre = [profile.bed_x * 0.5, profile.bed_y * 0.5];
    let (frame, _) = pose.part_frame(centre);
    let r = frame.rotation;
    let rot = [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]];
    let det = rot[0][0] * (rot[1][1] * rot[2][2] - rot[1][2] * rot[2][1])
        - rot[0][1] * (rot[1][0] * rot[2][2] - rot[1][2] * rot[2][0])
        + rot[0][2] * (rot[1][0] * rot[2][1] - rot[1][1] * rot[2][0]);
    if det.abs() < 1e-12 {
        return Err("The object's pose can't be undone.".into());
    }
    let mut inv = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (r1, r2) = ((j + 1) % 3, (j + 2) % 3);
            let (c1, c2) = ((i + 1) % 3, (i + 2) % 3);
            inv[i][j] = (rot[r1][c1] * rot[r2][c2] - rot[r1][c2] * rot[r2][c1]) / det;
        }
    }
    // p = R⁻¹ (p' − t') + pivot.
    let t = frame.translation;
    let mut m = identity();
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = inv[i][j];
        }
        m[i][3] = frame.pivot[i] - (0..3).map(|k| inv[i][k] * t[k]).sum::<f64>();
    }
    Ok(m)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StudyBody {
    request: SliceRequest,
    study: SlicedStudy,
}

fn floats_b64(values: impl Iterator<Item = f32>) -> String {
    let mut raw = Vec::new();
    for v in values {
        raw.extend_from_slice(&v.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(raw)
}

/// `{ "request": <a one-object slice request>, "study": <a sliced study> }`
/// in, `{ "ok": true, "report", "surface" }` out, or `{ "ok": false,
/// "reason": <sentence> }`. The JSON is specified in
/// `docs/stress-sim-review-tasks.md`, SR-14.
pub fn study_json(body: &str) -> String {
    match study_value(body, Job::default(), &Watch::idle()) {
        Ok(value) => value.to_string(),
        Err(reason) => json!({ "ok": false, "reason": reason }).to_string(),
    }
}

/// [`study_json`] with a job and a watch, for a caller that cancels or
/// shows progress.
pub fn study_value(body: &str, job: Job, watch: &Watch) -> Result<Value, String> {
    let parsed: StudyBody =
        serde_json::from_str(body).map_err(|err| format!("The study could not be read. {err}"))?;
    let mut field = slice_field(&parsed.request, job, watch)?;
    let to_model = part_to_model(&parsed.request)?;
    field.header.frame = multiply(&to_model, &field.header.frame);
    let report = run(&field, &parsed.study).map_err(|err| err.message)?;
    let surface = draw_surface(&report, &parsed.study.card).unwrap_or_default();
    Ok(json!({
        "ok": true,
        "report": serde_json::to_value(&report).map_err(|e| e.to_string())?,
        "surface": {
            "triangles": surface.positions.len() / 3,
            "positionsB64": floats_b64(surface.positions.iter().flatten().copied()),
            "displacementB64": floats_b64(surface.displacement.iter().flatten().copied()),
            "vonMisesB64": floats_b64(surface.von_mises.iter().copied()),
            "safetyB64": floats_b64(surface.safety.iter().copied()),
        },
    }))
}
