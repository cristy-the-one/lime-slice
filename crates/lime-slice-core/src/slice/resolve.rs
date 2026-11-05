use super::*;

pub(super) fn pattern_label(strategy: &ResolvedStrategy) -> String {
    if strategy.gyroid_3d && strategy.pattern == crate::strategy::InfillPattern::Gyroid {
        "gyroid3d".into()
    } else {
        strategy.pattern.as_str().into()
    }
}

pub(super) fn resolve(
    mut strategy: ResolvedStrategy,
    settings: &SliceSettings,
) -> ResolvedStrategy {
    if settings.classic {
        strategy = classicize(strategy);
    }
    if !settings.feature_speeds {
        strategy.feature_speeds = false;
    }
    if !settings.infill_combine {
        strategy.infill_combine = 1;
    }
    if let Some(mode) = settings.seam.mode() {
        strategy.seam = mode;
        strategy.inner_follows_seam = true;
    }
    if !settings.classic {
        match settings.gyroid_3d {
            Gyroid3d::Off => strategy.gyroid_3d = false,
            Gyroid3d::Blend => {}
            Gyroid3d::On => {
                strategy.pattern = crate::strategy::InfillPattern::Gyroid;
                strategy.gyroid_3d = true;
                strategy.lightning_range_mm = 0.0;
            }
        }
        if strategy.gyroid_3d
            && strategy.pattern == crate::strategy::InfillPattern::Gyroid
            && strategy.toughness >= 0.75
            && settings.infill_combine
        {
            strategy.infill_combine = strategy.infill_combine.max(2);
        }
        strategy.z_hop = match settings.z_hop {
            ZHopMode::Off => ZHopMode::Off,
            ZHopMode::Always => ZHopMode::Always,
            ZHopMode::Smart => ZHopMode::Smart,
            ZHopMode::Blend => strategy.z_hop,
        };
        if settings.classic {
            strategy.z_hop = ZHopMode::Off;
        }
    }
    strategy
}

pub(super) fn shaft_scales(supports: &[crate::support::SupportLayer], mult: f64) -> Vec<f64> {
    let m = if mult < 1.0 {
        1
    } else {
        mult.round().clamp(1.0, 4.0) as u32
    };
    let has = |i: usize| {
        supports
            .get(i)
            .map(|s| !s.sparse.is_empty() || !s.disks.is_empty())
            .unwrap_or(false)
    };
    let mut scale = vec![0.0; supports.len()];
    let mut since = 0u32;
    for (i, slot) in scale.iter_mut().enumerate() {
        if !has(i) {
            since = 0;
            continue;
        }
        since += 1;
        if since >= m || !has(i + 1) {
            *slot = since as f64;
            since = 0;
        }
    }
    scale
}

pub(super) fn interior_remainings(
    blend: &BlendMode,
    settings: &SliceSettings,
    bands: &[crate::adaptive::LayerBand],
    skins: &[Vec<Arc<Skin>>; 2],
) -> (Vec<InteriorSpan>, Vec<InteriorSpan>) {
    let shells_for = |pick: &dyn Fn(f64) -> ResolvedStrategy| -> Vec<ShellBand> {
        bands
            .iter()
            .enumerate()
            .map(|(i, b)| skin_of([&skins[0][i], &skins[1][i]], &pick(b.z)).shell())
            .collect()
    };
    match blend {
        BlendMode::ByRegion { .. } => {
            let low = shells_for(&|_| {
                settings
                    .object_tweak
                    .apply(resolve(pure(StrategyId::Toughness), settings))
            });
            let high = shells_for(&|_| {
                settings
                    .object_tweak
                    .apply(resolve(pure(StrategyId::Speed), settings))
            });
            (remaining_interior(&low), remaining_interior(&high))
        }
        other => {
            let low = shells_for(&|z| {
                settings
                    .object_tweak
                    .apply(resolve(strategy_at(other, z), settings))
            });
            (remaining_interior(&low), vec![(0, 0); bands.len()])
        }
    }
}

pub(super) fn strategy_at(blend: &BlendMode, z: f64) -> ResolvedStrategy {
    match blend {
        BlendMode::Single { strategy } => pure(*strategy),
        BlendMode::Weight { toughness } => mix(*toughness),
        BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
        BlendMode::ByRegion { .. } => pure(StrategyId::Speed),
    }
}

pub(super) type InteriorSpan = (u32, u32);

pub(super) fn remaining_interior(shells: &[ShellBand]) -> Vec<InteriorSpan> {
    let n = shells.len();
    let mut out = vec![(0u32, 0u32); n];
    let mut i = 0;
    while i < n {
        if shells[i] != ShellBand::Interior {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && shells[j] == ShellBand::Interior {
            j += 1;
        }
        let run = (j - i) as u32;
        for (k, slot) in out.iter_mut().enumerate().take(j).skip(i) {
            *slot = (run - (k - i) as u32, run);
        }
        i = j;
    }
    out
}
