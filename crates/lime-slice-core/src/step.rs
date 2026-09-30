//! STEP AP203/AP214 boundary-representation import.
//!
//! Tessellation is [truck](https://github.com/ricosjp/truck) (`truck-stepio` 0.3 and
//! `truck-meshalgo` 0.4): pure Rust, no Open CASCADE install. Truck reads planes,
//! cylinders, cones, spheres, tori, and NURBS, and returns coordinates in file units.
//! Units and assembly placements are applied here.
//!
//! Every closed solid is merged into one triangle mesh. A slicer job is one object,
//! so an assembly becomes one mesh with each instance transformed into the root frame.
//! Component definitions are not also emitted at the origin. Open shells, faceted
//! breps, and AP242 tessellated solids are rejected with a message instead of a panic.
//!
//! Chord tolerance is in millimetres of the part. It is converted into file units
//! after the length-unit scale is known, and clamped so it stays above truck's
//! internal 1e-6 floor.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use std::time::Instant;

use truck_meshalgo::prelude::PolygonMesh;
use truck_meshalgo::tessellation::RobustMeshableShape;
use truck_stepio::r#in::ruststep::ast::{DataSection, EntityInstance, Name, Parameter, Record};
use truck_stepio::r#in::ruststep::parser;
use truck_stepio::r#in::Table;

use crate::mesh::Mesh;

pub const STEP_TOLERANCE_DEFAULT_MM: f64 = 0.1;
pub const STEP_TOLERANCE_MIN_MM: f64 = 0.01;
pub const STEP_TOLERANCE_MAX_MM: f64 = 2.0;

const SHAPE_REPS: &[&str] = &[
    "ADVANCED_BREP_SHAPE_REPRESENTATION",
    "MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
    "FACETED_BREP_SHAPE_REPRESENTATION",
    "GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION",
    "SHAPE_REPRESENTATION",
];

/// `0` selects [`STEP_TOLERANCE_DEFAULT_MM`]. Any other value must sit in range.
pub fn resolve_step_tolerance(requested_mm: f64) -> Result<f64, String> {
    let tolerance = if requested_mm == 0.0 {
        STEP_TOLERANCE_DEFAULT_MM
    } else {
        requested_mm
    };
    if !tolerance.is_finite()
        || !(STEP_TOLERANCE_MIN_MM..=STEP_TOLERANCE_MAX_MM).contains(&tolerance)
    {
        return Err(format!(
            "STEP chord tolerance must be from {STEP_TOLERANCE_MIN_MM} to {STEP_TOLERANCE_MAX_MM} mm"
        ));
    }
    Ok(tolerance)
}

/// Wall-clock milliseconds inside one [`load_step`] call. Sums of per-shell
/// work can exceed the tessellation total when several shells are converted.
#[derive(Clone, Debug, Default)]
pub struct StepTimings {
    pub read_ms: f64,
    pub parse_ms: f64,
    pub index_ms: f64,
    pub table_ms: f64,
    pub topology_ms: f64,
    pub compress_ms: f64,
    pub tessellate_ms: f64,
    pub snap_ms: f64,
    pub ear_ms: f64,
    pub sliver_ms: f64,
    pub assembly_ms: f64,
    pub total_ms: f64,
    pub shells: usize,
    pub faces: usize,
    pub ear_faces: usize,
    pub triangles: usize,
    /// The mesh was cloned from an earlier successful load of these bytes.
    pub cache_hit: bool,
}

pub fn load_step(bytes: &[u8], tolerance_mm: f64) -> Result<Mesh, String> {
    Ok(load_step_timed(bytes, tolerance_mm)?.0)
}

/// [`load_step`] plus the stage clock. The mesh is the same either way.
///
/// The same file bytes and the same resolved chord tolerance reuse the mesh
/// from the first successful tessellation. `0` and [`STEP_TOLERANCE_DEFAULT_MM`]
/// share that entry. A failed parse is not stored, and the returned mesh is a
/// clone, so settling it does not change the cached one.
pub fn load_step_timed(bytes: &[u8], tolerance_mm: f64) -> Result<(Mesh, StepTimings), String> {
    let tol_mm = resolve_step_tolerance(tolerance_mm)?;
    if let Some(mesh) = step_cache_get(bytes, tol_mm) {
        CACHE_HITS.with(|hits| hits.set(hits.get() + 1));
        let timings = StepTimings {
            triangles: mesh.triangle_count(),
            cache_hit: true,
            ..StepTimings::default()
        };
        return Ok((mesh, timings));
    }
    CACHE_MISSES.with(|misses| misses.set(misses.get() + 1));
    let (mesh, timings) = tessellate_step(bytes, tol_mm)?;
    step_cache_put(bytes, tol_mm, &mesh);
    Ok((mesh, timings))
}

fn tessellate_step(bytes: &[u8], tol_mm: f64) -> Result<(Mesh, StepTimings), String> {
    let total = Instant::now();
    let mut timings = StepTimings::default();
    let read = Instant::now();
    let text = step_text(bytes)?;
    timings.read_ms = ms_since(read);
    if !text.to_ascii_uppercase().contains("ISO-10303-21") {
        return Err("STEP file is missing an ISO-10303-21 header".into());
    }
    let parse = Instant::now();
    let exchange = parser::parse(&text)
        .map_err(|err| format!("STEP file could not be parsed: {}", brief(&err.to_string())))?;
    timings.parse_ms = ms_since(parse);
    let section = exchange
        .data
        .first()
        .ok_or("STEP file has no DATA section")?;
    let index = Instant::now();
    let entities = index_entities(section);
    timings.index_ms = ms_since(index);
    let table_at = Instant::now();
    let table = Table::from_data_section(section);
    timings.table_ms = ms_since(table_at);
    let topo = Instant::now();
    let emits = collect_emits(&entities)?;
    timings.topology_ms = ms_since(topo);
    timings.shells = emits.len();
    let mut triangles = Vec::new();
    for emit in &emits {
        let raw = tessellate_shell(&table, emit.shell, tol_mm, emit.scale, &mut timings)?;
        let assemble = Instant::now();
        let flip = emit.flip ^ (emit.xform.det() < 0.0);
        for tri in raw {
            let mut mapped = tri.map(|p| {
                emit.xform
                    .apply([p[0] * emit.scale, p[1] * emit.scale, p[2] * emit.scale])
            });
            if flip {
                mapped.swap(1, 2);
            }
            if finite(&mapped) && !degenerate(&mapped) {
                triangles.push(mapped);
            }
        }
        timings.assembly_ms += ms_since(assemble);
    }
    if triangles.is_empty() {
        return Err("STEP file tessellated to an empty mesh".into());
    }
    timings.triangles = triangles.len();
    timings.total_ms = ms_since(total);
    Ok((Mesh { triangles }, timings))
}

fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn step_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("STEP file is empty".into());
    }
    if bytes.iter().take(64).any(|byte| *byte == 0) {
        return Err("STEP file is not text".into());
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(_) => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(80)]);
            if head.to_ascii_uppercase().contains("ISO-10303-21") {
                Ok(String::from_utf8_lossy(bytes).into_owned())
            } else {
                Err("STEP file is not text".into())
            }
        }
    }
}

fn brief(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    line.chars().take(180).collect()
}

struct Ent {
    records: Vec<(String, Vec<Parameter>)>,
}

fn index_entities(section: &DataSection) -> HashMap<u64, Ent> {
    let mut map = HashMap::new();
    for instance in &section.entities {
        match instance {
            EntityInstance::Simple { id, record } => {
                map.insert(
                    *id,
                    Ent {
                        records: vec![(record.name.clone(), record_params(record))],
                    },
                );
            }
            EntityInstance::Complex { id, subsuper } => {
                map.insert(
                    *id,
                    Ent {
                        records: subsuper
                            .0
                            .iter()
                            .map(|record| (record.name.clone(), record_params(record)))
                            .collect(),
                    },
                );
            }
        }
    }
    map
}

fn record_params(record: &Record) -> Vec<Parameter> {
    match &record.parameter {
        Parameter::List(items) => items.clone(),
        other => vec![other.clone()],
    }
}

fn rec<'a>(ent: &'a Ent, name: &str) -> Option<&'a [Parameter]> {
    ent.records
        .iter()
        .find(|(found, _)| found == name)
        .map(|(_, params)| params.as_slice())
}

fn has(ent: &Ent, name: &str) -> bool {
    ent.records.iter().any(|(found, _)| found == name)
}

struct Emit {
    shell: u64,
    flip: bool,
    scale: f64,
    xform: Xform,
}

struct Rel {
    parent: u64,
    child: u64,
    xform: Option<u64>,
}

struct World<'a> {
    entities: &'a HashMap<u64, Ent>,
    reps: &'a HashMap<u64, (Vec<u64>, u64)>,
    children: &'a HashMap<u64, Vec<(u64, Option<u64>)>>,
    voids: &'a HashSet<u64>,
}

fn collect_emits(entities: &HashMap<u64, Ent>) -> Result<Vec<Emit>, String> {
    let mut reps = HashMap::new();
    for (id, ent) in entities {
        if let Some(info) = shape_rep(ent) {
            reps.insert(*id, info);
        }
    }
    let mut children: HashMap<u64, Vec<(u64, Option<u64>)>> = HashMap::new();
    let mut child_reps = HashSet::new();
    for rel in relationships(entities) {
        children
            .entry(rel.parent)
            .or_default()
            .push((rel.child, rel.xform));
        child_reps.insert(rel.child);
    }
    let mut roots = Vec::new();
    for ent in entities.values() {
        if let Some(rep) = sdr_rep(ent, &reps) {
            if !child_reps.contains(&rep) && !roots.contains(&rep) {
                roots.push(rep);
            }
        }
    }
    if roots.is_empty() {
        let mut ids: Vec<u64> = reps
            .keys()
            .copied()
            .filter(|id| !child_reps.contains(id))
            .collect();
        ids.sort_unstable();
        roots = ids;
    }

    let mut voids = HashSet::new();
    let mut saw_open = false;
    for ent in entities.values() {
        if let Some(params) = rec(ent, "BREP_WITH_VOIDS") {
            if let Some(list) = params.get(2) {
                for id in refs(list) {
                    remember_void(entities, id, &mut voids);
                }
            }
        }
        if has(ent, "OPEN_SHELL") || has(ent, "ORIENTED_OPEN_SHELL") {
            saw_open = true;
        }
    }

    let world = World {
        entities,
        reps: &reps,
        children: &children,
        voids: &voids,
    };
    let mut out = Vec::new();
    let mut path = Vec::new();
    for root in roots {
        walk(root, &Xform::identity(), &mut path, &world, &mut out)?;
    }
    if !out.is_empty() {
        return Ok(out);
    }
    let mut closed: Vec<u64> = entities
        .iter()
        .filter(|(id, ent)| has(ent, "CLOSED_SHELL") && !voids.contains(id))
        .map(|(id, _)| *id)
        .collect();
    closed.sort_unstable();
    if !closed.is_empty() {
        let scale = any_length_scale(entities)?;
        return Ok(closed
            .into_iter()
            .map(|shell| Emit {
                shell,
                flip: false,
                scale,
                xform: Xform::identity(),
            })
            .collect());
    }
    if saw_open {
        return Err("STEP file has no closed solid. Open shells are not sliced.".into());
    }
    if entities.values().any(|ent| {
        has(ent, "FACETED_BREP")
            || has(ent, "TESSELLATED_SOLID")
            || has(ent, "TESSELLATED_SHAPE_REPRESENTATION")
    }) {
        return Err(
            "STEP faceted brep and AP242 tessellated solids are not supported. Export a boundary representation or an STL."
                .into(),
        );
    }
    Err("STEP file has no geometry to tessellate".into())
}

fn walk(
    rep: u64,
    xform: &Xform,
    path: &mut Vec<u64>,
    world: &World<'_>,
    out: &mut Vec<Emit>,
) -> Result<(), String> {
    if path.contains(&rep) {
        return Ok(());
    }
    let Some((items, ctx)) = world.reps.get(&rep) else {
        return Ok(());
    };
    path.push(rep);
    let scale = length_scale(world.entities, *ctx)?;
    let rel_children = world.children.get(&rep).cloned().unwrap_or_default();
    let rel_set: HashSet<u64> = rel_children.iter().map(|(child, _)| *child).collect();
    for item in items {
        if let Some((mapped, placed)) = mapped_item(world, *item, scale) {
            if !rel_set.contains(&mapped) {
                let next = xform.mul(&placed);
                walk(mapped, &next, path, world, out)?;
            }
            continue;
        }
        for shell in solid_shells(world.entities, *item) {
            if world.voids.contains(&shell.id) {
                continue;
            }
            out.push(Emit {
                shell: shell.id,
                flip: shell.flip,
                scale,
                xform: *xform,
            });
        }
    }
    for (child, xf) in rel_children {
        let placed = transform_between(world, xf, child, rep)?;
        let next = xform.mul(&placed);
        walk(child, &next, path, world, out)?;
    }
    path.pop();
    Ok(())
}

struct SolidShell {
    id: u64,
    flip: bool,
}

fn solid_shells(entities: &HashMap<u64, Ent>, item: u64) -> Vec<SolidShell> {
    let Some(ent) = entities.get(&item) else {
        return Vec::new();
    };
    if let Some(params) = rec(ent, "MANIFOLD_SOLID_BREP") {
        return shell_from(entities, params.get(1), false);
    }
    if let Some(params) = rec(ent, "BREP_WITH_VOIDS") {
        return shell_from(entities, params.get(1), false);
    }
    if has(ent, "CLOSED_SHELL") {
        return vec![SolidShell {
            id: item,
            flip: false,
        }];
    }
    if has(ent, "ORIENTED_CLOSED_SHELL") {
        return oriented_shell(entities, ent, false);
    }
    Vec::new()
}

fn shell_from(
    entities: &HashMap<u64, Ent>,
    param: Option<&Parameter>,
    flip: bool,
) -> Vec<SolidShell> {
    let Some(id) = param.and_then(as_entity) else {
        return Vec::new();
    };
    let Some(ent) = entities.get(&id) else {
        return vec![SolidShell { id, flip }];
    };
    if has(ent, "ORIENTED_CLOSED_SHELL") {
        return oriented_shell(entities, ent, flip);
    }
    if has(ent, "OPEN_SHELL") || has(ent, "ORIENTED_OPEN_SHELL") {
        return Vec::new();
    }
    vec![SolidShell { id, flip }]
}

fn oriented_shell(entities: &HashMap<u64, Ent>, ent: &Ent, outer_flip: bool) -> Vec<SolidShell> {
    let Some(params) = rec(ent, "ORIENTED_CLOSED_SHELL") else {
        return Vec::new();
    };
    let ori = params.get(3).and_then(as_bool).unwrap_or(true);
    let flip = outer_flip ^ !ori;
    shell_from(entities, params.get(2), flip)
}

fn remember_void(entities: &HashMap<u64, Ent>, id: u64, voids: &mut HashSet<u64>) {
    voids.insert(id);
    let Some(ent) = entities.get(&id) else {
        return;
    };
    if let Some(params) = rec(ent, "ORIENTED_CLOSED_SHELL") {
        if let Some(inner) = params.get(2).and_then(as_entity) {
            voids.insert(inner);
        }
    }
}

fn relationships(entities: &HashMap<u64, Ent>) -> Vec<Rel> {
    let mut rels = Vec::new();
    for ent in entities.values() {
        if !has(ent, "SHAPE_REPRESENTATION_RELATIONSHIP") {
            continue;
        }
        let Some(params) = rec(ent, "REPRESENTATION_RELATIONSHIP") else {
            continue;
        };
        let Some(child) = params.get(2).and_then(as_entity) else {
            continue;
        };
        let Some(parent) = params.get(3).and_then(as_entity) else {
            continue;
        };
        let xform = rec(ent, "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION")
            .and_then(|items| items.first())
            .and_then(as_entity);
        rels.push(Rel {
            parent,
            child,
            xform,
        });
    }
    rels
}

fn shape_rep(ent: &Ent) -> Option<(Vec<u64>, u64)> {
    for name in SHAPE_REPS {
        let Some(params) = rec(ent, name) else {
            continue;
        };
        if params.len() < 3 {
            continue;
        }
        let items = params.get(1).map(refs).unwrap_or_default();
        let ctx = as_entity(params.get(2)?)?;
        return Some((items, ctx));
    }
    None
}

fn sdr_rep(ent: &Ent, reps: &HashMap<u64, (Vec<u64>, u64)>) -> Option<u64> {
    let params = rec(ent, "SHAPE_DEFINITION_REPRESENTATION")?;
    let candidates = [
        params.get(1).and_then(as_entity),
        params.first().and_then(as_entity),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|id| reps.contains_key(id))
}

fn mapped_item(world: &World<'_>, item: u64, parent_scale: f64) -> Option<(u64, Xform)> {
    let ent = world.entities.get(&item)?;
    let params = rec(ent, "MAPPED_ITEM")?;
    let source = as_entity(params.get(1)?)?;
    let target = as_entity(params.get(2)?)?;
    let map_ent = world.entities.get(&source)?;
    let map_params = rec(map_ent, "REPRESENTATION_MAP")?;
    let origin = as_entity(map_params.first()?)?;
    let mapped = as_entity(map_params.get(1)?)?;
    if !world.reps.contains_key(&mapped) {
        return None;
    }
    let child_scale = rep_scale(world, mapped);
    let origin_pose = placement_pose(world.entities, origin, child_scale)?;
    let target_pose = placement_pose(world.entities, target, parent_scale)
        .or_else(|| operator_pose(world.entities, target, parent_scale))?;
    Some((mapped, target_pose.mul(&origin_pose.inverse())))
}

fn transform_between(
    world: &World<'_>,
    xf: Option<u64>,
    child: u64,
    parent: u64,
) -> Result<Xform, String> {
    let Some(id) = xf else {
        return Ok(Xform::identity());
    };
    let ent = world
        .entities
        .get(&id)
        .ok_or_else(|| format!("STEP assembly transform #{id} is missing"))?;
    let child_scale = rep_scale(world, child);
    let parent_scale = rep_scale(world, parent);
    if let Some(params) = rec(ent, "ITEM_DEFINED_TRANSFORMATION") {
        let child_id = params
            .get(2)
            .and_then(as_entity)
            .ok_or_else(|| "STEP assembly placement is missing a child axis".to_string())?;
        let parent_id = params
            .get(3)
            .and_then(as_entity)
            .ok_or_else(|| "STEP assembly placement is missing a parent axis".to_string())?;
        let child_pose =
            placement_pose(world.entities, child_id, child_scale).ok_or_else(|| {
                "STEP assembly child placement is not an AXIS2_PLACEMENT_3D".to_string()
            })?;
        let parent_pose =
            placement_pose(world.entities, parent_id, parent_scale).ok_or_else(|| {
                "STEP assembly parent placement is not an AXIS2_PLACEMENT_3D".to_string()
            })?;
        return Ok(parent_pose.mul(&child_pose.inverse()));
    }
    if let Some(pose) = operator_pose(world.entities, id, parent_scale) {
        return Ok(pose);
    }
    Err(
        "STEP assembly transform is not supported. Supported: item-defined axis placements and cartesian operators."
            .into(),
    )
}

fn rep_scale(world: &World<'_>, rep: u64) -> f64 {
    world
        .reps
        .get(&rep)
        .map(|(_, ctx)| length_scale(world.entities, *ctx).unwrap_or(1.0))
        .unwrap_or(1.0)
}

fn any_length_scale(entities: &HashMap<u64, Ent>) -> Result<f64, String> {
    let mut ids: Vec<u64> = entities
        .iter()
        .filter(|(_, ent)| has(ent, "GLOBAL_UNIT_ASSIGNED_CONTEXT"))
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    if let Some(id) = ids.first() {
        return length_scale(entities, *id);
    }
    Ok(1.0)
}

fn length_scale(entities: &HashMap<u64, Ent>, ctx: u64) -> Result<f64, String> {
    let Some(ent) = entities.get(&ctx) else {
        return Ok(1.0);
    };
    let Some(params) = rec(ent, "GLOBAL_UNIT_ASSIGNED_CONTEXT") else {
        return Ok(1.0);
    };
    let Some(list) = params.first() else {
        return Ok(1.0);
    };
    for id in refs(list) {
        if let Some(scale) = unit_to_mm(entities, id)? {
            if !scale.is_finite() || scale <= 0.0 {
                return Err("STEP length unit scale is not usable".into());
            }
            return Ok(scale);
        }
    }
    Ok(1.0)
}

fn unit_to_mm(entities: &HashMap<u64, Ent>, id: u64) -> Result<Option<f64>, String> {
    let Some(ent) = entities.get(&id) else {
        return Ok(None);
    };
    if let Some(params) = rec(ent, "SI_UNIT") {
        let unit = params.get(1).and_then(as_enum).unwrap_or_default();
        if unit != "METRE" {
            return Ok(None);
        }
        let prefix = params.first().and_then(as_enum).unwrap_or_default();
        return Ok(Some(prefix_mm(&prefix)?));
    }
    if let Some(params) = rec(ent, "CONVERSION_BASED_UNIT") {
        if !has(ent, "LENGTH_UNIT") {
            return Ok(None);
        }
        let factor = params
            .get(1)
            .and_then(as_entity)
            .ok_or_else(|| "STEP conversion-based unit is missing its factor".to_string())?;
        return Ok(Some(conversion_mm(entities, factor)?));
    }
    Ok(None)
}

fn conversion_mm(entities: &HashMap<u64, Ent>, factor_id: u64) -> Result<f64, String> {
    let ent = entities
        .get(&factor_id)
        .ok_or_else(|| "STEP length conversion factor is missing".to_string())?;
    let params = rec(ent, "LENGTH_MEASURE_WITH_UNIT")
        .or_else(|| rec(ent, "MEASURE_WITH_UNIT"))
        .ok_or_else(|| "STEP length conversion factor is not a measure with unit".to_string())?;
    let value = params
        .first()
        .and_then(measure_value)
        .ok_or_else(|| "STEP length conversion factor has no value".to_string())?;
    let unit = params
        .get(1)
        .and_then(as_entity)
        .ok_or_else(|| "STEP length conversion factor has no unit".to_string())?;
    let scale = unit_to_mm(entities, unit)?
        .ok_or_else(|| "STEP length conversion does not reference a length unit".to_string())?;
    if !value.is_finite() || value <= 0.0 || !scale.is_finite() || scale <= 0.0 {
        return Err("STEP length unit scale is not usable".into());
    }
    Ok(value * scale)
}

fn prefix_mm(prefix: &str) -> Result<f64, String> {
    let scale = match prefix {
        "" => 1000.0,
        "EXA" => 1e21,
        "PETA" => 1e18,
        "TERA" => 1e15,
        "GIGA" => 1e12,
        "MEGA" => 1e9,
        "KILO" => 1e6,
        "HECTO" => 1e5,
        "DECA" => 1e4,
        "DECI" => 100.0,
        "CENTI" => 10.0,
        "MILLI" => 1.0,
        "MICRO" => 1e-3,
        "NANO" => 1e-6,
        "PICO" => 1e-9,
        "FEMTO" => 1e-12,
        "ATTO" => 1e-15,
        other => return Err(format!("STEP length prefix '{other}' is not supported")),
    };
    Ok(scale)
}

fn placement_pose(entities: &HashMap<u64, Ent>, id: u64, scale: f64) -> Option<Xform> {
    let ent = entities.get(&id)?;
    let params = rec(ent, "AXIS2_PLACEMENT_3D")?;
    if params.len() >= 4 {
        let origin = point_of(entities, as_entity(params.get(1)?)?, scale)?;
        let z = direction_of(entities, params.get(2)).unwrap_or([0.0, 0.0, 1.0]);
        let x = direction_of(entities, params.get(3)).unwrap_or([1.0, 0.0, 0.0]);
        return Some(Xform::from_axes(origin, z, x));
    }
    let place = rec(ent, "PLACEMENT")?;
    let origin = point_of(entities, as_entity(place.get(1)?)?, scale)?;
    let z = direction_of(entities, params.first()).unwrap_or([0.0, 0.0, 1.0]);
    let x = direction_of(entities, params.get(1)).unwrap_or([1.0, 0.0, 0.0]);
    Some(Xform::from_axes(origin, z, x))
}

fn operator_pose(entities: &HashMap<u64, Ent>, id: u64, unit_scale: f64) -> Option<Xform> {
    let ent = entities.get(&id)?;
    let three = rec(ent, "CARTESIAN_TRANSFORMATION_OPERATOR_3D");
    let base = rec(ent, "CARTESIAN_TRANSFORMATION_OPERATOR");
    let (axis1, axis2, origin, scl, axis3) = if let Some(params) = three {
        if base.is_none() && params.len() >= 4 {
            (
                params.get(1),
                params.get(2),
                params.get(3)?,
                params.get(4).and_then(as_f64).unwrap_or(1.0),
                params.get(5),
            )
        } else {
            let base = base?;
            (
                base.get(1),
                base.get(2),
                base.get(3)?,
                base.get(4).and_then(as_f64).unwrap_or(1.0),
                params.first(),
            )
        }
    } else {
        let base = base?;
        (
            base.get(1),
            base.get(2),
            base.get(3)?,
            base.get(4).and_then(as_f64).unwrap_or(1.0),
            None,
        )
    };
    if !scl.is_finite() || scl == 0.0 {
        return None;
    }
    let origin = point_of(entities, as_entity(origin)?, unit_scale)?;
    let x = direction_of(entities, axis1).unwrap_or([1.0, 0.0, 0.0]);
    let y = direction_of(entities, axis2);
    let z = direction_of(entities, axis3);
    Some(Xform::from_axes_scaled(origin, x, y, z, scl))
}

fn point_of(entities: &HashMap<u64, Ent>, id: u64, scale: f64) -> Option<[f64; 3]> {
    let ent = entities.get(&id)?;
    let params = rec(ent, "CARTESIAN_POINT")?;
    let Parameter::List(coords) = params.get(1)? else {
        return None;
    };
    let x = coords.first().and_then(as_f64)? * scale;
    let y = coords.get(1).and_then(as_f64).unwrap_or(0.0) * scale;
    let z = coords.get(2).and_then(as_f64).unwrap_or(0.0) * scale;
    Some([x, y, z])
}

fn direction_of(entities: &HashMap<u64, Ent>, param: Option<&Parameter>) -> Option<[f64; 3]> {
    let id = as_entity(param?)?;
    let ent = entities.get(&id)?;
    let params = rec(ent, "DIRECTION")?;
    let Parameter::List(coords) = params.get(1)? else {
        return None;
    };
    Some([
        coords.first().and_then(as_f64).unwrap_or(0.0),
        coords.get(1).and_then(as_f64).unwrap_or(0.0),
        coords.get(2).and_then(as_f64).unwrap_or(0.0),
    ])
}

fn tessellate_shell(
    table: &Table,
    shell_id: u64,
    tol_mm: f64,
    scale: f64,
    timings: &mut StepTimings,
) -> Result<Vec<[[f64; 3]; 3]>, String> {
    let shell = table.shell.get(&shell_id).ok_or_else(|| {
        format!("STEP solid references shell #{shell_id}, which is not a tessellatable shell")
    })?;
    let step_faces = shell.cfs_faces.len();
    let compress = Instant::now();
    let compressed = table.to_compressed_shell(shell).map_err(|err| {
        format!(
            "STEP solid could not be converted: {}",
            brief(&err.to_string())
        )
    })?;
    timings.compress_ms += ms_since(compress);
    let kept = compressed.faces.len();
    if step_faces > 0 && kept < step_faces {
        return Err(format!(
            "STEP surface is not supported ({kept} of {step_faces} faces kept). Supported surfaces: plane, cylinder, cone, sphere, torus, and NURBS."
        ));
    }
    let tol_file = (tol_mm / scale).max(1e-5);
    let tess = Instant::now();
    let meshed = catch_unwind(AssertUnwindSafe(|| {
        compressed.robust_triangulation(tol_file)
    }))
    .map_err(|_| {
        "STEP tessellation failed on this solid. Try a larger chord tolerance, or export the part as STL."
            .to_string()
    })?;
    timings.tessellate_ms += ms_since(tess);
    timings.faces += meshed.faces.len();
    // Each wire is a closed loop in the surface's own orientation. Polyline
    // ends are pinned to the shared vertex: each curve evaluates its own end
    // a few nanometres off, and edges meeting at a corner would not join.
    let corner = |v: usize| {
        let p = meshed.vertices[v];
        [p.x, p.y, p.z]
    };
    let polyline = |index: usize, forward: bool| {
        let edge = &meshed.edges[index];
        let mut points: Vec<[f64; 3]> = edge.curve.0.iter().map(|p| [p.x, p.y, p.z]).collect();
        if let [first, .., last] = points.as_mut_slice() {
            *first = corner(edge.vertices.0);
            *last = corner(edge.vertices.1);
        }
        if !forward {
            points.reverse();
        }
        points
    };
    let mut triangles = Vec::new();
    for face in &meshed.faces {
        let loops: Vec<Vec<[f64; 3]>> = face
            .boundaries
            .iter()
            .map(|wire| closed_loop(wire.iter().map(|e| polyline(e.index, e.orientation))))
            .collect();
        let mut tris = match &face.surface {
            Some(mesh) => {
                let snap = Instant::now();
                let tris = snapped_triangles(mesh, &loops, tol_file);
                timings.snap_ms += ms_since(snap);
                tris
            }
            // Truck returns no mesh where a surface parameterization degenerates,
            // like the apex of a drill-point cone. The face is still bounded by
            // the same edge polylines its neighbours use, so it closes from them.
            None => match loops.as_slice() {
                [outline] => {
                    timings.ear_faces += 1;
                    let ear = Instant::now();
                    let tris = ear_clip(outline);
                    timings.ear_ms += ms_since(ear);
                    tris
                }
                _ => Vec::new(),
            },
        };
        if !face.orientation {
            for tri in &mut tris {
                tri.swap(1, 2);
            }
        }
        triangles.extend(tris.into_iter().filter(|t| !degenerate(t)));
    }
    let sliver = Instant::now();
    turn_flipped_slivers(&mut triangles);
    timings.sliver_ms += ms_since(sliver);
    if triangles.is_empty() && step_faces > 0 {
        return Err("STEP solid tessellated to an empty mesh at this chord tolerance".into());
    }
    Ok(triangles)
}

/// Edge polylines joined end to end, without the repeated joints or the
/// closing point.
fn closed_loop(edges: impl Iterator<Item = Vec<[f64; 3]>>) -> Vec<[f64; 3]> {
    let mut out: Vec<[f64; 3]> = Vec::new();
    for points in edges {
        for point in points {
            if out.last() != Some(&point) {
                out.push(point);
            }
        }
    }
    if out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    out
}

/// A face mesh's triangles with its boundary vertices moved onto the edge
/// polylines it was built from. Truck projects those polyline points onto each
/// surface separately, so the two faces along an edge land up to 0.05 mm apart
/// and the mesh leaks. A weld cannot close that safely: truck's own weld
/// measures its tolerance against the bounding box, and 0.025 of a 300 mm part
/// merged whole walls.
fn snapped_triangles(
    mesh: &PolygonMesh,
    loops: &[Vec<[f64; 3]>],
    reach: f64,
) -> Vec<[[f64; 3]; 3]> {
    let polys: Vec<Vec<usize>> = mesh
        .face_iter()
        .map(|face| face.iter().map(|v| v.pos).collect())
        .collect();
    let mut uses: HashMap<(usize, usize), u32> = HashMap::new();
    for poly in &polys {
        for k in 0..poly.len() {
            let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
            *uses.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    let rim: HashSet<usize> = uses
        .iter()
        .filter(|(_, n)| **n == 1)
        .flat_map(|(&(a, b), _)| [a, b])
        .collect();
    let anchors: Vec<[f64; 3]> = loops.iter().flatten().copied().collect();
    let reach2 = reach * reach;
    let positions: Vec<[f64; 3]> = mesh
        .positions()
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let p = [p.x, p.y, p.z];
            if !rim.contains(&i) {
                return p;
            }
            anchors
                .iter()
                .map(|a| (dist2(*a, p), *a))
                .filter(|(d, _)| *d <= reach2)
                .min_by(|x, y| x.0.total_cmp(&y.0))
                .map_or(p, |(_, a)| a)
        })
        .collect();
    let mut out = Vec::new();
    for poly in &polys {
        for pair in poly.get(1..).unwrap_or(&[]).windows(2) {
            out.push([positions[poly[0]], positions[pair[0]], positions[pair[1]]]);
        }
    }
    out
}

/// Truck winds an occasional near-collinear sliver backwards. Such a triangle
/// runs every one of its edges the same way as the neighbour across it, so a
/// slice through it reverses a stretch of the outline. Turn it over.
fn turn_flipped_slivers(triangles: &mut [[[f64; 3]; 3]]) {
    let key = |p: [f64; 3]| p.map(f64::to_bits);
    for _ in 0..4 {
        let mut runs: HashMap<([u64; 3], [u64; 3]), u32> = HashMap::new();
        for tri in triangles.iter() {
            for k in 0..3 {
                *runs
                    .entry((key(tri[k]), key(tri[(k + 1) % 3])))
                    .or_default() += 1;
            }
        }
        let against = |tri: &[[f64; 3]; 3]| {
            (0..3).all(|k| {
                let (a, b) = (key(tri[k]), key(tri[(k + 1) % 3]));
                runs.get(&(a, b)).copied().unwrap_or(0) > 1 && !runs.contains_key(&(b, a))
            })
        };
        let flipped: Vec<usize> = (0..triangles.len())
            .filter(|&i| against(&triangles[i]))
            .collect();
        if flipped.is_empty() {
            return;
        }
        for i in flipped {
            triangles[i].swap(1, 2);
        }
    }
}

/// Triangles covering one closed loop, by ear clipping in its best-fit plane.
fn ear_clip(ring: &[[f64; 3]]) -> Vec<[[f64; 3]; 3]> {
    if ring.len() < 3 {
        return Vec::new();
    }
    let mut normal = [0.0; 3];
    for (i, a) in ring.iter().enumerate() {
        let b = ring[(i + 1) % ring.len()];
        normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
        normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
        normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let Some(n) = normalize(normal) else {
        return Vec::new();
    };
    let helper = if n[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let Some(u) = normalize(cross(helper, n)) else {
        return Vec::new();
    };
    let v = cross(n, u);
    let flat: Vec<[f64; 2]> = ring.iter().map(|p| [dot(*p, u), dot(*p, v)]).collect();
    let turn = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let mut left: Vec<usize> = (0..ring.len()).collect();
    let mut out = Vec::new();
    while left.len() > 3 {
        let m = left.len();
        let ear = (0..m).find(|&k| {
            let (a, b, c) = (left[(k + m - 1) % m], left[k], left[(k + 1) % m]);
            turn(flat[a], flat[b], flat[c]) > 0.0
                && left.iter().all(|&q| {
                    q == a
                        || q == b
                        || q == c
                        || turn(flat[a], flat[b], flat[q]) < 0.0
                        || turn(flat[b], flat[c], flat[q]) < 0.0
                        || turn(flat[c], flat[a], flat[q]) < 0.0
                })
        });
        // A loop that folds over itself in its plane has no clean ear. Clip the
        // next corner anyway so the face still closes.
        let k = ear.unwrap_or(0);
        let (a, b, c) = (left[(k + m - 1) % m], left[k], left[(k + 1) % m]);
        out.push([ring[a], ring[b], ring[c]]);
        left.remove(k);
    }
    out.push([ring[left[0]], ring[left[1]], ring[left[2]]]);
    out
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    dot(d, d)
}

fn as_entity(param: &Parameter) -> Option<u64> {
    match param {
        Parameter::Ref(Name::Entity(id)) => Some(*id),
        Parameter::Typed { parameter, .. } => as_entity(parameter),
        _ => None,
    }
}

fn as_f64(param: &Parameter) -> Option<f64> {
    match param {
        Parameter::Real(value) => Some(*value),
        Parameter::Integer(value) => Some(*value as f64),
        Parameter::Typed { parameter, .. } => as_f64(parameter),
        Parameter::List(items) => items.first().and_then(as_f64),
        _ => None,
    }
}

fn as_enum(param: &Parameter) -> Option<String> {
    match param {
        Parameter::Enumeration(value) => Some(value.trim_matches('.').to_ascii_uppercase()),
        _ => None,
    }
}

fn as_bool(param: &Parameter) -> Option<bool> {
    match as_enum(param)?.as_str() {
        "T" | "TRUE" => Some(true),
        "F" | "FALSE" => Some(false),
        _ => None,
    }
}

fn measure_value(param: &Parameter) -> Option<f64> {
    match param {
        Parameter::Real(value) => Some(*value),
        Parameter::Integer(value) => Some(*value as f64),
        Parameter::Typed { parameter, .. } => measure_value(parameter),
        Parameter::List(items) => items.iter().find_map(measure_value),
        _ => None,
    }
}

fn refs(param: &Parameter) -> Vec<u64> {
    match param {
        Parameter::Ref(Name::Entity(id)) => vec![*id],
        Parameter::List(items) => items.iter().filter_map(as_entity).collect(),
        Parameter::Typed { parameter, .. } => refs(parameter),
        _ => Vec::new(),
    }
}

fn finite(tri: &[[f64; 3]; 3]) -> bool {
    tri.iter()
        .all(|point| point.iter().all(|coord| coord.is_finite()))
}

fn degenerate(tri: &[[f64; 3]; 3]) -> bool {
    let ax = tri[1][0] - tri[0][0];
    let ay = tri[1][1] - tri[0][1];
    let az = tri[1][2] - tri[0][2];
    let bx = tri[2][0] - tri[0][0];
    let by = tri[2][1] - tri[0][1];
    let bz = tri[2][2] - tri[0][2];
    let cx = ay * bz - az * by;
    let cy = az * bx - ax * bz;
    let cz = ax * by - ay * bx;
    cx * cx + cy * cy + cz * cz < 1e-16
}

#[derive(Clone, Copy)]
struct Xform {
    /// Column-major 4×4.
    m: [f64; 16],
}

impl Xform {
    fn identity() -> Self {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        Self { m }
    }

    fn from_columns(x: [f64; 3], y: [f64; 3], z: [f64; 3], origin: [f64; 3]) -> Self {
        Self {
            m: [
                x[0], x[1], x[2], 0.0, y[0], y[1], y[2], 0.0, z[0], z[1], z[2], 0.0, origin[0],
                origin[1], origin[2], 1.0,
            ],
        }
    }

    fn from_axes(origin: [f64; 3], z_in: [f64; 3], x_in: [f64; 3]) -> Self {
        let z = normalize(z_in).unwrap_or([0.0, 0.0, 1.0]);
        let mut x = sub(x_in, mul_s(z, dot(x_in, z)));
        if normalize(x).is_none() {
            let hint = if z[0].abs() < 0.9 {
                [1.0, 0.0, 0.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            x = sub(hint, mul_s(z, dot(hint, z)));
        }
        let x = normalize(x).unwrap_or([1.0, 0.0, 0.0]);
        let y = cross(z, x);
        Self::from_columns(x, y, z, origin)
    }

    fn from_axes_scaled(
        origin: [f64; 3],
        x_in: [f64; 3],
        y_in: Option<[f64; 3]>,
        z_in: Option<[f64; 3]>,
        scale: f64,
    ) -> Self {
        let x = normalize(x_in).unwrap_or([1.0, 0.0, 0.0]);
        let z = z_in.and_then(normalize).unwrap_or_else(|| {
            normalize(cross(x, y_in.unwrap_or([0.0, 1.0, 0.0]))).unwrap_or([0.0, 0.0, 1.0])
        });
        let y = y_in.and_then(normalize).unwrap_or_else(|| cross(z, x));
        Self::from_columns(mul_s(x, scale), mul_s(y, scale), mul_s(z, scale), origin)
    }

    fn mul(self, other: &Self) -> Self {
        let mut m = [0.0; 16];
        for col in 0..4 {
            for row in 0..4 {
                m[col * 4 + row] = (0..4)
                    .map(|k| self.m[k * 4 + row] * other.m[col * 4 + k])
                    .sum();
            }
        }
        Self { m }
    }

    fn inverse(self) -> Self {
        let r = self.m;
        let mut m = [0.0; 16];
        for col in 0..3 {
            for row in 0..3 {
                m[col * 4 + row] = r[row * 4 + col];
            }
        }
        let tx = r[12];
        let ty = r[13];
        let tz = r[14];
        m[12] = -(m[0] * tx + m[4] * ty + m[8] * tz);
        m[13] = -(m[1] * tx + m[5] * ty + m[9] * tz);
        m[14] = -(m[2] * tx + m[6] * ty + m[10] * tz);
        m[15] = 1.0;
        Self { m }
    }

    fn det(self) -> f64 {
        let r = self.m;
        r[0] * (r[5] * r[10] - r[6] * r[9]) - r[4] * (r[1] * r[10] - r[2] * r[9])
            + r[8] * (r[1] * r[6] - r[2] * r[5])
    }

    fn apply(self, point: [f64; 3]) -> [f64; 3] {
        let m = self.m;
        [
            m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12],
            m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13],
            m[2] * point[0] + m[6] * point[1] + m[10] * point[2] + m[14],
        ]
    }
}

fn normalize(v: [f64; 3]) -> Option<[f64; 3]> {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if length < 1e-12 {
        None
    } else {
        Some([v[0] / length, v[1] / length, v[2] / length])
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn mul_s(a: [f64; 3], scale: f64) -> [f64; 3] {
    [a[0] * scale, a[1] * scale, a[2] * scale]
}

const STEP_CACHE_CAP: usize = 8;

struct CachedStep {
    hash_a: u64,
    hash_b: u64,
    len: usize,
    tol_bits: u64,
    mesh: Mesh,
}

struct StepMeshCache {
    entries: Vec<CachedStep>,
}

static STEP_MESH_CACHE: Mutex<StepMeshCache> = Mutex::new(StepMeshCache {
    entries: Vec::new(),
});

thread_local! {
    static CACHE_HITS: Cell<u64> = const { Cell::new(0) };
    static CACHE_MISSES: Cell<u64> = const { Cell::new(0) };
}

/// Hits and misses counted on this thread. Other threads keep their own totals.
pub fn step_cache_stats() -> (u64, u64) {
    CACHE_HITS.with(|hits| CACHE_MISSES.with(|misses| (hits.get(), misses.get())))
}

/// Drop every cached mesh and zero this thread's hit and miss counts.
pub fn clear_step_cache() {
    STEP_MESH_CACHE
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .entries
        .clear();
    CACHE_HITS.with(|hits| hits.set(0));
    CACHE_MISSES.with(|misses| misses.set(0));
}

fn step_cache_get(bytes: &[u8], tol_mm: f64) -> Option<Mesh> {
    let (hash_a, hash_b, len, tol_bits) = step_cache_key(bytes, tol_mm);
    let mut cache = STEP_MESH_CACHE
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let pos = cache.entries.iter().position(|entry| {
        entry.hash_a == hash_a
            && entry.hash_b == hash_b
            && entry.len == len
            && entry.tol_bits == tol_bits
    })?;
    let mesh = cache.entries[pos].mesh.clone();
    if pos != 0 {
        let entry = cache.entries.remove(pos);
        cache.entries.insert(0, entry);
    }
    Some(mesh)
}

fn step_cache_put(bytes: &[u8], tol_mm: f64, mesh: &Mesh) {
    let (hash_a, hash_b, len, tol_bits) = step_cache_key(bytes, tol_mm);
    let mut cache = STEP_MESH_CACHE
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(pos) = cache.entries.iter().position(|entry| {
        entry.hash_a == hash_a
            && entry.hash_b == hash_b
            && entry.len == len
            && entry.tol_bits == tol_bits
    }) {
        cache.entries[pos].mesh = mesh.clone();
        if pos != 0 {
            let entry = cache.entries.remove(pos);
            cache.entries.insert(0, entry);
        }
        return;
    }
    cache.entries.insert(
        0,
        CachedStep {
            hash_a,
            hash_b,
            len,
            tol_bits,
            mesh: mesh.clone(),
        },
    );
    if cache.entries.len() > STEP_CACHE_CAP {
        cache.entries.pop();
    }
}

fn step_cache_key(bytes: &[u8], tol_mm: f64) -> (u64, u64, usize, u64) {
    let (hash_a, hash_b) = fnv_pair(bytes);
    (hash_a, hash_b, bytes.len(), tol_mm.to_bits())
}

fn fnv_pair(bytes: &[u8]) -> (u64, u64) {
    let mut hash_a = 0xcbf29ce484222325u64;
    let mut hash_b = 0x84222325cbf29ce4u64;
    for &byte in bytes {
        let value = u64::from(byte);
        hash_a ^= value;
        hash_a = hash_a.wrapping_mul(0x100000001b3);
        hash_b ^= value;
        hash_b = hash_b.wrapping_mul(0x100000001b3);
    }
    (hash_a, hash_b ^ (bytes.len() as u64))
}
