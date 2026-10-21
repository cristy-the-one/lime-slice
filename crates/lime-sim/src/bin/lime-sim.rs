//! Generated-beam solve for `sim_run` and `sim_field`.
//!
//! The study document stays node-based. This binary turns a box's faces into
//! those nodes, then calls the same factorisation the tests use. It does not
//! mesh an STL. A part without this box is refused before it is started.

use std::collections::HashSet;
use std::io::{self, Read, Write};

use lime_sim::material::von_mises;
use lime_sim::recipe::{Pattern, Recipe};
use lime_sim::study::{Card, Study, StudyHold, StudyLoad};
use lime_sim::{beam, solve, ElementKind, Mesh, SimError};

const FIELDS: &[&str] = &[
    "displacement",
    "von_mises",
    "stress",
    "safety_factor",
    "element_error",
];

fn main() {
    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        finish(fail("The study could not be read."));
    }
    let job: Job = match serde_json::from_str(&raw) {
        Ok(job) => job,
        Err(_) => finish(fail("The study could not be read.")),
    };
    finish(match job.op.as_str() {
        "run" => run(&job),
        "field" => field(&job),
        _ => fail("This study is not in this version."),
    });
}

fn finish(body: serde_json::Value) -> ! {
    let mut out = serde_json::to_string(&body).unwrap_or_else(|_| {
        r#"{"ok":false,"reason":"The stress solver did not finish."}"#.to_string()
    });
    out.push('\n');
    let _ = io::stdout().write_all(out.as_bytes());
    std::process::exit(0);
}

fn fail(reason: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "reason": reason })
}

fn fail_err(err: SimError) -> serde_json::Value {
    fail(&err.message)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    op: String,
    length: f64,
    width: f64,
    height: f64,
    edge: f64,
    #[serde(default)]
    holds: Vec<JobHold>,
    #[serde(default)]
    loads: Vec<JobLoad>,
    card: Card,
    #[serde(default = "up_axis")]
    build_axis: [f64; 3],
    #[serde(default)]
    gravity: bool,
    #[serde(default)]
    walls: Option<u32>,
    #[serde(default)]
    infill: Option<f64>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default = "one_scale")]
    load_scale: f64,
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    points: Option<Vec<[f64; 3]>>,
    #[serde(default)]
    stride: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    cursor: Option<usize>,
    #[serde(default)]
    face: Option<usize>,
    #[serde(default, rename = "box")]
    region: Option<JobBox>,
}

fn up_axis() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}
fn one_scale() -> f64 {
    1.0
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum JobHold {
    Bed,
    Faces { faces: Vec<usize> },
    Plane { normal: [f64; 3], origin: [f64; 3] },
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum JobLoad {
    Force {
        faces: Vec<usize>,
        magnitude: f64,
        direction: [f64; 3],
    },
    Pressure {
        faces: Vec<usize>,
        magnitude: f64,
        direction: [f64; 3],
    },
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobBox {
    min: [f64; 3],
    max: [f64; 3],
}

struct Solved {
    mesh: Mesh,
    solution: lime_sim::Solution,
}

fn prepare(job: &Job) -> Result<Solved, serde_json::Value> {
    if !(job.load_scale.is_finite() && job.load_scale > 0.0) {
        return Err(fail("The load scale has to be positive."));
    }
    let mesh = beam(job.length, job.width, job.height, job.edge, ElementKind::Tet10).map_err(fail_err)?;
    let study = study_of(job, &mesh)?;
    let solution = solve(&study, &mesh).map_err(fail_err)?;
    Ok(Solved { mesh, solution })
}

fn run(job: &Job) -> serde_json::Value {
    let solved = match prepare(job) {
        Ok(solved) => solved,
        Err(err) => return err,
    };
    let mut body = serde_json::to_value(solved.solution.summary()).unwrap_or_else(|_| fail("The stress solver did not finish."));
    if let Some(map) = body.as_object_mut() {
        map.insert("ok".into(), serde_json::json!(true));
    }
    body
}

fn field(job: &Job) -> serde_json::Value {
    let name = job.field.as_deref().unwrap_or("");
    if !FIELDS.contains(&name) {
        let names = FIELDS.join(", ");
        return fail(&format!("Unknown field. This result has {names}."));
    }
    let solved = match prepare(job) {
        Ok(solved) => solved,
        Err(err) => return err,
    };
    let indexes = match indexes_of(job, &solved.mesh) {
        Ok(indexes) => indexes,
        Err(err) => return err,
    };
    let rows = indexes
        .iter()
        .filter_map(|index| row_of(name, *index, &solved))
        .collect::<Vec<_>>();
    let limit = job.limit.unwrap_or(20).clamp(1, 100);
    let start = job.cursor.unwrap_or(0);
    let page = rows.iter().skip(start).take(limit).cloned().collect::<Vec<_>>();
    let next = start.saturating_add(limit);
    let mut body = serde_json::json!({
        "ok": true,
        "field": name,
        "rows": page,
    });
    if next < rows.len() {
        body["nextCursor"] = serde_json::Value::String(next.to_string());
    }
    body
}

fn row_of(name: &str, index: usize, solved: &Solved) -> Option<serde_json::Value> {
    let (at, value) = match name {
        "displacement" => {
            let u = *solved.solution.displacement.get(index)?;
            let at = *solved.mesh.nodes.get(index)?;
            (at, (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt())
        }
        "von_mises" => (*solved.mesh.nodes.get(index)?, *solved.solution.von_mises.get(index)?),
        "safety_factor" => (*solved.mesh.nodes.get(index)?, *solved.solution.safety.get(index)?),
        "element_error" => (
            centroid(&solved.mesh, index)?,
            *solved.solution.element_error.get(index)?,
        ),
        "stress" => {
            let sample = solved.solution.gauss.get(index)?;
            (sample.xyz, von_mises(&sample.stress))
        }
        _ => return None,
    };
    Some(serde_json::json!({ "at": at, "value": value }))
}

fn indexes_of(job: &Job, mesh: &Mesh) -> Result<Vec<usize>, serde_json::Value> {
    if let Some(points) = &job.points {
        return Ok(points.iter().map(|point| nearest(&mesh.nodes, *point)).collect());
    }
    if let Some(region) = &job.region {
        return Ok(mesh
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, point)| inside(**point, region.min, region.max))
            .map(|(index, _)| index)
            .collect());
    }
    if let Some(face) = job.face {
        let nodes = face_nodes(mesh, job, face).map_err(fail_err)?;
        return Ok(nodes);
    }
    if let Some(stride) = job.stride {
        if stride == 0 {
            return Err(fail("A stride starts at 1."));
        }
        return Ok((0..mesh.nodes.len()).step_by(stride).collect());
    }
    Err(fail("Name points, a box, a face, or a stride."))
}

fn study_of(job: &Job, mesh: &Mesh) -> Result<Study, serde_json::Value> {
    let mut seen = HashSet::new();
    let mut holds = Vec::new();
    let mut fix = |node: usize| {
        if seen.insert(node) {
            holds.push(StudyHold::Fixed { node });
        }
    };
    for hold in &job.holds {
        match hold {
            JobHold::Bed => {
                for (index, point) in mesh.nodes.iter().enumerate() {
                    if point[2].abs() <= 0.05 {
                        fix(index);
                    }
                }
            }
            JobHold::Faces { faces } => {
                for face in faces {
                    for node in face_nodes(mesh, job, *face).map_err(fail_err)? {
                        fix(node);
                    }
                }
            }
            JobHold::Plane { normal, origin } => {
                let Some(unit) = unit_of(*normal) else {
                    continue;
                };
                for (index, point) in mesh.nodes.iter().enumerate() {
                    let dist = (point[0] - origin[0]) * unit[0]
                        + (point[1] - origin[1]) * unit[1]
                        + (point[2] - origin[2]) * unit[2];
                    if dist.abs() <= 0.05 {
                        fix(index);
                    }
                }
            }
        }
    }
    if holds.is_empty() {
        return Err(fail("This part is not held. Fix a face, or the bed."));
    }
    let mut loads = Vec::new();
    for load in &job.loads {
        match load {
            JobLoad::Force { faces, magnitude, direction } => {
                let dir = unit_of(*direction).unwrap_or([0.0, 0.0, -1.0]);
                let mut nodes = Vec::new();
                for face in faces {
                    nodes.extend(face_nodes(mesh, job, *face).map_err(fail_err)?);
                }
                nodes.sort_unstable();
                nodes.dedup();
                if nodes.is_empty() {
                    return Err(fail("That face is not on this beam."));
                }
                let share = magnitude * job.load_scale / nodes.len() as f64;
                for node in nodes {
                    loads.push(StudyLoad::Force {
                        node,
                        force: [dir[0] * share, dir[1] * share, dir[2] * share],
                    });
                }
            }
            JobLoad::Pressure { faces, magnitude, direction } => {
                let dir = unit_of(*direction).unwrap_or([0.0, 0.0, -1.0]);
                let traction = [
                    dir[0] * magnitude * job.load_scale,
                    dir[1] * magnitude * job.load_scale,
                    dir[2] * magnitude * job.load_scale,
                ];
                for face in faces {
                    for nodes in face_triangles(mesh, job, *face).map_err(fail_err)? {
                        loads.push(StudyLoad::Traction { nodes, traction });
                    }
                }
            }
        }
    }
    let mut recipe = Recipe::solid();
    if let Some(walls) = job.walls {
        recipe.walls = walls;
    }
    if let Some(infill) = job.infill {
        recipe.infill = infill.clamp(0.0, 1.0);
        recipe.reinforced_infill = recipe.infill;
    }
    if let Some(name) = &job.pattern {
        let pattern = pattern_of(name)?;
        recipe.pattern_measured = pattern.measured();
        recipe.pattern = pattern;
    }
    Ok(Study {
        format: "lime-sim-1".into(),
        linear: true,
        element: "tet10".into(),
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        analysis: "static".into(),
        build_axis: job.build_axis,
        h_mm: job.edge,
        gravity: job.gravity,
        temperature_c: None,
        fibre_axis: None,
        card: job.card.clone(),
        recipe,
        steps: vec![lime_sim::study::Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-8,
        }],
        post_steps: Vec::new(),
        holds,
        loads,
    })
}

fn pattern_of(name: &str) -> Result<Pattern, serde_json::Value> {
    match name {
        "lines" => Ok(Pattern::Lines),
        "grid" => Ok(Pattern::Grid),
        "gyroid" => Ok(Pattern::Gyroid),
        "lightning" => Ok(Pattern::Lightning),
        other => Err(fail(&format!("{other} is not in this version."))),
    }
}

/// Corner order, then the three mid-edge nodes, matching `traction_forces`.
const TET_FACES: [[usize; 6]; 4] = [
    [0, 1, 2, 4, 5, 6],
    [0, 1, 3, 4, 8, 7],
    [1, 2, 3, 5, 9, 8],
    [0, 2, 3, 6, 9, 7],
];

fn on_box(point: [f64; 3], face: usize, length: f64, width: f64, height: f64) -> bool {
    let tol = 1e-6 * length.max(width).max(height).max(1.0);
    match face {
        0 => point[0].abs() <= tol,
        1 => (point[0] - length).abs() <= tol,
        2 => point[1].abs() <= tol,
        3 => (point[1] - width).abs() <= tol,
        4 => point[2].abs() <= tol,
        5 => (point[2] - height).abs() <= tol,
        _ => false,
    }
}

fn face_nodes(mesh: &Mesh, job: &Job, face: usize) -> Result<Vec<usize>, SimError> {
    if face > 5 {
        return Err(SimError::new("That face is not on this beam."));
    }
    let mut nodes = Vec::new();
    for (index, point) in mesh.nodes.iter().enumerate() {
        if on_box(*point, face, job.length, job.width, job.height) {
            nodes.push(index);
        }
    }
    Ok(nodes)
}

fn face_triangles(mesh: &Mesh, job: &Job, face: usize) -> Result<Vec<Vec<usize>>, SimError> {
    if face > 5 {
        return Err(SimError::new("That face is not on this beam."));
    }
    let mut out = Vec::new();
    for cell in &mesh.elements {
        if cell.nodes.len() < 10 {
            continue;
        }
        for local in TET_FACES {
            let corners = [cell.nodes[local[0]], cell.nodes[local[1]], cell.nodes[local[2]]];
            let on = corners.iter().all(|node| {
                on_box(mesh.nodes[*node], face, job.length, job.width, job.height)
            });
            if !on {
                continue;
            }
            out.push(local.iter().map(|slot| cell.nodes[*slot]).collect());
        }
    }
    Ok(out)
}

fn centroid(mesh: &Mesh, element: usize) -> Option<[f64; 3]> {
    let cell = mesh.elements.get(element)?;
    let count = cell.nodes.len().min(4);
    if count == 0 {
        return None;
    }
    let mut at = [0.0; 3];
    for slot in 0..count {
        let point = mesh.nodes[cell.nodes[slot]];
        at[0] += point[0];
        at[1] += point[1];
        at[2] += point[2];
    }
    let scale = count as f64;
    Some([at[0] / scale, at[1] / scale, at[2] / scale])
}

fn nearest(nodes: &[[f64; 3]], point: [f64; 3]) -> usize {
    let mut best = 0;
    let mut best_d = f64::MAX;
    for (index, node) in nodes.iter().enumerate() {
        let d = (node[0] - point[0]).powi(2) + (node[1] - point[1]).powi(2) + (node[2] - point[2]).powi(2);
        if d < best_d {
            best_d = d;
            best = index;
        }
    }
    best
}

fn inside(point: [f64; 3], min: [f64; 3], max: [f64; 3]) -> bool {
    point.iter().enumerate().all(|(axis, value)| *value >= min[axis] - 1e-9 && *value <= max[axis] + 1e-9)
}

fn unit_of(value: [f64; 3]) -> Option<[f64; 3]> {
    let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
    if length <= 1e-12 {
        None
    } else {
        Some([value[0] / length, value[1] / length, value[2] / length])
    }
}
