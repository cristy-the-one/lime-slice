//! Pins the `lime_occt_tree` JSON text of open, apply, probe, and goto.
//!
//! The expected files are the raw replies from commit 512f6e0a (the pre-#853
//! order), captured through `lime_occt_tree` on that OS. Open CASCADE's mesh
//! differs per platform, the same way `mesh_angle` keeps separate Windows soup
//! hashes, so each `target_os` has its own directory. A map compare would hide
//! the `stepFaces` move, so the test matches the bytes.

use serde_json::Value;
use std::ffi::{CStr, CString};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

/// The four calls, in order, on one tree. Plate mesh at the coarsest chord so the pin stays the reply text.
const CALLS: &[(&str, &str)] = &[
    (
        "open",
        r#"{"call":"open","key":"json-pin","box":[10.0,8.0,6.0],"chordMm":2.0}"#,
    ),
    (
        "apply",
        r#"{"call":"apply","key":"json-pin","parent":0,"node":1,"chordMm":2.0,"op":{"kind":"fillet","edges":[0],"size":1.0}}"#,
    ),
    (
        "probe",
        r#"{"call":"probe","key":"json-pin","node":1,"preview":true,"chordMm":2.0,"op":{"kind":"hole","origin":[5.0,4.0,6.0],"axis":[0.0,0.0,-1.0],"radius":1.0,"depth":6.0,"through":true}}"#,
    ),
    (
        "goto",
        r#"{"call":"goto","key":"json-pin","node":1,"chordMm":2.0}"#,
    ),
];

fn call_tree(request: &str) -> String {
    let req = CString::new(request).unwrap();
    // SAFETY: `req` is a C string. The answer is freed with the function that goes with it.
    let answer = unsafe { lime_model_occt::lime_occt_tree(req.as_ptr()) };
    let reply = unsafe { CStr::from_ptr(answer) }
        .to_string_lossy()
        .into_owned();
    unsafe { lime_model_occt::lime_occt_string_free(answer) };
    reply
}

fn pinned(name: &str) -> String {
    let os = std::env::consts::OS;
    let path = format!(
        "{}/tests/fixtures/json_pin/{os}/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => panic!(
            "no JSON pin fixture for {os} ({name}). Expected {path}, the raw lime_occt_tree text of 512f6e0a on {os}. Open CASCADE's mesh is not the same bytes on every OS, so this check is not compared against another platform's fixture."
        ),
        Err(err) => panic!("pin {name} at {path}: {err}"),
    }
}

fn keys_of(text: &str) -> String {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    match value.as_object() {
        Some(map) => map.keys().cloned().collect::<Vec<_>>().join(","),
        None => "<not an object>".into(),
    }
}

fn nested_keys(text: &str, field: &str) -> String {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    value
        .get(field)
        .and_then(|child| child.as_object())
        .map(|map| map.keys().cloned().collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}

fn assert_bytes(name: &str, got: &str, expected: &str) {
    if got == expected {
        return;
    }
    let at = got
        .bytes()
        .zip(expected.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(got.len().min(expected.len()));
    let window = |text: &str| -> String {
        let start = at.saturating_sub(80);
        let end = (at + 80).min(text.len());
        text.get(start..end).unwrap_or("").to_string()
    };
    panic!(
        "{name}: lime_occt_tree JSON is not the 512f6e0a text\n\
         got {got_len} bytes, expected {exp_len} bytes, first difference at byte {at}\n\
         got keys: {got_keys}\n\
         expected keys: {exp_keys}\n\
         got preview keys: {got_preview}\n\
         expected preview keys: {exp_preview}\n\
         got around: {got_window}\n\
         expected around: {exp_window}",
        got_len = got.len(),
        exp_len = expected.len(),
        got_keys = keys_of(got),
        exp_keys = keys_of(expected),
        got_preview = nested_keys(got, "preview"),
        exp_preview = nested_keys(expected, "preview"),
        got_window = window(got),
        exp_window = window(expected),
    );
}

#[test]
fn open_apply_probe_and_goto_json_matches_the_pre_binary_ipc_bytes() {
    let open = call_tree(CALLS[0].1);
    if open.contains("OCCT_ROOT") {
        assert!(
            !require(),
            "LIME_REQUIRE_OCCT is set but the kernel is not linked"
        );
        return;
    }
    for (name, request) in CALLS {
        let got = if *name == "open" {
            open.clone()
        } else {
            call_tree(request)
        };
        assert!(
            serde_json::from_str::<Value>(&got)
                .ok()
                .is_some_and(|v| v.get("error").is_none()),
            "{name} failed: {got}"
        );
        assert_bytes(name, &got, &pinned(name));
    }
}
