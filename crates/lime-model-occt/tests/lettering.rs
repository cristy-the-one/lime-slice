//! Lettering from real fonts on a flat face (docs/plan-text-on-curves-and-fonts.md, milestone 1).
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.

use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

/// A 40 x 20 x 10 block opened under `key`, or None when the kernel is not linked.
fn block(key: &str) -> Option<Value> {
    let opened = call(json!({ "call": "open", "key": key, "box": [40.0, 20.0, 10.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        return None;
    }
    Some(opened)
}

/// The op: lettering on the block's top face (z = 10), its middle at (u, v) from the face's centre.
fn lettering(op: &str, text: &str, font: &str, height: f64, depth: f64) -> Value {
    json!({
        "kind": "lettering", "op": op, "origin": [20.0, 10.0, 10.0], "turn": [0.0, 0.0, 0.0],
        "text": text, "font": font, "height": height, "depth": depth,
    })
}

fn with(mut op: Value, field: &str, value: Value) -> Value {
    op[field] = value;
    op
}

/// The ink the laid-out text covers, mm2, as the engine's own layout call reports it.
fn ink(op: &Value) -> f64 {
    let mut request = json!({ "call": "textLayout" });
    for key in [
        "text",
        "font",
        "style",
        "height",
        "spacing",
        "lineSpacing",
        "align",
        "angleDeg",
    ] {
        if let Some(value) = op.get(key) {
            request[key] = value.clone();
        }
    }
    let reply = call(request);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    reply["inkMm2"].as_f64().expect("inkMm2")
}

fn probe(key: &str, op: &Value) -> Value {
    call(json!({ "call": "probe", "key": key, "node": 0, "op": op }))
}

#[track_caller]
fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

#[test]
fn raised_letters_are_a_valid_closed_solid_whose_volume_is_ink_times_depth() {
    let Some(_) = block("lt-raise") else { return };
    // The letters with holes: A, O, 8, g, B, e. Every bundled family.
    for (font, style) in [
        ("sans", None),
        ("sans", Some("bold")),
        ("sans", Some("italic")),
        ("mono", None),
        ("serif", Some("bold")),
        ("stencil", None),
    ] {
        let mut op = lettering("fuse", "AO8gBe", font, 5.0, 0.8);
        if let Some(style) = style {
            op = with(op, "style", json!(style));
        }
        let reply = probe("lt-raise", &op);
        assert_eq!(reply["ok"], json!(true), "{font} {style:?}: {reply}");
        assert_eq!(reply["solids"], json!(1), "{font} {style:?}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{font} {style:?}: {reply}");
        assert_eq!(
            reply["text"]["build"],
            json!("direct"),
            "{font} {style:?} is built without a boolean: {reply}"
        );
        let added = reply["volumeMm3"].as_f64().unwrap() - 8000.0;
        near(added, ink(&op) * 0.8, 0.01);
    }
}

#[test]
fn engraved_letters_take_ink_times_depth_out() {
    let Some(_) = block("lt-cut") else { return };
    let op = lettering("cut", "A O 8 g", "sans", 6.0, 0.8);
    let reply = probe("lt-cut", &op);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["solids"], json!(1), "{reply}");
    assert_eq!(reply["shells"], json!(1), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    let taken = 8000.0 - reply["volumeMm3"].as_f64().unwrap();
    near(taken, ink(&op) * 0.8, 0.01);
}

#[test]
fn the_direct_build_leaves_every_other_face_the_face_it_was() {
    let Some(_) = block("lt-faces") else { return };
    let op = lettering("fuse", "LIME", "sans", 6.0, 1.0);
    let applied =
        call(json!({ "call": "apply", "key": "lt-faces", "parent": 0, "node": 1, "op": op }));
    assert!(applied.get("error").is_none(), "{applied}");
    assert_eq!(applied["text"]["build"], json!("direct"));
    let owners = applied["stepFaces"].as_array().expect("stepFaces");
    // The five faces the text is not on, and the top it replaced, are the block's; every letter face is this step's.
    assert_eq!(
        owners.iter().filter(|o| o.as_u64() == Some(0)).count(),
        6,
        "{owners:?}"
    );
    assert!(owners.iter().filter(|o| o.as_u64() == Some(1)).count() > 20);
    let faces = applied["faces"].as_array().unwrap();
    for (face, owner) in faces.iter().zip(owners) {
        if owner.as_u64() == Some(0) && face["normal"][2].as_f64().unwrap_or(0.0) < 0.5 {
            // A side or the bottom: untouched.
            assert!(face["areaMm2"].as_f64().unwrap() >= 200.0 - 1e-6, "{face}");
        }
    }
    // The stored op names the font with its version.
    assert_eq!(applied["op"]["font"], json!("sans@4.0"));
    assert_eq!(applied["op"]["kind"], json!("lettering"));
}

#[test]
fn lines_alignment_spacing_and_angle_all_build() {
    let Some(_) = block("lt-layout") else { return };
    let base = lettering("fuse", "LINE ONE\nLINE 2", "sans", 4.0, 0.6);
    for (field, value) in [
        ("align", json!("left")),
        ("align", json!("right")),
        ("align", json!("centre")),
        ("spacing", json!(0.5)),
        ("lineSpacing", json!(1.6)),
        ("angleDeg", json!(20.0)),
        ("style", json!("bold-italic")),
    ] {
        let mut op = with(base.clone(), field, value.clone());
        // Left starts at the anchor and right ends on it.
        if value == json!("left") {
            op = with(op, "origin", json!([7.0, 10.0, 10.0]));
        } else if value == json!("right") {
            op = with(op, "origin", json!([33.0, 10.0, 10.0]));
        }
        let reply = probe("lt-layout", &op);
        assert_eq!(reply["ok"], json!(true), "{field} {value}: {reply}");
        let added = reply["volumeMm3"].as_f64().unwrap() - 8000.0;
        near(added, ink(&op) * 0.6, 0.01);
    }
    // Two lines turned a quarter are still one solid.
    let turned = with(
        lettering(
            "fuse", "AB
CD", "sans", 4.0, 0.6,
        ),
        "angleDeg",
        json!(90.0),
    );
    let reply = probe("lt-layout", &turned);
    assert_eq!(reply["solids"], json!(1), "{reply}");
}

#[test]
fn a_cut_through_the_wall_goes_through_where_no_letter_would_lose_its_middle() {
    let Some(_) = block("lt-through") else { return };
    // Letters without a counter cut through, built by the boolean.
    let op = lettering("cut", "LI", "sans", 6.0, 12.0);
    let reply = probe("lt-through", &op);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["text"]["build"], json!("boolean"), "{reply}");
    assert_eq!(reply["solids"], json!(1), "{reply}");
    assert!(
        reply["text"]["booleanBecause"]
            .as_str()
            .unwrap()
            .contains("through the wall"),
        "{reply}"
    );
    near(
        8000.0 - reply["volumeMm3"].as_f64().unwrap(),
        ink(&op) * 10.0,
        0.05,
    );
    // An O would lose its middle: refused, pointing at Stencil.
    let refused = probe("lt-through", &lettering("cut", "O", "sans", 6.0, 12.0));
    assert_eq!(refused["ok"], json!(false), "{refused}");
    assert_eq!(
        refused["error"],
        json!("The middle of ‘O’ would fall out. Use the Stencil font, or engrave less deep."),
        "{refused}"
    );
    // Engraved shallower than the wall, the same O is fine.
    let fine = probe("lt-through", &lettering("cut", "O", "sans", 6.0, 9.0));
    assert_eq!(fine["ok"], json!(true), "{fine}");
    assert_eq!(fine["text"]["build"], json!("direct"));
    // The stencil O has its bridges, so no middle is left to fall out.
    let stencil = probe("lt-through", &lettering("cut", "OA8", "stencil", 6.0, 12.0));
    assert_eq!(stencil["ok"], json!(true), "{stencil}");
    assert_eq!(stencil["solids"], json!(1), "{stencil}");
}

#[test]
fn text_that_runs_off_the_face_is_refused_in_a_sentence() {
    let Some(_) = block("lt-off") else { return };
    let op = with(
        lettering("fuse", "LONG TEXT RUNS OFF", "sans", 6.0, 1.0),
        "origin",
        json!([36.0, 10.0, 10.0]),
    );
    let reply = probe("lt-off", &op);
    assert_eq!(reply["ok"], json!(false), "{reply}");
    assert_eq!(
        reply["error"],
        json!("The text runs off this face. Move it, make it smaller, or put it on one face."),
        "{reply}"
    );
}

#[test]
fn a_letter_the_font_lacks_a_bad_font_and_a_missing_bold_are_sentences() {
    let Some(_) = block("lt-refuse") else { return };
    let reply = probe("lt-refuse", &lettering("fuse", "Lime 日", "sans", 6.0, 1.0));
    assert_eq!(
        reply["error"],
        json!("This font has no ‘日’. Pick another font, or take it out."),
        "{reply}"
    );
    let reply = probe("lt-refuse", &lettering("fuse", "Lime", "comic", 6.0, 1.0));
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("There is no font called ‘comic’"),
        "{reply}"
    );
    let reply = probe(
        "lt-refuse",
        &with(
            lettering("fuse", "Lime", "stencil", 6.0, 1.0),
            "style",
            json!("bold"),
        ),
    );
    assert_eq!(
        reply["error"],
        json!("‘Allerta Stencil’ has no bold. Pick Regular, or another font."),
        "{reply}"
    );
    let reply = probe("lt-refuse", &lettering("fuse", "   ", "sans", 6.0, 1.0));
    assert!(
        reply["error"].as_str().unwrap().contains("no letters"),
        "{reply}"
    );
    let reply = probe("lt-refuse", &lettering("fuse", "Lime", "sans", 6.0, 0.0));
    assert!(
        reply["error"].as_str().unwrap().contains("depth"),
        "{reply}"
    );
    let reply = probe("lt-refuse", &lettering("common", "Lime", "sans", 6.0, 1.0));
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("raised (fuse) or engraved (cut)"),
        "{reply}"
    );
}

#[test]
fn text_on_a_side_face_follows_the_face_turn() {
    let Some(_) = block("lt-side") else { return };
    // The +X face (x = 40): a plane turned 90 degrees about Y has W along +X, U along -Z.
    let op = json!({
        "kind": "lettering", "op": "fuse", "origin": [40.0, 10.0, 5.0], "turn": [0.0, 90.0, 0.0],
        "text": "SI", "font": "sans", "height": 4.0, "depth": 0.5,
    });
    let reply = probe("lt-side", &op);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["text"]["build"], json!("direct"), "{reply}");
    near(
        reply["volumeMm3"].as_f64().unwrap() - 8000.0,
        ink(&op) * 0.5,
        0.01,
    );
}

#[test]
fn a_text_step_replays_from_a_saved_node_to_the_same_solid() {
    let Some(_) = block("lt-replay") else { return };
    let source = json!({ "kind": "text", "text": "LIME", "font": "sans" });
    let group = json!({ "kind": "group", "label": "Text LIME", "source": source, "steps": [lettering("fuse", "LIME", "sans@4.0", 6.0, 1.0)] });
    let applied =
        call(json!({ "call": "apply", "key": "lt-replay", "parent": 0, "node": 1, "op": group }));
    assert!(applied.get("error").is_none(), "{applied}");
    assert_eq!(applied["op"]["source"], source);
    let reopened = call(json!({
        "call": "open", "key": "lt-replay2", "box": [40.0, 20.0, 10.0], "current": 1,
        "nodes": [{ "id": 1, "parent": 0, "op": applied["op"], "fingerprint": applied["fingerprint"] }],
    }));
    assert!(reopened.get("error").is_none(), "{reopened}");
    assert_eq!(
        reopened["fingerprint"], applied["fingerprint"],
        "{reopened}"
    );
    // Again with the font named without its version: the same bytes, the same solid.
    let bare = json!({ "kind": "group", "label": "Text LIME", "steps": [lettering("fuse", "LIME", "sans", 6.0, 1.0)] });
    let again = call(json!({ "call": "probe", "key": "lt-replay", "node": 0, "op": bare }));
    near(
        again["volumeMm3"].as_f64().unwrap(),
        applied["volumeMm3"].as_f64().unwrap(),
        1e-6,
    );
}

#[test]
fn the_layout_call_answers_outlines_and_the_letters_too_thin_for_the_nozzle() {
    let request = json!({ "call": "textLayout", "text": "Hi 8", "font": "sans", "height": 6.0, "stepMm": 0.1 });
    let reply = call(request);
    if reply.get("error").is_some() && !require() {
        return;
    }
    assert_eq!(reply["ok"], json!(true), "{reply}");
    assert_eq!(reply["font"], json!("sans@4.0"));
    let faces = reply["faces"].as_array().unwrap();
    // H, i (stem and dot), 8.
    assert_eq!(faces.len(), 4, "{reply}");
    let eight = faces.iter().find(|f| f["ch"] == "8").expect("an 8");
    assert_eq!(
        eight["loops"].as_array().unwrap().len(),
        3,
        "an 8 is an outline and two counters"
    );
    assert!(reply["thin"].as_array().unwrap().is_empty());
    assert!(reply["thinNote"].is_null());
    assert!(reply["bounds"].as_array().unwrap().len() == 4);
    // The same text far smaller names the letters that will not print.
    let small = call(
        json!({ "call": "textLayout", "text": "Lime", "font": "serif", "height": 1.5, "lineMm": 0.4 }),
    );
    let names: Vec<&str> = small["thin"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["ch"].as_str().unwrap())
        .collect();
    assert!(!names.is_empty(), "{small}");
    assert!(
        small["thinNote"]
            .as_str()
            .unwrap()
            .contains("thinner than your 0.4 mm line"),
        "{small}"
    );
    assert!(small["faces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["thin"] == json!(true)));
    // A letter the font lacks is the same sentence.
    let missing =
        call(json!({ "call": "textLayout", "text": "日", "font": "sans", "height": 6.0 }));
    assert_eq!(
        missing["error"],
        json!("This font has no ‘日’. Pick another font, or take it out.")
    );
}

#[test]
fn the_font_list_names_every_bundled_font_and_its_styles() {
    let reply = call(json!({ "call": "textFonts" }));
    if reply.get("error").is_some() && !require() {
        return;
    }
    let fonts = reply["fonts"].as_array().unwrap();
    let ids: Vec<&str> = fonts.iter().map(|f| f["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["sans@4.0", "mono@1", "serif@1", "stencil@1"]);
    let sans = &fonts[0];
    assert_eq!(
        (
            sans["regular"].as_bool(),
            sans["bold"].as_bool(),
            sans["italic"].as_bool(),
            sans["boldItalic"].as_bool()
        ),
        (Some(true), Some(true), Some(true), Some(true))
    );
    let stencil = &fonts[3];
    assert_eq!(stencil["bold"], json!(false));
}

/// A CFF OpenType font (cubic outlines), known to debug builds only as `test-cff`.
#[test]
fn letters_from_a_cff_font_build_valid_and_closed_too() {
    let Some(_) = block("lt-cff") else { return };
    let probe_cff = |op: &str| probe("lt-cff", &lettering(op, "AO8gBe", "test-cff", 5.0, 0.8));
    let raised = probe_cff("fuse");
    if raised["error"]
        .as_str()
        .is_some_and(|e| e.contains("There is no font called"))
    {
        // A release build ships no test font.
        return;
    }
    for (name, reply, sign) in [
        ("raised", raised, 1.0),
        ("engraved", probe_cff("cut"), -1.0),
    ] {
        assert_eq!(reply["ok"], json!(true), "{name}: {reply}");
        assert_eq!(reply["solids"], json!(1), "{name}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{name}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{name}: {reply}");
        let ink = ink(&lettering("fuse", "AO8gBe", "test-cff", 5.0, 0.8));
        near(
            reply["volumeMm3"].as_f64().unwrap() - 8000.0,
            sign * ink * 0.8,
            0.01,
        );
    }
}

// --- Text milestone 4: the person's own fonts. The fonts are built in code (debug builds only), so no font file of anyone's is
// in the repository.

/// A font built in code and added to the engine, or None in a build that has no test fonts. Answers its info.
fn added_font(family: &str, fs_type: u16, variable: Option<[f64; 2]>) -> Option<Value> {
    let mut request = json!({ "call": "textTestFont", "family": family, "fsType": fs_type });
    if let Some(range) = variable {
        request["variable"] = json!(range);
    }
    let made = call(request);
    let data = made.get("dataB64")?.as_str()?.to_string();
    let info = call(json!({ "call": "textFontAdd", "dataB64": data }));
    assert_eq!(info["ok"], json!(true), "{info}");
    Some(info)
}

fn weighted_ink(op: &Value) -> f64 {
    let mut request = json!({ "call": "textLayout" });
    for key in [
        "text",
        "font",
        "style",
        "height",
        "spacing",
        "lineSpacing",
        "align",
        "angleDeg",
        "weight",
    ] {
        if let Some(value) = op.get(key) {
            request[key] = value.clone();
        }
    }
    let reply = call(request);
    assert_eq!(reply["ok"], json!(true), "{reply}");
    reply["inkMm2"].as_f64().expect("inkMm2")
}

#[test]
fn letters_from_a_font_the_person_added_build_valid_closed_and_direct() {
    let Some(_) = block("lt-user") else { return };
    let Some(info) = added_font("Integration Sans", 0, None) else {
        return;
    };
    let id = info["id"].as_str().unwrap();
    for op in ["fuse", "cut"] {
        let letters = lettering(op, "H O", id, 5.0, 0.8);
        let reply = probe("lt-user", &letters);
        assert_eq!(reply["ok"], json!(true), "{op}: {reply}");
        assert_eq!(reply["solids"], json!(1), "{op}: {reply}");
        assert_eq!(reply["shells"], json!(1), "{op}: {reply}");
        assert_eq!(reply["text"]["build"], json!("direct"), "{op}: {reply}");
        // The font is stored by its id; the volume is the ink times the depth.
        assert_eq!(reply["text"]["font"], json!(id));
        let sign = if op == "fuse" { 1.0 } else { -1.0 };
        near(
            reply["volumeMm3"].as_f64().unwrap() - 8000.0,
            sign * ink(&letters) * 0.8,
            0.01,
        );
    }
    // The stored step names the font by id, so a rebuild finds the same bytes.
    let applied = call(
        json!({ "call": "apply", "key": "lt-user", "parent": 0, "node": 1, "op": lettering("fuse", "HO", id, 5.0, 0.8) }),
    );
    assert!(applied.get("error").is_none(), "{applied}");
    assert_eq!(applied["op"]["font"], json!(id));
}

#[test]
fn a_restricted_font_rebuilds_from_the_pack_of_its_letters_to_the_same_solid() {
    let Some(_) = block("lt-pack") else { return };
    let Some(info) = added_font("Restricted Sans", 2, None) else {
        return;
    };
    assert_eq!(info["restricted"], json!(true));
    assert_eq!(info["embedding"], json!("outlines"));
    let id = info["id"].as_str().unwrap();
    let packed = call(json!({ "call": "textFontPack", "id": id, "uses": [{ "text": "HO-" }] }));
    assert_eq!(packed["ok"], json!(true), "{packed}");
    assert_eq!(packed["letters"], json!("-HO"));
    // The pack as another computer would hold it: only the pack, under an id the engine has no file for.
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(packed["dataB64"].as_str().unwrap())
        .unwrap();
    let mut pack: Value = serde_json::from_slice(&bytes).unwrap();
    pack["id"] = json!("user:00000000deadbeef");
    pack["sha256"] = json!("0".repeat(64));
    let added = call(
        json!({ "call": "textFontAdd", "dataB64": base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&pack).unwrap()) }),
    );
    assert_eq!(added["ok"], json!(true), "{added}");
    assert_eq!(added["pack"], json!(true));
    assert_eq!(added["letters"], json!("-HO"));
    let (whole, packed_op) = (
        lettering("fuse", "H O-", id, 5.0, 0.8),
        lettering("fuse", "H O-", "user:00000000deadbeef", 5.0, 0.8),
    );
    let (a, b) = (probe("lt-pack", &whole), probe("lt-pack", &packed_op));
    assert_eq!(b["ok"], json!(true), "{b}");
    near(
        b["volumeMm3"].as_f64().unwrap(),
        a["volumeMm3"].as_f64().unwrap(),
        1e-6,
    );
    assert_eq!(
        (b["solids"].clone(), b["shells"].clone()),
        (json!(1), json!(1))
    );
    // A letter the pack does not hold is refused in a sentence naming it.
    let more = probe(
        "lt-pack",
        &lettering("fuse", "HI", "user:00000000deadbeef", 5.0, 0.8),
    );
    let said = more["error"].as_str().unwrap_or_default();
    assert!(
        said.contains("with only the letters it was used for") && said.contains("‘I’"),
        "{more}"
    );
}

#[test]
fn a_variable_fonts_weight_changes_the_ink_and_the_solid() {
    let Some(_) = block("lt-weight") else { return };
    let Some(info) = added_font("Integration Variable", 0, Some([400.0, 800.0])) else {
        return;
    };
    assert_eq!(info["weight"]["max"], json!(800.0));
    let id = info["id"].as_str().unwrap();
    let mut volumes = Vec::new();
    for weight in [400.0, 600.0, 800.0] {
        let op = with(
            lettering("fuse", "HI", id, 5.0, 0.8),
            "weight",
            json!(weight),
        );
        let reply = probe("lt-weight", &op);
        assert_eq!(reply["ok"], json!(true), "{weight}: {reply}");
        near(
            reply["volumeMm3"].as_f64().unwrap() - 8000.0,
            weighted_ink(&op) * 0.8,
            0.01,
        );
        volumes.push(reply["volumeMm3"].as_f64().unwrap());
    }
    assert!(
        volumes[0] < volumes[1] && volumes[1] < volumes[2],
        "{volumes:?}"
    );
    let applied = call(
        json!({ "call": "apply", "key": "lt-weight", "parent": 0, "node": 1, "op": with(lettering("fuse", "HI", id, 5.0, 0.8), "weight", json!(700.0)) }),
    );
    assert_eq!(applied["op"]["weight"], json!(700.0), "{applied}");
    let outside = probe(
        "lt-weight",
        &with(
            lettering("fuse", "HI", id, 5.0, 0.8),
            "weight",
            json!(900.0),
        ),
    );
    assert_eq!(
        outside["error"],
        json!("‘Integration Variable Regular’ takes weights 400 to 800.")
    );
}

#[test]
fn the_refusals_for_a_font_the_person_added_are_one_sentence_each() {
    let Some(_) = block("lt-refuse") else { return };
    let Some(info) = added_font("Refusal Sans", 0, None) else {
        return;
    };
    let id = info["id"].as_str().unwrap();
    let missing = probe("lt-refuse", &lettering("fuse", "HÑÉ", id, 5.0, 0.8));
    assert_eq!(
        missing["error"],
        json!("This font has no ‘Ñ’ and ‘É’. Pick another font, or take them out.")
    );
    let bold = probe(
        "lt-refuse",
        &with(lettering("fuse", "H", id, 5.0, 0.8), "style", json!("bold")),
    );
    assert_eq!(
        bold["error"],
        json!("‘Refusal Sans Regular’ has no bold. Pick Regular, or another font.")
    );
    let gone = probe(
        "lt-refuse",
        &lettering("fuse", "H", "user:ffffffffffffffff", 5.0, 0.8),
    );
    assert!(
        gone["error"]
            .as_str()
            .unwrap()
            .contains("not on this computer"),
        "{gone}"
    );
    let junk = call(json!({ "call": "textFontAdd", "dataB64": "aGVsbG8gd29ybGQ=" }));
    assert_eq!(junk["error"], json!("This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file."));
}
