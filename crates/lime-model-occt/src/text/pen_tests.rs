// --- Milestone 5: the pen fonts go through the outline pipeline.
use super::*;

fn pen(font: &str, text: &str) -> Spec {
    Spec {
        text: text.into(),
        font: font.into(),
        style: None,
        height: 6.0,
        spacing: None,
        line_spacing: None,
        align: Align::Centre,
        angle_deg: 0.0,
        weight: None,
        stroke_mm: None,
    }
}

#[test]
fn the_stroke_font_lays_out_as_outlines_with_holes() {
    let laid = lay_out(&pen("stroke", "O8A")).expect("stroke lays out");
    assert_eq!(laid.font, "stroke@1");
    // O has one counter, 8 two, A one: three faces, four holes, a pen's width of ink and no more.
    assert_eq!(laid.faces.len(), 3);
    let holes: Vec<usize> = laid.faces.iter().map(|f| f.holes.len()).collect();
    assert_eq!(holes, vec![1, 2, 1]);
    assert!(
        laid.ink_mm2 > 5.0 && laid.ink_mm2 < 60.0,
        "{}",
        laid.ink_mm2
    );
}

#[test]
fn a_stroke_letter_is_as_tall_as_the_height_plus_a_pen() {
    // Capitals 6 mm with a 0.9 mm pen: the strokes' centre line is 6 mm, the ink reaches half a pen past each end.
    let laid = lay_out(&pen("stroke", "H")).unwrap();
    let b = laid.bounds.unwrap();
    assert!((b[3] - b[1] - 6.9).abs() < 0.02, "{b:?}");
    assert!((b[2] - b[0] - 4.9).abs() < 0.02, "{b:?}");
}

#[test]
fn the_stroke_pen_and_gap_are_typed_as_they_always_were() {
    let mut s = pen("stroke", "II");
    let narrow = lay_out(&s).unwrap().widths[0];
    // Two letters 4 units apart plus a third of the height between: 4 + 2 + 4 units of 1 mm.
    assert!((narrow - 10.0).abs() < 1e-9, "{narrow}");
    s.spacing = Some(0.0);
    assert!((lay_out(&s).unwrap().widths[0] - 8.0).abs() < 1e-9);
    s.stroke_mm = Some(2.0);
    let fat = lay_out(&s).unwrap().ink_mm2;
    s.stroke_mm = Some(0.5);
    assert!(fat > lay_out(&s).unwrap().ink_mm2 * 3.0);
    s.stroke_mm = Some(4.0);
    assert!(lay_out(&s).unwrap_err().contains("at most half the height"));
}

#[test]
fn stroke_has_capitals_and_line_has_lowercase() {
    // Stroke draws a lowercase letter as its capital (D3).
    let low = lay_out(&pen("stroke", "lime")).unwrap();
    let up = lay_out(&pen("stroke", "LIME")).unwrap();
    assert!((low.ink_mm2 - up.ink_mm2).abs() < 1e-9);
    // Line has its own.
    let line = lay_out(&pen("line", "lime gy")).unwrap();
    assert_eq!(line.font, "line@1");
    let b = line.bounds.unwrap();
    assert!(b[1] < -3.0, "g and y hang below the baseline: {b:?}");
    let err = lay_out(&pen("stroke", "a日")).unwrap_err();
    assert!(err.contains("‘日’") && err.contains("A-Z"), "{err}");
    assert!(lay_out(&pen("line", "日"))
        .unwrap_err()
        .contains("letters, digits"));
}

#[test]
fn a_pen_font_refuses_styles_and_weights() {
    let mut s = pen("stroke", "A");
    s.style = Some("bold".into());
    assert!(lay_out(&s).unwrap_err().contains("one style"));
    s.style = None;
    s.weight = Some(500.0);
    assert!(lay_out(&s).unwrap_err().contains("one weight"));
    assert!(lay_out(&pen("stroke@2", "A"))
        .unwrap_err()
        .contains("stroke@1"));
}

#[test]
fn overlapping_strokes_become_one_clean_outline() {
    // The A's crossbar and legs overlap; the united letter is one face with one hole.
    let laid = lay_out(&pen("line", "A")).unwrap();
    assert_eq!(laid.faces.len(), 1);
    assert_eq!(laid.faces[0].holes.len(), 1);
    // The thin-stroke analysis works on a pen font: a 0.2 mm pen is thinner than a 0.4 mm line.
    let mut s = pen("stroke", "L");
    s.stroke_mm = Some(0.2);
    let thin = thin_letters(&lay_out(&s).unwrap(), 0.4);
    assert_eq!(thin.len(), 1);
    assert!(thin_letters(&lay_out(&pen("stroke", "L")).unwrap(), 0.4).is_empty());
}
