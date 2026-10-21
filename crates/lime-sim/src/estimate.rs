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

use crate::assemble::{Hold, NodeHold};
use crate::element::{shape_of, ElementKind};
use crate::fields::GaussSample;
use crate::fields::Solution;
use crate::mesh::{boundary_faces, Mesh};

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

/// Elements near the edge of a hold that grips along the surface: within `reach` of a node held in a direction
/// tangential to a boundary face through it, on a face that has a corner not held in that direction.
///
/// That is the perimeter of a fixed face, a pinned point, or a pinned line. There the exact stress has no finite
/// limit, so the error does not fall as the mesh is refined (a cantilever whose root shear went through one pinned
/// node read 0.022, 0.034, then 0.074). A hold across the surface, the normal of a symmetry plane or of a sliding
/// root, makes no such corner and is not marked. The field near a singular edge looks the same at every scale, so
/// the error a fixed number of elements away does not fall either. Only a fixed physical distance does: `reach`.
pub fn held_edge_elements(mesh: &Mesh, holds: &[NodeHold], reach: f64) -> Vec<bool> {
    // The directions each node is held in, as unit vectors. Fixed is all three axes.
    let mut held: Vec<Vec<[f64; 3]>> = vec![Vec::new(); mesh.nodes.len()];
    for hold in holds {
        let Some(list) = held.get_mut(hold.node) else {
            continue;
        };
        match &hold.hold {
            Hold::Fixed => list.extend([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
            Hold::Axis { axis, .. } => {
                let mut d = [0.0; 3];
                if let Some(slot) = d.get_mut(*axis) {
                    *slot = 1.0;
                }
                list.push(d);
            }
            Hold::Normal { normal, .. } => list.push(*normal),
            // Columns of `q` are the local directions in global coordinates.
            Hold::Frame { q, prescribed } => {
                for (j, p) in prescribed.iter().enumerate() {
                    if p.is_some() {
                        list.push([q[0][j], q[1][j], q[2][j]]);
                    }
                }
            }
        }
    }
    let holds_dir = |node: usize, d: [f64; 3]| {
        held[node]
            .iter()
            .any(|h| (h[0] * d[0] + h[1] * d[1] + h[2] * d[2]).abs() > 0.9)
    };
    // A held direction grips only when it runs along every boundary face through the node. A roller or a symmetry
    // plane holds across its own face, so where two of them meet each held direction is across one of the faces.
    let faces = boundary_faces(mesh);
    let mut normals: Vec<Vec<[f64; 3]>> = vec![Vec::new(); mesh.nodes.len()];
    for face in &faces {
        for &node in &face.nodes[..face.nodes.len().min(3)] {
            normals[node].push(face.normal);
        }
    }
    let dot3 = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let mut edge = vec![false; mesh.nodes.len()];
    for face in &faces {
        let corners = &face.nodes[..face.nodes.len().min(3)];
        for &node in corners {
            for d in &held[node] {
                let grips = normals[node].iter().all(|n| dot3(*d, *n).abs() < 0.9);
                if grips && corners.iter().any(|&other| !holds_dir(other, *d)) {
                    edge[node] = true;
                }
            }
        }
    }
    let singular: Vec<[f64; 3]> = (0..mesh.nodes.len())
        .filter(|&n| edge[n])
        .map(|n| mesh.nodes[n])
        .collect();
    if singular.is_empty() {
        return vec![false; mesh.elements.len()];
    }
    let reach2 = reach * reach;
    mesh.elements
        .iter()
        .map(|cell| {
            cell.nodes.iter().any(|&n| edge[n])
                || cell.nodes.iter().take(4).any(|&n| {
                    let p = mesh.nodes[n];
                    singular
                        .iter()
                        .any(|s| (0..3).map(|k| (p[k] - s[k]).powi(2)).sum::<f64>() <= reach2)
                })
        })
        .collect()
}

/// How far from the edge of a fixed hold trust is judged: one and a half elements, or a fifth of the part's thinnest
/// extent, whichever is larger. The second term is a fixed physical distance, so the judged point does not creep into
/// the singularity as the mesh is refined.
pub fn hold_reach(mesh: &Mesh, h_mm: f64) -> f64 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in &mesh.nodes {
        for k in 0..3 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }
    let thinnest = (0..3)
        .map(|k| max[k] - min[k])
        .fold(f64::INFINITY, f64::min);
    let thinnest = if thinnest.is_finite() { thinnest } else { 0.0 };
    (1.5 * h_mm).max(0.2 * thinnest)
}

/// The relative error of the elements with a Gauss point within `radius` of `at`, leaving out the elements `skip`
/// marks: the square root of their error energy over their strain energy. 0 when nothing there carries energy.
pub fn local_relative(
    solution: &Solution,
    element_error: &[f64],
    at: [f64; 3],
    radius: f64,
    skip: &[bool],
) -> f64 {
    let mut near = vec![false; solution.mesh.elements.len()];
    for sample in &solution.gauss {
        if skip.get(sample.element).copied().unwrap_or(false) {
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::ElementKind;
    use crate::mesh::grid;

    fn root(mesh: &Mesh) -> Vec<usize> {
        (0..mesh.nodes.len())
            .filter(|&n| mesh.nodes[n][0] < 1e-9)
            .collect()
    }

    #[test]
    fn a_sliding_face_is_not_a_hold_edge() {
        let mesh = grid([0.0; 3], [8.0, 4.0, 4.0], [4, 2, 2], ElementKind::Tet10).unwrap();
        let holds: Vec<NodeHold> = root(&mesh)
            .into_iter()
            .map(|node| NodeHold {
                node,
                hold: Hold::Axis {
                    axis: 0,
                    value: 0.0,
                },
            })
            .collect();
        assert!(held_edge_elements(&mesh, &holds, 0.0).iter().all(|&s| !s));
    }

    #[test]
    fn a_pinned_node_and_a_fixed_face_are_hold_edges() {
        let mesh = grid([0.0; 3], [8.0, 4.0, 4.0], [4, 2, 2], ElementKind::Tet10).unwrap();
        let nodes = root(&mesh);
        let centre = *nodes
            .iter()
            .min_by(|&&a, &&b| {
                let d =
                    |n: usize| (mesh.nodes[n][1] - 2.0).powi(2) + (mesh.nodes[n][2] - 2.0).powi(2);
                d(a).total_cmp(&d(b))
            })
            .unwrap();
        let mut holds: Vec<NodeHold> = nodes
            .iter()
            .map(|&node| NodeHold {
                node,
                hold: Hold::Axis {
                    axis: 0,
                    value: 0.0,
                },
            })
            .collect();
        holds.push(NodeHold {
            node: centre,
            hold: Hold::Axis {
                axis: 2,
                value: 0.0,
            },
        });
        let pinned = held_edge_elements(&mesh, &holds, 0.0);
        assert!(mesh
            .elements
            .iter()
            .zip(&pinned)
            .any(|(cell, &s)| s && cell.nodes.contains(&centre)));
        assert!(
            pinned.iter().any(|&s| !s),
            "only the elements at the pin are marked"
        );
        let fixed: Vec<NodeHold> = nodes
            .into_iter()
            .map(|node| NodeHold {
                node,
                hold: Hold::Fixed,
            })
            .collect();
        let clamped = held_edge_elements(&mesh, &fixed, 0.0);
        assert!(clamped.iter().any(|&s| s) && clamped.iter().any(|&s| !s));
    }
}
