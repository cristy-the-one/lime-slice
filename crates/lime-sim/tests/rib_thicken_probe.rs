//! D-study probe. Not part of the planner: every number comes from
//! `plan_ribs` as it ships, plus solves of a thickness edit on a copy of
//! the mesh. The one-case snapshots stay on `rib_multi_load` and are run
//! with this file present and the planner sources untouched.
//!
//! A region is the triangles whose membrane energy exceeds their bending
//! energy on the bare wall. Thickening it adds the same amount to every
//! vertex of those triangles. Volume is the change in (area × mean corner
//! thickness) over the whole mesh, so a vertex shared with an untouched
//! triangle is counted on that triangle too.

mod shell_common;

use std::time::Instant;

use lime_sim::shell::planner::{plan_ribs, Goal, Holds, RibPlan, RibPlanRequest, RibRules};
use lime_sim::shell::{ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions};
use shell_common::{cylinder_segment, material};

const E: f64 = 2000.0;
const NU: f64 = 0.35;
const DT_CAP: f64 = 8.0;

struct Solve {
    compliance: f64,
    membrane: f64,
    bending: f64,
    /// Strain energy of each triangle.
    energy: Vec<f64>,
    /// Triangles with membrane energy above bending energy.
    membrane_tris: Vec<bool>,
    factor_s: f64,
    solve_s: f64,
    assemble_s: f64,
    analyse_s: f64,
    wall_s: f64,
}

fn pressure(_mesh: &ShellMesh, triangles: &[u32]) -> Vec<Vec<ShellLoad>> {
    vec![vec![ShellLoad::Pressure {
        triangles: triangles.to_vec(),
        pressure: lime_sim::shell::planner::DEFAULT_PRESSURE,
    }]]
}

fn tri_area(mesh: &ShellMesh, tri: [u32; 3]) -> f64 {
    let a = mesh.vertices[tri[0] as usize];
    let b = mesh.vertices[tri[1] as usize];
    let c = mesh.vertices[tri[2] as usize];
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    0.5 * (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
}

fn solve(mesh: &ShellMesh, holds: &[ShellHold], cases: &[Vec<ShellLoad>]) -> Solve {
    let started = Instant::now();
    let mut model = ShellModel::new(
        mesh.clone(),
        material(E, NU),
        holds,
        ShellOptions::default(),
    )
    .unwrap();
    model.set_threads(1);
    let result = model.solve(&cases[0]).unwrap();
    let t = model.timings();
    let membrane_tris: Vec<bool> = result
        .elements
        .iter()
        .map(|e| e.membrane_energy > e.bending_energy)
        .collect();
    Solve {
        compliance: result.compliance,
        membrane: result.elements.iter().map(|e| e.membrane_energy).sum(),
        bending: result.elements.iter().map(|e| e.bending_energy).sum(),
        energy: result
            .elements
            .iter()
            .map(|e| e.membrane_energy + e.bending_energy)
            .collect(),
        membrane_tris,
        factor_s: t.factor,
        solve_s: t.solve,
        assemble_s: t.assemble_shell,
        analyse_s: t.analyse,
        wall_s: started.elapsed().as_secs_f64(),
    }
}

fn thicken(mesh: &ShellMesh, region: &[bool], dt: f64) -> ShellMesh {
    let mut out = mesh.clone();
    let mut hit = vec![false; mesh.vertices.len()];
    for (tri, on) in mesh.triangles.iter().zip(region) {
        if *on {
            for v in tri {
                hit[*v as usize] = true;
            }
        }
    }
    for (t, on) in out.thickness.iter_mut().zip(hit) {
        if on {
            *t += dt;
        }
    }
    out
}

fn added_volume(base: &ShellMesh, now: &ShellMesh) -> f64 {
    base.triangles
        .iter()
        .map(|tri| {
            let area = tri_area(base, *tri);
            let mean =
                |m: &ShellMesh| tri.iter().map(|&v| m.thickness[v as usize]).sum::<f64>() / 3.0;
            area * (mean(now) - mean(base))
        })
        .sum()
}

struct Search {
    dt: f64,
    volume: f64,
    compliance: f64,
    factor: f64,
    solves: u32,
    seconds: f64,
    reached: bool,
}

/// Smallest dt in `[0, DT_CAP]` whose compliance is at or under `target`.
fn search_dt(
    mesh: &ShellMesh,
    region: &[bool],
    holds: &[ShellHold],
    cases: &[Vec<ShellLoad>],
    target: f64,
    bare: f64,
) -> Search {
    let started = Instant::now();
    let mut solves = 0u32;
    let eval = |dt: f64, solves: &mut u32| {
        *solves += 1;
        let got = solve(&thicken(mesh, region, dt), holds, cases);
        got.compliance
    };
    let c_cap = eval(DT_CAP, &mut solves);
    if c_cap > target {
        return Search {
            dt: DT_CAP,
            volume: added_volume(mesh, &thicken(mesh, region, DT_CAP)),
            compliance: c_cap,
            factor: bare / c_cap,
            solves,
            seconds: started.elapsed().as_secs_f64(),
            reached: false,
        };
    }
    let mut lo = 0.0;
    let mut hi = DT_CAP;
    for _ in 0..16 {
        let mid = 0.5 * (lo + hi);
        if eval(mid, &mut solves) > target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let compliance = eval(hi, &mut solves);
    Search {
        dt: hi,
        volume: added_volume(mesh, &thicken(mesh, region, hi)),
        compliance,
        factor: bare / compliance,
        solves,
        seconds: started.elapsed().as_secs_f64(),
        reached: true,
    }
}

fn all_on(mesh: &ShellMesh) -> Vec<bool> {
    vec![true; mesh.triangles.len()]
}

/// The quarter of triangles with the most strain energy. Ties break toward
/// the lower index, so the set is fixed.
fn hot_quarter(energy: &[f64]) -> Vec<bool> {
    let mut order: Vec<usize> = (0..energy.len()).collect();
    order.sort_by(|&a, &b| energy[b].partial_cmp(&energy[a]).unwrap().then(a.cmp(&b)));
    let keep = (energy.len() / 4).max(1);
    let mut on = vec![false; energy.len()];
    for i in &order[..keep] {
        on[*i] = true;
    }
    on
}

fn report_plan(plan: &RibPlan) {
    let th = plan.thickening.as_ref();
    let grid = plan.grid.as_ref();
    eprintln!(
        "PLAN ribs {} vol {:.4} factor {:.6} goal {} not_better {} solves {} plan_s {:.3} baseline_s {:.3}",
        plan.ribs.len(),
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        plan.goal_met,
        plan.not_better_than_baseline,
        plan.stats.solves,
        plan.stats.seconds.total,
        plan.stats.seconds.baselines,
    );
    match th {
        Some(t) => eprintln!(
            "UNIFORM dt {:.6} vol {:.4} solves {}",
            t.added_thickness_mm, t.added_volume_mm3, t.solves
        ),
        None => eprintln!("UNIFORM none"),
    }
    match grid {
        Some(g) => eprintln!(
            "GRID vol {:?} pitch {:?} lines {:?} grid_vol {:.4} compliance {:.6} solves {}",
            g.volume_mm3, g.pitch_mm, g.lines, g.grid_volume_mm3, g.compliance, g.solves
        ),
        None => eprintln!("GRID none"),
    }
}

fn vertex_at(vertices: &mut Vec<[f64; 3]>, p: [f64; 3]) -> u32 {
    for (i, v) in vertices.iter().enumerate() {
        if (v[0] - p[0]).abs() < 1e-9 && (v[1] - p[1]).abs() < 1e-9 && (v[2] - p[2]).abs() < 1e-9 {
            return i as u32;
        }
    }
    vertices.push(p);
    (vertices.len() - 1) as u32
}

fn push_quad(triangles: &mut Vec<[u32; 3]>, a: u32, b: u32, c: u32, d: u32) {
    triangles.push([a, b, c]);
    triangles.push([a, c, d]);
}

/// Coarse stand-in for the folded cover: a 40 × 24 floor, walls 12 mm high,
/// open top. Floor pressure only, top rim clamped. Centre-lines, thickness 2.
fn open_box() -> (ShellMesh, Vec<u32>, Vec<ShellHold>) {
    let (nx, ny, nz) = (8usize, 5usize, 3usize);
    let (lx, ly, h) = (40.0, 24.0, 12.0);
    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    let mut floor = Vec::new();
    let id = |i: usize, j: usize, k: usize| {
        [
            lx * i as f64 / nx as f64,
            ly * j as f64 / ny as f64,
            h * k as f64 / nz as f64,
        ]
    };
    for j in 0..ny {
        for i in 0..nx {
            let a = vertex_at(&mut vertices, id(i, j, 0));
            let b = vertex_at(&mut vertices, id(i + 1, j, 0));
            let c = vertex_at(&mut vertices, id(i + 1, j + 1, 0));
            let d = vertex_at(&mut vertices, id(i, j + 1, 0));
            floor.push(triangles.len() as u32);
            push_quad(&mut triangles, a, b, c, d);
            floor.push(triangles.len() as u32 - 1);
        }
    }
    let wall = |vertices: &mut Vec<[f64; 3]>,
                triangles: &mut Vec<[u32; 3]>,
                nseg: usize,
                at: &dyn Fn(usize, usize) -> [f64; 3]| {
        for s in 0..nseg {
            for k in 0..nz {
                let a = vertex_at(vertices, at(s, k));
                let b = vertex_at(vertices, at(s + 1, k));
                let c = vertex_at(vertices, at(s + 1, k + 1));
                let d = vertex_at(vertices, at(s, k + 1));
                push_quad(triangles, a, b, c, d);
            }
        }
    };
    wall(&mut vertices, &mut triangles, nx, &|s, k| id(s, 0, k));
    wall(&mut vertices, &mut triangles, nx, &|s, k| id(s, ny, k));
    wall(&mut vertices, &mut triangles, ny, &|s, k| id(0, s, k));
    wall(&mut vertices, &mut triangles, ny, &|s, k| id(nx, s, k));
    let holds = vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| (p[2] - h).abs() < 1e-9)
        .map(|(i, _)| ShellHold::clamped(i as u32))
        .collect();
    let mesh = ShellMesh {
        thickness: vec![2.0; vertices.len()],
        vertices,
        triangles,
    };
    (mesh, floor, holds)
}

fn holds_of(mesh: &ShellMesh, which: &Holds) -> Vec<ShellHold> {
    match which {
        Holds::Given(h) => h.clone(),
        Holds::AllBoundaryClamped => lime_sim::shell::planner::boundary_vertices(mesh)
            .into_iter()
            .map(ShellHold::clamped)
            .collect(),
        Holds::OuterBoundaryClamped => panic!("not used"),
    }
}

fn straight_edges(div: [usize; 2]) -> Vec<ShellHold> {
    let (nx, ny) = (div[0], div[1]);
    let mut holds = Vec::new();
    for j in [0, ny] {
        for i in 0..=nx {
            holds.push(ShellHold::clamped((i + (nx + 1) * j) as u32));
        }
    }
    holds
}

struct Case {
    name: &'static str,
    mesh: ShellMesh,
    holds: Holds,
    /// `None` is pressure on every triangle.
    loaded: Option<Vec<u32>>,
    goal: Goal,
    rules: RibRules,
}

fn run_case(case: &Case) {
    eprintln!(
        "== {} tris {} verts {}",
        case.name,
        case.mesh.triangles.len(),
        case.mesh.vertices.len()
    );
    let loaded: Vec<u32> = case
        .loaded
        .clone()
        .unwrap_or_else(|| (0..case.mesh.triangles.len() as u32).collect());
    let cases = pressure(&case.mesh, &loaded);
    let holds = holds_of(&case.mesh, &case.holds);
    let bare = solve(&case.mesh, &holds, &cases);
    let share = bare.membrane / (bare.membrane + bare.bending);
    let n_mem = bare.membrane_tris.iter().filter(|t| **t).count();
    let free = 6 * case.mesh.vertices.len() - 6 * holds.len();
    eprintln!(
        "BARE C {:.8} membrane_share {:.4} membrane_tris {} / {} free_dofs {}",
        bare.compliance,
        share,
        n_mem,
        case.mesh.triangles.len(),
        free
    );
    eprintln!(
        "STEP assemble {:.4} analyse {:.4} factor {:.4} rhs {:.4} wall {:.4}",
        bare.assemble_s, bare.analyse_s, bare.factor_s, bare.solve_s, bare.wall_s
    );
    let again = thicken(&case.mesh, &bare.membrane_tris, 0.5);
    let second = solve(&again, &holds, &cases);
    eprintln!(
        "REBUILD +0.5mm on membrane verts: assemble {:.4} analyse {:.4} factor {:.4} rhs {:.4} wall {:.4}",
        second.assemble_s, second.analyse_s, second.factor_s, second.solve_s, second.wall_s
    );

    let mut req = RibPlanRequest::new(case.mesh.clone(), material(E, NU));
    req.holds = case.holds.clone();
    req.goal = case.goal;
    req.rules = case.rules.clone();
    if case.loaded.is_some() {
        req.load_cases = cases.clone();
    }
    let plan = plan_ribs(&req).unwrap();
    report_plan(&plan);
    for (i, rib) in plan.ribs.iter().enumerate() {
        eprintln!(
            "RIB {i} vol {:.4} gain {:.6} energy_share {:.4}",
            rib.volume_mm3, rib.gain, rib.energy_share
        );
    }

    let region = if n_mem >= 4 {
        bare.membrane_tris.clone()
    } else {
        eprintln!("REGION fallback: fewer than 4 membrane triangles, thickening every triangle");
        all_on(&case.mesh)
    };
    let target = plan.ribbed.compliance;
    eprintln!(
        "TARGET plan_bare {:.8} plan_ribbed {:.8} my_bare {:.8}",
        plan.bare.compliance, plan.ribbed.compliance, bare.compliance
    );
    let hot = hot_quarter(&bare.energy);
    let hot_e: f64 = bare
        .energy
        .iter()
        .zip(&hot)
        .filter(|(_, on)| **on)
        .map(|(e, _)| e)
        .sum();
    let all_e: f64 = bare.energy.iter().sum();
    eprintln!(
        "HOT tris {} energy_share {:.4}",
        hot.iter().filter(|t| **t).count(),
        if all_e > 0.0 { hot_e / all_e } else { 0.0 }
    );
    let hot_search = search_dt(&case.mesh, &hot, &holds, &cases, target, bare.compliance);
    eprintln!(
        "HOT reached {} dt {:.4} vol {:.4} C {:.8} factor {:.6} solves {} s {:.3}",
        hot_search.reached,
        hot_search.dt,
        hot_search.volume,
        hot_search.compliance,
        hot_search.factor,
        hot_search.solves,
        hot_search.seconds
    );
    let local = search_dt(&case.mesh, &region, &holds, &cases, target, bare.compliance);
    eprintln!(
        "LOCAL reached {} dt {:.4} vol {:.4} factor {:.6} solves {} s {:.3}",
        local.reached, local.dt, local.volume, local.factor, local.solves, local.seconds
    );
    let uniform = search_dt(
        &case.mesh,
        &all_on(&case.mesh),
        &holds,
        &cases,
        target,
        bare.compliance,
    );
    eprintln!(
        "UNIFORM_OWN reached {} dt {:.4} vol {:.4} factor {:.6} solves {} s {:.3}",
        uniform.reached,
        uniform.dt,
        uniform.volume,
        uniform.factor,
        uniform.solves,
        uniform.seconds
    );

    if plan.ribs.is_empty() {
        eprintln!("BLEND skipped: the planner kept no ribs");
        return;
    }
    // One extra plan: pre-thicken the membrane region by a quarter of the
    // dt that matches the rib plan, then let the same greedy loop add ribs.
    let dt = if local.reached { 0.25 * local.dt } else { 0.5 };
    let mut blend = req.clone();
    blend.mesh = thicken(&case.mesh, &region, dt);
    blend.options.baselines = false;
    let started = Instant::now();
    let blended = plan_ribs(&blend).unwrap();
    let thick_vol = added_volume(&case.mesh, &blend.mesh);
    eprintln!(
        "BLEND dt {:.4} thick_vol {:.4} ribs {} rib_vol {:.4} total {:.4} factor {:.6} goal {} s {:.3}",
        dt,
        thick_vol,
        blended.ribs.len(),
        blended.rib_volume_mm3,
        thick_vol + blended.rib_volume_mm3,
        blended.stiffness_factor,
        blended.goal_met,
        started.elapsed().as_secs_f64()
    );
}

#[test]
fn thicken_against_ribs_on_three_walls() {
    let div = [16, 8];
    let curved = cylinder_segment(40.0, 80.0, std::f64::consts::FRAC_PI_2, div, 2.0);
    let holds = straight_edges(div);
    run_case(&Case {
        name: "curved-membrane",
        mesh: curved,
        holds: Holds::Given(holds),
        loaded: None,
        goal: Goal::Balanced,
        rules: RibRules::default(),
    });

    run_case(&Case {
        name: "flat-bending",
        mesh: ShellMesh::rectangle([160.0, 80.0], [24, 12], 2.0),
        holds: Holds::AllBoundaryClamped,
        loaded: None,
        goal: Goal::Stiffer(2.0),
        rules: RibRules::default(),
    });

    let (box_mesh, floor, box_holds) = open_box();
    let mut rules = RibRules::default();
    rules.min_spacing = 8.0;
    rules.min_length = 6.0;
    run_case(&Case {
        name: "folded-cover",
        mesh: box_mesh,
        holds: Holds::Given(box_holds),
        loaded: Some(floor),
        goal: Goal::Stiffer(1.5),
        rules,
    });
}
