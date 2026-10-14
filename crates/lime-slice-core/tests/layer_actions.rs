use lime_slice_core::{
    slice_configured, BlendMode, Firmware, LayerAction, LayerActionKind, Mesh, PrinterProfile,
    SliceRequest, SliceSettings, StrategyId,
};

fn face(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> [[[f64; 3]; 3]; 2] {
    [[a, b, c], [a, c, d]]
}

fn cube() -> Mesh {
    let p = |x, y, z| [x, y, z];
    let mut triangles = Vec::new();
    let corners = [
        p(0.0, 0.0, 0.0),
        p(10.0, 0.0, 0.0),
        p(10.0, 10.0, 0.0),
        p(0.0, 10.0, 0.0),
        p(0.0, 0.0, 2.0),
        p(10.0, 0.0, 2.0),
        p(10.0, 10.0, 2.0),
        p(0.0, 10.0, 2.0),
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
        triangles.extend(face(corners[a], corners[b], corners[c], corners[d]));
    }
    Mesh { triangles }
}

fn pause(z: f64) -> LayerAction {
    LayerAction {
        z_mm: z,
        kind: LayerActionKind::Pause,
        note: None,
        gcode: None,
    }
}

fn gcode(extra: SliceSettings, firmware: Option<Firmware>) -> String {
    let profile = PrinterProfile {
        firmware,
        ..PrinterProfile::default()
    };
    slice_configured(
        &cube(),
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        &profile,
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
fn an_empty_action_list_stays_off_the_request_and_the_gcode() {
    let req: SliceRequest = serde_json::from_str(r#"{"layerHeight":0.2}"#).unwrap();
    assert!(req.layer_actions.is_empty());
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("layerActions"), "{text}");
    let set = SliceSettings::from_request(&req);
    assert!(set.layer_actions.is_empty());

    let plain = gcode(SliceSettings::default(), None);
    let named = gcode(
        SliceSettings {
            layer_actions: Vec::new(),
            ..SliceSettings::default()
        },
        None,
    );
    assert_eq!(plain, named);
    assert!(!plain.contains("M601"));
    assert!(!plain.contains("M600"));
    assert!(!plain.contains("PAUSE"));
}

#[test]
fn a_pause_and_a_filament_change_follow_the_firmware() {
    let at = SliceSettings {
        layer_actions: vec![
            LayerAction {
                z_mm: 1.0,
                kind: LayerActionKind::Pause,
                note: Some("embed nut".into()),
                gcode: None,
            },
            LayerAction {
                z_mm: 1.6,
                kind: LayerActionKind::FilamentChange,
                note: None,
                gcode: None,
            },
        ],
        ..SliceSettings::default()
    };
    let marlin = gcode(at.clone(), None);
    assert!(marlin.contains("; embed nut\nM601\n"), "{marlin}");
    assert!(marlin.contains("M600\n"));
    assert!(!marlin.contains("PAUSE"));
    let pause_at = marlin.find("M601").unwrap();
    let header = marlin[..pause_at].rfind(";LAYER:").expect("layer header");
    assert!(
        marlin[header..pause_at].contains("Z:1.000"),
        "the pause sits on the 1 mm layer"
    );

    let klipper = gcode(at.clone(), Some(Firmware::Klipper));
    assert!(klipper.contains("PAUSE\n"));
    assert!(klipper.contains("M600\n"));
    assert!(!klipper.contains("M601"));

    let bambu = gcode(at, Some(Firmware::Bambu));
    assert!(bambu.contains("M400 U1\n"));
    assert!(!bambu.contains("M601"));
    assert!(!bambu.contains("PAUSE"));
}

#[test]
fn custom_gcode_is_emitted_and_a_blank_line_is_dropped() {
    let asked: SliceRequest = serde_json::from_str(
        r#"{"layerActions":[{"zMm":0.4,"kind":"customGcode","gcode":"M117 hi","note":"sign"},{"zMm":0.6,"kind":"customGcode","gcode":"  "}]}"#,
    )
    .unwrap();
    let set = SliceSettings::from_request(&asked);
    assert_eq!(set.layer_actions.len(), 1);
    assert_eq!(set.layer_actions[0].gcode.as_deref(), Some("M117 hi"));
    let text = gcode(set, Some(Firmware::Rrf));
    assert!(text.contains("; sign\nM117 hi\n"), "{text}");
}

#[test]
fn a_pause_json_round_trips_and_classic_keeps_it() {
    let asked: SliceRequest =
        serde_json::from_str(r#"{"classic":true,"layerActions":[{"zMm":0.8,"kind":"pause"}]}"#)
            .unwrap();
    let set = SliceSettings::from_request(&asked);
    assert_eq!(set.layer_actions, vec![pause(0.8)]);
    let text = serde_json::to_string(&SliceRequest {
        layer_actions: vec![pause(0.8)],
        ..serde_json::from_str("{}").unwrap()
    })
    .unwrap();
    assert!(text.contains("\"layerActions\""), "{text}");
}
