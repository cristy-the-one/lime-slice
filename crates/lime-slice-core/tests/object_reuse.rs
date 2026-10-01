use lime_slice_core::{
    keep_object_slices, slice_configured, BlendMode, Mesh, PrinterProfile, SliceResponse,
    SliceSettings, StrategyId, SupportStyle,
};

#[allow(clippy::too_many_arguments)]
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

/// A block with a shelf sticking out past it, so supports have work to do.
fn ledge() -> Mesh {
    let mut tris = Vec::new();
    add_box(&mut tris, 0.0, 0.0, 0.0, 24.0, 24.0, 12.0);
    add_box(&mut tris, 24.0, 4.0, 12.0, 48.0, 20.0, 16.0);
    Mesh { triangles: tris }
}

fn slice(mesh: &Mesh, blend: &BlendMode, settings: &SliceSettings) -> SliceResponse {
    slice_configured(mesh, blend, &PrinterProfile::default(), settings).unwrap()
}

// One test, because the kept slices are shared by the whole process.
#[test]
fn support_changes_reuse_the_part_and_match_a_fresh_slice() {
    let mesh = ledge();
    let blend = BlendMode::Weight { toughness: 0.7 };
    let grid = SliceSettings {
        supports: true,
        support_style: SupportStyle::Grid,
        baseline: false,
        ..SliceSettings::default()
    };
    let tree = SliceSettings {
        support_style: SupportStyle::Tree,
        support_angle: 35.0,
        tip_diameter: 1.0,
        ..grid.clone()
    };

    keep_object_slices(true);
    let first = slice(&mesh, &blend, &grid);
    let reused = slice(&mesh, &blend, &tree);
    let other_width = slice(
        &mesh,
        &blend,
        &SliceSettings {
            line_width: 0.5,
            ..tree.clone()
        },
    );
    let other_blend = slice(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &tree,
    );
    keep_object_slices(false);
    let fresh = slice(&mesh, &blend, &tree);

    assert!(
        !first.stages.object_reused,
        "the first slice plans the part"
    );
    assert!(
        reused.stages.object_reused,
        "a support-only change reuses the part"
    );
    assert!(
        !other_width.stages.object_reused,
        "a new line width plans the part again"
    );
    assert!(
        !other_blend.stages.object_reused,
        "a new blend plans the part again"
    );
    assert!(!fresh.stages.object_reused);
    assert_ne!(
        first.gcode, reused.gcode,
        "tree supports print differently from grid"
    );
    assert_eq!(
        reused.gcode, fresh.gcode,
        "a reused part prints exactly like a fresh one"
    );
    assert_eq!(reused.estimate.seconds, fresh.estimate.seconds);
}
