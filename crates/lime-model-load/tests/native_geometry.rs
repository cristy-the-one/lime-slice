//! The engine's native geometry answers exactly what `lime_recipe` answers for the same request text: `tree` reads
//! the request with serde_json, and every number must come out of that read with the same bits. Without serde_json's
//! `float_roundtrip` about one decimal in eight was read one unit off in the last place, so a lust plugin sent other
//! bytes with native geometry on than off (docs/plan-native-recipes.md, section 2.6).

/// Shortest decimals that serde_json's fast reader got wrong (each was read as its neighbour f64).
const AWKWARD: [f64; 5] = [11.005321081608713, -124.42004566890179, -127.06591418579039, 108.53463355319555, 29.658074656865942];

fn square(x: f64, y: f64, side: f64) -> String {
    format!("[[{x},{y}],[{},{y}],[{},{}],[{x},{}]]", x + side, x + side, y + side, y + side)
}

#[test]
fn native_geometry_keeps_every_bit() {
    for (i, &v) in AWKWARD.iter().enumerate() {
        // Two overlapping squares whose corners carry the awkward number; their union keeps the outer corners.
        let args = format!(r#"{{"op":"resolve","fill":"union","a":[{}],"b":[{}]}}"#, square(v, v, 10.0), square(v + 5.0, v + 0.5, 10.0));
        let direct = lime_recipe::native_geometry_request(&args).expect("lime_recipe answers the request");
        let via_tree = lime_model_load::tree(&format!(r#"{{"call":"nativeGeometry","args":{args}}}"#)).expect("tree answers");
        assert_eq!(via_tree, direct, "row {i}: the engine changed a number of {v}");
        assert!(direct.contains(&format!("{v}")), "row {i}: {v} is a corner of the union: {direct}");
    }
}

#[test]
fn engine_json_reads_numbers_exactly() {
    for v in AWKWARD {
        let text = format!("{v}");
        let read: f64 = serde_json::from_str(&text).unwrap();
        assert_eq!(read.to_bits(), text.parse::<f64>().unwrap().to_bits(), "{text}");
    }
}
