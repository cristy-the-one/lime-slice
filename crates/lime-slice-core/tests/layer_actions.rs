use base64::Engine;
use lime_slice_core::{
    slice_configured, slice_request, BlendMode, Firmware, Job, LayerAction, LayerActionKind, Mesh,
    PrinterProfile, SliceRequest, SliceSettings, StrategyId,
};
use serde_json::json;

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

fn belt_request(actions: Vec<LayerAction>) -> SliceRequest {
    let mut stl = String::from("solid cube\n");
    for tri in cube().triangles {
        stl.push_str("facet normal 0 0 0\nouter loop\n");
        for v in tri {
            stl.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        stl.push_str("endloop\nendfacet\n");
    }
    stl.push_str("endsolid cube\n");
    let mut req: SliceRequest = serde_json::from_value(json!({
        "filename": "cube.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
        "belt": { "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 250.0, "copies": 1, "gapMm": 5.0 },
    }))
    .unwrap();
    req.printer = Some(PrinterProfile {
        firmware: Some(Firmware::Klipper),
        ..PrinterProfile::default()
    });
    req.layer_actions = actions;
    req
}

#[test]
fn a_belt_pause_follows_the_belt_move_of_its_layer() {
    let plain = slice_request(&belt_request(Vec::new()), Job::default()).unwrap();
    assert!(!plain.gcode.contains("PAUSE"));
    let layer = &plain.layers[plain.layers.len() / 2];

    let paused = slice_request(&belt_request(vec![pause(layer.z)]), Job::default()).unwrap();
    let lines: Vec<&str> = paused.gcode.lines().collect();
    let at: Vec<usize> = (0..lines.len()).filter(|&i| lines[i] == "PAUSE").collect();
    assert_eq!(at.len(), 1, "one pause");
    let header = lines[at[0] - 2];
    let z = header
        .strip_prefix(";LAYER:")
        .and_then(|rest| rest.split_whitespace().nth(1))
        .and_then(|field| field.strip_prefix("Z:"))
        .unwrap_or_else(|| panic!("a layer header two lines up: {header}"));
    assert_eq!(lines[at[0] - 1], format!("G1 Z{z} F7200"));
}
