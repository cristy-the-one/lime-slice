use super::belt::{tilt_layer, tilt_preview};
use super::parts::Contours;
use super::patch::{PreviewPatch, WholePreview};
use super::pipeline::KeptPlate;
use super::preview_paths::{preview_layer, preview_of};
use super::{kept, patch, slice_sharing};
use crate::gcode::PlateLayer;
use crate::{
    BlendMode, CompareEstimate, FeatureEstimate, Mesh, PreviewLayer, PrinterProfile, ScarfSeam,
    SliceSettings, StrategyId, SupportStyle, VelocityCap, Watch,
};
use rayon::iter::{IndexedParallelIterator, IntoParallelRefIterator, ParallelIterator};
use std::sync::Arc;

/// The reply's preview. A kept plate names it with a token, and when the
/// request's `previewBase` is the preview the engine last drew from the same
/// cuts under the same blends and flow cap, only the layers that differ go
/// back, as a patch.
#[allow(clippy::too_many_arguments)]
pub(super) fn preview(
    planned: &Arc<Vec<PlateLayer>>,
    kept: Option<KeptPlate>,
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    preview_base: Option<&str>,
    layer_seconds: &[f64],
    layer_slow: &[f64],
    tilt: Option<&patch::BeltTilt>,
) -> (Vec<PreviewLayer>, Option<String>, Option<PreviewPatch>) {
    let Some(kept) = kept else {
        let mut layers = preview_of(planned, profile, blends, layer_seconds, layer_slow);
        if let Some(tilt) = tilt {
            tilt_preview(&mut layers, planned, tilt);
        }
        return (layers, None, None);
    };
    let mut emitted = 0;
    let mut slow = Vec::with_capacity(planned.len());
    let seconds: Vec<Option<f64>> = planned
        .iter()
        .map(|l| {
            if l.is_empty() {
                slow.push(1.0);
                return None;
            }
            slow.push(layer_slow.get(emitted).copied().unwrap_or(1.0));
            emitted += 1;
            Some(layer_seconds.get(emitted - 1).copied().unwrap_or(0.0))
        })
        .collect();
    // A different belt stamp is a different drawing. The planned paths can
    // match while the tilt does not, so that reply is the whole plate.
    let base = kept.prior.as_ref().filter(|(_, shown)| {
        preview_base == Some(shown.token.as_str())
            && shown.drawn == kept.drawn
            && shown.belt == kept.belt
            && shown.sequential == kept.sequential
    });
    let (mut layers, mut patched) = match base {
        Some((joined, shown)) => {
            let shown_blends: Vec<&BlendMode> = shown.blends.iter().collect();
            let restyled: Vec<bool> = (0..blends.len())
                .map(|o| {
                    shown
                        .blends
                        .get(o)
                        .is_none_or(|b| format!("{b:?}") != format!("{:?}", blends[o]))
                })
                .collect();
            let changed = planned
                .par_iter()
                .enumerate()
                .filter_map(|(i, layer)| {
                    let now = seconds[i]?;
                    let was = joined.get(i);
                    let held = was.is_some() && shown.seconds.get(i).is_some_and(Option::is_some);
                    let same = was.is_some_and(|w| w.same(layer))
                        && layer.runs.iter().all(|r| !restyled[r.object as usize]);
                    if held && same {
                        return None;
                    }
                    let layer = preview_layer(layer, profile, blends, now, slow[i]);
                    let was = match was.filter(|_| held) {
                        Some(was) => preview_layer(was, profile, &shown_blends, 0.0, 1.0).paths,
                        None => Vec::new(),
                    };
                    Some(patch::diff_layer(&was, layer))
                })
                .collect();
            let patch = PreviewPatch {
                base: shown.token.clone(),
                layers: planned
                    .iter()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.index)
                    .collect(),
                changed,
                seconds: seconds.iter().flatten().copied().collect(),
                slow: planned
                    .iter()
                    .zip(&slow)
                    .filter(|(l, _)| !l.is_empty())
                    .map(|(_, s)| *s)
                    .collect(),
                whole: WholePreview {
                    layers: Arc::clone(planned),
                    profile: profile.clone(),
                    blends: blends.iter().map(|&b| b.clone()).collect(),
                    layer_seconds: layer_seconds.to_vec(),
                    layer_slow: layer_slow.to_vec(),
                    tilt: tilt.cloned(),
                },
            };
            (Vec::new(), Some(patch))
        }
        None => (
            preview_of(planned, profile, blends, layer_seconds, layer_slow),
            None,
        ),
    };
    if let Some(tilt) = tilt {
        if let Some(patch) = patched.as_mut() {
            for changed in &mut patch.changed {
                if let Some(plate) = planned.iter().find(|l| l.index == changed.layer.index) {
                    tilt_layer(&mut changed.layer, plate, tilt);
                }
            }
        } else {
            tilt_preview(&mut layers, planned, tilt);
        }
    }
    kept::show(
        planned,
        patch::Shown {
            token: kept.token.clone(),
            drawn: kept.drawn,
            blends: blends.iter().map(|&b| b.clone()).collect(),
            seconds,
            belt: kept.belt,
            sequential: kept.sequential,
        },
    );
    (layers, Some(kept.token), patched)
}

pub(super) fn feature_estimates(
    rows: &[crate::gcode::FeatureStat],
    profile: &PrinterProfile,
) -> Vec<FeatureEstimate> {
    let area = std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2);
    let scale = area * profile.filament_density_g_cm3 / 1000.0;
    rows.iter()
        .map(|row| FeatureEstimate {
            kind: row.kind.clone(),
            seconds: row.seconds,
            filament_mm: row.filament_mm,
            filament_g: row.filament_mm * scale,
        })
        .collect()
}

pub(super) fn velocity_cap(
    gcode: &crate::gcode::GcodeStats,
    profile: &PrinterProfile,
) -> Option<VelocityCap> {
    if gcode.capped_mm <= 0.0 {
        return None;
    }
    let path = (gcode.extrusion_length_mm + gcode.travel_length_mm).max(gcode.capped_mm);
    Some(VelocityCap {
        max_velocity_mm_s: profile.max_velocity,
        fastest_feed_mm_s: gcode.capped_feed_mm_s,
        capped_share: gcode.capped_mm / path,
    })
}

pub(super) fn compare_estimates(
    mesh: &Mesh,
    settings: &SliceSettings,
    profile: &PrinterProfile,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<Vec<CompareEstimate>, String> {
    let mut quiet = settings.unkept();
    quiet.baseline = false;
    quiet.compare = false;
    let modes = [
        (
            "speed",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            false,
        ),
        ("efficiency", BlendMode::Weight { toughness: 0.5 }, false),
        (
            "toughness",
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
            false,
        ),
        (
            "classic",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            true,
        ),
    ];
    let mut out = Vec::with_capacity(modes.len());
    for (label, blend, classic) in modes {
        let mut one = quiet.clone();
        one.classic = classic;
        if classic {
            one.variable_width = false;
            one.arc_fit = false;
            one.travel_opt = false;
            one.overhang_control = false;
            one.infill_combine = false;
            one.combing = false;
            one.feature_speeds = false;
            one.scarf_seam = ScarfSeam::Off;
            one.support_style = SupportStyle::Grid;
            one.support_height_mult = 1.0;
            one.support_avoidance = false;
            one.support_strict_stacking = false;
            one.support_paint_join = false;
            one.support_slow_fragile = false;
        }
        let response = slice_sharing(mesh, &blend, profile, &one, cut, watch)?;
        out.push(CompareEstimate {
            label: label.into(),
            seconds: response.estimate.seconds,
            filament_g: response.estimate.filament_g,
            by_feature: response.estimate.by_feature,
        });
    }
    Ok(out)
}
