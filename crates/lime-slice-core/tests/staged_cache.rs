//! The staged cache: a run of settings tweaks, each reusing the stages its
//! change left alone, gives the same G-code and preview as slicing each
//! request cold. One test, because the kept stages are shared by the whole
//! process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

fn request(extra: &Value) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../samples/overhang_ledge.stl"
    );
    let mut req = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).unwrap()),
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
    });
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    req
}

fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn reused(reply: &Value) -> Vec<&str> {
    reply["stages"]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn each_tweak_reuses_the_stages_it_left_alone_and_slices_as_cold() {
    // Each step adds one change to the step before it.
    let steps: [(&str, Value); 8] = [
        ("base", json!({})),
        ("arc fit off", json!({"arcFit": false})),
        ("z-hop always", json!({"zHop": "always"})),
        ("scarf off", json!({"scarfSeam": "off"})),
        ("seam rear", json!({"seam": "rear"})),
        ("feature speeds off", json!({"featureSpeeds": false})),
        ("support angle 55", json!({"supportAngle": 55})),
        (
            "nozzle 215 °C",
            json!({"printer": {
                "name": "Generic Marlin 0.4 mm PLA",
                "nozzleDiameter": 0.4,
                "filamentDiameter": 1.75,
                "nozzleTemp": 215.0,
                "bedTemp": 60.0,
                "bedX": 220.0,
                "bedY": 220.0,
            }}),
        ),
    ];
    let mut requests = Vec::new();
    let mut extra = json!({});
    for (_, change) in &steps {
        for (k, v) in change.as_object().unwrap() {
            extra[k] = v.clone();
        }
        requests.push(request(&extra));
    }

    keep_support_bases(true);
    let staged: Vec<Value> = requests.iter().map(slice).collect();
    // The same requests with the G-code parked, as the app asks: its text
    // is formatted only when the parked G-code is read.
    let parked: Vec<String> = requests
        .iter()
        .map(|req| {
            let mut req = req.clone();
            req["includeGcode"] = json!(false);
            let mut text = String::new();
            let reply = slice_payload(&req.to_string(), None, Job::default(), |g| {
                text = g.text();
                "parked".into()
            })
            .unwrap();
            assert!(reply.contains("\"gcodeToken\":\"parked\""));
            text
        })
        .collect();
    keep_support_bases(false);
    let cold: Vec<Value> = requests.iter().map(slice).collect();

    let got: Vec<(&str, Vec<&str>)> = steps
        .iter()
        .zip(&staged)
        .map(|((name, _), reply)| (*name, reused(reply)))
        .collect();
    assert_eq!(
        got,
        vec![
            ("base", vec![]),
            (
                "arc fit off",
                vec![
                    "contours",
                    "toolpaths",
                    "order",
                    "comb",
                    "supports",
                    "supportPaths"
                ]
            ),
            (
                "z-hop always",
                vec!["contours", "toolpaths", "order", "supports", "supportPaths"]
            ),
            (
                "scarf off",
                vec!["contours", "toolpaths", "supports", "supportPaths"]
            ),
            ("seam rear", vec!["contours", "supports", "supportPaths"]),
            ("feature speeds off", vec!["contours", "supports"]),
            (
                "support angle 55",
                vec!["contours", "toolpaths", "order", "comb"]
            ),
            (
                "nozzle 215 °C",
                vec![
                    "contours",
                    "toolpaths",
                    "order",
                    "comb",
                    "supports",
                    "supportPaths"
                ]
            ),
        ]
    );
    for ((((name, _), staged), cold), parked) in steps.iter().zip(&staged).zip(&cold).zip(&parked) {
        assert!(
            cold["gcode"] == json!(parked),
            "{name}: parked g-code differs"
        );
        assert_eq!(
            reused(cold),
            Vec::<&str>::new(),
            "{name}: cold reuses nothing"
        );
        assert!(
            staged["gcode"].as_str().unwrap().contains(";LAYER:"),
            "{name}: g-code"
        );
        assert!(staged["gcode"] == cold["gcode"], "{name}: g-code differs");
        assert!(
            staged["layers"] == cold["layers"],
            "{name}: preview differs"
        );
        assert_eq!(staged["estimate"], cold["estimate"], "{name}: estimate");
        assert_eq!(staged["coverage"], cold["coverage"], "{name}: coverage");
    }
    let gcode = |k: usize| staged[k]["gcode"].as_str().unwrap().to_string();
    assert!(
        (1..steps.len()).all(|k| gcode(k) != gcode(k - 1)),
        "every tweak changes the g-code"
    );
}
