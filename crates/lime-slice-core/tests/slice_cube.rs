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

    let mid = speed.layers.iter().find(|l| l.index == 40).unwrap();
    let mid_t = tough.layers.iter().find(|l| l.index == 40).unwrap();
    assert!(mid.speed_walls > 0);
    assert_eq!(mid.toughness_walls, 0);
    assert!(
        mid_t.toughness_walls > mid.speed_walls,
        "toughness walls {} vs speed walls {}",
        mid_t.toughness_walls,
        mid.speed_walls
    );
    let speed_infill = mid.paths.iter().filter(|p| p.kind == "infill").count();
    let tough_infill = mid_t.paths.iter().filter(|p| p.kind == "infill").count();
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

fn has_type(gcode: &str, kind: &str) -> bool {
    let marker = format!("TYPE:{kind}");
    gcode
        .lines()
        .any(|line| line.trim().trim_start_matches(';').trim() == marker)
}

fn settings(adaptive: bool, supports: bool) -> SliceSettings {
    SliceSettings {
        layer_height: 0.2,
        line_width: 0.45,
        adaptive,
        adaptive_min: 0.08,
        adaptive_max: 0.2,
        supports,
        support_angle: 45.0,
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
    assert!(has_type(&held.gcode, "WALL"));
    assert!(has_type(&held.gcode, "INFILL"));
    assert!(!has_type(&bare.gcode, "SUPPORT"));
    let shelf = held
        .layers
        .iter()
        .find(|l| (l.z - 14.0).abs() < 0.05)
        .unwrap();
    assert!(shelf.support_paths == 0);
    assert!(shelf.paths.iter().any(|p| p.kind == "wall"));
}
