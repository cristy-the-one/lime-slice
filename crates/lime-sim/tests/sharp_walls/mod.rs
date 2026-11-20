// Synthetic non-folded walls with sharp edges, and an exact text print of
// a plan. The fixtures `sharp_*_v6120_02989e0f.txt` were printed with these
// walls, this request and this print, compiled against origin/main at
// 02989e0f (the v6.12.0 code); `rib_sharp_walls_v6120.rs` checks them.

use std::collections::HashMap;
use std::fmt::Write as _;

use lime_sim::shell::planner::{Goal, RibPlan, RibPlanRequest};
use lime_sim::shell::{IsotropicShell, ShellMesh};

struct Build {
    mesh: ShellMesh,
    index: HashMap<(i64, i64, i64), u32>,
}

impl Build {
    fn new() -> Self {
        Self {
            mesh: ShellMesh::default(),
            index: HashMap::new(),
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
        self.mesh.thickness.push(2.0);
        self.index.insert(key, id);
        id
    }

    /// A sheet through `rows[j][i]`, two triangles per cell, one winding.
    fn sheet(&mut self, rows: &[Vec<[f64; 3]>]) {
        let ids: Vec<Vec<u32>> = rows
            .iter()
            .map(|r| r.iter().map(|&p| self.vertex(p)).collect())
            .collect();
        for j in 0..ids.len() - 1 {
            for i in 0..ids[j].len() - 1 {
                let (a, b, c, d) = (ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
                self.mesh.triangles.push([a, b, c]);
                self.mesh.triangles.push([a, c, d]);
            }
        }
    }
}

fn span(a: f64, b: f64, n: usize) -> Vec<f64> {
    (0..=n)
        .map(|i| {
            if i == n {
                b
            } else {
                a + (b - a) * i as f64 / n as f64
            }
        })
        .collect()
}

/// A profile in (y, z) swept along x from 0 to 60 in 15 steps.
fn extrude(profile: &[[f64; 2]]) -> ShellMesh {
    let xs = span(0.0, 60.0, 15);
    let rows: Vec<Vec<[f64; 3]>> = profile
        .iter()
        .map(|q| xs.iter().map(|&x| [x, q[0], q[1]]).collect())
        .collect();
    let mut b = Build::new();
    b.sheet(&rows);
    b.mesh
}

/// (i) A floor that runs over a radius-3 fillet into a wall: the fillet is
/// three facets of 30°, so four mesh lines turn by more than 20°.
pub fn fillet_wall() -> ShellMesh {
    let mut profile: Vec<[f64; 2]> = Vec::new();
    for y in span(40.0, 3.0, 9) {
        profile.push([y, 0.0]);
    }
    for k in 1..=3 {
        let a = (k as f64) * 30.0_f64.to_radians();
        profile.push([3.0 - 3.0 * a.sin(), 3.0 - 3.0 * a.cos()]);
    }
    for z in span(3.0, 25.0, 6).into_iter().skip(1) {
        profile.push([0.0, z]);
    }
    extrude(&profile)
}

/// (ii) A floor and a wall meeting at 90° along one edge.
pub fn right_angle_wall() -> ShellMesh {
    let mut profile: Vec<[f64; 2]> = Vec::new();
    for y in span(40.0, 0.0, 10) {
        profile.push([y, 0.0]);
    }
    for z in span(0.0, 25.0, 6).into_iter().skip(1) {
        profile.push([0.0, z]);
    }
    extrude(&profile)
}

/// (iii) A floor with a face standing on one of its mesh lines: every edge
/// of that line carries three triangles.
pub fn t_junction_wall() -> ShellMesh {
    let mut b = Build::new();
    let xs = span(0.0, 80.0, 20);
    let ys = span(0.0, 60.0, 14);
    let floor: Vec<Vec<[f64; 3]>> = ys
        .iter()
        .map(|&y| xs.iter().map(|&x| [x, y, 0.0]).collect())
        .collect();
    b.sheet(&floor);
    let wx = span(20.0, 60.0, 10);
    let wz = span(0.0, 15.0, 4);
    let wall: Vec<Vec<[f64; 3]>> = wz
        .iter()
        .map(|&z| wx.iter().map(|&x| [x, 30.0, z]).collect())
        .collect();
    b.sheet(&wall);
    b.mesh
}

/// The request every wall is planned with: all defaults (held all round,
/// even pressure, balanced, baselines on), the material the tool defaults
/// to.
pub fn request(mesh: ShellMesh, goal: Goal) -> RibPlanRequest {
    let mut req = RibPlanRequest::new(mesh, IsotropicShell::new(2000.0, 0.38).unwrap());
    req.goal = goal;
    req.options.baselines = true;
    req.options.workers = 4;
    req
}

/// Each wall planned balanced and to twice the bare stiffness.
pub fn walls() -> Vec<(&'static str, ShellMesh, Goal)> {
    vec![
        ("fillet_balanced", fillet_wall(), Goal::Balanced),
        ("fillet_stiffer2", fillet_wall(), Goal::Stiffer(2.0)),
        ("right_angle_balanced", right_angle_wall(), Goal::Balanced),
        ("right_angle_stiffer2", right_angle_wall(), Goal::Stiffer(2.0)),
        ("t_junction_balanced", t_junction_wall(), Goal::Balanced),
        ("t_junction_stiffer2", t_junction_wall(), Goal::Stiffer(2.0)),
    ]
}

/// Largest dihedral over all edges, degrees, and the count of edges over
/// 20°; and the count of edges with three or more triangles.
pub fn sharpness(mesh: &ShellMesh) -> (f64, usize, usize) {
    let normal = |t: &[u32; 3]| {
        let p = |i: usize| mesh.vertices[t[i] as usize];
        let (a, b, c) = (p(0), p(1), p(2));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        [n[0] / l, n[1] / l, n[2] / l]
    };
    let mut edges: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (e, t) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            edges.entry((a.min(b), a.max(b))).or_default().push(e);
        }
    }
    let (mut max, mut sharp, mut tee) = (0.0_f64, 0, 0);
    for faces in edges.values() {
        if faces.len() > 2 {
            tee += 1;
        }
        let mut worst = 0.0_f64;
        for i in 0..faces.len() {
            for j in i + 1..faces.len() {
                let (a, b) = (normal(&mesh.triangles[faces[i]]), normal(&mesh.triangles[faces[j]]));
                let d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
                worst = worst.max(d.acos().to_degrees());
            }
        }
        if worst > 20.0 {
            sharp += 1;
        }
        max = max.max(worst);
    }
    (max, sharp, tee)
}

fn fnv(h: &mut u64, x: u64) {
    for k in 0..8 {
        *h ^= (x >> (8 * k)) & 0xff;
        *h = h.wrapping_mul(0x100_0000_01b3);
    }
}

/// Every number of the plan a caller reads, each f64 printed so it parses
/// back to the same bits. The plan's mesh is a hash of its bits.
pub fn print(name: &str, plan: &RibPlan) -> String {
    let mut s = String::new();
    let w = &mut s;
    writeln!(w, "wall {name}").unwrap();
    writeln!(
        w,
        "head ribs {} factor {:?} volume {:?} bare {:?} {:?} ribbed {:?} {:?} goal_met {} not_better {} stopped {}",
        plan.ribs.len(),
        plan.stiffness_factor,
        plan.rib_volume_mm3,
        plan.bare.compliance,
        plan.bare.max_deflection,
        plan.ribbed.compliance,
        plan.ribbed.max_deflection,
        plan.goal_met,
        plan.not_better_than_baseline,
        plan.stopped_early
    )
    .unwrap();
    match &plan.thickening {
        Some(t) => writeln!(
            w,
            "thick {:?} {:?} {:?} {}",
            t.added_thickness_mm, t.added_volume_mm3, t.compliance, t.solves
        )
        .unwrap(),
        None => writeln!(w, "thick none").unwrap(),
    }
    match &plan.grid {
        Some(g) => writeln!(
            w,
            "grid {} {:?} {:?} {:?} {:?} {:?} {}",
            g.reached, g.pitch_mm, g.lines, g.grid_volume_mm3, g.compliance, g.volume_mm3, g.solves
        )
        .unwrap(),
        None => writeln!(w, "grid none").unwrap(),
    }
    for l in &plan.loose_ends {
        writeln!(w, "loose {} {} {:?} {:?}", l.rib, l.end, l.point, l.reason).unwrap();
    }
    let mut h = 0xcbf2_9ce4_8422_2325_u64;
    for v in &plan.mesh.vertices {
        for x in v {
            fnv(&mut h, x.to_bits());
        }
    }
    for t in &plan.mesh.triangles {
        for &i in t {
            fnv(&mut h, i as u64);
        }
    }
    for x in &plan.mesh.thickness {
        fnv(&mut h, x.to_bits());
    }
    writeln!(
        w,
        "mesh {} {} {:016x}",
        plan.mesh.vertices.len(),
        plan.mesh.triangles.len(),
        h
    )
    .unwrap();
    for (i, r) in plan.ribs.iter().enumerate() {
        writeln!(
            w,
            "rib {i} h {:?} w {:?} len {:?} vol {:?} gain {:?} share {:?} ends {:?} {:?} {:?} {:?}",
            r.height,
            r.width,
            r.length_mm,
            r.volume_mm3,
            r.gain,
            r.energy_share,
            r.ends[0],
            r.ends[1],
            r.family,
            r.side
        )
        .unwrap();
        writeln!(w, "profile {:?}", r.profile).unwrap();
        for (k, p) in r.points.iter().enumerate() {
            writeln!(w, "pt {:?} {:?} {:?} v {}", p[0], p[1], p[2], r.vertices[k]).unwrap();
        }
        for x in &r.heights {
            writeln!(w, "ht {x:?}").unwrap();
        }
        for x in &r.sections {
            writeln!(w, "sec {x:?}").unwrap();
        }
    }
    s
}
