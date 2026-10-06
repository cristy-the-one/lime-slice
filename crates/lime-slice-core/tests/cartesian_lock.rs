//! A slice with no belt field keeps the G-code it had before belt emit existed.
//! The hash is the whole file, so a formatting change in the cartesian writer fails here.

use lime_slice_core::{
    slice_configured, BlendMode, Mesh, PrinterProfile, SliceSettings, StrategyId,
};
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

#[test]
fn cartesian_gcode_hash_is_locked() {
    let mesh = box_mesh(8.0, 1.6);
    let response = slice_configured(
        &mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
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
    assert!(response.sanity.ok, "{:?}", response.sanity.notes);
    assert!(!response.gcode.contains("; belt:"));
    let hash = hex(&Sha256::digest(response.gcode.as_bytes()));
    // Captured from this box before the belt writer existed. A cartesian
    // request still takes that path, so the bytes do not move.
    assert_eq!(
        hash,
        "e724c75e5d27d72ed57c9a419b5646f5b0b4394a5b49ed9dd0833f1cc0638b9a"
    );
    let debug = format!("{:?}", SliceSettings::default());
    assert!(!debug.contains("belt"), "{debug}");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
