//! `lime-slice bench --json` reports every stage, and the stages add up to the core.

use std::path::Path;
use std::process::Command;

const KEYS: [&str; 17] = [
    "bands",
    "index",
    "contours",
    "cutCpu",
    "simplifyCpu",
    "roofs",
    "supports",
    "prep",
    "toolpaths",
    "wallsCpu",
    "infillCpu",
    "order",
    "combing",
    "join",
    "emit",
    "other",
    "core",
];
/// The rows that are slices of `core`; the CPU rows sit inside them.
const WALL: [&str; 12] = [
    "bands",
    "index",
    "contours",
    "roofs",
    "supports",
    "prep",
    "toolpaths",
    "order",
    "combing",
    "join",
    "emit",
    "other",
];

#[test]
fn bench_json_has_every_stage_and_they_sum_to_the_core() {
    let cube =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/calibration_cube_20mm.stl");
    let out = Command::new(env!("CARGO_BIN_EXE_lime-slice"))
        .args(["bench", "--json"])
        .arg(&cube)
        .output()
        .expect("run bench");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let doc: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("stdout is one JSON document");
    let runs = doc["runs"].as_array().expect("runs");
    assert_eq!(runs.len(), 8, "four modes, new path and classic");
    for run in runs {
        let name = run["run"].as_str().unwrap();
        let layers = run["layers"].as_u64().unwrap();
        assert!(layers > 0, "{name}: layers");
        for field in ["stagesMs", "perLayerMs"] {
            for key in KEYS {
                let v = run[field][key].as_f64();
                assert!(
                    v.is_some_and(|v| v >= 0.0),
                    "{name}: {field}.{key} is {v:?}"
                );
            }
        }
        let ms = &run["stagesMs"];
        let core = ms["core"].as_f64().unwrap();
        assert_eq!(core, run["coreMs"].as_f64().unwrap(), "{name}");
        assert!(
            run["callMs"].as_f64().unwrap() >= core,
            "{name}: call covers core"
        );
        let sum: f64 = WALL.iter().map(|k| ms[*k].as_f64().unwrap()).sum();
        assert!(
            (sum - core).abs() <= core * 0.05 + 0.5,
            "{name}: stages {sum:.3} ms vs core {core:.3} ms"
        );
        let per = run["perLayerMs"]["core"].as_f64().unwrap();
        assert!(
            (per * layers as f64 - core).abs() <= core * 1e-9 + 1e-9,
            "{name}: per layer"
        );
    }
}
