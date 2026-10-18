//! K3. An extrude's second depth, its draft angle, and stopping at a face. Each volume is one worked out by
//! hand. A request with none of the new fields stays the plain extrude. `LIME_REQUIRE_OCCT=1` makes a missing
//! kernel a failure.

use std::f64::consts::PI;

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn apply(key: &str, parent: u32, node: u32, op: &Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": parent, "node": node, "op": op }))
}

fn refused(reply: &Value, wanted: &str) {
    assert_eq!(reply["error"].as_str(), Some(wanted), "{reply}");
}

fn square() -> Value {
    json!([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]])
}

/// The face whose outward normal has both X and Z, the slant of a topX = 0 wedge.
fn slant(reply: &Value) -> i64 {
    let faces = reply["faces"].as_array().expect("faces");
    let mut found = None;
    for (index, face) in faces.iter().enumerate() {
        let normal = face["normal"].as_array().expect("normal");
        let nx = normal[0].as_f64().unwrap();
        let ny = normal[1].as_f64().unwrap();
        let nz = normal[2].as_f64().unwrap();
        if nx.abs() > 0.2 && nz.abs() > 0.2 && ny.abs() < 0.2 {
            assert!(found.is_none(), "two faces lean in X and Z");
            found = Some(index as i64);
        }
    }
    found.expect("the slanted face")
}

#[test]
fn extrude_two_sides_draft_and_up_to_a_face() {
    // A 10 mm cube, 1000 mm³, standing on Z = 0.
    let opened = call(json!({ "call": "open", "key": "k3", "box": [10.0, 10.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return;
    }
    near(volume(&opened), 1000.0);

    // The same square, no new fields: the chimney the plain extrude already builds, and the op stored without them.
    let plain = json!({
        "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0],
        "profile": square(), "depth": 10.0,
    });
    let chimney = apply("k3", 0, 1, &plain);
    near(volume(&chimney), 2000.0);
    assert!(chimney["op"].get("depth2").is_none(), "{}", chimney["op"]);
    assert!(chimney["op"].get("draftDeg").is_none(), "{}", chimney["op"]);
    assert!(chimney["op"].get("upTo").is_none(), "{}", chimney["op"]);

    // Draft 5° on that 10 mm square, pushed 10 mm. The far end is smaller by 10 tan 5° on each side.
    // a2 = 10 - 2 * 10 * tan 5°. Volume = h/3 * (a² + a2² + a*a2), added on the cube it sits on.
    let theta = 5.0 * PI / 180.0;
    let far = 10.0 - 2.0 * 10.0 * theta.tan();
    let frustum = 10.0 / 3.0 * (100.0 + far * far + 10.0 * far);
    let mut drafted = plain.clone();
    drafted["draftDeg"] = json!(5.0);
    let boss = apply("k3", 0, 2, &drafted);
    near(volume(&boss), 1000.0 + frustum);
    assert_eq!(boss["op"]["draftDeg"], json!(5.0));
    assert!(boss["op"].get("depth2").is_none(), "{}", boss["op"]);

    // A negative angle grows the far end. Convex corners are rounded: at height z the offset is
    // d = z tan|θ|, and a square's rounded outline has area a² + 4 a d + π d². Integrated, that is
    // h (a² + 2 a r + π r² / 3) with r = h tan|θ|.
    let radius = 10.0 * theta.tan();
    let grown_volume = 10.0 * (100.0 + 2.0 * 10.0 * radius + PI * radius * radius / 3.0);
    let mut opened_out = plain.clone();
    opened_out["draftDeg"] = json!(-5.0);
    near(volume(&apply("k3", 0, 3, &opened_out)), 1000.0 + grown_volume);

    // Two-sided, straight walls, from the bottom face: 4 mm below Z = 0 and 10 mm up. The prism is
    // 10 × 10 × 14 and contains the cube, so the union is the prism, 1400 mm³.
    let both = json!({
        "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 0.0],
        "profile": square(), "depth": 10.0, "depth2": 4.0,
    });
    let through = apply("k3", 0, 4, &both);
    near(volume(&through), 1400.0);
    assert_eq!(through["op"]["depth2"], json!(4.0));

    // Up to the slant of a 40 × 20 × 20 wedge with no top length. The slant is z = 20 - 0.5 x, and the solid
    // is 8000 mm³. A 16 × 16 rectangle at z = 1, x from 8 to 24 and y from 2 to 18, cut upward until the slant.
    // The height left under the slant is 19 - 0.5 x, so the cut is ∫_8^24 16 (19 - 0.5 x) dx = 2816.
    let wedge = call(json!({
        "call": "open", "key": "ramp",
        "primitive": { "primitive": "wedge", "origin": [0.0, 0.0, 0.0], "size": [40.0, 20.0, 20.0], "topX": 0.0 },
    }));
    near(volume(&wedge), 8000.0);
    let face = slant(&wedge);
    let cut = json!({
        "kind": "extrude", "op": "cut", "origin": [0.0, 0.0, 1.0],
        "profile": [[8.0, 2.0], [24.0, 2.0], [24.0, 18.0], [8.0, 18.0]],
        "depth": 1.0, "upTo": face,
    });
    let pocket = apply("ramp", 0, 1, &cut);
    near(volume(&pocket), 8000.0 - 2816.0);
    let stored = &pocket["op"]["upTo"];
    assert_eq!(stored["index"], json!(face), "{stored}");
    assert!(stored["mid"].is_array() && stored["areaMm2"].is_number(), "{stored}");

    // The same pocket, rebuilt from the stored face, is the same solid.
    let saved = json!([{ "id": 1, "parent": 0, "op": pocket["op"], "fingerprint": pocket["fingerprint"] }]);
    let again = call(json!({
        "call": "open", "key": "ramp2",
        "primitive": { "primitive": "wedge", "origin": [0.0, 0.0, 0.0], "size": [40.0, 20.0, 20.0], "topX": 0.0 },
        "nodes": saved, "current": 1,
    }));
    near(volume(&again), volume(&pocket));

    // Refusals, each one sentence.
    refused(
        &apply("k3", 0, 90, &json!({
            "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square(), "depth": 10.0, "draftDeg": 90.0,
        })),
        "A draft angle must be between -89 and 89 degrees.",
    );
    refused(
        &apply("k3", 0, 90, &json!({
            "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square(), "depth": 10.0, "draftDeg": 30.0,
        })),
        "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.",
    );
    refused(
        &apply("k3", 0, 90, &json!({
            "kind": "extrude", "op": "fuse", "origin": [0.0, 0.0, 10.0], "profile": square(), "depth": 10.0, "depth2": 0.0,
        })),
        "The second depth is a distance on the other side of the plane, above 0.",
    );
    let mut centred = both.clone();
    centred["symmetric"] = json!(true);
    refused(
        &apply("k3", 0, 90, &centred),
        "An extrude is centred, or it has a second depth, not both.",
    );
    let mut with_draft = cut.clone();
    with_draft["draftDeg"] = json!(5.0);
    refused(
        &apply("ramp", 0, 90, &with_draft),
        "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth.",
    );
    let mut with_side = cut.clone();
    with_side["depth2"] = json!(2.0);
    refused(
        &apply("ramp", 0, 90, &with_side),
        "An extrude up to a face starts at the profile. Drop the second depth.",
    );
    let mut centred_face = cut.clone();
    centred_face["symmetric"] = json!(true);
    refused(
        &apply("ramp", 0, 90, &centred_face),
        "An extrude up to a face starts at the profile. Leave centred off.",
    );
    let mut missing = cut.clone();
    missing["upTo"] = json!(40);
    refused(&apply("ramp", 0, 90, &missing), "That face is not on this solid.");
}
