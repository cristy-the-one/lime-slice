//! Zienkiewicz–Zhu estimator. v1 reports the number and does not remesh.
//!
//! A smoothed stress is the nodal average of the Gauss stresses, weighted
//! equally per Gauss point of the elements that touch the node. The element
//! indicator is the energy of the difference, eᵀ S e. The global number is
//! the square root of that energy over the strain energy.

use std::cell::Cell;

use crate::element::shape_of;
use crate::fields::Solution;

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
        let nodal = nodal_average(solution);
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

fn nodal_average(solution: &Solution) -> Vec<[f64; 6]> {
    let n = solution.mesh.nodes.len();
    let mut sum = vec![[0.0; 6]; n];
    let mut count = vec![0.0; n];
    for sample in &solution.gauss {
        for &node in &solution.mesh.elements[sample.element].nodes {
            for k in 0..6 {
                sum[node][k] += sample.stress[k];
            }
            count[node] += 1.0;
        }
    }
    for i in 0..n {
        if count[i] > 0.0 {
            for k in 0..6 {
                sum[i][k] /= count[i];
            }
        }
    }
    sum
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
