use std::path::PathBuf;

use lime_slice_core::{load_mesh, slice_with_baseline, Axis, BlendMode, Mesh, StrategyId};

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
    let mode: BlendMode = serde_json::from_str(
        r#"{"mode":"byRegion","axis":"x","atMm":10}"#,
    )
    .unwrap();
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
