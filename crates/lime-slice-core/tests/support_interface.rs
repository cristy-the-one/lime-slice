use lime_slice_core::{
    slice_configured, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId,
    SupportStyle,
};

fn face(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> [[[f64; 3]; 3]; 2] {
    [[a, b, c], [a, c, d]]
}

fn quad(tris: &mut Vec<[[f64; 3]; 3]>, a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) {
    tris.extend(face(a, b, c, d));
}

/// A 16 mm body with an 10 mm ledge off +Y, so trees have to reach the bed.
fn ledge() -> Mesh {
    let p = |x, y, z| [x, y, z];
    let mut triangles = Vec::new();
    // Body, open on +Y above z 6 where the ledge joins it.
    quad(&mut triangles, p(0.0, 0.0, 0.0), p(16.0, 0.0, 0.0), p(16.0, 12.0, 0.0), p(0.0, 12.0, 0.0));
    quad(&mut triangles, p(0.0, 0.0, 10.0), p(0.0, 12.0, 10.0), p(16.0, 12.0, 10.0), p(16.0, 0.0, 10.0));
    quad(&mut triangles, p(0.0, 0.0, 0.0), p(0.0, 0.0, 10.0), p(16.0, 0.0, 10.0), p(16.0, 0.0, 0.0));
    quad(&mut triangles, p(0.0, 0.0, 0.0), p(0.0, 12.0, 0.0), p(0.0, 12.0, 10.0), p(0.0, 0.0, 10.0));
    quad(&mut triangles, p(16.0, 0.0, 0.0), p(16.0, 0.0, 10.0), p(16.0, 12.0, 10.0), p(16.0, 12.0, 0.0));
    quad(&mut triangles, p(0.0, 12.0, 0.0), p(16.0, 12.0, 0.0), p(16.0, 12.0, 6.0), p(0.0, 12.0, 6.0));
    // Ledge, open on -Y where it meets the body.
    quad(&mut triangles, p(0.0, 12.0, 6.0), p(16.0, 12.0, 6.0), p(16.0, 22.0, 6.0), p(0.0, 22.0, 6.0));
    quad(&mut triangles, p(0.0, 12.0, 10.0), p(0.0, 22.0, 10.0), p(16.0, 22.0, 10.0), p(16.0, 12.0, 10.0));
    quad(&mut triangles, p(0.0, 22.0, 6.0), p(0.0, 22.0, 10.0), p(16.0, 22.0, 10.0), p(16.0, 22.0, 6.0));
    quad(&mut triangles, p(0.0, 12.0, 6.0), p(0.0, 22.0, 6.0), p(0.0, 22.0, 10.0), p(0.0, 12.0, 10.0));
    quad(&mut triangles, p(16.0, 12.0, 6.0), p(16.0, 12.0, 10.0), p(16.0, 22.0, 10.0), p(16.0, 22.0, 6.0));
    Mesh { triangles }
}

fn tree(extra: SliceSettings) -> String {
    slice_configured(
        &ledge(),
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &PrinterProfile::default(),
        &extra,
    )
    .expect("slice")
    .gcode
}

fn trees() -> SliceSettings {
    SliceSettings {
        supports: true,
        support_style: SupportStyle::Tree,
        ..SliceSettings::default()
    }
}

#[test]
fn omitted_support_interface_stays_off_the_request() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2,"supports":true}"#).unwrap();
    assert!(req.support_z_gap_mm.is_none());
    assert!(req.support_xy_gap_mm.is_none());
    assert!(req.support_interface_layers.is_none());
    assert!(req.support_tree_brim_mm.is_none());
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("supportZGap"), "{text}");
    assert!(!text.contains("supportXyGap"), "{text}");
    assert!(!text.contains("supportInterface"), "{text}");
    assert!(!text.contains("supportTreeBrim"), "{text}");

    let set = SliceSettings::from_request(&req);
    assert!(set.support_z_gap_mm.is_none());
    assert!(set.support_xy_gap_mm.is_none());
    assert!(set.support_interface_layers.is_none());
    assert!(set.support_tree_brim_mm.is_none());

    let asked: SliceRequest = serde_json::from_str(
        r#"{"supportZGapMm":0.8,"supportXyGapMm":1.1,"supportInterfaceLayers":1,"supportTreeBrimMm":3}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&asked);
    assert_eq!(set.support_z_gap_mm, Some(0.8));
    assert_eq!(set.support_xy_gap_mm, Some(1.1));
    assert_eq!(set.support_interface_layers, Some(1));
    assert_eq!(set.support_tree_brim_mm, Some(3.0));

    let classic: SliceRequest = serde_json::from_str(
        r#"{"classic":true,"supportZGapMm":0.8,"supportTreeBrimMm":4,"supportInterfaceLayers":1}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&classic);
    assert!(set.support_z_gap_mm.is_none());
    assert!(set.support_interface_layers.is_none());
    assert!(set.support_tree_brim_mm.is_none());
}

#[test]
fn a_set_gap_and_a_tree_brim_change_the_gcode_and_the_default_does_not() {
    let plain = tree(trees());
    let named = tree(SliceSettings {
        support_z_gap_mm: None,
        support_xy_gap_mm: None,
        support_interface_layers: None,
        support_tree_brim_mm: None,
        ..trees()
    });
    assert_eq!(plain, named);
    let gap = tree(SliceSettings {
        support_z_gap_mm: Some(0.8),
        ..trees()
    });
    assert_ne!(plain, gap);
    let brim = tree(SliceSettings {
        support_tree_brim_mm: Some(3.0),
        ..trees()
    });
    assert_ne!(plain, brim);
    assert_ne!(gap, brim);
}

#[test]
fn a_real_zero_is_a_zero_and_no_interface_layers_print_one() {
    let asked: SliceRequest = serde_json::from_str(
        r#"{"supportZGapMm":0,"supportXyGapMm":0,"supportInterfaceLayers":0}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&asked);
    assert_eq!(set.support_z_gap_mm, Some(0.0));
    assert_eq!(set.support_xy_gap_mm, Some(0.0));
    assert_eq!(set.support_interface_layers, Some(1));

    let plain = tree(trees());
    let zero_z = tree(SliceSettings {
        support_z_gap_mm: Some(0.0),
        ..trees()
    });
    let zero_xy = tree(SliceSettings {
        support_xy_gap_mm: Some(0.0),
        ..trees()
    });
    assert_ne!(plain, zero_z);
    assert_ne!(plain, zero_xy);
    let layers = |n: u32| {
        let text = format!(r#"{{"supports":true,"supportStyle":"tree","supportInterfaceLayers":{n}}}"#);
        tree(SliceSettings::from_request(&serde_json::from_str::<SliceRequest>(&text).unwrap()))
    };
    assert_eq!(layers(1), layers(0));
    let all = tree(SliceSettings {
        support_z_gap_mm: Some(0.0),
        support_xy_gap_mm: Some(0.0),
        support_interface_layers: Some(1),
        ..trees()
    });
    assert!(all.contains("G1"), "a slice with every gap at zero still prints");
}
