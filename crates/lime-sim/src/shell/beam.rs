//! A rib segment: a two-node 3D Timoshenko beam (the closed form in
//! Przemieniecki, "Theory of Matrix Structural Analysis", 1968, §5.6) with
//! a solid rectangular section, hung off the shell's nodes by rigid links.
//!
//! Local axes: x along the segment, z the rib's height direction (the
//! shell's normal there, made square to x), y = z × x across the rib. The
//! height h bends about y; the width b about z.
//!
//! **Eccentricity.** A rib standing on one face of the wall has its
//! centroid a distance `t/2 + h/2` off the mid-surface the shell nodes sit
//! on. The rib's foot (on the wall's face, `e_t = t/2 n` off the node)
//! moves with the shell node as a rigid body; the centroid sits a further
//! `e_h = h/2 n` up the web. This is what puts the wall's membrane to work
//! as the rib's flange, which is most of what a rib is worth.
//!
//! **The web's own rotation ψ.** The wall is a Kirchhoff plate: its nodal
//! rotation is the slope of its mid-surface. Tying the rib's section
//! rotation to that slope leaves a Timoshenko beam no shear at all in the
//! limit, and on a finite mesh a spurious, mesh-dependent amount (the
//! clamped ribbed plate stiffened by 5 % with every halving of the mesh
//! and never settled). So each rib vertex carries one more dof, ψ: the
//! web's section rotation about the rib's lateral axis `ŷ`. The rib's
//! other two rotations (twist about its axis, turn about the normal) still
//! follow the shell node. Per vertex, with `P = I − ŷŷᵀ`:
//!
//! - `θ_c = P θ + ψ ŷ`
//! - `u_c = u + θ × e_t + θ_c × e_h`
//!
//! With ψ = θ·ŷ this is the rigid offset; free, the web shears against the
//! wall's slope with the section's shear stiffness `κ G A`, κ = 5/6.

use super::geometry::skew;
use crate::units::{cross, dot, norm, normalize, scale, sub};

/// The rib element's stiffness on `[u_a, θ_a, u_b, θ_b, ψ_a, ψ_b]`.
pub(crate) type K14 = [[f64; 14]; 14];
pub(crate) type K12 = [[f64; 12]; 12];

/// Shear correction of a solid rectangle.
const SHEAR_FACTOR: f64 = 5.0 / 6.0;

#[derive(Clone, Copy, Debug)]
pub(crate) struct BeamSection {
    pub e: f64,
    pub g: f64,
    /// Across the rib, along local y.
    pub width: f64,
    /// Out of the wall, along local z.
    pub height: f64,
}

impl BeamSection {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    /// About local y: the height bends.
    fn i_y(&self) -> f64 {
        self.width * self.height.powi(3) / 12.0
    }

    /// About local z: the width bends.
    fn i_z(&self) -> f64 {
        self.height * self.width.powi(3) / 12.0
    }

    /// St Venant torsion constant of a rectangle a ≥ b (Roark):
    /// `J = a b³ (1/3 − 0.21 (b/a)(1 − b⁴ / (12 a⁴)))`.
    fn torsion(&self) -> f64 {
        let a = self.width.max(self.height);
        let b = self.width.min(self.height);
        let r = b / a;
        a * b.powi(3) * (1.0 / 3.0 - 0.21 * r * (1.0 - r.powi(4) / 12.0))
    }
}

/// Local stiffness, dof order `[u, v, w, θx, θy, θz]` at each end.
pub(crate) fn local_stiffness(len: f64, s: &BeamSection) -> K12 {
    let mut k = [[0.0; 12]; 12];
    let l = len;
    let ea = s.e * s.area() / l;
    let gj = s.g * s.torsion() / l;
    let shear_area = SHEAR_FACTOR * s.area();
    let phi_y = 12.0 * s.e * s.i_z() / (s.g * shear_area * l * l);
    let phi_z = 12.0 * s.e * s.i_y() / (s.g * shear_area * l * l);
    let a = s.e * s.i_z() / ((1.0 + phi_y) * l.powi(3));
    let b = s.e * s.i_y() / ((1.0 + phi_z) * l.powi(3));
    let mut set = |i: usize, j: usize, v: f64| {
        k[i][j] = v;
        k[j][i] = v;
    };
    set(0, 0, ea);
    set(6, 6, ea);
    set(0, 6, -ea);
    set(3, 3, gj);
    set(9, 9, gj);
    set(3, 9, -gj);
    // Bending in x–y: v and θz = dv/dx.
    set(1, 1, 12.0 * a);
    set(1, 5, 6.0 * a * l);
    set(1, 7, -12.0 * a);
    set(1, 11, 6.0 * a * l);
    set(5, 5, (4.0 + phi_y) * a * l * l);
    set(5, 7, -6.0 * a * l);
    set(5, 11, (2.0 - phi_y) * a * l * l);
    set(7, 7, 12.0 * a);
    set(7, 11, -6.0 * a * l);
    set(11, 11, (4.0 + phi_y) * a * l * l);
    // Bending in x–z: w and θy = −dw/dx, so the couplings change sign.
    set(2, 2, 12.0 * b);
    set(2, 4, -6.0 * b * l);
    set(2, 8, -12.0 * b);
    set(2, 10, -6.0 * b * l);
    set(4, 4, (4.0 + phi_z) * b * l * l);
    set(4, 8, 6.0 * b * l);
    set(4, 10, (2.0 - phi_z) * b * l * l);
    set(8, 8, 12.0 * b);
    set(8, 10, 6.0 * b * l);
    set(10, 10, (4.0 + phi_z) * b * l * l);
    k
}

/// The local axes of a segment from `a` to `b` whose height direction is
/// near `up`: rows x, y, z. `None` when `up` runs along the segment.
pub(crate) fn axes(a: [f64; 3], b: [f64; 3], up: [f64; 3]) -> Option<[[f64; 3]; 3]> {
    let x = normalize(sub(b, a))?;
    let square = sub(up, scale(x, dot(up, x)));
    if norm(square) < 1e-6 * norm(up) {
        return None;
    }
    let z = normalize(square)?;
    let y = cross(z, x);
    Some([x, y, z])
}

/// Where a rib end sits on its shell node: the foot's offset `e_t` and the
/// centroid's further offset `e_h` (both along the normal, zero for a
/// centred rib), and the lateral axis `y` its web rotation ψ turns about.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RibEnd {
    pub foot: [f64; 3],
    pub up_web: [f64; 3],
    pub lateral: [f64; 3],
}

impl RibEnd {
    /// `[u_c; θ_c] = G [u; θ; ψ]`, 6 × 7 (see the module notes).
    fn map(&self) -> [[f64; 7]; 6] {
        let y = self.lateral;
        let mut p = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                p[i][j] = if i == j { 1.0 } else { 0.0 } - y[i] * y[j];
            }
        }
        let st = skew(self.foot);
        let sh = skew(self.up_web);
        let mut g = [[0.0; 7]; 6];
        for i in 0..3 {
            g[i][i] = 1.0;
            for j in 0..3 {
                let shp: f64 = (0..3).map(|q| sh[i][q] * p[q][j]).sum();
                g[i][3 + j] = -st[i][j] - shp;
                g[3 + i][3 + j] = p[i][j];
            }
            g[i][6] = -(0..3).map(|q| sh[i][q] * y[q]).sum::<f64>();
            g[3 + i][6] = y[i];
        }
        g
    }

    fn centroid(&self, node: [f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|k| node[k] + self.foot[k] + self.up_web[k])
    }
}

/// Stiffness of a rib segment between shell nodes at `a` and `b` on
/// `[u_a, θ_a, u_b, θ_b, ψ_a, ψ_b]`, height direction near `up`. `None`
/// when `up` runs along the segment.
pub(crate) fn rib_stiffness(
    a: [f64; 3],
    b: [f64; 3],
    up: [f64; 3],
    ends: [RibEnd; 2],
    s: &BeamSection,
) -> Option<K14> {
    // The beam runs between the centroids, so its axes and length do too.
    let ca = ends[0].centroid(a);
    let cb = ends[1].centroid(b);
    let rows = axes(ca, cb, up)?;
    let kl = local_stiffness(norm(sub(cb, ca)), s);
    // M (12 × 14): local beam dofs from the two ends' [u, θ] and ψ, the
    // global end map G followed by the rotation into the beam's axes.
    let mut m = [[0.0; 14]; 12];
    for (end, map) in ends.iter().map(RibEnd::map).enumerate() {
        let o = 6 * end;
        let cols: [usize; 7] = [o, o + 1, o + 2, o + 3, o + 4, o + 5, 12 + end];
        for blk in 0..2 {
            for i in 0..3 {
                for (c, &col) in cols.iter().enumerate() {
                    m[o + 3 * blk + i][col] =
                        (0..3).map(|q| rows[i][q] * map[3 * blk + q][c]).sum();
                }
            }
        }
    }
    let mut km = [[0.0; 14]; 12];
    for i in 0..12 {
        for j in 0..14 {
            km[i][j] = (0..12).map(|q| kl[i][q] * m[q][j]).sum();
        }
    }
    let mut k = [[0.0; 14]; 14];
    for i in 0..14 {
        for j in 0..14 {
            k[i][j] = (0..12).map(|q| m[q][i] * km[q][j]).sum();
        }
    }
    Some(k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use faer::prelude::Solve;

    fn section() -> BeamSection {
        BeamSection {
            e: 2000.0,
            g: 2000.0 / 2.6,
            width: 2.0,
            height: 8.0,
        }
    }

    /// A cantilever of one element, tip load along local z: Timoshenko's
    /// `P L³ / (3 E I) + P L / (κ G A)`.
    #[test]
    fn one_element_cantilever_is_exact() {
        let s = section();
        let l = 40.0;
        let k = local_stiffness(l, &s);
        // Free dofs: the far end (6..12). Solve the 6×6 by faer.
        let m = faer::Mat::<f64>::from_fn(6, 6, |i, j| k[6 + i][6 + j]);
        let mut rhs = faer::Mat::<f64>::zeros(6, 1);
        rhs[(2, 0)] = 1.0;
        let x = m.ldlt(faer::Side::Lower).unwrap().solve(&rhs);
        let want = l.powi(3) / (3.0 * s.e * s.i_y()) + l / (SHEAR_FACTOR * s.g * s.area());
        assert!(
            (x[(2, 0)] - want).abs() < 1e-10 * want,
            "{} {want}",
            x[(2, 0)]
        );
        // The tip turns by −dw/dx about y.
        let slope = l * l / (2.0 * s.e * s.i_y());
        assert!((x[(4, 0)] + slope).abs() < 1e-10 * slope);
    }

    fn unit(v: [f64; 3]) -> [f64; 3] {
        normalize(v).unwrap()
    }

    /// Rigid motion of the shell nodes, with ψ turning with them, moves
    /// the offset rib rigidly: no force anywhere.
    #[test]
    fn offset_rib_has_six_rigid_modes() {
        let a = [0.0, 0.0, 0.0];
        let b = [3.0, 1.0, 0.5];
        let ends = [
            RibEnd {
                foot: [0.0, -0.1, 1.0],
                up_web: [0.05, -0.2, 3.0],
                lateral: unit([-1.0, 3.0, 0.1]),
            },
            RibEnd {
                foot: [0.02, -0.1, 1.1],
                up_web: [0.0, -0.2, 3.2],
                lateral: unit([-1.1, 3.0, 0.3]),
            },
        ];
        let k = rib_stiffness(a, b, [0.0, 0.2, 1.0], ends, &section()).unwrap();
        let t = [0.2, -0.1, 0.3];
        let w = [0.01, 0.02, -0.015];
        let mut u = [0.0; 14];
        for (n, p) in [a, b].iter().enumerate() {
            let r = cross(w, *p);
            for i in 0..3 {
                u[6 * n + i] = t[i] + r[i];
                u[6 * n + 3 + i] = w[i];
            }
            u[12 + n] = dot(w, ends[n].lateral);
        }
        let mut f = [0.0; 14];
        for i in 0..14 {
            f[i] = (0..14).map(|j| k[i][j] * u[j]).sum();
        }
        let big = k.iter().flatten().fold(0.0_f64, |m, v| m.max(v.abs()));
        assert!(f.iter().all(|v| v.abs() < 1e-9 * big), "{f:?}");
    }

    /// A centred rib along x with its web rotation free bends and shears
    /// as a Timoshenko cantilever when the node's own turn about y is held
    /// (the wall holds it in a real model).
    #[test]
    fn the_web_rotation_carries_the_shear() {
        let s = section();
        let l = 40.0;
        let end = RibEnd {
            foot: [0.0; 3],
            up_web: [0.0; 3],
            lateral: [0.0, 1.0, 0.0],
        };
        let k = rib_stiffness([0.0; 3], [l, 0.0, 0.0], [0.0, 0.0, 1.0], [end, end], &s).unwrap();
        // Free: u_b (6, 7, 8), θx_b (9), θz_b (11), ψ_b (13).
        let free = [6, 7, 8, 9, 11, 13];
        let m = faer::Mat::<f64>::from_fn(6, 6, |i, j| k[free[i]][free[j]]);
        let mut rhs = faer::Mat::<f64>::zeros(6, 1);
        rhs[(2, 0)] = 1.0;
        let x = m.ldlt(faer::Side::Lower).unwrap().solve(&rhs);
        let want = l.powi(3) / (3.0 * s.e * s.i_y()) + l / (SHEAR_FACTOR * s.g * s.area());
        assert!(
            (x[(2, 0)] - want).abs() < 1e-9 * want,
            "{} {want}",
            x[(2, 0)]
        );
    }
}
