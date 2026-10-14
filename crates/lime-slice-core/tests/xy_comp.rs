use lime_slice_core::{
    slice_configured, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId,
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
fn omitted_compensation_stays_zero_and_off_the_request() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2}"#).unwrap();
    assert_eq!(req.xy_hole_compensation_mm, 0.0);
    assert_eq!(req.xy_contour_compensation_mm, 0.0);
    assert_eq!(req.elephants_foot_compensation_mm, 0.0);
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("xyHole"), "{text}");
    assert!(!text.contains("xyContour"), "{text}");
    assert!(!text.contains("elephantsFoot"), "{text}");
}

#[test]
fn zero_compensation_matches_the_default_and_an_offset_does_not() {
    let plain = speed(&SliceSettings::default());
    let named = speed(&SliceSettings {
        xy_hole_compensation_mm: 0.0,
        xy_contour_compensation_mm: 0.0,
        elephants_foot_compensation_mm: 0.0,
        ..SliceSettings::default()
    });
    assert_eq!(plain, named);
    let grown = speed(&SliceSettings {
        xy_contour_compensation_mm: 0.2,
        ..SliceSettings::default()
    });
    assert_ne!(plain, grown);
    let foot = speed(&SliceSettings {
        elephants_foot_compensation_mm: 0.2,
        ..SliceSettings::default()
    });
    assert_ne!(plain, foot);
    assert_ne!(grown, foot);
}
