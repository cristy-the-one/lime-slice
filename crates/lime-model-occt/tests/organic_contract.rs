//! The shapes the app and the MCP send for the organic ops, as mcp/organic-contract-occt.test.ts sends them, built for
//! real: a spline written with `through`, a closed NURBS written with `closed`, a sweep's auxiliary spine as
//! `mode: {kind: "auxSpine"}`, and the sweep and blend inputs the contract test found refused or damaged.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn has_occt() -> bool {
    let caps = call(json!({ "call": "capabilities" }));
    if caps["stepMeshing"].as_bool() == Some(true) {
        return true;
    }
    assert!(std::env::var_os("LIME_REQUIRE_OCCT").is_none(), "Open CASCADE is required but not linked: {caps}");
    false
}

fn decode_f32(b64: &str) -> Vec<f32> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
        .chunks_exact(4)
        .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect()
}

/// The largest coordinate `axis` of a reply's mesh.
fn max_of(reply: &Value, axis: usize) -> f64 {
    decode_f32(reply["positions"].as_str().expect("positions"))
        .chunks_exact(3)
        .map(|p| f64::from(p[axis]))
        .fold(f64::MIN, f64::max)
}

fn feature(key: &str, feature: Value) -> Value {
    call(json!({ "call": "open", "key": key, "feature": feature, "chordMm": 0.05 }))
}

fn close(key: &str) {
    ok(json!({ "call": "close", "key": key }));
}

fn ring(radius: f64, z: f64) -> Value {
    json!({ "origin": [0.0, 0.0, z], "turn": [0.0, 0.0, 0.0], "radius": radius })
}

#[test]
fn a_sweep_along_a_spline_written_with_through_builds() {
    if !has_occt() {
        return;
    }
    let reply = feature("contract-sweep-spline", json!({
        "kind": "sweep", "op": "fuse", "sections": [ring(3.0, 0.0)],
        "spine": { "kind": "spline", "through": [[0.0, 0.0, 0.0], [0.0, 0.0, 20.0], [20.0, 0.0, 20.0]] }
    }));
    assert!(reply.get("error").is_none(), "{reply}");
    assert!(max_of(&reply, 0) > 19.5 && max_of(&reply, 2) > 21.0, "the sweep follows the spline: {}", max_of(&reply, 0));
    close("contract-sweep-spline");
}

#[test]
fn a_loft_with_a_spline_rail_written_with_through_builds() {
    if !has_occt() {
        return;
    }
    let reply = feature("contract-loft-guide", json!({
        "kind": "loft", "op": "fuse", "sections": [ring(5.0, 0.0), ring(5.0, 40.0)],
        "guides": [{ "kind": "spline", "through": [[5.0, 0.0, 0.0], [8.5, 0.0, 20.0], [5.0, 0.0, 40.0]] }]
    }));
    assert!(reply.get("error").is_none(), "{reply}");
    assert!(max_of(&reply, 0) > 7.0, "the rail bulges the loft: {}", max_of(&reply, 0));
    close("contract-loft-guide");
}

#[test]
fn a_planar_sheet_from_a_nurbs_written_closed_is_the_periodic_curve() {
    if !has_occt() {
        return;
    }
    let poles: Vec<[f64; 3]> = [0.0_f64, 60.0, 120.0, 180.0, 240.0, 300.0]
        .iter()
        .map(|deg| [10.0 * deg.to_radians().cos(), 10.0 * deg.to_radians().sin(), 0.0])
        .collect();
    let area = |key: &str, flag: &str| {
        let reply = feature(key, json!({ "kind": "sheet", "mode": "planar",
            "curves": [{ "kind": "nurbs", "poles": poles, "degree": 3, flag: true }] }));
        assert!(reply.get("error").is_none(), "{flag}: {reply}");
        let total = reply["faces"].as_array().expect("faces").iter().map(|f| f["areaMm2"].as_f64().unwrap_or(0.0)).sum::<f64>();
        close(key);
        total
    };
    let closed = area("contract-nurbs-closed", "closed");
    let periodic = area("contract-nurbs-periodic", "periodic");
    println!("closed {closed} mm², periodic {periodic} mm²");
    assert!((closed - periodic).abs() < 1e-9 * periodic, "closed is read as periodic: {closed} vs {periodic}");
    // The periodic cubic through six poles on a radius-10 circle bounds about 217 mm² (the open curve: 66.5).
    assert!(closed > 200.0, "{closed}");
}

#[test]
fn a_sweep_with_mode_aux_spine_builds() {
    if !has_occt() {
        return;
    }
    let square = json!({ "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "profile": [[-3.0, -3.0], [3.0, -3.0], [3.0, 3.0], [-3.0, 3.0]] });
    let line = |x: f64| json!({ "kind": "segments", "start": [x, 0.0, 0.0], "segments": [{ "kind": "line", "to": [x, 0.0, 40.0] }] });
    let reply = feature("contract-sweep-aux", json!({
        "kind": "sweep", "op": "fuse", "sections": [square], "spine": line(0.0),
        "mode": { "kind": "auxSpine", "spine": line(10.0) }
    }));
    assert!(reply.get("error").is_none(), "{reply}");
    let volume = reply["volumeMm3"].as_f64().expect("volume");
    assert!((volume - 36.0 * 40.0).abs() <= 1e-4 * 1440.0, "a 6 mm square along 40 mm: {volume}");
    close("contract-sweep-aux");
    // Both spellings at once is refused.
    let both = feature("contract-sweep-aux-both", json!({
        "kind": "sweep", "op": "fuse", "sections": [square], "spine": line(0.0),
        "mode": { "kind": "auxSpine", "spine": line(10.0) }, "auxSpine": line(10.0)
    }));
    assert!(both["error"].as_str().is_some_and(|e| e.starts_with("Give the auxiliary spine once")), "{both}");
}

/// A transformed corner is built and then checked: kept when the solid is clean, refused when it is damaged. A 2.9
/// degree bend builds with it; the 90 degree elbow either builds a clean solid or is refused with the sentence.
#[test]
fn a_transformed_corner_is_kept_when_clean_and_refused_when_damaged() {
    if !has_occt() {
        return;
    }
    let spine = |to: [f64; 3]| json!({ "kind": "segments", "start": [0.0, 0.0, 0.0], "segments": [
        { "kind": "line", "to": [0.0, 0.0, 20.0] }, { "kind": "line", "to": to }
    ] });
    let gentle = feature("contract-bend-transformed", json!({ "kind": "sweep", "op": "fuse", "sections": [ring(3.0, 0.0)],
        "spine": spine([1.0, 0.0, 40.0]), "transition": "transformed" }));
    assert!(gentle.get("error").is_none(), "a 2.9 degree bend builds with a transformed corner: {gentle}");
    println!("2.9 degree bend, transformed: {} mm³", gentle["volumeMm3"]);
    close("contract-bend-transformed");
    for transition in ["right", "round", "transformed"] {
        let key = format!("contract-elbow-{transition}");
        let reply = feature(&key, json!({ "kind": "sweep", "op": "fuse", "sections": [ring(3.0, 0.0)], "spine": spine([20.0, 0.0, 20.0]), "transition": transition }));
        if let Some(error) = reply["error"].as_str() {
            assert_eq!(transition, "transformed", "{transition}: {reply}");
            assert_eq!(error, "A transformed corner left a damaged solid at a bend of this spine. Use a right or round corner there.");
            println!("90 degree elbow, transformed: refused");
        } else {
            println!("90 degree elbow, {transition}: {} mm³", reply["volumeMm3"]);
            close(&key);
        }
    }
}

#[test]
fn scale_stations_on_a_sweep_of_several_sections_are_refused() {
    if !has_occt() {
        return;
    }
    let line = json!({ "kind": "segments", "start": [0.0, 0.0, 0.0], "segments": [{ "kind": "line", "to": [0.0, 0.0, 40.0] }] });
    let one = feature("contract-scale-one", json!({ "kind": "sweep", "op": "fuse", "sections": [ring(3.0, 0.0)], "spine": line, "scale": [[0.0, 1.0], [1.0, 2.0]] }));
    assert!(one.get("error").is_none(), "{one}");
    assert!((max_of(&one, 0) - 6.0).abs() < 0.05, "radius 3 grows to 6: {}", max_of(&one, 0));
    close("contract-scale-one");
    let two = feature("contract-scale-two", json!({ "kind": "sweep", "op": "fuse", "sections": [ring(3.0, 0.0), ring(4.0, 40.0)], "spine": line, "scale": [[0.0, 1.0], [1.0, 2.0]] }));
    assert_eq!(
        two["error"].as_str(),
        Some("Scale stations take a sweep of one section. With several sections, each section sets the size where it stands."),
        "{two}"
    );
}

/// Two coaxial tubes whose rims are each four quarter arcs (four edges a rim), picked in an order of their own.
#[test]
fn a_blend_between_rims_of_four_edges_each_builds() {
    if !has_occt() {
        return;
    }
    // The inner rim starts a quarter turn on from the outer one, so the two chains do not start across from each other.
    let quarters = |r: f64| {
        let h = r * std::f64::consts::FRAC_1_SQRT_2;
        let mut points = [[r, 0.0], [h, h], [0.0, r], [-h, h], [-r, 0.0], [-h, -h], [0.0, -r], [h, -h]];
        if r < 14.0 {
            points.rotate_left(2);
        }
        let at = |k: usize| json!([points[k % 8][0], points[k % 8][1], 0.0]);
        json!({ "kind": "segments", "start": at(0), "segments": (0..4)
            .map(|q| json!({ "kind": "arc", "through": at(2 * q + 1), "to": at(2 * q + 2) }))
            .collect::<Vec<_>>() })
    };
    let key = "contract-blend-quarters";
    let tube = |r: f64| json!({ "kind": "sheet", "mode": "extrude", "curves": [quarters(r)], "dir": [0.0, 0.0, 1.0], "distance": 16.0 });
    ok(json!({ "call": "open", "key": key, "feature": tube(18.0), "chordMm": 0.01 }));
    let both = ok(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "chordMm": 0.01, "op": tube(10.0) }));
    let points = decode_f32(both["edgePoints"].as_str().expect("edgePoints"));
    let offsets: Vec<u32> = base64::engine::general_purpose::STANDARD
        .decode(both["edgeOffsets"].as_str().expect("edgeOffsets"))
        .expect("base64")
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let mut outer = Vec::new();
    let mut inner = Vec::new();
    for index in 0..offsets.len() - 1 {
        let row: Vec<&[f32]> = (offsets[index] as usize..offsets[index + 1] as usize).map(|k| &points[k * 3..k * 3 + 3]).collect();
        if row.len() < 2 || row.iter().any(|p| (p[2] - 16.0).abs() > 1e-4) {
            continue;
        }
        let radius = row.iter().map(|p| f64::from(p[0].hypot(p[1]))).sum::<f64>() / row.len() as f64;
        if radius > 14.0 { outer.push(index) } else { inner.push(index) }
    }
    assert_eq!((outer.len(), inner.len()), (4, 4), "four edges a rim");
    // Not in chain order: the kernel joins them end to start itself.
    outer.swap(0, 2);
    inner.reverse();
    for continuity in ["g1", "g2"] {
        let reply = call(json!({ "call": "apply", "key": key, "parent": 1, "node": 2, "chordMm": 0.01, "op": {
            "kind": "blendSurface", "continuity": continuity,
            "a": { "edges": outer, "continuity": continuity }, "b": { "edges": inner, "continuity": continuity }
        } }));
        assert!(reply.get("error").is_none(), "{continuity}: {reply}");
        assert!(max_of(&reply, 2) > 16.5, "{continuity}: the blend rises over the rims");
        ok(json!({ "call": "drop", "key": key, "node": 2 }));
    }
    close(key);
}
