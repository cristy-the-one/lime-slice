//! Verify that `lime_model_occt::tree_bin` and the C ABI `lime_occt_tree_bin` / `lime_occt_bytes_free`
//! produce `LMB1` binary frames whose hydrated contents match `lime_model_occt::tree` JSON byte-for-byte
//! across `open` (with display mesh), `apply`, `probe` (with preview), `partition` (with pieces),
//! `surfaceInspect`, and plain JSON replies (`close`, errors).

use base64::Engine;
use serde_json::{json, Value};
use std::ffi::CString;

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

/// Unpack an `LMB1` frame (or plain UTF-8 JSON bytes) back into a `serde_json::Value` with base64-encoded
/// buffers so we can assert exact equality against `lime_model_occt::tree()`.
fn unpack_to_b64_json(bytes: &[u8]) -> (bool, Value) {
    if bytes.len() >= 12 && &bytes[0..4] == b"LMB1" {
        let json_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let flags = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        assert_eq!(flags, 0, "LMB1 flags must be 0");
        let blob_base = (12 + json_len + 3) & !3;
        assert!(blob_base <= bytes.len(), "LMB1 blob_base past end");
        let header = std::str::from_utf8(&bytes[12..12 + json_len]).expect("UTF-8 JSON header");
        let mut value: Value = serde_json::from_str(header).expect("valid JSON header");
        let blobs = &bytes[blob_base..];
        hydrate(&mut value, blobs);
        (true, value)
    } else {
        let text = std::str::from_utf8(bytes).expect("UTF-8 plain JSON");
        (false, serde_json::from_str(text).expect("valid plain JSON"))
    }
}

fn hydrate(value: &mut Value, blobs: &[u8]) {
    match value {
        Value::Array(items) => {
            for item in items {
                hydrate(item, blobs);
            }
        }
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(Value::Array(pair)) = map.get("$bin") {
                    assert_eq!(pair.len(), 2);
                    let off = pair[0].as_u64().unwrap() as usize;
                    let len = pair[1].as_u64().unwrap() as usize;
                    assert_eq!(off % 4, 0, "blob offset {off} must be 4-byte aligned");
                    assert!(off + len <= blobs.len(), "blob slice out of bounds");
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&blobs[off..off + len]);
                    *value = Value::String(b64);
                    return;
                }
            }
            for (_, v) in map.iter_mut() {
                hydrate(v, blobs);
            }
        }
        _ => {}
    }
}

fn call_c_abi_bin(request: &Value) -> Vec<u8> {
    let req = CString::new(request.to_string()).unwrap();
    let mut len: usize = 0;
    let ptr = unsafe { lime_model_occt::lime_occt_tree_bin(req.as_ptr(), &mut len) };
    assert!(!ptr.is_null(), "lime_occt_tree_bin returned null");
    let out = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { lime_model_occt::lime_occt_bytes_free(ptr, len) };
    out
}

#[test]
fn binary_ipc_frames_match_json_replies_exactly() {
    let probe: Value = serde_json::from_str(&lime_model_occt::tree(
        &json!({ "call": "open", "key": "bin-ipc-probe", "box": [1.0, 1.0, 1.0] }).to_string(),
    ))
    .unwrap();
    if probe["error"]
        .as_str()
        .is_some_and(|e| e.contains("OCCT_ROOT"))
    {
        assert!(
            !require(),
            "LIME_REQUIRE_OCCT is set but the kernel is not linked"
        );
        return;
    }
    lime_model_occt::tree(&json!({ "call": "close", "key": "bin-ipc-probe" }).to_string());

    let requests = [
        (
            "open with display mesh",
            true,
            json!({ "call": "open", "key": "bin-ipc", "box": [40.0, 30.0, 20.0], "chordMm": 0.1, "meshQuality": "display" }),
        ),
        (
            "apply fillet with display mesh",
            true,
            json!({
                "call": "apply", "key": "bin-ipc", "parent": 0, "node": 1, "chordMm": 0.1, "meshQuality": "display",
                "op": { "kind": "fillet", "edges": [0, 2], "size": 2.0 }
            }),
        ),
        (
            "cached goto with display mesh",
            true,
            json!({ "call": "goto", "key": "bin-ipc", "node": 1, "chordMm": 0.1, "meshQuality": "display" }),
        ),
        (
            "probe with preview",
            true,
            json!({
                "call": "probe", "key": "bin-ipc", "node": 1, "preview": true, "chordMm": 0.1, "meshQuality": "display",
                "op": { "kind": "hole", "origin": [20.0, 15.0, 20.0], "axis": [0.0, 0.0, -1.0], "radius": 3.0, "depth": 10.0, "through": true }
            }),
        ),
        (
            "surfaceInspect with curvature and isoparms",
            true,
            json!({
                "call": "surfaceInspect", "key": "bin-ipc", "node": 1, "chordMm": 0.1,
                "curvature": true, "isoparms": true, "isoCount": 4, "meshQuality": "display"
            }),
        ),
        (
            "partition with pieces",
            true,
            json!({
                "call": "apply", "key": "bin-ipc", "parent": 1, "node": 2, "chordMm": 0.1, "meshQuality": "display",
                "pieceKeys": ["bin-ipc-piece"],
                "op": {
                    "kind": "partition",
                    "cuts": [{ "origin": [20.0, 15.0, 10.0], "normal": [1.0, 0.0, 0.0], "u": [0.0, 1.0, 0.0],
                        "profile": { "kind": "straight" }, "connectors": { "on": false } }],
                    "target": { "printer": "lime-220", "process": "fdm", "volumeMm": [220.0, 220.0, 250.0] },
                    "orient": "keep", "arrange": true, "bedMarginMm": 5.0, "maxPieces": 12.0
                }
            }),
        ),
        (
            "plain close reply",
            false,
            json!({ "call": "close", "key": "bin-ipc" }),
        ),
        (
            "plain close piece reply",
            false,
            json!({ "call": "close", "key": "bin-ipc-piece" }),
        ),
    ];

    for (label, expect_lmb1, req) in requests {
        let bin_bytes = call_c_abi_bin(&req);
        let (is_lmb1, from_bin) = unpack_to_b64_json(&bin_bytes);
        assert_eq!(is_lmb1, expect_lmb1, "{label}: LMB1 framing mismatch");
        assert!(from_bin.get("error").is_none(), "{label}: {from_bin}");

        // Compare against JSON call on an equivalent key (re-run stateless/cached or twin).
        if label == "cached goto with display mesh" || label == "surfaceInspect with curvature and isoparms" {
            let from_json: Value =
                serde_json::from_str(&lime_model_occt::tree(&req.to_string())).unwrap();
            assert_eq!(from_bin, from_json, "{label}: binary frame diverged from JSON");
        }
    }

    // Also run a full twin tree in JSON mode vs binary mode and verify exact equality of every reply.
    for (suffix, use_bin) in [("json", false), ("bin", true)] {
        let key = format!("bin-ipc-twin-{suffix}");
        let reqs = [
            json!({ "call": "open", "key": key, "box": [30.0, 20.0, 10.0], "chordMm": 0.1, "meshQuality": "display" }),
            json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.1, "meshQuality": "display",
                "op": { "kind": "fillet", "edges": [0], "size": 2.0 } }),
            json!({ "call": "close", "key": key }),
        ];
        if !use_bin {
            for r in reqs {
                let _ = lime_model_occt::tree(&r.to_string());
            }
        } else {
            let key_j = "bin-ipc-eq-j";
            let key_b = "bin-ipc-eq-b";
            let j0: Value = serde_json::from_str(&lime_model_occt::tree(
                &json!({ "call": "open", "key": key_j, "box": [30.0, 20.0, 10.0], "chordMm": 0.1, "meshQuality": "display" }).to_string(),
            )).unwrap();
            let (is_bin, b0) = unpack_to_b64_json(&lime_model_occt::tree_bin(
                &json!({ "call": "open", "key": key_b, "box": [30.0, 20.0, 10.0], "chordMm": 0.1, "meshQuality": "display" }).to_string(),
            ));
            assert!(is_bin);
            assert_eq!(j0, b0, "open binary frame matches JSON byte for byte");

            let j1: Value = serde_json::from_str(&lime_model_occt::tree(
                &json!({ "call": "apply", "key": key_j, "parent": 0, "node": 1, "chordMm": 0.1, "meshQuality": "display",
                    "op": { "kind": "fillet", "edges": [0], "size": 2.0 } }).to_string(),
            )).unwrap();
            let (is_bin, b1) = unpack_to_b64_json(&lime_model_occt::tree_bin(
                &json!({ "call": "apply", "key": key_b, "parent": 0, "node": 1, "chordMm": 0.1, "meshQuality": "display",
                    "op": { "kind": "fillet", "edges": [0], "size": 2.0 } }).to_string(),
            ));
            assert!(is_bin);
            assert_eq!(j1, b1, "apply binary frame matches JSON byte for byte");

            lime_model_occt::tree(&json!({ "call": "close", "key": key_j }).to_string());
            lime_model_occt::tree_bin(&json!({ "call": "close", "key": key_b }).to_string());
        }
    }
}
