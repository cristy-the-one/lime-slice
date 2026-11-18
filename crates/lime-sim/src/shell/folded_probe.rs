//! Probe for docs/plan-folded-shell.md. Synthetic plates only: an open box,
//! a right-angle fold, a flat plate and a tray with a rim. Nothing here is
//! a product part.
//!
//! Numbers are printed and appended to `/tmp/folded-probe/log.txt`.
//! Run: `cargo test -p lime-sim --release --lib folded_probe -- --test-threads=1 --nocapture`

#![allow(clippy::too_many_lines)]
#![allow(clippy::similar_names)]

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use super::planner::{
    plan_ribs, rib_network_volume, Goal, Holds, RibPlanRequest, RibRules,
};
use super::{
    IsotropicShell, LoadCase, MembraneKind, Rib, RibSide, ShellHold, ShellLoad, ShellMesh,
    ShellModel, ShellOptions, ShellResult, DRILL_PENALTY, FIELD_ALPHA, Field, Surface, TraceRules,
    Tracer,
};
use crate::assemble::{traction_forces, Hold, Load, NodeHold};
use crate::element::ElementKind;
use crate::material::LinearOrthotropic;
use crate::mesh::{faces_on_plane, grid, BoundaryFace, Cell, Mesh};
use crate::recipe::Recipe;
use crate::study::{Request, Step};
use crate::units::{cross, dot, norm, normalize, sub};
use crate::{solve_request, Solution};

const E_MPA: f64 = 2000.0;
const NU: f64 = 0.3;
/// N/mm² on the floor. The plate tests use the same value.
const PRESSURE: f64 = 0.01;

/// Open box, outer skin 100 × 60 × 30 mm, walls 2 mm, open at z = 30.
const BOX_L: f64 = 100.0;
const BOX_W: f64 = 60.0;
const BOX_H: f64 = 30.0;
const BOX_T: f64 = 2.0;
const BOX_X0: f64 = 1.0;
const BOX_X1: f64 = 99.0;
const BOX_Y0: f64 = 1.0;
const BOX_Y1: f64 = 59.0;
const BOX_Z0: f64 = 1.0;
const BOX_Z1: f64 = 30.0;

/// Tray: belly 80 × 48, walls 12 mm above the floor slab, rim 6 mm, all 2 mm.
const CV_L: f64 = 80.0;
const CV_W: f64 = 48.0;
const CV_T: f64 = 2.0;
const CV_WALL: f64 = 12.0;
const CV_RIM: f64 = 6.0;
const CV_X0: f64 = 1.0;
const CV_X1: f64 = 79.0;
const CV_Y0: f64 = 1.0;
const CV_Y1: f64 = 47.0;
const CV_ZB: f64 = 1.0;
const CV_ZT: f64 = 13.0;

const RIB_W: f64 = 2.0;
const RIB_H: f64 = 6.0;

static LOG: LazyLock<Mutex<std::fs::File>> = LazyLock::new(|| {
    std::fs::create_dir_all("/tmp/folded-probe").ok();
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/folded-probe/log.txt")
        .expect("probe log");
    Mutex::new(file)
});

fn log(line: &str) {
    eprintln!("{line}");
    let mut file = LOG.lock().expect("probe log lock");
    let _ = writeln!(file, "{line}");
    let _ = file.flush();
}

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

fn div_exact(size: f64, h: f64) -> usize {
    let n = (size / h).round();
    assert!(
        (size - n * h).abs() < 1e-6 && n >= 1.0,
        "size {size} is not a multiple of {h}"
    );
    n as usize
}

fn tri_normal(mesh: &ShellMesh, t: usize) -> [f64; 3] {
    let tri = mesh.triangles[t];
    let a = mesh.vertices[tri[0] as usize];
    let b = mesh.vertices[tri[1] as usize];
    let c = mesh.vertices[tri[2] as usize];
    normalize(cross(sub(b, a), sub(c, a))).unwrap_or([0.0, 0.0, 1.0])
}

fn tri_area(mesh: &ShellMesh, t: usize) -> f64 {
    let tri = mesh.triangles[t];
    let a = mesh.vertices[tri[0] as usize];
    let b = mesh.vertices[tri[1] as usize];
    let c = mesh.vertices[tri[2] as usize];
    0.5 * norm(cross(sub(b, a), sub(c, a)))
}

fn centroid3(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0)
}

fn mesh_centroid(mesh: &ShellMesh, t: usize) -> [f64; 3] {
    let tri = mesh.triangles[t];
    centroid3(
        mesh.vertices[tri[0] as usize],
        mesh.vertices[tri[1] as usize],
        mesh.vertices[tri[2] as usize],
    )
}

fn angle_deg(a: [f64; 3], b: [f64; 3]) -> f64 {
    dot(a, b).clamp(-1.0, 1.0).acos().to_degrees()
}

fn nearest(nodes: &[[f64; 3]], p: [f64; 3]) -> usize {
    let mut best = (f64::MAX, 0usize);
    for (i, q) in nodes.iter().enumerate() {
        let d: f64 = (0..3).map(|k| (q[k] - p[k]).powi(2)).sum();
        if d < best.0 {
            best = (d, i);
        }
    }
    best.1
}

fn face_normal(verts: &[[f64; 3]], a: u32, b: u32, c: u32) -> [f64; 3] {
    let (pa, pb, pc) = (verts[a as usize], verts[b as usize], verts[c as usize]);
    normalize(cross(sub(pb, pa), sub(pc, pa))).unwrap_or([0.0, 0.0, 1.0])
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
                let (a, b, c, d) = (corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1));
                let n = face_normal(&self.mesh.vertices, a, b, c);
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

fn box_shell(through_floor: bool, h: f64) -> ShellMesh {
    let (x0, x1, y0, y1, z0, z1) = (BOX_X0, BOX_X1, BOX_Y0, BOX_Y1, BOX_Z0, BOX_Z1);
    let nu = even_div(x1 - x0, h);
    let nv = even_div(y1 - y0, h);
    let nw = even_div(z1 - z0, h);
    let mut s = ShellBuild::new(BOX_T);
    let up = [0.0, 0.0, 1.0];
    if through_floor {
        let xs = [(0.0, x0, 1usize), (x0, x1, nu), (x1, BOX_L, 1usize)];
        let ys = [(0.0, y0, 1usize), (y0, y1, nv), (y1, BOX_W, 1usize)];
        for &(xa, xb, nx) in &xs {
            for &(ya, yb, ny) in &ys {
                s.panel(nx, ny, |i, j| [lerp(xa, xb, i, nx), lerp(ya, yb, j, ny), z0], up);
            }
        }
        for &(ya, yb, ny) in &ys {
            s.panel(ny, nw, |i, j| [x0, lerp(ya, yb, i, ny), lerp(z0, z1, j, nw)], [1.0, 0.0, 0.0]);
            s.panel(ny, nw, |i, j| [x1, lerp(ya, yb, i, ny), lerp(z0, z1, j, nw)], [-1.0, 0.0, 0.0]);
        }
    } else {
        s.panel(nu, nv, |i, j| [lerp(x0, x1, i, nu), lerp(y0, y1, j, nv), z0], up);
        s.panel(nv, nw, |i, j| [x0, lerp(y0, y1, i, nv), lerp(z0, z1, j, nw)], [1.0, 0.0, 0.0]);
        s.panel(nv, nw, |i, j| [x1, lerp(y0, y1, i, nv), lerp(z0, z1, j, nw)], [-1.0, 0.0, 0.0]);
    }
    s.panel(nu, nw, |i, j| [lerp(x0, x1, i, nu), y0, lerp(z0, z1, j, nw)], [0.0, 1.0, 0.0]);
    s.panel(nu, nw, |i, j| [lerp(x0, x1, i, nu), y1, lerp(z0, z1, j, nw)], [0.0, -1.0, 0.0]);
    s.finish()
}

fn l_shell(h: f64) -> ShellMesh {
    let nu = even_div(40.0, h);
    let nv = even_div(24.0, h);
    let nw = even_div(20.0, h);
    let mut s = ShellBuild::new(2.0);
    s.panel(nu, nv, |i, j| [lerp(0.0, 40.0, i, nu), lerp(0.0, 24.0, j, nv), 0.0], [0.0, 0.0, 1.0]);
    s.panel(nu, nw, |i, j| [lerp(0.0, 40.0, i, nu), 0.0, lerp(0.0, 20.0, j, nw)], [0.0, 1.0, 0.0]);
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
    s.panel(nu, nv, |i, j| [lerp(CV_X0, CV_X1, i, nu), lerp(CV_Y0, CV_Y1, j, nv), CV_ZB], up);
    s.panel(nv, nw, |i, j| [CV_X0, lerp(CV_Y0, CV_Y1, i, nv), lerp(CV_ZB, CV_ZT, j, nw)], [1.0, 0.0, 0.0]);
    s.panel(nv, nw, |i, j| [CV_X1, lerp(CV_Y0, CV_Y1, i, nv), lerp(CV_ZB, CV_ZT, j, nw)], [-1.0, 0.0, 0.0]);
    s.panel(nu, nw, |i, j| [lerp(CV_X0, CV_X1, i, nu), CV_Y0, lerp(CV_ZB, CV_ZT, j, nw)], [0.0, 1.0, 0.0]);
    s.panel(nu, nw, |i, j| [lerp(CV_X0, CV_X1, i, nu), CV_Y1, lerp(CV_ZB, CV_ZT, j, nw)], [0.0, -1.0, 0.0]);
    s.panel(nr, ny_rim, |i, j| [lerp(CV_X0 - CV_RIM, CV_X0, i, nr), lerp(y_lo, y_hi, j, ny_rim), CV_ZT], up);
    s.panel(nr, ny_rim, |i, j| [lerp(CV_X1, CV_X1 + CV_RIM, i, nr), lerp(y_lo, y_hi, j, ny_rim), CV_ZT], up);
    s.panel(nu, nr, |i, j| [lerp(CV_X0, CV_X1, i, nu), lerp(CV_Y0 - CV_RIM, CV_Y0, j, nr), CV_ZT], up);
    s.panel(nu, nr, |i, j| [lerp(CV_X0, CV_X1, i, nu), lerp(CV_Y1, CV_Y1 + CV_RIM, j, nr), CV_ZT], up);
    s.finish()
}

fn belly_shell(h: f64) -> ShellMesh {
    let nu = even_div(CV_X1 - CV_X0, h);
    let nv = even_div(CV_Y1 - CV_Y0, h);
    let mut s = ShellBuild::new(CV_T);
    s.panel(
        nu,
        nv,
        |i, j| [lerp(CV_X0, CV_X1, i, nu), lerp(CV_Y0, CV_Y1, j, nv), CV_ZB],
        [0.0, 0.0, 1.0],
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

fn floor_load(mesh: &ShellMesh, window: Option<[f64; 4]>, q: f64) -> (LoadCase, f64) {
    let mut tris = Vec::new();
    let mut area = 0.0;
    for t in 0..mesh.triangles.len() {
        if tri_normal(mesh, t)[2] < 0.9 {
            continue;
        }
        let c = mesh_centroid(mesh, t);
        if let Some([x0, x1, y0, y1]) = window {
            if c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1 {
                continue;
            }
        }
        tris.push(t as u32);
        area += tri_area(mesh, t);
    }
    assert!(!tris.is_empty(), "no floor triangles");
    (
        vec![ShellLoad::Pressure {
            triangles: tris,
            pressure: q,
        }],
        area,
    )
}

struct ShellStats {
    w_down: f64,
    compliance: f64,
    membrane: f64,
    bending: f64,
    dofs: usize,
    nodes: usize,
    tris: usize,
    seconds: f64,
    factor_s: f64,
    pivot: f64,
    force: f64,
    at: [f64; 3],
}

fn solve_shell(
    mesh: ShellMesh,
    holds: &[ShellHold],
    case: &LoadCase,
    options: ShellOptions,
    watch: [f64; 3],
    force: f64,
) -> ShellStats {
    let nodes = mesh.vertices.len();
    let tris = mesh.triangles.len();
    let started = Instant::now();
    let mut model = ShellModel::new(
        mesh,
        IsotropicShell::new(E_MPA, NU).expect("material"),
        holds,
        options,
    )
    .unwrap_or_else(|e| panic!("{}", e.message));
    model.set_threads(4);
    let result = model
        .solve(case)
        .unwrap_or_else(|e| panic!("{}", e.message));
    let seconds = started.elapsed().as_secs_f64();
    let v = model.mesh().nearest_vertex(watch) as usize;
    let at = model.mesh().vertices[v];
    stats_from(&model, &result, nodes, tris, seconds, force, -result.displacement[v][2], at)
}

#[allow(clippy::too_many_arguments)]
fn stats_from(
    model: &ShellModel,
    result: &ShellResult,
    nodes: usize,
    tris: usize,
    seconds: f64,
    force: f64,
    w_down: f64,
    at: [f64; 3],
) -> ShellStats {
    let membrane = result.elements.iter().map(|e| e.membrane_energy).sum();
    let bending = result.elements.iter().map(|e| e.bending_energy).sum();
    let timings = model.timings();
    ShellStats {
        w_down,
        compliance: result.compliance,
        membrane,
        bending,
        dofs: model.free_dofs(),
        nodes,
        tris,
        seconds,
        factor_s: timings.factor + timings.solve,
        pivot: result.pivot_ratio,
        force,
        at,
    }
}

fn report_shell(label: &str, h: f64, s: &ShellStats) {
    let mem = if s.membrane + s.bending > 0.0 {
        100.0 * s.membrane / (s.membrane + s.bending)
    } else {
        0.0
    };
    log(&format!(
        "| {label} | h≈{h:.3} | {} nodes {} tris | {} dofs | w {:+.6e} at ({:.2},{:.2},{:.2}) | C {:.6e} | F {:.4} | membrane {mem:.1}% | {:.3} s (factor+solve {:.3}) | pivot {:.2e} |",
        s.nodes, s.tris, s.dofs, s.w_down, s.at[0], s.at[1], s.at[2], s.compliance, s.force, s.seconds, s.factor_s, s.pivot
    ));
}

fn extrapolate(label: &str, rows: &[(f64, f64)]) {
    if rows.len() < 3 {
        log(&format!("{label}: fewer than 3 meshes"));
        return;
    }
    let n = rows.len();
    let (h0, w0) = rows[n - 3];
    let (h1, w1) = rows[n - 2];
    let (h2, w2) = rows[n - 1];
    let d01 = w0 - w1;
    let d12 = w1 - w2;
    if d01.abs() < 1e-15 || d12.abs() < 1e-15 || d01.signum() != d12.signum() {
        log(&format!(
            "{label}: not monotone ({w0:.6e}, {w1:.6e}, {w2:.6e}), no extrapolation"
        ));
        return;
    }
    let p = (d01 / d12).abs().ln() / (h0 / h1).ln();
    let r = h1 / h2;
    let inf = if r.powf(p) > 1.001 {
        w2 + (w2 - w1) / (r.powf(p) - 1.0)
    } else {
        w2
    };
    let inf2 = w2 + (w2 - w1) / (r * r - 1.0);
    log(&format!(
        "{label}: observed order {p:.2}, Richardson at that order {inf:.6e}, at order 2 {inf2:.6e}"
    ));
}

struct Block {
    origin: [f64; 3],
    size: [f64; 3],
    div: [usize; 3],
}

fn weld_blocks(blocks: &[Block]) -> Mesh {
    let mut index: HashMap<(i64, i64, i64), usize> = HashMap::new();
    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    for block in blocks {
        let part = grid(block.origin, block.size, block.div, ElementKind::Tet10)
            .unwrap_or_else(|e| panic!("{}", e.message));
        let mut map = vec![0usize; part.nodes.len()];
        for (i, p) in part.nodes.iter().enumerate() {
            let key = (
                (p[0] * 1.0e6).round() as i64,
                (p[1] * 1.0e6).round() as i64,
                (p[2] * 1.0e6).round() as i64,
            );
            map[i] = if let Some(&id) = index.get(&key) {
                id
            } else {
                let id = nodes.len();
                nodes.push(*p);
                index.insert(key, id);
                id
            };
        }
        for cell in &part.elements {
            elements.push(Cell {
                nodes: cell.nodes.iter().map(|&n| map[n]).collect(),
            });
        }
    }
    Mesh {
        nodes,
        elements,
        kind: ElementKind::Tet10,
    }
}

fn box_blocks(h_in: f64, h_th: f64) -> Vec<Block> {
    let (l, w, h, t) = (BOX_L, BOX_W, BOX_H, BOX_T);
    let nx = div_exact(l, h_in);
    let ny = div_exact(w, h_in);
    let nt = div_exact(t, h_th);
    let nz_f = div_exact(t, h_th);
    let nz_w = div_exact(h - t, h_in);
    let n_in = div_exact(l - 2.0 * t, h_in);
    vec![
        Block { origin: [0.0, 0.0, 0.0], size: [l, w, t], div: [nx, ny, nz_f] },
        Block { origin: [0.0, 0.0, t], size: [t, w, h - t], div: [nt, ny, nz_w] },
        Block { origin: [l - t, 0.0, t], size: [t, w, h - t], div: [nt, ny, nz_w] },
        Block { origin: [t, 0.0, t], size: [l - 2.0 * t, t, h - t], div: [n_in, nt, nz_w] },
        Block { origin: [t, w - t, t], size: [l - 2.0 * t, t, h - t], div: [n_in, nt, nz_w] },
    ]
}

fn l_blocks(h: f64) -> Vec<Block> {
    vec![
        Block {
            origin: [-1.0, -1.0, -1.0],
            size: [42.0, 26.0, 2.0],
            div: [div_exact(42.0, h), div_exact(26.0, h), div_exact(2.0, h)],
        },
        Block {
            origin: [-1.0, -1.0, 1.0],
            size: [42.0, 2.0, 19.0],
            div: [div_exact(42.0, h), div_exact(2.0, h), div_exact(19.0, h)],
        },
    ]
}

fn cover_blocks(h_in: f64, h_th: f64) -> Vec<Block> {
    let (l, w, t, wall, rim) = (CV_L, CV_W, CV_T, CV_WALL, CV_RIM);
    let nx = div_exact(l, h_in);
    let ny = div_exact(w, h_in);
    let nt = div_exact(t, h_th);
    let nz_w = div_exact(wall, h_in);
    let n_in_x = div_exact(l - 2.0 * t, h_in);
    let nr = div_exact(rim, h_in);
    let n_rim_y = div_exact(w + 2.0 * rim, h_in);
    let z_rim = t + wall - t;
    vec![
        Block { origin: [0.0, 0.0, 0.0], size: [l, w, t], div: [nx, ny, nt] },
        Block { origin: [0.0, 0.0, t], size: [t, w, wall], div: [nt, ny, nz_w] },
        Block { origin: [l - t, 0.0, t], size: [t, w, wall], div: [nt, ny, nz_w] },
        Block { origin: [t, 0.0, t], size: [l - 2.0 * t, t, wall], div: [n_in_x, nt, nz_w] },
        Block { origin: [t, w - t, t], size: [l - 2.0 * t, t, wall], div: [n_in_x, nt, nz_w] },
        Block { origin: [-rim, -rim, z_rim], size: [rim, w + 2.0 * rim, t], div: [nr, n_rim_y, nt] },
        Block { origin: [l, -rim, z_rim], size: [rim, w + 2.0 * rim, t], div: [nr, n_rim_y, nt] },
        Block { origin: [0.0, -rim, z_rim], size: [l, rim, t], div: [nx, nr, nt] },
        Block { origin: [0.0, w, z_rim], size: [l, rim, t], div: [nx, nr, nt] },
    ]
}

fn plate_block(h_in: f64, h_th: f64) -> Block {
    let t = 2.0;
    Block {
        origin: [0.0, 0.0, -t / 2.0],
        size: [100.0, 60.0, t],
        div: [div_exact(100.0, h_in), div_exact(60.0, h_in), div_exact(t, h_th)],
    }
}

struct SolidStats {
    w_down: f64,
    compliance: f64,
    dofs: usize,
    nodes: usize,
    elements: usize,
    seconds: f64,
    build_s: f64,
    force: f64,
    at: [f64; 3],
    energy_error: f64,
    volume: f64,
}

fn solid_work(mesh: &Mesh, loads: &[Load], displacement: &[[f64; 3]]) -> f64 {
    let mut work = 0.0;
    for load in loads {
        match load {
            Load::Traction { nodes, traction } => {
                let coords: Vec<[f64; 3]> = nodes.iter().map(|&n| mesh.nodes[n]).collect();
                let forces = traction_forces(&coords, *traction);
                for (node, force) in nodes.iter().zip(forces) {
                    for k in 0..3 {
                        work += force[k] * displacement[*node][k];
                    }
                }
            }
            Load::Force { node, force } => {
                for k in 0..3 {
                    work += force[k] * displacement[*node][k];
                }
            }
        }
    }
    work
}

fn solve_solid(
    mesh: Mesh,
    holds: Vec<NodeHold>,
    loads: Vec<Load>,
    watch: [f64; 3],
    force: f64,
    build_s: f64,
) -> Option<SolidStats> {
    let nodes = mesh.nodes.len();
    let elements = mesh.elements.len();
    let volume = mesh.volume();
    if nodes > 190_000 {
        log(&format!(
            "solid skipped: {nodes} nodes, {elements} tets (cap 200000)"
        ));
        return None;
    }
    let held = holds.len();
    let started = Instant::now();
    let sol: Solution = solve_request(&Request {
        mesh,
        material: LinearOrthotropic::isotropic(E_MPA, NU, 1.2),
        recipe: Recipe::solid(),
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: loads.clone(),
        steps: vec![Step { factor: 1.0, max_iter: 1, tol: 1e-10 }],
        linear: true,
        gravity: None,
        h_mm: 1.0,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "smear".into(),
        cells: Vec::new(),
        beads: None,
        post_steps: Vec::new(),
        provisional: false,
        cancel: None,
        on_progress: None,
    })
    .unwrap_or_else(|e| panic!("{}", e.message));
    let seconds = started.elapsed().as_secs_f64();
    let node = nearest(&sol.mesh.nodes, watch);
    let at = sol.mesh.nodes[node];
    let w_down = -sol.displacement[node][2];
    let compliance = solid_work(&sol.mesh, &loads, &sol.displacement);
    Some(SolidStats {
        w_down,
        compliance,
        dofs: nodes * 3 - held * 3,
        nodes,
        elements,
        seconds,
        build_s,
        force,
        at,
        energy_error: sol.relative_energy_error,
        volume,
    })
}

fn report_solid(label: &str, detail: &str, s: &SolidStats) {
    log(&format!(
        "| {label} | {detail} | {} nodes {} tets | {} dofs | vol {:.1} | w {:+.6e} at ({:.2},{:.2},{:.2}) | C {:.6e} | F {:.4} | build {:.3} s solve {:.3} s | energy err {:.3e} |",
        s.nodes, s.elements, s.dofs, s.volume, s.w_down, s.at[0], s.at[1], s.at[2], s.compliance, s.force, s.build_s, s.seconds, s.energy_error
    ));
}

fn faces_window(mesh: &Mesh, axis: usize, at: f64, window: impl Fn([f64; 3]) -> bool) -> Vec<BoundaryFace> {
    faces_on_plane(mesh, axis, at, 1e-6)
        .into_iter()
        .filter(|face| window(face.centroid))
        .collect()
}

fn traction_of(faces: &[BoundaryFace], traction: [f64; 3]) -> (Vec<Load>, f64) {
    let area: f64 = faces.iter().map(|f| f.area).sum();
    let loads = faces
        .iter()
        .map(|f| Load::Traction {
            nodes: f.nodes.clone(),
            traction,
        })
        .collect();
    (loads, area)
}

fn fixed_where(mesh: &Mesh, pred: impl Fn([f64; 3]) -> bool) -> Vec<NodeHold> {
    mesh.nodes
        .iter()
        .enumerate()
        .filter(|(_, p)| pred(**p))
        .map(|(i, _)| NodeHold { node: i, hold: Hold::Fixed })
        .collect()
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
    Rib::rectangular(edges, RIB_W, RIB_H, RibSide::Positive)
}

fn solve_with_ribs(
    mesh: ShellMesh,
    holds: &[ShellHold],
    case: &LoadCase,
    ribs: Vec<Rib>,
    watch: [f64; 3],
    force: f64,
) -> (ShellStats, f64) {
    let nodes = mesh.vertices.len();
    let tris = mesh.triangles.len();
    let volume = rib_network_volume(&mesh, &ribs);
    let started = Instant::now();
    let mut model = ShellModel::new(
        mesh,
        IsotropicShell::new(E_MPA, NU).expect("material"),
        holds,
        ShellOptions::default(),
    )
    .unwrap_or_else(|e| panic!("{}", e.message));
    model.set_threads(4);
    model.set_ribs(ribs).unwrap_or_else(|e| panic!("{}", e.message));
    let result = model.solve(case).unwrap_or_else(|e| panic!("{}", e.message));
    let seconds = started.elapsed().as_secs_f64();
    let v = model.mesh().nearest_vertex(watch) as usize;
    let at = model.mesh().vertices[v];
    let stats = stats_from(
        &model,
        &result,
        nodes,
        tris,
        seconds,
        force,
        -result.displacement[v][2],
        at,
    );
    (stats, volume)
}

fn cover_point_region(p: [f64; 3]) -> &'static str {
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

fn shell_options(alpha: f64, kind: MembraneKind) -> ShellOptions {
    ShellOptions {
        membrane: kind,
        drill_penalty: alpha,
    }
}

fn pct(a: f64, b: f64) -> f64 {
    if b.abs() < 1e-15 {
        f64::NAN
    } else {
        100.0 * (a - b) / b
    }
}

#[test]
fn q2_creases_normals_and_neighbour() {
    log("\n## Q2 creases, vertex normals, Surface::neighbour");
    let l = l_shell(4.0);
    let holds = clamp_where(&l, |p| near(p[2], 20.0));
    let (case, area) = floor_load(&l, None, PRESSURE);
    let mut model = ShellModel::new(
        l.clone(),
        IsotropicShell::new(E_MPA, NU).expect("material"),
        &holds,
        ShellOptions::default(),
    )
    .unwrap_or_else(|e| panic!("{}", e.message));
    let crease = model.mesh().nearest_vertex([20.0, 0.0, 0.0]) as usize;
    let n = model.vertex_normals()[crease];
    let at = model.mesh().vertices[crease];
    log(&format!(
        "L crease vertex ({:.3},{:.3},{:.3}) normal ({:.4},{:.4},{:.4}), angle to +z {:.2}°, to +y {:.2}°",
        at[0], at[1], at[2], n[0], n[1], n[2], angle_deg(n, [0.0, 0.0, 1.0]), angle_deg(n, [0.0, 1.0, 0.0])
    ));
    model.set_threads(4);
    let solved = model.solve(&case).unwrap_or_else(|e| panic!("{}", e.message));
    let surface = Surface::new(model.mesh(), None);
    let mut fold_edges = 0usize;
    let mut fold_neighbour_ok = 0usize;
    for t in 0..surface.tris.len() as u32 {
        for k in 0..3 {
            let Some(o) = surface.neighbour(t, k) else { continue };
            let ang = angle_deg(surface.normal(t), surface.normal(o));
            if !(80.0..=100.0).contains(&ang) {
                continue;
            }
            fold_edges += 1;
            if (0..3).any(|q| surface.neighbour(o, q) == Some(t)) {
                fold_neighbour_ok += 1;
            }
        }
    }
    log(&format!(
        "L fold-edge sides {fold_edges}, of which the neighbour points back {fold_neighbour_ok} (each edge counted twice)"
    ));
    let rules = TraceRules { spacing: 8.0, min_length: 4.0, tolerance: 0.2 };
    let blocked = vec![false; surface.tris.len()];
    let mut field = Field::new(&surface, std::slice::from_ref(&solved), FIELD_ALPHA);
    // The cross-field connection is the other frame's e1 measured in this
    // plane. At 90° that vector can lie along this plane's normal, so the
    // angle is the angle of a near-zero projection.
    let mut shown = 0;
    for t in 0..surface.tris.len() as u32 {
        for k in 0..3 {
            let Some(o) = surface.neighbour(t, k) else { continue };
            if !(80.0..=100.0).contains(&angle_deg(surface.normal(t), surface.normal(o))) {
                continue;
            }
            let here = &field.frames[t as usize];
            let there = &field.frames[o as usize];
            let in_plane = (dot(there.e1, here.e1).powi(2) + dot(there.e1, here.e2).powi(2)).sqrt();
            let tri = surface.tris[t as usize];
            let edge = normalize(sub(
                surface.pos[tri[(k + 1) % 3] as usize],
                surface.pos[tri[k] as usize],
            ))
            .unwrap_or([1.0, 0.0, 0.0]);
            let across = normalize(cross(here.n, edge)).unwrap_or([0.0, 0.0, 1.0]);
            let across_in = (dot(across, there.e1).powi(2) + dot(across, there.e2).powi(2)).sqrt();
            log(&format!(
                "fold connection t {t} → {o}: neighbour e1 in this plane {:.2}° (in-plane {in_plane:.3}); heading across the edge lands in the next plane at {:.2}° with in-plane fraction {across_in:.3}",
                here.angle(there.e1).to_degrees(),
                there.angle(across).to_degrees()
            ));
            shown += 1;
            if shown == 4 {
                break;
            }
        }
        if shown == 4 {
            break;
        }
    }
    let start = surface
        .tris
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            let ca = centroid3(
                surface.pos[a[0] as usize],
                surface.pos[a[1] as usize],
                surface.pos[a[2] as usize],
            );
            let cb = centroid3(
                surface.pos[b[0] as usize],
                surface.pos[b[1] as usize],
                surface.pos[b[2] as usize],
            );
            let da = (ca[0] - 20.0).powi(2) + (ca[1] - 8.0).powi(2) + ca[2].powi(2);
            let db = (cb[0] - 20.0).powi(2) + (cb[1] - 8.0).powi(2) + cb[2].powi(2);
            da.total_cmp(&db)
        })
        .map(|(i, _)| i as u32)
        .expect("triangle");
    let origin = surface.centroid(start);
    let summarize = |name: &str, pts: &[[f64; 3]]| {
        let min_y = pts.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
        let max_z = pts.iter().map(|p| p[2]).fold(0.0_f64, f64::max);
        let (min_x, max_x) = pts.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p[0]), b.max(p[0])));
        let last = pts.last().copied().unwrap_or(origin);
        log(&format!(
            "trace {name}: {} points, x [{min_x:.2},{max_x:.2}], min y {min_y:.3}, max z {max_z:.3}, last ({:.2},{:.2},{:.2}), from ({:.2},{:.2},{:.2})",
            pts.len(), last[0], last[1], last[2], origin[0], origin[1], origin[2]
        ));
    };
    let candidates = {
        let tracer = Tracer {
            s: &surface,
            field: &field,
            blocked: &blocked,
            rules: &rules,
            max_length: 200.0,
        };
        let (straight, _) = tracer.follow(start, origin, [0.0, -1.0, 0.0]);
        let (diagonal, _) = tracer.follow(start, origin, normalize([0.2, -1.0, 0.0]).expect("heading"));
        summarize("field, square into the crease", &straight);
        summarize("field, diagonal into the crease", &diagonal);
        tracer.candidates()
    };
    let mut floor_only = 0usize;
    let mut wall_only = 0usize;
    let mut both = 0usize;
    for c in &candidates {
        let on_floor = c.points.iter().any(|p| p[2] < 0.5 && p[1] > 0.5);
        let on_wall = c.points.iter().any(|p| p[2] > 1.0);
        match (on_floor, on_wall) {
            (true, true) => both += 1,
            (false, true) => wall_only += 1,
            (true, false) => floor_only += 1,
            (false, false) => {}
        }
    }
    log(&format!(
        "L candidates {}: {} floor only, {} wall only, {} with points on both. Loaded floor area {area:.1} mm²",
        candidates.len(),
        floor_only,
        wall_only,
        both
    ));
    for flag in &mut field.confident {
        *flag = false;
    }
    let long_rules = TraceRules { spacing: 80.0, min_length: 4.0, tolerance: 0.2 };
    let straight_tracer = Tracer {
        s: &surface,
        field: &field,
        blocked: &blocked,
        rules: &long_rules,
        max_length: 200.0,
    };
    let (straight, _) = straight_tracer.follow(start, origin, [0.0, -1.0, 0.0]);
    let (diagonal, _) = straight_tracer.follow(start, origin, normalize([0.2, -1.0, 0.0]).expect("heading"));
    summarize("straight, square into the crease", &straight);
    summarize("straight, diagonal into the crease", &diagonal);

    let box_mesh = box_shell(false, 8.0);
    let box_holds = clamp_where(&box_mesh, |p| near(p[2], BOX_Z1));
    let box_model = ShellModel::new(
        box_mesh,
        IsotropicShell::new(E_MPA, NU).expect("material"),
        &box_holds,
        ShellOptions::default(),
    )
    .unwrap_or_else(|e| panic!("{}", e.message));
    let corner = box_model.mesh().nearest_vertex([BOX_X0, BOX_Y0, BOX_Z0]) as usize;
    let cn = box_model.vertex_normals()[corner];
    let cp = box_model.mesh().vertices[corner];
    log(&format!(
        "box corner ({:.3},{:.3},{:.3}) normal ({:.4},{:.4},{:.4}), angle to +z {:.2}°, to +x {:.2}°, to +y {:.2}°",
        cp[0], cp[1], cp[2], cn[0], cn[1], cn[2],
        angle_deg(cn, [0.0, 0.0, 1.0]),
        angle_deg(cn, [1.0, 0.0, 0.0]),
        angle_deg(cn, [0.0, 1.0, 0.0])
    ));
    let edge = box_model.mesh().nearest_vertex([50.0, BOX_Y0, BOX_Z0]) as usize;
    let en = box_model.vertex_normals()[edge];
    let ep = box_model.mesh().vertices[edge];
    log(&format!(
        "box floor/wall crease mid ({:.3},{:.3},{:.3}) normal ({:.4},{:.4},{:.4}), angle to +z {:.2}°, to +y {:.2}°",
        ep[0], ep[1], ep[2], en[0], en[1], en[2],
        angle_deg(en, [0.0, 0.0, 1.0]),
        angle_deg(en, [0.0, 1.0, 0.0])
    ));

    let through = box_shell(true, 8.0);
    let through_s = Surface::new(&through, None);
    let mut degree = [0usize; 6];
    let mut seen = std::collections::HashSet::<(u32, u32)>::new();
    for tri in &through_s.tris {
        for k in 0..3 {
            let (a, b) = (tri[k].min(tri[(k + 1) % 3]), tri[k].max(tri[(k + 1) % 3]));
            if !seen.insert((a, b)) {
                continue;
            }
            let n = through_s.edge_triangles(a, b).len().min(5);
            degree[n] += 1;
        }
    }
    log(&format!(
        "through-floor box edges by triangle count: 1→{} 2→{} 3→{} 4→{} 5+→{}",
        degree[1], degree[2], degree[3], degree[4], degree[5]
    ));
    let tee = ShellMesh {
        vertices: vec![
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [1.0, 1.5, 0.0],
            [1.0, -1.5, 0.0],
            [1.0, 0.0, 1.5],
        ],
        triangles: vec![[0, 1, 2], [0, 3, 1], [0, 1, 4]],
        thickness: vec![2.0; 5],
    };
    let tee_s = Surface::new(&tee, None);
    let around = tee_s.edge_triangles(0, 1);
    log(&format!("T-junction edge 0–1 triangles: {around:?} (len {})", around.len()));
    for &t in around {
        let tri = tee_s.tris[t as usize];
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if (a.min(b), a.max(b)) == (0, 1) {
                log(&format!(
                    "  neighbour of triangle {t} across local edge {k} = {:?}",
                    tee_s.neighbour(t, k)
                ));
            }
        }
    }
    let tee_holds = vec![ShellHold::clamped(2), ShellHold::clamped(3), ShellHold::pinned(0)];
    let mut tee_model = ShellModel::new(
        tee,
        IsotropicShell::new(E_MPA, NU).expect("material"),
        &tee_holds,
        ShellOptions::default(),
    )
    .unwrap_or_else(|e| panic!("T-junction shell refused: {}", e.message));
    tee_model.set_threads(1);
    let tee_r = tee_model
        .solve(&[ShellLoad::Force { node: 4, force: [0.0, 0.0, -1.0] }])
        .unwrap_or_else(|e| panic!("T-junction solve failed: {}", e.message));
    log(&format!(
        "T-junction shell solved: dofs {}, tip uz {:+.6e}, pivot {:.2e}",
        tee_model.free_dofs(),
        tee_r.displacement[4][2],
        tee_r.pivot_ratio
    ));
}

#[test]
fn q1_plate_control() {
    log("\n## Q1 control: clamped 100×60×2 plate, shell against TET10");
    let mut shell_w = Vec::new();
    for h in [4.0, 2.0, 1.0] {
        let nx = even_div(100.0, h);
        let ny = even_div(60.0, h);
        let mesh = ShellMesh::rectangle([100.0, 60.0], [nx, ny], 2.0);
        let holds = clamp_where(&mesh, |p| near(p[0], 0.0) || near(p[0], 100.0) || near(p[1], 0.0) || near(p[1], 60.0));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(mesh, &holds, &case, ShellOptions::default(), [50.0, 30.0, 0.0], PRESSURE * area);
        report_shell("plate shell", 100.0 / nx as f64, &stats);
        shell_w.push((100.0 / nx as f64, stats.w_down));
        if (h - 2.0).abs() < 1e-9 {
            for alpha in [1.0e-4, 1.0] {
                let again = ShellMesh::rectangle([100.0, 60.0], [nx, ny], 2.0);
                let holds = clamp_where(&again, |p| near(p[0], 0.0) || near(p[0], 100.0) || near(p[1], 0.0) || near(p[1], 60.0));
                let (case, area) = floor_load(&again, None, PRESSURE);
                let stats = solve_shell(
                    again,
                    &holds,
                    &case,
                    shell_options(alpha, MembraneKind::Allman),
                    [50.0, 30.0, 0.0],
                    PRESSURE * area,
                );
                log(&format!(
                    "plate drill α={alpha:.0e}: w {:+.6e} ({:+.3}% vs default run at this mesh)",
                    stats.w_down,
                    pct(stats.w_down, shell_w.last().expect("h=2").1)
                ));
            }
        }
    }
    extrapolate("plate shell w", &shell_w);
    let mut solid_w = Vec::new();
    for (h_in, h_th, name) in [(4.0, 2.0, "4 mm, 1 through"), (2.0, 1.0, "2 mm, 2 through"), (1.0, 1.0, "1 mm, 2 through"), (2.0, 0.5, "2 mm, 4 through")] {
        let started = Instant::now();
        let mesh = weld_blocks(&[plate_block(h_in, h_th)]);
        let build_s = started.elapsed().as_secs_f64();
        let faces = faces_window(&mesh, 2, -1.0, |_| true);
        let (loads, area) = traction_of(&faces, [0.0, 0.0, -PRESSURE]);
        let holds = fixed_where(&mesh, |p| near(p[0], 0.0) || near(p[0], 100.0) || near(p[1], 0.0) || near(p[1], 60.0));
        let Some(stats) = solve_solid(mesh, holds, loads, [50.0, 30.0, 0.0], PRESSURE * area, build_s) else {
            continue;
        };
        report_solid("plate solid", name, &stats);
        solid_w.push((h_in, stats.w_down));
        if let Some((_, sw)) = shell_w.iter().min_by(|a, b| a.0.total_cmp(&b.0)) {
            log(&format!(
                "  plate solid vs finest shell: {:+.2}% on centre w",
                pct(stats.w_down, *sw)
            ));
        }
    }
    extrapolate("plate solid w", &solid_w);
}

#[test]
fn q1_box_shell_and_drilling() {
    log("\n## Q1 shell open box 100×60×30, t=2, rim clamped, pressure on the floor");
    log("Centre-line shell: floor between wall centre-lines (98×58 at z=1), walls up to z=30.");
    log("Through-floor shell: floor is the full 100×60, walls meet it in a T-junction.");
    let mut centre_w = Vec::new();
    let mut centre_c = Vec::new();
    for h in [4.0, 2.0, 1.0] {
        let mesh = box_shell(false, h);
        let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(
            mesh,
            &holds,
            &case,
            ShellOptions::default(),
            [50.0, 30.0, BOX_Z0],
            PRESSURE * area,
        );
        report_shell("box centre-line", h, &stats);
        centre_w.push((h, stats.w_down));
        centre_c.push((h, stats.compliance));
    }
    extrapolate("box centre-line w", &centre_w);
    extrapolate("box centre-line C", &centre_c);

    let mut through_w = Vec::new();
    for h in [4.0, 2.0, 1.0] {
        let mesh = box_shell(true, h);
        let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(
            mesh,
            &holds,
            &case,
            ShellOptions::default(),
            [50.0, 30.0, BOX_Z0],
            PRESSURE * area,
        );
        report_shell("box through-floor", h, &stats);
        through_w.push((h, stats.w_down));
    }
    extrapolate("box through-floor w", &through_w);

    log("Drilling penalty on the centre-line box at h≈2, Allman unless noted.");
    let mesh = box_shell(false, 2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
    let (case, area) = floor_load(&mesh, None, PRESSURE);
    let base = solve_shell(
        mesh,
        &holds,
        &case,
        ShellOptions::default(),
        [50.0, 30.0, BOX_Z0],
        PRESSURE * area,
    );
    for alpha in [1.0e-4, 1.0e-3, 1.0e-2, 1.0e-1, 1.0] {
        let mesh = box_shell(false, 2.0);
        let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(
            mesh,
            &holds,
            &case,
            shell_options(alpha, MembraneKind::Allman),
            [50.0, 30.0, BOX_Z0],
            PRESSURE * area,
        );
        log(&format!(
            "box α={alpha:.0e}: w {:+.6e} ({:+.3}% vs α={DRILL_PENALTY:.0e}), C {:.6e} ({:+.3}%)",
            stats.w_down,
            pct(stats.w_down, base.w_down),
            stats.compliance,
            pct(stats.compliance, base.compliance)
        ));
    }
    let mesh = box_shell(false, 2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
    let (case, area) = floor_load(&mesh, None, PRESSURE);
    let cst = solve_shell(
        mesh,
        &holds,
        &case,
        shell_options(DRILL_PENALTY, MembraneKind::Cst),
        [50.0, 30.0, BOX_Z0],
        PRESSURE * area,
    );
    log(&format!(
        "box CST α={DRILL_PENALTY:.0e}: w {:+.6e} ({:+.3}% vs Allman), C {:.6e} ({:+.3}%)",
        cst.w_down,
        pct(cst.w_down, base.w_down),
        cst.compliance,
        pct(cst.compliance, base.compliance)
    ));

    log("Clean right-angle fold: floor 40×24 at z=0, wall up to z=20, thickness 2 centred on those planes.");
    let mut lw = Vec::new();
    for h in [4.0, 2.0, 1.0] {
        let mesh = l_shell(h);
        let holds = clamp_where(&mesh, |p| near(p[2], 20.0));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(mesh, &holds, &case, ShellOptions::default(), [20.0, 12.0, 0.0], PRESSURE * area);
        report_shell("L shell", h, &stats);
        lw.push((h, stats.w_down));
    }
    extrapolate("L shell w", &lw);
    let mesh = l_shell(2.0);
    let holds = clamp_where(&mesh, |p| near(p[2], 20.0));
    let (case, area) = floor_load(&mesh, None, PRESSURE);
    let base = solve_shell(mesh, &holds, &case, ShellOptions::default(), [20.0, 12.0, 0.0], PRESSURE * area);
    for alpha in [1.0e-4, 1.0e-2, 1.0] {
        let mesh = l_shell(2.0);
        let holds = clamp_where(&mesh, |p| near(p[2], 20.0));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let stats = solve_shell(
            mesh,
            &holds,
            &case,
            shell_options(alpha, MembraneKind::Allman),
            [20.0, 12.0, 0.0],
            PRESSURE * area,
        );
        log(&format!(
            "L α={alpha:.0e}: w {:+.6e} ({:+.3}% vs default)",
            stats.w_down,
            pct(stats.w_down, base.w_down)
        ));
    }
}

#[test]
fn q1_box_and_fold_solid() {
    log("\n## Q1 solid open box and the clean L, TET10");
    log("Box solid: floor z[0,2] full plan; x-walls own the corners; y-walls inset. Expected volume 29472 mm³.");
    for (h_in, h_th, name) in [
        (2.0, 2.0, "2 mm, 1 through"),
        (2.0, 1.0, "2 mm in plane, 2 through"),
        (1.0, 1.0, "1 mm, 2 through"),
    ] {
        let started = Instant::now();
        let mesh = weld_blocks(&box_blocks(h_in, h_th));
        let build_s = started.elapsed().as_secs_f64();
        let vol = mesh.volume();
        log(&format!("box solid volume {vol:.2} (expected 29472), build {build_s:.3} s, {} nodes", mesh.nodes.len()));
        assert!((vol - 29472.0).abs() < 1.0, "box volume {vol}");
        let faces = faces_window(&mesh, 2, BOX_T, |c| c[0] > BOX_T && c[0] < BOX_L - BOX_T && c[1] > BOX_T && c[1] < BOX_W - BOX_T);
        let (loads, area) = traction_of(&faces, [0.0, 0.0, -PRESSURE]);
        let holds = fixed_where(&mesh, |p| near(p[2], BOX_H));
        let Some(stats) = solve_solid(mesh, holds, loads, [50.0, 30.0, BOX_Z0], PRESSURE * area, build_s) else {
            continue;
        };
        report_solid("box solid", name, &stats);
    }

    log("Clean L solid: slabs of thickness 2 centred on the mid-surfaces, union, expected volume 3780 mm³.");
    for h in [1.0, 0.5] {
        let started = Instant::now();
        let mesh = weld_blocks(&l_blocks(h));
        let build_s = started.elapsed().as_secs_f64();
        let vol = mesh.volume();
        log(&format!("L solid h={h} volume {vol:.2} (expected 3780), {} nodes, build {build_s:.3} s", mesh.nodes.len()));
        assert!((vol - 3780.0).abs() < 1.0, "L volume {vol}");
        let faces = faces_window(&mesh, 2, -1.0, |c| (0.0..=40.0).contains(&c[0]) && (0.0..=24.0).contains(&c[1]));
        let (loads, area) = traction_of(&faces, [0.0, 0.0, -PRESSURE]);
        let holds = fixed_where(&mesh, |p| near(p[2], 20.0));
        let Some(stats) = solve_solid(mesh, holds, loads, [20.0, 12.0, 0.0], PRESSURE * area, build_s) else {
            continue;
        };
        report_solid("L solid", &format!("h={h}"), &stats);
    }
}

#[test]
fn q4_ribs_at_creases() {
    log("\n## Q4 ribs at the box creases: stop, cross, anchor");
    log(&format!("Rectangular ribs {RIB_W}×{RIB_H} mm on the positive (inward) side."));
    for h in [4.0, 2.0] {
        let mesh = box_shell(false, h);
        let holds = clamp_where(&mesh, |p| near(p[2], BOX_Z1));
        let (case, area) = floor_load(&mesh, None, PRESSURE);
        let force = PRESSURE * area;
        let bare = solve_shell(
            mesh.clone(),
            &holds,
            &case,
            ShellOptions::default(),
            [50.0, 30.0, BOX_Z0],
            force,
        );
        report_shell(&format!("q4 bare h={h}"), h, &bare);
        let y_mid = 0.5 * (BOX_Y0 + BOX_Y1);
        let floor = chain_where(&mesh, |p| near(p[1], y_mid) && near(p[2], BOX_Z0), 0);
        let mut left = chain_where(&mesh, |p| near(p[0], BOX_X0) && near(p[1], y_mid), 2);
        left.reverse();
        let right = chain_where(&mesh, |p| near(p[0], BOX_X1) && near(p[1], y_mid), 2);
        let cross = join_chains(&[left, floor.clone(), right]);
        let anchor = vec![
            chain_where(&mesh, |p| near(p[1], BOX_Y0) && near(p[2], BOX_Z0), 0),
            chain_where(&mesh, |p| near(p[1], BOX_Y1) && near(p[2], BOX_Z0), 0),
            chain_where(&mesh, |p| near(p[0], BOX_X0) && near(p[2], BOX_Z0), 1),
            chain_where(&mesh, |p| near(p[0], BOX_X1) && near(p[2], BOX_Z0), 1),
        ];
        let mut anchor_plus = anchor.clone();
        anchor_plus.push(floor.clone());
        let cases: Vec<(&str, Vec<Vec<u32>>)> = vec![
            ("stop: centre rib on the floor only", vec![floor]),
            ("cross: centre rib up both short walls to the rim", vec![cross]),
            ("anchor: ribs along the four floor creases", anchor),
            ("anchor + the centre rib stopping at the creases", anchor_plus),
        ];
        for (name, chains) in cases {
            let ribs: Vec<Rib> = chains.iter().map(|c| rib_of(c)).collect();
            let (stats, volume) = solve_with_ribs(mesh.clone(), &holds, &case, ribs, [50.0, 30.0, BOX_Z0], force);
            let factor = bare.compliance / stats.compliance;
            let per = if volume > 0.0 {
                (bare.compliance - stats.compliance) / volume
            } else {
                0.0
            };
            log(&format!(
                "h={h} {name}: volume {volume:.1} mm³, w {:+.6e} ({:+.2}% vs bare), C {:.6e}, stiffness ×{factor:.3}, ΔC/mm³ {per:.4}, {} dofs, {:.3} s",
                stats.w_down,
                pct(stats.w_down, bare.w_down),
                stats.compliance,
                stats.dofs,
                stats.seconds
            ));
        }
    }
}

fn energy_by_region(mesh: &ShellMesh, result: &ShellResult) -> (f64, f64, f64) {
    let mut belly = 0.0;
    let mut wall = 0.0;
    let mut rim = 0.0;
    for (t, el) in result.elements.iter().enumerate() {
        let n = tri_normal(mesh, t);
        let c = mesh_centroid(mesh, t);
        let e = el.bending_energy + el.membrane_energy;
        if n[2].abs() > 0.9 {
            if c[2] < 0.5 * (CV_ZB + CV_ZT) {
                belly += e;
            } else {
                rim += e;
            }
        } else {
            wall += e;
        }
    }
    (belly, wall, rim)
}

fn plan_on(mesh: ShellMesh, holds: Holds, case: LoadCase, tag: &str) {
    let mut req = RibPlanRequest::new(mesh, IsotropicShell::new(E_MPA, NU).expect("material"));
    req.holds = holds;
    req.load_cases = vec![case];
    req.goal = Goal::Balanced;
    req.hole_rim_margin = None;
    req.options.baselines = false;
    req.options.workers = 4;
    req.rules = RibRules {
        width: 1.5,
        max_height: 4.0,
        min_height: 1.0,
        min_spacing: 12.0,
        min_length: 8.0,
        side: RibSide::Positive,
        ..RibRules::default()
    };
    let started = Instant::now();
    match plan_ribs(&req) {
        Ok(plan) => {
            let seconds = started.elapsed().as_secs_f64();
            log(&format!(
                "{tag}: {} ribs, volume {:.1} mm³, bare C {:.6e}, ribbed C {:.6e}, ×{:.3}, max |u| {:.4e}, solver s {:.3}, total s {:.3} (wall {:.3}), candidates {} embedded {}",
                plan.ribs.len(),
                plan.rib_volume_mm3,
                plan.bare.compliance,
                plan.ribbed.compliance,
                plan.stiffness_factor,
                plan.ribbed.max_deflection,
                plan.stats.seconds.solver,
                plan.stats.seconds.total,
                seconds,
                plan.stats.candidates,
                plan.stats.embedded_candidates
            ));
            log(&format!(
                "{tag} stages s: bare {:.3} field {:.3} trace {:.3} embed {:.3} select {:.3} connect {:.3} prune {:.3} size {:.3}",
                plan.stats.seconds.bare,
                plan.stats.seconds.field,
                plan.stats.seconds.trace,
                plan.stats.seconds.embed,
                plan.stats.seconds.select,
                plan.stats.seconds.connect,
                plan.stats.seconds.prune,
                plan.stats.seconds.size
            ));
            for (i, rib) in plan.ribs.iter().enumerate() {
                let mut len = [0.0; 4];
                for w in rib.points.windows(2) {
                    let mid = [0, 1, 2].map(|k| 0.5 * (w[0][k] + w[1][k]));
                    let dl = norm(sub(w[1], w[0]));
                    let slot = match cover_point_region(mid) {
                        "belly" => 0,
                        "wall" => 1,
                        "rim" => 2,
                        _ => 3,
                    };
                    len[slot] += dl;
                }
                let total = len.iter().sum::<f64>().max(1e-9);
                let c = rib.points.iter().fold([0.0; 3], |a, p| [0, 1, 2].map(|k| a[k] + p[k]));
                let n = rib.points.len().max(1) as f64;
                let c = [0, 1, 2].map(|k| c[k] / n);
                log(&format!(
                    "  rib {i}: len {:.1} ({:.0}% belly, {:.0}% wall, {:.0}% rim, {:.0}% joint), centroid ({:.1},{:.1},{:.1}), h {:.2}, gain {:.3}, ends {:?}/{:?}",
                    rib.length_mm,
                    100.0 * len[0] / total,
                    100.0 * len[1] / total,
                    100.0 * len[2] / total,
                    100.0 * len[3] / total,
                    c[0], c[1], c[2],
                    rib.height,
                    rib.gain,
                    rib.ends[0],
                    rib.ends[1]
                ));
            }
        }
        Err(e) => log(&format!("{tag} FAILED: {}", e.message)),
    }
}

#[test]
fn q3_cover_and_q5_cost() {
    log("\n## Q3 and Q5 synthetic cover: belly, side walls, rim");
    log("Shell meets at wall centre-lines. Solid walls are 2 mm slabs butt-joined to a 6 mm outward rim. Difference is about t/2 = 1 mm.");
    let mut rows = Vec::new();
    for h in [4.0, 2.0] {
        let belly = belly_shell(h);
        let holds = clamp_where(&belly, |p| {
            near(p[0], CV_X0) || near(p[0], CV_X1) || near(p[1], CV_Y0) || near(p[1], CV_Y1)
        });
        let (case, area) = floor_load(&belly, None, PRESSURE);
        let stats = solve_shell(
            belly,
            &holds,
            &case,
            ShellOptions::default(),
            [40.0, 24.0, CV_ZB],
            PRESSURE * area,
        );
        report_shell("cover one-wall clamped", h, &stats);
        rows.push(("one-wall", h, stats.dofs, stats.seconds, stats.w_down, stats.compliance));

        let cover = cover_shell(h);
        let holds = clamp_where(&cover, |p| {
            near(p[0], CV_X0 - CV_RIM)
                || near(p[0], CV_X1 + CV_RIM)
                || near(p[1], CV_Y0 - CV_RIM)
                || near(p[1], CV_Y1 + CV_RIM)
        });
        log(&format!("cover h={h}: {} rim vertices clamped", holds.len()));
        // Pressure on the belly only. The rim is also flat, and a window-less
        // load would press it too.
        let belly = Some([CV_X0, CV_X1, CV_Y0, CV_Y1]);
        let (case, area) = floor_load(&cover, belly, PRESSURE);
        let nodes = cover.vertices.len();
        let tris = cover.triangles.len();
        let started = Instant::now();
        let mut model = ShellModel::new(
            cover.clone(),
            IsotropicShell::new(E_MPA, NU).expect("material"),
            &holds,
            ShellOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{}", e.message));
        model.set_threads(4);
        let result = model.solve(&case).unwrap_or_else(|e| panic!("{}", e.message));
        let seconds = started.elapsed().as_secs_f64();
        let (belly_e, wall_e, rim_e) = energy_by_region(&cover, &result);
        let sum = (belly_e + wall_e + rim_e).max(1e-15);
        log(&format!(
            "cover energy: belly {:.1}%, wall {:.1}%, rim {:.1}%",
            100.0 * belly_e / sum,
            100.0 * wall_e / sum,
            100.0 * rim_e / sum
        ));
        let v = model.mesh().nearest_vertex([40.0, 24.0, CV_ZB]) as usize;
        let at = model.mesh().vertices[v];
        let stats = stats_from(
            &model,
            &result,
            nodes,
            tris,
            seconds,
            PRESSURE * area,
            -result.displacement[v][2],
            at,
        );
        report_shell("cover folded shell", h, &stats);
        rows.push(("folded", h, stats.dofs, stats.seconds, stats.w_down, stats.compliance));

        // A thick patch standing in for a boss, and the same patch capped at 3× the wall.
        let mut thick = cover.clone();
        let mut capped = cover.clone();
        for (i, p) in cover.vertices.iter().enumerate() {
            if (p[2] - CV_ZB).abs() < 0.3 && (p[0] - 40.0).hypot(p[1] - 24.0) <= 8.0 {
                thick.thickness[i] = 8.0;
                capped.thickness[i] = 6.0;
            }
        }
        let (case, area) = floor_load(&thick, belly, PRESSURE);
        let thick_s = solve_shell(thick, &holds, &case, ShellOptions::default(), [40.0, 24.0, CV_ZB], PRESSURE * area);
        let (case, area) = floor_load(&capped, belly, PRESSURE);
        let cap_s = solve_shell(capped, &holds, &case, ShellOptions::default(), [40.0, 24.0, CV_ZB], PRESSURE * area);
        log(&format!(
            "h={h} centre patch r=8 mm at 8 mm thick: w {:+.6e} ({:+.2}% vs uniform 2 mm). Capped at 6 mm (3× median): w {:+.6e} ({:+.2}% vs the real 8 mm)",
            thick_s.w_down,
            pct(thick_s.w_down, stats.w_down),
            cap_s.w_down,
            pct(cap_s.w_down, thick_s.w_down)
        ));
    }

    log("Planner, balanced, baselines off, spacing 12 mm, ribs 1.5×4 mm. One wall against the folded cover.");
    for h in [4.0, 2.0] {
        let belly = belly_shell(h);
        let (case, _) = floor_load(&belly, None, PRESSURE);
        plan_on(belly, Holds::AllBoundaryClamped, case, &format!("one-wall plan h={h}"));
        let cover = cover_shell(h);
        let (case, _) = floor_load(&cover, Some([CV_X0, CV_X1, CV_Y0, CV_Y1]), PRESSURE);
        plan_on(cover, Holds::AllBoundaryClamped, case, &format!("folded plan h={h}"));
    }

    log("Cover solid. Expected volume 16992 mm³.");
    for (h_in, h_th, name) in [(2.0, 2.0, "2 mm, 1 through"), (2.0, 1.0, "2 mm in plane, 2 through"), (1.0, 1.0, "1 mm, 2 through")] {
        let started = Instant::now();
        let mesh = weld_blocks(&cover_blocks(h_in, h_th));
        let build_s = started.elapsed().as_secs_f64();
        let vol = mesh.volume();
        log(&format!("cover solid volume {vol:.2} (expected 16992), {} nodes, build {build_s:.3} s", mesh.nodes.len()));
        assert!((vol - 16992.0).abs() < 1.0, "cover volume {vol}");
        let faces = faces_window(&mesh, 2, CV_T, |c| {
            c[0] > CV_T && c[0] < CV_L - CV_T && c[1] > CV_T && c[1] < CV_W - CV_T
        });
        let (loads, area) = traction_of(&faces, [0.0, 0.0, -PRESSURE]);
        let holds = fixed_where(&mesh, |p| {
            near(p[0], -CV_RIM) || near(p[0], CV_L + CV_RIM) || near(p[1], -CV_RIM) || near(p[1], CV_W + CV_RIM)
        });
        let Some(stats) = solve_solid(mesh, holds, loads, [40.0, 24.0, CV_ZB], PRESSURE * area, build_s) else {
            continue;
        };
        report_solid("cover solid", name, &stats);
    }
    log("Q5 cost rows (shells already printed above):");
    for (name, h, dofs, seconds, w, c) in &rows {
        log(&format!("| {name} | h={h} | {dofs} dofs | {seconds:.3} s | w {w:+.6e} | C {c:.6e} |"));
    }
}
