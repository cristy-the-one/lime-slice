//! --- Text with real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1). The op that raises or cuts the letters of a
//! string on a flat face, and the two stateless calls the Model tab's card asks: the layout (outlines for the live preview,
//! and the letters too thin for the nozzle) and the list of bundled fonts.
//!
//! Reading the font and laying the letters out is `crate::text`; building them is `cpp/text.cpp`.

use std::os::raw::{c_char, c_int};

use serde_json::{json, Value};

use super::{take_text, BooleanOp, BuildFail, Built, Op, RawShape, Shape};
use crate::text::skin::{self, SkinHow, SkinInfo, Surf, V3};
use crate::text::wrap::{self, How, SurfaceInfo};
use crate::text::{self, fonts};

extern "C" {
    fn lime_tree_text_face(
        from: *const RawShape,
        point: *const f64,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    fn lime_tree_text_curved(
        from: *const RawShape,
        cut: c_int,
        p: *const f64,
        data: *const f64,
        data_len: c_int,
        path: *mut c_int,
        note: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
    // --- Milestone 3: the face under a point when it is a sphere, a torus or a freeform face, held while the text is laid out.
    fn lime_tree_skin_open(
        from: *const RawShape,
        point: *const f64,
        info: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> *mut RawSkin;
    fn lime_tree_skin_d1(skin: *const RawSkin, u: f64, v: f64, out: *mut f64) -> c_int;
    fn lime_tree_skin_free(skin: *mut RawSkin);
    fn lime_tree_text_skin(
        from: *const RawShape,
        cut: c_int,
        p: *const f64,
        data: *const f64,
        data_len: c_int,
        path: *mut c_int,
        note: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> *mut RawShape;
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

/// A face held by the kernel (cpp/text.cpp `SkinHandle`).
#[repr(C)]
struct RawSkin {
    _private: [u8; 0],
}

/// The face under an anchor, asked for its surface's points as the text is laid out.
struct SkinFace(*mut RawSkin);

impl Surf for SkinFace {
    fn d1(&self, u: f64, v: f64) -> Option<(V3, V3, V3)> {
        let mut out = [0.0f64; 9];
        // SAFETY: the handle lives until `drop`; `out` holds the nine numbers the kernel writes.
        let ok = unsafe { lime_tree_skin_d1(self.0, u, v, out.as_mut_ptr()) };
        (ok == 1).then(|| {
            (
                [out[0], out[1], out[2]],
                [out[3], out[4], out[5]],
                [out[6], out[7], out[8]],
            )
        })
    }
}

impl Drop for SkinFace {
    fn drop(&mut self) {
        // SAFETY: the handle came from `lime_tree_skin_open` and is freed once.
        unsafe { lime_tree_skin_free(self.0) };
    }
}

/// A sphere, a torus or a freeform face with what the kernel says of it.
struct Skinned {
    face: SkinFace,
    info: SkinInfo,
}

/// What is under the anchor of a text.
enum Under {
    /// A flat face, or no face at all (a bare workplane): the frame the op carries builds it.
    Flat,
    /// A cylinder or a cone.
    Round(SurfaceInfo),
    /// A sphere, a torus or a freeform face.
    Skin(Skinned),
}

/// The sphere, torus or freeform face of `from` under `point`, held.
fn skin_under(from: &Shape, point: [f64; 3]) -> Result<Skinned, String> {
    let mut info: *mut c_char = std::ptr::null_mut();
    let mut error: *mut c_char = std::ptr::null_mut();
    let raw = unsafe { lime_tree_skin_open(from.raw(), point.as_ptr(), &mut info, &mut error) };
    let message = take_text(error);
    let described = take_text(info);
    if raw.is_null() {
        return Err(message.unwrap_or_else(|| {
            "Text could not be placed on this face. Pick a point on it, or another face.".into()
        }));
    }
    let face = SkinFace(raw);
    let text = described.ok_or_else(|| "Open CASCADE described the face badly".to_string())?;
    let info: SkinInfo = serde_json::from_str(&text)
        .map_err(|err| format!("Open CASCADE described the face badly: {err}"))?;
    Ok(Skinned { face, info })
}

/// The face of `from` under `point`: a cylinder or a cone with its surface, a sphere, a torus or a freeform face held, or the flat
/// way.
fn under(from: &Shape, point: [f64; 3]) -> Result<Under, String> {
    let mut error: *mut c_char = std::ptr::null_mut();
    let raw = unsafe { lime_tree_text_face(from.raw(), point.as_ptr(), &mut error) };
    let message = take_text(error);
    let Some(text) = take_text(raw) else {
        return Err(message.unwrap_or_else(|| "Open CASCADE failed".into()));
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| "Open CASCADE answered with damaged text".to_string())?;
    match value["kind"].as_str() {
        Some("cylinder") | Some("cone") => serde_json::from_value(value)
            .map(Under::Round)
            .map_err(|err| format!("Open CASCADE described the face badly: {err}")),
        Some("other") => skin_under(from, point).map(Under::Skin),
        _ => Ok(Under::Flat),
    }
}

/// The way the baseline runs, from the op's `along`.
fn how_of(along: Option<&str>, flip: bool) -> Result<How, String> {
    let along = match along {
        None | Some("around") | Some("u") => false,
        Some("axis") | Some("v") => true,
        Some(other) => return Err(format!(
            "along is around or axis, not ‘{other}’. Around reads round the part; axis runs up it."
        )),
    };
    Ok(How { along, flip })
}

/// The way the baseline starts on a sphere, a torus or a freeform face, from the op's `along`, `flip`, `wrap` and angle.
fn skin_how_of(
    along: Option<&str>,
    flip: bool,
    wrap: Option<&str>,
    angle_deg: f64,
) -> Result<SkinHow, String> {
    let v_first = match along {
        None | Some("u") | Some("around") => false,
        Some("v") | Some("axis") => true,
        Some(other) => return Err(format!(
            "along is u or v on this face, not ‘{other}’. U runs the baseline along the face's U, v along its V."
        )),
    };
    let project = match wrap {
        None | Some("wrap") => false,
        Some("project") => true,
        Some(other) => return Err(format!(
            "wrap is wrap or project, not ‘{other}’. Wrap keeps the letters' size on the surface; project pushes them onto it along the anchor's normal."
        )),
    };
    Ok(SkinHow {
        v_first,
        flip,
        angle_deg,
        project,
    })
}

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
    let target = under(from, *origin).map_err(BuildFail::plain)?;
    let mut spec = spec_of(&op).expect("a text op");
    // On a sphere, a torus or a freeform face the angle turns the baseline at the anchor, not the layout.
    let angle_deg = spec.angle_deg;
    if matches!(target, Under::Skin(_)) {
        spec.angle_deg = 0.0;
    }
    let laid = text::lay_out(&spec).map_err(BuildFail::plain)?;
    if laid.faces.is_empty() {
        return Err(BuildFail::plain(
            "The text has no letters to build. Spaces leave no ink.",
        ));
    }
    let (along, flip, wrap_mode) = match &op {
        Op::Lettering {
            along, flip, wrap, ..
        } => (along.clone(), flip.unwrap_or(false), wrap.clone()),
        _ => unreachable!("matched a text op"),
    };
    let mut path: c_int = 0;
    let mut note: *mut c_char = std::ptr::null_mut();
    let mut crossed = false;
    let mut surface = "plane".to_string();
    let built = match target {
        Under::Round(info) => {
            let how = how_of(along.as_deref(), flip).map_err(BuildFail::plain)?;
            let wrapped =
                wrap::wrap(&laid.faces, &info, how, *depth, cut).map_err(BuildFail::plain)?;
            crossed = wrapped.crosses_seam;
            surface = if info.kind == "cone" {
                "cone".into()
            } else {
                "cylinder".into()
            };
            let blob = text::encode(&wrapped.faces);
            let p = [
                origin[0],
                origin[1],
                origin[2],
                *depth,
                f64::from(u8::from(crossed)),
            ];
            Shape::made(|error| unsafe {
                lime_tree_text_curved(
                    from.raw(),
                    c_int::from(cut),
                    p.as_ptr(),
                    blob.as_ptr(),
                    blob.len() as c_int,
                    &mut path,
                    &mut note,
                    error,
                )
            })
        }
        Under::Skin(skinned) => {
            let how = skin_how_of(along.as_deref(), flip, wrap_mode.as_deref(), angle_deg)
                .map_err(BuildFail::plain)?;
            let wrapped = skin::lay(&laid.faces, &skinned.info, &skinned.face, how, *depth, cut)
                .map_err(BuildFail::plain)?;
            crossed = wrapped.crosses_seam;
            surface = skinned.info.kind.clone();
            let blob = text::encode(&wrapped.faces);
            let p = [
                origin[0],
                origin[1],
                origin[2],
                *depth,
                f64::from(u8::from(crossed)),
            ];
            drop(skinned);
            Shape::made(|error| unsafe {
                lime_tree_text_skin(
                    from.raw(),
                    c_int::from(cut),
                    p.as_ptr(),
                    blob.as_ptr(),
                    blob.len() as c_int,
                    &mut path,
                    &mut note,
                    error,
                )
            })
        }
        Under::Flat => {
            let blob = text::encode(&laid.faces);
            let p = [
                origin[0], origin[1], origin[2], turn[0], turn[1], turn[2], *depth,
            ];
            Shape::made(|error| unsafe {
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
            })
        }
    };
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
                "surface": surface,
                "crossesSeam": crossed,
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

/// The loops of each letter for the preview: the layout point, the point on the face and the point on the top (or floor), each
/// about `step` mm apart on a curve. `place` takes a layout point to the face's point and the top's.
fn preview_faces(
    laid: &text::Laid,
    thin: &[text::Thin],
    step: f64,
    place: &dyn Fn([f64; 2]) -> Option<(V3, V3)>,
) -> Vec<Value> {
    laid.faces
        .iter()
        .map(|face| {
            let loops: Vec<Value> = std::iter::once(&face.outer)
                .chain(face.holes.iter())
                .map(|contour| {
                    let mut layout = Vec::new();
                    let mut base = Vec::new();
                    let mut top = Vec::new();
                    for p in contour.flatten(step) {
                        let Some((on, up)) = place(p) else { continue };
                        layout.push([round(p[0]), round(p[1])]);
                        base.push([round(on[0]), round(on[1]), round(on[2])]);
                        top.push([round(up[0]), round(up[1]), round(up[2])]);
                    }
                    json!({ "uv": layout, "base": base, "top": top })
                })
                .collect();
            json!({ "ch": face.ch.to_string(), "loops": loops, "thin": thin.iter().any(|t| t.ch == face.ch) })
        })
        .collect()
}

/// A text laid out on the curved face under `point` (a cylinder, a cone, a sphere, a torus or a freeform face), for the card's live
/// preview: each letter's loops as polylines about `step_mm` apart, with the layout point, the point on the face and the point on
/// the top (or floor) of each. A text that would not build (too long, off the face, too deep, across a pole) is the sentence.
#[allow(clippy::too_many_arguments)]
pub(super) fn curved_reply(
    from: &Shape,
    spec: &text::Spec,
    point: [f64; 3],
    depth: f64,
    cut: bool,
    along: Option<&str>,
    flip: bool,
    wrap_mode: Option<&str>,
    line_mm: f64,
    step_mm: f64,
) -> Result<String, String> {
    let target = under(from, point)?;
    let mut spec = spec.clone();
    let angle_deg = spec.angle_deg;
    if matches!(target, Under::Skin(_)) {
        spec.angle_deg = 0.0;
    }
    let laid = text::lay_out(&spec)?;
    if laid.faces.is_empty() {
        return Err("The text has no letters to build. Spaces leave no ink.".into());
    }
    if !(depth.is_finite() && depth >= MIN_DEPTH_MM) {
        return Err("Text needs a depth above 0, in millimetres.".into());
    }
    let thin = text::thin_letters(&laid, line_mm);
    let step = step_mm.clamp(0.05, 2.0);
    let lift = if cut { -depth } else { depth };
    match target {
        Under::Round(info) => {
            let how = how_of(along, flip)?;
            let wrapped = wrap::wrap(&laid.faces, &info, how, depth, cut)?;
            let mapper = wrap::Mapper::new(&info, how);
            let faces = preview_faces(&laid, &thin, step, &|p| {
                let [u, v] = mapper.map(p)?;
                Some((info.point(u, v), info.lifted(u, v, lift)))
            });
            Ok(json!({
                "ok": true,
                "font": laid.font,
                "surface": info.kind,
                "faces": faces,
                "inkMm2": laid.ink_mm2,
                "thin": thin,
                "thinNote": text::thin_sentence(&thin, line_mm),
                "crossesSeam": wrapped.crosses_seam,
                "bounds": wrapped.bounds,
                "wayRoundMm": round(info.way_round(info.v0)),
            })
            .to_string())
        }
        Under::Skin(skinned) => {
            let how = skin_how_of(along, flip, wrap_mode, angle_deg)?;
            let (wrapped, placer) =
                skin::lay_placed(&laid.faces, &skinned.info, &skinned.face, how, depth, cut)?;
            let faces = preview_faces(&laid, &thin, step, &|p| {
                let [u, v] = placer.map(p).ok()?;
                placer.base_and_top(u, v, lift)
            });
            Ok(json!({
                "ok": true,
                "font": laid.font,
                "surface": skinned.info.kind,
                "faces": faces,
                "inkMm2": laid.ink_mm2,
                "thin": thin,
                "thinNote": text::thin_sentence(&thin, line_mm),
                "crossesSeam": wrapped.crosses_seam,
                "bounds": wrapped.bounds,
                "wayRoundMm": placer.way_round().map(round),
            })
            .to_string())
        }
        Under::Flat => Err("Pick a point on a curved face.".into()),
    }
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
