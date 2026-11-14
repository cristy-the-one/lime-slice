//! The gear primitive (docs/plan-native-recipes.md milestone 8): a spur gear with true involute flanks, as a new solid
//! and as a boolean's tool. A valid closed solid of the outline's area times its thickness, teeth as thick as they
//! should be at the pitch circle, two gears that mesh at their centre distance without touching and touch when turned
//! past their backlash, bores and hubs, blends on its edges, and its refusals. `LIME_REQUIRE_OCCT=1` makes a missing
//! kernel a failure. `cargo test -p lime-model-occt --test gear -- --nocapture` prints the build times and face counts
//! against the library's polyline outline.

use std::time::Instant;

use base64::Engine;
use lime_recipe::gear_pair::{classify, PairVerdict};
use lime_recipe::gears::{self, Gear};
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
    assert!(reply.get("error").is_none() && reply["ok"] != json!(false), "{} -> {}", short(&request), short(&reply));
    reply
}

/// A reply cut short for a failure message: a mesh is long.
fn short(value: &Value) -> String {
    value.to_string().chars().take(400).collect()
}

/// False, and the test passes, when the kernel is not linked and nobody asked for it.
fn kernel() -> bool {
    let probe = call(json!({ "call": "open", "key": "gear-kernel", "box": [1.0, 1.0, 1.0] }));
    if probe.get("error").is_some() {
        assert!(!require(), "OCCT was required: {probe}");
        return false;
    }
    true
}

fn volume(reply: &Value) -> f64 {
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn faces(reply: &Value) -> u64 {
    reply["fingerprint"]["faces"].as_u64().expect("faces")
}

/// A gear primitive: `teeth` of module `module`, `thickness` thick, its base centred on `origin`.
fn gear(teeth: u32, module: f64, thickness: f64, origin: [f64; 3]) -> Value {
    json!({ "primitive": "gear", "origin": origin, "height": thickness, "teeth": teeth, "module": module })
}

fn with(mut value: Value, extra: Value) -> Value {
    for (key, field) in extra.as_object().expect("an object") {
        value[key] = field.clone();
    }
    value
}

fn as_tool(solid: &Value, op: &str) -> Value {
    with(solid.clone(), json!({ "kind": "boolean", "op": op }))
}

fn step_check(key: &str, node: u32) -> lime_model_occt::PartitionPiece {
    let exported = ok(json!({ "call": "export", "key": key, "node": node, "format": "step" }));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(exported["bytesBase64"].as_str().expect("bytesBase64"))
        .expect("base64");
    let solids = lime_model_occt::step_solids(&bytes).expect("the STEP file reads");
    assert_eq!(solids.len(), 1, "{solids:?}");
    solids[0].clone()
}

#[test]
fn a_gear_is_a_valid_closed_solid_of_its_outline_s_area() {
    if !kernel() {
        return;
    }
    for (teeth, module) in [(6u32, 2.0), (12, 2.0), (24, 1.5), (60, 1.0), (150, 0.5)] {
        let key = format!("gear-root-{teeth}");
        let opened = ok(json!({ "call": "open", "key": key, "primitive": gear(teeth, module, 8.0, [0.0, 0.0, 0.0]) }));
        let expected = Gear::new(teeth, module).area().unwrap() * 8.0;
        let got = volume(&opened);
        assert!((got - expected).abs() / expected < 2e-4, "{teeth} teeth: {got} vs {expected}");
        let piece = step_check(&key, 0);
        assert!(piece.valid && piece.closed && piece.solids == 1, "{teeth} teeth: {piece:?}");
        // Two caps, and per tooth: a root, a tip, an involute and a fillet each side, and on an undercut gear the
        // undercut each side too.
        let outline = Gear::new(teeth, module).outline(0.0).unwrap();
        assert_eq!(faces(&opened), 2 + outline.pieces.len() as u64, "{teeth} teeth");
        // It stands on Z = 0, centred on its axis, as a cylinder does.
        let bounds = &opened["bounds"];
        if bounds.is_object() {
            assert!((bounds["min"][2].as_f64().unwrap()).abs() < 1e-6, "{bounds}");
        }
    }
}

#[test]
fn every_gear_the_numbers_allow_builds() {
    if !kernel() {
        return;
    }
    let mut built = 0;
    for teeth in [6u32, 8, 10, 13, 17, 18, 24, 41, 42, 60, 150] {
        for pressure in [14.5, 20.0, 25.0, 30.0] {
            for shift in [-0.5, 0.0, 0.5, 1.0] {
                let g = Gear::new(teeth, 1.0).pressure(pressure).shift(shift);
                let key = format!("sweep-{teeth}-{pressure}-{shift}");
                let solid = with(gear(teeth, 1.0, 3.0, [0.0, 0.0, 0.0]), json!({ "pressureDeg": pressure, "profileShift": shift }));
                let opened = call(json!({ "call": "open", "key": key, "primitive": solid }));
                match g.refusal() {
                    Some(why) => assert_eq!(opened["error"].as_str(), Some(why.as_str())),
                    None => {
                        assert!(opened.get("error").is_none(), "{teeth} teeth at {pressure} degrees, shift {shift}: {}", short(&opened));
                        let expected = g.area().unwrap() * 3.0;
                        assert!((volume(&opened) - expected).abs() / expected < 2e-4, "{teeth} {pressure} {shift}: {} vs {expected}", volume(&opened));
                        built += 1;
                    }
                }
                call(json!({ "call": "close", "key": key }));
            }
        }
    }
    assert!(built > 120, "{built} of 176 built");
}

#[test]
fn teeth_are_as_thick_as_they_should_be_at_the_pitch_circle() {
    if !kernel() {
        return;
    }
    // The gear's common with a thin ring about the pitch circle is the teeth's arcs there times the ring's width.
    for (teeth, shift, backlash) in [(12u32, 0.0, 0.1), (24, 0.0, 0.0), (24, 0.3, 0.1), (40, -0.2, 0.2)] {
        let g = Gear::new(teeth, 2.0).shift(shift).backlash(backlash);
        let key = format!("gear-pitch-{teeth}-{shift}");
        let solid = with(gear(teeth, 2.0, 5.0, [0.0, 0.0, 0.0]), json!({ "profileShift": shift, "backlash": backlash }));
        ok(json!({ "call": "open", "key": key, "primitive": solid }));
        let (r, half) = (g.pitch_radius(), 0.01);
        let ring = json!({ "kind": "boolean", "op": "common", "primitive": "tube", "origin": [0.0, 0.0, -1.0],
            "radius": r + half, "innerRadius": r - half, "height": 7.0 });
        let common = ok(json!({ "call": "probe", "key": key, "node": 0, "op": ring }));
        let arc = volume(&common) / (5.0 * 2.0 * half) / f64::from(teeth);
        assert!((arc - g.pitch_thickness()).abs() < 2e-3, "{teeth} teeth, shift {shift}: {arc} vs {}", g.pitch_thickness());
    }
}

/// The common of gear `a`'s tree with `tool`: 0 when they do not overlap.
fn common(key: &str, tool: &Value) -> f64 {
    let reply = call(json!({ "call": "probe", "key": key, "node": 0, "op": as_tool(tool, "common") }));
    if reply.get("error").is_some() || reply["ok"] == json!(false) {
        let why = reply["error"].as_str().unwrap_or_default();
        assert!(why.contains("removed the solid") || why.contains("do not overlap"), "{}", short(&reply));
        return 0.0;
    }
    volume(&reply)
}

#[test]
fn two_gears_mesh_at_their_centre_distance_within_their_backlash() {
    if !kernel() {
        return;
    }
    for (a, b, module) in [(12u32, 24u32, 2.0), (17, 31, 1.5), (9, 40, 1.0), (24, 24, 1.0)] {
        let key = format!("mesh-{a}-{b}");
        ok(json!({ "call": "open", "key": key, "primitive": gear(a, module, 6.0, [0.0, 0.0, 0.0]) }));
        let (ga, gb) = (Gear::new(a, module), Gear::new(b, module));
        let distance = ga.centre_distance(&gb);
        // The mate's tooth 0 faces a gap of this gear when turned by mate_phase (the library's helper, unchanged).
        let phase = gears::mate_phase(0.0, a, 0.0, b);
        let mate = |turn_mm: f64| {
            let deg = (phase + (turn_mm / gb.pitch_radius()).to_degrees()) % 360.0;
            with(gear(b, module, 6.0, [distance, 0.0, 0.0]), json!({ "phaseDeg": deg }))
        };
        // 0.1 mm off each tooth: 0.2 mm of play at the pitch circle, 0.1 each way when centred.
        assert_eq!(common(&key, &mate(0.0)), 0.0, "{a} with {b}: they mesh without touching");
        for turn in [0.06, -0.06] {
            assert_eq!(common(&key, &mate(turn)), 0.0, "{a} with {b}: {turn} mm is inside the backlash");
        }
        for turn in [0.16, -0.16] {
            let crossing = common(&key, &mate(turn));
            assert!(crossing > 1e-3, "{a} with {b}: turned {turn} mm past the backlash they cross ({crossing})");
        }
        // Half a tooth off, tooth meets tooth.
        assert!(common(&key, &mate(std::f64::consts::PI * module / 2.0)) > 1.0);
        // The same poses, classified from the outlines. The volume above is the kernel; this is the recipe check.
        let phase_at = |turn_mm: f64| (phase + (turn_mm / gb.pitch_radius()).to_degrees()) % 360.0;
        let verdict = |turn_mm: f64| classify(&ga, &gb, [0.0, 0.0], [distance, 0.0], 0.0, phase_at(turn_mm));
        assert_eq!(verdict(0.0).verdict, PairVerdict::Meshing, "{a} with {b}");
        assert!(!verdict(0.0).hit, "{a} with {b}");
        for turn in [0.06, -0.06] {
            assert_eq!(verdict(turn).verdict, PairVerdict::Meshing, "{a} with {b} at {turn}");
            assert!(!verdict(turn).hit, "{a} with {b} at {turn}");
        }
        for turn in [0.16, -0.16] {
            assert!(verdict(turn).verdict.interferes(), "{a} with {b} at {turn}: {}", verdict(turn).verdict.as_str());
        }
        assert!(verdict(std::f64::consts::PI * module / 2.0).verdict.interferes());
    }
}

#[test]
fn bores_and_hubs() {
    if !kernel() {
        return;
    }
    let base = gear(24, 1.5, 6.0, [0.0, 0.0, 0.0]);
    let plain = volume(&ok(json!({ "call": "open", "key": "bore-none", "primitive": base })));
    let round = volume(&ok(json!({ "call": "open", "key": "bore-round", "primitive": with(base.clone(), json!({ "bore": 5.0 })) })));
    assert!((plain - round - std::f64::consts::PI * 2.5 * 2.5 * 6.0).abs() < 1e-3, "{plain} {round}");
    let hex = volume(&ok(json!({ "call": "open", "key": "bore-hex", "primitive": with(base.clone(), json!({ "bore": 5.0, "boreShape": "hex" })) })));
    let hex_area = 3f64.sqrt() / 2.0 * 5.0 * 5.0;
    assert!((plain - hex - hex_area * 6.0).abs() < 1e-3, "{plain} {hex}");
    let d = volume(&ok(json!({ "call": "open", "key": "bore-d", "primitive": with(base.clone(), json!({ "bore": 5.0, "boreShape": "d", "boreFlat": 4.5 })) })));
    // A D of 5 mm with its flat 2 mm from the centre: the circle less the segment beyond the flat.
    let (radius, across) = (2.5f64, 2.0f64);
    let segment = radius * radius * (across / radius).acos() - across * (radius * radius - across * across).sqrt();
    assert!((plain - d - (std::f64::consts::PI * radius * radius - segment) * 6.0).abs() < 1e-3, "{plain} {d}");
    let hub = ok(json!({ "call": "open", "key": "hub", "primitive": with(base.clone(), json!({ "bore": 5.0, "hubDiameter": 14.0, "hubHeight": 4.0 })) }));
    let ring = std::f64::consts::PI * (7.0 * 7.0 - 2.5 * 2.5) * 4.0;
    assert!((volume(&hub) - round - ring).abs() < 1e-3, "{} {round}", volume(&hub));
    let piece = step_check("hub", 0);
    assert!(piece.valid && piece.closed && piece.solids == 1, "{piece:?}");
}

#[test]
fn a_gear_tool_fuses_and_cuts_and_its_edges_take_blends() {
    if !kernel() {
        return;
    }
    // A gear stood on a plate, turned and moved like any tool: the fused volume is the gear's.
    ok(json!({ "call": "open", "key": "plate", "primitive": { "primitive": "box", "origin": [-30.0, -30.0, -4.0], "size": [60.0, 60.0, 4.0] } }));
    let tool = with(gear(20, 2.0, 6.0, [0.0, 0.0, 0.0]), json!({ "bore": 6.0, "phaseDeg": 4.5 }));
    let fused = ok(json!({ "call": "apply", "key": "plate", "parent": 0, "node": 1, "op": as_tool(&tool, "fuse") }));
    let alone = volume(&ok(json!({ "call": "open", "key": "plate-gear", "primitive": tool.clone() })));
    assert!((volume(&fused) - 60.0 * 60.0 * 4.0 - alone).abs() < 1e-2, "{} vs {}", volume(&fused), alone);
    // The step's faces are its own: every flank, tip and root face the gear made belongs to node 1.
    let steps = fused["stepFaces"].as_array().expect("stepFaces");
    let mine = steps.iter().filter(|step| step.as_u64() == Some(1)).count();
    assert!(mine >= 20 * 6, "{mine} faces made by the gear step");
    // Chamfer the gear's sharp convex edges from that step: the tip's and the flanks' top edges.
    let chamfered = ok(json!({ "call": "apply", "key": "plate", "parent": 1, "node": 2,
        "op": { "kind": "chamfer", "edges": [{ "fromNode": 1, "filter": "convex" }], "size": 0.3 } }));
    assert!(volume(&chamfered) < volume(&fused));
    // Cut into the plate, turned onto its side: the hole is the gear's shape.
    ok(json!({ "call": "open", "key": "block", "primitive": { "primitive": "box", "origin": [-30.0, -30.0, -30.0], "size": [60.0, 60.0, 60.0] } }));
    let cut_tool = with(gear(20, 2.0, 80.0, [0.0, 0.0, -40.0]), json!({ "turn": [0.0, 90.0, 0.0] }));
    let cut = ok(json!({ "call": "apply", "key": "block", "parent": 0, "node": 1, "op": as_tool(&cut_tool, "cut") }));
    let area = Gear::new(20, 2.0).area().unwrap();
    assert!((60.0f64.powi(3) - volume(&cut) - area * 60.0).abs() / (area * 60.0) < 2e-4, "{}", volume(&cut));
    // A fillet on a gear root's convex edges too.
    ok(json!({ "call": "open", "key": "round-teeth", "primitive": gear(16, 2.0, 6.0, [0.0, 0.0, 0.0]) }));
    ok(json!({ "call": "apply", "key": "round-teeth", "parent": 0, "node": 1,
        "op": { "kind": "fillet", "edges": [{ "fromNode": 0, "filter": "convex" }], "size": 0.25 } }));
    let piece = step_check("round-teeth", 1);
    assert!(piece.valid && piece.closed, "{piece:?}");
}

#[test]
fn a_gear_saved_in_a_project_rebuilds_the_same() {
    if !kernel() {
        return;
    }
    let tool = with(gear(14, 1.25, 5.0, [3.0, -2.0, 1.0]), json!({ "pressureDeg": 25.0, "profileShift": 0.2, "turn": [10.0, 0.0, 30.0], "hubDiameter": 8.0, "hubHeight": 2.0 }));
    ok(json!({ "call": "open", "key": "saved", "box": [40.0, 40.0, 10.0] }));
    let first = ok(json!({ "call": "apply", "key": "saved", "parent": 0, "node": 1, "op": as_tool(&tool, "cut") }));
    // The op as stored keeps every gear field, and the same op opened afresh in a new tree builds the same solid.
    let stored = &first["op"];
    if stored.is_object() {
        for field in ["teeth", "module", "pressureDeg", "profileShift", "hubDiameter", "hubHeight"] {
            assert!(stored.get(field).is_some(), "{field} in {stored}");
        }
    }
    ok(json!({ "call": "open", "key": "saved-again", "box": [40.0, 40.0, 10.0] }));
    let again = ok(json!({ "call": "apply", "key": "saved-again", "parent": 0, "node": 1, "op": as_tool(&tool, "cut") }));
    assert_eq!(first["fingerprint"], again["fingerprint"]);
    // A primitive saved before gears existed is the same JSON as ever: no gear field is written for it.
    let cylinder = ok(json!({ "call": "apply", "key": "saved", "parent": 1, "node": 2,
        "op": { "kind": "boolean", "op": "cut", "primitive": "cylinder", "origin": [0.0, 0.0, 0.0], "radius": 2.0, "height": 20.0 } }));
    if let Some(op) = cylinder["op"].as_object() {
        assert!(!op.contains_key("teeth") && !op.contains_key("module"), "{op:?}");
    }
}

#[test]
fn a_gear_refuses_in_one_sentence() {
    if !kernel() {
        return;
    }
    let base = gear(20, 1.0, 5.0, [0.0, 0.0, 0.0]);
    let cases = [
        (with(base.clone(), json!({ "teeth": 5 })), "A gear takes 6 to 150 teeth."),
        (with(base.clone(), json!({ "teeth": 20.5 })), "A gear takes a whole number of teeth."),
        (with(base.clone(), json!({ "module": 0.0 })), "A gear's module is 0.05 to 50 mm."),
        (with(base.clone(), json!({ "pressureDeg": 45.0 })), "A gear's pressure angle is 10 to 30 degrees."),
        (with(base.clone(), json!({ "height": 0.0 })), "A gear's thickness is above 0 and at most 1000 mm."),
        (with(base.clone(), json!({ "bore": 16.0 })), "The bore leaves less than one module of material under the teeth: keep it under 15.50 mm."),
        (with(base.clone(), json!({ "hubDiameter": 8.0 })), "A hub takes both hubDiameter and hubHeight."),
        (with(base.clone(), json!({ "bore": 5.0, "hubDiameter": 5.5, "hubHeight": 2.0 })), "A hub is wider than the bore by at least 1 mm."),
        (with(base.clone(), json!({ "boreShape": "hex" })), "A bore's shape or flat needs a bore size."),
        (with(base.clone(), json!({ "bore": 5.0, "boreFlat": 4.0 })), "Only a D bore takes a flat."),
        (with(base.clone(), json!({ "teeth": 8, "profileShift": 1.0 })), "These teeth come to a point below the tip: use less profile shift, more teeth, or a smaller pressure angle."),
    ];
    for (index, (solid, why)) in cases.iter().enumerate() {
        let opened = call(json!({ "call": "open", "key": format!("refuse-{index}"), "primitive": solid }));
        assert_eq!(opened["error"].as_str(), Some(*why), "{solid}: {}", short(&opened));
        // The same as a tool: the solid it was applied to does not change.
        ok(json!({ "call": "open", "key": format!("refuse-tool-{index}"), "box": [10.0, 10.0, 10.0] }));
        let applied = call(json!({ "call": "probe", "key": format!("refuse-tool-{index}"), "node": 0, "op": as_tool(solid, "fuse") }));
        assert!(applied.to_string().contains(why), "{}", short(&applied));
    }
}

/// Not a check: the numbers the plan's "As built" quotes. The gear op's build against an extrude of the library's
/// polyline outline (3 points a flank, the ingredient's default), each a new solid and then cut from a plate.
#[test]
fn build_time_and_faces_against_the_library_polyline() {
    if !kernel() {
        return;
    }
    let polyline = |teeth: u32, module: f64| {
        let pts = gears::gear_outline_with(teeth, module, 0.1, 3, 0.0);
        json!({ "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 0.0], "turn": [0.0, 0.0, 0.0], "profile": pts, "depth": 8.0 })
    };
    for (teeth, module) in [(12u32, 2.0), (24, 2.0), (60, 1.0)] {
        let mut row = Vec::new();
        for kind in ["gear", "polyline"] {
            let (mut news, mut cuts) = (Vec::new(), Vec::new());
            for run in 0..3 {
                let key = format!("bench-{kind}-{teeth}-{run}");
                let started = Instant::now();
                let opened = if kind == "gear" {
                    ok(json!({ "call": "open", "key": key, "primitive": gear(teeth, module, 8.0, [0.0, 0.0, 0.0]) }))
                } else {
                    ok(json!({ "call": "open", "key": key, "feature": polyline(teeth, module) }))
                };
                let new_ms = started.elapsed().as_secs_f64() * 1000.0;
                ok(json!({ "call": "open", "key": format!("{key}-plate"), "primitive": { "primitive": "box", "origin": [-60.0, -60.0, -2.0], "size": [120.0, 120.0, 6.0] } }));
                let started = Instant::now();
                let op = if kind == "gear" { as_tool(&gear(teeth, module, 8.0, [0.0, 0.0, 0.0]), "cut") } else { with(polyline(teeth, module), json!({ "op": "cut" })) };
                let cut = ok(json!({ "call": "apply", "key": format!("{key}-plate"), "parent": 0, "node": 1, "op": op }));
                let cut_ms = started.elapsed().as_secs_f64() * 1000.0;
                news.push(new_ms);
                cuts.push(cut_ms);
                if run == 2 {
                    let range = |v: &[f64]| format!("{:.0}-{:.0} ms", v.iter().copied().fold(f64::INFINITY, f64::min), v.iter().copied().fold(0.0, f64::max));
                    row.push(format!(
                        "{kind}: new solid {} faces {}, cut {} faces {}, {:.1} mm3",
                        faces(&opened),
                        range(&news),
                        faces(&cut),
                        range(&cuts),
                        volume(&opened)
                    ));
                }
            }
        }
        println!("{teeth} teeth: {}", row.join(" | "));
    }
}
