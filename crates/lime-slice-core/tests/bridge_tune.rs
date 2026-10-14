use lime_slice_core::{
    slice_configured, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId,
};

fn face(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> [[[f64; 3]; 3]; 2] {
    [[a, b, c], [a, c, d]]
}

fn add_box(tris: &mut Vec<[[f64; 3]; 3]>, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) {
    let p = |x, y, z| [x, y, z];
    let corners = [
        p(x0, y0, z0),
        p(x1, y0, z0),
        p(x1, y1, z0),
        p(x0, y1, z0),
        p(x0, y0, z1),
        p(x1, y0, z1),
        p(x1, y1, z1),
        p(x0, y1, z1),
    ];
    let quads = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ];
    for (a, b, c, d) in quads {
        tris.extend(face(corners[a], corners[b], corners[c], corners[d]));
    }
}

/// Two towers and a 14 mm deck, the same span `samples/bridge_span.stl` describes.
fn bridge_span() -> Mesh {
    let mut triangles = Vec::new();
    add_box(&mut triangles, 0.0, 0.0, 0.0, 8.0, 16.0, 8.0);
    add_box(&mut triangles, 22.0, 0.0, 0.0, 30.0, 16.0, 8.0);
    add_box(&mut triangles, 0.0, 4.0, 8.0, 30.0, 12.0, 10.0);
    Mesh { triangles }
}

fn gcode(extra: SliceSettings) -> String {
    slice_configured(
        &bridge_span(),
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &PrinterProfile::default(),
        &SliceSettings {
            include_preview: false,
            supports: false,
            ..extra
        },
    )
    .expect("slice")
    .gcode
}

#[test]
fn omitted_bridge_tune_stays_off_the_request() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2}"#).unwrap();
    assert!(req.bridge_flow_ratio.is_none());
    assert!(req.bridge_speed_mm_s.is_none());
    assert!(req.bridge_fan_percent.is_none());
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("bridgeFlow"), "{text}");
    assert!(!text.contains("bridgeSpeed"), "{text}");
    assert!(!text.contains("bridgeFan"), "{text}");

    let set = SliceSettings::from_request(&req);
    assert!(set.bridge_flow_ratio.is_none());
    assert!(set.bridge_speed_mm_s.is_none());
    assert!(set.bridge_fan_percent.is_none());

    let asked: SliceRequest = serde_json::from_str(
        r#"{"bridgeFlowRatio":0.9,"bridgeSpeedMmS":15,"bridgeFanPercent":80}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&asked);
    assert_eq!(set.bridge_flow_ratio, Some(0.9));
    assert_eq!(set.bridge_speed_mm_s, Some(15.0));
    assert_eq!(set.bridge_fan_percent, Some(80));

    let identity: SliceRequest =
        serde_json::from_str(r#"{"bridgeFlowRatio":1,"bridgeSpeedMmS":0,"bridgeFanPercent":0}"#)
            .unwrap();
    let set = SliceSettings::from_request(&identity);
    assert!(set.bridge_flow_ratio.is_none());
    assert!(set.bridge_speed_mm_s.is_none());
    assert!(set.bridge_fan_percent.is_none());

    let classic: SliceRequest = serde_json::from_str(
        r#"{"classic":true,"bridgeFlowRatio":0.9,"bridgeSpeedMmS":15,"bridgeFanPercent":80}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&classic);
    assert!(set.bridge_flow_ratio.is_none());
    assert!(set.bridge_speed_mm_s.is_none());
    assert!(set.bridge_fan_percent.is_none());
}

#[test]
fn a_set_bridge_changes_the_gcode_and_the_default_does_not() {
    let plain = gcode(SliceSettings::default());
    let named = gcode(SliceSettings {
        bridge_flow_ratio: None,
        bridge_speed_mm_s: None,
        bridge_fan_percent: None,
        ..SliceSettings::default()
    });
    assert_eq!(plain, named);
    assert!(plain.contains("TYPE:BRIDGE"));
    assert!(!plain.contains("M106 S204"), "{plain}");
    assert!(!plain.contains(" F900"), "default bridge is not 15 mm/s");

    let flow = gcode(SliceSettings {
        bridge_flow_ratio: Some(0.9),
        ..SliceSettings::default()
    });
    assert_ne!(plain, flow);
    assert!(flow.contains("TYPE:BRIDGE"));

    let fan = gcode(SliceSettings {
        bridge_fan_percent: Some(80),
        ..SliceSettings::default()
    });
    assert!(fan.contains("M106 S204"));
    assert!(fan.contains("M106 S255"), "the layer fan comes back after the bridge");
    assert_ne!(plain, fan);

    let speed = gcode(SliceSettings {
        bridge_speed_mm_s: Some(15.0),
        ..SliceSettings::default()
    });
    assert!(speed.contains(" F900"), "15 mm/s is below the 18 mm/s clamp");
    assert_ne!(plain, speed);
}
