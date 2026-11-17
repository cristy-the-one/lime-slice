//! Textbook checks of the shell elements: square plates (Timoshenko &
//! Woinowsky-Krieger), a cantilever strip, patch tests, rigid modes, the
//! Scordelis–Lo roof and the principal bending direction of a plate bent
//! one way. Each prints its convergence rows; run with `--nocapture` to
//! see them.

// Vector components are indexed on purpose, as in the crate.
#![allow(clippy::needless_range_loop)]

mod shell_common;

use lime_sim::shell::{MembraneKind, ShellHold, ShellLoad, ShellMesh, ShellModel, ShellOptions};
use shell_common::*;

const E: f64 = 2000.0;
const NU: f64 = 0.3;

/// Navier's series for the centre of a simply supported square plate
/// under uniform pressure: `w = α q a⁴ / D`.
fn navier_alpha() -> f64 {
    let pi = std::f64::consts::PI;
    let mut s = 0.0;
    for m in (1..400).step_by(2) {
        for n in (1..400).step_by(2) {
            let sign = if ((m + n) / 2 - 1) % 2 == 0 {
                1.0
            } else {
                -1.0
            };
            let (m, n) = (m as f64, n as f64);
            s += sign / (m * n * (m * m + n * n).powi(2));
        }
    }
    16.0 / pi.powi(6) * s
}

#[test]
fn navier_series_matches_the_table() {
    // Timoshenko & Woinowsky-Krieger quote 0.00406.
    let alpha = navier_alpha();
    assert!((alpha - 0.00406235).abs() < 1e-7, "{alpha}");
}

/// Centre deflection of a square plate for each mesh, as fractions of
/// the reference.
fn square_plate(edge: Edge, point: bool, reference_alpha: f64, label: &str) -> Vec<f64> {
    let (a, t) = (100.0, 1.0);
    let d = rigidity(E, NU, t);
    let (q, p) = (0.001, 10.0);
    let reference = if point {
        reference_alpha * p * a * a / d
    } else {
        reference_alpha * q * a.powi(4) / d
    };
    let mut errors = Vec::new();
    for n in [4, 8, 16, 32, 64] {
        let mut model = plate_model(a, t, n, material(E, NU), edge, ShellOptions::default());
        let centre = [0.5 * a, 0.5 * a, 0.0];
        let case = if point {
            vec![ShellLoad::Force {
                node: model.mesh().nearest_vertex(centre),
                force: [0.0, 0.0, -p],
            }]
        } else {
            pressure(model.mesh(), q)
        };
        let r = model.solve(&case).unwrap();
        let w = -centre_w(&model, &r.displacement, centre);
        errors.push(row(label, &format!("{n}×{n}×2"), w, reference));
        // Every load's work is stored as strain energy.
        assert!((r.compliance - 2.0 * r.strain_energy).abs() < 1e-9 * r.compliance);
    }
    errors
}

#[test]
fn simply_supported_square_plate_under_pressure() {
    let errors = square_plate(Edge::Simple, false, navier_alpha(), "SS plate, pressure");
    // Converging, and within 0.5 % from 16 × 16.
    assert!(errors[2].abs() < 5e-3, "{errors:?}");
    assert!(errors[4].abs() < 1e-3, "{errors:?}");
    assert!(errors[4].abs() < errors[1].abs());
}

/// The table's three figures carry ±0.4 % of their own; each clamped case
/// is also checked against the value to more figures (0.0012653 and
/// 0.005612, which a Richardson extrapolation of the 16–32–64 rows here
/// reproduces to four figures).
#[test]
fn clamped_square_plate_under_pressure() {
    let table = square_plate(
        Edge::Clamped,
        false,
        0.00126,
        "clamped plate, pressure (0.00126)",
    );
    let errors = square_plate(
        Edge::Clamped,
        false,
        0.0012653,
        "clamped plate, pressure (0.0012653)",
    );
    assert!(table[4].abs() < 0.006, "{table:?}");
    assert!(errors[2].abs() < 0.01, "{errors:?}");
    assert!(errors[4].abs() < 0.002, "{errors:?}");
}

#[test]
fn clamped_square_plate_under_a_point_load() {
    let table = square_plate(
        Edge::Clamped,
        true,
        0.00560,
        "clamped plate, centre load (0.00560)",
    );
    let errors = square_plate(
        Edge::Clamped,
        true,
        0.005612,
        "clamped plate, centre load (0.005612)",
    );
    assert!(table[4].abs() < 0.006, "{table:?}");
    assert!(errors[2].abs() < 0.015, "{errors:?}");
    assert!(errors[4].abs() < 0.002, "{errors:?}");
}

/// A strip clamped at x = 0, a line load P across its free end. With ν = 0
/// a wide strip is a beam: `w = P L³ / (3 E I)`, `I = b t³ / 12`.
#[test]
fn cantilever_strip_under_an_end_load() {
    let (l, b, t, p): (f64, f64, f64, f64) = (100.0, 10.0, 1.0, 1.0);
    let reference = p * l.powi(3) / (3.0 * E * b * t.powi(3) / 12.0);
    let mut errors = Vec::new();
    for (nx, ny) in [(5, 1), (10, 2), (20, 4), (40, 8)] {
        let mesh = ShellMesh::rectangle([l, b], [nx, ny], t);
        let holds: Vec<ShellHold> = (0..mesh.vertices.len())
            .filter(|&i| mesh.vertices[i][0].abs() < TOL)
            .map(|i| ShellHold::clamped(i as u32))
            .collect();
        let mut case = Vec::new();
        for (i, v) in mesh.vertices.iter().enumerate() {
            if (v[0] - l).abs() < TOL {
                let share = if v[1].abs() < TOL || (v[1] - b).abs() < TOL {
                    0.5
                } else {
                    1.0
                };
                case.push(ShellLoad::Force {
                    node: i as u32,
                    force: [0.0, 0.0, -p * share / ny as f64],
                });
            }
        }
        let mut model =
            ShellModel::new(mesh, material(E, 0.0), &holds, ShellOptions::default()).unwrap();
        let r = model.solve(&case).unwrap();
        let tip: Vec<f64> = model
            .mesh()
            .vertices
            .iter()
            .zip(&r.displacement)
            .filter(|(v, _)| (v[0] - l).abs() < TOL)
            .map(|(_, d)| -d[2])
            .collect();
        let w = tip.iter().sum::<f64>() / tip.len() as f64;
        errors.push(row(
            "cantilever strip, ν = 0",
            &format!("{nx}×{ny}×2"),
            w,
            reference,
        ));
    }
    // DKT is not exact for the cubic: second order, 0.2 % on 5 elements.
    assert!(errors.iter().all(|e| e.abs() < 2e-3), "{errors:?}");
    assert!(errors[3].abs() < 1e-4, "{errors:?}");
    for k in 1..errors.len() {
        assert!(errors[k].abs() < 0.3 * errors[k - 1].abs(), "{errors:?}");
    }
}

/// A distorted patch on a tilted plane. Boundary vertices are held on an
/// exact field; inner vertices must land on it and every element must
/// carry the field's constant forces or moments.
fn tilted_patch() -> (ShellMesh, Vec<bool>, [[f64; 3]; 3]) {
    let mut mesh = ShellMesh::rectangle([2.0, 1.0], [4, 3], 0.1);
    let mut boundary = Vec::new();
    for v in mesh.vertices.iter_mut() {
        let edge = v[0].abs() < TOL
            || (v[0] - 2.0).abs() < TOL
            || v[1].abs() < TOL
            || (v[1] - 1.0).abs() < TOL;
        if !edge {
            // Deterministic, uneven nudges.
            let (x, y) = (v[0], v[1]);
            v[0] += 0.13 * (3.1 * x + 1.7 * y).sin();
            v[1] += 0.09 * (2.3 * x - 4.1 * y).cos();
        }
        boundary.push(edge);
    }
    // Rows: the patch's own axes in global coordinates.
    let q = {
        let e1 = normalise([0.8, 0.3, 0.52]);
        let tmp = normalise([-0.2, 1.0, 0.1]);
        let n = normalise(cross(e1, tmp));
        let e2 = cross(n, e1);
        [e1, e2, n]
    };
    for v in mesh.vertices.iter_mut() {
        *v = to_global(&q, *v);
    }
    (mesh, boundary, q)
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalise(a: [f64; 3]) -> [f64; 3] {
    let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    [a[0] / n, a[1] / n, a[2] / n]
}

fn to_global(q: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    let mut g = [0.0; 3];
    for k in 0..3 {
        for i in 0..3 {
            g[i] += q[k][i] * v[k];
        }
    }
    g
}

fn to_local(q: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|k| q[k][0] * v[0] + q[k][1] * v[1] + q[k][2] * v[2])
}

/// `field(x, y)` in patch axes gives (translation, rotation) in patch axes.
fn run_patch(
    kind: MembraneKind,
    field: impl Fn(f64, f64) -> ([f64; 3], [f64; 3]),
) -> (ShellModel, lime_sim::shell::ShellResult, [[f64; 3]; 3]) {
    let (mesh, boundary, q) = tilted_patch();
    let mut holds = Vec::new();
    for (i, v) in mesh.vertices.iter().enumerate() {
        if boundary[i] {
            let p = to_local(&q, *v);
            let (u, r) = field(p[0], p[1]);
            let (u, r) = (to_global(&q, u), to_global(&q, r));
            holds.push(ShellHold {
                node: i as u32,
                dofs: [u[0], u[1], u[2], r[0], r[1], r[2]].map(Some),
            });
        }
    }
    let options = ShellOptions {
        membrane: kind,
        ..ShellOptions::default()
    };
    let mut model = ShellModel::new(mesh, material(E, NU), &holds, options).unwrap();
    let r = model.solve(&[]).unwrap();
    (model, r, q)
}

#[test]
fn membrane_patch_test() {
    let (ex, ey, gxy) = (2e-3, -5e-4, 8e-4);
    let w = 3e-4; // a rigid in-plane turn on top
    let field = |x: f64, y: f64| {
        let u = ex * x + 0.5 * gxy * y - w * y;
        let v = ey * y + 0.5 * gxy * x + w * x;
        ([u, v, 0.0], [0.0, 0.0, w])
    };
    for kind in [MembraneKind::Allman, MembraneKind::Cst] {
        let (model, r, q) = run_patch(kind, field);
        let mut worst = 0.0_f64;
        for (i, v) in model.mesh().vertices.iter().enumerate() {
            let p = to_local(&q, *v);
            let want = to_global(&q, field(p[0], p[1]).0);
            for k in 0..3 {
                worst = worst.max((r.displacement[i][k] - want[k]).abs());
            }
        }
        assert!(worst < 1e-12, "{kind:?}: displacement off by {worst}");
        // N = A ε, the same in every element; compare as global tensors
        // through the principal values.
        let c = E * 0.1 / (1.0 - NU * NU);
        let n = [
            c * (ex + NU * ey),
            c * (ey + NU * ex),
            c * 0.5 * (1.0 - NU) * gxy,
        ];
        let mean = 0.5 * (n[0] + n[1]);
        let rad = (0.25 * (n[0] - n[1]).powi(2) + n[2] * n[2]).sqrt();
        for e in &r.elements {
            let got = [e.membrane_force.major, e.membrane_force.minor];
            let mut want = [mean + rad, mean - rad];
            if want[1].abs() > want[0].abs() {
                want.swap(0, 1);
            }
            for k in 0..2 {
                assert!(
                    (got[k] - want[k]).abs() < 1e-9,
                    "{kind:?}: {got:?} vs {want:?}"
                );
            }
            assert!(e.bending_energy.abs() < 1e-20);
        }
        eprintln!("| membrane patch, {kind:?} | 24 distorted facets, tilted | max |u − exact| {worst:.1e} | 0 |");
    }
}

#[test]
fn bending_patch_test() {
    let (p, qq, s) = (1e-3, -4e-4, 6e-4); // w = ½p x² + ½q y² + s x y
    let field = |x: f64, y: f64| {
        let w = 0.5 * p * x * x + 0.5 * qq * y * y + s * x * y;
        // θx = ∂w/∂y, θy = −∂w/∂x.
        ([0.0, 0.0, w], [qq * y + s * x, -(p * x + s * y), 0.0])
    };
    let (model, r, q) = run_patch(MembraneKind::Allman, field);
    let mut worst = 0.0_f64;
    for (i, v) in model.mesh().vertices.iter().enumerate() {
        let pl = to_local(&q, *v);
        let want = to_global(&q, field(pl[0], pl[1]).0);
        for k in 0..3 {
            worst = worst.max((r.displacement[i][k] - want[k]).abs());
        }
    }
    assert!(worst < 1e-12, "displacement off by {worst}");
    let d = rigidity(E, NU, 0.1);
    let m = [-d * (p + NU * qq), -d * (qq + NU * p), -d * (1.0 - NU) * s];
    let mean = 0.5 * (m[0] + m[1]);
    let rad = (0.25 * (m[0] - m[1]).powi(2) + m[2] * m[2]).sqrt();
    let mut want = [mean + rad, mean - rad];
    if want[1].abs() > want[0].abs() {
        want.swap(0, 1);
    }
    for e in &r.elements {
        let got = [e.bending_moment.major, e.bending_moment.minor];
        for k in 0..2 {
            assert!(
                (got[k] - want[k]).abs() < 1e-8 * want[0].abs(),
                "{got:?} vs {want:?}"
            );
        }
    }
    eprintln!(
        "| bending patch (DKT) | 24 distorted facets, tilted | max |u − exact| {worst:.1e} | 0 |"
    );
}

/// A free curved shell has exactly six zero-energy modes, with a rib on it
/// or not, and rigid motion stores no energy.
#[test]
fn a_free_shell_has_six_rigid_modes() {
    let mesh = cylinder_patch(20.0, 30.0, 70f64.to_radians(), [4, 3], 1.0);
    for kind in [MembraneKind::Allman, MembraneKind::Cst] {
        for with_rib in [false, true] {
            let options = ShellOptions {
                membrane: kind,
                ..ShellOptions::default()
            };
            let mut model = ShellModel::new(mesh.clone(), material(E, NU), &[], options).unwrap();
            if with_rib {
                // Along the axis on the second row of vertices.
                let edges = (0..4).map(|i| (5 + i, 5 + i + 1)).collect();
                model
                    .add_rib(lime_sim::shell::Rib {
                        edges,
                        section: lime_sim::shell::RibSection::rectangular(1.2),
                        height: 5.0,
                        side: lime_sim::shell::RibSide::Positive,
                    })
                    .unwrap();
            }
            let (n, upper) = model.stiffness_upper();
            let k = faer::Mat::<f64>::from_fn(n, n, |_, _| 0.0);
            let mut k = k;
            for (r, c, v) in &upper {
                k[(*r, *c)] += v;
                if r != c {
                    k[(*c, *r)] += v;
                }
            }
            let ev = k.self_adjoint_eigenvalues(faer::Side::Lower).unwrap();
            let top = ev.iter().cloned().fold(0.0, f64::max);
            let zero = ev.iter().filter(|v| v.abs() < 1e-10 * top).count();
            let smallest_kept = ev
                .iter()
                .cloned()
                .filter(|v| v.abs() >= 1e-10 * top)
                .fold(f64::INFINITY, f64::min);
            eprintln!(
                "| free cylinder patch, {kind:?}, rib {with_rib} | {} dofs | zero modes {zero} | smallest other λ/λmax {:.1e} |",
                n,
                smallest_kept / top
            );
            assert_eq!(zero, 6, "{kind:?} rib {with_rib}");
            // A rigid motion: translation plus a turn about a point.
            let (t, w) = ([0.3, -0.2, 0.1], [0.02, -0.01, 0.03]);
            let mut u = vec![0.0; n];
            let nv = model.mesh().vertices.len();
            for (i, p) in model.mesh().vertices.iter().enumerate() {
                let r = cross(w, *p);
                for c in 0..3 {
                    u[6 * i + c] = t[c] + r[c];
                    u[6 * i + 3 + c] = w[c];
                }
            }
            // Each rib web rotation turns with the body: ψ = ω · its axis.
            for (k, (_, axis, free)) in model.web_rotations().iter().enumerate() {
                assert!(free);
                u[6 * nv + k] = w[0] * axis[0] + w[1] * axis[1] + w[2] * axis[2];
            }
            assert_eq!(u.len(), 6 * nv + model.web_rotations().len());
            let mut energy = 0.0;
            for (r, c, v) in &upper {
                let m = if r == c { 1.0 } else { 2.0 };
                energy += 0.5 * m * u[*r] * v * u[*c];
            }
            assert!(energy.abs() < 1e-9 * top, "{energy}");
        }
    }
}

/// A cylinder piece about the x axis: radius r, length l, `angle` total,
/// symmetric about the top (+z). Normals point outward.
fn cylinder_patch(r: f64, l: f64, angle: f64, div: [usize; 2], t: f64) -> ShellMesh {
    let [nx, nt] = div;
    let mut mesh = ShellMesh::rectangle([l, angle], [nx, nt], t);
    for v in mesh.vertices.iter_mut() {
        let phi = v[1] - 0.5 * angle;
        *v = [v[0], -r * phi.sin(), r * phi.cos()];
    }
    mesh
}

/// The Scordelis–Lo roof: R = 25, L = 50, 40° half-angle, t = 0.25,
/// E = 4.32e8, ν = 0, 90 per unit area of self weight; ends on rigid
/// diaphragms (uy = uz = 0), long edges free. Reference: 0.3024 down at the
/// middle of a free edge (MacNeal & Harder 1985).
#[test]
fn scordelis_lo_roof() {
    let (r, l, t) = (25.0, 50.0, 0.25);
    let angle = 80f64.to_radians();
    let reference = 0.3024;
    let mut results = Vec::new();
    for kind in [MembraneKind::Allman, MembraneKind::Cst] {
        for n in [4, 8, 16, 32, 64] {
            let mesh = cylinder_patch(r, l, angle, [n, n], t);
            let mut holds = Vec::new();
            for (i, v) in mesh.vertices.iter().enumerate() {
                if v[0].abs() < TOL || (v[0] - l).abs() < TOL {
                    holds.push(ShellHold::fixed(
                        i as u32,
                        [false, true, true, false, false, false],
                    ));
                } else if (v[0] - 0.5 * l).abs() < TOL && v[1].abs() < TOL {
                    // The mid-span crown cannot move along the axis by symmetry.
                    holds.push(ShellHold::fixed(
                        i as u32,
                        [true, false, false, false, false, false],
                    ));
                }
            }
            let area = r * angle * l;
            let case = vec![ShellLoad::SpreadForce {
                triangles: every_triangle(&mesh),
                force: [0.0, 0.0, -90.0 * area],
            }];
            let options = ShellOptions {
                membrane: kind,
                ..ShellOptions::default()
            };
            let mut model = ShellModel::new(mesh, material(4.32e8, 0.0), &holds, options).unwrap();
            let res = model.solve(&case).unwrap();
            let edge = model.mesh().nearest_vertex([
                0.5 * l,
                r * (0.5 * angle).sin(),
                r * (0.5 * angle).cos(),
            ]);
            let w = -res.displacement[edge as usize][2];
            let err = row(
                &format!("Scordelis–Lo, {kind:?}"),
                &format!("{n}×{n}×2"),
                w,
                reference,
            );
            results.push((kind, n, err));
        }
    }
    let allman_finest = results
        .iter()
        .find(|(k, n, _)| *k == MembraneKind::Allman && *n == 64)
        .unwrap()
        .2;
    assert!(allman_finest.abs() < 0.03, "{results:?}");
}

/// The drilling penalty factor barely moves the answers.
#[test]
fn the_drilling_penalty_is_not_a_tuning_knob() {
    let (a, t) = (100.0, 1.0);
    let mut values = Vec::new();
    for alpha in [1e-4, 1e-3, 1e-2, 1e-1, 1.0] {
        let options = ShellOptions {
            drill_penalty: alpha,
            ..ShellOptions::default()
        };
        let mut model = plate_model(a, t, 16, material(E, NU), Edge::Simple, options);
        let case = pressure(model.mesh(), 1e-3);
        let res = model.solve(&case).unwrap();
        let w = -centre_w(&model, &res.displacement, [50.0, 50.0, 0.0]);
        // A curved case, where membrane and bending couple.
        let mesh = cylinder_patch(25.0, 50.0, 80f64.to_radians(), [16, 16], 0.25);
        let holds: Vec<ShellHold> = mesh
            .vertices
            .iter()
            .enumerate()
            .filter(|(_, v)| v[0].abs() < TOL || (v[0] - 50.0).abs() < TOL)
            .map(|(i, _)| ShellHold::fixed(i as u32, [false, true, true, false, false, false]))
            .chain(std::iter::once(ShellHold::fixed(
                mesh.nearest_vertex([25.0, 0.0, 25.0]),
                [true, false, false, false, false, false],
            )))
            .collect();
        let case = vec![ShellLoad::SpreadForce {
            triangles: every_triangle(&mesh),
            force: [0.0, 0.0, -1.0],
        }];
        let mut roof = ShellModel::new(mesh, material(4.32e8, 0.0), &holds, options).unwrap();
        let rr = roof.solve(&case).unwrap();
        eprintln!(
            "| α = {alpha:.0e} | plate w {w:.6e} | roof energy {:.6e} | pivot ratio {:.1e} |",
            rr.strain_energy, rr.pivot_ratio
        );
        values.push((w, rr.strain_energy));
    }
    let (w0, u0) = values[2];
    for (w, u) in &values {
        assert!((w - w0).abs() < 1e-3 * w0, "{values:?}");
        assert!((u - u0).abs() < 0.01 * u0, "{values:?}");
    }
}

/// Worst angle between the major bending direction and x over the facets
/// whose centroid passes `inside`, and where it is.
fn worst_angle_to_x(
    nu: f64,
    div: [usize; 2],
    inside: impl Fn([f64; 2]) -> bool,
) -> (f64, [f64; 2], usize, f64) {
    let (a, b, t) = (100.0, 50.0, 1.0);
    let mesh = ShellMesh::rectangle([a, b], div, t);
    let holds: Vec<ShellHold> = mesh
        .vertices
        .iter()
        .enumerate()
        .filter(|(_, v)| v[0].abs() < TOL || (v[0] - a).abs() < TOL)
        .map(|(i, _)| ShellHold::fixed(i as u32, [true, true, true, true, false, false]))
        .collect();
    let mut model =
        ShellModel::new(mesh, material(E, nu), &holds, ShellOptions::default()).unwrap();
    let case = pressure(model.mesh(), 1e-3);
    let r = model.solve(&case).unwrap();
    let mut worst = (0.0_f64, [0.0; 2]);
    let mut count = 0;
    let mut most_isotropic = 0.0_f64;
    for (e, tri) in r.elements.iter().zip(&model.mesh().triangles) {
        let c = [0, 1].map(|k| {
            tri.iter()
                .map(|&v| model.mesh().vertices[v as usize][k])
                .sum::<f64>()
                / 3.0
        });
        if !inside(c) {
            continue;
        }
        let d = e.bending_moment.major_dir;
        let off = d[0].abs().clamp(-1.0, 1.0).acos().to_degrees();
        if off > worst.0 {
            worst = (off, c);
        }
        most_isotropic = most_isotropic.max(e.bending_moment.isotropy);
        count += 1;
    }
    (worst.0, worst.1, count, most_isotropic)
}

/// A 100 × 50 plate held along x = 0 and x = 100 only, under pressure,
/// bends one way: the major bending direction runs along the span.
///
/// With ν = 0 the exact Kirchhoff solution is pure cylindrical bending
/// (w depends on x only and meets the free-edge conditions), so the
/// direction must be x at every facet off the supports, where Mxx → 0.
/// The element's centroid moments carry a small O(h) twist error, which
/// shows most where Mxx is small, next to the supports: the worst facet,
/// at x ≈ 10, is 2.0°, 1.1°, 0.6° off on the three meshes, and the error
/// halves with each refinement. With ν = 0.3 the free edges really do twist the
/// plate (anticlastic bending; the exact solution is Lévy's, not
/// cylindrical), so the check there keeps to the middle half and allows
/// the few degrees the exact field has.
#[test]
fn cylindrical_bending_points_along_the_span() {
    let mut rows = Vec::new();
    for div in [[20, 10], [40, 20], [80, 40]] {
        let off_supports = |c: [f64; 2]| c[0] > 10.0 && c[0] < 90.0;
        let (corner, corner_at, _, _) = worst_angle_to_x(0.0, div, off_supports);
        let off_edges = |c: [f64; 2]| c[0] > 10.0 && c[0] < 90.0 && c[1] > 5.0 && c[1] < 45.0;
        let (w0, at0, n0, iso0) = worst_angle_to_x(0.0, div, off_edges);
        eprintln!(
            "| ν = 0, facets touching a free edge included: worst {corner:.3}° at {corner_at:?} |"
        );
        let middle = |c: [f64; 2]| c[0] > 25.0 && c[0] < 75.0 && c[1] > 12.5 && c[1] < 37.5;
        let (w3, at3, n3, iso3) = worst_angle_to_x(NU, div, middle);
        let (wall, atall, nall, _) = worst_angle_to_x(NU, div, |c| {
            c[0] > 20.0 && c[0] < 80.0 && c[1] > 10.0 && c[1] < 40.0
        });
        eprintln!(
            "| cylindrical bending {}×{}×2 | ν = 0, {n0} facets 10 mm off the supports and 5 mm off the free edges: worst {w0:.4}° at {at0:?}, max isotropy {iso0:.3} | ν = 0.3, middle half ({n3}): worst {w3:.3}° at {at3:?}, max isotropy {iso3:.3} | ν = 0.3, x 20–80, y 10–40 ({nall}): worst {wall:.3}° at {atall:?} |",
            div[0], div[1]
        );
        rows.push((w0, w3, iso0.max(iso3)));
    }
    // ν = 0.3: the rows converge to about 3.6°, so that is the exact
    // field's own twist, not the element's error.
    let (w0, w3, iso) = rows[rows.len() - 1];
    assert!(rows.iter().all(|r| r.0 < 2.5), "{rows:?}");
    assert!(
        rows[1].0 < 0.6 * rows[0].0 && rows[2].0 < 0.6 * rows[1].0,
        "{rows:?}"
    );
    assert!(w0 < 1.0, "{rows:?}");
    assert!(w3 < 4.0, "{rows:?}");
    assert!(iso < 0.5, "{rows:?}");
}
