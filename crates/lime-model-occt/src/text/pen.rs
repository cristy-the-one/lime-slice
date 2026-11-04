//! Pen fonts (docs/plan-text-on-curves-and-fonts.md, milestone 5): letters drawn as lines with a pen width, laid out and built
//! through the same pipeline as an outline font, so they sit on a cylinder, a cone, a sphere, a torus or a freeform face and are
//! one step, not one box per stroke.
//!
//! Two fonts. `stroke` is the 4 × 6 grid font the app has always had (capitals, digits and `- + . , : ! ? / ' &`; a lowercase
//! letter is drawn as its capital, D3). `line` is the same grid with lowercase letters and a few more marks, drawn for this
//! app (it is not the Hershey data, see the plan's "As built (milestone 5)"). Each stroke becomes a capsule (round ends) of the
//! pen width, the letter's capsules are united in 2D, and what comes out is an outline glyph like any font's.

use lime_recipe::geom2d::{Poly, Region};

use super::{lay_out_with, refit, Contour, Glyphs, Laid, Spec};

type P = [f64; 2];

pub const STROKE: &str = "stroke";
pub const LINE: &str = "line";

/// The stored ids, with their versions.
pub const STROKE_ID: &str = "stroke@1";
pub const LINE_ID: &str = "line@1";

/// The grid the letters are drawn on: 4 wide, capitals 6 tall.
const CAP_UNITS: f64 = 6.0;
const ADVANCE_UNITS: f64 = 4.0;

type Strokes = &'static [&'static [P]];

/// A, B, ... 0-9 and the marks of the stroke font, as the app has drawn them since text began.
static STROKE_GLYPHS: &[(char, Strokes)] = &[
    ('0', &[&[[1.0, 0.0], [0.0, 1.0], [0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0]], &[[0.5, 1.0], [3.5, 5.0]]]),
    ('1', &[&[[1.0, 5.0], [2.0, 6.0], [2.0, 0.0]], &[[1.0, 0.0], [3.0, 0.0]]]),
    ('2', &[&[[0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [0.0, 0.0], [4.0, 0.0]]]),
    ('3', &[&[[0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [3.0, 3.0], [1.5, 3.0]], &[[3.0, 3.0], [4.0, 2.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('4', &[&[[3.0, 0.0], [3.0, 6.0], [0.0, 2.0], [4.0, 2.0]]]),
    ('5', &[&[[4.0, 6.0], [0.0, 6.0], [0.0, 3.5], [3.0, 3.5], [4.0, 2.5], [4.0, 1.0], [3.0, 0.0], [0.0, 0.0]]]),
    ('6', &[&[[4.0, 5.0], [3.0, 6.0], [1.0, 6.0], [0.0, 5.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0], [4.0, 2.0], [3.0, 3.0], [0.0, 3.0]]]),
    ('7', &[&[[0.0, 6.0], [4.0, 6.0], [1.0, 0.0]]]),
    ('8', &[&[[1.0, 3.0], [0.0, 4.0], [0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [3.0, 3.0], [1.0, 3.0], [0.0, 2.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0], [4.0, 2.0], [3.0, 3.0]]]),
    ('9', &[&[[4.0, 3.0], [1.0, 3.0], [0.0, 4.0], [0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0]]]),
    ('A', &[&[[0.0, 0.0], [0.0, 4.0], [2.0, 6.0], [4.0, 4.0], [4.0, 0.0]], &[[0.0, 3.0], [4.0, 3.0]]]),
    ('B', &[&[[0.0, 0.0], [0.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [3.0, 3.0], [0.0, 3.0]], &[[3.0, 3.0], [4.0, 2.0], [4.0, 1.0], [3.0, 0.0], [0.0, 0.0]]]),
    ('C', &[&[[4.0, 6.0], [1.0, 6.0], [0.0, 5.0], [0.0, 1.0], [1.0, 0.0], [4.0, 0.0]]]),
    ('D', &[&[[0.0, 0.0], [0.0, 6.0], [2.0, 6.0], [4.0, 4.0], [4.0, 2.0], [2.0, 0.0], [0.0, 0.0]]]),
    ('E', &[&[[4.0, 6.0], [0.0, 6.0], [0.0, 0.0], [4.0, 0.0]], &[[0.0, 3.0], [3.0, 3.0]]]),
    ('F', &[&[[4.0, 6.0], [0.0, 6.0], [0.0, 0.0]], &[[0.0, 3.0], [3.0, 3.0]]]),
    ('G', &[&[[4.0, 5.0], [3.0, 6.0], [1.0, 6.0], [0.0, 5.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0], [4.0, 3.0], [2.0, 3.0]]]),
    ('H', &[&[[0.0, 0.0], [0.0, 6.0]], &[[4.0, 0.0], [4.0, 6.0]], &[[0.0, 3.0], [4.0, 3.0]]]),
    ('I', &[&[[1.0, 6.0], [3.0, 6.0]], &[[2.0, 6.0], [2.0, 0.0]], &[[1.0, 0.0], [3.0, 0.0]]]),
    ('J', &[&[[4.0, 6.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('K', &[&[[0.0, 0.0], [0.0, 6.0]], &[[4.0, 6.0], [0.0, 2.0]], &[[1.5, 3.5], [4.0, 0.0]]]),
    ('L', &[&[[0.0, 6.0], [0.0, 0.0], [4.0, 0.0]]]),
    ('M', &[&[[0.0, 0.0], [0.0, 6.0], [2.0, 3.0], [4.0, 6.0], [4.0, 0.0]]]),
    ('N', &[&[[0.0, 0.0], [0.0, 6.0], [4.0, 0.0], [4.0, 6.0]]]),
    ('O', &[&[[1.0, 0.0], [0.0, 1.0], [0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0]]]),
    ('P', &[&[[0.0, 0.0], [0.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [3.0, 3.0], [0.0, 3.0]]]),
    ('Q', &[&[[1.0, 0.0], [0.0, 1.0], [0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0]], &[[2.5, 1.5], [4.0, 0.0]]]),
    ('R', &[&[[0.0, 0.0], [0.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [3.0, 3.0], [0.0, 3.0]], &[[2.0, 3.0], [4.0, 0.0]]]),
    ('S', &[&[[4.0, 5.0], [3.0, 6.0], [1.0, 6.0], [0.0, 5.0], [0.0, 4.0], [1.0, 3.0], [3.0, 3.0], [4.0, 2.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('T', &[&[[0.0, 6.0], [4.0, 6.0]], &[[2.0, 6.0], [2.0, 0.0]]]),
    ('U', &[&[[0.0, 6.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0], [4.0, 6.0]]]),
    ('V', &[&[[0.0, 6.0], [2.0, 0.0], [4.0, 6.0]]]),
    ('W', &[&[[0.0, 6.0], [1.0, 0.0], [2.0, 3.0], [3.0, 0.0], [4.0, 6.0]]]),
    ('X', &[&[[0.0, 0.0], [4.0, 6.0]], &[[0.0, 6.0], [4.0, 0.0]]]),
    ('Y', &[&[[0.0, 6.0], [2.0, 3.0], [4.0, 6.0]], &[[2.0, 3.0], [2.0, 0.0]]]),
    ('Z', &[&[[0.0, 6.0], [4.0, 6.0], [0.0, 0.0], [4.0, 0.0]]]),
    ('-', &[&[[1.0, 3.0], [3.0, 3.0]]]),
    ('+', &[&[[0.0, 3.0], [4.0, 3.0]], &[[2.0, 1.0], [2.0, 5.0]]]),
    ('.', &[&[[2.0, 0.0], [2.0, 0.01]]]),
    (',', &[&[[2.0, 0.5], [1.5, -0.8]]]),
    (':', &[&[[2.0, 4.5], [2.0, 4.51]], &[[2.0, 1.5], [2.0, 1.51]]]),
    ('!', &[&[[2.0, 6.0], [2.0, 2.0]], &[[2.0, 0.0], [2.0, 0.01]]]),
    ('?', &[&[[0.0, 5.0], [1.0, 6.0], [3.0, 6.0], [4.0, 5.0], [4.0, 4.0], [2.0, 2.5], [2.0, 1.8]], &[[2.0, 0.0], [2.0, 0.01]]]),
    ('/', &[&[[0.0, 0.0], [4.0, 6.0]]]),
    ('\'', &[&[[2.0, 6.0], [2.0, 4.5]]]),
    ('&', &[&[[4.0, 0.0], [1.0, 4.0], [1.0, 5.0], [2.0, 6.0], [3.0, 5.0], [3.0, 4.0], [0.0, 2.0], [0.0, 1.0], [1.0, 0.0], [2.0, 0.0], [4.0, 2.0]]]),
];

/// What `line` adds: lowercase letters (x-height 4, ascenders to 6, descenders to -2) and a few marks.
static LINE_GLYPHS: &[(char, Strokes)] = &[
    ('a', &[&[[4.0, 4.0], [4.0, 0.0]], &[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('b', &[&[[0.0, 6.0], [0.0, 0.0]], &[[0.0, 3.0], [1.0, 4.0], [3.0, 4.0], [4.0, 3.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('c', &[&[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('d', &[&[[4.0, 6.0], [4.0, 0.0]], &[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('e', &[&[[0.0, 2.0], [4.0, 2.0], [4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('f', &[&[[4.0, 5.0], [3.0, 6.0], [2.0, 6.0], [1.0, 5.0], [1.0, 0.0]], &[[0.0, 4.0], [3.0, 4.0]]]),
    ('g', &[&[[4.0, 4.0], [4.0, -1.0], [3.0, -2.0], [1.0, -2.0], [0.0, -1.0]], &[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('h', &[&[[0.0, 6.0], [0.0, 0.0]], &[[0.0, 3.0], [1.0, 4.0], [3.0, 4.0], [4.0, 3.0], [4.0, 0.0]]]),
    ('i', &[&[[2.0, 4.0], [2.0, 0.0]], &[[2.0, 5.5], [2.0, 5.51]]]),
    ('j', &[&[[2.0, 4.0], [2.0, -1.0], [1.0, -2.0], [0.0, -1.0]], &[[2.0, 5.5], [2.0, 5.51]]]),
    ('k', &[&[[0.0, 6.0], [0.0, 0.0]], &[[4.0, 4.0], [0.0, 1.5]], &[[1.5, 2.5], [4.0, 0.0]]]),
    ('l', &[&[[2.0, 6.0], [2.0, 0.0]]]),
    ('m', &[&[[0.0, 4.0], [0.0, 0.0]], &[[0.0, 3.0], [0.8, 4.0], [1.6, 4.0], [2.0, 3.0], [2.0, 0.0]], &[[2.0, 3.0], [2.8, 4.0], [3.6, 4.0], [4.0, 3.0], [4.0, 0.0]]]),
    ('n', &[&[[0.0, 4.0], [0.0, 0.0]], &[[0.0, 3.0], [1.0, 4.0], [3.0, 4.0], [4.0, 3.0], [4.0, 0.0]]]),
    ('o', &[&[[1.0, 0.0], [0.0, 1.0], [0.0, 3.0], [1.0, 4.0], [3.0, 4.0], [4.0, 3.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0]]]),
    ('p', &[&[[0.0, 4.0], [0.0, -2.0]], &[[0.0, 3.0], [1.0, 4.0], [3.0, 4.0], [4.0, 3.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('q', &[&[[4.0, 4.0], [4.0, -2.0]], &[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]]]),
    ('r', &[&[[0.0, 4.0], [0.0, 0.0]], &[[0.0, 3.0], [1.0, 4.0], [3.0, 4.0]]]),
    ('s', &[&[[4.0, 3.0], [3.0, 4.0], [1.0, 4.0], [0.0, 3.0], [1.0, 2.0], [3.0, 2.0], [4.0, 1.0], [3.0, 0.0], [1.0, 0.0], [0.0, 1.0]]]),
    ('t', &[&[[1.5, 6.0], [1.5, 1.0], [2.5, 0.0], [3.5, 0.0]], &[[0.0, 4.0], [3.5, 4.0]]]),
    ('u', &[&[[0.0, 4.0], [0.0, 1.0], [1.0, 0.0], [3.0, 0.0], [4.0, 1.0]], &[[4.0, 4.0], [4.0, 0.0]]]),
    ('v', &[&[[0.0, 4.0], [2.0, 0.0], [4.0, 4.0]]]),
    ('w', &[&[[0.0, 4.0], [1.0, 0.0], [2.0, 3.0], [3.0, 0.0], [4.0, 4.0]]]),
    ('x', &[&[[0.0, 4.0], [4.0, 0.0]], &[[0.0, 0.0], [4.0, 4.0]]]),
    ('y', &[&[[0.0, 4.0], [2.0, 0.0]], &[[4.0, 4.0], [1.0, -2.0]]]),
    ('z', &[&[[0.0, 4.0], [4.0, 4.0], [0.0, 0.0], [4.0, 0.0]]]),
    ('(', &[&[[3.0, 6.0], [1.0, 4.0], [1.0, 2.0], [3.0, 0.0]]]),
    (')', &[&[[1.0, 6.0], [3.0, 4.0], [3.0, 2.0], [1.0, 0.0]]]),
    ('=', &[&[[0.0, 2.0], [4.0, 2.0]], &[[0.0, 4.0], [4.0, 4.0]]]),
    ('_', &[&[[0.0, -1.0], [4.0, -1.0]]]),
];

/// Whether `font` (with or without its version) is a pen font.
pub fn is_pen(font: &str) -> bool {
    matches!(font.split('@').next(), Some(STROKE) | Some(LINE))
}

/// The stored id of a pen font, or a sentence for a version this build does not have.
pub fn versioned(font: &str) -> Result<&'static str, String> {
    let (name, version) = match font.split_once('@') {
        Some((n, v)) => (n, Some(v)),
        None => (font, None),
    };
    let id = match name {
        STROKE => STROKE_ID,
        LINE => LINE_ID,
        _ => return Err(format!("There is no font called ‘{font}’.")),
    };
    match version {
        None | Some("1") => Ok(id),
        Some(v) => Err(format!("This build has {id}, not {name}@{v}. Pick the font again.")),
    }
}

/// The pen font's letters as the layout reads them.
struct Pen {
    /// `line` has lowercase of its own; `stroke` draws a lowercase letter as its capital.
    lowercase: bool,
    /// The pen's width in grid units.
    width: f64,
}

impl Pen {
    fn strokes(&self, ch: char) -> Option<Strokes> {
        let find = |table: &'static [(char, Strokes)], c: char| table.iter().find(|(k, _)| *k == c).map(|(_, s)| *s);
        if ch == ' ' {
            return Some(&[]);
        }
        if self.lowercase {
            if let Some(s) = find(LINE_GLYPHS, ch) {
                return Some(s);
            }
            return find(STROKE_GLYPHS, ch);
        }
        find(STROKE_GLYPHS, ch.to_ascii_uppercase())
    }
}

/// One stroke segment as a capsule: a rectangle with a half circle on each end.
fn capsule(a: P, b: P, r: f64) -> Poly {
    const ARC: usize = 10;
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    if len < 1e-9 {
        let pts = (0..2 * ARC)
            .map(|i| {
                let t = std::f64::consts::TAU * i as f64 / (2 * ARC) as f64;
                [a[0] + r * t.cos(), a[1] + r * t.sin()]
            })
            .collect();
        return Poly::new(pts);
    }
    let base = dy.atan2(dx);
    let mut pts = Vec::with_capacity(2 * ARC + 2);
    // Round the far end from -90 to +90 degrees about the stroke's direction, then the near end.
    for i in 0..=ARC {
        let t = base - std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * i as f64 / ARC as f64;
        pts.push([b[0] + r * t.cos(), b[1] + r * t.sin()]);
    }
    for i in 0..=ARC {
        let t = base + std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * i as f64 / ARC as f64;
        pts.push([a[0] + r * t.cos(), a[1] + r * t.sin()]);
    }
    Poly::new(pts)
}

impl Glyphs for Pen {
    fn glyph(&self, ch: char) -> Option<u32> {
        self.strokes(ch).map(|_| ch as u32)
    }
    fn advance(&self, _glyph: u32) -> f64 {
        ADVANCE_UNITS
    }
    fn kerning(&self, _left: u32, _right: u32) -> f64 {
        0.0
    }
    fn outline(&self, glyph: u32) -> Vec<Contour> {
        let Some(strokes) = char::from_u32(glyph).and_then(|ch| self.strokes(ch)) else {
            return Vec::new();
        };
        let r = self.width / 2.0;
        let mut ink = Region::empty();
        for line in strokes {
            for pair in line.windows(2) {
                ink = ink.union(&Region::from_poly(&capsule(pair[0], pair[1], r)));
            }
        }
        let mut out = Vec::new();
        for piece in ink.pieces() {
            for ring in piece.loops() {
                if ring.pts.len() >= 3 {
                    out.push(refit(&ring.pts));
                }
            }
        }
        out
    }
    fn cap_height(&self) -> f64 {
        CAP_UNITS
    }
    fn lacks(&self, missing: &[char]) -> String {
        let names: Vec<String> = missing.iter().map(|ch| format!("‘{ch}’")).collect();
        let have = if self.lowercase {
            "letters, digits, space, and - + . , : ! ? / ' & ( ) = _"
        } else {
            "A-Z, 0-9, space, and - + . , : ! ? / ' &"
        };
        format!("The font has no {}. It has {have}.", names.join(", "))
    }
}

/// `spec` laid out in a pen font. The pen is `strokeWidth` wide (0.15 of the height when absent) and the gap after each letter is
/// `spacing` (a third of the height when absent), as the stroke font has always been typed.
pub fn lay_out(spec: &Spec) -> Result<Laid, String> {
    let id = versioned(&spec.font)?;
    let name = id.split('@').next().unwrap_or(STROKE);
    if spec.weight.is_some() {
        return Err("This font has one weight. Set the stroke width instead.".into());
    }
    if let Some(style) = spec.style.as_deref() {
        if !matches!(style, "" | "regular") {
            return Err("This font has one style. Use a stroke width for a heavier line, or pick an outline font for bold and italic.".into());
        }
    }
    let width_mm = spec.stroke_mm.unwrap_or(spec.height * 0.15);
    if !(width_mm.is_finite() && width_mm > 0.0 && width_mm <= spec.height / 2.0) {
        return Err("strokeWidth is above 0 and at most half the height.".into());
    }
    let k = spec.height / CAP_UNITS;
    let pen = Pen { lowercase: name == LINE, width: width_mm / k };
    let mut with_gap = spec.clone();
    if with_gap.spacing.is_none() {
        with_gap.spacing = Some(spec.height / 3.0);
    }
    let mut laid = lay_out_with(&with_gap, &pen, false, id.to_string())?;
    laid.font = id.to_string();
    Ok(laid)
}
