//! The study document, `format: "lime-sim-1"`.
//!
//! The panel, the project file, and the MCP read this object. The solver
//! receives it plus a mesh. A value this version cannot run is refused with
//! one sentence. It is not dropped and it is not ignored.

use serde::{Deserialize, Serialize};

use crate::assemble::{Hold, Load, NodeHold};
use crate::element::ElementKind;
use crate::error::{bead_refused, temperature_refused, tet4_refused, zero_axis, SimError};
use crate::material::LinearOrthotropic;
use crate::mesh::Mesh;
use crate::recipe::Recipe;
use crate::sliced::CellMaterial;
use crate::solve::{Csc, EigenSolver, ModalStub};
use crate::units::{normalize, GRAVITY_MM_S2};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub polymer: String,
    #[serde(default)]
    pub provisional: bool,
    #[serde(rename = "EInPlaneMPa")]
    pub e_in_plane_mpa: f64,
    #[serde(rename = "EAcrossLayersMPa")]
    pub e_across_layers_mpa: f64,
    pub nu: f64,
    #[serde(rename = "strengthInPlaneMPa")]
    pub strength_in_plane_mpa: f64,
    #[serde(rename = "strengthAcrossLayersMPa")]
    pub strength_across_layers_mpa: f64,
    /// Absent on an older card. Then compression uses the tension number.
    #[serde(default, rename = "compressionInPlaneMPa")]
    pub compression_in_plane_mpa: Option<f64>,
    #[serde(default, rename = "compressionAcrossLayersMPa")]
    pub compression_across_layers_mpa: Option<f64>,
    /// Absent on an older card. Then shear is half the across-layer tension.
    #[serde(default, rename = "shearAcrossLayersMPa")]
    pub shear_across_layers_mpa: Option<f64>,
    #[serde(rename = "densityGCm3")]
    pub density_g_cm3: f64,
    #[serde(default, rename = "measuredAtC")]
    pub measured_at_c: Option<f64>,
    #[serde(default)]
    pub specimen: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub isotropic: bool,
}

impl Card {
    pub fn material(&self) -> LinearOrthotropic {
        LinearOrthotropic {
            e_in_plane_mpa: self.e_in_plane_mpa,
            e_across_layers_mpa: self.e_across_layers_mpa,
            nu: self.nu,
            strength_in_plane_mpa: self.strength_in_plane_mpa,
            strength_across_layers_mpa: self.strength_across_layers_mpa,
            compression_in_plane_mpa: self
                .compression_in_plane_mpa
                .unwrap_or(self.strength_in_plane_mpa),
            compression_across_layers_mpa: self
                .compression_across_layers_mpa
                .unwrap_or(self.strength_across_layers_mpa),
            shear_across_layers_mpa: self
                .shear_across_layers_mpa
                .unwrap_or(0.5 * self.strength_across_layers_mpa),
            density_g_cm3: self.density_g_cm3,
            isotropic: self.isotropic,
        }
    }
}

/// Placeholders so a study can be tried. Not a data sheet.
pub fn provisional_cards() -> Vec<Card> {
    vec![
        card("inhouse-pla", "PLA", 1700.0, 1400.0, 0.35, 28.0, 14.0, 1.24),
        card(
            "inhouse-petg",
            "PETG",
            1800.0,
            1500.0,
            0.35,
            30.0,
            15.0,
            1.27,
        ),
        card("inhouse-abs", "ABS", 1600.0, 1300.0, 0.35, 25.0, 12.0, 1.04),
        card("inhouse-tpu", "TPU", 80.0, 60.0, 0.45, 10.0, 5.0, 1.21),
    ]
}

#[allow(clippy::too_many_arguments)]
fn card(
    id: &str,
    polymer: &str,
    e_in: f64,
    e_z: f64,
    nu: f64,
    s_in: f64,
    s_z: f64,
    density: f64,
) -> Card {
    Card {
        id: id.into(),
        polymer: polymer.into(),
        provisional: true,
        e_in_plane_mpa: e_in,
        e_across_layers_mpa: e_z,
        nu,
        strength_in_plane_mpa: s_in,
        strength_across_layers_mpa: s_z,
        compression_in_plane_mpa: Some(s_in),
        compression_across_layers_mpa: Some(s_z),
        shear_across_layers_mpa: Some(0.5 * s_z),
        density_g_cm3: density,
        measured_at_c: None,
        specimen: "placeholder, not measured".into(),
        method: None,
        source: "in-house".into(),
        isotropic: false,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub factor: f64,
    #[serde(default = "one_iter")]
    pub max_iter: u32,
    #[serde(default = "default_tol")]
    pub tol: f64,
}

fn one_iter() -> u32 {
    1
}
fn default_tol() -> f64 {
    1e-8
}

fn default_steps() -> Vec<Step> {
    vec![Step {
        factor: 1.0,
        max_iter: 1,
        tol: 1e-8,
    }]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum StudyHold {
    Fixed {
        node: usize,
    },
    Axis {
        node: usize,
        axis: usize,
        value: f64,
    },
    Normal {
        node: usize,
        normal: [f64; 3],
        value: f64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum StudyLoad {
    Force {
        node: usize,
        force: [f64; 3],
    },
    Traction {
        nodes: Vec<usize>,
        traction: [f64; 3],
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Study {
    pub format: String,
    #[serde(default = "default_true")]
    pub linear: bool,
    #[serde(default = "default_element")]
    pub element: String,
    #[serde(default = "default_solver")]
    pub solver: String,
    #[serde(default = "default_representation")]
    pub representation: String,
    #[serde(default = "default_analysis")]
    pub analysis: String,
    #[serde(default = "default_axis")]
    pub build_axis: [f64; 3],
    #[serde(default)]
    pub h_mm: f64,
    #[serde(default)]
    pub gravity: bool,
    #[serde(default)]
    pub temperature_c: Option<f64>,
    #[serde(default)]
    pub fibre_axis: Option<[f64; 3]>,
    pub card: Card,
    #[serde(default)]
    pub recipe: Recipe,
    #[serde(default = "default_steps")]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub post_steps: Vec<serde_json::Value>,
    #[serde(default)]
    pub holds: Vec<StudyHold>,
    #[serde(default)]
    pub loads: Vec<StudyLoad>,
}

fn default_true() -> bool {
    true
}
fn default_element() -> String {
    "tet10".into()
}
fn default_solver() -> String {
    "faer-ldlt".into()
}
fn default_representation() -> String {
    "smear".into()
}
fn default_analysis() -> String {
    "static".into()
}
fn default_axis() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

/// What the driver runs. Tests build this directly so a TET4 regression can
/// pass the study gate that refuses linear tetrahedra.
pub struct Request {
    pub mesh: Mesh,
    pub material: LinearOrthotropic,
    pub recipe: Recipe,
    pub build_axis: [f64; 3],
    pub holds: Vec<NodeHold>,
    pub loads: Vec<Load>,
    pub steps: Vec<Step>,
    pub linear: bool,
    pub gravity: Option<f64>,
    pub h_mm: f64,
    pub allow_linear_tets: bool,
    pub analysis: String,
    pub temperature_c: Option<f64>,
    pub fibre_axis: Option<[f64; 3]>,
    pub solver: String,
    pub representation: String,
    /// One material per element for `representation: "sliced"`, from its
    /// grid cell. Empty for a smear, whose fractions come from the recipe.
    pub cells: Vec<CellMaterial>,
    pub post_steps: Vec<serde_json::Value>,
    pub provisional: bool,
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    pub on_progress: Option<fn(&'static str)>,
}

impl Study {
    pub fn to_request(&self, mesh: &Mesh) -> Result<Request, SimError> {
        validate_study(self)?;
        let (kind, name) = ElementKind::parse(&self.element);
        if mesh.kind != kind {
            return Err(SimError::new(format!(
                "The mesh is {}, and the study asks for {name}.",
                mesh.kind.name()
            )));
        }
        let mut holds = Vec::new();
        for hold in &self.holds {
            match hold {
                StudyHold::Fixed { node } => holds.push(NodeHold {
                    node: *node,
                    hold: Hold::Fixed,
                }),
                StudyHold::Axis { node, axis, value } => holds.push(NodeHold {
                    node: *node,
                    hold: Hold::Axis {
                        axis: *axis,
                        value: *value,
                    },
                }),
                StudyHold::Normal {
                    node,
                    normal,
                    value,
                } => holds.push(NodeHold {
                    node: *node,
                    hold: Hold::Normal {
                        normal: *normal,
                        value: *value,
                    },
                }),
            }
        }
        let mut loads = Vec::new();
        for load in &self.loads {
            match load {
                StudyLoad::Force { node, force } => loads.push(Load::Force {
                    node: *node,
                    force: *force,
                }),
                StudyLoad::Traction { nodes, traction } => loads.push(Load::Traction {
                    nodes: nodes.clone(),
                    traction: *traction,
                }),
            }
        }
        Ok(Request {
            mesh: mesh.clone(),
            material: self.card.material(),
            recipe: self.recipe.clone(),
            build_axis: self.build_axis,
            holds,
            loads,
            steps: self.steps.clone(),
            linear: self.linear,
            gravity: if self.gravity {
                Some(GRAVITY_MM_S2)
            } else {
                None
            },
            h_mm: self.h_mm,
            allow_linear_tets: false,
            analysis: self.analysis.clone(),
            temperature_c: self.temperature_c,
            fibre_axis: self.fibre_axis,
            solver: self.solver.clone(),
            representation: self.representation.clone(),
            cells: Vec::new(),
            post_steps: self.post_steps.clone(),
            provisional: self.card.provisional,
            cancel: None,
            on_progress: None,
        })
    }
}

pub fn validate_study(study: &Study) -> Result<(), SimError> {
    study.recipe.refuse_regions()?;
    if study.format != "lime-sim-1" {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            study.format
        )));
    }
    if study.temperature_c.is_some() || study.fibre_axis.is_some() {
        return Err(temperature_refused());
    }
    if study.solver != "faer-ldlt" {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            study.solver
        )));
    }
    if study.representation == "sliced" {
        return Err(SimError::new(
            "A sliced study is built from its slice field, not from a mesh.",
        ));
    }
    if study.representation != "smear" {
        return Err(bead_refused());
    }
    let (kind, name) = ElementKind::parse(&study.element);
    match kind {
        ElementKind::Tet10 => {}
        ElementKind::Tet4 => return Err(tet4_refused()),
        _ => {
            return Err(SimError::new(format!("{name} is not in this version.")));
        }
    }
    if normalize(study.build_axis).is_none() {
        return Err(zero_axis());
    }
    if study.analysis == "modal" {
        return Err(modal_sentence());
    }
    if study.analysis != "static" {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            study.analysis
        )));
    }
    Ok(())
}

pub fn validate_request_fields(req: &Request) -> Result<(), SimError> {
    req.recipe.refuse_regions()?;
    if req.solver != "faer-ldlt" {
        return Err(SimError::new(format!(
            "{} is not in this version.",
            req.solver
        )));
    }
    match req.representation.as_str() {
        "smear" if req.cells.is_empty() => {}
        "smear" => {
            return Err(SimError::new(
                "A smeared study takes its fractions from the recipe, not from cells.",
            ))
        }
        "sliced" if req.cells.len() == req.mesh.elements.len() => {}
        "sliced" => {
            return Err(SimError::new(format!(
                "A sliced study needs one cell per element: {} cells for {} elements.",
                req.cells.len(),
                req.mesh.elements.len()
            )))
        }
        _ => return Err(bead_refused()),
    }
    Ok(())
}

pub fn modal_sentence() -> SimError {
    let empty = Csc {
        nrows: 0,
        col_ptr: vec![0],
        row_idx: Vec::new(),
        values: Vec::new(),
    };
    let err = ModalStub.smallest(&empty, &empty, 0).unwrap_err();
    SimError::new(err.sentence())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn petg_card_matches_the_plan() {
        let raw = r#"{
          "id": "inhouse-petg",
          "polymer": "PETG",
          "provisional": true,
          "EInPlaneMPa": 1800,
          "EAcrossLayersMPa": 1500,
          "nu": 0.35,
          "strengthInPlaneMPa": 30,
          "strengthAcrossLayersMPa": 15,
          "densityGCm3": 1.27,
          "measuredAtC": null,
          "specimen": "not measured",
          "method": null,
          "source": "in-house"
        }"#;
        let card: Card = serde_json::from_str(raw).unwrap();
        assert!((card.e_in_plane_mpa - 1800.0).abs() < 1e-12);
        assert!((card.e_across_layers_mpa - 1500.0).abs() < 1e-12);
        assert!((card.density_g_cm3 - 1.27).abs() < 1e-12);
        assert!(card.provisional);
        assert!(!card.isotropic);
        let shipped = provisional_cards()
            .into_iter()
            .find(|c| c.id == "inhouse-petg")
            .unwrap();
        assert_eq!(shipped.e_in_plane_mpa, card.e_in_plane_mpa);
        assert_eq!(shipped.strength_across_layers_mpa, 15.0);
        assert_eq!(shipped.compression_in_plane_mpa, Some(30.0));
        assert_eq!(shipped.compression_across_layers_mpa, Some(15.0));
        assert_eq!(shipped.shear_across_layers_mpa, Some(7.5));
        assert!(
            shipped.specimen.contains("placeholder"),
            "{}",
            shipped.specimen
        );
        let filled = card.material();
        assert!((filled.compression_in_plane_mpa - 30.0).abs() < 1e-12);
        assert!((filled.shear_across_layers_mpa - 7.5).abs() < 1e-12);
    }

    #[test]
    fn thermal_and_modal_and_tet4_refuse() {
        let mut study = base();
        study.temperature_c = Some(40.0);
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "Temperature is not in this version."
        );
        study.temperature_c = None;
        study.fibre_axis = Some([1.0, 0.0, 0.0]);
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "Temperature is not in this version."
        );
        study.fibre_axis = None;
        study.analysis = "modal".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "Modal analysis is not in this version."
        );
        study.analysis = "static".into();
        study.element = "tet4".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "This study uses quadratic tetrahedra. Linear tetrahedra lock in bending."
        );
        study.element = "hex8".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "hex8 is not in this version."
        );
        study.element = "mystic".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "mystic is not in this version."
        );
        study.element = "tet10".into();
        study.representation = "voxel".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "A bead-by-bead model is not in this version."
        );
        study.representation = "smear".into();
        study.solver = "cholmod".into();
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "cholmod is not in this version."
        );
        study.solver = "faer-ldlt".into();
        study.build_axis = [0.0, 0.0, 0.0];
        assert_eq!(
            validate_study(&study).unwrap_err().message,
            "The build direction has zero length."
        );
    }

    fn base() -> Study {
        Study {
            format: "lime-sim-1".into(),
            linear: true,
            element: "tet10".into(),
            solver: "faer-ldlt".into(),
            representation: "smear".into(),
            analysis: "static".into(),
            build_axis: [0.0, 0.0, 1.0],
            h_mm: 10.0,
            gravity: false,
            temperature_c: None,
            fibre_axis: None,
            card: provisional_cards().into_iter().next().unwrap(),
            recipe: Recipe::solid(),
            steps: default_steps(),
            post_steps: Vec::new(),
            holds: Vec::new(),
            loads: Vec::new(),
        }
    }
}
