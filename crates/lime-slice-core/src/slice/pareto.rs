use super::pipeline::slice_plate;
use super::preview_paths::scarf_scales;
use super::{load_object, wire, PlateOrder, Source};
use crate::gcode::PlateLayer;
use crate::{
    BlendMode, BlendScore, Job, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId,
    Watch,
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParetoPoint {
    pub label: String,
    pub toughness: f64,
    pub seconds: f64,
    pub filament_g: f64,
    /// Structural toughness proxy from the same scorer as a normal slice.
    pub score: f64,
}

/// `pareto_estimates` for a slice request: its mesh, printer, and settings.
pub fn pareto_request(req: &SliceRequest, job: Job) -> Result<Vec<ParetoPoint>, String> {
    let profile = req.printer.clone().unwrap_or_default();
    let overrides = wire::parse_overrides(req, [profile.bed_x, profile.bed_y])?;
    let (mesh, settings) = load_object(req, &overrides, job)?;
    pareto_on(&mesh, &profile, &settings, req.belt.as_ref())
}

/// Speed, three weight mixes, and toughness. No preview polylines and no G-code text.
pub fn pareto_estimates(
    mesh: &Mesh,
    profile: &PrinterProfile,
    settings: &SliceSettings,
) -> Result<Vec<ParetoPoint>, String> {
    pareto_on(mesh, profile, settings, None)
}

/// The five blends, laid on `belt` as a slice would be when there is one.
pub(super) fn pareto_on(
    mesh: &Mesh,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    belt: Option<&crate::belt::BeltSpec>,
) -> Result<Vec<ParetoPoint>, String> {
    let mut quiet = settings.unkept();
    quiet.baseline = false;
    quiet.compare = false;
    quiet.include_gcode = false;
    let points = [
        (0.0, "speed"),
        (0.25, "weight 25%"),
        (0.5, "weight 50%"),
        (0.75, "weight 75%"),
        (1.0, "toughness"),
    ];
    // Each blend already fans its layers out across the pool. A second
    // `par_iter` over the five blends oversubscribes that pool: on this part
    // the grid blend then took ~20 s instead of ~7.5 s alone, and the five
    // together were slower than one-after-another. The blends share one cut.
    let mut cut = None;
    points
        .iter()
        .map(|(toughness, label)| {
            let blend = if *toughness <= 1e-9 {
                BlendMode::Single {
                    strategy: StrategyId::Speed,
                }
            } else if *toughness >= 1.0 - 1e-9 {
                BlendMode::Single {
                    strategy: StrategyId::Toughness,
                }
            } else {
                BlendMode::Weight {
                    toughness: *toughness,
                }
            };
            let source = Source {
                id: None,
                mesh,
                blend: &blend,
                settings: quiet.clone(),
            };
            let response = slice_plate(
                &[source],
                &blend,
                profile,
                &quiet,
                belt,
                PlateOrder::AllAtOnce,
                &mut cut,
                &Watch::idle(),
            )?;
            Ok(ParetoPoint {
                label: (*label).into(),
                toughness: *toughness,
                seconds: response.estimate.seconds,
                filament_g: response.estimate.filament_g,
                score: response.score.toughness,
            })
        })
        .collect()
}

pub(super) fn score_of(seconds: f64, grams: f64, toughness: f64) -> BlendScore {
    BlendScore {
        speed: 60.0 / (seconds / 60.0).max(0.05),
        efficiency: 8.0 / grams.max(0.02),
        toughness,
    }
}

pub(super) fn structural_mm3(layers: &[PlateLayer]) -> f64 {
    layers
        .iter()
        .map(|layer| {
            layer
                .paths()
                .map(|(_, path)| {
                    let len = path
                        .points
                        .windows(2)
                        .map(|w| {
                            let dx = w[1][0] - w[0][0];
                            let dy = w[1][1] - w[0][1];
                            dx.hypot(dy)
                        })
                        .sum::<f64>();
                    let h = if path.bead_height > 1e-6 {
                        path.bead_height
                    } else {
                        layer.height
                    };
                    let (z_scale, flow_scale) = scarf_scales(path);
                    len * path.width * h * z_scale * path.strength * path.flow * flow_scale
                })
                .sum::<f64>()
        })
        .sum()
}
