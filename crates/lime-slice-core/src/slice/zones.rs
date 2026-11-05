use super::*;

/// The volumes whose footprint at `z` can meet the layer's outline, in
/// request order.
pub(super) fn layer_footprints(overrides: &Overrides, z: f64, contours: &[Loop]) -> Vec<Print> {
    if overrides.volumes.is_empty() {
        return Vec::new();
    }
    let Some((lo, hi)) = loop_bounds(contours) else {
        return Vec::new();
    };
    overrides
        .footprints(z)
        .into_iter()
        .filter(|p| {
            let (a, b) = p.outline.bounds();
            a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1]
        })
        .collect()
}

/// Reinforcement sections at `z`, split by the modifier footprints so a
/// modifier keeps its walls and speed and the region only raises infill.
/// A piece whose floor does not exceed the density that piece would print
/// is left out, so a region at the strategy density adds no footprint.
pub(super) fn reinforcement_prints(
    regions: &[crate::reinforcement::Region],
    modifiers: &[Print],
    contours: &[Loop],
    blend: &BlendMode,
    z: f64,
    settings: &SliceSettings,
    range: Option<Tweak>,
) -> Vec<Print> {
    let Some((lo, hi)) = loop_bounds(contours) else {
        return Vec::new();
    };
    let touches = |loops: &[Loop]| {
        loop_bounds(loops)
            .is_some_and(|(a, b)| a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1])
    };
    let raw: Vec<Vec<Loop>> = regions.iter().map(|r| r.sections(z)).collect();
    let mut out = Vec::new();
    for (i, region) in regions.iter().enumerate() {
        let mut remainder = raw[i].clone();
        if !touches(&remainder) {
            continue;
        }
        // Later regions win the overlap even when their floor does not rise
        // above the layer's strategy and emits no footprint of its own.
        for later in &raw[i + 1..] {
            if !later.is_empty() && !remainder.is_empty() {
                remainder = solid_loops(boolean_diff(&remainder, later));
            }
        }
        if !touches(&remainder) {
            continue;
        }
        let floor = Tweak {
            infill_floor: Some(region.density),
            ..Tweak::default()
        };
        // The later modifier wins the overlap, the same as the volume list.
        for modifier in modifiers.iter().rev() {
            let clip = modifier.outline.polygons();
            let hit = solid_loops(boolean_intersect(&remainder, &clip));
            remainder = solid_loops(boolean_diff(&remainder, &clip));
            if !touches(&hit) {
                continue;
            }
            let tweak = modifier.tweak.under(Some(floor)).unwrap_or(floor);
            if floor_rises(blend, z, settings, range, tweak, region.density) {
                out.push(Print {
                    outline: Footprint::Polygon(hit),
                    tweak,
                    volume: region.index,
                });
            }
        }
        if touches(&remainder) && floor_rises(blend, z, settings, range, floor, region.density) {
            out.push(Print {
                outline: Footprint::Polygon(remainder),
                tweak: floor,
                volume: region.index,
            });
        }
    }
    out
}

pub(super) fn solid_loops(loops: Vec<Loop>) -> Vec<Loop> {
    let loops: Vec<Loop> = loops
        .into_iter()
        .filter(|loop_| loop_.len() >= 3 && signed_area(loop_).abs() > 0.05)
        .collect();
    if loops.iter().map(|loop_| signed_area(loop_)).sum::<f64>() > 0.05 {
        loops
    } else {
        Vec::new()
    }
}

/// Whether `floor` prints denser than `tweak` would without it. A region
/// blend emits the piece when either side rises.
pub(super) fn floor_rises(
    blend: &BlendMode,
    z: f64,
    settings: &SliceSettings,
    range: Option<Tweak>,
    tweak: Tweak,
    floor: f64,
) -> bool {
    let stacked = range
        .unwrap_or_default()
        .under(Some(tweak))
        .unwrap_or(tweak);
    let above = |strategy: ResolvedStrategy| {
        let cleared = Tweak {
            infill_floor: None,
            ..stacked
        };
        floor > cleared.apply(strategy).infill_density
    };
    match blend {
        BlendMode::ByRegion { .. } => {
            above(resolve(pure(StrategyId::Toughness), settings))
                || above(resolve(pure(StrategyId::Speed), settings))
        }
        other => above(layer_strategy(other, z, settings)),
    }
}

/// The most walls a zone with `tweak` prints at `z`.
pub(super) fn zone_walls(
    blend: &BlendMode,
    z: f64,
    settings: &SliceSettings,
    tweak: &Tweak,
) -> u32 {
    match blend {
        BlendMode::ByRegion { .. } => [StrategyId::Toughness, StrategyId::Speed]
            .into_iter()
            .map(|id| tweak.apply(resolve(pure(id), settings)).walls)
            .max()
            .unwrap_or(0),
        other => tweak.apply(layer_strategy(other, z, settings)).walls,
    }
}

/// The beads of one zone's plan that lie in that zone: outside every
/// footprint for `None`, else where footprint `zone` is the last to hold
/// them. A closed loop cut open keeps the run through its start whole, as
/// `keep_side` does.
pub(super) fn keep_zone(
    paths: Vec<Extrusion>,
    prints: &[Print],
    zone: Option<usize>,
) -> Vec<Extrusion> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let mut kept = zone_runs(&path.points, prints, zone);
        if kept.len() == 1 && kept[0] == path.points {
            out.push(path);
            continue;
        }
        let closed = path.points.len() > 2 && path.points.first() == path.points.last();
        if closed && kept.len() >= 2 && kept[0].first() == path.points.first() {
            let head = kept.remove(0);
            let tail = kept.last_mut().unwrap();
            tail.extend_from_slice(&head[1..]);
        }
        out.extend(
            kept.into_iter()
                .filter(|pts| poly_len(pts) > 0.05)
                .map(|pts| {
                    let mut piece = cut_piece(&path, pts);
                    if piece.kind.is_closed() {
                        piece.seam = Seam::Cut;
                    }
                    piece
                }),
        );
    }
    out
}

/// Both sides' beads with each high run of a travel group right after the low
/// run of the same group. Ordering chains paths only within a run of one
/// group, so a wall or infill line that ends on the cut continues on the
/// other side instead of leaving a travel back from every cut end.
pub(super) fn pair_sides(low: Vec<Extrusion>, high: Vec<Extrusion>) -> Vec<Extrusion> {
    let runs = |paths: Vec<Extrusion>| {
        let mut out: Vec<Vec<Extrusion>> = Vec::new();
        for path in paths {
            match out.last_mut() {
                Some(run) if run[0].travel_group() == path.travel_group() => run.push(path),
                _ => out.push(vec![path]),
            }
        }
        out
    };
    let mut high = runs(high).into_iter().peekable();
    let mut out = Vec::new();
    for run in runs(low) {
        let group = run[0].travel_group();
        out.extend(run);
        if let Some(next) = high.next_if(|h| h[0].travel_group() == group) {
            out.extend(next);
        }
    }
    out.extend(high.flatten());
    out
}

/// The strategy a non-region blend prints at height `z`.
/// The lightning branches of every layer, grown once for the strategy the
/// blend prints lightning with: speed on a region blend's high side, else
/// the first layer's strategy that prints lightning. `None` when none does.
pub(super) fn grow_lightning(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Option<Lightning> {
    let strategy = match blend {
        BlendMode::ByRegion { .. } => resolve(pure(StrategyId::Speed), settings),
        other => cut
            .bands
            .iter()
            .map(|b| layer_strategy(other, b.z, settings))
            .find(|s| s.pattern == crate::strategy::InfillPattern::Lightning)?,
    };
    let strategy = settings.object_tweak.apply(strategy);
    if strategy.pattern != crate::strategy::InfillPattern::Lightning {
        return None;
    }
    let skins = &cut.skins[usize::from(strategy.toughness > 0.6)];
    Some(crate::lightning::grow(
        &cut.bands,
        &cut.contours,
        skins,
        strategy.walls,
        settings.line_width,
        lightning_pitch(&strategy, settings.line_width),
    ))
}

pub(super) fn layer_strategy(
    blend: &BlendMode,
    z: f64,
    settings: &SliceSettings,
) -> ResolvedStrategy {
    resolve(
        match blend {
            BlendMode::Single { strategy } => pure(*strategy),
            BlendMode::Weight { toughness } => mix(*toughness),
            BlendMode::ByLayer {
                bottom_mm,
                transition_mm,
            } => mix(layer_weight(z, *bottom_mm, *transition_mm)),
            BlendMode::ByRegion { .. } => unreachable!(),
        },
        settings,
    )
}
