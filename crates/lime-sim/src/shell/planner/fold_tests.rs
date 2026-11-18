//! Ribs on a folded shell. The meshes are the synthetic box and cover from
//! the folded-shell study (`docs/plan-folded-shell.md`): centre-line walls,
//! no customer geometry.

use std::collections::HashMap;

use crate::shell::{
    IsotropicShell, LoadCase, Rib, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel,
    ShellOptions,
};
use crate::units::{cross, dot, norm, normalize, sub};

use super::super::field::{self, Field};
use super::super::surface::{self, Surface};
use super::super::{plan_ribs, Goal, Holds, PlannerOptions, RibPlanRequest, RibRules};
use super::{TraceRules, Tracer};

const E_MPA: f64 = 2000.0;
const NU: f64 = 0.3;
const PRESSURE: f64 = 0.01;

const BOX_X0: f64 = 1.0;
const BOX_X1: f64 = 99.0;
const BOX_Y0: f64 = 1.0;
const BOX_Y1: f64 = 59.0;
const BOX_Z0: f64 = 1.0;
const BOX_Z1: f64 = 30.0;
const BOX_T: f64 = 2.0;

const CV_T: f64 = 2.0;
const CV_RIM: f64 = 6.0;
const CV_X0: f64 = 1.0;
const CV_X1: f64 = 79.0;
const CV_Y0: f64 = 1.0;
const CV_Y1: f64 = 47.0;
const CV_ZB: f64 = 1.0;
const CV_ZT: f64 = 13.0;

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6
}

fn lerp(a: f64, b: f64, i: usize, n: usize) -> f64 {
    if i == 0 || n == 0 {
        a
    } else if i == n {
        b
    } else {
        a + (b - a) * (i as f64 / n as f64)
    }
}

fn even_div(span: f64, h: f64) -> usize {
    let mut n = (span / h).round() as i64;
    if n < 2 {
        n = 2;
    }
    if n % 2 == 1 {
        n += 1;
    }
    n as usize
}

struct ShellBuild {
    mesh: ShellMesh,
    index: HashMap<(i64, i64, i64), u32>,
    thickness: f64,
}

impl ShellBuild {
    fn new(thickness: f64) -> Self {
        Self {
            mesh: ShellMesh::default(),
            index: HashMap::new(),
            thickness,
        }
    }

    fn vertex(&mut self, p: [f64; 3]) -> u32 {
        let key = (
            (p[0] * 1.0e6).round() as i64,
            (p[1] * 1.0e6).round() as i64,
            (p[2] * 1.0e6).round() as i64,
        );
        if let Some(&id) = self.index.get(&key) {
            return id;
        }
        let id = self.mesh.vertices.len() as u32;
        self.mesh.vertices.push(p);
        self.mesh.thickness.push(self.thickness);
        self.index.insert(key, id);
        id
    }

    fn panel(
        &mut self,
        nu: usize,
        nv: usize,
        at: impl Fn(usize, usize) -> [f64; 3],
        inward: [f64; 3],
    ) {
        let mut ids = vec![0u32; (nu + 1) * (nv + 1)];
        for j in 0..=nv {
            for i in 0..=nu {
                ids[i + (nu + 1) * j] = self.vertex(at(i, j));
            }
        }
        let corner = |i: usize, j: usize| ids[i + (nu + 1) * j];
        for j in 0..nv {
            for i in 0..nu {
                let (a, b, c, d) = (
                    corner(i, j),
                    corner(i + 1, j),
                    corner(i + 1, j + 1),
                    corner(i, j + 1),
                );
                let (pa, pb, pc) = (
                    self.mesh.vertices[a as usize],
                    self.mesh.vertices[b as usize],
                    self.mesh.vertices[c as usize],
                );
                let n = normalize(cross(sub(pb, pa), sub(pc, pa))).unwrap_or([0.0, 0.0, 1.0]);
                if dot(n, inward) >= 0.0 {
                    self.mesh.triangles.push([a, b, c]);
                    self.mesh.triangles.push([a, c, d]);
                } else {
                    self.mesh.triangles.push([a, c, b]);
                    self.mesh.triangles.push([a, d, c]);
                }
            }
        }
    }

    fn finish(self) -> ShellMesh {
        self.mesh
    }
}

fn box_shell(h: f64) -> ShellMesh {
    let (x0, x1, y0, y1, z0, z1) = (BOX_X0, BOX_X1, BOX_Y0, BOX_Y1, BOX_Z0, BOX_Z1);
    let nu = even_div(x1 - x0, h);
    let nv = even_div(y1 - y0, h);
    let nw = even_div(z1 - z0, h);
    let mut s = ShellBuild::new(BOX_T);
    s.panel(
        nu,
        nv,
        |i, j| [lerp(x0, x1, i, nu), lerp(y0, y1, j, nv), z0],
        [0.0, 0.0, 1.0],
    );
    s.panel(
        nv,
        nw,
        |i, j| [x0, lerp(y0, y1, i, nv), lerp(z0, z1, j, nw)],
        [1.0, 0.0, 0.0],
    );
    s.panel(
        nv,
        nw,
        |i, j| [x1, lerp(y0, y1, i, nv), lerp(z0, z1, j, nw)],
        [-1.0, 0.0, 0.0],
    );
    s.panel(
        nu,
        nw,
        |i, j| [lerp(x0, x1, i, nu), y0, lerp(z0, z1, j, nw)],
        [0.0, 1.0, 0.0],
    );
    s.panel(
        nu,
        nw,
        |i, j| [lerp(x0, x1, i, nu), y1, lerp(z0, z1, j, nw)],
        [0.0, -1.0, 0.0],
    );
    s.finish()
}

fn l_shell(h: f64) -> ShellMesh {
    let nu = even_div(40.0, h);
    let nv = even_div(24.0, h);
    let nw = even_div(20.0, h);
    let mut s = ShellBuild::new(2.0);
    s.panel(
        nu,
        nv,
        |i, j| [lerp(0.0, 40.0, i, nu), lerp(0.0, 24.0, j, nv), 0.0],
        [0.0, 0.0, 1.0],
    );
    s.panel(
        nu,
        nw,
        |i, j| [lerp(0.0, 40.0, i, nu), 0.0, lerp(0.0, 20.0, j, nw)],
        [0.0, 1.0, 0.0],
    );
    s.finish()
}

fn cover_shell(h: f64) -> ShellMesh {
    let nu = even_div(CV_X1 - CV_X0, h);
    let nv = even_div(CV_Y1 - CV_Y0, h);
    let nw = even_div(CV_ZT - CV_ZB, h);
    let nr = even_div(CV_RIM, h);
    let y_lo = CV_Y0 - CV_RIM;
    let y_hi = CV_Y1 + CV_RIM;
    let ny_rim = even_div(y_hi - y_lo, h);
    let mut s = ShellBuild::new(CV_T);
    let up = [0.0, 0.0, 1.0];
    s.panel(
        nu,
        nv,
        |i, j| [lerp(CV_X0, CV_X1, i, nu), lerp(CV_Y0, CV_Y1, j, nv), CV_ZB],
        up,
    );
    s.panel(
        nv,
        nw,
        |i, j| [CV_X0, lerp(CV_Y0, CV_Y1, i, nv), lerp(CV_ZB, CV_ZT, j, nw)],
        [1.0, 0.0, 0.0],
    );
    s.panel(
        nv,
        nw,
        |i, j| [CV_X1, lerp(CV_Y0, CV_Y1, i, nv), lerp(CV_ZB, CV_ZT, j, nw)],
        [-1.0, 0.0, 0.0],
    );
    s.panel(
        nu,
        nw,
        |i, j| [lerp(CV_X0, CV_X1, i, nu), CV_Y0, lerp(CV_ZB, CV_ZT, j, nw)],
        [0.0, 1.0, 0.0],
    );
    s.panel(
        nu,
        nw,
        |i, j| [lerp(CV_X0, CV_X1, i, nu), CV_Y1, lerp(CV_ZB, CV_ZT, j, nw)],
        [0.0, -1.0, 0.0],
    );
    s.panel(
        nr,
        ny_rim,
        |i, j| {
            [
                lerp(CV_X0 - CV_RIM, CV_X0, i, nr),
                lerp(y_lo, y_hi, j, ny_rim),
                CV_ZT,
            ]
        },
        up,
    );
    s.panel(
        nr,
        ny_rim,
        |i, j| {
            [
                lerp(CV_X1, CV_X1 + CV_RIM, i, nr),
                lerp(y_lo, y_hi, j, ny_rim),
                CV_ZT,
            ]
        },
        up,
    );
    s.panel(
        nu,
        nr,
        |i, j| {
            [
                lerp(CV_X0, CV_X1, i, nu),
                lerp(CV_Y0 - CV_RIM, CV_Y0, j, nr),
                CV_ZT,
            ]
        },
        up,
    );
    s.panel(
        nu,
        nr,
        |i, j| {
            [
                lerp(CV_X0, CV_X1, i, nu),
                lerp(CV_Y1, CV_Y1 + CV_RIM, j, nr),
                CV_ZT,
            ]
        },
        up,
    );
    s.finish()
}

fn clamp_where(mesh: &ShellMesh, pred: impl Fn([f64; 3]) -> bool) -> Vec<ShellHold> {
    mesh.vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| pred(**p))
        .map(|(i, _)| ShellHold::clamped(i as u32))
        .collect()
}

fn floor_load(mesh: &ShellMesh, window: Option<[f64; 4]>, q: f64) -> LoadCase {
    let mut tris = Vec::new();
    for t in 0..mesh.triangles.len() {
        let tri = mesh.triangles[t];
        let (a, b, c) = (
            mesh.vertices[tri[0] as usize],
            mesh.vertices[tri[1] as usize],
            mesh.vertices[tri[2] as usize],
        );
        let n = normalize(cross(sub(b, a), sub(c, a))).unwrap_or([0.0, 0.0, 1.0]);
        if n[2] < 0.9 {
            continue;
        }
        let centroid = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
        if let Some([x0, x1, y0, y1]) = window {
            if centroid[0] < x0 || centroid[0] > x1 || centroid[1] < y0 || centroid[1] > y1 {
                continue;
            }
        }
        tris.push(t as u32);
    }
    vec![ShellLoad::Pressure {
        triangles: tris,
        pressure: q,
    }]
}

fn chain_where(mesh: &ShellMesh, pred: impl Fn([f64; 3]) -> bool, axis: usize) -> Vec<u32> {
    let mut ids: Vec<u32> = mesh
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, p)| pred(**p))
        .map(|(i, _)| i as u32)
        .collect();
    ids.sort_by(|&a, &b| {
        mesh.vertices[a as usize][axis].total_cmp(&mesh.vertices[b as usize][axis])
    });
    ids.dedup();
    ids
}

fn join_chains(parts: &[Vec<u32>]) -> Vec<u32> {
    let mut out = Vec::new();
    for part in parts {
        for &v in part {
            if out.last() != Some(&v) {
                out.push(v);
            }
        }
    }
    out
}

fn rib_of(chain: &[u32]) -> Rib {
    let edges = chain.windows(2).map(|w| (w[0], w[1])).collect();
    Rib::rectangular(edges, 2.0, 6.0, RibSide::Positive)
}

fn material() -> IsotropicShell {
    IsotropicShell::new(E_MPA, NU).expect("material")
}

fn cross_and_stop(mesh: &ShellMesh) -> (Vec<u32>, Vec<u32>, Vec<Vec<u32>>) {
    let y_mid = 0.5 * (BOX_Y0 + BOX_Y1);
    let floor = chain_where(mesh, |p| near(p[1], y_mid) && near(p[2], BOX_Z0), 0);
    let mut left = chain_where(mesh, |p| near(p[0], BOX_X0) && near(p[1], y_mid), 2);
    left.reverse();
    let right = chain_where(mesh, |p| near(p[0], BOX_X1) && near(p[1], y_mid), 2);
    let cross = join_chains(&[left, floor.clone(), right]);
    let anchor = vec![
        chain_where(mesh, |p| near(p[1], BOX_Y0) && near(p[2], BOX_Z0), 0),
        chain_where(mesh, |p| near(p[1], BOX_Y1) && near(p[2], BOX_Z0), 0),
        chain_where(mesh, |p| near(p[0], BOX_X0) && near(p[2], BOX_Z0), 1),
        chain_where(mesh, |p| near(p[0], BOX_X1) && near(p[2], BOX_Z0), 1),
    ];
    (floor, cross, anchor)
}

struct Solved {
    compliance: f64,
    w_down: f64,
    pivot: f64,
}

fn solve(
    mesh: ShellMesh,
    holds: &[ShellHold],
    case: &LoadCase,
    ribs: Vec<Rib>,
    watch: [f64; 3],
) -> Solved {
    let mut model = ShellModel::new(mesh, material(), holds, ShellOptions::default())
        .unwrap_or_else(|e| panic!("{}", e.message));
    model.set_threads(4);
    if !ribs.is_empty() {
        model
            .set_ribs(ribs)
            .unwrap_or_else(|e| panic!("{}", e.message));
    }
    let result = model
        .solve(case)
        .unwrap_or_else(|e| panic!("{}", e.message));
    let v = model.mesh().nearest_vertex(watch) as usize;
    Solved {
        compliance: result.compliance,
        w_down: -result.displacement[v][2],
        pivot: result.pivot_ratio,
    }
}

fn balanced(mesh: ShellMesh, holds: Holds, case: LoadCase) -> crate::shell::planner::RibPlan {
    let mut req = RibPlanRequest::new(mesh, material());
    req.holds = holds;
    req.load_cases = vec![case];
    req.goal = Goal::Balanced;
    req.hole_rim_margin = None;
    req.options = PlannerOptions {
        baselines: false,
        workers: 4,
        ..PlannerOptions::default()
    };
    req.rules = RibRules {
        width: 1.5,
        max_height: 4.0,
        min_height: 1.0,
        min_spacing: 12.0,
        min_length: 8.0,
        side: RibSide::Positive,
        ..RibRules::default()
    };
    plan_ribs(&req).unwrap_or_else(|e| panic!("{}", e.message))
}

fn crosses_box(points: &[[f64; 3]]) -> bool {
    let on_floor = points.iter().any(|p| {
        (p[2] - BOX_Z0).abs() < 0.5
            && p[0] > BOX_X0 + 0.5
            && p[0] < BOX_X1 - 0.5
            && p[1] > BOX_Y0 + 0.5
            && p[1] < BOX_Y1 - 0.5
    });
    let on_wall = points.iter().any(|p| p[2] > BOX_Z0 + 2.0);
    on_floor && on_wall
}

fn length_by(
    points: &[[f64; 3]],
    region: impl Fn([f64; 3]) -> &'static str,
) -> [(&'static str, f64); 4] {
    let mut len = [("belly", 0.0), ("wall", 0.0), ("rim", 0.0), ("joint", 0.0)];
    for w in points.windows(2) {
        let mid = [0, 1, 2].map(|k| 0.5 * (w[0][k] + w[1][k]));
        let dl = norm(sub(w[1], w[0]));
        let name = region(mid);
        if let Some(slot) = len.iter_mut().find(|s| s.0 == name) {
            slot.1 += dl;
        }
    }
    len
}

fn cover_region(p: [f64; 3]) -> &'static str {
    let on_belly = (p[2] - CV_ZB).abs() <= 0.35;
    let on_top = (p[2] - CV_ZT).abs() <= 0.35;
    if on_belly && !on_top {
        return "belly";
    }
    if on_top {
        let inside = p[0] >= CV_X0 - 0.35
            && p[0] <= CV_X1 + 0.35
            && p[1] >= CV_Y0 - 0.35
            && p[1] <= CV_Y1 + 0.35;
        return if inside { "joint" } else { "rim" };
    }
    "wall"
}

fn count_crossing(
    mesh: &ShellMesh,
    holds: &[ShellHold],
    case: &LoadCase,
    crosses: impl Fn(&[[f64; 3]]) -> bool,
) -> (usize, usize) {
    let s = Surface::new(mesh, None);
    let mut model = ShellModel::new(mesh.clone(), material(), holds, ShellOptions::default())
        .unwrap_or_else(|e| panic!("{}", e.message));
    model.set_threads(1);
    let result = model
        .solve(case)
        .unwrap_or_else(|e| panic!("{}", e.message));
    let field = Field::new(&s, &[result], field::ALPHA, &[1.0]);
    let blocked = vec![false; s.tris.len()];
    let rules = TraceRules {
        spacing: 12.0,
        min_length: 8.0,
        tolerance: 0.2,
    };
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for p in &mesh.vertices {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let diag = norm(sub(hi, lo));
    let tracer = Tracer {
        s: &s,
        field: &field,
        blocked: &blocked,
        rules: &rules,
        max_length: 4.0 * diag,
    };
    let candidates = tracer.candidates();
    let crossing = candidates.iter().filter(|c| crosses(&c.points)).count();
    (candidates.len(), crossing)
}

#[test]
fn a_heading_unfolds_about_the_crease() {
    // Floor normal +z, wall normal +y, edge +x. A heading toward the wall
    // rotates up the wall, and the edge's direction does not matter.
    let floor = [0.0, 0.0, 1.0];
    let wall = [0.0, 1.0, 0.0];
    let heading = [0.0, -1.0, 0.0];
    let up = surface::unfold_about(heading, [1.0, 0.0, 0.0], floor, wall);
    let up_flip = surface::unfold_about(heading, [-1.0, 0.0, 0.0], floor, wall);
    for got in [up, up_flip] {
        assert!(got[0].abs() < 1e-12 && got[1].abs() < 1e-12, "{got:?}");
        assert!((got[2] - 1.0).abs() < 1e-12, "{got:?}");
    }
    // A flat step is the old projection, bit for bit.
    let d = normalize([0.6, -0.8, 0.0]).unwrap();
    let carried = super::carry_heading(d, floor, floor, Some([1.0, 0.0, 0.0])).unwrap();
    let projected = super::project(d, floor).unwrap();
    for k in 0..3 {
        assert_eq!(carried[k].to_bits(), projected[k].to_bits());
    }
}

#[test]
fn a_square_heading_climbs_the_wall() {
    let mesh = l_shell(4.0);
    let holds = clamp_where(&mesh, |p| near(p[2], 20.0));
    let case = floor_load(&mesh, None, PRESSURE);
    let s = Surface::new(&mesh, None);
    let mut model = ShellModel::new(mesh, material(), &holds, ShellOptions::default()).unwrap();
    model.set_threads(1);
    let result = model.solve(&case).unwrap();
    let field = Field::new(&s, &[result], field::ALPHA, &[1.0]);
    let blocked = vec![false; s.tris.len()];
    let rules = TraceRules {
        spacing: 12.0,
        min_length: 8.0,
        tolerance: 0.2,
    };
    let tracer = Tracer {
        s: &s,
        field: &field,
        blocked: &blocked,
        rules: &rules,
        max_length: 80.0,
    };
    let start = [20.0, 12.0, 0.0];
    let (t, _) = s.locate(start);
    let (pts, _) = tracer.straight_to(t, start, [0.0, -1.0, 0.0], 40.0);
    let max_z = pts.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
    assert!(max_z > 10.0, "square heading max z {max_z}, points {pts:?}");
    let diagonal = normalize([0.3, -1.0, 0.0]).unwrap();
    let (pts, _) = tracer.straight_to(t, start, diagonal, 40.0);
    let max_z = pts.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
    assert!(
        max_z > 5.0,
        "diagonal heading should climb, not run along the crease; max z {max_z}"
    );
}

#[test]
fn a_t_junction_keeps_the_coplanar_face() {
    // Two floor triangles and a wall on one edge. A heading that crosses
    // the edge inside the floor stays in the floor (turn 0 beats the
    // wall's 90°). A heading that comes down the wall enters the floor
    // face it points into.
    let mut mesh = ShellMesh::default();
    let thickness = vec![1.0; 5];
    mesh.vertices = vec![
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
        [5.0, 5.0, 0.0],
        [5.0, -5.0, 0.0],
        [5.0, 0.0, 8.0],
    ];
    mesh.thickness = thickness;
    mesh.triangles = vec![
        [0, 1, 2], // 0 floor, +z, edge 0 is the shared edge
        [0, 3, 1], // 1 floor, +z
        [0, 4, 1], // 2 wall, +y
    ];
    let s = Surface::new(&mesh, None);
    assert_eq!(s.neighbours(0, 0).len(), 2);
    assert_eq!(s.neighbour(0, 0), s.neighbours(0, 0).first().copied());
    let q = [5.0, 0.0, 0.0];
    let stay = super::next_triangle(&s, 0, q, 0, None, [0.0, -1.0, 0.0]);
    assert_eq!(stay, Some(1), "the coplanar floor wins over the wall");
    // Down the wall. Local edge between vertices 1 and 0 is k = 2.
    let down = super::next_triangle(&s, 2, q, 2, None, [0.0, 0.0, -1.0]);
    assert_eq!(down, Some(0), "the wall enters the floor it unfolds onto");
}

#[test]
fn two_triangles_on_an_edge_keep_neighbour() {
    let mesh = l_shell(4.0);
    let s = Surface::new(&mesh, None);
    for t in 0..s.tris.len() as u32 {
        for k in 0..3 {
            let all = s.neighbours(t, k);
            assert!(all.len() <= 1, "the L is a two-triangle crease");
            assert_eq!(all.first().copied(), s.neighbour(t, k));
        }
    }
}

#[test]
fn box_candidates_cross_the_fold() {
    let mesh = box_shell(2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
    let case = floor_load(&mesh, None, PRESSURE);
    let (total, crossing) = count_crossing(&mesh, &holds, &case, crosses_box);
    eprintln!("box h=2 candidates {total}, crossing the fold {crossing} (study: 0 of 13 on the L)");
    assert!(
        crossing > 0,
        "{crossing} of {total} candidates cross the fold"
    );
    let l = l_shell(2.0);
    let holds = clamp_where(&l, |p| near(p[2], 20.0));
    let case = floor_load(&l, None, PRESSURE);
    let (total_l, crossing_l) = count_crossing(&l, &holds, &case, |pts| {
        let on_floor = pts
            .iter()
            .any(|p| p[2].abs() < 0.5 && p[1] > 1.0 && (0.5..39.5).contains(&p[0]));
        let on_wall = pts.iter().any(|p| p[2] > 2.0);
        on_floor && on_wall
    });
    eprintln!("L h=2 candidates {total_l}, crossing {crossing_l}");
    assert!(crossing_l > 0, "L: {crossing_l} of {total_l}");
}

#[test]
fn box_plan_and_the_cross_rib() {
    let mesh = box_shell(2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
    let case = floor_load(&mesh, None, PRESSURE);
    let watch = [50.0, 30.0, BOX_Z0];
    let bare = solve(mesh.clone(), &holds, &case, Vec::new(), watch);
    let (floor, cross, _) = cross_and_stop(&mesh);
    let stop = solve(mesh.clone(), &holds, &case, vec![rib_of(&floor)], watch);
    let crossed = solve(mesh.clone(), &holds, &case, vec![rib_of(&cross)], watch);
    let stop_f = bare.compliance / stop.compliance;
    let cross_f = bare.compliance / crossed.compliance;
    let volume = super::super::rib_network_volume(&mesh, &[rib_of(&cross)]);
    eprintln!(
        "box h=2 rim clamped: bare C {:.6} w {:.5}; stop ×{stop_f:.3}; cross ×{cross_f:.3} at {volume:.1} mm³ (study cross ×1.721 at 1872 mm³)",
        bare.compliance, bare.w_down
    );
    let plan = balanced(mesh, Holds::AllBoundaryClamped, case);
    let crossing_ribs = plan.ribs.iter().filter(|r| crosses_box(&r.points)).count();
    eprintln!(
        "box h=2 balanced: {} ribs ({} cross), volume {:.1} mm³, ×{:.3}, bare C {:.6}, ribbed C {:.6}",
        plan.ribs.len(),
        crossing_ribs,
        plan.rib_volume_mm3,
        plan.stiffness_factor,
        plan.bare.compliance,
        plan.ribbed.compliance
    );
    for (i, rib) in plan.ribs.iter().enumerate() {
        let parts = length_by(&rib.points, |p| {
            if (p[2] - BOX_Z0).abs() <= 0.35
                && p[0] > BOX_X0 + 0.35
                && p[0] < BOX_X1 - 0.35
                && p[1] > BOX_Y0 + 0.35
                && p[1] < BOX_Y1 - 0.35
            {
                "belly"
            } else if p[2] > BOX_Z1 - 0.35 {
                "rim"
            } else if (p[2] - BOX_Z0).abs() <= 0.35 {
                "joint"
            } else {
                "wall"
            }
        });
        eprintln!(
            "  rib {i}: len {:.1}, {:?}, h {:.2}, ends {:?}/{:?}",
            rib.length_mm, parts, rib.height, rib.ends[0], rib.ends[1]
        );
    }
    assert!(plan.stiffness_factor > 1.0, "×{}", plan.stiffness_factor);
    assert!(
        crossing_ribs > 0,
        "the balanced plan places no rib across the fold (×{:.3}, {} ribs, {:.1} mm³)",
        plan.stiffness_factor,
        plan.ribs.len(),
        plan.rib_volume_mm3
    );
}

#[test]
fn cover_plan_is_not_empty() {
    let mesh = cover_shell(2.0);
    let case = floor_load(&mesh, Some([CV_X0, CV_X1, CV_Y0, CV_Y1]), PRESSURE);
    let plan = balanced(mesh, Holds::AllBoundaryClamped, case);
    eprintln!(
        "cover h=2 balanced: {} ribs, volume {:.1} mm³, ×{:.3}",
        plan.ribs.len(),
        plan.rib_volume_mm3,
        plan.stiffness_factor
    );
    let mut total = [0.0; 4];
    for (i, rib) in plan.ribs.iter().enumerate() {
        let parts = length_by(&rib.points, cover_region);
        eprintln!(
            "  rib {i}: len {:.1}, {:?}, h {:.2}, ends {:?}/{:?}",
            rib.length_mm, parts, rib.height, rib.ends[0], rib.ends[1]
        );
        for (k, slot) in parts.iter().enumerate() {
            total[k] += slot.1;
        }
    }
    let sum = total.iter().sum::<f64>().max(1e-9);
    eprintln!(
        "cover length: belly {:.0}% wall {:.0}% rim {:.0}% joint {:.0}%",
        100.0 * total[0] / sum,
        100.0 * total[1] / sum,
        100.0 * total[2] / sum,
        100.0 * total[3] / sum
    );
    assert!(!plan.ribs.is_empty(), "the folded cover plan is empty");
    assert!(plan.stiffness_factor > 1.0);
}

#[test]
fn crossing_with_the_rim_free() {
    // Section 4 held the whole rim, so the cross rib ran onto a hold.
    // Here only the four rim corners are held.
    let mesh = box_shell(2.0);
    let corners = [
        [BOX_X0, BOX_Y0, BOX_Z1],
        [BOX_X1, BOX_Y0, BOX_Z1],
        [BOX_X0, BOX_Y1, BOX_Z1],
        [BOX_X1, BOX_Y1, BOX_Z1],
    ];
    let holds: Vec<ShellHold> = corners
        .iter()
        .map(|p| ShellHold::clamped(mesh.nearest_vertex(*p)))
        .collect();
    let case = floor_load(&mesh, None, PRESSURE);
    let watch = [50.0, 30.0, BOX_Z0];
    let bare = solve(mesh.clone(), &holds, &case, Vec::new(), watch);
    let (floor, cross, _) = cross_and_stop(&mesh);
    let stop = solve(mesh.clone(), &holds, &case, vec![rib_of(&floor)], watch);
    let crossed = solve(mesh.clone(), &holds, &case, vec![rib_of(&cross)], watch);
    let stop_f = bare.compliance / stop.compliance;
    let cross_f = bare.compliance / crossed.compliance;
    let ratio = cross_f / stop_f;
    eprintln!(
        "rim free (4 corners): bare C {c:.6} pivot {pivot:.3e}; stop ×{stop_f:.3} (w {sw:.5}); cross ×{cross_f:.3} (w {cw:.5}); cross/stop {ratio:.3}",
        c = bare.compliance,
        pivot = bare.pivot,
        sw = stop.w_down,
        cw = crossed.w_down,
    );
    assert!(
        bare.pivot > 1e-8,
        "rim-free solve looks singular, pivot {}",
        bare.pivot
    );
    assert!(stop_f.is_finite() && cross_f.is_finite());
}

#[test]
fn crease_rib_foot_stands_on_a_face() {
    let mesh = box_shell(2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
    let case = floor_load(&mesh, None, PRESSURE);
    let (floor, _, anchor) = cross_and_stop(&mesh);
    let y_mid = 0.5 * (BOX_Y0 + BOX_Y1);
    let mid = floor
        .iter()
        .copied()
        .find(|&v| near(mesh.vertices[v as usize][0], 50.0))
        .expect("a mid-floor vertex");
    let mid_at = floor.iter().position(|&v| v == mid).unwrap();
    let mut model =
        ShellModel::new(mesh.clone(), material(), &holds, ShellOptions::default()).unwrap();
    model.set_threads(4);
    model.set_ribs(vec![rib_of(&floor)]).unwrap();
    let (_, lateral, _) = model
        .web_rotations()
        .into_iter()
        .find(|r| r.0 == mid)
        .unwrap();
    let n = model.vertex_normals()[mid as usize];
    let tangent = normalize(sub(
        mesh.vertices[floor[mid_at + 1] as usize],
        mesh.vertices[floor[mid_at - 1] as usize],
    ))
    .unwrap();
    let old_axis = normalize(cross(n, tangent)).unwrap();
    let agree = dot(lateral, old_axis).abs();
    eprintln!("mid-floor foot agrees with the vertex normal, |dot| {agree:.6} (1 is unchanged)");
    assert!(agree > 1.0 - 1e-8, "a mid-face vertex moved: |dot| {agree}");

    let ribs: Vec<Rib> = anchor.iter().map(|c| rib_of(c)).collect();
    model.set_ribs(ribs).unwrap();
    let mut worst_face = 1.0_f64;
    let mut best_bisector = 0.0_f64;
    let mut bisector_dot = 1.0_f64;
    let mut checked = 0usize;
    for (v, lateral, _) in model.web_rotations() {
        let p = mesh.vertices[v as usize];
        let on_long = near(p[1], BOX_Y0) || near(p[1], BOX_Y1);
        let on_short = near(p[0], BOX_X0) || near(p[0], BOX_X1);
        // Corners meet three faces; the check is one crease.
        if !(near(p[2], BOX_Z0) && (on_long || on_short) && !(on_long && on_short)) {
            continue;
        }
        checked += 1;
        let wall = if near(p[1], BOX_Y0) {
            [0.0, 1.0, 0.0]
        } else if near(p[1], BOX_Y1) {
            [0.0, -1.0, 0.0]
        } else if near(p[0], BOX_X0) {
            [1.0, 0.0, 0.0]
        } else {
            [-1.0, 0.0, 0.0]
        };
        let floor_n = [0.0, 0.0, 1.0];
        let bisector = normalize([
            floor_n[0] + wall[0],
            floor_n[1] + wall[1],
            floor_n[2] + wall[2],
        ])
        .unwrap();
        // The stored vertex normal is the bisector. The web axis of a rib
        // standing on it is perpendicular to that bisector; standing on a
        // face, it is not.
        let stored = model.vertex_normals()[v as usize];
        let off_bisector = dot(lateral, stored).abs();
        best_bisector = best_bisector.max(off_bisector);
        // Reconstruct the normal the axis was built from.
        let chain = anchor.iter().find(|c| c.contains(&v)).unwrap();
        let i = chain.iter().position(|&w| w == v).unwrap();
        let t = if i + 1 < chain.len() {
            normalize(sub(mesh.vertices[chain[i + 1] as usize], p)).unwrap()
        } else {
            normalize(sub(p, mesh.vertices[chain[i - 1] as usize])).unwrap()
        };
        let n_rib = normalize(cross(t, lateral)).unwrap();
        bisector_dot = bisector_dot.min(dot(n_rib, bisector).abs());
        let face = dot(n_rib, floor_n).abs().max(dot(n_rib, wall).abs());
        worst_face = worst_face.min(face);
    }
    eprintln!(
        "anchor crease foot ({checked} vertices): closest face |dot| {worst_face:.4} (1 is on the face), |foot · 45° bisector| down to {bisector_dot:.4}, |lateral · vertex normal| up to {best_bisector:.4} (0 was the bisector web)"
    );
    assert!(checked > 0, "no crease vertex was measured");
    assert!(
        worst_face > 0.98,
        "crease foot is not on a face, closest |dot| {worst_face}"
    );
    assert!(
        best_bisector > 0.3,
        "crease web is still perpendicular to the bisector"
    );

    let watch = [50.0, y_mid, BOX_Z0];
    let bare = solve(mesh.clone(), &holds, &case, Vec::new(), watch);
    let ribs: Vec<Rib> = anchor.iter().map(|c| rib_of(c)).collect();
    let anchored = solve(mesh, &holds, &case, ribs, watch);
    let factor = bare.compliance / anchored.compliance;
    eprintln!(
        "anchor h=2, foot on the face: ×{factor:.3} (study, foot on the 45° bisector: ×1.069), w {:.5} vs bare {:.5}",
        anchored.w_down, bare.w_down
    );
}
