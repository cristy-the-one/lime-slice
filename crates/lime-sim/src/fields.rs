//! A result is a list of fields, not a hard-coded stress blob.
//!
//! Value arrays stay in memory. The summary is the small object a later
//! `sim_run` returns. The label is the same string the panel will show.

use serde::Serialize;

use crate::mesh::Mesh;
use crate::trust::TrustLevel;

pub const LABEL: &str = "In-house estimate";
pub const FORMAT: &str = "sim-result-1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldDesc {
    pub name: &'static str,
    pub location: &'static str,
    pub rank: &'static str,
    pub unit: &'static str,
}

pub fn field_list() -> Vec<FieldDesc> {
    vec![
        FieldDesc {
            name: "displacement",
            location: "node",
            rank: "vector",
            unit: "mm",
        },
        FieldDesc {
            name: "von_mises",
            location: "node",
            rank: "scalar",
            unit: "MPa",
        },
        FieldDesc {
            name: "stress",
            location: "gauss",
            rank: "tensor",
            unit: "MPa",
        },
        FieldDesc {
            name: "safety_factor",
            location: "node",
            rank: "scalar",
            unit: "1",
        },
        FieldDesc {
            name: "element_error",
            location: "element",
            rank: "scalar",
            unit: "1",
        },
    ]
}

#[derive(Clone, Debug)]
pub struct GaussSample {
    pub element: usize,
    pub xi: [f64; 3],
    pub weight_det: f64,
    pub stress: [f64; 6],
    pub strain: [f64; 6],
    pub xyz: [f64; 3],
    /// Compliance at this point, so the estimator can form eᵀ S e.
    pub compliance: [[f64; 6]; 6],
}

#[derive(Clone, Debug)]
pub struct Solution {
    pub mesh: Mesh,
    pub displacement: Vec<[f64; 3]>,
    pub nodal_stress: Vec<[f64; 6]>,
    pub von_mises: Vec<f64>,
    pub safety: Vec<f64>,
    pub gauss: Vec<GaussSample>,
    pub element_error: Vec<f64>,
    pub relative_energy_error: f64,
    pub residual: f64,
    pub mass_g: f64,
    pub solid_mass_g: f64,
    pub trust: TrustLevel,
    pub notes: Vec<String>,
    pub max_von_mises_mpa: f64,
    pub max_von_mises_at: [f64; 3],
    pub max_displacement_mm: f64,
    pub max_displacement_at: [f64; 3],
    pub min_safety_factor: f64,
    pub min_safety_at: [f64; 3],
    pub criterion: String,
    pub label: String,
    pub steps_run: usize,
    pub h_mm: f64,
    pub dofs: usize,
    pub element: String,
    pub provisional: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustReport {
    pub level: TrustLevel,
    pub relative_energy_error: f64,
    pub residual: f64,
    pub element: String,
    pub h_mm: f64,
    pub nodes: usize,
    pub dofs: usize,
    pub notes: Vec<String>,
}

/// The small reply. No triangles, no stiffness, no value arrays.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub label: String,
    pub max_von_mises_mpa: f64,
    pub max_von_mises_at: [f64; 3],
    pub max_displacement_mm: f64,
    pub max_displacement_at: [f64; 3],
    pub min_safety_factor: f64,
    pub min_safety_at: [f64; 3],
    pub criterion: String,
    pub mass_g: f64,
    pub solid_mass_g: f64,
    pub trust: TrustReport,
    pub stale: bool,
}

impl Solution {
    pub fn summary(&self) -> Summary {
        Summary {
            label: self.label.clone(),
            max_von_mises_mpa: self.max_von_mises_mpa,
            max_von_mises_at: self.max_von_mises_at,
            max_displacement_mm: self.max_displacement_mm,
            max_displacement_at: self.max_displacement_at,
            min_safety_factor: self.min_safety_factor,
            min_safety_at: self.min_safety_at,
            criterion: self.criterion.clone(),
            mass_g: self.mass_g,
            solid_mass_g: self.solid_mass_g,
            trust: TrustReport {
                level: self.trust,
                relative_energy_error: self.relative_energy_error,
                residual: self.residual,
                element: self.element.clone(),
                h_mm: self.h_mm,
                nodes: self.mesh.nodes.len(),
                dofs: self.dofs,
                notes: self.notes.clone(),
            },
            stale: false,
        }
    }
}
