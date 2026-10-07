//! Flow scales filament length and, at 1, leaves a cartesian file alone.

use lime_slice_core::{
    slice_configured, slice_request, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings,
    StrategyId,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn box_mesh(size: f64, height: f64) -> Mesh {
    let (x, y, z) = (size, size, height);
    let faces = [
        [[0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0]],
        [[0.0, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0]],
        [[0.0, 0.0, z], [x, y, z], [x, 0.0, z]],
        [[0.0, 0.0, z], [0.0, y, z], [x, y, z]],
        [[0.0, 0.0, 0.0], [x, 0.0, z], [x, 0.0, 0.0]],
        [[0.0, 0.0, 0.0], [0.0, 0.0, z], [x, 0.0, z]],
        [[0.0, y, 0.0], [x, y, 0.0], [x, y, z]],
        [[0.0, y, 0.0], [x, y, z], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, 0.0], [0.0, y, z]],
        [[0.0, 0.0, 0.0], [0.0, y, z], [0.0, 0.0, z]],
        [[x, 0.0, 0.0], [x, y, z], [x, y, 0.0]],
        [[x, 0.0, 0.0], [x, 0.0, z], [x, y, z]],
    ];
    Mesh {
        triangles: faces.to_vec(),
    }
}

fn settings(flow: f64) -> SliceSettings {
    SliceSettings {
        layer_height: 0.2,
        line_width: 0.45,
        baseline: false,
        compare: false,
        include_preview: false,
        flow,
        ..SliceSettings::default()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn flow_one_keeps_the_cartesian_file_and_a_higher_flow_lengthens_e() {
    let mesh = box_mesh(8.0, 1.6);
    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let profile = PrinterProfile::default();
    let plain = slice_configured(&mesh, &blend, &profile, &settings(1.0)).unwrap();
    let hash = hex(&Sha256::digest(plain.gcode.as_bytes()));
    assert_eq!(
        hash,
        "e5698089d6650acea79cceb231348a8bbc4f198c6cf5da6dcb4fd8daf3676054"
    );
    assert!(!plain.gcode.contains("; flow"));
    let raised = slice_configured(&mesh, &blend, &profile, &settings(1.2)).unwrap();
    assert!(raised.gcode.contains("; flow 1.200"));
    assert!(raised.sanity.final_e > plain.sanity.final_e * 1.15);
    assert_ne!(raised.gcode, plain.gcode);
}

#[test]
fn an_omitted_flow_serializes_as_absent_and_a_plate_refuses_it_per_object() {
    let req: SliceRequest = serde_json::from_str(r#"{"filename":"a.stl"}"#).unwrap();
    assert!((req.flow - 1.0).abs() < 1e-12);
    let value = serde_json::to_value(&req).unwrap();
    assert!(value.get("flow").is_none());

    let err = slice_request(
        &serde_json::from_value(json!({
            "objects": [{
                "id": "a",
                "filename": "a.stl",
                "dataB64": "",
                "settings": { "flow": 1.1 }
            }]
        }))
        .unwrap(),
        lime_slice_core::Job::start(),
    )
    .unwrap_err();
    assert_eq!(err, "objects[0].settings.flow is a plate setting");
}
