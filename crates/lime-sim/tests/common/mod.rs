//! Shared checks for the JSON baselines. A row is a number plus a tolerance,
//! not a hash of the floats.

use serde_json::Value;

pub fn load(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/baselines")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("baseline {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("baseline {name}: {err}"))
}

pub fn near_abs(got: f64, expect: f64, abs: f64, what: &str) {
    let err = (got - expect).abs();
    assert!(
        err <= abs,
        "{what}: got {got:.10} expect {expect:.10} abs {err:.3e} tol {abs:.3e}"
    );
}

pub fn number(row: &Value, key: &str) -> f64 {
    row[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} is not a number in {row}"))
}
