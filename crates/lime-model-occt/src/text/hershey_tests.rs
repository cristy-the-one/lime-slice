// --- The Hershey pen fonts.
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
fn the_hershey_fonts_have_the_ascii_letters_and_their_own_advances() {
    for font in hershey::FONTS.iter() {
        // Space and 94 printable marks: 95 characters, each with a table entry.
        assert_eq!(font.glyph_count(), 95, "{}", font.id);
        let laid = lay_out(&pen(font.id, "Lime 42")).unwrap_or_else(|e| panic!("{}: {e}", font.id));
        assert_eq!(laid.font, font.stored);
        // Letters are proportional: an i is narrower than an m in every one of them.
        let i = lay_out(&pen(font.id, "i")).unwrap().widths[0];
        let m = lay_out(&pen(font.id, "m")).unwrap().widths[0];
        assert!(i < m, "{}: i {i} m {m}", font.id);
        assert!(laid.ink_mm2 > 1.0, "{}", font.id);
    }
}

#[test]
fn a_known_hershey_glyph_has_its_strokes() {
    let simplex = hershey::find("hershey-simplex").unwrap();
    // H is two stems and a bar, I one stem, ! a stem and a dot, space none.
    assert_eq!(simplex.stroke_count('H'), Some(3));
    assert_eq!(simplex.stroke_count('I'), Some(1));
    assert_eq!(simplex.stroke_count('!'), Some(2));
    assert_eq!(simplex.stroke_count(' '), Some(0));
    assert_eq!(simplex.stroke_count('日'), None);
    // The capital is the grid's 6 units: H's strokes reach 6 and 0.
    let (_, strokes) = simplex.glyph('H').unwrap();
    let top = strokes
        .iter()
        .flat_map(|s| s.iter())
        .map(|p| p[1])
        .fold(f64::MIN, f64::max);
    let bottom = strokes
        .iter()
        .flat_map(|s| s.iter())
        .map(|p| p[1])
        .fold(f64::MAX, f64::min);
    assert!(
        (top - 6.0).abs() < 1e-9 && bottom.abs() < 1e-9,
        "{top} {bottom}"
    );
}

#[test]
fn hershey_letters_and_marks_name_what_is_missing_and_a_version_is_checked() {
    let err = lay_out(&pen("hershey-simplex", "a日")).unwrap_err();
    assert!(err.contains("‘日’") && err.contains("ASCII"), "{err}");
    assert!(lay_out(&pen("hershey-script@2", "A"))
        .unwrap_err()
        .contains("hershey-script@1"));
    assert!(pen::is_pen("hershey-gothic@1") && !pen::is_pen("hershey-nope"));
    let mut s = pen("hershey-duplex", "A");
    s.weight = Some(500.0);
    assert!(lay_out(&s).unwrap_err().contains("one weight"));
}

#[test]
fn hershey_neighbours_stay_apart_and_the_pen_width_is_typed() {
    // Two stems are two faces with the default gap, at the default pen.
    let laid = lay_out(&pen("hershey-simplex", "ll")).unwrap();
    assert_eq!(laid.faces.len(), 2);
    let mut s = pen("hershey-simplex", "ll");
    s.stroke_mm = Some(2.0);
    let fat = lay_out(&s).unwrap().ink_mm2;
    s.stroke_mm = Some(0.5);
    assert!(fat > lay_out(&s).unwrap().ink_mm2 * 3.0);
    // A one-point stroke would still be ink.
    assert!(lay_out(&pen("hershey-simplex", ".")).unwrap().ink_mm2 > 0.0);
    // The thin-stroke analysis reads a Hershey font like any other.
    s.stroke_mm = Some(0.2);
    assert!(!thin_letters(&lay_out(&s).unwrap(), 0.4).is_empty());
}
