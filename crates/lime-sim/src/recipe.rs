//! Smear of walls and infill. The solver never plans a bead.
//!
//! Skin on a face whose outward normal is within 45° of the build axis is
//! `skin_layers` thick (three layer heights until the real skin bands are
//! read). Side skin is `walls * line_width`. The core is the infill fraction
//! times the pattern factor. An unmeasured pattern uses the grid factor, 1.

use serde::{Deserialize, Serialize};

use crate::element::element;
use crate::mesh::Mesh;
use crate::units::{dot, normalize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pattern {
    Lines,
    Grid,
    Gyroid,
    Lightning,
}

impl Pattern {
    pub fn measured(self) -> bool {
        matches!(self, Self::Grid)
    }

    pub fn factor(self) -> f64 {
        // Unmeasured patterns do not invent a stiffness. They use the grid.
        1.0
    }

    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Grid => None,
            Self::Lines => Some(
                "Lines infill is modelled as a grid of the same density. The factor has not been measured.",
            ),
            Self::Gyroid => Some(
                "Gyroid infill is modelled as a grid of the same density. The factor has not been measured.",
            ),
            Self::Lightning => Some(
                "Lightning infill is modelled as a grid of the same density. A tree of struts is a poor smear.",
            ),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub walls: u32,
    pub line_width_mm: f64,
    pub layer_height_mm: f64,
    #[serde(default = "three_layers")]
    pub skin_layers: u32,
    /// 0 to 1.
    pub infill: f64,
    pub pattern: Pattern,
    #[serde(default = "one")]
    pub pattern_factor: f64,
    #[serde(default)]
    pub pattern_measured: bool,
}

fn three_layers() -> u32 {
    3
}
fn one() -> f64 {
    1.0
}

impl Default for Recipe {
    fn default() -> Self {
        Self::solid()
    }
}

impl Recipe {
    pub fn solid() -> Self {
        Self {
            walls: 2,
            line_width_mm: 0.4,
            layer_height_mm: 0.2,
            skin_layers: 3,
            infill: 1.0,
            pattern: Pattern::Grid,
            pattern_factor: 1.0,
            pattern_measured: true,
        }
    }

    pub fn pattern_is_measured(&self) -> bool {
        self.pattern_measured || self.pattern.measured()
    }
}

/// One fraction per element. 1 is solid polymer, the infill number is the core.
pub fn volume_fractions(mesh: &Mesh, recipe: &Recipe, build_axis: [f64; 3]) -> Vec<f64> {
    let n = mesh.elements.len();
    if recipe.infill >= 1.0 - 1e-12 {
        return vec![1.0; n];
    }
    let Some(axis) = normalize(build_axis) else {
        return vec![recipe.infill.clamp(0.0, 1.0); n];
    };
    let (min, max) = bounds(mesh);
    let core = (recipe.infill * recipe.pattern_factor).clamp(0.0, 1.0);
    let mut out = Vec::with_capacity(n);
    for elem in &mesh.elements {
        let coords: Vec<[f64; 3]> = elem.nodes.iter().map(|i| mesh.nodes[*i]).collect();
        let Some(elem_kind) = element(mesh.kind) else {
            out.push(core);
            continue;
        };
        let mut inside = 0.0;
        let mut total = 0.0;
        for gp in elem_kind.quadrature() {
            let shape = elem_kind.shape(gp.xi);
            let mut p = [0.0; 3];
            for (a, n) in shape.n.iter().enumerate() {
                p[0] += n * coords[a][0];
                p[1] += n * coords[a][1];
                p[2] += n * coords[a][2];
            }
            total += 1.0;
            if in_skin(p, min, max, axis, recipe) {
                inside += 1.0;
            }
        }
        let frac = if total == 0.0 { 0.0 } else { inside / total };
        out.push((frac + (1.0 - frac) * core).clamp(0.0, 1.0));
    }
    out
}

fn bounds(mesh: &Mesh) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in &mesh.nodes {
        for k in 0..3 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }
    (min, max)
}

fn in_skin(p: [f64; 3], min: [f64; 3], max: [f64; 3], axis: [f64; 3], recipe: &Recipe) -> bool {
    let faces = [
        ([-1.0, 0.0, 0.0], p[0] - min[0]),
        ([1.0, 0.0, 0.0], max[0] - p[0]),
        ([0.0, -1.0, 0.0], p[1] - min[1]),
        ([0.0, 1.0, 0.0], max[1] - p[1]),
        ([0.0, 0.0, -1.0], p[2] - min[2]),
        ([0.0, 0.0, 1.0], max[2] - p[2]),
    ];
    let limit = (45.0_f64.to_radians()).cos();
    for (normal, distance) in faces {
        let thick = if dot(normal, axis).abs() >= limit {
            recipe.skin_layers as f64 * recipe.layer_height_mm
        } else {
            recipe.walls as f64 * recipe.line_width_mm
        };
        if distance <= thick + 1e-9 {
            return true;
        }
    }
    false
}

pub fn integrate_volumes(mesh: &Mesh, vf: &[f64]) -> (f64, f64) {
    let Some(elem) = element(mesh.kind) else {
        return (0.0, 0.0);
    };
    let mut solid = 0.0;
    let mut printed = 0.0;
    for (ei, cell) in mesh.elements.iter().enumerate() {
        let coords: Vec<[f64; 3]> = cell.nodes.iter().map(|i| mesh.nodes[*i]).collect();
        for gp in elem.quadrature() {
            let shape = elem.shape(gp.xi);
            if let Some((_, det)) = crate::element::gradients(&shape.dn_dxi, &coords) {
                let dv = gp.weight * det;
                solid += dv;
                printed += dv * vf.get(ei).copied().unwrap_or(1.0);
            }
        }
    }
    (solid, printed)
}
