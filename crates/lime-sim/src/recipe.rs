//! Smear of walls and infill. The solver never plans a bead.
//!
//! Skin on a face whose outward normal is within 45° of the build axis is
//! `skin_layers` thick (three layer heights until the real skin bands are
//! read). Side skin is `walls * line_width`. The core is the infill fraction
//! times the pattern factor. An unmeasured pattern uses the grid factor, 1.

use serde::{Deserialize, Serialize};

use crate::element::element;
use crate::error::SimError;
use crate::mesh::Mesh;
use crate::skin::SurfaceBands;
use crate::units::normalize;

/// A modifier or a painted reinforcement is recorded on the recipe. This
/// version does not smear either one. Option (b) in SR-02: refuse, do not
/// drop the keys and do not change the wall bands.
pub const REGIONS_REFUSAL: &str = "Modifier and reinforcement regions are not in this version.";

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
                "Lines infill is modelled as a grid of the same density. Its strength along each layer's direction is not modelled.",
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

/// A height range or a modifier volume, as the panel records it. Present so
/// the key is not an unknown field. A non-empty list is refused.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub walls: Option<u32>,
    #[serde(default)]
    pub infill: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// Height ranges and modifier volumes. Empty is the whole-part smear.
    #[serde(default)]
    pub regions: Vec<Region>,
    /// The raised core after painted reinforcement. Absent, or not above
    /// `infill`, does not change the smear.
    #[serde(default)]
    pub reinforced_infill: f64,
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
            regions: Vec::new(),
            reinforced_infill: 1.0,
        }
    }

    pub fn pattern_is_measured(&self) -> bool {
        self.pattern_measured || self.pattern.measured()
    }

    /// Refuse a modifier or a reinforcement that would change the smear.
    /// An empty region list and a reinforced infill that does not exceed
    /// `infill` are the recipe the panel sends when neither is set.
    pub fn refuse_regions(&self) -> Result<(), SimError> {
        let raised = self.reinforced_infill > self.infill + 1e-9;
        if self.regions.is_empty() && !raised {
            return Ok(());
        }
        Err(SimError::new(REGIONS_REFUSAL))
    }
}

/// One fraction per element. 1 is solid polymer, the infill number is the core.
///
/// The walls and skins are a band inside the part's real surface, found by
/// [`crate::skin::SurfaceBands`]. Each element's fraction is its wall share
/// at 1 plus the rest at the core fraction.
pub fn volume_fractions(mesh: &Mesh, recipe: &Recipe, build_axis: [f64; 3]) -> Vec<f64> {
    let n = mesh.elements.len();
    if recipe.infill >= 1.0 - 1e-12 {
        return vec![1.0; n];
    }
    let Some(axis) = normalize(build_axis) else {
        return vec![recipe.infill.clamp(0.0, 1.0); n];
    };
    let core = (recipe.infill * recipe.pattern_factor).clamp(0.0, 1.0);
    let skin = f64::from(recipe.skin_layers) * recipe.layer_height_mm;
    let wall = f64::from(recipe.walls) * recipe.line_width_mm;
    let bands = SurfaceBands::new(mesh, axis, skin, wall);
    bands
        .wall_shares(mesh)
        .into_iter()
        .map(|share| (share + (1.0 - share) * core).clamp(0.0, 1.0))
        .collect()
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
