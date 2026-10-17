//! Run with LIME_REQUIRE_OCCT=1 and LIME_OCCT_BRIDGE pointing at the built bridge.
use lime_slice_core::load_mesh;

#[test]
fn closed_splines_and_trims_match_the_occt_solid() {
    let Some((mesher, identity)) = lime_model_load::step_mesher() else {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT STEP bridge is required"
        );
        eprintln!("skipping OCCT STEP regression: bridge unavailable");
        return;
    };
    lime_slice_core::set_step_mesher(mesher, identity);
    let opened: serde_json::Value = serde_json::from_str(
        &lime_model_load::tree(r#"{"call":"open","key":"keep-during-import","box":[10,10,10]}"#)
            .unwrap(),
    )
    .unwrap();
    assert!(opened.get("error").is_none());
    let bytes = include_bytes!("../../lime-slice-core/tests/fixtures/duck-plate.step");
    let mesh = load_mesh("duck-plate.step", bytes).unwrap();
    let mut volume = 0.0;
    let mut area = 0.0;
    for [a, b, c] in &mesh.triangles {
        let ab = [0, 1, 2].map(|i| b[i] - a[i]);
        let ac = [0, 1, 2].map(|i| c[i] - a[i]);
        let cross = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        area += cross.iter().map(|x| x * x).sum::<f64>().sqrt() / 2.0;
        volume += a.iter().zip(cross).map(|(a, n)| a * n).sum::<f64>() / 6.0;
    }
    println!(
        "{} triangles, volume {volume} mm³, area {area} mm², bounds {:?}",
        mesh.triangle_count(),
        mesh.bounds()
    );
    assert!(
        (volume - 32645.87).abs() / 32645.87 < 0.005,
        "volume {volume}"
    );
    assert!((area - 6100.4).abs() / 6100.4 < 0.005, "area {area}");
    assert_eq!(
        load_mesh("duck.step", bytes).unwrap().triangles,
        mesh.triangles
    );
    let fine = lime_slice_core::load_slice_mesh_tol("duck.step", bytes, true, 0.01).unwrap();
    let coarse = lime_slice_core::load_slice_mesh_tol("duck.step", bytes, true, 1.0).unwrap();
    assert!(fine.triangle_count() > coarse.triangle_count());
    let (min, max) = mesh.bounds().unwrap();
    for (axis, expected) in [57.09, 37.04, 51.0].into_iter().enumerate() {
        assert!((max[axis] - min[axis] - expected).abs() < 0.15);
    }
    let preview = lime_slice_core::mesh_preview("duck.STP", bytes).unwrap();
    assert_eq!(preview.triangles, mesh.triangle_count());
    assert_eq!(preview.min, min);
    assert_eq!(preview.max, max);
    for (got, want) in preview
        .positions
        .iter()
        .zip(mesh.triangles.iter().flatten().flatten())
    {
        assert_eq!(*got, *want as f32);
    }
    // Poses use the file frame, while previews seat on the bed exactly once.
    let raw = lime_slice_core::load_slice_mesh_tol("duck.step", bytes, true, 0.0).unwrap();
    assert!((raw.bounds().unwrap().0[2] - preview.seat_mm).abs() < 1e-6);
    assert!(load_mesh("bad.step", b"not STEP").is_err());
    assert!(lime_slice_core::load_slice_mesh_tol("duck.step", bytes, true, f64::NAN).is_err());
    // Unit conversion and assembly instance placement go through the same backend.
    for (name, expected_volume, expected_max) in [
        ("inch_cube.step", 25.4_f64.powi(3), [25.4; 3]),
        ("assembly.step", 2000.0, [40.0, 10.0, 10.0]),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../lime-slice-core/tests/fixtures")
            .join(name);
        let part = load_mesh(name, &std::fs::read(path).unwrap()).unwrap();
        let vol: f64 = part
            .triangles
            .iter()
            .map(|[a, b, c]| {
                (a[0] * (b[1] * c[2] - b[2] * c[1])
                    + a[1] * (b[2] * c[0] - b[0] * c[2])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum();
        assert!((vol - expected_volume).abs() < 0.01, "{name}: {vol}");
        let (_, hi) = part.bounds().unwrap();
        for i in 0..3 {
            assert!((hi[i] - expected_max[i]).abs() < 1e-4, "{name}: {hi:?}");
        }
    }
    let assembly = include_str!("../../lime-slice-core/tests/fixtures/assembly.step").replace("\r\n", "\n");
    let rotated = assembly.replace(
        "#143=AXIS2_PLACEMENT_3D('',#140,#130,#131);",
        "#143=AXIS2_PLACEMENT_3D('',#140,#130,#155);\n#155=DIRECTION('',(0.,1.,0.));",
    );
    let rotated = load_mesh("rotated.step", rotated.as_bytes()).unwrap();
    assert_eq!(rotated.bounds().unwrap(), ([0.0; 3], [30.0, 10.0, 10.0]));
    let nested = assembly.replace("ENDSEC;\nEND-ISO-10303-21;", "#155=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#141),#128);\n#156=(REPRESENTATION_RELATIONSHIP('','',#144,#155) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#153) SHAPE_REPRESENTATION_RELATIONSHIP());\nENDSEC;\nEND-ISO-10303-21;");
    let nested = load_mesh("nested.step", nested.as_bytes()).unwrap();
    assert_eq!(
        nested.bounds().unwrap(),
        ([30.0, 0.0, 0.0], [70.0, 10.0, 10.0])
    );
    let kept: serde_json::Value = serde_json::from_str(
        &lime_model_load::tree(r#"{"call":"goto","key":"keep-during-import","node":0}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(kept["fingerprint"], opened["fingerprint"]);
    lime_model_load::tree(r#"{"call":"close","key":"keep-during-import"}"#).unwrap();
}
