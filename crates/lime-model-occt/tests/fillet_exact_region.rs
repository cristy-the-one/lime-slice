//! The exact G2 and conic fillets cut the fillet's own cross-section along the edge and nothing else. The cutter used to
//! run 0.5 mm past both ends of the edge, so a wall the edge runs into, or a boss beside the end of the edge, lost
//! material. Each case here takes the same fillet on a part without the wall or boss as its reference: the volume the
//! fillet removes must be the same.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use base64::Engine;
use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn floats(reply: &Value, field: &str) -> Vec<f32> {
    base64::engine::general_purpose::STANDARD
        .decode(reply[field].as_str().expect(field))
        .expect("base64")
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes(word.try_into().expect("four bytes")))
        .collect()
}

fn words(reply: &Value, field: &str) -> Vec<u32> {
    base64::engine::general_purpose::STANDARD
        .decode(reply[field].as_str().expect(field))
        .expect("base64")
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes(word.try_into().expect("four bytes")))
        .collect()
}

/// The index of the one edge from y = 0 whose points all lie on x = 20, z = 10, and how long it is along y. (Under the
/// wall the fused part keeps a second, inner edge there, from y = 15 to 20.)
fn edge_at_x20_z10(reply: &Value) -> (usize, f64) {
    let points = floats(reply, "edgePoints");
    let offsets = words(reply, "edgeOffsets");
    let mut found = Vec::new();
    for index in 0..offsets.len() - 1 {
        let row: Vec<[f32; 3]> = (offsets[index] as usize..offsets[index + 1] as usize)
            .map(|k| [points[k * 3], points[k * 3 + 1], points[k * 3 + 2]])
            .collect();
        if row.len() >= 2 && row.iter().all(|p| (p[0] - 20.0).abs() < 1e-4 && (p[2] - 10.0).abs() < 1e-4) {
            let (lo, hi) = row.iter().fold((f32::MAX, f32::MIN), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
            if lo.abs() < 1e-4 {
                found.push((index, f64::from(hi - lo)));
            }
        }
    }
    assert_eq!(found.len(), 1, "one edge from y = 0 on x = 20, z = 10: {found:?}");
    found[0]
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

/// The volume a fillet of `continuity` on the x = 20, z = 10 edge removes from the box `[20, depth, 10]` with `extra`
/// fused on (None: the box alone), and that edge's length.
fn removed(key: &str, depth: f64, extra: Option<Value>, continuity: &str) -> Option<(f64, f64)> {
    let opened = call(json!({ "call": "open", "key": key, "box": [20.0, depth, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    let (mut parent, mut before) = (0, opened);
    if let Some(extra) = extra {
        before = ok(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": extra }));
        parent = 1;
    }
    let (edge, length) = edge_at_x20_z10(&before);
    let mut op = json!({ "kind": "fillet", "edges": [edge], "size": 3.0, "continuity": continuity });
    if continuity == "conic" {
        op["rho"] = json!(0.6);
    }
    let after = ok(json!({ "call": "apply", "key": key, "parent": parent, "node": parent + 1, "op": op }));
    ok(json!({ "call": "close", "key": key }));
    Some((volume(&before) - volume(&after), length))
}

fn same_removal(case: &str, with: (f64, f64), reference: (f64, f64)) {
    println!("{case}: removed {:.6} mm³ along {:.3} mm, reference {:.6} mm³ along {:.3} mm", with.0, with.1, reference.0, reference.1);
    assert!((with.1 - reference.1).abs() < 1e-6, "{case}: the edges differ");
    assert!(
        (with.0 - reference.0).abs() <= 1e-4 * reference.0,
        "{case}: the fillet removed {} mm³, its own region is {} mm³",
        with.0,
        reference.0
    );
}

#[test]
fn an_exact_fillet_leaves_the_wall_it_runs_into_whole() {
    for continuity in ["g2", "conic"] {
        // The wall stands on the top face across its back 5 mm, so the edge on x = 20, z = 10 runs from y = 0 to 15.
        let wall = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [0.0, 15.0, 10.0], "size": [20.0, 5.0, 10.0] });
        let Some(with) = removed(&format!("wall-{continuity}"), 20.0, Some(wall), continuity) else {
            return;
        };
        let reference = removed(&format!("wall-ref-{continuity}"), 15.0, None, continuity).expect("reference");
        same_removal(&format!("wall {continuity}"), with, reference);
    }
}

#[test]
fn an_exact_fillet_leaves_a_boss_beside_the_end_of_its_edge_whole() {
    for continuity in ["g2", "conic"] {
        // The boss stands out of the y = 0 end face, inside the corner the cutter used to run 0.5 mm past.
        let boss = json!({ "kind": "boolean", "op": "fuse", "primitive": "box", "origin": [17.0, -3.0, 7.5], "size": [2.5, 3.0, 2.0] });
        let Some(with) = removed(&format!("boss-{continuity}"), 20.0, Some(boss), continuity) else {
            return;
        };
        let reference = removed(&format!("boss-ref-{continuity}"), 20.0, None, continuity).expect("reference");
        same_removal(&format!("boss {continuity}"), with, reference);
    }
}

/// Off a straight edge between two flat faces, G2 and conic fall to Open CASCADE's own fillet, which has no rho and no
/// G2 bound. A conic is refused there; a G2 result is kept only when its seams measure G2 (jump at most 1e-3 per mm),
/// as surfaceInspect reads them, and is refused otherwise.
#[test]
fn g2_and_conic_off_a_straight_flat_edge_are_measured_or_refused() {
    for continuity in ["g2", "conic"] {
        let key = format!("curved-{continuity}");
        let opened = call(json!({ "call": "open", "key": key,
            "primitive": { "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 10.0, "height": 20.0 } }));
        if opened.get("error").is_some() {
            assert!(!require(), "OCCT was required: {opened}");
            return;
        }
        let points = floats(&opened, "edgePoints");
        let offsets = words(&opened, "edgeOffsets");
        let rim = (0..offsets.len() - 1)
            .find(|&i| {
                let row: Vec<f32> = (offsets[i] as usize..offsets[i + 1] as usize).map(|k| points[k * 3 + 2]).collect();
                row.len() > 4 && row.iter().all(|z| (z - 20.0).abs() < 1e-4)
            })
            .expect("the top rim");
        let mut op = json!({ "kind": "fillet", "edges": [rim], "size": 2.0, "continuity": continuity });
        if continuity == "conic" {
            op["rho"] = json!(0.6);
        }
        let reply = call(json!({ "call": "apply", "key": key, "parent": 0, "node": 1, "op": op }));
        let error = reply["error"].as_str().unwrap_or("").to_string();
        println!("{continuity} on a circular edge: {}", if error.is_empty() { "kept" } else { &error });
        if continuity == "conic" {
            assert_eq!(error, "A conic fillet is built only on straight edges between two flat faces, as a convex corner.");
        } else if error.is_empty() {
            let inspect = ok(json!({ "call": "surfaceInspect", "key": key, "node": 1, "chordMm": 0.1 }));
            assert!(
                inspect["continuity"]["worstCurvatureJump"].as_f64().unwrap_or(99.0) <= 1e-3,
                "a kept G2 fillet measures G2: {inspect}"
            );
        } else {
            assert!(error.starts_with("A G2 fillet is exact only on straight edges between two flat faces"), "{error}");
        }
        ok(json!({ "call": "close", "key": key }));
    }
}
