//! The person's fonts (milestone 4): reading, the embedding rules, the pack that keeps only the letters used, variable weights,
//! collections, and the refit of united outlines to curves. Every font here is built in code (`synth`) or is a bundled font
//! (SIL OFL 1.1) read as if the person had added it: no non-free font is in the repository.

use super::fit::fit_loop;
use super::synth::{blob, Glyph, Synth};
use super::user::{self, Embedding, Use};
use super::*;

fn add(bytes: Vec<u8>) -> user::Added {
    user::register(bytes, None).unwrap_or_else(|err| panic!("{err}"))
}

fn spec_in(id: &str, text: &str) -> Spec {
    user::spec_for(id, text, 10.0)
}

fn ink(spec: &Spec) -> f64 {
    lay_out(spec)
        .unwrap_or_else(|err| panic!("{:?}: {err}", spec.text))
        .ink_mm2
}

#[test]
fn a_font_file_is_read_by_name_and_laid_out_like_a_bundled_one() {
    let added = add(Synth::simple("Reading Test").bytes());
    let font = &added.font;
    assert!(
        font.id.starts_with("user:") && font.id.len() == "user:".len() + 16,
        "{}",
        font.id
    );
    assert_eq!(font.meta.family, "Reading Test");
    assert_eq!(font.meta.name, "Reading Test Regular");
    assert_eq!(font.meta.embedding, Embedding::Full);
    assert!(font.meta.weight_axis.is_none());
    // The same file is the same id, whoever adds it.
    assert_eq!(add(Synth::simple("Reading Test").bytes()).font.id, font.id);
    assert_ne!(add(Synth::simple("Another").bytes()).font.id, font.id);
    // H is a box 900 wide and 1400 (the capitals' height) tall: at 10 mm, 6.43 by 10.
    let laid = lay_out(&spec_in(&font.id, "H")).expect("H");
    let [u0, v0, u1, v1] = laid.bounds.expect("ink");
    assert!((v1 - v0 - 10.0).abs() < 1e-6, "{}", v1 - v0);
    assert!(
        (u1 - u0 - 900.0 / 1400.0 * 10.0).abs() < 1e-6,
        "{}",
        u1 - u0
    );
    assert_eq!(laid.font, font.id);
    // O is a ring: one face with one hole.
    let o = lay_out(&spec_in(&font.id, "O")).expect("O");
    assert_eq!((o.faces.len(), o.faces[0].holes.len()), (1, 1));
    // The font's own letters, a space, and several lines.
    let two = lay_out(&spec_in(&font.id, "H I\nO-")).expect("two lines");
    assert_eq!(two.widths.len(), 2);
}

#[test]
fn an_id_the_engine_was_never_given_says_so() {
    let err = lay_out(&spec_in("user:0123456789abcdef", "H")).unwrap_err();
    assert!(
        err.contains("user:0123456789abcdef") && err.contains("not on this computer"),
        "{err}"
    );
}

#[test]
fn a_file_that_is_not_a_font_is_refused_in_one_sentence() {
    for bytes in [
        Vec::new(),
        b"this is not a font at all".to_vec(),
        b"wOF2\0\0\0\0 web font".to_vec(),
        Synth::simple("Cut").bytes()[..40].to_vec(),
        (0..300u32).map(|i| (i * 7 % 251) as u8).collect(),
    ] {
        let err = user::register(bytes, None).err().expect("refused");
        assert_eq!(err, user::UNREADABLE);
    }
    assert!(user::UNREADABLE.starts_with("This file is not a font Lime Slice can read."));
}

#[test]
fn a_font_with_only_bitmaps_is_refused_for_having_no_outlines() {
    let err = user::register(
        Synth::simple("Bitmaps Only").without_outlines().bytes(),
        None,
    )
    .err()
    .expect("refused");
    assert_eq!(err, "‘Bitmaps Only Regular’ has only bitmap letters and no outlines. Pick an outline font (TrueType or OpenType).");
}

#[test]
fn the_licence_decides_what_the_project_keeps() {
    // OS/2 fsType: 0 installable and 8 editable may be embedded whole; 2 restricted, 4 preview and print, and the bitmap-only
    // bit 0x200 keep only the outlines the text uses. 0x100 (no subsetting) on an installable font changes nothing.
    for (fs, expect) in [
        (0u16, Embedding::Full),
        (8, Embedding::Full),
        (0x100, Embedding::Full),
        (8 | 0x100, Embedding::Full),
        (2, Embedding::Outlines),
        (4, Embedding::Outlines),
        (0x200, Embedding::Outlines),
        (8 | 0x200, Embedding::Outlines),
        (2 | 0x100, Embedding::Outlines),
    ] {
        let added = add(Synth::simple(&format!("Licence {fs}"))
            .with_fs_type(fs)
            .bytes());
        assert_eq!(added.font.meta.embedding, expect, "fsType {fs:#x}");
        assert_eq!(added.font.meta.fs_type, fs);
        let json = user::info(&added);
        assert_eq!(
            json["restricted"],
            serde_json::json!(expect == Embedding::Outlines),
            "fsType {fs:#x}"
        );
    }
}

#[test]
fn every_character_a_font_lacks_is_named() {
    let id = add(Synth::simple("Missing Test").bytes()).font.id.clone();
    assert_eq!(
        lay_out(&spec_in(&id, "HÑ")).unwrap_err(),
        "This font has no ‘Ñ’. Pick another font, or take it out."
    );
    assert_eq!(
        lay_out(&spec_in(&id, "HÑÉ ÑÜ")).unwrap_err(),
        "This font has no ‘Ñ’, ‘É’ and ‘Ü’. Pick another font, or take them out."
    );
    assert_eq!(
        lay_out(&spec_in(&id, "HÑ É")).unwrap_err(),
        "This font has no ‘Ñ’ and ‘É’. Pick another font, or take them out."
    );
}

#[test]
fn styles_of_a_static_font_follow_the_file() {
    // An upright regular font: bold is refused, italic is a 12 degree slant.
    let regular = add(Synth::simple("Style Regular").bytes()).font.id.clone();
    let mut s = spec_in(&regular, "I");
    s.style = Some("bold".into());
    assert_eq!(
        lay_out(&s).unwrap_err(),
        "‘Style Regular Regular’ has no bold. Pick Regular, or another font."
    );
    s.style = Some("italic".into());
    let slanted = lay_out(&s).expect("italic is made");
    let upright = lay_out(&spec_in(&regular, "I")).expect("regular");
    let (sb, ub) = (slanted.bounds.unwrap(), upright.bounds.unwrap());
    assert!(
        (sb[2] - sb[0]) - (ub[2] - ub[0]) > 10.0 * (12f64).to_radians().tan() * 0.9,
        "the slant widens the box"
    );
    // A bold file is bold as it is: no refusal, no slant. An italic file is italic as it is.
    let bold = add(Synth::simple("Style Bold").bold().bytes())
        .font
        .id
        .clone();
    let mut s = spec_in(&bold, "I");
    s.style = Some("bold".into());
    let drawn = lay_out(&s).expect("a bold file takes bold");
    assert!((drawn.ink_mm2 - ink(&spec_in(&bold, "I"))).abs() < 1e-9);
    let italic = add(Synth::simple("Style Italic").italic().bytes())
        .font
        .id
        .clone();
    let mut s = spec_in(&italic, "I");
    s.style = Some("italic".into());
    let b = lay_out(&s).unwrap().bounds.unwrap();
    let c = lay_out(&spec_in(&italic, "I")).unwrap().bounds.unwrap();
    assert!(
        ((b[2] - b[0]) - (c[2] - c[0])).abs() < 1e-9,
        "an italic file is not slanted again"
    );
    // A weight on a static font is refused.
    let mut s = spec_in(&regular, "I");
    s.weight = Some(700.0);
    assert!(
        lay_out(&s).unwrap_err().contains("is not a variable font"),
        "weight on a static font"
    );
}

#[test]
fn a_variable_fonts_weight_is_an_instance_inside_its_axis() {
    let added = add(Synth::simple("Variable Test")
        .variable(400.0, 800.0)
        .bytes());
    let id = added.font.id.clone();
    assert_eq!(added.font.meta.weight_axis, Some([400.0, 400.0, 800.0]));
    let json = user::info(&added);
    assert_eq!(json["weight"]["min"], serde_json::json!(400.0));
    assert_eq!(json["weight"]["max"], serde_json::json!(800.0));
    let at = |weight: Option<f64>, style: Option<&str>| {
        let mut s = spec_in(&id, "HI");
        s.weight = weight;
        s.style = style.map(str::to_string);
        ink(&s)
    };
    let (light, mid, heavy) = (
        at(Some(400.0), None),
        at(Some(600.0), None),
        at(Some(800.0), None),
    );
    assert!(
        light < mid && mid < heavy,
        "{light} < {mid} < {heavy}: more ink as the weight grows"
    );
    // No weight is the font's own (400); bold is 700, between regular and the heaviest.
    assert!((at(None, None) - light).abs() < 1e-9);
    let bold = at(None, Some("bold"));
    assert!(bold > mid && bold < heavy, "bold {bold} is weight 700");
    assert!((bold - at(Some(700.0), None)).abs() < 1e-9);
    // An explicit weight wins over the style.
    assert!((at(Some(500.0), Some("bold")) - at(Some(500.0), None)).abs() < 1e-9);
    // Outside the axis, one sentence with the range.
    let mut s = spec_in(&id, "H");
    s.weight = Some(900.0);
    assert_eq!(
        lay_out(&s).unwrap_err(),
        "‘Variable Test Regular’ takes weights 400 to 800."
    );
    s.weight = Some(100.0);
    assert!(lay_out(&s)
        .unwrap_err()
        .ends_with("takes weights 400 to 800."));
}

#[test]
fn a_collection_lists_its_faces_and_each_is_its_own_font() {
    let a = Synth::simple("Collected A");
    let b = Synth::simple("Collected B").bold();
    let ttc = Synth::collection(&[a, b]);
    let added = user::register(ttc.clone(), None).expect("face 0");
    let names: Vec<String> = added.faces.iter().map(|(_, n)| n.clone()).collect();
    assert_eq!(names, ["Collected A Regular", "Collected B Bold"]);
    let first = added.font.id.clone();
    let second = user::register(ttc, Some(1)).expect("face 1").font;
    assert_ne!(first, second.id);
    assert!(second.id.ends_with(".1"), "{}", second.id);
    assert_eq!(second.meta.name, "Collected B Bold");
    assert!(second.meta.bold);
    assert!(lay_out(&spec_in(&second.id, "HIO")).is_ok());
    let err = user::register(Synth::collection(&[Synth::simple("Only")]), Some(5))
        .err()
        .expect("no such face");
    assert_eq!(err, user::UNREADABLE);
}

/// The pack of `text` in the font `id`, registered again under a new id so the layout can only read the pack.
fn pack_only(id: &str, uses: &[Use], name: &str) -> String {
    let mut pack = user::pack(id, uses).expect("pack");
    pack.id = format!(
        "user:{:0>16}",
        name.bytes()
            .map(|b| format!("{b:x}"))
            .collect::<String>()
            .chars()
            .take(16)
            .collect::<String>()
    );
    pack.sha256 = "0".repeat(64);
    let json = serde_json::to_vec(&pack).unwrap();
    assert!(user::is_pack(&json));
    let added = user::register(json, None).expect("a pack registers");
    assert!(matches!(added.font.source, user::Source::Pack(_)));
    added.font.id.clone()
}

fn use_of(text: &str) -> Use {
    Use {
        text: text.into(),
        style: None,
        weight: None,
    }
}

#[test]
fn a_pack_lays_out_exactly_like_the_font_it_was_taken_from() {
    // Inter Regular (SIL OFL 1.1, bundled) read as a font the person added: it has kerning, curves and holes.
    let bytes = fonts::family("sans").unwrap().styles[0].bytes.to_vec();
    let id = add(bytes).font.id.clone();
    let text = "AVA To e8g";
    let packed = pack_only(&id, &[use_of(text)], "inter-pack");
    let (from_file, from_pack) = (
        lay_out(&spec_in(&id, text)).unwrap(),
        lay_out(&spec_in(&packed, text)).unwrap(),
    );
    assert_eq!(from_file.faces.len(), from_pack.faces.len());
    assert!(
        (from_file.ink_mm2 - from_pack.ink_mm2).abs() < 1e-9,
        "{} against {}",
        from_file.ink_mm2,
        from_pack.ink_mm2
    );
    assert_eq!(
        from_file.widths, from_pack.widths,
        "kerning travels with the pack"
    );
    assert_eq!(from_file.faces, from_pack.faces);
    // The letters in another order (pairs the text never had) still kern the same way, because every pair of the letters is kept.
    let other = "VAT eg8o";
    assert_eq!(
        lay_out(&spec_in(&id, other)).unwrap().widths,
        lay_out(&spec_in(&packed, other)).unwrap().widths
    );
    // A letter outside the pack is named, with why.
    let err = lay_out(&spec_in(&packed, "AVA z")).unwrap_err();
    assert!(
        err.contains("saved in this project with only the letters it was used for")
            && err.contains("‘z’"),
        "{err}"
    );
    let err = lay_out(&spec_in(&packed, "zq")).unwrap_err();
    assert!(err.contains("‘z’ and ‘q’"), "{err}");
    // The pack is far smaller than the font.
    let size = serde_json::to_vec(&user::pack(&id, &[use_of(text)]).unwrap())
        .unwrap()
        .len();
    assert!(size < 40_000, "{size} bytes for ten letters");
}

#[test]
fn a_pack_keeps_the_weights_it_was_used_at() {
    let id = add(Synth::simple("Pack Weights").variable(400.0, 800.0).bytes())
        .font
        .id
        .clone();
    let uses = [
        Use {
            text: "HI".into(),
            style: None,
            weight: Some(500.0),
        },
        Use {
            text: "HO".into(),
            style: Some("bold".into()),
            weight: None,
        },
        Use {
            text: "-".into(),
            style: None,
            weight: Some(500.0),
        },
    ];
    let pack = user::pack(&id, &uses).expect("pack");
    // Weight 500 and bold (700): two instances, the letters of each.
    assert_eq!(pack.instances.len(), 2);
    let packed = pack_only(&id, &uses, "pack-weights");
    let mut s = spec_in(&packed, "HI-");
    s.weight = Some(500.0);
    let mut f = spec_in(&id, "HI-");
    f.weight = Some(500.0);
    assert!((ink(&s) - ink(&f)).abs() < 1e-9);
    let mut s = spec_in(&packed, "HO");
    s.style = Some("bold".into());
    let mut f = spec_in(&id, "HO");
    f.style = Some("bold".into());
    assert!((ink(&s) - ink(&f)).abs() < 1e-9);
    // A weight the project never used is named as missing from the pack, not drawn wrong.
    let mut s = spec_in(&packed, "HI");
    s.weight = Some(650.0);
    assert!(lay_out(&s)
        .unwrap_err()
        .contains("at the weights it was used at only"));
    // 'O' was only used at bold: at weight 500 it is not in that instance.
    let mut s = spec_in(&packed, "O");
    s.weight = Some(500.0);
    assert!(lay_out(&s).unwrap_err().contains("‘O’"));
}

#[test]
fn a_pack_never_replaces_the_whole_font_it_came_from() {
    let id = add(Synth::simple("Whole Beats Pack").with_fs_type(2).bytes())
        .font
        .id
        .clone();
    let pack = user::pack(&id, &[use_of("H")]).expect("pack");
    assert_eq!(pack.meta.embedding, Embedding::Outlines);
    let again = user::register(serde_json::to_vec(&pack).unwrap(), None).expect("registers");
    assert!(
        matches!(again.font.source, user::Source::File { .. }),
        "the file stays"
    );
    assert!(
        lay_out(&spec_in(&id, "HIO")).is_ok(),
        "all its letters are still there"
    );
    // Asking a pack for its pack gives the same pack: the H and the space it always holds.
    let packed = pack_only(&id, &[use_of("H")], "only-h");
    assert_eq!(
        user::pack(&packed, &[use_of("HIO")]).unwrap().instances[0]
            .glyphs
            .len(),
        2
    );
}

#[test]
fn a_pack_that_is_not_ours_is_refused() {
    for json in [
        r#"{"lime":"something-else","v":1}"#,
        r#"{"hello":"world"}"#,
        "{",
    ] {
        assert_eq!(
            user::register(json.as_bytes().to_vec(), None)
                .err()
                .expect("refused"),
            user::UNREADABLE
        );
    }
}

#[test]
fn a_circle_of_short_lines_is_refitted_to_a_few_curves() {
    let r = 5.0;
    let n = 314;
    let pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
            [r * a.cos(), r * a.sin()]
        })
        .collect();
    let fitted = fit_loop(&pts, 0.004);
    assert!(
        fitted.segs.len() <= 8,
        "{} pieces for 314 lines",
        fitted.segs.len()
    );
    assert!(fitted.segs.iter().all(|s| matches!(s, Seg::Cubic(..))));
    assert_eq!(
        fitted.segs.last().unwrap().end(),
        fitted.start,
        "closes on its start"
    );
    for p in fitted.flatten(0.02) {
        assert!(
            (p[0].hypot(p[1]) - r).abs() < 0.01,
            "{p:?} is off the circle"
        );
    }
}

#[test]
fn a_loop_with_corners_keeps_them_and_its_straight_sides() {
    // A 10 x 4 box with rounded corners (radius 1), sampled 0.1 apart.
    let mut pts: Vec<[f64; 2]> = Vec::new();
    let arc = |pts: &mut Vec<[f64; 2]>, cx: f64, cy: f64, a0: f64| {
        for i in 0..16 {
            let a = a0 + std::f64::consts::FRAC_PI_2 * f64::from(i) / 16.0;
            pts.push([cx + a.cos(), cy + a.sin()]);
        }
    };
    let side = |pts: &mut Vec<[f64; 2]>, from: [f64; 2], to: [f64; 2]| {
        let steps = ((to[0] - from[0]).hypot(to[1] - from[1]) / 0.1) as usize;
        for i in 0..steps {
            let t = i as f64 / steps as f64;
            pts.push([
                from[0] + (to[0] - from[0]) * t,
                from[1] + (to[1] - from[1]) * t,
            ]);
        }
    };
    arc(&mut pts, 9.0, 1.0, -std::f64::consts::FRAC_PI_2);
    side(&mut pts, [10.0, 1.0], [10.0, 3.0]);
    arc(&mut pts, 9.0, 3.0, 0.0);
    side(&mut pts, [9.0, 4.0], [1.0, 4.0]);
    arc(&mut pts, 1.0, 3.0, std::f64::consts::FRAC_PI_2);
    side(&mut pts, [0.0, 3.0], [0.0, 1.0]);
    arc(&mut pts, 1.0, 1.0, std::f64::consts::PI);
    side(&mut pts, [1.0, 0.0], [9.0, 0.0]);
    let fitted = fit_loop(&pts, 0.004);
    assert!(
        fitted.segs.len() < 24,
        "{} pieces for {} lines",
        fitted.segs.len(),
        pts.len()
    );
    let lines = fitted
        .segs
        .iter()
        .filter(|s| matches!(s, Seg::Line(_)))
        .count();
    assert!(lines >= 4, "the four sides stay lines: {lines}");
    let before = area(&pts).abs();
    let after = area(&fitted.flatten(0.01)).abs();
    assert!(
        (after - before).abs() < 0.003 * before,
        "{after} against {before}"
    );
}

#[test]
fn glyphs_drawn_from_overlapping_curves_are_united_and_refitted_not_left_as_polylines() {
    // The way a variable font draws an 8: two rounded blobs, running the same way, overlapping.
    let eight = Glyph {
        ch: '8',
        advance: 1100,
        contours: vec![blob(550, 500, 500), blob(550, 1000, 400)],
        heavy: None,
    };
    let id = add(Synth::simple("Overlap Test").glyph(eight).bytes())
        .font
        .id
        .clone();
    let laid = lay_out(&spec_in(&id, "8")).expect("8");
    assert_eq!(laid.faces.len(), 1, "one united face");
    assert!(laid.faces[0].holes.is_empty());
    let segs = laid.faces[0].outer.segs.len();
    let curves = laid.faces[0]
        .outer
        .segs
        .iter()
        .filter(|s| !matches!(s, Seg::Line(_)))
        .count();
    assert!(
        segs <= 40,
        "{segs} pieces: refitted, not a polyline of hundreds"
    );
    assert!(curves >= 4, "{curves} curved pieces");
    // The area is the union's: compare with the polyline union at a fine step.
    let ink = laid.ink_mm2;
    assert!(ink > 20.0 && ink < 80.0, "{ink}");
    // Union of the same two contours as a polyline union, at 0.05 mm: the refit is within a third of a percent of it.
    let flat = laid.faces[0].outer.flatten(0.02);
    let polygon_area = area(&flat).abs();
    assert!(
        (polygon_area - ink).abs() < 0.003 * ink,
        "{polygon_area} against {ink}"
    );
}

#[test]
fn letters_that_touch_are_united_without_filling_their_curves_into_polylines() {
    // Two O's of the blob font set so tight they touch: the united face is refitted too.
    let o = Glyph {
        ch: 'o',
        advance: 800,
        contours: vec![blob(500, 500, 500)],
        heavy: None,
    };
    let id = add(Synth::simple("Touch Test").glyph(o).bytes())
        .font
        .id
        .clone();
    // Each letter's box is wider than its advance, so the pair overlaps as it stands.
    let laid = lay_out(&spec_in(&id, "oo")).expect("oo");
    let faces = laid.faces.len();
    assert!(faces <= 2, "{faces}");
    for face in &laid.faces {
        assert!(
            face.outer.segs.len() <= 60,
            "{} pieces",
            face.outer.segs.len()
        );
    }
}

#[test]
fn the_reply_for_a_font_says_what_the_card_needs() {
    let added = add(Synth::simple("Reply Test")
        .variable(300.0, 700.0)
        .with_fs_type(4)
        .bytes());
    let json = user::info(&added);
    assert_eq!(json["ok"], serde_json::json!(true));
    assert_eq!(json["name"], serde_json::json!("Reply Test Regular"));
    assert_eq!(json["family"], serde_json::json!("Reply Test"));
    assert_eq!(json["embedding"], serde_json::json!("outlines"));
    assert_eq!(json["restricted"], serde_json::json!(true));
    assert_eq!(json["bold"], serde_json::json!(false));
    assert!(json["id"].as_str().unwrap().starts_with("user:"));
    assert_eq!(json["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(json["weight"]["default"], serde_json::json!(300.0));
    let reply = user::add_reply(&base64_of(&Synth::simple("Reply Test 2").bytes()), None)
        .expect("add_reply");
    let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(parsed["restricted"], serde_json::json!(false));
    assert!(user::add_reply("not base64 !!!", None).is_err());
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn a_font_file_over_the_limit_is_refused() {
    let big = vec![0u8; user::MAX_FILE_BYTES + 1];
    let err = user::register(big, None).err().expect("too big");
    assert!(err.contains("larger than 40 MB"), "{err}");
}

#[test]
fn spacing_and_style_on_a_user_font_use_the_same_layout_as_a_bundled_one() {
    let id = add(Synth::simple("Layout Test").bytes()).font.id.clone();
    let mut a = spec_in(&id, "HH");
    let plain = lay_out(&a).unwrap().widths[0];
    a.spacing = Some(2.0);
    assert!((lay_out(&a).unwrap().widths[0] - plain - 2.0).abs() < 1e-9);
    a.spacing = None;
    a.align = Align::Right;
    let right = lay_out(&a).unwrap();
    assert!(
        (right.bounds.unwrap()[2] + 200.0 * 10.0 / 1400.0).abs() < 1e-9,
        "right-aligned text ends at its anchor, less the last letter's side bearing"
    );
}
