use super::assemble::rest_on_support;
use super::brims::{
    belt_anchor, belt_anchor_layers, line_spans, merge_spans, subtract_spans, BELT_ANCHOR_MIN_MM,
};
use super::plan::{cut_mesh, height_opts, plan, plan_contours, Plan};
use super::resolve::resolve;
use super::skin::{skin_regions, under_walls};
use super::supports::{
    print_gently, Gentle, GENTLE_INTERFACE_MM_S, GENTLE_SUPPORT_ACCEL, GENTLE_SUPPORT_MM_S,
};
use super::tours::{guess_tours, part_paths, scarf_params, set_serial_tour_for_test, tour_part};
use crate::adaptive::{plan_bands, HeightOpts, LayerBand};
use crate::gcode::PlateLayer;
use crate::index::ZIndex;
use crate::poly::{boolean_diff, offset_loops, signed_area, Loop};
use crate::strategy::pure;
use crate::support::Disk;
use crate::toolpath::{
    plan_support, plan_tree_support, CapFeed, PartLayout, PathFeatures, Slowdown,
};
use crate::{
    outline_tolerance_mm, slice_configured, slice_request, BlendMode, Job, Mesh, PathKind,
    PrinterProfile, ScarfSeam, SliceRequest, SliceSettings, StrategyId, Watch,
};

fn square_loop(x0: f64, y0: f64, side: f64) -> Loop {
    vec![
        [x0, y0],
        [x0 + side, y0],
        [x0 + side, y0 + side],
        [x0, y0 + side],
    ]
}

#[test]
fn gentle_supports_slow_and_soften_every_support_path_alike() {
    let strategy = resolve(pure(StrategyId::Speed), &SliceSettings::default());
    let disk = |x: f64, r: f64, n: u32| Disk {
        xy: [x, 0.0],
        r,
        node: crate::support::NodeId(n),
    };
    let disks = [disk(0.0, 0.4, 0), disk(10.0, 1.2, 1), disk(30.0, 2.5, 2)];
    let mut paths = plan_tree_support(&disks, &[], &strategy, 0.45);
    for interface in [false, true] {
        paths.extend(plan_support(
            &[square_loop(50.0, 0.0, 5.0)],
            &strategy,
            0.45,
            0.6,
            interface,
            None,
        ));
    }
    let mut part = plan_support(
        &[square_loop(70.0, 0.0, 5.0)],
        &strategy,
        0.45,
        0.6,
        false,
        None,
    );
    for path in &mut part {
        path.kind = PathKind::Solid;
    }
    paths.extend(part);
    let before: Vec<(f64, f64)> = paths.iter().map(|p| (p.speed, p.accel)).collect();
    assert!(before.iter().any(|(s, a)| *s > 40.0 && *a > 2000.0));
    let gentle = Gentle {
        speed: GENTLE_SUPPORT_MM_S,
        accel: GENTLE_SUPPORT_ACCEL,
    };
    print_gently(&mut paths, gentle);
    let mut seen = [false; 3];
    for (path, (speed, accel)) in paths.iter().zip(before) {
        let (want_speed, want_accel) = match path.kind {
            PathKind::SupportInterface => {
                seen[1] = true;
                (
                    speed.min(GENTLE_INTERFACE_MM_S),
                    accel.min(GENTLE_SUPPORT_ACCEL),
                )
            }
            PathKind::Support => {
                seen[0] = true;
                (
                    speed.min(GENTLE_SUPPORT_MM_S),
                    accel.min(GENTLE_SUPPORT_ACCEL),
                )
            }
            _ => {
                seen[2] = true;
                (speed, accel)
            }
        };
        assert!((path.speed - want_speed).abs() < 1e-9, "{:?}", path.kind);
        assert!((path.accel - want_accel).abs() < 1e-9, "{:?}", path.kind);
    }
    assert_eq!(seen, [true; 3], "support, interface, and part all printed");
}

#[test]
fn brim_spans_join_cut_and_follow_a_line() {
    let spans = merge_spans(vec![[5.0, 6.0], [0.0, 2.0], [1.5, 3.0]]);
    assert_eq!(spans, vec![[0.0, 3.0], [5.0, 6.0]]);
    assert_eq!(
        subtract_spans(&[[0.0, 10.0]], &[[2.0, 3.0], [8.0, 12.0]]),
        vec![[0.0, 2.0], [3.0, 8.0]]
    );
    assert_eq!(
        line_spans(
            &[square_loop(0.0, 0.0, 4.0), square_loop(10.0, 0.0, 2.0)],
            1.0
        ),
        vec![[0.0, 4.0], [10.0, 12.0]]
    );
}

/// Layers 0.5 mm apart along the belt, with a foot on each layer `footed` names.
fn belt_rows(n: usize, footed: impl Fn(usize) -> bool) -> (Vec<f64>, Vec<Vec<[f64; 2]>>) {
    let at = (0..n).map(|i| i as f64 * 0.5).collect();
    let feet = (0..n)
        .map(|i| {
            if footed(i) {
                vec![[10.0, 12.0]]
            } else {
                Vec::new()
            }
        })
        .collect();
    (at, feet)
}

#[test]
fn belt_anchors_lie_every_spacing_along_the_belt_and_at_both_ends() {
    // Feet from 2 mm to 34.5 mm along the belt.
    let (at, feet) = belt_rows(80, |i| (4..=69).contains(&i));
    let layers = belt_anchor_layers(&at, &feet, 10.0);
    let along: Vec<f64> = layers.iter().map(|&i| at[i]).collect();
    assert_eq!(along, vec![2.0, 12.0, 22.0, 32.0, 34.5]);
    // A wider spacing, and one wider than all the feet: first and last only.
    let wide = belt_anchor_layers(&at, &feet, 15.0);
    assert_eq!(
        wide.iter().map(|&i| at[i]).collect::<Vec<_>>(),
        vec![2.0, 17.0, 32.0, 34.5]
    );
    let ends = belt_anchor_layers(&at, &feet, 100.0);
    assert_eq!(ends, vec![4, 69]);
    // The last foot on a grid line is not laid twice.
    let (at, feet) = belt_rows(80, |i| (0..=40).contains(&i));
    assert_eq!(belt_anchor_layers(&at, &feet, 10.0), vec![0, 20, 40]);
    // A single foot is the first and the last.
    let (at, feet) = belt_rows(10, |i| i == 3);
    assert_eq!(belt_anchor_layers(&at, &feet, 10.0), vec![3]);
}

#[test]
fn belt_anchors_skip_belt_where_no_support_stands() {
    // Feet at 0–5 mm and again at 30–40 mm; the part lies on the belt between.
    let (at, feet) = belt_rows(81, |i| i <= 10 || (60..=80).contains(&i));
    let layers = belt_anchor_layers(&at, &feet, 10.0);
    let along: Vec<f64> = layers.iter().map(|&i| at[i]).collect();
    // The next anchor after 0 mm is the first foot past the bare stretch.
    assert_eq!(along, vec![0.0, 30.0, 40.0]);
    assert!(layers.iter().all(|&i| !feet[i].is_empty()));
    // No foot on the belt: no anchor.
    let (at, feet) = belt_rows(20, |_| false);
    assert!(belt_anchor_layers(&at, &feet, 10.0).is_empty());
}

#[test]
fn a_belt_anchor_spans_the_feet_plus_five_mm_and_keeps_clear_of_the_part() {
    let feet = [[10.0, 12.0], [40.0, 41.0]];
    let anchor = belt_anchor(3.0, &feet, &feet).unwrap();
    assert_eq!(anchor.y, 3.0);
    assert_eq!(anchor.spans, vec![[5.0, 10.0], [12.0, 40.0], [41.0, 46.0]]);
    // The part lies on this line from 20 to 30 mm; the gap is already on it.
    let taken = merge_spans(vec![[10.0, 12.0], [40.0, 41.0], [19.45, 30.55]]);
    let anchor = belt_anchor(3.0, &feet, &taken).unwrap();
    assert_eq!(
        anchor.spans,
        vec![[5.0, 10.0], [12.0, 19.45], [30.55, 40.0], [41.0, 46.0]]
    );
    assert!(belt_anchor(3.0, &[], &[]).is_none());
}

#[test]
fn belt_anchors_are_asked_only_on_a_belt_and_never_in_classic() {
    let belt: crate::belt::BeltSpec = serde_json::from_value(serde_json::json!({
        "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 220.0,
        "copies": 1, "gapMm": 5.0, "floorSupports": true
    }))
    .unwrap();
    let req = |extra: serde_json::Value| -> SliceRequest {
        let mut body = serde_json::json!({
            "filename": "a.stl", "dataB64": "", "layerHeight": 0.2, "lineWidth": 0.45,
            "blend": {"mode": "weight", "toughness": 0.3}, "supports": true,
            "supportStyle": "grid", "supportBeltAnchorMm": 10.0,
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        serde_json::from_value(body).unwrap()
    };
    let mut on = req(serde_json::json!({}));
    assert_eq!(SliceSettings::from_request(&on).support_anchor_mm, None);
    on.belt = Some(belt.clone());
    assert_eq!(
        SliceSettings::from_request(&on).support_anchor_mm,
        Some(10.0)
    );
    on.support_anchor_mm = Some(0.5);
    assert_eq!(
        SliceSettings::from_request(&on).support_anchor_mm,
        Some(BELT_ANCHOR_MIN_MM)
    );
    on.support_anchor_mm = None;
    assert_eq!(SliceSettings::from_request(&on).support_anchor_mm, None);
    let mut classic = req(serde_json::json!({"classic": true}));
    classic.belt = Some(belt);
    assert_eq!(
        SliceSettings::from_request(&classic).support_anchor_mm,
        None
    );
}

#[test]
fn a_hanging_span_over_support_interface_prints_like_a_bridge() {
    let strategy = resolve(pure(StrategyId::Speed), &SliceSettings::default());
    let span = |y: f64| {
        let mut path = plan_support(
            &[square_loop(0.0, y, 4.0)],
            &strategy,
            0.45,
            0.2,
            false,
            None,
        )
        .remove(0);
        path.kind = PathKind::Outer;
        path.on_overhang = true;
        path.speed = 130.0 * 0.32;
        path.cap_feed = Some(CapFeed {
            feed: 130.0,
            slow: Slowdown::Steep,
        });
        path
    };
    let below = vec![vec![square_loop(-1.0, -1.0, 6.0)]];
    let mut paths = vec![span(0.0), span(20.0)];
    rest_on_support(&mut paths, &below, None);
    assert!(
        (paths[0].speed - 36.0).abs() < 1e-9,
        "on interface {}",
        paths[0].speed
    );
    assert!(
        (paths[1].speed - 130.0 * 0.32).abs() < 1e-9,
        "over air {}",
        paths[1].speed
    );
    let mut held = vec![span(0.0)];
    held[0].on_overhang = false;
    rest_on_support(&mut held, &below, None);
    assert!(
        (held[0].speed - 130.0 * 0.32).abs() < 1e-9,
        "a held span is left alone"
    );
}

/// The guessed tour must be the serial tour, path for path and end for
/// end, and on these parts some guesses must hold and some must not.
#[test]
fn guessed_tours_match_the_serial_tour() {
    for (name, scarf) in [
        ("lime_hull.stl", ScarfSeam::Blend),
        ("arc_post.stl", ScarfSeam::Off),
        ("calibration_cube_20mm.stl", ScarfSeam::All),
    ] {
        let bytes = std::fs::read(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../samples")
                .join(name),
        )
        .unwrap();
        let mesh = crate::load::load_mesh(name, &bytes).unwrap();
        let settings = SliceSettings {
            scarf_seam: scarf,
            ..SliceSettings::default()
        };
        let blend = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let bands = plan_bands(&mesh, &height_opts(&settings)).unwrap();
        let idle = Watch::idle();
        let cut = cut_mesh(&mesh, bands, &settings, 0.4, &idle).unwrap();
        let part = part_paths(&cut, &blend, &settings, 0.4, [0; 32], None, &idle).unwrap();
        let tour = || tour_part(&cut, &part, &blend, &settings, [0; 32], None, &idle).unwrap();
        set_serial_tour_for_test(true);
        let serial = tour();
        set_serial_tour_for_test(false);
        let guessed = tour();
        assert_eq!(serial.layers.len(), guessed.layers.len(), "{name}");
        let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
        for (i, (s, g)) in serial.layers.iter().zip(&guessed.layers).enumerate() {
            assert_eq!(s.paths, g.paths, "{name} layer {i}");
            assert_eq!(bits(s.from), bits(g.from), "{name} layer {i}");
            assert_eq!(bits(s.end), bits(g.end), "{name} layer {i}");
        }
        let laid: Vec<Option<PartLayout>> = part
            .layers
            .iter()
            .zip(&cut.contours)
            .map(|(l, c)| Some(PartLayout::new(l.paths.clone(), c)))
            .collect();
        let held = guess_tours(&laid, &[], 0, Some(serial.layers[0].from), |i| {
            Some(scarf_params(&settings, cut.bands[i].index))
        })
        .iter()
        .zip(&serial.layers)
        .filter(|(g, s)| g.as_ref().is_some_and(|g| bits(g.from) == bits(s.from)))
        .count();
        assert!(held > 0, "{name}: no guess held");
        if name == "lime_hull.stl" {
            assert!(held < serial.layers.len(), "{name}: every guess held");
        }
    }
}

/// Root 8 mm wide, tip 0.55 mm, 40 mm long, 12 mm tall. Matches `wedge_wing`
/// in tests/slice_cube.rs.
fn wedge_wing() -> Mesh {
    let (length, root, tip, z1) = (40.0, 8.0, 0.55, 12.0);
    let y_tip0 = (root - tip) * 0.5;
    let ring = |z: f64| {
        [
            [0.0, 0.0, z],
            [length, y_tip0, z],
            [length, y_tip0 + tip, z],
            [0.0, root, z],
        ]
    };
    let (b, t) = (ring(0.0), ring(z1));
    let mut triangles = vec![
        [b[0], b[1], b[2]],
        [b[0], b[2], b[3]],
        [t[0], t[2], t[1]],
        [t[0], t[3], t[2]],
    ];
    for i in 0..4 {
        let j = (i + 1) % 4;
        triangles.push([b[i], t[i], t[j]]);
        triangles.push([b[i], t[j], b[j]]);
    }
    Mesh { triangles }
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 < 1e-12 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    (a[0] + dx * t - p[0]).hypot(a[1] + dy * t - p[1])
}

/// Wing centerline stations `flared_wing_taper_is_filled_on_speed_and_toughness`
/// checks, left uncovered at `want_z`, and the gap-fill length on that layer.
fn wing_holes(plan: &Plan, want_z: f64) -> (Vec<f64>, f64) {
    let layer = plan
        .layers
        .iter()
        .find(|l| (l.z - want_z).abs() < 0.15)
        .unwrap();
    let gap_mm = layer
        .paths
        .iter()
        .filter(|p| p.kind == PathKind::GapFill)
        .flat_map(|p| p.points.windows(2))
        .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
        .sum();
    let holes = (1..20)
        .map(|i| i as f64 * 2.0)
        .filter(|&x| {
            let width = 8.0 + (0.55 - 8.0) * (x / 40.0);
            // Sparse and gyroid may leave the fat root open. The taper may not.
            let open_ok = want_z < 10.0 && width > 3.2;
            let hit = layer.paths.iter().any(|p| {
                p.kind != PathKind::Skirt
                    && p.points
                        .windows(2)
                        .any(|s| seg_dist([x, 4.0], s[0], s[1]) <= (p.width * 0.5).max(0.1) + 0.05)
            });
            !hit && !open_ok
        })
        .collect();
    (holes, gap_mm)
}

/// Two 4 mm squares joined by a neck narrower than one bead. The outer wall
/// splits at the neck, and the bead that fills it is the part's skin there.
/// Necks under the narrowest bead (0.2 mm), and under the 0.1 mm the width
/// probe can read, are where a membrane's faces meet. They still print.
#[test]
fn a_pinch_too_narrow_for_walls_is_filled_as_thin_wall() {
    for neck in [0.35, 0.12, 0.06] {
        pinch_is_thin_wall(neck);
    }
}

fn pinch_is_thin_wall(neck: f64) {
    let (lo, hi) = (2.0 - neck * 0.5, 2.0 + neck * 0.5);
    let dumbbell: Loop = vec![
        [0.0, 0.0],
        [4.0, 0.0],
        [4.0, lo],
        [7.0, lo],
        [7.0, 0.0],
        [11.0, 0.0],
        [11.0, 4.0],
        [7.0, 4.0],
        [7.0, hi],
        [4.0, hi],
        [4.0, 4.0],
        [0.0, 4.0],
    ];
    let settings = SliceSettings::default();
    for strategy in [StrategyId::Speed, StrategyId::Toughness] {
        let resolved = resolve(pure(strategy), &settings);
        let features = PathFeatures {
            variable_width: true,
            layer_height: 0.2,
            z: 1.0,
            nozzle_diameter: 0.4,
            layer_index: 5,
            ..PathFeatures::default()
        };
        let paths = crate::toolpath::plan_region(
            &[dumbbell.clone()],
            &resolved,
            settings.line_width,
            &mut [0.0, 0.0],
            &features,
        );
        let covered = |x: f64, kind: PathKind| {
            paths.iter().any(|p| {
                p.kind == kind
                    && p.points
                        .windows(2)
                        .any(|s| seg_dist([x, 2.0], s[0], s[1]) <= p.width * 0.5 + 0.05)
            })
        };
        for x in [4.5, 5.0, 5.5, 6.0, 6.5] {
            assert!(
                covered(x, PathKind::ThinWall),
                "{strategy:?}: {neck} mm neck at x={x} has no thin wall"
            );
            assert!(
                !covered(x, PathKind::GapFill),
                "{strategy:?}: {neck} mm neck at x={x} is labelled gap fill"
            );
        }
    }
}

#[test]
fn wing_taper_fill_survives_micron_moves_and_start_rotation() {
    let mesh = wedge_wing();
    let settings = SliceSettings::default();
    let bands = plan_bands(
        &mesh,
        &HeightOpts {
            nominal: settings.layer_height,
            adaptive: false,
            min_h: settings.adaptive_min,
            max_h: settings.layer_height,
        },
    )
    .unwrap();
    let index = ZIndex::build(&mesh);
    let cut: Vec<Vec<Loop>> = bands.iter().map(|b| index.slice(b.cut_z())).collect();
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut step = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % 3) as f64 - 1.0
    };
    let mut failures = Vec::new();
    for case in 0..16 {
        // One Clipper grid step (1 µm) per coordinate, on the 1e-3 grid, from a rotated start.
        let moves: Vec<[f64; 2]> = (0..4).map(|_| [step() * 1e-3, step() * 1e-3]).collect();
        let contours: Vec<Vec<Loop>> = cut
            .iter()
            .map(|layer| {
                layer
                    .iter()
                    .map(|l| {
                        let mut l: Loop = l
                            .iter()
                            .zip(moves.iter().cycle())
                            .map(|(p, m)| {
                                [
                                    ((p[0] + m[0]) * 1e3).round() / 1e3,
                                    ((p[1] + m[1]) * 1e3).round() / 1e3,
                                ]
                            })
                            .collect();
                        let start = case % l.len();
                        l.rotate_left(start);
                        l
                    })
                    .collect()
            })
            .collect();
        for strategy in [StrategyId::Speed, StrategyId::Toughness] {
            let plan = plan_contours(
                bands.clone(),
                contours.clone(),
                mesh.bounds().unwrap(),
                &BlendMode::Single { strategy },
                &settings,
                0.4,
            )
            .unwrap();
            for want_z in [6.0, 11.8] {
                let (holes, gap_mm) = wing_holes(&plan, want_z);
                if !holes.is_empty() || gap_mm <= 1.0 {
                    failures.push(format!(
                        "case {case} {strategy:?} z={want_z} holes at x={holes:?} gap-fill {gap_mm:.2} mm"
                    ));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{}",
        failures.join(
            "
"
        )
    );
}

/// The beads the stress study reads are the writer's own: their volume is
/// the filament the G-code feeds, with scarf seams, a flow multiplier and
/// a plate offset on, with and without fuzzy skin. The post is round, so
/// its seams scarf; a cube's sharp corners keep them butt. Arc fitting is
/// off, because an arc's E follows the arc and a bead its chords.
#[test]
fn emitted_beads_are_the_extrusion_the_writer_feeds() {
    let bytes = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/arc_post.stl"),
    )
    .unwrap();
    let mesh = crate::load::load_mesh("arc_post.stl", &bytes).unwrap();
    for fuzzy in [None, Some(crate::strategy::FuzzySkin::default())] {
        let settings = SliceSettings {
            baseline: false,
            include_preview: false,
            compare: false,
            arc_fit: false,
            flow: 0.93,
            scarf_seam: ScarfSeam::All,
            fuzzy_skin: fuzzy,
            ..SliceSettings::default()
        };
        let profile = PrinterProfile::default();
        let blend = BlendMode::Single {
            strategy: StrategyId::Speed,
        };
        let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
            .unwrap()
            .layers
            .into_iter()
            .map(PlateLayer::single)
            .collect::<Vec<_>>();
        let offsets = [[3.0, -2.0]];
        let stats = crate::gcode::emit_gcode(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &settings.feature_note(),
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &offsets,
            None,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            &Watch::idle(),
        );
        let beads =
            crate::gcode::emitted_beads(&planned, &offsets, settings.flow).collect::<Vec<_>>();
        let volume: f64 = beads.iter().map(|b| b.volume_mm3()).sum();
        let area = std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2);
        let fed = stats.filament_mm * area;
        assert!(
            ((volume - fed) / fed).abs() < 1e-9,
            "beads {volume} mm³, writer {fed} mm³"
        );
        // A scarf moves the nozzle inside the layer, and the offset moves the part.
        let ramps = beads
            .iter()
            .filter(|b| (b.from[2] - b.to[2]).abs() > 1e-6)
            .count();
        let scarfed = planned
            .iter()
            .flat_map(|l| l.paths())
            .filter(|(_, p)| !p.z_frac.is_empty())
            .count();
        assert!(
            ramps > 0,
            "fuzzy {fuzzy:?}: {scarfed} paths carry z_frac, no bead ramps"
        );
        let min_x = beads
            .iter()
            .map(|b| b.from[0])
            .fold(f64::INFINITY, f64::min);
        assert!(
            (min_x - stats.min_x).abs() < 1.0,
            "beads from x {min_x}, G-code from {}",
            stats.min_x
        );
    }
}

/// The cube, planned once and emitted for `profile` the way a slice does:
/// in parallel, then on one thread. Both must agree to the last byte.
fn emit_cube_both_ways(
    profile: &PrinterProfile,
) -> (crate::gcode::GcodeStats, crate::gcode::GcodeStats) {
    let bytes = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/calibration_cube_20mm.stl"),
    )
    .unwrap();
    let mesh = crate::load::load_mesh("calibration_cube_20mm.stl", &bytes).unwrap();
    let settings = SliceSettings {
        baseline: false,
        include_preview: false,
        compare: false,
        ..SliceSettings::default()
    };
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
        .unwrap()
        .layers
        .into_iter()
        .map(PlateLayer::single)
        .collect::<Vec<_>>();
    let features = settings.feature_note();
    let retract = || crate::gcode::RetractEmit {
        length_mm: settings.retract_length,
        speed_mm_s: settings.retract_speed,
    };
    let parallel = crate::gcode::emit_gcode(
        &planned,
        profile,
        &blend,
        settings.layer_height,
        settings.line_width,
        &features,
        settings.arc_fit,
        settings.classic_estimator,
        settings.junction_deviation_mm,
        &[[0.0, 0.0]],
        None,
        settings.flow,
        retract(),
        settings.min_layer(),
        settings.job,
        &Watch::idle(),
    );
    let linear = crate::gcode::emit_gcode_linear(
        &planned,
        profile,
        &blend,
        settings.layer_height,
        settings.line_width,
        &features,
        settings.arc_fit,
        settings.classic_estimator,
        settings.junction_deviation_mm,
        &[[0.0, 0.0]],
        None,
        settings.flow,
        retract(),
        settings.min_layer(),
        settings.job,
        &Watch::idle(),
    );
    (parallel, linear)
}

#[test]
fn a_klipper_printer_gets_klipper_time_and_the_same_toolpath() {
    // Both firmwares take arcs here, so only the estimator tells them apart.
    let generic = PrinterProfile {
        pressure_advance: 0.05,
        max_accel: 20_000.0,
        firmware_arcs: Some(true),
        ..PrinterProfile::default()
    };
    // Klipper numbers on a printer that does not name its firmware are not read.
    let unread = PrinterProfile {
        square_corner_velocity: 8.0,
        minimum_cruise_ratio: 0.9,
        extruder_corner_velocity: 0.1,
        max_z_velocity: 20.0,
        max_z_accel: 500.0,
        ..generic.clone()
    };
    let klipper = PrinterProfile {
        firmware: Some(crate::Firmware::Klipper),
        ..generic.clone()
    };
    let (base, base_linear) = emit_cube_both_ways(&generic);
    let (same, _) = emit_cube_both_ways(&unread);
    let (k, k_linear) = emit_cube_both_ways(&klipper);

    assert_eq!(base.text, base_linear.text);
    assert_eq!(same.text, base.text, "unread fields change no byte");
    assert_eq!(same.print_time_s, base.print_time_s);
    assert_eq!(same.layer_seconds, base.layer_seconds);

    assert_eq!(k.text, k_linear.text, "klipper g-code bytes");
    assert_eq!(k.print_time_s, k_linear.print_time_s);
    assert_eq!(k.layer_seconds, k_linear.layer_seconds);
    assert_eq!(k.by_feature.len(), k_linear.by_feature.len());

    let body = |text: &str| {
        text.lines()
            .filter(|l| !l.starts_with("; estimator:") && !l.starts_with("; TIME:"))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        body(&k.text),
        body(&base.text),
        "only the estimator lines differ"
    );
    assert!(k
        .text
        .contains("; estimator: klipper square_corner_velocity=5.0"));
    assert!(
        k.print_time_s > base.print_time_s * 1.05,
        "klipper {} s against generic {} s",
        k.print_time_s,
        base.print_time_s
    );
}

#[test]
fn parallel_gcode_matches_linear_on_the_cube() {
    let bytes = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/calibration_cube_20mm.stl"),
    )
    .unwrap();
    let mesh = crate::load::load_mesh("calibration_cube_20mm.stl", &bytes).unwrap();
    let settings = SliceSettings {
        baseline: false,
        include_preview: false,
        compare: false,
        ..SliceSettings::default()
    };
    let profile = PrinterProfile {
        pressure_advance: 0.05,
        linear_advance: 0.08,
        ..PrinterProfile::default()
    };
    for blend in [
        BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
    ] {
        let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
            .unwrap()
            .layers
            .into_iter()
            .map(PlateLayer::single)
            .collect::<Vec<_>>();
        let features = settings.feature_note();
        let parallel = crate::gcode::emit_gcode(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &[[0.0, 0.0]],
            None,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            &Watch::idle(),
        );
        let linear = crate::gcode::emit_gcode_linear(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &[[0.0, 0.0]],
            None,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            &Watch::idle(),
        );
        assert!(
            crate::gcode::scans_in_parallel(
                &planned,
                &profile,
                settings.arc_fit,
                settings.classic_estimator
            ),
            "{blend:?} scans its layers in parallel"
        );
        assert_eq!(parallel.text, linear.text, "{blend:?} g-code bytes");
        assert_eq!(parallel.print_time_s, linear.print_time_s);
        assert_eq!(parallel.final_e, linear.final_e);
        assert_eq!(parallel.layer_seconds, linear.layer_seconds);
        assert_eq!(parallel.arc_moves, linear.arc_moves);
        assert_eq!(parallel.retracts, linear.retracts);
        assert_eq!(parallel.z_hops, linear.z_hops);
        assert_eq!(parallel.extrusion_moves, linear.extrusion_moves);
        assert_eq!(parallel.by_feature.len(), linear.by_feature.len());
        for (a, b) in parallel.by_feature.iter().zip(&linear.by_feature) {
            assert_eq!(a.kind, b.kind);
            assert_eq!(a.seconds, b.seconds);
            assert_eq!(a.filament_mm, b.filament_mm);
        }
    }
    let settings = SliceSettings {
        classic_estimator: true,
        arc_fit: false,
        ..settings
    };
    let profile = PrinterProfile::default();
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
        .unwrap()
        .layers
        .into_iter()
        .map(PlateLayer::single)
        .collect::<Vec<_>>();
    let features = settings.feature_note();
    let parallel = crate::gcode::emit_gcode(
        &planned,
        &profile,
        &blend,
        settings.layer_height,
        settings.line_width,
        &features,
        settings.arc_fit,
        settings.classic_estimator,
        settings.junction_deviation_mm,
        &[[0.0, 0.0]],
        None,
        settings.flow,
        crate::gcode::RetractEmit {
            length_mm: settings.retract_length,
            speed_mm_s: settings.retract_speed,
        },
        settings.min_layer(),
        settings.job,
        &Watch::idle(),
    );
    let linear = crate::gcode::emit_gcode_linear(
        &planned,
        &profile,
        &blend,
        settings.layer_height,
        settings.line_width,
        &features,
        settings.arc_fit,
        settings.classic_estimator,
        settings.junction_deviation_mm,
        &[[0.0, 0.0]],
        None,
        settings.flow,
        crate::gcode::RetractEmit {
            length_mm: settings.retract_length,
            speed_mm_s: settings.retract_speed,
        },
        settings.min_layer(),
        settings.job,
        &Watch::idle(),
    );
    assert!(
        crate::gcode::scans_in_parallel(&planned, &profile, false, true),
        "the classic estimator scans its layers in parallel"
    );
    assert_eq!(parallel.text, linear.text, "classic estimator g-code");
    assert_eq!(parallel.print_time_s, linear.print_time_s);
    assert_eq!(parallel.layer_seconds, linear.layer_seconds);
}

#[test]
fn pose_is_applied_without_seating_the_canonical_mesh() {
    let stl = raised_cube_stl(5.0);
    use base64::Engine;
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(stl.as_bytes());
    let req: SliceRequest = serde_json::from_value(serde_json::json!({
        "filename": "raised-cube.stl",
        "dataB64": data_b64,
        "baseline": false,
        "includePreview": false,
        "simplify": false,
        "pose": {
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "pivot": [10.0, 10.0, 15.0],
            "translation": [10.0, 10.0, 15.0]
        }
    }))
    .unwrap();
    let response = slice_request(&req, Job::default()).unwrap();
    assert!(
        response.mesh.min[2] > 4.0,
        "canonical mesh was seated before the pose: {:?}",
        response.mesh.min
    );
    assert_eq!(response.offset, Some([-100.0, -100.0]));
    assert_eq!(response.mesh.max[0], 120.0, "part frame centred on the bed");
}

fn raised_cube_stl(z0: f64) -> String {
    let z1 = z0 + 20.0;
    let v = [
        [0.0, 0.0, z0],
        [20.0, 0.0, z0],
        [20.0, 20.0, z0],
        [0.0, 20.0, z0],
        [0.0, 0.0, z1],
        [20.0, 0.0, z1],
        [20.0, 20.0, z1],
        [0.0, 20.0, z1],
    ];
    let faces = [
        (0, 2, 1),
        (0, 3, 2),
        (4, 5, 6),
        (4, 6, 7),
        (0, 1, 5),
        (0, 5, 4),
        (3, 7, 6),
        (3, 6, 2),
        (0, 4, 7),
        (0, 7, 3),
        (1, 2, 6),
        (1, 6, 5),
    ];
    let mut out = String::from("solid raised\n");
    for (i, j, k) in faces {
        out.push_str("facet normal 0 0 0\nouter loop\n");
        for p in [v[i], v[j], v[k]] {
            out.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
        }
        out.push_str("endloop\nendfacet\n");
    }
    out.push_str("endsolid raised\n");
    out
}

/// Raw cut against simplified outline on every layer of an external mesh.
/// Not part of the default suite.
///   LIME_FIDELITY_MESH=path.stl cargo test -p lime-slice-core --release -- outline_fidelity_report --ignored --nocapture
#[test]
#[ignore = "opt-in fidelity report on an external mesh"]
fn outline_fidelity_report() {
    use crate::poly::{boolean_intersect, simplify_loops};
    let Ok(path) = std::env::var("LIME_FIDELITY_MESH") else {
        eprintln!("skip: LIME_FIDELITY_MESH unset");
        return;
    };
    let bytes = std::fs::read(&path).expect("read mesh");
    let mesh = crate::load::load_mesh(&path, &bytes).expect("load");
    let tol = outline_tolerance_mm(0.4);
    let index = ZIndex::build(&mesh);
    let (_, max) = mesh.bounds().unwrap();
    let area = |loops: &[Loop]| loops.iter().map(|l| signed_area(l)).sum::<f64>().abs();
    let (mut verts, mut kept, mut beyond, mut fused) = (0usize, 0usize, 0.0, 0usize);
    let mut widest = 0.0f64;
    let mut z = 0.1;
    while z < max[2] {
        let raw = index.slice(z);
        let cut = simplify_loops(raw.clone(), tol);
        verts += raw.iter().map(Vec::len).sum::<usize>();
        kept += cut.iter().map(Vec::len).sum::<usize>();
        beyond += area(&boolean_diff(&cut, &offset_loops(&raw, tol)))
            + area(&boolean_diff(&raw, &offset_loops(&cut, tol)));
        let raw_islands = crate::toolpath::island_loops(&raw);
        for piece in crate::toolpath::island_loops(&cut) {
            let near: Vec<&Vec<Loop>> = raw_islands
                .iter()
                .filter(|r| area(&boolean_intersect(r, &piece)) > 1e-3)
                .collect();
            if near.len() >= 2 {
                fused += 1;
                let mut gap = f64::MAX;
                for (i, a) in near.iter().enumerate() {
                    for b in &near[i + 1..] {
                        for v in a.iter().flatten() {
                            gap = gap.min(crate::poly::distance_to_outline(b, *v));
                        }
                    }
                }
                widest = widest.max(gap);
                if gap > 0.05 {
                    println!(
                        "  z {z:.2}: {} islands merged, raw gap {gap:.3} mm",
                        near.len()
                    );
                }
            }
        }
        z += 0.2;
    }
    println!(
        "tolerance {tol} mm  outline vertices {verts} -> {kept}  area beyond tolerance {beyond:.4} mm2  fused islands {fused}, widest raw gap among them {widest:.4} mm"
    );
}

/// Before/after travel for the reorder. Not part of the default suite.
///   cargo test -p lime-slice-core --release -- travel_cluster_report --ignored --nocapture
#[test]
#[ignore = "opt-in travel reorder report"]
fn travel_cluster_report() {
    use crate::toolpath::set_legacy_travel_for_test;
    use std::path::PathBuf;

    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            set_legacy_travel_for_test(false);
        }
    }
    let _guard = Guard;

    let quiet = SliceSettings {
        baseline: false,
        compare: false,
        include_gcode: false,
        include_preview: false,
        supports: false,
        ..SliceSettings::default()
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut meshes: Vec<(&str, Mesh)> = Vec::new();
    for name in [
        "calibration_cube_20mm.stl",
        "lime_hull.stl",
        "dragon_2_5.stl",
    ] {
        let path = root.join("samples").join(name);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                eprintln!("skip {name}: missing");
                continue;
            }
        };
        match crate::load::load_mesh(name, &bytes) {
            Ok(mesh) => meshes.push((name.trim_end_matches(".stl"), mesh)),
            Err(err) => eprintln!("skip {name}: {err}"),
        }
    }
    let blends = [
        (
            "speed",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
        ),
        (
            "tough",
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
        ),
    ];
    println!(
        "{:<16} {:<8} {:>10} {:>10} {:>8} {:>8} {:>10} {:>10} {:>8} {:>8}",
        "mesh", "blend", "travel0", "travel1", "moves0", "moves1", "sec0", "sec1", "core0", "core1"
    );
    for (name, mesh) in &meshes {
        for (label, blend) in &blends {
            set_legacy_travel_for_test(true);
            let before = slice_configured(mesh, blend, &PrinterProfile::default(), &quiet)
                .expect("legacy slice");
            set_legacy_travel_for_test(false);
            let after =
                slice_configured(mesh, blend, &PrinterProfile::default(), &quiet).expect("slice");
            let dt = before.sanity.travel_length_mm - after.sanity.travel_length_mm;
            let ds = before.estimate.seconds - after.estimate.seconds;
            println!(
                "{:<16} {:<8} {:>10.1} {:>10.1} {:>8} {:>8} {:>10.1} {:>10.1} {:>8.1} {:>8.1}  dTravel {:+.1} mm  dTime {:+.1} s  filament {:.2}->{:.2} g  retract {}->{}  order {:.1}->{:.1} ms",
                name,
                label,
                before.sanity.travel_length_mm,
                after.sanity.travel_length_mm,
                before.sanity.travel_moves,
                after.sanity.travel_moves,
                before.estimate.seconds,
                after.estimate.seconds,
                before.core_ms,
                after.core_ms,
                dt,
                ds,
                before.estimate.filament_g,
                after.estimate.filament_g,
                before.sanity.retracts,
                after.sanity.retracts,
                before.stages.order_ms,
                after.stages.order_ms
            );
        }
    }
}

#[test]
fn a_minimum_layer_time_is_the_same_in_the_parallel_and_the_linear_emit() {
    let bytes = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/calibration_cube_20mm.stl"),
    )
    .unwrap();
    let mesh = crate::load::load_mesh("calibration_cube_20mm.stl", &bytes).unwrap();
    let settings = SliceSettings {
        baseline: false,
        include_preview: false,
        compare: false,
        min_layer_time_s: Some(12.0),
        ..SliceSettings::default()
    };
    let profile = PrinterProfile::default();
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let planned = plan(&mesh, &blend, &settings, profile.nozzle_diameter)
        .unwrap()
        .layers
        .into_iter()
        .map(PlateLayer::single)
        .collect::<Vec<_>>();
    let features = settings.feature_note();
    let emit = |linear: bool| {
        let run = if linear {
            crate::gcode::emit_gcode_linear
        } else {
            crate::gcode::emit_gcode
        };
        run(
            &planned,
            &profile,
            &blend,
            settings.layer_height,
            settings.line_width,
            &features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            &[[0.0, 0.0]],
            None,
            settings.flow,
            crate::gcode::RetractEmit::default(),
            settings.min_layer(),
            settings.job,
            &Watch::idle(),
        )
    };
    let (parallel, linear) = (emit(false), emit(true));
    assert!(
        !parallel.layer_slow.is_empty(),
        "a 20 mm cube layer takes under 12 s"
    );
    assert!(parallel.text.contains(" slow ×"));
    assert_eq!(parallel.text, linear.text);
    assert_eq!(parallel.layer_seconds, linear.layer_seconds);
    assert_eq!(parallel.layer_slow, linear.layer_slow);
    assert_eq!(parallel.print_time_s, linear.print_time_s);
}

#[test]
fn estimates_without_gcode_text_match_the_full_emit_under_a_minimum_layer_time() {
    let mesh = wedge_wing();
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let profile = PrinterProfile::default();
    let with = SliceSettings {
        include_gcode: true,
        include_preview: false,
        baseline: false,
        min_layer_time_s: Some(10.0),
        ..SliceSettings::default()
    };
    let without = SliceSettings {
        include_gcode: false,
        ..with.clone()
    };
    let full = slice_configured(&mesh, &blend, &profile, &with).expect("gcode");
    let quiet = slice_configured(&mesh, &blend, &profile, &without).expect("estimates");
    assert!(full.gcode.contains(" slow ×"));
    assert!(quiet.gcode_text.as_ref().unwrap().text() == full.gcode);
    assert!((full.estimate.seconds - quiet.estimate.seconds).abs() < 1e-6);
}

#[test]
fn estimates_without_gcode_text_match_the_full_emit() {
    let mesh = wedge_wing();
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let profile = PrinterProfile::default();
    let with = SliceSettings {
        include_gcode: true,
        include_preview: false,
        baseline: false,
        ..SliceSettings::default()
    };
    let without = SliceSettings {
        include_gcode: false,
        ..with.clone()
    };
    let full = slice_configured(&mesh, &blend, &profile, &with).expect("gcode");
    let quiet = slice_configured(&mesh, &blend, &profile, &without).expect("estimates");
    assert!(
        full.gcode.contains(";LAYER:"),
        "full emit should keep layer markers"
    );
    assert!(
        quiet.gcode.is_empty(),
        "discarded g-code should not be built"
    );
    assert!(full.gcode_text.is_none());
    assert!(
        quiet.gcode_text.as_ref().unwrap().text() == full.gcode,
        "the text formatted later is the text a full emit writes"
    );
    assert!(quiet.sanity.ok, "{:?}", quiet.sanity.notes);
    assert_eq!(full.sanity.layers, quiet.sanity.layers);
    assert_eq!(full.sanity.extrusion_moves, quiet.sanity.extrusion_moves);
    assert!((full.estimate.seconds - quiet.estimate.seconds).abs() < 1e-6);
    assert!((full.estimate.filament_g - quiet.estimate.filament_g).abs() < 1e-9);
}

/// A slab 5 mm long in each layer that steps `step` mm a layer, as a
/// down ramp nearly flat against the belt's layers does.
fn sliding_slab(step: f64) -> (Vec<LayerBand>, Vec<Vec<Loop>>) {
    let n = 24;
    let bands = (0..n)
        .map(|i| LayerBand {
            index: i,
            z: 0.2 * (i + 1) as f64,
            height: 0.2,
        })
        .collect();
    let contours = (0..n)
        .map(|i| {
            let y0 = step * i as f64;
            vec![vec![
                [0.0, y0],
                [100.0, y0],
                [100.0, y0 + 5.0],
                [0.0, y0 + 5.0],
            ]]
        })
        .collect();
    (bands, contours)
}

fn area(loops: &[Loop]) -> f64 {
    loops.iter().map(|l| signed_area(l)).sum()
}

#[test]
fn shallow_skins_find_the_skin_of_a_slab_that_steps_past_the_walls() {
    let (bands, contours) = sliding_slab(0.52);
    let wall_stack = 0.9;
    let off = &skin_regions(&bands, &contours, wall_stack, false, false)[0][12];
    assert!(
        area(&off.top) < 1e-6 && area(&off.bottom) < 1e-6,
        "without it the slab is all interior"
    );
    let on = &skin_regions(&bands, &contours, wall_stack, true, false)[0][12];
    // Three strips of 0.52 mm or more over each 0.6 mm shell depth.
    let least = 100.0 * 3.0 * 0.52 - 1.0;
    assert!(area(&on.top) >= least, "top {}", area(&on.top));
    assert!(area(&on.bottom) >= least, "bottom {}", area(&on.bottom));
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

#[test]
fn walls_landing_on_interior_get_skin_under_them() {
    // A block 7.6 mm deep, then three teeth standing on its middle, as the
    // housing's lip stands on its comb.
    let block = vec![rect(0.0, 0.0, 80.0, 7.6)];
    let teeth = vec![
        rect(0.0, 1.0, 80.0, 3.0),
        rect(0.0, 3.4, 80.0, 4.4),
        rect(0.0, 4.8, 80.0, 6.6),
    ];
    let under = under_walls(&block, &teeth, 0.9);
    assert!(area(&under) > 80.0 * 3.0, "under {}", area(&under));
    let n = 12;
    let bands: Vec<LayerBand> = (0..n)
        .map(|i| LayerBand {
            index: i,
            z: 0.2 * (i + 1) as f64,
            height: 0.2,
        })
        .collect();
    let contours: Vec<Vec<Loop>> = (0..n)
        .map(|i| if i < 8 { block.clone() } else { teeth.clone() })
        .collect();
    let off = &skin_regions(&bands, &contours, 0.9, false, false)[0][4];
    let on = &skin_regions(&bands, &contours, 0.9, false, true)[0][4];
    assert!(area(&off.top) < 1e-6, "today the block is all interior");
    let skin = area(&on.top);
    assert!(skin > 80.0 * 3.0, "1.2 mm under the teeth is skin: {skin}");
}

#[test]
fn walls_stepping_in_on_a_slope_stand_on_the_walls_below() {
    let lower = vec![rect(0.0, 0.0, 80.0, 20.0)];
    let upper = vec![rect(0.3, 0.3, 79.7, 19.7)];
    assert!(area(&under_walls(&lower, &upper, 0.9)) < 1e-6);
}

#[test]
fn shallow_skins_leave_a_steep_slope_to_the_walls() {
    let (bands, contours) = sliding_slab(0.1);
    let on = &skin_regions(&bands, &contours, 0.9, true, false)[0][12];
    assert!(area(&on.top) < 1e-6 && area(&on.bottom) < 1e-6);
}
