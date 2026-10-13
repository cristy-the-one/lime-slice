use lime_slice_core::{
    slice_configured, AdhesionType, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings,
    StrategyId,
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
fn an_omitted_adhesion_stays_a_skirt_and_is_left_off_the_request() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2}"#).unwrap();
    assert_eq!(req.adhesion, AdhesionType::Skirt);
    assert!(req.brim_width_mm.is_none());
    assert!(req.brim_gap_mm.is_none());
    assert!(req.skirt_loops.is_none());
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("adhesion"), "{text}");
    assert!(!text.contains("brim"), "{text}");
    assert!(!text.contains("skirtLoops"), "{text}");
}

#[test]
fn one_forced_skirt_loop_matches_the_speed_default() {
    let plain = speed(&SliceSettings::default());
    let forced = SliceSettings {
        skirt_loops: Some(1),
        ..SliceSettings::default()
    };
    assert_eq!(speed(&forced), plain);
}

#[test]
fn a_brim_and_mouse_ears_print_outside_the_part() {
    let plain = speed(&SliceSettings::default());
    let brim = SliceSettings {
        adhesion: AdhesionType::Brim,
        brim_width_mm: 5.0,
        brim_gap_mm: 0.1,
        ..SliceSettings::default()
    };
    let brim_gcode = speed(&brim);
    assert_ne!(brim_gcode, plain);
    assert!(
        brim_gcode.lines().any(|line| {
            let Some(rest) = line.strip_prefix("G1 ") else {
                return false;
            };
            rest.split_whitespace().any(|word| {
                word.strip_prefix("X")
                    .and_then(|n| n.parse::<f64>().ok())
                    .is_some_and(|x| !(-0.5..=20.5).contains(&x))
            })
        }),
        "brim should leave the 20 mm footprint"
    );

    let ears = SliceSettings {
        adhesion: AdhesionType::MouseEars,
        brim_width_mm: 5.0,
        brim_gap_mm: 0.1,
        ..SliceSettings::default()
    };
    let ear_gcode = speed(&ears);
    assert_ne!(ear_gcode, plain);
    assert!(
        ear_gcode.lines().any(|line| line.contains("X-") || line.contains("X21") || line.contains("X22")),
        "mouse ears should reach past a corner"
    );
}
