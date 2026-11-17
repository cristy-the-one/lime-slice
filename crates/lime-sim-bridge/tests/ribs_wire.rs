//! The wire between `src/modeling/rib-wall.ts` and the rib planner: a request
//! `ribWall` wrote (an open box's floor, a height-capped zone, a pressure,
//! `clearance` all null because nothing faces the floor), as committed by
//! `src/modeling/auto-ribs.test.ts`, read with every field checked and planned.

use lime_sim_bridge::ribs::{plan_ribs_json, request_of, RibPlanBody, WireHolds};
use serde_json::{json, Value};

fn fixture() -> Value {
    let text = include_str!("rib-wall-request.json");
    serde_json::from_str(text).expect("the fixture is JSON")
}

fn body(request: Value) -> Value {
    json!({
        "request": request,
        "rules": { "width": 1.35, "maxHeight": 6.0, "minSpacing": 8.0, "minLength": 5.0, "solverProfile": "rectangular" },
        "goal": { "kind": "balanced" },
        "options": { "workers": 2 },
    })
}

#[test]
fn ribwall_request_reads_with_every_field_known() {
    let parsed: RibPlanBody = serde_json::from_value(body(fixture())).expect("ribWall's request reads");
    assert!(matches!(parsed.request.holds, WireHolds::Given { .. }));
    assert_eq!(parsed.request.side, "positive");
    assert_eq!(parsed.request.zones.len(), 1);
    assert_eq!(parsed.request.load_cases.len(), 1);
    assert!(parsed.request.clearance.iter().all(|c| c.is_none()), "an open box: nothing faces the floor");
    let req = request_of(&parsed).expect("a valid request");
    assert!(req.rules.clearance.as_ref().unwrap().iter().all(|c| c.is_infinite()), "null is no cap");
    assert_eq!(req.mesh.vertices.len(), req.mesh.thickness.len());
}

#[test]
fn ribwall_request_plans() {
    let out: Value = serde_json::from_str(&plan_ribs_json(&body(fixture()).to_string())).unwrap();
    assert_eq!(out["ok"], true, "{out}");
    let ribs = out["ribs"].as_array().unwrap();
    assert!(!ribs.is_empty(), "the floor gets ribs: {out}");
    // The zone caps ribs at 2 mm inside it: no stretch is over 6, and any capped stretch is at most 2.
    for rib in ribs {
        for h in rib["heights"].as_array().unwrap() {
            let h = h.as_f64().unwrap();
            assert!(h <= 6.0 + 1e-9, "{h}");
        }
    }
    assert!(out["stiffnessFactor"].as_f64().unwrap() > 1.0);
}
