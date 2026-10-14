//! The desktop shell on Linux runs GTK, which sets the C locale from the environment, and the bridge
//! runs in that process. A locale with a decimal comma must not reach the reply's JSON numbers.
//! Its own test binary, since the locale is process-wide.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

use serde_json::{json, Value};

extern "C" {
    fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char;
}

#[cfg(target_os = "linux")]
const LC_NUMERIC: c_int = 1;
#[cfg(not(target_os = "linux"))]
const LC_NUMERIC: c_int = 4;

/// The first decimal-comma locale this machine has, set for numbers.
fn comma_locale() -> Option<&'static str> {
    [
        "de_DE.UTF-8",
        "de_DE.utf8",
        "de-DE",
        "German_Germany.1252",
        "fr_FR.UTF-8",
        "ro_RO.UTF-8",
    ]
    .into_iter()
    .find(|name| {
        let name = CString::new(*name).expect("locale name");
        !unsafe { setlocale(LC_NUMERIC, name.as_ptr()) }.is_null()
    })
}

#[test]
fn a_decimal_comma_locale_leaves_the_reply_json() {
    let probe = lime_model_occt::tree(
        &json!({ "call": "open", "key": "probe", "box": [1.0, 1.0, 1.0] }).to_string(),
    );
    if probe.contains("\"error\"") {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required: {probe}"
        );
        return;
    }
    let Some(name) = comma_locale() else {
        eprintln!("no decimal-comma locale is installed; skipped");
        return;
    };
    let current = unsafe { CStr::from_ptr(setlocale(LC_NUMERIC, std::ptr::null())) };
    assert_eq!(current.to_str().ok(), Some(name));
    let text = lime_model_occt::tree(
        &json!({ "call": "open", "key": "comma", "box": [10.5, 20.0, 30.0] }).to_string(),
    );
    let reply: Value = serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{name}: not JSON ({err}): {}", &text[..text.len().min(300)]));
    let volume = reply["volumeMm3"].as_f64().expect("volumeMm3");
    assert!((volume - 6300.0).abs() < 0.05, "{volume}");
    let lengths: Vec<f64> = reply["edgeLengths"]
        .as_array()
        .expect("edgeLengths")
        .iter()
        .map(|n| n.as_f64().expect("length"))
        .collect();
    assert!(
        lengths.iter().any(|length| (length - 10.5).abs() < 1e-9),
        "{lengths:?}"
    );
}
