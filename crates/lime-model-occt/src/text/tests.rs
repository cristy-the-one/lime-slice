use super::*;

fn spec(text: &str) -> Spec {
    Spec {
        text: text.into(),
        font: "sans".into(),
        style: None,
        height: 6.0,
        spacing: None,
        line_spacing: None,
        align: Align::Centre,
        angle_deg: 0.0,
        weight: None,
    }
}

fn laid(text: &str) -> Laid {
    lay_out(&spec(text)).unwrap_or_else(|err| panic!("{text:?}: {err}"))
}

fn faces_of_char(laid: &Laid, ch: char) -> Vec<&GlyphFace> {
    laid.faces.iter().filter(|f| f.ch == ch).collect()
}

#[test]
fn every_bundled_font_lays_out_letters_digits_and_symbols() {
    for family in fonts::FAMILIES {
        for style in family.styles {
            let mut s = spec("Lime Slice 2026 - A/B: C&D? 100%");
            s.font = family.id.into();
            s.style = Some(
                match (style.bold, style.italic) {
                    (false, false) => "regular",
                    (true, false) => "bold",
                    (false, true) => "italic",
                    (true, true) => "bold-italic",
                }
                .into(),
            );
            let laid =
                lay_out(&s).unwrap_or_else(|err| panic!("{} {:?}: {err}", family.id, s.style));
            assert!(laid.faces.len() > 20, "{} {:?}", family.id, s.style);
            assert!(laid.ink_mm2 > 10.0, "{}: ink {}", family.id, laid.ink_mm2);
        }
    }
}

#[test]
fn capitals_are_the_height_asked_for() {
    for family in fonts::FAMILIES {
        let mut s = spec("H");
        s.font = family.id.into();
        s.height = 8.0;
        let laid = lay_out(&s).expect("H");
        let [_, v0, _, v1] = laid.bounds.expect("ink");
        assert!(
            (v1 - v0 - 8.0).abs() < 0.2,
            "{}: H is {} mm tall",
            family.id,
            v1 - v0
        );
        // A single line is centred on v = 0.
        assert!(
            (v0 + v1).abs() < 0.2,
            "{}: centre at {}",
            family.id,
            (v0 + v1) / 2.0
        );
    }
}

#[test]
fn letters_with_holes_have_them() {
    let l = laid("A O 8 g B e i");
    let holes = |ch: char| {
        faces_of_char(&l, ch)
            .iter()
            .map(|f| f.holes.len())
            .sum::<usize>()
    };
    assert_eq!(holes('A'), 1, "A");
    assert_eq!(holes('O'), 1, "O");
    assert_eq!(holes('8'), 2, "8");
    assert_eq!(holes('B'), 2, "B");
    assert_eq!(holes('e'), 1, "e");
    assert!(holes('g') >= 1, "g");
    // The i is its stem and its dot: two faces.
    assert_eq!(faces_of_char(&l, 'i').len(), 2, "i");
    assert_eq!(faces_of_char(&l, 'A').len(), 1, "A is one face");
}

#[test]
fn loops_are_closed_and_run_the_right_way() {
    let l = laid("AO8gBe&@");
    for face in &l.faces {
        for (n, c) in std::iter::once(&face.outer).chain(&face.holes).enumerate() {
            let last = c.segs.last().expect("a segment").end();
            assert_eq!(last, c.start, "{} loop {n} closes on its start", face.ch);
            let a = area(&c.flatten(0.05));
            if n == 0 {
                assert!(a > 0.0, "{} outer runs counter-clockwise", face.ch);
            } else {
                assert!(a < 0.0, "{} hole runs clockwise", face.ch);
            }
            // No segment is a sliver.
            let mut at = c.start;
            for seg in &c.segs {
                let to = seg.end();
                assert!(
                    (to[0] - at[0]).hypot(to[1] - at[1]) >= TINY_MM || !matches!(seg, Seg::Line(_)),
                    "{} has a sliver segment",
                    face.ch
                );
                at = to;
            }
        }
    }
}

#[test]
fn curves_stay_curves_in_a_font_that_does_not_overlap() {
    let l = laid("O");
    let curves = l.faces[0]
        .outer
        .segs
        .iter()
        .filter(|s| !matches!(s, Seg::Line(_)))
        .count();
    assert!(curves >= 4, "an O is curves, not a polygon: {curves}");
}

#[test]
fn kerning_pulls_a_pair_together() {
    let pair = laid("AV").widths[0];
    let apart = laid("A").widths[0] + laid("V").widths[0];
    assert!(
        pair < apart - 0.05,
        "AV {pair} is narrower than A + V {apart}"
    );
    // A pair the font does not kern is just the two advances.
    let hh = laid("HH").widths[0];
    let h = laid("H").widths[0];
    assert!(
        (hh - 2.0 * h).abs() < 0.3,
        "HH {hh} against 2 x H {}",
        2.0 * h
    );
}

#[test]
fn letter_spacing_adds_a_gap_after_each_letter_but_the_last() {
    let plain = laid("HHH").widths[0];
    let mut s = spec("HHH");
    s.spacing = Some(1.5);
    let spaced = lay_out(&s).unwrap().widths[0];
    assert!(
        (spaced - plain - 3.0).abs() < 1e-6,
        "{spaced} against {plain} + 2 gaps of 1.5"
    );
}

#[test]
fn lines_stack_downward_with_the_line_spacing() {
    let one = laid("HH");
    let two = laid("HH\nHH");
    let (b1, b2) = (one.bounds.unwrap(), two.bounds.unwrap());
    // Caps 6 high, lines 1.3 x 6 apart: the block is 7.8 + 6 = 13.8 tall, centred.
    assert!(
        (b2[3] - b2[1] - (6.0 + 1.3 * 6.0)).abs() < 0.2,
        "block height {}",
        b2[3] - b2[1]
    );
    assert!((b2[3] + b2[1]).abs() < 0.2, "block centred on v = 0");
    assert_eq!(two.faces.len(), 4);
    assert_eq!(two.widths.len(), 2);
    assert!(
        (b1[2] - b1[0] - (b2[2] - b2[0])).abs() < 1e-6,
        "both lines are as wide as the one"
    );
    let mut s = spec("HH\nHH");
    s.line_spacing = Some(2.0);
    let wide = lay_out(&s).unwrap().bounds.unwrap();
    assert!(
        (wide[3] - wide[1] - (6.0 + 2.0 * 6.0)).abs() < 0.2,
        "line spacing 2: {}",
        wide[3] - wide[1]
    );
    // A blank line still takes its place.
    let gap = laid("H\n\nH").bounds.unwrap();
    assert!(
        (gap[3] - gap[1] - (6.0 + 2.0 * 7.8)).abs() < 0.2,
        "blank line between: {}",
        gap[3] - gap[1]
    );
}

#[test]
fn alignment_puts_the_anchor_at_the_left_the_middle_or_the_right_of_each_line() {
    let run = |align: Align| {
        let mut s = spec("HHHH\nHH");
        s.align = align;
        lay_out(&s).unwrap()
    };
    let left = run(Align::Left);
    let centre = run(Align::Centre);
    let right = run(Align::Right);
    let (wl, wr) = (left.widths[0], left.widths[1]);
    assert!(wl > wr);
    // Left: every line starts at u = 0 (a letter's own side bearing aside).
    let lb = left.bounds.unwrap();
    assert!(lb[0] > -0.05 && lb[0] < 1.0, "left edge {}", lb[0]);
    // Right: every line ends at u = 0.
    let rb = right.bounds.unwrap();
    assert!(rb[2] < 0.05 && rb[2] > -1.0, "right edge {}", rb[2]);
    // Centre: symmetric about 0.
    let cb = centre.bounds.unwrap();
    assert!((cb[0] + cb[2]).abs() < 1.0, "centre {} {}", cb[0], cb[2]);
    // The short line of a right-aligned text is flush with the long one on the right.
    let ends: Vec<f64> = right
        .faces
        .iter()
        .map(|f| bbox(&f.outer.flatten(0.05))[2])
        .collect();
    let first_line_end = ends[..4].iter().cloned().fold(f64::MIN, f64::max);
    let second_line_end = ends[4..].iter().cloned().fold(f64::MIN, f64::max);
    assert!(
        (first_line_end - second_line_end).abs() < 0.05,
        "{first_line_end} {second_line_end}"
    );
}

#[test]
fn a_missing_letter_is_named_not_drawn_as_a_box() {
    let err = lay_out(&spec("Lime 日")).unwrap_err();
    assert_eq!(
        err,
        "This font has no ‘日’. Pick another font, or take it out."
    );
    let err = lay_out(&spec("a\tb")).unwrap_err();
    assert!(err.contains("control character"), "{err}");
}

#[test]
fn fonts_resolve_by_id_and_version() {
    assert!(fonts::family("sans").is_ok());
    assert_eq!(fonts::versioned(fonts::family("sans").unwrap()), "sans@4.0");
    assert!(fonts::family("sans@4.0").is_ok());
    assert!(fonts::family("sans@9").unwrap_err().contains("not sans@9"));
    assert!(fonts::family("comic")
        .unwrap_err()
        .contains("no font called ‘comic’"));
    assert_eq!(laid("A").font, "sans@4.0");
}

#[test]
fn a_family_without_an_italic_is_slanted_and_one_without_a_bold_is_refused() {
    // Plex Mono has no italic here: a slant of 12 degrees moves the top of an I to the right of its foot.
    let slanted = {
        let mut s = spec("I");
        s.font = "mono".into();
        s.style = Some("italic".into());
        s.height = 20.0;
        lay_out(&s).unwrap()
    };
    let upright = {
        let mut s = spec("I");
        s.font = "mono".into();
        s.height = 20.0;
        lay_out(&s).unwrap()
    };
    let (sb, ub) = (slanted.bounds.unwrap(), upright.bounds.unwrap());
    assert!(
        ((sb[2] - sb[0]) - (ub[2] - ub[0])) > 20.0 * 0.12 * 0.8,
        "the slant widens the box: {} against {}",
        sb[2] - sb[0],
        ub[2] - ub[0]
    );
    // Stencil has one weight.
    let mut s = spec("A");
    s.font = "stencil".into();
    s.style = Some("bold".into());
    assert_eq!(
        lay_out(&s).unwrap_err(),
        "‘Allerta Stencil’ has no bold. Pick Regular, or another font."
    );
    // Bold and bold-italic come from Inter's own files, not a slant.
    let mut s = spec("A");
    s.style = Some("bold-italic".into());
    assert!(lay_out(&s).is_ok());
    s.style = Some("sideways".into());
    assert!(lay_out(&s).unwrap_err().contains("sideways"));
}

#[test]
fn bold_is_heavier_than_regular() {
    let regular = laid("HELLO").ink_mm2;
    let mut s = spec("HELLO");
    s.style = Some("bold".into());
    let bold = lay_out(&s).unwrap().ink_mm2;
    assert!(
        bold > regular * 1.15,
        "bold {bold} against regular {regular}"
    );
}

#[test]
fn the_angle_turns_the_text_about_its_anchor() {
    let flat = laid("HHHH");
    let mut s = spec("HHHH");
    s.angle_deg = 90.0;
    let up = lay_out(&s).unwrap();
    let (f, u) = (flat.bounds.unwrap(), up.bounds.unwrap());
    assert!(
        ((f[2] - f[0]) - (u[3] - u[1])).abs() < 0.05,
        "width becomes height"
    );
    assert!(
        ((f[3] - f[1]) - (u[2] - u[0])).abs() < 0.05,
        "height becomes width"
    );
    assert!(
        (flat.ink_mm2 - up.ink_mm2).abs() < 0.01,
        "a turn keeps the ink"
    );
}

#[test]
fn too_much_text_is_refused() {
    let err = lay_out(&spec(&"A".repeat(MAX_CHARS + 1))).unwrap_err();
    assert!(err.contains("400"), "{err}");
    assert!(lay_out(&spec(&"A".repeat(MAX_CHARS))).is_ok());
    let mut s = spec("A");
    s.height = 0.0;
    assert!(lay_out(&s).is_err());
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> GlyphFace {
    GlyphFace {
        ch: 'x',
        outer: Contour::polygon(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]),
        holes: vec![],
    }
}

#[test]
fn letters_that_touch_are_united_and_the_others_keep_their_curves() {
    let apart = merge_overlaps(vec![rect(0.0, 0.0, 1.0, 1.0), rect(2.0, 0.0, 3.0, 1.0)]);
    assert_eq!(apart.len(), 2);
    let touching = merge_overlaps(vec![rect(0.0, 0.0, 1.0, 1.0), rect(0.5, 0.0, 1.5, 1.0)]);
    assert_eq!(touching.len(), 1);
    let ring = touching[0].outer.flatten(0.05);
    assert!(
        (area(&ring) - 1.5).abs() < 1e-6,
        "the union is 1.5 wide: {}",
        area(&ring)
    );
    // A small letter in another's hole is not united with it.
    let mut frame = rect(0.0, 0.0, 10.0, 10.0);
    frame.holes = vec![Contour::polygon(&[
        [2.0, 8.0],
        [8.0, 8.0],
        [8.0, 2.0],
        [2.0, 2.0],
    ])];
    let nested = merge_overlaps(vec![frame, rect(4.0, 4.0, 5.0, 5.0)]);
    assert_eq!(nested.len(), 2);
    // A real font's curves survive when nothing overlaps.
    let l = laid("OO");
    assert!(l
        .faces
        .iter()
        .all(|f| f.outer.segs.iter().any(|s| !matches!(s, Seg::Line(_)))));
}

#[test]
fn contours_that_overlap_inside_one_glyph_are_united_into_clean_faces() {
    // The way a variable font draws a cross: two overlapping bars, both running the same way.
    let bar = |x0: f64, y0: f64, x1: f64, y1: f64| {
        Contour::polygon(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
    };
    let cross = [bar(0.0, 4.0, 10.0, 6.0), bar(4.0, 0.0, 6.0, 10.0)];
    assert!(contours_overlap(&cross));
    let faces = union_contours('+', &cross);
    assert_eq!(faces.len(), 1);
    assert!(faces[0].holes.is_empty());
    assert!(
        (faces[0].area() - 36.0).abs() < 1e-6,
        "2 x 10 + 2 x 10 - 4: {}",
        faces[0].area()
    );
    // Two bars apart do not overlap.
    assert!(!contours_overlap(&[
        bar(0.0, 0.0, 1.0, 1.0),
        bar(2.0, 0.0, 3.0, 1.0)
    ]));
    // A ring: an outer loop and a hole running the other way is one face, not an overlap.
    let hole = bar(3.0, 3.0, 7.0, 7.0).reversed();
    assert!(!contours_overlap(&[bar(0.0, 0.0, 10.0, 10.0), hole]));
}

#[test]
fn thin_letters_are_named_and_sturdy_ones_are_not() {
    let sturdy = laid("HELLO 2026");
    assert!(
        thin_letters(&sturdy, 0.4).is_empty(),
        "6 mm Inter prints on a 0.4 mm line"
    );
    let mut s = spec("Lime Slice");
    s.height = 1.6;
    let tiny = lay_out(&s).unwrap();
    let thin = thin_letters(&tiny, 0.4);
    assert!(!thin.is_empty(), "1.6 mm capitals do not");
    assert!(thin
        .iter()
        .all(|t| t.lost_pct > 10.0 && t.lost_pct <= 100.0));
    let sentence = thin_sentence(&thin, 0.4).unwrap();
    assert!(
        sentence.contains("thinner than your 0.4 mm line"),
        "{sentence}"
    );
    assert_eq!(thin_sentence(&[], 0.4), None);
    // Each distinct letter once.
    let names: Vec<char> = thin.iter().map(|t| t.ch).collect();
    let mut once = names.clone();
    once.dedup();
    assert_eq!(names.len(), once.len());
    // Bold holds up where regular does not.
    let mut b = spec("Lime Slice");
    b.height = 3.0;
    let regular = thin_letters(&lay_out(&b).unwrap(), 0.4).len();
    b.style = Some("bold".into());
    let bold = thin_letters(&lay_out(&b).unwrap(), 0.4).len();
    assert!(bold <= regular, "bold {bold} against regular {regular}");
}

#[test]
fn the_kernel_blob_counts_faces_loops_and_segments() {
    let l = laid("OA");
    let blob = encode(&l.faces);
    assert_eq!(blob[0] as usize, l.faces.len());
    let mut at = 1;
    for face in &l.faces {
        assert_eq!(blob[at] as u32, face.ch as u32);
        let loops = blob[at + 1] as usize;
        assert_eq!(loops, 1 + face.holes.len());
        at += 2;
        for _ in 0..loops {
            let segs = blob[at + 2] as usize;
            at += 3;
            for _ in 0..segs {
                at += match blob[at] as i32 {
                    1 => 3,
                    2 => 5,
                    3 => 7,
                    other => panic!("kind {other}"),
                };
            }
        }
    }
    assert_eq!(at, blob.len());
}

const CFF: &[u8] = include_bytes!("../../tests/fonts/SourceCodePro-Regular.otf");

#[test]
fn a_cff_font_reads_as_cubic_curves_with_holes_and_no_slivers() {
    assert_eq!(&CFF[..4], b"OTTO", "the fixture is a CFF OpenType font");
    let l = lay_out_face(&spec("A O 8 g B e"), CFF, false, "test-cff@1".into()).expect("CFF text");
    assert_eq!(l.font, "test-cff@1");
    let cubic = l
        .faces
        .iter()
        .flat_map(|f| &f.outer.segs)
        .filter(|s| matches!(s, Seg::Cubic(..)))
        .count();
    assert!(cubic > 8, "CFF outlines are cubic pieces: {cubic}");
    let holes = |ch: char| {
        faces_of_char(&l, ch)
            .iter()
            .map(|f| f.holes.len())
            .sum::<usize>()
    };
    assert_eq!(
        (holes('A'), holes('O'), holes('8'), holes('B'), holes('e')),
        (1, 1, 2, 2, 1)
    );
    assert!(holes('g') >= 1);
    for face in &l.faces {
        for contour in std::iter::once(&face.outer).chain(&face.holes) {
            assert_eq!(
                contour.segs.last().unwrap().end(),
                contour.start,
                "{} closes",
                face.ch
            );
            let mut at = contour.start;
            for seg in &contour.segs {
                let to = seg.end();
                assert!(to != at, "{} has a zero-length segment", face.ch);
                at = to;
            }
        }
    }
    let [_, v0, _, v1] = lay_out_face(&spec("H"), CFF, false, "t".into())
        .unwrap()
        .bounds
        .unwrap();
    assert!(
        (v1 - v0 - 6.0).abs() < 0.2,
        "capitals are 6 mm: {}",
        v1 - v0
    );
}
