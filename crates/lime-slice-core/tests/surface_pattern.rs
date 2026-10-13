use lime_slice_core::{
    slice_configured, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId,
    SurfacePattern,
};

fn cube() -> Mesh {
    let face = |a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]| [[a, b, c], [a, c, d]];
    let z0 = 0.0;
    let z1 = 10.0;
    let p = |x, y, z| [x, y, z];
    let mut triangles = Vec::new();
    triangles.extend(face(p(0.0, 0.0, z0), p(20.0, 0.0, z0), p(20.0, 20.0, z0), p(0.0, 20.0, z0)));
    triangles.extend(face(p(0.0, 0.0, z1), p(0.0, 20.0, z1), p(20.0, 20.0, z1), p(20.0, 0.0, z1)));
    triangles.extend(face(p(0.0, 0.0, z0), p(0.0, 0.0, z1), p(20.0, 0.0, z1), p(20.0, 0.0, z0)));
    triangles.extend(face(p(20.0, 0.0, z0), p(20.0, 0.0, z1), p(20.0, 20.0, z1), p(20.0, 20.0, z0)));
    triangles.extend(face(p(20.0, 20.0, z0), p(20.0, 20.0, z1), p(0.0, 20.0, z1), p(0.0, 20.0, z0)));
    triangles.extend(face(p(0.0, 20.0, z0), p(0.0, 20.0, z1), p(0.0, 0.0, z1), p(0.0, 0.0, z0)));
    Mesh { triangles }
}

fn speed(settings: &SliceSettings) -> String {
    slice_configured(
        &cube(),
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &PrinterProfile::default(),
        settings,
    )
    .expect("slice")
    .gcode
}

#[test]
fn an_omitted_pattern_stays_rectilinear_and_off_the_request() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2}"#).unwrap();
    assert_eq!(req.top_surface_pattern, SurfacePattern::Rectilinear);
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("topSurfacePattern"), "{text}");
    let asked: SliceRequest =
        serde_json::from_str(r#"{"layerHeight":0.2,"topSurfacePattern":"monotonic"}"#).unwrap();
    assert_eq!(asked.top_surface_pattern, SurfacePattern::Monotonic);
}

#[test]
fn rectilinear_matches_the_default_and_monotonic_does_not() {
    let plain = speed(&SliceSettings::default());
    let named = speed(&SliceSettings {
        top_surface_pattern: SurfacePattern::Rectilinear,
        ..SliceSettings::default()
    });
    assert_eq!(plain, named);
    let mono = speed(&SliceSettings {
        top_surface_pattern: SurfacePattern::Monotonic,
        ..SliceSettings::default()
    });
    assert_ne!(plain, mono);
    let rings = speed(&SliceSettings {
        top_surface_pattern: SurfacePattern::Concentric,
        ..SliceSettings::default()
    });
    assert_ne!(plain, rings);
    assert_ne!(mono, rings);
}
