//! --- Text with real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1). The op that raises or cuts the letters of a
//! string on a flat face, and the two stateless calls the Model tab's card asks: the layout (outlines for the live preview,
//! and the letters too thin for the nozzle) and the list of bundled fonts.
//!
//! Reading the font and laying the letters out is `crate::text`; building them is `cpp/text.cpp`.

use std::os::raw::{c_char, c_int};

use serde_json::{json, Value};

use super::{take_text, BooleanOp, BuildFail, Built, Op, RawShape, Shape};
use crate::text::{self, fonts};

extern "C" {
    fn lime_tree_text(
        from: *const RawShape,
        cut: c_int,
        p: *const f64,
        data: *const f64,
        data_len: c_int,
        path: *mut c_int,
        note: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
}

/// The least depth a letter takes, mm.
const MIN_DEPTH_MM: f64 = 0.001;

/// The layout a text op is typed as.
fn spec_of(op: &Op) -> Option<text::Spec> {
    let Op::Lettering {
        text,
        font,
        style,
        height,
        spacing,
        line_spacing,
        align,
        angle_deg,
        weight,
        ..
    } = op
    else {
        return None;
    };
    Some(text::Spec {
        text: text.clone(),
        font: font.clone(),
        style: style.clone(),
        height: *height,
        spacing: *spacing,
        line_spacing: *line_spacing,
        align: align.unwrap_or_default(),
        angle_deg: angle_deg.unwrap_or(0.0),
        weight: *weight,
    })
}

/// The letters of `op` built on `from`. The stored op names the font with its version, so a rebuild reads the same bytes.
pub(super) fn build(from: &mut Shape, op: Op) -> Result<Built, BuildFail> {
    let Op::Lettering {
        op: which,
        origin,
        turn,
        depth,
        ..
    } = &op
    else {
        unreachable!("matched a text op");
    };
    let cut = match which {
        BooleanOp::Fuse => false,
        BooleanOp::Cut => true,
        BooleanOp::Common => {
            return Err(BuildFail::plain("Text is raised (fuse) or engraved (cut)."))
        }
    };
    if !(depth.is_finite() && *depth >= MIN_DEPTH_MM) {
        return Err(BuildFail::plain(
            "Text needs a depth above 0, in millimetres.",
        ));
    }
    let spec = spec_of(&op).expect("a text op");
    let laid = text::lay_out(&spec).map_err(BuildFail::plain)?;
    if laid.faces.is_empty() {
        return Err(BuildFail::plain(
            "The text has no letters to build. Spaces leave no ink.",
        ));
    }
    let blob = text::encode(&laid.faces);
    let p = [
        origin[0], origin[1], origin[2], turn[0], turn[1], turn[2], *depth,
    ];
    let mut path: c_int = 0;
    let mut note: *mut c_char = std::ptr::null_mut();
    let built = Shape::made(|error| unsafe {
        lime_tree_text(
            from.raw(),
            c_int::from(cut),
            p.as_ptr(),
            blob.as_ptr(),
            blob.len() as c_int,
            &mut path,
            &mut note,
            error,
        )
    });
    let note = take_text(note);
    let kept = built.map_err(BuildFail::plain)?;
    let mut stored = op;
    if let Op::Lettering { font, .. } = &mut stored {
        *font = laid.font.clone();
    }
    Ok(Built {
        op: stored,
        kept,
        other: None,
        pieces: Vec::new(),
        pins: None,
        numbered: None,
        joined: None,
        skipped: 0,
        sides: Vec::new(),
        report: Some((
            "text",
            json!({
                "build": if path == 1 { "direct" } else { "boolean" },
                "font": laid.font,
                "letters": laid.faces.len(),
                "inkMm2": laid.ink_mm2,
                "booleanBecause": note,
            }),
        )),
    })
}

/// A laid-out text for the card's live preview: each letter's loops as polylines about `stepMm` apart, in the plane's own
/// U and V, with the letters too thin for a `lineMm` line.
#[allow(clippy::too_many_arguments)]
pub(super) fn layout_reply(
    spec: &text::Spec,
    line_mm: f64,
    step_mm: f64,
) -> Result<String, String> {
    let laid = text::lay_out(spec)?;
    let thin = text::thin_letters(&laid, line_mm);
    let step = step_mm.clamp(0.01, 2.0);
    let faces: Vec<Value> = laid
        .faces
        .iter()
        .map(|face| {
            let loops: Vec<Vec<[f64; 2]>> = std::iter::once(&face.outer)
                .chain(face.holes.iter())
                .map(|contour| contour.flatten(step).iter().map(|p| [round(p[0]), round(p[1])]).collect())
                .collect();
            json!({ "ch": face.ch.to_string(), "loops": loops, "thin": thin.iter().any(|t| t.ch == face.ch) })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "font": laid.font,
        "faces": faces,
        "widths": laid.widths,
        "bounds": laid.bounds,
        "inkMm2": laid.ink_mm2,
        "thin": thin,
        "thinNote": text::thin_sentence(&thin, line_mm),
    })
    .to_string())
}

fn round(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

/// The bundled fonts: id with its version, name, what it is for, and the styles its files have.
pub(super) fn fonts_reply() -> String {
    let rows: Vec<Value> = fonts::FAMILIES
        .iter()
        .map(|family| {
            let has = |bold: bool, italic: bool| {
                family
                    .styles
                    .iter()
                    .any(|file| file.bold == bold && file.italic == italic)
            };
            json!({
                "id": fonts::versioned(family),
                "name": family.name,
                "about": family.about,
                "regular": has(false, false),
                "bold": has(true, false),
                "italic": has(false, true),
                "boldItalic": has(true, true),
            })
        })
        .collect();
    json!({ "ok": true, "fonts": rows }).to_string()
}
