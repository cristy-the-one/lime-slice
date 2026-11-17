//! The in-plane half of a facet: three nodes, each with u, v and the
//! drilling rotation θz (about the facet normal). Element dof order is
//! `[u0, v0, θz0, u1, v1, θz1, u2, v2, θz2]`.
//!
//! Two elements:
//!
//! - **Allman** (Allman 1984, "A compatible triangular element including
//!   vertex rotations for plane elasticity analysis", Comput. Struct. 19).
//!   The six-node linear-strain triangle with its midside displacements
//!   written in terms of the corners: along edge i→j of length L with
//!   outward normal n, the normal displacement is the cubic through the
//!   corner values with end slopes −θ, whose midpoint value is
//!   `(u_i + u_j)/2 + (L/8)(θ_j − θ_i) n`. Linear strain, so in-plane
//!   bending is far better than the constant-strain triangle, and the
//!   drilling rotation is a real degree of freedom a rib can bend against.
//! - **CST**, the constant-strain triangle, kept to compare against.
//!
//! **Drilling penalty.** Allman's element has one spurious zero-energy mode
//! (equal θz at the three corners, no translation), and the CST has no
//! stiffness on θz at all. Both get the Hughes–Brezzi style penalty
//! `½ α G t ∫ (θz − ω)² dA`, where `ω = ½ (∂v/∂x − ∂u/∂y)` is the
//! continuum's in-plane rotation and `G t` is the section's in-plane shear
//! stiffness `A[2][2]`. It vanishes under every rigid motion and every
//! constant-strain state with θz = ω, so it costs neither the patch test nor
//! the rigid modes. Allman's element takes it at the centroid on the corner
//! mean of θz; the CST at the three corners against its constant ω. `α` is
//! [`super::ShellOptions::drill_penalty`]; the tests sweep it.

use super::geometry::{area_gradients, quadratic_derivatives, EDGES, GAUSS3};
use super::section::Mat3;

pub(crate) type K9 = [[f64; 9]; 9];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MembraneKind {
    /// Allman's triangle with vertex rotations (the default).
    #[default]
    Allman,
    /// The constant-strain triangle with a drilling penalty only.
    Cst,
}

/// Six-node displacements `[u0, v0, …, u5, v5]` from the nine corner dofs.
fn allman_transform(xy: &[[f64; 2]; 3]) -> [[f64; 9]; 12] {
    let mut t = [[0.0; 9]; 12];
    for i in 0..3 {
        t[2 * i][3 * i] = 1.0;
        t[2 * i + 1][3 * i + 1] = 1.0;
    }
    for (m, (i, j)) in EDGES.iter().copied().enumerate() {
        let row = 2 * (3 + m);
        // (L/8) n with n the outward normal of edge i→j of a
        // counter-clockwise triangle: n L = (y_j − y_i, x_i − x_j).
        let nx = (xy[j][1] - xy[i][1]) / 8.0;
        let ny = (xy[i][0] - xy[j][0]) / 8.0;
        t[row][3 * i] = 0.5;
        t[row][3 * j] = 0.5;
        t[row][3 * j + 2] = nx;
        t[row][3 * i + 2] = -nx;
        t[row + 1][3 * i + 1] = 0.5;
        t[row + 1][3 * j + 1] = 0.5;
        t[row + 1][3 * j + 2] = ny;
        t[row + 1][3 * i + 2] = -ny;
    }
    t
}

/// Strain `[εxx, εyy, γxy]` and rotation ω rows over the nine dofs, at
/// area coordinates `l`.
fn allman_rows(xy: &[[f64; 2]; 3], t: &[[f64; 9]; 12], l: [f64; 3]) -> ([[f64; 9]; 3], [f64; 9]) {
    let (dx, dy) = quadratic_derivatives(xy, l);
    let mut b = [[0.0; 9]; 3];
    let mut w = [0.0; 9];
    for k in 0..6 {
        let (ru, rv) = (&t[2 * k], &t[2 * k + 1]);
        for d in 0..9 {
            b[0][d] += dx[k] * ru[d];
            b[1][d] += dy[k] * rv[d];
            b[2][d] += dy[k] * ru[d] + dx[k] * rv[d];
            w[d] += 0.5 * (dx[k] * rv[d] - dy[k] * ru[d]);
        }
    }
    (b, w)
}

/// Strain and rotation rows of the constant-strain triangle.
fn cst_rows(xy: &[[f64; 2]; 3]) -> ([[f64; 9]; 3], [f64; 9]) {
    let (bb, cc, two_a) = area_gradients(xy);
    let mut b = [[0.0; 9]; 3];
    let mut w = [0.0; 9];
    for i in 0..3 {
        b[0][3 * i] = bb[i] / two_a;
        b[1][3 * i + 1] = cc[i] / two_a;
        b[2][3 * i] = cc[i] / two_a;
        b[2][3 * i + 1] = bb[i] / two_a;
        w[3 * i + 1] = 0.5 * bb[i] / two_a;
        w[3 * i] = -0.5 * cc[i] / two_a;
    }
    (b, w)
}

/// `K += s · Bᵀ A B`.
fn add_btdb(k: &mut K9, b: &[[f64; 9]; 3], a: &Mat3, s: f64) {
    let mut db = [[0.0; 9]; 3];
    for r in 0..3 {
        for d in 0..9 {
            db[r][d] = (0..3).map(|q| a[r][q] * b[q][d]).sum();
        }
    }
    for i in 0..9 {
        for j in 0..9 {
            k[i][j] += s * (0..3).map(|r| b[r][i] * db[r][j]).sum::<f64>();
        }
    }
}

/// `K += s · g gᵀ`.
fn add_outer(k: &mut K9, g: &[f64; 9], s: f64) {
    for i in 0..9 {
        for j in 0..9 {
            k[i][j] += s * g[i] * g[j];
        }
    }
}

/// The membrane stiffness of one facet, drilling penalty included. `a` is
/// the section's membrane matrix, `alpha` the drilling penalty factor.
pub(crate) fn stiffness(
    kind: MembraneKind,
    xy: &[[f64; 2]; 3],
    area: f64,
    a: &Mat3,
    alpha: f64,
) -> K9 {
    let mut k = [[0.0; 9]; 9];
    let gt = a[2][2];
    match kind {
        MembraneKind::Allman => {
            let t = allman_transform(xy);
            for l in GAUSS3 {
                let (b, _) = allman_rows(xy, &t, l);
                add_btdb(&mut k, &b, a, area / 3.0);
            }
            let (_, w) = allman_rows(xy, &t, super::geometry::CENTROID);
            let mut g = [0.0; 9];
            for d in 0..9 {
                g[d] = -w[d];
            }
            for i in 0..3 {
                g[3 * i + 2] += 1.0 / 3.0;
            }
            add_outer(&mut k, &g, alpha * gt * area);
        }
        MembraneKind::Cst => {
            let (b, w) = cst_rows(xy);
            add_btdb(&mut k, &b, a, area);
            for i in 0..3 {
                let mut g = [0.0; 9];
                for d in 0..9 {
                    g[d] = -w[d];
                }
                g[3 * i + 2] += 1.0;
                add_outer(&mut k, &g, alpha * gt * area / 3.0);
            }
        }
    }
    k
}

/// `[εxx, εyy, γxy]` at the centroid.
pub(crate) fn centroid_strain(kind: MembraneKind, xy: &[[f64; 2]; 3], u: &[f64; 9]) -> [f64; 3] {
    let b = match kind {
        MembraneKind::Allman => {
            let t = allman_transform(xy);
            allman_rows(xy, &t, super::geometry::CENTROID).0
        }
        MembraneKind::Cst => cst_rows(xy).0,
    };
    let mut e = [0.0; 3];
    for r in 0..3 {
        e[r] = (0..9).map(|d| b[r][d] * u[d]).sum();
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    const XY: [[f64; 2]; 3] = [[0.0, 0.0], [2.0, 0.0], [0.6, 1.5]];

    fn amat() -> Mat3 {
        let (e, nu) = (1000.0, 0.3);
        let c = e / (1.0 - nu * nu);
        [
            [c, c * nu, 0.0],
            [c * nu, c, 0.0],
            [0.0, 0.0, c * 0.5 * (1.0 - nu)],
        ]
    }

    fn energy(k: &K9, u: &[f64; 9]) -> f64 {
        let mut s = 0.0;
        for i in 0..9 {
            for j in 0..9 {
                s += u[i] * k[i][j] * u[j];
            }
        }
        0.5 * s
    }

    /// u = a + ω × r and θz = ω: no energy in either element.
    #[test]
    fn rigid_motion_costs_nothing() {
        for kind in [MembraneKind::Allman, MembraneKind::Cst] {
            let k = stiffness(kind, &XY, 1.5, &amat(), 0.1);
            let (ax, ay, w) = (0.3, -0.2, 0.05);
            let mut u = [0.0; 9];
            for i in 0..3 {
                u[3 * i] = ax - w * XY[i][1];
                u[3 * i + 1] = ay + w * XY[i][0];
                u[3 * i + 2] = w;
            }
            assert!(energy(&k, &u) < 1e-12, "{kind:?}");
        }
    }

    /// A linear field with θz at its rotation: the exact strain, and the
    /// energy is `½ εᵀ A ε × area`.
    #[test]
    fn constant_strain_is_exact() {
        let area = 1.5;
        for kind in [MembraneKind::Allman, MembraneKind::Cst] {
            let k = stiffness(kind, &XY, area, &amat(), 0.1);
            // u = 0.01 x + 0.004 y, v = −0.002 x + 0.003 y.
            let mut u = [0.0; 9];
            for i in 0..3 {
                let (x, y) = (XY[i][0], XY[i][1]);
                u[3 * i] = 0.01 * x + 0.004 * y;
                u[3 * i + 1] = -0.002 * x + 0.003 * y;
                u[3 * i + 2] = 0.5 * (-0.002 - 0.004);
            }
            let e = centroid_strain(kind, &XY, &u);
            let want = [0.01, 0.003, 0.002];
            for r in 0..3 {
                assert!((e[r] - want[r]).abs() < 1e-14, "{kind:?} {e:?}");
            }
            let a = amat();
            let mut w = 0.0;
            for r in 0..3 {
                for q in 0..3 {
                    w += want[r] * a[r][q] * want[q];
                }
            }
            assert!((energy(&k, &u) - 0.5 * w * area).abs() < 1e-12 * w);
        }
    }

    /// Allman's element without the penalty has exactly one more zero mode
    /// than the three rigid ones; the penalty takes it away.
    #[test]
    fn the_penalty_removes_allmans_spurious_mode() {
        let zero_modes = |alpha: f64| {
            let k = stiffness(MembraneKind::Allman, &XY, 1.5, &amat(), alpha);
            let m = faer::Mat::<f64>::from_fn(9, 9, |i, j| k[i][j]);
            let ev = m.self_adjoint_eigenvalues(faer::Side::Lower).unwrap();
            let top = ev.iter().cloned().fold(0.0, f64::max);
            ev.iter().filter(|v| v.abs() < 1e-10 * top).count()
        };
        assert_eq!(zero_modes(0.0), 4);
        assert_eq!(zero_modes(1e-3), 3);
    }
}
