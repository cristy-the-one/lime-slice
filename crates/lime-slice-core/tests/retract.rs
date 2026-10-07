//! An omitted retract length keeps the strategy. A set length replaces it at emit.

use lime_slice_core::{slice_configured, slice_request, BlendMode, Mesh, PrinterProfile, SliceRequest, SliceSettings, StrategyId};
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Distances of E-only moves that pull filament back.
fn pull_mm(gcode: &str) -> Vec<f64> {
    let mut prev = 0.0;
    let mut out = Vec::new();
    for line in gcode.lines() {
        if !line.starts_with('G') {
            continue;
        }
        let Some(e) = line.split_whitespace().find_map(|tok| tok.strip_prefix('E')?.parse::<f64>().ok()) else {
            continue;
        };
        let delta = prev - e;
        let e_only = !line.contains(" X") && !line.contains(" Y") && !line.contains(" Z");
        if e_only && delta > 0.05 {
            out.push((delta * 1000.0).round() / 1000.0);
        }
        prev = e;
    }
    out
}

#[test]
fn omitted_retract_keeps_the_cartesian_file() {
    let mesh = box_mesh(8.0, 1.6);
    let response = slice_configured(
        &mesh,
        &BlendMode::Single { strategy: StrategyId::Speed },
        &PrinterProfile::default(),
        &SliceSettings {
            layer_height: 0.2,
            line_width: 0.45,
            baseline: false,
            compare: false,
            include_preview: false,
            ..SliceSettings::default()
        },
    )
    .unwrap();
    let hash = hex(&Sha256::digest(response.gcode.as_bytes()));
    assert_eq!(
        hash,
        "e5698089d6650acea79cceb231348a8bbc4f198c6cf5da6dcb4fd8daf3676054"
    );
    assert!(!response.gcode.contains("; retract"));
    let pulls = pull_mm(&response.gcode);
    assert!(pulls.iter().any(|n| (*n - 0.35).abs() < 1e-3), "{pulls:?}");
}

#[test]
fn a_set_length_replaces_the_strategy_and_a_set_speed_replaces_the_feed() {
    let mesh = box_mesh(8.0, 1.6);
    let blend = BlendMode::Single { strategy: StrategyId::Speed };
    let profile = PrinterProfile::default();
    let raised = slice_configured(
        &mesh,
        &blend,
        &profile,
        &SliceSettings {
            layer_height: 0.2,
            line_width: 0.45,
            baseline: false,
            compare: false,
            include_preview: false,
            retract_length: Some(2.0),
            retract_speed: Some(45.0),
            ..SliceSettings::default()
        },
    )
    .unwrap();
    assert!(raised.gcode.contains("; retract 2.000 mm at 45 mm/s"));
    let pulls = pull_mm(&raised.gcode);
    assert!(pulls.iter().any(|n| (*n - 2.0).abs() < 1e-3), "{pulls:?}");
    assert!(raised.gcode.contains("F2700"));
}

#[test]
fn omitted_retract_serializes_as_absent_and_a_plate_refuses_it_per_object() {
    let req: SliceRequest = serde_json::from_str(r#"{"filename":"a.stl"}"#).unwrap();
    assert!(req.retract_length.is_none());
    assert!(req.retract_speed.is_none());
    let value = serde_json::to_value(&req).unwrap();
    assert!(value.get("retractLength").is_none());
    assert!(value.get("retractSpeed").is_none());

    let err = slice_request(&serde_json::from_value(json!({
        "objects": [{
            "id": "a",
            "filename": "a.stl",
            "dataB64": "",
            "settings": { "retractLength": 1.0 }
        }]
    })).unwrap(), lime_slice_core::Job::start()).unwrap_err();
    assert!(err.contains("objects[0].settings.retractLength is a plate setting"), "{err}");
}

#[test]
fn a_set_length_retracts_only_where_the_strategy_retracts() {
    let mesh = box_mesh(20.0, 3.0);
    let blend = BlendMode::Single { strategy: StrategyId::Speed };
    let profile = PrinterProfile::default();
    let pulls = |retract_length: Option<f64>| {
        let response = slice_configured(
            &mesh,
            &blend,
            &profile,
            &SliceSettings {
                layer_height: 0.2,
                line_width: 0.45,
                baseline: false,
                compare: false,
                include_preview: false,
                retract_length,
                ..SliceSettings::default()
            },
        )
        .unwrap();
        pull_mm(&response.gcode)
    };
    let planned = pulls(None);
    let set = pulls(Some(2.0));
    assert_eq!(
        set.len(),
        planned.len(),
        "a travel that combs inside the part still does not retract"
    );
    // The last pull is the end of the print, a fixed 1 mm.
    let travels = &set[..set.len() - 1];
    assert!(travels.iter().all(|n| (*n - 2.0).abs() < 1e-3), "{set:?}");
}
