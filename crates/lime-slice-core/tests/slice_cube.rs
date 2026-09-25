use std::path::PathBuf;

use lime_slice_core::{
    load_mesh, slice_configured, slice_with_baseline, Axis, BlendMode, Mesh, SliceSettings,
    StrategyId,
};

fn cube() -> Mesh {
    let stl = r#"solid cube
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 20 0 0
vertex 20 20 0
endloop
endfacet
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 20 20 0
vertex 0 20 0
endloop
endfacet
facet normal 0 0 1
outer loop
vertex 0 0 20
vertex 20 20 20
vertex 20 0 20
endloop
endfacet
facet normal 0 0 1
outer loop
vertex 0 0 20
vertex 0 20 20
vertex 20 20 20
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 20 0 20
vertex 20 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 0 0 20
vertex 20 0 20
endloop
endfacet
facet normal 0 1 0
outer loop
vertex 0 20 0
vertex 20 20 0
vertex 20 20 20
endloop
endfacet
facet normal 0 1 0
outer loop
vertex 0 20 0
vertex 20 20 20
vertex 0 20 20
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 20 0
vertex 0 20 20
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 20 20
vertex 0 0 20
endloop
endfacet
facet normal 1 0 0
outer loop
vertex 20 0 0
vertex 20 20 20
vertex 20 20 0
endloop
endfacet
facet normal 1 0 0
outer loop
vertex 20 0 0
vertex 20 0 20
vertex 20 20 20
endloop
endfacet
endsolid cube
"#;
    lime_slice_core::load_mesh("cube.stl", stl.as_bytes()).unwrap()
}

fn profile() -> lime_slice_core::PrinterProfile {
    lime_slice_core::PrinterProfile::default()
}

#[test]
fn speed_and_toughness_differ_and_gcode_is_printable() {
    let mesh = cube();
    let speed = slice_with_baseline(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        0.2,
        0.45,
    )
    .unwrap();
    let tough = slice_with_baseline(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        &profile(),
        0.2,
        0.45,
    )
    .unwrap();
    assert_eq!(speed.mesh.triangles, 12);
    assert_eq!(speed.sanity.layers, 100, "20 mm / 0.2 mm");
    assert!(speed.sanity.ok, "{:?}", speed.sanity.notes);
    assert!(tough.sanity.ok, "{:?}", tough.sanity.notes);
    assert!(speed.gcode.contains("M104 S200"));
    assert!(speed.gcode.contains("M140 S60"));
    assert!(speed.gcode.contains(";LAYER:0"));
    assert!(speed.gcode.contains(";LAYER:99"));
    assert!(speed.sanity.final_e > 10.0);
    assert!(speed.sanity.extrusion_moves > 100);

    let mid_t = tough
        .layers
        .iter()
        .filter(|l| (15..80).contains(&l.index))
        .max_by_key(|l| l.paths.iter().filter(|p| is_infill(&p.kind)).count())
        .unwrap();
    let mid = speed.layers.iter().find(|l| l.index == mid_t.index).unwrap();
    assert!(mid.speed_walls > 0);
    assert_eq!(mid.toughness_walls, 0);
    assert!(
        mid_t.toughness_walls > mid.speed_walls,
        "toughness walls {} vs speed walls {}",
        mid_t.toughness_walls,
        mid.speed_walls
    );
    let speed_infill = mid.paths.iter().filter(|p| is_infill(&p.kind)).count();
    let tough_infill = mid_t.paths.iter().filter(|p| is_infill(&p.kind)).count();
    assert!(
        tough_infill > speed_infill,
        "tough infill paths {tough_infill} vs speed {speed_infill}"
    );
}

#[test]
fn region_blend_mixes_both_strategies_on_one_layer() {
    let mesh = cube();
    let blended = slice_with_baseline(
        &mesh,
        &BlendMode::ByRegion {
            axis: Axis::X,
            at_mm: 10.0,
        },
        &profile(),
        0.2,
        0.45,
    )
    .unwrap();
    assert!(blended.sanity.ok, "{:?}", blended.sanity.notes);
    let mid = blended.layers.iter().find(|l| l.index == 40).unwrap();
    assert!(mid.speed_walls > 0, "missing speed walls");
    assert!(
        mid.toughness_walls > mid.speed_walls,
        "missing extra toughness walls"
    );
    assert!(blended.gcode.contains("M204 S"));
}

#[test]
fn layer_blend_changes_strategy_with_height() {
    let mesh = cube();
    let blended = slice_with_baseline(
        &mesh,
        &BlendMode::ByLayer {
            bottom_mm: 4.0,
            transition_mm: 0.0,
        },
        &profile(),
        0.2,
        0.45,
    )
    .unwrap();
    assert!(blended.sanity.ok, "{:?}", blended.sanity.notes);
    let bottom = blended
        .layers
        .iter()
        .find(|l| (l.z - 2.0).abs() < 1e-6)
        .unwrap();
    let top = blended
        .layers
        .iter()
        .find(|l| (l.z - 16.0).abs() < 1e-6)
        .unwrap();
    assert!(bottom.toughness_walls > top.speed_walls);
    assert!(bottom.note.contains("toughness"));
    assert!(top.note.contains("speed"));
}

#[test]
fn blend_json_matches_the_ui() {
    let mode: BlendMode =
        serde_json::from_str(r#"{"mode":"byRegion","axis":"x","atMm":10}"#).unwrap();
    assert!(matches!(
        mode,
        BlendMode::ByRegion {
            axis: Axis::X,
            at_mm
        } if (at_mm - 10.0).abs() < 1e-6
    ));
    let layer: BlendMode =
        serde_json::from_str(r#"{"mode":"byLayer","bottomMm":4,"transitionMm":6}"#).unwrap();
    assert!(matches!(layer, BlendMode::ByLayer { .. }));
}

#[test]
fn sample_meshes_slice() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples");
    for name in [
        "calibration_cube_20mm.stl",
        "calibration_cube_20mm.3mf",
        "lime_hull.stl",
    ] {
        let bytes = std::fs::read(root.join(name)).unwrap();
        let mesh = load_mesh(name, &bytes).unwrap();
        assert!(mesh.triangle_count() > 0, "{name}");
        let (min, max) = mesh.bounds().unwrap();
        let response = slice_with_baseline(
            &mesh,
            &BlendMode::Single {
                strategy: StrategyId::Speed,
            },
            &profile(),
            0.28,
            0.45,
        )
        .unwrap();
        assert!(response.sanity.ok, "{name}: {:?}", response.sanity.notes);
        assert!(response.sanity.layers > 10);
        assert!(max[2] - min[2] > 10.0);
    }
}

fn add_box(tris: &mut Vec<[[f64; 3]; 3]>, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) {
    let v = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
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
    for (i, j, k) in faces {
        tris.push([v[i], v[j], v[k]]);
    }
}

fn ledge() -> Mesh {
    let mut tris = Vec::new();
    add_box(&mut tris, 0.0, 0.0, 0.0, 24.0, 24.0, 12.0);
    add_box(&mut tris, 24.0, 4.0, 12.0, 48.0, 20.0, 16.0);
    Mesh { triangles: tris }
}

fn ramp() -> Mesh {
    let v = [
        [0.0, 0.0, 0.0],
        [40.0, 0.0, 0.0],
        [40.0, 16.0, 0.0],
        [0.0, 16.0, 0.0],
        [0.0, 0.0, 8.0],
        [0.0, 16.0, 8.0],
        [40.0, 0.0, 20.0],
        [40.0, 16.0, 20.0],
    ];
    let faces = [
        (0, 2, 1),
        (0, 3, 2),
        (0, 1, 6),
        (0, 6, 4),
        (3, 5, 7),
        (3, 7, 2),
        (1, 2, 7),
        (1, 7, 6),
        (0, 4, 5),
        (0, 5, 3),
        (4, 6, 7),
        (4, 7, 5),
    ];
    Mesh {
        triangles: faces
            .into_iter()
            .map(|(i, j, k)| [v[i], v[j], v[k]])
            .collect(),
    }
}

fn is_wall(kind: &str) -> bool {
    matches!(kind, "wall" | "outer" | "inner")
}

fn is_infill(kind: &str) -> bool {
    matches!(kind, "infill" | "sparse" | "solid" | "top")
}

fn has_type(gcode: &str, kind: &str) -> bool {
    let marker = format!("TYPE:{kind}");
    gcode
        .lines()
        .any(|line| line.trim().trim_start_matches(';').trim() == marker)
}

fn settings(adaptive: bool, supports: bool) -> SliceSettings {
    SliceSettings {
        adaptive,
        supports,
        ..SliceSettings::default()
    }
}

#[test]
fn adaptive_layers_thin_the_slope_and_keep_layer_markers() {
    let mesh = ramp();
    let fixed = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &settings(false, false),
    )
    .unwrap();
    let adaptive = slice_configured(
        &mesh,
        &BlendMode::ByRegion {
            axis: Axis::X,
            at_mm: 20.0,
        },
        &profile(),
        &settings(true, false),
    )
    .unwrap();
    assert!(fixed.sanity.ok, "{:?}", fixed.sanity.notes);
    assert!(adaptive.sanity.ok, "{:?}", adaptive.sanity.notes);
    assert!(
        fixed.sanity.layers >= 90,
        "fixed layers {}",
        fixed.sanity.layers
    );
    let heights: Vec<f64> = adaptive.layers.iter().map(|l| l.height).collect();
    let thin = heights.iter().copied().fold(f64::MAX, f64::min);
    let thick = heights.iter().copied().fold(0.0_f64, f64::max);
    assert!(
        thin < 0.12,
        "expected thinner layers on the slope, min {thin}"
    );
    assert!(
        thick > 0.16,
        "expected thicker layers on the vertical base, max {thick}"
    );
    assert!(
        adaptive.sanity.layers > fixed.sanity.layers,
        "adaptive {} vs fixed {}",
        adaptive.sanity.layers,
        fixed.sanity.layers
    );
    assert!(adaptive.gcode.contains(";LAYER:0"));
    assert!(adaptive.gcode.contains("H:0.08") || adaptive.gcode.contains("H:0.080"));
    let mid = adaptive
        .layers
        .iter()
        .find(|l| l.z > 4.0 && l.z < 7.0)
        .unwrap();
    assert!(mid.speed_walls > 0 && mid.toughness_walls > 0);
    let top = adaptive.layers.iter().rev().find(|l| l.z > 12.0).unwrap();
    assert!(top.height < mid.height);
}

#[test]
fn supports_fill_the_ledge_and_stay_off_when_disabled() {
    let mesh = ledge();
    let bare = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &settings(false, false),
    )
    .unwrap();
    let held = slice_configured(
        &mesh,
        &BlendMode::Weight { toughness: 0.7 },
        &profile(),
        &settings(false, true),
    )
    .unwrap();
    assert!(bare.sanity.ok, "{:?}", bare.sanity.notes);
    assert!(held.sanity.ok, "{:?}", held.sanity.notes);
    let bare_support: usize = bare.layers.iter().map(|l| l.support_paths as usize).sum();
    assert_eq!(bare_support, 0);
    let support_layers: Vec<_> = held.layers.iter().filter(|l| l.support_paths > 0).collect();
    assert!(
        !support_layers.is_empty(),
        "expected support under the shelf"
    );
    assert!(
        support_layers.iter().all(|l| l.z < 12.05),
        "support should stop below the shelf"
    );
    let under = support_layers.iter().any(|l| {
        l.paths.iter().any(|p| {
            (p.kind == "support" || p.kind == "support-interface")
                && p.pts.iter().any(|pt| pt[0] > 26.0 && pt[0] < 47.0)
        })
    });
    assert!(under, "support toolpaths should sit under the overhang");
    assert!(has_type(&held.gcode, "SUPPORT"));
    assert!(has_type(&held.gcode, "SUPPORT-INTERFACE"));
    assert!(has_type(&held.gcode, "WALL") || has_type(&held.gcode, "OUTER"));
    assert!(
        has_type(&held.gcode, "INFILL")
            || has_type(&held.gcode, "SPARSE")
            || has_type(&held.gcode, "SOLID")
            || has_type(&held.gcode, "TOP")
    );
    assert!(!has_type(&bare.gcode, "SUPPORT"));
    let shelf = held
        .layers
        .iter()
        .find(|l| (l.z - 14.0).abs() < 0.05)
        .unwrap();
    assert!(shelf.support_paths == 0);
    assert!(shelf.paths.iter().any(|p| is_wall(&p.kind)));
}

fn classic() -> SliceSettings {
    SliceSettings {
        classic: true,
        ..SliceSettings::default()
    }
}

fn thin_fin() -> Mesh {
    let mut tris = Vec::new();
    add_box(&mut tris, 0.0, 0.0, 0.0, 18.0, 18.0, 3.0);
    add_box(&mut tris, 8.0, 2.0, 3.0, 8.7, 16.0, 12.0);
    Mesh { triangles: tris }
}

fn bridge_span() -> Mesh {
    let mut tris = Vec::new();
    add_box(&mut tris, 0.0, 0.0, 0.0, 8.0, 16.0, 8.0);
    add_box(&mut tris, 22.0, 0.0, 0.0, 30.0, 16.0, 8.0);
    add_box(&mut tris, 0.0, 4.0, 8.0, 30.0, 12.0, 10.0);
    Mesh { triangles: tris }
}

fn cylinder(radius: f64, height: f64, n: usize) -> Mesh {
    let mut tris = Vec::new();
    let mut ring = Vec::with_capacity(n);
    for i in 0..n {
        let t = std::f64::consts::TAU * i as f64 / n as f64;
        ring.push([radius * t.cos(), radius * t.sin(), 0.0]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        let a = ring[i];
        let b = ring[j];
        let c = [b[0], b[1], height];
        let d = [a[0], a[1], height];
        tris.push([a, b, c]);
        tris.push([a, c, d]);
        tris.push([[0.0, 0.0, 0.0], b, a]);
        tris.push([[0.0, 0.0, height], d, c]);
    }
    Mesh { triangles: tris }
}

#[test]
fn lightning_saves_filament_without_dropping_toughness() {
    let mesh = cube();
    let speed = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    let speed_old = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &classic(),
    )
    .unwrap();
    let tough = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    let tough_old = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        &profile(),
        &classic(),
    )
    .unwrap();
    assert!(speed.sanity.ok && tough.sanity.ok);
    assert!(
        speed.estimate.filament_mm < speed_old.estimate.filament_mm * 0.75,
        "lightning filament {} vs classic {}",
        speed.estimate.filament_mm,
        speed_old.estimate.filament_mm
    );
    assert!(speed.gcode.contains("lightning"));
    assert!(!speed.gcode.contains("gyroid3d"));
    assert!(tough.gcode.contains("gyroid3d"));
    assert!(
        tough.score.toughness >= tough_old.score.toughness * 0.90,
        "toughness {} vs classic {}",
        tough.score.toughness,
        tough_old.score.toughness
    );
    assert!(tough.score.toughness > speed.score.toughness * 2.0);
    assert!(speed.estimate.seconds > 1.0 && speed.estimate.filament_g > 0.1);
    assert!(speed.score.efficiency > speed_old.score.efficiency);
}

#[test]
fn thin_wall_uses_a_variable_bead() {
    let mesh = thin_fin();
    let response = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let bead = response
        .layers
        .iter()
        .flat_map(|l| l.paths.iter())
        .any(|p| {
            (p.kind == "thin-wall" || is_wall(&p.kind) || p.kind == "gap-fill")
                && p.width > 0.2
                && (p.width - 0.45).abs() > 0.04
        });
    assert!(bead, "expected a variable-width bead on the 0.7 mm fin");
    assert!(
        has_type(&response.gcode, "THIN-WALL")
            || has_type(&response.gcode, "WALL")
            || has_type(&response.gcode, "OUTER")
    );
}

#[test]
fn bridge_and_overhang_slow_the_span() {
    let mesh = bridge_span();
    let response = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let bridges: Vec<_> = response
        .layers
        .iter()
        .flat_map(|l| l.paths.iter())
        .filter(|p| p.kind == "bridge")
        .collect();
    assert!(!bridges.is_empty(), "expected a bridge across the span");
    assert!(bridges.iter().all(|p| p.speed <= 40.0));
    assert!(has_type(&response.gcode, "BRIDGE"));
    let off = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &SliceSettings {
            overhang_control: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(!has_type(&off.gcode, "BRIDGE"));
}

#[test]
fn arcs_fit_a_cylinder_and_classic_stays_linear() {
    let mesh = cylinder(12.0, 4.0, 48);
    let fitted = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    let linear = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &classic(),
    )
    .unwrap();
    assert!(fitted.sanity.ok, "{:?}", fitted.sanity.notes);
    assert!(linear.sanity.ok, "{:?}", linear.sanity.notes);
    assert!(fitted.estimate.arc_moves > 0, "expected G2/G3");
    assert!(fitted.gcode.contains("G2 ") || fitted.gcode.contains("G3 "));
    assert_eq!(linear.estimate.arc_moves, 0);
    assert!(fitted.gcode.contains("G1 "));
    assert!(fitted.estimate.filament_g > 0.0);
}

#[test]
fn volumetric_flow_caps_extrusion_feed() {
    let mesh = cube();
    let mut printer = profile();
    printer.max_volumetric_mm3_s = 1.5;
    let response = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &printer,
        &SliceSettings::default(),
    )
    .unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let mut over = 0u32;
    for line in response.gcode.lines() {
        if !line.starts_with("G1 ") || !line.contains(" E") {
            continue;
        }
        let Some(f) = line
            .split_whitespace()
            .find_map(|tok| tok.strip_prefix('F'))
        else {
            continue;
        };
        let f: f64 = f.parse().unwrap();
        // Narrow variable beads may run faster than a 0.45 mm bead. 140 mm/s is F8400.
        if f > 2800.0 {
            over += 1;
        }
    }
    assert_eq!(over, 0, "extrusion feed exceeded the volumetric cap");
}

#[test]
fn indexed_slice_matches_classic_contours() {
    let mesh = cube();
    let indexed = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        &profile(),
        &SliceSettings {
            classic: false,
            variable_width: false,
            arc_fit: false,
            travel_opt: false,
            overhang_control: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let scanned = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        &profile(),
        &SliceSettings {
            classic: false,
            spatial_index: false,
            variable_width: false,
            arc_fit: false,
            travel_opt: false,
            overhang_control: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert_eq!(indexed.sanity.layers, scanned.sanity.layers);
    let mid_i = indexed.layers.iter().find(|l| l.index == 40).unwrap();
    let mid_s = scanned.layers.iter().find(|l| l.index == 40).unwrap();
    assert_eq!(mid_i.toughness_walls, mid_s.toughness_walls);
    let rel = (indexed.estimate.filament_mm - scanned.estimate.filament_mm).abs()
        / scanned.estimate.filament_mm;
    assert!(rel < 0.08, "filament drifted {rel}");
}

fn speed_mode() -> BlendMode {
    BlendMode::Single {
        strategy: StrategyId::Speed,
    }
}

#[test]
fn feature_speeds_keep_outer_slower_than_sparse() {
    let mesh = cube();
    let response =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let outer = feed_after(&response.gcode, "OUTER");
    let sparse = feed_after(&response.gcode, "SPARSE");
    assert!(outer > 0.0 && sparse > 0.0, "outer {outer} sparse {sparse}");
    assert!(
        outer < sparse,
        "outer feed {outer} should be below sparse {sparse}"
    );
    let off = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            feature_speeds: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(has_type(&off.gcode, "WALL"));
    assert!(!has_type(&off.gcode, "OUTER"));
}

fn feed_after(gcode: &str, kind: &str) -> f64 {
    let marker = format!("TYPE:{kind}");
    let mut armed = false;
    for line in gcode.lines() {
        if line.contains(&marker) {
            armed = true;
            continue;
        }
        if armed && line.starts_with("G1 ") && line.contains(" E") {
            if let Some(f) = line.split_whitespace().find_map(|t| t.strip_prefix('F')) {
                return f.parse().unwrap_or(0.0);
            }
        }
    }
    0.0
}

#[test]
fn infill_combine_thins_sparse_layers_and_classic_disables_it() {
    let mesh = cube();
    // 0.1 mm still fits three layers under the 0.75 × nozzle cap.
    let on = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            layer_height: 0.1,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let off = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            layer_height: 0.1,
            infill_combine: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let old = slice_configured(&mesh, &speed_mode(), &profile(), &classic()).unwrap();
    assert!(on.sanity.ok && off.sanity.ok, "{:?}", on.sanity.notes);
    let on_n = on.gcode.matches("TYPE:SPARSE").count() + on.gcode.matches("TYPE:TOP").count();
    let off_n = off.gcode.matches("TYPE:SPARSE").count() + off.gcode.matches("TYPE:TOP").count();
    assert!(on_n < off_n, "combined infill lines {on_n} vs {off_n}");
    let rel = (on.estimate.filament_g - off.estimate.filament_g).abs() / off.estimate.filament_g;
    assert!(rel < 0.2, "filament drifted {rel}");
    assert!(on.estimate.seconds < off.estimate.seconds * 1.05);
    assert!(!old.gcode.contains("TYPE:SPARSE"));
    assert!(old.gcode.contains("TYPE:INFILL"));
}

#[test]
fn tree_supports_use_less_filament_than_grid_and_keep_an_interface() {
    let mesh = ledge();
    let grid = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            supports: true,
            support_style: lime_slice_core::SupportStyle::Grid,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let tree = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            supports: true,
            support_style: lime_slice_core::SupportStyle::Tree,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(grid.sanity.ok, "{:?}", grid.sanity.notes);
    assert!(tree.sanity.ok, "{:?}", tree.sanity.notes);
    assert!(has_type(&tree.gcode, "SUPPORT"));
    assert!(has_type(&tree.gcode, "SUPPORT-INTERFACE"));
    assert!(
        tree.estimate.filament_g < grid.estimate.filament_g * 0.85,
        "tree {:.3} g vs grid {:.3} g",
        tree.estimate.filament_g,
        grid.estimate.filament_g
    );
    let thick = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            supports: true,
            support_style: lime_slice_core::SupportStyle::Tree,
            support_height_mult: 2.0,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(thick.sanity.ok, "{:?}", thick.sanity.notes);
    assert!(thick.estimate.seconds <= tree.estimate.seconds * 1.02);
}

#[test]
fn combing_routes_around_a_hole_and_retracts_less() {
    let mesh = window_frame();
    let routed =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    let straight = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            combing: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(routed.sanity.ok, "{:?}", routed.sanity.notes);
    assert!(straight.sanity.ok, "{:?}", straight.sanity.notes);
    assert!(
        routed.sanity.retracts < straight.sanity.retracts,
        "combing retracts {} vs straight {}",
        routed.sanity.retracts,
        straight.sanity.retracts
    );
}

fn window_frame() -> Mesh {
    let mut tris = Vec::new();
    add_box(&mut tris, 0.0, 0.0, 0.0, 30.0, 8.0, 6.0);
    add_box(&mut tris, 0.0, 22.0, 0.0, 30.0, 30.0, 6.0);
    add_box(&mut tris, 0.0, 8.0, 0.0, 8.0, 22.0, 6.0);
    add_box(&mut tris, 22.0, 8.0, 0.0, 30.0, 22.0, 6.0);
    Mesh { triangles: tris }
}

#[test]
fn pressure_advance_is_emitted_from_the_profile() {
    let mesh = cube();
    let mut printer = profile();
    printer.pressure_advance = 0.05;
    printer.linear_advance = 0.08;
    let response =
        slice_configured(&mesh, &speed_mode(), &printer, &SliceSettings::default()).unwrap();
    assert!(response
        .gcode
        .contains("SET_PRESSURE_ADVANCE ADVANCE=0.0500"));
    assert!(response.gcode.contains("M900 K0.080"));
    assert!(
        response
            .gcode
            .contains("SET_PRESSURE_ADVANCE ADVANCE=0.0325")
            || response.gcode.contains("M900 K0.052")
    );
    let old = slice_configured(&mesh, &speed_mode(), &printer, &classic()).unwrap();
    assert!(!old.gcode.contains("SET_PRESSURE_ADVANCE"));
    assert!(!old.gcode.contains("M900"));
}

fn tough_mode() -> BlendMode {
    BlendMode::Single {
        strategy: StrategyId::Toughness,
    }
}

fn scarf_outer() -> SliceSettings {
    SliceSettings {
        scarf_seam: lime_slice_core::ScarfSeam::Outer,
        ..SliceSettings::default()
    }
}

#[test]
fn scarf_ramps_a_smooth_wall_and_keeps_cube_corners() {
    let post = cylinder(12.0, 6.0, 48);
    let on = slice_configured(&post, &tough_mode(), &profile(), &scarf_outer()).unwrap();
    assert!(on.sanity.ok, "{:?}", on.sanity.notes);
    assert!(on.estimate.scarfed_loops > 0, "expected scarf overlaps");
    assert!(
        (on.estimate.mean_scarf_mm - 10.0).abs() < 0.2,
        "mean overlap {}",
        on.estimate.mean_scarf_mm
    );
    assert!(
        on.estimate.max_seam_z_step_mm < 0.04,
        "Z step {} should stay under one ramp increment",
        on.estimate.max_seam_z_step_mm
    );
    assert!(
        on.estimate.arc_moves > 0,
        "body of the wall should still arc-fit"
    );
    assert_gcode_z_and_e(&on.gcode);
    let first = on.gcode.split(";LAYER:1 ").next().unwrap_or("");
    for line in first.lines() {
        if !(line.starts_with("G0 ")
            || line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 "))
        {
            continue;
        }
        if let Some(z) = line.split_whitespace().find_map(|t| t.strip_prefix('Z')) {
            let z: f64 = z.parse().unwrap();
            assert!(z + 1e-3 >= 0.2, "first layer Z {z} ramped below the layer");
        }
    }

    let cube_on = slice_configured(&cube(), &tough_mode(), &profile(), &scarf_outer()).unwrap();
    assert_eq!(
        cube_on.estimate.scarfed_loops, 0,
        "a sharp corner keeps the corner seam"
    );
    assert_gcode_z_and_e(&cube_on.gcode);

    let speed =
        slice_configured(&post, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert_eq!(
        speed.estimate.scarfed_loops, 0,
        "speed blend leaves scarf off"
    );

    let classic_post = slice_configured(&post, &tough_mode(), &profile(), &classic()).unwrap();
    assert_eq!(classic_post.estimate.scarfed_loops, 0);

    let tiny = cylinder(1.0, 4.0, 24);
    let tiny_on = slice_configured(&tiny, &tough_mode(), &profile(), &scarf_outer()).unwrap();
    assert_eq!(
        tiny_on.estimate.scarfed_loops, 0,
        "loops under 8 mm stay butt seams"
    );
}

#[test]
fn scarf_all_includes_inner_walls_and_outer_does_not() {
    let post = cylinder(12.0, 2.0, 32);
    let outer = slice_configured(&post, &speed_mode(), &profile(), &scarf_outer()).unwrap();
    let all = slice_configured(
        &post,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            scarf_seam: lime_slice_core::ScarfSeam::All,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(all.estimate.scarfed_loops > outer.estimate.scarfed_loops);
    assert_gcode_z_and_e(&all.gcode);
    assert_gcode_z_and_e(&outer.gcode);
}

/// Extrusion Z stays inside the current layer slab, and E only decreases on retracts.
fn assert_gcode_z_and_e(gcode: &str) {
    let mut layer_z = 0.0;
    let mut layer_h = 0.2;
    let mut in_layer = false;
    let mut e = 0.0;
    let mut saw = false;
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            saw = true;
            in_layer = true;
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("Z:") {
                    layer_z = v.parse().expect("layer z");
                }
                if let Some(v) = tok.strip_prefix("H:") {
                    layer_h = v.parse().expect("layer h");
                }
            }
            continue;
        }
        if !(line.starts_with("G0 ")
            || line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 "))
        {
            continue;
        }
        let mut has_xy = false;
        let mut z = None;
        let mut e_new = None;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                let _ = v;
                has_xy = true;
            } else if let Some(v) = tok.strip_prefix('Y') {
                let _ = v;
                has_xy = true;
            } else if let Some(v) = tok.strip_prefix('Z') {
                z = Some(v.parse::<f64>().expect("z"));
            } else if let Some(v) = tok.strip_prefix('E') {
                e_new = Some(v.parse::<f64>().expect("e"));
            }
        }
        if in_layer {
            if let Some(z) = z {
                let lo = layer_z - layer_h - 1e-3;
                let extruding = e_new.map(|en| en > e + 1e-6).unwrap_or(false);
                if extruding {
                    assert!(
                        (lo..=layer_z + 1e-3).contains(&z),
                        "extrusion Z {z} outside [{lo}, {layer_z}] in {line}"
                    );
                } else if !has_xy {
                    assert!(z + 1e-3 >= lo, "Z-only {z} below previous layer in {line}");
                }
            }
        }
        if let Some(en) = e_new {
            if has_xy {
                assert!(en + 1e-4 >= e, "E decreased on extrusion {line}");
            }
            e = en;
        }
    }
    assert!(saw, "no layer markers");
}

#[test]
fn gyroid3d_changes_with_z_and_stays_off_for_speed_and_classic() {
    let mesh = cube();
    let on = slice_configured(&mesh, &tough_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert!(on.sanity.ok, "{:?}", on.sanity.notes);
    assert!(on.gcode.contains("gyroid3d"));
    let sparse_layers: Vec<Vec<[f64; 2]>> = on
        .layers
        .iter()
        .filter(|l| l.z > 2.0 && l.z < 16.0)
        .map(|l| {
            l.paths
                .iter()
                .filter(|p| p.kind == "sparse")
                .flat_map(|p| p.pts.iter().copied())
                .collect::<Vec<_>>()
        })
        .filter(|pts| pts.len() > 20)
        .collect();
    assert!(
        sparse_layers.len() >= 2,
        "expected 3D gyroid sparse layers, found {}",
        sparse_layers.len()
    );
    assert_ne!(sparse_layers[0], sparse_layers[sparse_layers.len() / 2]);
    let off = slice_configured(
        &mesh,
        &tough_mode(),
        &profile(),
        &SliceSettings {
            gyroid_3d: lime_slice_core::Gyroid3d::Off,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(off.gcode.contains("gyroid"));
    assert!(!off.gcode.contains("gyroid3d"));
    assert!(
        on.gcode.contains("M204 S4000"),
        "3D gyroid should use its own infill accel"
    );
    assert!(
        !off.gcode.contains("M204 S4000"),
        "2D gyroid must keep the old sparse accel"
    );
    assert!(
        on.estimate.seconds < off.estimate.seconds * 0.7,
        "recovered {:.1}s vs 2D {:.1}s",
        on.estimate.seconds,
        off.estimate.seconds
    );
    assert!(
        on.score.toughness > off.score.toughness,
        "score {:.1} vs 2D {:.1}",
        on.score.toughness,
        off.score.toughness
    );
    assert!(
        on.score.toughness > 11500.0,
        "cube score {:.1} fell back under the unrecovered 3D gyroid",
        on.score.toughness
    );
    assert!(
        on.estimate.seconds < 2400.0,
        "cube time {:.1}s gave back the print-time recovery",
        on.estimate.seconds
    );
    let classic_t = slice_configured(&mesh, &tough_mode(), &profile(), &classic()).unwrap();
    assert!(!classic_t.gcode.contains("gyroid3d"));
    let speed =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert!(speed.gcode.contains("lightning"));
    assert!(!speed.gcode.contains("gyroid3d"));
}

#[test]
fn z_hop_returns_to_the_layer_and_skips_speed_by_default() {
    let mesh = cube();
    let always = slice_configured(
        &mesh,
        &tough_mode(),
        &profile(),
        &SliceSettings {
            z_hop: lime_slice_core::ZHopMode::Always,
            z_hop_height: 0.4,
            z_hop_min_travel: 0.4,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(always.sanity.ok, "{:?}", always.sanity.notes);
    assert!(always.estimate.z_hops > 0, "always mode should hop");
    assert_hop_returns(&always.gcode);

    let speed =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert_eq!(speed.estimate.z_hops, 0, "speed blend leaves z-hop off");
    let classic_t = slice_configured(&mesh, &tough_mode(), &profile(), &classic()).unwrap();
    assert_eq!(classic_t.estimate.z_hops, 0, "classic leaves z-hop off");

    let smart = slice_configured(
        &mesh,
        &tough_mode(),
        &profile(),
        &SliceSettings {
            z_hop: lime_slice_core::ZHopMode::Smart,
            z_hop_min_travel: 0.4,
            combing: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(smart.estimate.z_hops > 0, "smart hops blocked travels");
    assert!(
        smart.estimate.z_hops < always.estimate.z_hops,
        "smart {} should hop less than always {}",
        smart.estimate.z_hops,
        always.estimate.z_hops
    );
    assert_hop_returns(&smart.gcode);
}

fn assert_hop_returns(gcode: &str) {
    let mut layer_z = 0.0;
    let mut z = 0.0;
    let mut e = 0.0;
    let mut hopped = false;
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("Z:") {
                    layer_z = v.parse().unwrap();
                    z = layer_z;
                    hopped = false;
                }
            }
            continue;
        }
        if !(line.starts_with("G0 ")
            || line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 "))
        {
            continue;
        }
        let mut e_new = None;
        let mut z_new = None;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('Z') {
                z_new = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('E') {
                e_new = Some(v.parse::<f64>().unwrap());
            }
        }
        if let Some(zn) = z_new {
            z = zn;
            if z > layer_z + 0.05 {
                hopped = true;
            }
        }
        if let Some(en) = e_new {
            if en > e + 1e-6 {
                assert!(
                    z <= layer_z + 0.02,
                    "extrusion at Z {z} while layer is {layer_z}"
                );
                assert!(
                    !hopped || (z - layer_z).abs() < 0.05,
                    "still hopped at Z {z}"
                );
                hopped = false;
            }
            e = en;
        }
    }
}

#[test]
fn scarf_overlap_z_never_drops() {
    let post = cylinder(12.0, 6.0, 64);
    let on = slice_configured(&post, &tough_mode(), &profile(), &scarf_outer()).unwrap();
    assert!(on.estimate.scarfed_loops > 0);
    let layer = gcode_layer(&on.gcode, 1);
    let mut seen: Vec<([i32; 2], f64)> = Vec::new();
    let mut z = 0.0;
    for line in layer.lines() {
        if !(line.starts_with("G0 ")
            || line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 "))
        {
            continue;
        }
        let mut xy: Option<(f64, f64)> = None;
        let mut e = false;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                let x: f64 = v.parse().unwrap();
                xy = Some((x, xy.map(|p| p.1).unwrap_or(0.0)));
            } else if let Some(v) = tok.strip_prefix('Y') {
                let y: f64 = v.parse().unwrap();
                let x = xy.map(|p| p.0).unwrap_or(0.0);
                xy = Some((x, y));
            } else if let Some(v) = tok.strip_prefix('Z') {
                z = v.parse().unwrap();
            } else if tok.starts_with('E') {
                e = true;
            }
        }
        let Some((x, y)) = xy else { continue };
        if !e {
            continue;
        }
        let key = [(x * 100.0).round() as i32, (y * 100.0).round() as i32];
        if let Some((_, prev)) = seen.iter().rev().find(|(k, _)| *k == key) {
            assert!(
                z + 1e-3 >= *prev,
                "overlap {x:.3},{y:.3} dropped from Z {prev} to {z}"
            );
        }
        seen.push((key, z));
    }
    assert!(seen.len() > 8, "expected a scarfed wall");
}

#[test]
fn combing_does_not_cross_a_hole_without_retract() {
    let mesh = window_frame();
    let speed =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    assert!(speed.sanity.ok, "{:?}", speed.sanity.notes);
    let crossings = hole_crossings(&speed.gcode);
    assert!(
        crossings.iter().all(|c| c.retracted),
        "unretracted hole crossings: {} of {} {:?}",
        crossings.iter().filter(|c| !c.retracted).count(),
        crossings.len(),
        crossings.iter().find(|c| !c.retracted).map(|c| (c.a, c.b))
    );
    assert_eq!(
        speed.estimate.z_hops, 0,
        "speed does not hop a hole crossing"
    );
    assert!(
        crossings.iter().all(|c| !c.hopped),
        "speed lifted on a hole crossing"
    );

    let tough =
        slice_configured(&mesh, &tough_mode(), &profile(), &SliceSettings::default()).unwrap();
    let tough_cross = hole_crossings(&tough.gcode);
    assert!(
        tough_cross.iter().all(|c| c.retracted),
        "toughness crossed a hole without retract"
    );
    let long: Vec<_> = tough_cross
        .iter()
        .filter(|c| !c.scarf && (c.a[0] - c.b[0]).hypot(c.a[1] - c.b[1]) >= 2.0)
        .collect();
    assert!(
        !long.is_empty(),
        "expected a long hole crossing on the frame"
    );
    assert!(
        long.iter().all(|c| c.hopped),
        "smart z-hop should lift a long retracted hole crossing (long {}, hopped {}, z-hops {})",
        long.len(),
        long.iter().filter(|c| c.hopped).count(),
        tough.estimate.z_hops
    );
}

struct HoleCross {
    retracted: bool,
    hopped: bool,
    scarf: bool,
    a: [f64; 2],
    b: [f64; 2],
}

fn hole_crossings(gcode: &str) -> Vec<HoleCross> {
    let hole = [8.4, 8.4, 21.6, 21.6];
    let mut out = Vec::new();
    let mut layer_z = 0.0;
    let mut e = 0.0;
    let mut retracted = false;
    let mut pos: Option<[f64; 2]> = None;
    let mut pending: Vec<HoleCross> = Vec::new();
    let mut lift = false;
    let mut scarf_arm = false;
    let flush =
        |out: &mut Vec<HoleCross>, pending: &mut Vec<HoleCross>, lift: &mut bool, scarf: bool| {
            for mut cross in pending.drain(..) {
                cross.hopped = *lift;
                cross.scarf = scarf;
                out.push(cross);
            }
            *lift = false;
        };
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            flush(&mut out, &mut pending, &mut lift, false);
            pos = None;
            scarf_arm = false;
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("Z:") {
                    layer_z = v.parse().unwrap();
                }
            }
            continue;
        }
        if !(line.starts_with("G0 ")
            || line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 "))
        {
            continue;
        }
        let mut x = None;
        let mut y = None;
        let mut e_new = None;
        let mut z_new = None;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                x = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('Y') {
                y = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('Z') {
                z_new = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('E') {
                e_new = Some(v.parse::<f64>().unwrap());
            }
        }
        if let Some(z) = z_new {
            if z > layer_z + 0.05 {
                lift = true;
            }
            if z + 0.02 < layer_z {
                scarf_arm = true;
            }
        }
        if x.is_none() && y.is_none() {
            if let Some(en) = e_new {
                retracted = en + 1e-6 < e;
                e = en;
            }
            continue;
        }
        let next = [
            x.unwrap_or(pos.map(|p| p[0]).unwrap_or(0.0)),
            y.unwrap_or(pos.map(|p| p[1]).unwrap_or(0.0)),
        ];
        if e_new.is_none() {
            if let Some(prev) = pos {
                if segment_hits_rect(prev, next, hole) {
                    pending.push(HoleCross {
                        retracted,
                        hopped: false,
                        scarf: false,
                        a: prev,
                        b: next,
                    });
                }
            }
        } else {
            let scarf = scarf_arm || z_new.map(|zn| zn + 0.02 < layer_z).unwrap_or(false);
            scarf_arm = false;
            flush(&mut out, &mut pending, &mut lift, scarf);
            retracted = false;
            e = e_new.unwrap();
        }
        pos = Some(next);
    }
    flush(&mut out, &mut pending, &mut lift, false);
    out
}

fn segment_hits_rect(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> bool {
    if point_in_rect(a, r) || point_in_rect(b, r) {
        return true;
    }
    let corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    corners.iter().enumerate().any(|(i, c)| {
        let d = corners[(i + 1) % 4];
        segs_cross(a, b, *c, d)
    })
}

fn point_in_rect(p: [f64; 2], r: [f64; 4]) -> bool {
    p[0] > r[0] && p[0] < r[2] && p[1] > r[1] && p[1] < r[3]
}

fn segs_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    o(a, b, c) * o(a, b, d) < -1e-9 && o(c, d, a) * o(c, d, b) < -1e-9
}

#[test]
fn infill_combine_caps_height_and_fills_under_the_top() {
    let mesh = cube();
    let capped =
        slice_configured(&mesh, &speed_mode(), &profile(), &SliceSettings::default()).unwrap();
    let heights = sparse_bead_heights(&capped.gcode);
    assert!(
        !heights.is_empty(),
        "speed cube should still print sparse infill, sparse blocks {}",
        capped.gcode.matches("TYPE:SPARSE").count()
    );
    assert!(
        heights.iter().all(|h| *h <= 0.32),
        "combined bead exceeded 0.75 × 0.4 mm nozzle: {heights:?}"
    );
    assert_sparse_under_top(&capped.gcode);

    let combined = slice_configured(
        &mesh,
        &speed_mode(),
        &profile(),
        &SliceSettings {
            layer_height: 0.1,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let beads = sparse_bead_heights(&combined.gcode);
    assert!(
        beads.iter().any(|h| (*h - 0.3).abs() < 0.04),
        "expected E for a 0.3 mm combined bead, got {beads:?}"
    );
    assert!(
        beads.iter().all(|h| *h <= 0.34),
        "bead over the cap: {beads:?}"
    );
    assert_sparse_under_top(&combined.gcode);
}

fn sparse_bead_heights(gcode: &str) -> Vec<f64> {
    let fil = std::f64::consts::PI * (1.75_f64 * 0.5).powi(2);
    let width = 0.45;
    let mut out = Vec::new();
    let mut sparse = false;
    let mut e = 0.0;
    let mut pos: Option<[f64; 2]> = None;
    for line in gcode.lines() {
        if line.contains("TYPE:") {
            sparse = line.contains("TYPE:SPARSE");
            continue;
        }
        if line.starts_with(";LAYER:") {
            sparse = false;
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ")) {
            continue;
        }
        let mut x = None;
        let mut y = None;
        let mut e_new = None;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                x = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('Y') {
                y = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('E') {
                e_new = Some(v.parse::<f64>().unwrap());
            }
        }
        if let (Some(prev), Some(en)) = (pos, e_new) {
            if sparse {
                let next = [x.unwrap_or(prev[0]), y.unwrap_or(prev[1])];
                let d = (next[0] - prev[0]).hypot(next[1] - prev[1]);
                let de = en - e;
                if d > 0.5 && de > 0.0 {
                    out.push(de * fil / (d * width));
                }
            }
        }
        if let Some(en) = e_new {
            e = en;
        }
        if x.is_some() || y.is_some() {
            let prev = pos.unwrap_or([0.0, 0.0]);
            pos = Some([x.unwrap_or(prev[0]), y.unwrap_or(prev[1])]);
        }
    }
    out
}

fn assert_sparse_under_top(gcode: &str) {
    let mut layers: Vec<(u32, bool, bool)> = Vec::new();
    let mut sparse = false;
    let mut top = false;
    let mut started = false;
    let mut index = 0u32;
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            if started {
                layers.push((index, sparse, top));
            }
            index = rest
                .split_whitespace()
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            sparse = false;
            top = false;
            started = true;
            continue;
        }
        if line.contains("TYPE:SPARSE") {
            sparse = true;
        }
        if line.contains("TYPE:TOP") {
            top = true;
        }
    }
    if started {
        layers.push((index, sparse, top));
    }
    let first_top = layers.iter().position(|(_, _, t)| *t).expect("top skin");
    assert!(
        layers[first_top - 1].1,
        "the layer under the top skin has no sparse"
    );
    let beads = sparse_layer_beads(gcode);
    let mut layer_h = 0.2;
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("H:") {
                    layer_h = v.parse().unwrap_or(layer_h);
                }
            }
            break;
        }
    }
    let mut gap = 0usize;
    for (_, sparse, _) in layers.iter().take(first_top - 1).rev() {
        if *sparse {
            break;
        }
        gap += 1;
    }
    if gap <= 4 {
        let index = layers[first_top - 1].0;
        let bead = beads.get(&index).copied().unwrap_or(0.0);
        let need = (gap as f64 + 1.0) * layer_h;
        assert!(
            bead + 0.04 >= need,
            "layer {index} bead {bead:.3} does not cover {need:.3} under the top skin"
        );
    }
}

fn sparse_layer_beads(gcode: &str) -> std::collections::HashMap<u32, f64> {
    let fil = std::f64::consts::PI * (1.75_f64 * 0.5).powi(2);
    let mut out = std::collections::HashMap::new();
    let mut index = 0u32;
    let mut sparse = false;
    let mut e = 0.0;
    let mut pos: Option<[f64; 2]> = None;
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            index = rest
                .split_whitespace()
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            sparse = false;
            continue;
        }
        if line.contains("TYPE:") {
            sparse = line.contains("TYPE:SPARSE");
            continue;
        }
        if !(line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ")) {
            continue;
        }
        let mut x = None;
        let mut y = None;
        let mut e_new = None;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                x = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('Y') {
                y = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('E') {
                e_new = Some(v.parse::<f64>().unwrap());
            }
        }
        if let (Some(prev), Some(en)) = (pos, e_new) {
            if sparse {
                let next = [x.unwrap_or(prev[0]), y.unwrap_or(prev[1])];
                let d = (next[0] - prev[0]).hypot(next[1] - prev[1]);
                let de = en - e;
                if d > 0.5 && de > 0.0 {
                    let h = de * fil / (d * 0.45);
                    let slot = out.entry(index).or_insert(0.0);
                    if h > *slot {
                        *slot = h;
                    }
                }
            }
        }
        if let Some(en) = e_new {
            e = en;
        }
        if x.is_some() || y.is_some() {
            let prev = pos.unwrap_or([0.0, 0.0]);
            pos = Some([x.unwrap_or(prev[0]), y.unwrap_or(prev[1])]);
        }
    }
    out
}

#[test]
fn region_split_keeps_one_outer_wall() {
    let response = slice_configured(
        &cube(),
        &BlendMode::ByRegion {
            axis: Axis::X,
            at_mm: 10.0,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    let layer = gcode_layer(&response.gcode, 40);
    let mut xs = Vec::new();
    let mut outer = false;
    let mut prev: Option<[f64; 2]> = None;
    for line in layer.lines() {
        if line.contains("TYPE:") {
            outer = line.contains("TYPE:OUTER");
            prev = None;
            continue;
        }
        if !outer || !line.starts_with("G1 ") {
            continue;
        }
        let mut x = None;
        let mut y = None;
        let mut extruding = false;
        for tok in line.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                x = Some(v.parse::<f64>().unwrap());
            } else if let Some(v) = tok.strip_prefix('Y') {
                y = Some(v.parse::<f64>().unwrap());
            } else if tok.starts_with('E') {
                extruding = true;
            }
        }
        if let (Some(p), Some(x), Some(y)) = (prev, x, y) {
            if extruding
                && (x - p[0]).abs() < 0.08
                && (y - p[1]).abs() > 2.0
                && (8.0..12.0).contains(&x)
            {
                xs.push((x * 20.0).round() / 20.0);
            }
        }
        if x.is_some() || y.is_some() {
            prev = Some([
                x.unwrap_or(prev.map(|p| p[0]).unwrap_or(0.0)),
                y.unwrap_or(prev.map(|p| p[1]).unwrap_or(0.0)),
            ]);
        }
    }
    xs.sort_by(|a, b| a.total_cmp(b));
    xs.dedup();
    assert_eq!(
        xs,
        vec![10.0],
        "outer walls on the cut: {xs:?}\n{}",
        layer
            .lines()
            .filter(|l| l.contains("OUTER") || l.contains("G1 "))
            .take(30)
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn speed_half_layer_zero_has_bottom_fill() {
    let response = slice_configured(
        &cube(),
        &BlendMode::ByRegion {
            axis: Axis::X,
            at_mm: 10.0,
        },
        &profile(),
        &SliceSettings::default(),
    )
    .unwrap();
    let layer = gcode_layer(&response.gcode, 0);
    let mut solid_x = false;
    let mut in_solid = false;
    for line in layer.lines() {
        if line.contains("TYPE:") {
            in_solid = line.contains("TYPE:SOLID");
            continue;
        }
        if !in_solid || !line.starts_with("G1 ") {
            continue;
        }
        for tok in line.split_whitespace() {
            if let Some(v) = tok.strip_prefix('X') {
                let x: f64 = v.parse().unwrap();
                if x > 12.0 {
                    solid_x = true;
                }
            }
        }
    }
    assert!(
        solid_x,
        "speed half of layer 0 has walls and no bottom solid\n{}",
        layer
            .lines()
            .filter(|l| l.contains("TYPE:"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let layer0 = response.layers.iter().find(|l| l.index == 0).unwrap();
    assert!(
        layer0.paths.iter().any(|p| p.kind == "solid"
            && p.strategy == "speed"
            && p.pts.iter().any(|q| q[0] > 12.0)),
        "2D preview is missing speed-half bottom fill"
    );
}

fn gcode_layer(gcode: &str, index: usize) -> String {
    let marker = format!(";LAYER:{index} ");
    let Some(start) = gcode.find(&marker) else {
        panic!("missing {marker}");
    };
    let rest = &gcode[start + marker.len()..];
    match rest.find("\n;LAYER:") {
        Some(end) => rest[..end].to_string(),
        None => rest.to_string(),
    }
}

#[test]
fn feature_times_match_total_and_baseline_skip_is_real() {
    let mesh = cube();
    let settings = SliceSettings {
        baseline: false,
        compare: true,
        ..SliceSettings::default()
    };
    let response = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile(),
        &settings,
    )
    .unwrap();
    assert_eq!(response.baseline_ms, 0.0, "baseline pass must be skipped");
    assert_eq!(response.baseline_label, "skipped");
    let sum: f64 = response
        .estimate
        .by_feature
        .iter()
        .map(|row| row.seconds)
        .sum();
    let total = response.estimate.seconds.max(1e-6);
    assert!(
        (sum - response.estimate.seconds).abs() / total < 0.005,
        "feature seconds {sum} vs total {}",
        response.estimate.seconds
    );
    let grams: f64 = response
        .estimate
        .by_feature
        .iter()
        .map(|row| row.filament_g)
        .sum();
    assert!((grams - response.estimate.filament_g).abs() < 0.02);
    let labels: Vec<_> = response
        .compare
        .iter()
        .map(|row| row.label.as_str())
        .collect();
    assert_eq!(labels, vec!["speed", "efficiency", "toughness", "classic"]);
    let speed = response
        .compare
        .iter()
        .find(|row| row.label == "speed")
        .unwrap();
    let tough = response
        .compare
        .iter()
        .find(|row| row.label == "toughness")
        .unwrap();
    let classic = response
        .compare
        .iter()
        .find(|row| row.label == "classic")
        .unwrap();
    assert!((speed.seconds - response.estimate.seconds).abs() < 0.05);
    assert!(tough.seconds > speed.seconds);
    assert!(classic.seconds > 0.0 && classic.filament_g > 0.0);
    assert!(tough.by_feature.iter().map(|row| row.seconds).sum::<f64>() > 0.0);
}
