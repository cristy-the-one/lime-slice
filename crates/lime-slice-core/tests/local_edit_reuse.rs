//! An edit to the mesh that reaches only some layers, like a Model hole,
//! plans again only those layers. A layer the edit does not reach keeps its
//! toolpaths, tour and travels, and the G-code is the one a slice of the
//! edited mesh with nothing kept makes. A layer is reached when its outline,
//! skins, roof distance or interior run changes; the last two are a whole
//! layer's, so an edit can reach layers below or above its own band.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

/// A box's twelve triangles, outward.
fn cuboid(min: [f32; 3], max: [f32; 3]) -> Vec<[[f32; 3]; 3]> {
    let p = |x: usize, y: usize, z: usize| {
        [
            if x == 0 { min[0] } else { max[0] },
            if y == 0 { min[1] } else { max[1] },
            if z == 0 { min[2] } else { max[2] },
        ]
    };
    let quads = [
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
        [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
        [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
        [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
    ];
    quads
        .iter()
        .flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]])
        .collect()
}

fn stl(triangles: &[[[f32; 3]; 3]]) -> String {
    let mut bytes = vec![0u8; 80];
    bytes.extend((triangles.len() as u32).to_le_bytes());
    for t in triangles {
        bytes.extend([0u8; 12]);
        for v in t {
            for c in v {
                bytes.extend(c.to_le_bytes());
            }
        }
        bytes.extend([0u8; 2]);
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A 20 mm block and, beside it, a 12 mm post, and with `stub` a 4 mm stub
/// beside the post: adding it reaches nothing above the post's top.
fn body(stub: bool) -> String {
    let mut mesh = cuboid([0.0, 0.0, 0.0], [20.0, 20.0, 20.0]);
    mesh.extend(cuboid([26.0, 6.0, 0.0], [32.0, 14.0, 12.0]));
    if stub {
        mesh.extend(cuboid([26.0, 16.0, 0.0], [32.0, 20.0, 4.0]));
    }
    json!({
        "filename": "edit.stl",
        "dataB64": stl(&mesh),
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
    })
    .to_string()
}

fn slice(body: &str) -> Value {
    serde_json::from_str(&slice_payload(body, None, Job::start(), |_| String::new()).unwrap()).unwrap()
}

#[test]
fn a_local_mesh_edit_replans_only_the_layers_it_reaches() {
    keep_support_bases(false);
    let fresh = slice(&body(true));

    keep_support_bases(true);
    slice(&body(false));
    let edited = slice(&body(true));
    keep_support_bases(false);

    assert_eq!(edited["gcode"], fresh["gcode"], "reused layers changed the G-code");
    let stages = &edited["stages"];
    let layers = edited["layers"].as_array().unwrap();
    // Under the post's top the stub shortens the interior run of every layer.
    // Over it, only the block prints, as it did before the edit.
    let untouched = layers
        .iter()
        .filter(|l| l["z"].as_f64().unwrap() > 12.1)
        .count() as u64;
    assert!(untouched > 30);
    for stage in ["toolpathLayersReused", "orderLayersReused", "combLayersReused"] {
        let reused = stages[stage].as_u64().unwrap();
        assert!(reused >= untouched, "{stage}: {reused} of {untouched} untouched layers");
        assert!(reused < layers.len() as u64, "{stage}: the edited band was reused too");
    }
}
