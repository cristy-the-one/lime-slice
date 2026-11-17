//! The direction field ribs follow: per triangle, the principal directions
//! of the bending moment (of the membrane force where membrane energy
//! dominates), combined over load cases, smoothed as a cross field, with a
//! confidence that marks where the directions mean little.
//!
//! **Cross field.** A rib may run along either principal direction, and a
//! direction is a line, so the field is stored as `z = r e^{4iθ}` in each
//! triangle's frame (θ from the frame's `e1`): the four directions θ + kπ/2
//! are one value. Neighbours compare after carrying `z` across the shared
//! edge (the angle between the two frames' `e1`, measured in the receiving
//! plane).
//!
//! **Smoothing** (Li et al. 2017, §4: a blend of smoothness and alignment
//! with α = 0.8). Minimise
//! `(1 − α) Σᵢ |zᵢ − zᵢ⁰|² + α Σ_{ij} |zᵢ − Rᵢⱼ zⱼ|²`
//! over the triangles' dual graph, where `zᵢ⁰` is the data: the principal
//! direction weighted by how anisotropic the tensor is and by the strain
//! energy density there. Where the data is weak (an isotropic point, or no
//! energy) the neighbours decide. Gauss–Seidel in index order, so the
//! result is deterministic. The smoothing length is in triangles, not mm:
//! about √(α·3/(1−α)) ≈ 3.5 triangles.
//!
//! **Confidence.** The same smoothing applied to `|zᵢ⁰|` gives `mᵢ`; the
//! coherence `|zᵢ| / mᵢ` is near 1 where the directions nearby agree and
//! falls toward 0 at a singularity of the field, where they cancel. A
//! triangle is low-confidence when its coherence is under
//! [`MIN_COHERENCE`] or its energy density is under [`LOW_ENERGY`] of the
//! 90th percentile.

use crate::shell::ShellResult;
use crate::units::{cross, dot, normalize, scale, sub};

use super::surface::Surface;

/// Li et al.'s blend.
pub(crate) const ALPHA: f64 = 0.8;
pub(crate) const MIN_COHERENCE: f64 = 0.35;
pub(crate) const LOW_ENERGY: f64 = 0.01;
const ITERATIONS: usize = 400;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct C(pub f64, pub f64);

impl C {
    fn polar(r: f64, a: f64) -> Self {
        C(r * a.cos(), r * a.sin())
    }
    fn mul(self, o: C) -> C {
        C(self.0 * o.0 - self.1 * o.1, self.0 * o.1 + self.1 * o.0)
    }
    fn add(self, o: C) -> C {
        C(self.0 + o.0, self.1 + o.1)
    }
    fn scale(self, s: f64) -> C {
        C(self.0 * s, self.1 * s)
    }
    fn abs(self) -> f64 {
        self.0.hypot(self.1)
    }
    fn arg(self) -> f64 {
        self.1.atan2(self.0)
    }
}

/// A tangent frame.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TFrame {
    pub e1: [f64; 3],
    pub e2: [f64; 3],
    pub n: [f64; 3],
}

impl TFrame {
    fn from(e1_hint: [f64; 3], n: [f64; 3]) -> Self {
        let p = sub(e1_hint, scale(n, dot(e1_hint, n)));
        let e1 = normalize(p)
            .or_else(|| normalize(cross(n, [0.0, 0.0, 1.0])))
            .or_else(|| normalize(cross(n, [1.0, 0.0, 0.0])))
            .expect("a unit normal has a perpendicular");
        Self {
            e1,
            e2: cross(n, e1),
            n,
        }
    }

    /// The angle of `d` (projected) from `e1`.
    pub fn angle(&self, d: [f64; 3]) -> f64 {
        dot(d, self.e2).atan2(dot(d, self.e1))
    }

    pub fn dir(&self, a: f64) -> [f64; 3] {
        let (s, c) = a.sin_cos();
        [0, 1, 2].map(|k| c * self.e1[k] + s * self.e2[k])
    }

    /// The rotation that carries an angle in `from` into this frame.
    fn offset_from(&self, from: &TFrame) -> f64 {
        self.angle(from.e1)
    }
}

pub(crate) struct Field {
    pub frames: Vec<TFrame>,
    pub confident: Vec<bool>,
    /// Strain energy density per triangle (summed over cases), N·mm/mm².
    pub density: Vec<f64>,
    /// The 90th percentile of `density`.
    pub density_p90: f64,
    /// The energy-weighted major direction (a line field), per triangle.
    pub major: Vec<[f64; 3]>,
    /// Per vertex, the cross field in the vertex frame.
    vertex_z: Vec<C>,
    /// Per triangle and corner, the rotation from the corner's vertex frame
    /// into the triangle's frame (as `e^{4iδ}`).
    corner_rot: Vec<[C; 3]>,
}

impl Field {
    /// Build the field on `surface` (the mesh the results were solved on)
    /// from one result per load case.
    pub fn new(surface: &Surface, results: &[ShellResult], alpha: f64) -> Self {
        let nt = surface.tris.len();
        let frames: Vec<TFrame> = (0..nt as u32)
            .map(|t| {
                let [a, b, _] = surface.corners(t);
                TFrame::from(sub(b, a), surface.normal(t))
            })
            .collect();
        let mut density = vec![0.0; nt];
        let mut data = vec![C::default(); nt];
        let mut line = vec![C::default(); nt];
        for r in results {
            for (t, el) in r.elements.iter().enumerate() {
                let energy = el.bending_energy + el.membrane_energy;
                let rho = energy / el.area;
                density[t] += rho;
                let tensor = if el.membrane_energy > el.bending_energy {
                    &el.membrane_force
                } else {
                    &el.bending_moment
                };
                let theta = frames[t].angle(tensor.major_dir);
                let w = rho * (1.0 - tensor.isotropy);
                data[t] = data[t].add(C::polar(w, 4.0 * theta));
                line[t] = line[t].add(C::polar(w, 2.0 * theta));
            }
        }
        let area: Vec<f64> = (0..nt as u32).map(|t| surface.area(t)).collect();
        let total_area: f64 = area.iter().sum();
        let mean = density.iter().zip(&area).map(|(d, a)| d * a).sum::<f64>() / total_area;
        let norm_by = if mean > 0.0 { 1.0 / mean } else { 1.0 };
        for z in &mut data {
            *z = z.scale(norm_by);
        }
        let mut sorted = density.clone();
        sorted.sort_by(f64::total_cmp);
        let density_p90 = sorted[((nt - 1) as f64 * 0.9) as usize];

        // Dual graph with the frame rotations.
        let mut nbrs: Vec<Vec<(u32, C)>> = vec![Vec::new(); nt];
        for t in 0..nt as u32 {
            for k in 0..3 {
                if let Some(o) = surface.neighbour(t, k) {
                    let delta = frames[t as usize].offset_from(&frames[o as usize]);
                    nbrs[t as usize].push((o, C::polar(1.0, 4.0 * delta)));
                }
            }
        }
        let z = smooth(&data, &nbrs, alpha);
        let mags: Vec<C> = data.iter().map(|z| C(z.abs(), 0.0)).collect();
        let ones: Vec<Vec<(u32, C)>> = nbrs
            .iter()
            .map(|l| l.iter().map(|&(o, _)| (o, C(1.0, 0.0))).collect())
            .collect();
        let m = smooth(&mags, &ones, alpha);
        let confident: Vec<bool> = (0..nt)
            .map(|t| {
                let coherence = if m[t].0 > 0.0 {
                    z[t].abs() / m[t].0
                } else {
                    0.0
                };
                coherence >= MIN_COHERENCE && density[t] >= LOW_ENERGY * density_p90
            })
            .collect();
        let major: Vec<[f64; 3]> = (0..nt)
            .map(|t| frames[t].dir(0.5 * line[t].arg()))
            .collect();

        // Vertex frames and the field carried to them, area-weighted.
        let nv = surface.pos.len();
        let mut vnormal = vec![[0.0; 3]; nv];
        for t in 0..nt {
            for &v in &surface.tris[t] {
                let n = scale(frames[t].n, area[t]);
                vnormal[v as usize] = [0, 1, 2].map(|k| vnormal[v as usize][k] + n[k]);
            }
        }
        let vframes: Vec<TFrame> = (0..nv)
            .map(|v| {
                let n = normalize(vnormal[v]).unwrap_or([0.0, 0.0, 1.0]);
                let hint = surface.vert_tris[v]
                    .first()
                    .map_or([1.0, 0.0, 0.0], |&t| frames[t as usize].e1);
                TFrame::from(hint, n)
            })
            .collect();
        let mut vertex_z = vec![C::default(); nv];
        for t in 0..nt {
            for &v in &surface.tris[t] {
                let vf = &vframes[v as usize];
                let rot = C::polar(1.0, 4.0 * vf.offset_from(&frames[t]));
                vertex_z[v as usize] = vertex_z[v as usize].add(z[t].mul(rot).scale(area[t]));
            }
        }
        let corner_rot: Vec<[C; 3]> = (0..nt)
            .map(|t| {
                surface.tris[t]
                    .map(|v| C::polar(1.0, 4.0 * frames[t].offset_from(&vframes[v as usize])))
            })
            .collect();
        Self {
            frames,
            confident,
            density,
            density_p90,
            major,
            vertex_z,
            corner_rot,
        }
    }

    /// The field direction at barycentric `l` of triangle `t` nearest to
    /// `heading` (one of the four), as a unit vector in `t`'s plane. `None`
    /// where the interpolated field vanishes.
    pub fn direction(
        &self,
        surface: &Surface,
        t: u32,
        l: [f64; 3],
        heading: [f64; 3],
    ) -> Option<[f64; 3]> {
        let tri = surface.tris[t as usize];
        let mut z = C::default();
        for k in 0..3 {
            let zv = self.vertex_z[tri[k] as usize].mul(self.corner_rot[t as usize][k]);
            z = z.add(zv.scale(l[k]));
        }
        if z.abs() < 1e-300 {
            return None;
        }
        let f = &self.frames[t as usize];
        let base = 0.25 * z.arg();
        let mut best = (f64::NEG_INFINITY, [0.0; 3]);
        for k in 0..4 {
            let d = f.dir(base + k as f64 * std::f64::consts::FRAC_PI_2);
            let c = dot(d, heading);
            if c > best.0 {
                best = (c, d);
            }
        }
        Some(best.1)
    }
}

/// Gauss–Seidel on `(1 − α)(zᵢ − dᵢ) + α Σⱼ (zᵢ − Rᵢⱼ zⱼ) = 0`.
fn smooth(data: &[C], nbrs: &[Vec<(u32, C)>], alpha: f64) -> Vec<C> {
    let mut z = data.to_vec();
    let scale_of = data.iter().map(|d| d.abs()).fold(0.0, f64::max);
    for _ in 0..ITERATIONS {
        let mut change: f64 = 0.0;
        for i in 0..z.len() {
            let mut s = data[i].scale(1.0 - alpha);
            for &(j, r) in &nbrs[i] {
                s = s.add(z[j as usize].mul(r).scale(alpha));
            }
            let new = s.scale(1.0 / ((1.0 - alpha) + alpha * nbrs[i].len() as f64));
            change = change.max(C(new.0 - z[i].0, new.1 - z[i].1).abs());
            z[i] = new;
        }
        if change <= 1e-7 * scale_of {
            break;
        }
    }
    z
}
