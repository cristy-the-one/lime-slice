//! Zienkiewicz–Zhu estimator. v1 reports the number and does not remesh.
//!
//! The smoothed stress is [`recover_nodal`]: each element's linear stress,
//! fitted through its four Gauss points and extrapolated to its corners, then
//! averaged over the elements at a node by volume. Inside one element the raw
//! and the smoothed field differ only by the jumps between elements, which is
//! the error ZZ measures. The element indicator is the energy of the
//! difference, eᵀ S e. The global number is the square root of that energy
//! over the strain energy. [`local_relative`] is the same ratio over the
//! elements near one point, so a peak can be judged on its own.

use std::cell::Cell;

use crate::element::{shape_of, ElementKind};
use crate::fields::GaussSample;
use crate::fields::Solution;
use crate::mesh::Mesh;

pub trait Estimator {
    fn element_error(&self, solution: &Solution) -> Vec<f64>;
    fn relative(&self, element_error: &[f64]) -> f64;
}

#[derive(Default)]
pub struct Zz {
    /// Strain energy written by `element_error` and read by `relative`.
    energy: Cell<f64>,
}

impl Zz {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Estimator for Zz {
    fn element_error(&self, solution: &Solution) -> Vec<f64> {
        let nodal = recover_nodal(&solution.mesh, &solution.gauss);
        let mut err = vec![0.0; solution.mesh.elements.len()];
        let mut energy = 0.0;
        for sample in &solution.gauss {
            let cell = &solution.mesh.elements[sample.element];
            let shape = shape_of(solution.mesh.kind, sample.xi);
            let mut smooth = [0.0; 6];
            for (a, node) in cell.nodes.iter().enumerate() {
                let w = shape.n.get(a).copied().unwrap_or(0.0);
                for k in 0..6 {
                    smooth[k] += w * nodal[*node][k];
                }
            }
            let mut diff = [0.0; 6];
            for k in 0..6 {
                diff[k] = sample.stress[k] - smooth[k];
            }
            let de = quad_form(&diff, &sample.compliance) * sample.weight_det;
            let se = quad_form(&sample.stress, &sample.compliance) * sample.weight_det;
            if de.is_finite() && de > 0.0 {
                err[sample.element] += de;
            }
            if se.is_finite() && se > 0.0 {
                energy += se;
            }
        }
        self.energy.set(energy);
        err
    }

    fn relative(&self, element_error: &[f64]) -> f64 {
        let num: f64 = element_error
            .iter()
            .copied()
            .filter(|v| v.is_finite())
            .sum();
        let den = self.energy.get();
        if den <= 1e-30 {
            if num <= 1e-30 {
                0.0
            } else {
                1.0
            }
        } else {
            (num / den).sqrt()
        }
    }
}

/// Mid-edge nodes of a quadratic tet, as local corner pairs: 4 is 0–1, 5 is 1–2, 6 is 0–2, 7 is 0–3, 8 is 1–3, 9 is 2–3.
const MID_EDGES: [(usize, usize); 6] = [(0, 1), (1, 2), (0, 2), (0, 3), (1, 3), (2, 3)];

/// Nodal stress recovered from the Gauss samples.
///
/// An element with four or more samples fits a linear stress through its first
/// four (the stiffness rule of a TET10), extrapolates it to its corners, and
/// gives each mid-edge node the mean of its two corners. An element with fewer
/// samples gives every node its mean. Each node then takes the volume-weighted
/// average over the elements that touch it. The old recovery, a plain average of
/// every Gauss point of those elements, was close to piecewise constant: it
/// overstated the error of a smooth field and flattened a peak.
pub fn recover_nodal(mesh: &Mesh, gauss: &[GaussSample]) -> Vec<[f64; 6]> {
    let n = mesh.nodes.len();
    let mut sum = vec![[0.0; 6]; n];
    let mut weight = vec![0.0; n];
    let mut by_element: Vec<Vec<usize>> = vec![Vec::new(); mesh.elements.len()];
    for (i, sample) in gauss.iter().enumerate() {
        if let Some(list) = by_element.get_mut(sample.element) {
            list.push(i);
        }
    }
    for (ei, cell) in mesh.elements.iter().enumerate() {
        let samples = &by_element[ei];
        if samples.is_empty() {
            continue;
        }
        let w: f64 = samples
            .iter()
            .map(|&i| gauss[i].weight_det.abs())
            .sum::<f64>()
            .max(1e-300);
        let corners = if samples.len() >= 4 && cell.nodes.len() >= 4 {
            extrapolate(&samples[..4].iter().map(|&i| &gauss[i]).collect::<Vec<_>>())
        } else {
            None
        };
        let mut put = |node: usize, value: [f64; 6]| {
            for k in 0..6 {
                sum[node][k] += w * value[k];
            }
            weight[node] += w;
        };
        match corners {
            Some(c) => {
                for a in 0..4 {
                    put(cell.nodes[a], c[a]);
                }
                if cell.nodes.len() == 10 {
                    for (m, (a, b)) in MID_EDGES.iter().enumerate() {
                        let mut mid = [0.0; 6];
                        for k in 0..6 {
                            mid[k] = 0.5 * (c[*a][k] + c[*b][k]);
                        }
                        put(cell.nodes[4 + m], mid);
                    }
                }
            }
            None => {
                let mut mean = [0.0; 6];
                for &i in samples {
                    for k in 0..6 {
                        mean[k] += gauss[i].stress[k] / samples.len() as f64;
                    }
                }
                for &node in &cell.nodes {
                    put(node, mean);
                }
            }
        }
    }
    for i in 0..n {
        if weight[i] > 0.0 {
            for k in 0..6 {
                sum[i][k] /= weight[i];
            }
        }
    }
    sum
}

/// The corner values of the linear stress through four Gauss samples. `None` when the four points are flat.
fn extrapolate(samples: &[&GaussSample]) -> Option<[[f64; 6]; 4]> {
    // Row g: the corner weights (linear shape functions) at sample g. Solve A c = s for each component.
    let mut a = [[0.0; 4]; 4];
    for (g, sample) in samples.iter().enumerate() {
        let shape = shape_of(ElementKind::Tet4, sample.xi);
        for i in 0..4 {
            a[g][i] = shape.n.get(i).copied().unwrap_or(0.0);
        }
    }
    let inv = invert4(a)?;
    let mut out = [[0.0; 6]; 4];
    for i in 0..4 {
        for g in 0..4 {
            for k in 0..6 {
                out[i][k] += inv[i][g] * samples[g].stress[k];
            }
        }
    }
    Some(out)
}

fn invert4(m: [[f64; 4]; 4]) -> Option<[[f64; 4]; 4]> {
    let mut a = m;
    let mut inv = [[0.0; 4]; 4];
    for i in 0..4 {
        inv[i][i] = 1.0;
    }
    for col in 0..4 {
        let pivot = (col..4).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        inv.swap(col, pivot);
        let p = a[col][col];
        for j in 0..4 {
            a[col][j] /= p;
            inv[col][j] /= p;
        }
        for row in 0..4 {
            if row != col {
                let f = a[row][col];
                for j in 0..4 {
                    a[row][j] -= f * a[col][j];
                    inv[row][j] -= f * inv[col][j];
                }
            }
        }
    }
    Some(inv)
}

/// The relative error of the elements with a Gauss point within `radius` of `at`: the square root of their error
/// energy over their strain energy. 0 when nothing there carries energy.
pub fn local_relative(
    solution: &Solution,
    element_error: &[f64],
    at: [f64; 3],
    radius: f64,
) -> f64 {
    let mut near = vec![false; solution.mesh.elements.len()];
    for sample in &solution.gauss {
        let d2: f64 = (0..3).map(|k| (sample.xyz[k] - at[k]).powi(2)).sum();
        if d2 <= radius * radius {
            near[sample.element] = true;
        }
    }
    let mut energy = 0.0;
    for sample in &solution.gauss {
        if near[sample.element] {
            let se = quad_form(&sample.stress, &sample.compliance) * sample.weight_det;
            if se.is_finite() && se > 0.0 {
                energy += se;
            }
        }
    }
    let err: f64 = element_error
        .iter()
        .enumerate()
        .filter(|(e, v)| near.get(*e).copied().unwrap_or(false) && v.is_finite())
        .map(|(_, v)| *v)
        .sum();
    if energy <= 1e-30 {
        0.0
    } else {
        (err / energy).sqrt()
    }
}

fn quad_form(v: &[f64; 6], s: &[[f64; 6]; 6]) -> f64 {
    let mut sv = [0.0; 6];
    for i in 0..6 {
        for j in 0..6 {
            sv[i] += s[i][j] * v[j];
        }
    }
    let mut out = 0.0;
    for i in 0..6 {
        out += v[i] * sv[i];
    }
    out
}
