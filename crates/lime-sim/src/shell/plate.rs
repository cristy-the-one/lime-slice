//! The bending half of a facet: the Discrete Kirchhoff Triangle (Batoz,
//! Bathe & Ho 1980, "A study of three-node triangular plate bending
//! elements", IJNME 15), built from its four defining assumptions rather
//! than from the closed-form tables:
//!
//! 1. The slopes β = (βx, βy) vary quadratically, interpolated from the
//!    three corners and three midsides with the six-node shape functions.
//! 2. At the corners, β = ∇w: with the nodal rotations θx, θy about the
//!    facet axes, βx = ∂w/∂x = −θy and βy = ∂w/∂y = θx.
//! 3. At each midside, the tangential slope is that of the cubic w along
//!    the edge through the corner w and tangential slopes:
//!    `β_s(mid) = 3 (w_j − w_i) / (2L) − (β_s,i + β_s,j) / 4`.
//! 4. The normal slope varies linearly along each edge:
//!    `β_n(mid) = (β_n,i + β_n,j) / 2`.
//!
//! Curvatures `κ = [∂βx/∂x, ∂βy/∂y, ∂βx/∂y + ∂βy/∂x]` are linear, so the
//! three-point rule integrates `κᵀ D κ` exactly. Element dof order is
//! `[w0, θx0, θy0, w1, θx1, θy1, w2, θx2, θy2]`.

use super::geometry::{quadratic_derivatives, EDGES, GAUSS3};
use super::membrane::K9;
use super::section::Mat3;

/// Slopes `[βx0, βy0, …, βx5, βy5]` at the six nodes from the nine dofs.
fn slopes(xy: &[[f64; 2]; 3]) -> [[f64; 9]; 12] {
    // β at corner i in terms of that corner's (w, θx, θy).
    let corner = |a: &mut [[f64; 9]; 12], row: usize, i: usize, m: [[f64; 2]; 2], s: f64| {
        // m maps (βx, βy) of corner i into the target pair of rows.
        for r in 0..2 {
            a[row + r][3 * i + 2] += -s * m[r][0];
            a[row + r][3 * i + 1] += s * m[r][1];
        }
    };
    let mut a = [[0.0; 9]; 12];
    let id = [[1.0, 0.0], [0.0, 1.0]];
    for i in 0..3 {
        corner(&mut a, 2 * i, i, id, 1.0);
    }
    for (m, (i, j)) in EDGES.iter().copied().enumerate() {
        let row = 2 * (3 + m);
        let ex = xy[j][0] - xy[i][0];
        let ey = xy[j][1] - xy[i][1];
        let len = (ex * ex + ey * ey).sqrt();
        let s = [ex / len, ey / len];
        let n = [s[1], -s[0]];
        // β_mid = s (3 (w_j − w_i)/(2L) − ¼ s·(β_i + β_j)) + n (½ n·(β_i + β_j))
        let mut p = [[0.0; 2]; 2];
        for r in 0..2 {
            for q in 0..2 {
                p[r][q] = -0.25 * s[r] * s[q] + 0.5 * n[r] * n[q];
            }
        }
        corner(&mut a, row, i, p, 1.0);
        corner(&mut a, row, j, p, 1.0);
        for r in 0..2 {
            a[row + r][3 * j] += 1.5 * s[r] / len;
            a[row + r][3 * i] -= 1.5 * s[r] / len;
        }
    }
    a
}

/// Curvature rows `[κxx, κyy, 2κxy]` over the nine dofs at area
/// coordinates `l`.
fn curvature_rows(xy: &[[f64; 2]; 3], a: &[[f64; 9]; 12], l: [f64; 3]) -> [[f64; 9]; 3] {
    let (dx, dy) = quadratic_derivatives(xy, l);
    let mut b = [[0.0; 9]; 3];
    for k in 0..6 {
        let (bx, by) = (&a[2 * k], &a[2 * k + 1]);
        for d in 0..9 {
            b[0][d] += dx[k] * bx[d];
            b[1][d] += dy[k] * by[d];
            b[2][d] += dy[k] * bx[d] + dx[k] * by[d];
        }
    }
    b
}

/// Quadratic shape functions at area coordinates `l`: corners
/// `L_i (2 L_i − 1)`, midsides `4 L_i L_j` on edges 0–1, 1–2, 2–0.
fn shape6(l: [f64; 3]) -> [f64; 6] {
    let mut n = [0.0; 6];
    for i in 0..3 {
        n[i] = l[i] * (2.0 * l[i] - 1.0);
    }
    for (m, (i, j)) in EDGES.iter().enumerate() {
        n[3 + m] = 4.0 * l[*i] * l[*j];
    }
    n
}

/// Dunavant's 7-point rule, exact through degree 5. The integrand
/// βᵀ N β is degree 4. Weights are fractions of the triangle's area.
fn dunavant7() -> [([f64; 3], f64); 7] {
    let s = 15.0_f64.sqrt();
    let w_a = (155.0 + s) / 1200.0;
    let w_b = (155.0 - s) / 1200.0;
    let a2 = (9.0 - 2.0 * s) / 21.0;
    let b2 = (6.0 + s) / 21.0;
    let a3 = (9.0 + 2.0 * s) / 21.0;
    let b3 = (6.0 - s) / 21.0;
    [
        ([1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0], 9.0 / 40.0),
        ([a2, b2, b2], w_a),
        ([b2, a2, b2], w_a),
        ([b2, b2, a2], w_a),
        ([a3, b3, b3], w_b),
        ([b3, a3, b3], w_b),
        ([b3, b3, a3], w_b),
    ]
}

/// Plate geometric stiffness ∫ βᵀ N β dA on the nine DKT bending dofs.
///
/// β is the same slope interpolation as the element stiffness. N is
/// `[Nxx, Nyy, Nxy]`, tension-positive, and constant (the CST membrane
/// force). Compression makes this matrix negative. There is no membrane
/// geometric stiffness here: the study found it changes no printed digit
/// of the plate mode. There is no beam geometric stiffness either: a rib
/// buckling on its own is not this factor.
pub(crate) fn geometric(xy: &[[f64; 2]; 3], area: f64, force: [f64; 3]) -> K9 {
    let [nxx, nyy, nxy] = force;
    let slopes = slopes(xy);
    let mut k = [[0.0; 9]; 9];
    for (l, w) in dunavant7() {
        let n = shape6(l);
        let mut bx = [0.0; 9];
        let mut by = [0.0; 9];
        for node in 0..6 {
            let s = n[node];
            for d in 0..9 {
                bx[d] += s * slopes[2 * node][d];
                by[d] += s * slopes[2 * node + 1][d];
            }
        }
        let weight = w * area;
        for i in 0..9 {
            for j in 0..9 {
                k[i][j] += weight
                    * (nxx * bx[i] * bx[j]
                        + nyy * by[i] * by[j]
                        + nxy * (bx[i] * by[j] + by[i] * bx[j]));
            }
        }
    }
    k
}

/// The DKT bending stiffness of one facet with bending matrix `d`.
pub(crate) fn stiffness(xy: &[[f64; 2]; 3], area: f64, d: &Mat3) -> K9 {
    let a = slopes(xy);
    let mut k = [[0.0; 9]; 9];
    for l in GAUSS3 {
        let b = curvature_rows(xy, &a, l);
        let mut db = [[0.0; 9]; 3];
        for r in 0..3 {
            for c in 0..9 {
                db[r][c] = (0..3).map(|q| d[r][q] * b[q][c]).sum();
            }
        }
        for i in 0..9 {
            for j in 0..9 {
                k[i][j] += area / 3.0 * (0..3).map(|r| b[r][i] * db[r][j]).sum::<f64>();
            }
        }
    }
    k
}

/// `[∂²w/∂x², ∂²w/∂y², 2 ∂²w/∂x∂y]` at the centroid.
pub(crate) fn centroid_curvature(xy: &[[f64; 2]; 3], u: &[f64; 9]) -> [f64; 3] {
    let a = slopes(xy);
    let b = curvature_rows(xy, &a, super::geometry::CENTROID);
    let mut k = [0.0; 3];
    for r in 0..3 {
        k[r] = (0..9).map(|d| b[r][d] * u[d]).sum();
    }
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    const XY: [[f64; 2]; 3] = [[0.0, 0.0], [2.0, 0.0], [0.6, 1.5]];

    /// w = a + b x + c y with the matching rotations: no curvature.
    #[test]
    fn a_tilted_plane_has_no_curvature() {
        let mut u = [0.0; 9];
        for i in 0..3 {
            let (x, y) = (XY[i][0], XY[i][1]);
            u[3 * i] = 0.1 + 0.02 * x - 0.03 * y;
            u[3 * i + 1] = -0.03; // θx = ∂w/∂y
            u[3 * i + 2] = -0.02; // θy = −∂w/∂x
        }
        let k = centroid_curvature(&XY, &u);
        assert!(k.iter().all(|v| v.abs() < 1e-14), "{k:?}");
    }

    /// Any quadratic w is reproduced exactly: its constant curvatures come
    /// back at every point.
    #[test]
    fn a_quadratic_bend_is_exact() {
        let (p, q, r) = (0.01, -0.004, 0.003); // w = ½p x² + ½q y² + r x y
        let mut u = [0.0; 9];
        for i in 0..3 {
            let (x, y) = (XY[i][0], XY[i][1]);
            u[3 * i] = 0.5 * p * x * x + 0.5 * q * y * y + r * x * y;
            u[3 * i + 1] = q * y + r * x;
            u[3 * i + 2] = -(p * x + r * y);
        }
        let a = slopes(&XY);
        for l in GAUSS3 {
            let b = curvature_rows(&XY, &a, l);
            let mut k = [0.0; 3];
            for row in 0..3 {
                k[row] = (0..9).map(|d| b[row][d] * u[d]).sum();
            }
            assert!(
                (k[0] - p).abs() < 1e-14 && (k[1] - q).abs() < 1e-14,
                "{k:?}"
            );
            assert!((k[2] - 2.0 * r).abs() < 1e-14, "{k:?}");
        }
    }

    /// A constant slope is a linear w. ∫ βᵀ N β dA is Nxx βx² times the area.
    #[test]
    fn constant_slope_matches_the_closed_integral() {
        let (beta_x, nxx) = (0.02, -4.0);
        let mut u = [0.0; 9];
        for i in 0..3 {
            u[3 * i] = beta_x * XY[i][0];
            u[3 * i + 2] = -beta_x;
        }
        let k = geometric(&XY, 1.5, [nxx, 1.0, 0.5]);
        let mut energy = 0.0;
        for i in 0..9 {
            for j in 0..9 {
                energy += u[i] * k[i][j] * u[j];
            }
        }
        let expect = nxx * beta_x * beta_x * 1.5;
        assert!((energy - expect).abs() < 1e-12 * expect.abs(), "{energy} vs {expect}");
    }

    /// Three rigid modes (w, θx, θy) and no other zero mode.
    #[test]
    fn three_zero_modes() {
        let d = [[1.0, 0.3, 0.0], [0.3, 1.0, 0.0], [0.0, 0.0, 0.35]];
        let k = stiffness(&XY, 1.5, &d);
        let m = faer::Mat::<f64>::from_fn(9, 9, |i, j| k[i][j]);
        let ev = m.self_adjoint_eigenvalues(faer::Side::Lower).unwrap();
        let top = ev.iter().cloned().fold(0.0, f64::max);
        assert_eq!(ev.iter().filter(|v| v.abs() < 1e-10 * top).count(), 3);
    }
}
