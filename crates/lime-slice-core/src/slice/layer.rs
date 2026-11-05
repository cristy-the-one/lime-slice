use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn object_layer(
    index: usize,
    z: f64,
    height: f64,
    contours: &[Loop],
    blend: &BlendMode,
    settings: &SliceSettings,
    skins: [&Arc<Skin>; 2],
    roof_distance: f64,
    min: [f64; 3],
    max: [f64; 3],
    nozzle_diameter: f64,
    remain_low: (u32, u32),
    remain_high: (u32, u32),
    lightning: Option<(&Lightning, usize)>,
) -> ObjectLayer {
    let line_width = settings.line_width;
    // The grown branches and the hollow under them, for a strategy that
    // prints the lightning they were grown for.
    let grown = |s: &ResolvedStrategy| -> (Option<Branches>, Option<Hollow>) {
        let Some((plan, i)) = lightning else {
            return (None, None);
        };
        let fits = s.pattern == crate::strategy::InfillPattern::Lightning
            && s.walls == plan.walls
            && (lightning_pitch(s, line_width) - plan.pitch).abs() < 1e-9;
        if !fits {
            return (None, None);
        }
        (
            Some(Arc::clone(&plan.layers[i])),
            Some(Arc::clone(&plan.hollow_below[i])),
        )
    };
    let features = PathFeatures {
        variable_width: settings.variable_width,
        roof_distance_mm: roof_distance,
        layer_index: index,
        layer_height: height,
        shell: ShellBand::Interior,
        skin: Arc::default(),
        lightning: None,
        hollow_below: None,
        z,
        fuzzy_skin: settings.fuzzy_skin,
        seam_paint: settings.seam_paint.clone(),
        nozzle_diameter,
        interior_remaining: remain_low.0,
        interior_run: remain_low.1,
        top_pattern: settings.top_surface_pattern,
        xy_hole_mm: settings.xy_hole_compensation_mm,
        xy_contour_mm: settings.xy_contour_compensation_mm,
        elephants_foot_mm: settings.elephants_foot_compensation_mm,
        infill_nearest_first: settings.classic,
    };
    // The blend's plan of `region`, with `tweak` over every strategy it
    // prints, and the print speed the note names when the object's cap
    // lowers it.
    let plan = |region: &[Loop], tweak: Option<&Tweak>| {
        let tweaked = |s: ResolvedStrategy| match tweak {
            Some(t) => t.apply(s),
            None => s,
        };
        let takes_cap = tweak.and_then(|t| t.speed).is_none();
        let mut shown = None;
        let mut paths = Vec::new();
        let mut wall_ms = 0.0;
        let mut infill_ms = 0.0;
        let contours = region;
        let note = match blend {
            BlendMode::ByRegion { axis, at_mm } => {
                let (low_rect, high_rect) = split_rects(*axis, *at_mm, min, max, contours);
                let tough = tweaked(resolve(pure(StrategyId::Toughness), settings));
                let speed = tweaked(resolve(pure(StrategyId::Speed), settings));
                let margin = cut_margin(&tough, &speed, line_width);
                let low_plan = widen_rect(low_rect, *axis, true, margin);
                let high_plan = widen_rect(high_rect, *axis, false, margin);
                let low = clip_to_rect(contours, low_plan.0, low_plan.1);
                let high = clip_to_rect(contours, high_plan.0, high_plan.1);
                let mut hint = [min[0], min[1]];
                let mut low_feat = features.clone();
                low_feat.skin = skin_of(skins, &tough);
                (low_feat.lightning, low_feat.hollow_below) = grown(&tough);
                low_feat.shell = low_feat.skin.shell();
                low_feat.interior_remaining = remain_low.0;
                low_feat.interior_run = remain_low.1;
                let mut high_feat = features.clone();
                high_feat.skin = skin_of(skins, &speed);
                (high_feat.lightning, high_feat.hollow_below) = grown(&speed);
                high_feat.shell = high_feat.skin.shell();
                high_feat.interior_remaining = remain_high.0;
                high_feat.interior_run = remain_high.1;
                let (low_paths, low_wall, low_infill) =
                    plan_region_split(&low, &tough, line_width, &mut hint, &low_feat);
                let (high_paths, high_wall, high_infill) =
                    plan_region_split(&high, &speed, line_width, &mut hint, &high_feat);
                wall_ms += low_wall + high_wall;
                infill_ms += low_infill + high_infill;
                paths.extend(pair_sides(
                    keep_side(low_paths, *axis, *at_mm, true),
                    keep_side(high_paths, *axis, *at_mm, false),
                ));
                format!("region low=toughness high=speed split {at_mm:.2} h={height:.3}")
            }
            other => {
                let resolved = tweaked(layer_strategy(other, z, settings));
                let mut hint = [max[0], (min[1] + max[1]) * 0.5];
                let mut feat = features.clone();
                feat.skin = skin_of(skins, &resolved);
                (feat.lightning, feat.hollow_below) = grown(&resolved);
                feat.shell = feat.skin.shell();
                feat.interior_remaining = remain_low.0;
                feat.interior_run = remain_low.1;
                let (region, region_wall, region_infill) =
                    plan_region_split(contours, &resolved, line_width, &mut hint, &feat);
                wall_ms += region_wall;
                infill_ms += region_infill;
                paths.extend(region);
                shown = takes_cap.then_some(resolved.print_speed);
                format!(
                    "{} walls={} infill={:.0}% {}{}h={:.3}",
                    resolved.id.as_str(),
                    resolved.walls,
                    resolved.infill_density * 100.0,
                    pattern_label(&resolved),
                    speed_label(resolved.print_speed),
                    height
                )
            }
        };
        if takes_cap {
            for path in &mut paths {
                path.cap_feed = Some(CapFeed {
                    feed: path.speed,
                    slow: Slowdown::None,
                });
            }
        }
        (paths, wall_ms, infill_ms, note, shown)
    };
    // The object's speed cap is applied once the layers are joined, so a
    // cap change reuses every part stage.
    let object = Tweak {
        speed: None,
        ..settings.object_tweak
    };
    let range = object.under(settings.overrides.range_at(z));
    let mut prints = layer_footprints(&settings.overrides, z, contours);
    // An empty list does not build a footprint and does not enter any zone
    // the modifiers would not have entered on their own.
    if !settings.reinforcement.is_empty() {
        let modifiers = prints.clone();
        prints.extend(reinforcement_prints(
            &settings.reinforcement,
            &modifiers,
            contours,
            blend,
            z,
            settings,
            range,
        ));
    }
    let (paths, wall_ms, infill_ms, mut note, shown) = if prints.is_empty() {
        plan(contours, range.as_ref())
    } else {
        // Each zone plans the part's own outline, so its walls follow the
        // real perimeter. The base zone plans the whole layer; a volume plans
        // the part within reach of its footprint, so the walls of that clip
        // edge lie outside the footprint. Each keeps only the beads in its
        // zone, and beads cut at a footprint edge meet the other zone's.
        let (mut paths, mut wall_ms, mut infill_ms, mut note, shown) =
            plan(contours, range.as_ref());
        paths = keep_zone(paths, &prints, None);
        for (k, print) in prints.iter().enumerate() {
            // The volume wins on each field it sets; the range, then the
            // object, fill the rest.
            let stacked = range
                .unwrap_or_default()
                .under(Some(print.tweak))
                .unwrap_or(print.tweak);
            let walls = zone_walls(blend, z, settings, &stacked);
            let reach = offset_loops(&print.outline.polygons(), (walls + 2) as f64 * line_width);
            let region = boolean_intersect(contours, &reach);
            if region.is_empty() {
                continue;
            }
            let (own, own_wall, own_infill, _, _) = plan(&region, Some(&stacked));
            wall_ms += own_wall;
            infill_ms += own_infill;
            let own = keep_zone(own, &prints, Some(k));
            if !own.is_empty() {
                if print.tweak.infill_floor.is_some() {
                    let tag = format!(" · reinforce {}", print.volume);
                    let already = note.match_indices(&tag).any(|(at, _)| {
                        !note[at + tag.len()..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_digit())
                    });
                    if !already {
                        note.push_str(&tag);
                    }
                } else {
                    note.push_str(&format!(" · volume {}", print.volume));
                }
            }
            paths = pair_sides(paths, own);
        }
        (paths, wall_ms, infill_ms, note, shown)
    };
    // Untoured, the planned order is the printed one: finish each island first.
    let paths = if settings.classic {
        crate::toolpath::order_by_island(paths, contours)
    } else {
        paths
    };
    if paths.iter().any(|p| p.kind == PathKind::GapFill) && !note.contains("gap-fill") {
        note.push_str(" · gap-fill");
    }
    ObjectLayer {
        paths,
        note,
        shown_speed: shown,
        wall_ms,
        infill_ms,
    }
}

/// A print speed as a layer note names it, with the spaces around it.
pub(super) fn speed_label(speed: f64) -> String {
    format!(" {speed:.0}mm/s ")
}
