//! Text from real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1): the letters of a string as closed outlines with
//! holes, in millimetres on a plane, ready for the kernel to raise or cut.
//!
//! This is the reading and layout half and needs no Open CASCADE. `ttf-parser` reads the glyph outlines (TrueType quadratics
//! and CFF cubics stay Bézier pieces, never polylines), the layout takes kerning from the font's `GPOS` and `kern` tables
//! and nothing else (no shaping, D6), and the outlines come out as faces: an outer loop and the holes inside it.
//!
//! Two traps the spike found, both handled here:
//! - A CFF font carries a few segments under 2 µm. Kept, they build sliver faces. They are dropped (`clean`).
//! - A glyph drawn from overlapping contours, and letters that touch, build invalid solids as they are. They are united in
//!   2D first (`merge_overlaps`), on polylines, and only those: a font whose letters do not overlap keeps its curves.

#![cfg_attr(not(lime_occt), allow(dead_code))]

pub mod fit;
pub mod fonts;
#[cfg(any(test, lime_occt_test_hooks))]
pub mod synth;
pub mod user;

use lime_recipe::geom2d::{Poly, Region};
use serde::{Deserialize, Serialize};
use ttf_parser::{Face, GlyphId, OutlineBuilder, Tag};

type P = [f64; 2];

/// The most characters one text step takes.
pub const MAX_CHARS: usize = 400;

/// Segments shorter than this are dropped from an outline, mm.
const TINY_MM: f64 = 0.002;

/// A letter that loses more than this share of its area to a nozzle-wide opening is too thin (D8).
pub const THIN_SHARE: f64 = 0.10;

/// How far apart a polyline's points are, for the overlap tests and the thin-stroke opening, mm.
const FLAT_MM: f64 = 0.05;

/// One outline piece after the one before it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line(P),
    Quad(P, P),
    Cubic(P, P, P),
}

impl Seg {
    fn end(&self) -> P {
        match *self {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
        }
    }

    fn map(&self, f: &impl Fn(P) -> P) -> Seg {
        match *self {
            Seg::Line(p) => Seg::Line(f(p)),
            Seg::Quad(a, p) => Seg::Quad(f(a), f(p)),
            Seg::Cubic(a, b, p) => Seg::Cubic(f(a), f(b), f(p)),
        }
    }
}

/// A closed loop: from `start` through each segment, the last ending on `start`.
#[derive(Clone, Debug, PartialEq)]
pub struct Contour {
    pub start: P,
    pub segs: Vec<Seg>,
}

impl Contour {
    fn map(&self, f: &impl Fn(P) -> P) -> Contour {
        Contour {
            start: f(self.start),
            segs: self.segs.iter().map(|seg| seg.map(f)).collect(),
        }
    }

    /// The loop walked the other way, curves and all.
    fn reversed(&self) -> Contour {
        let mut ends = vec![self.start];
        ends.extend(self.segs.iter().map(Seg::end));
        let mut segs = Vec::with_capacity(self.segs.len());
        for i in (0..self.segs.len()).rev() {
            let to = ends[i];
            segs.push(match self.segs[i] {
                Seg::Line(_) => Seg::Line(to),
                Seg::Quad(a, _) => Seg::Quad(a, to),
                Seg::Cubic(a, b, _) => Seg::Cubic(b, a, to),
            });
        }
        Contour {
            start: *ends.last().expect("a start"),
            segs,
        }
    }

    /// Points along the loop, about `step` mm apart on a curve, without repeating the start.
    pub fn flatten(&self, step: f64) -> Vec<P> {
        let mut pts = vec![self.start];
        let mut p0 = self.start;
        let d = |a: P, b: P| (a[0] - b[0]).hypot(a[1] - b[1]);
        for seg in &self.segs {
            match *seg {
                Seg::Line(p) => {
                    pts.push(p);
                    p0 = p;
                }
                Seg::Quad(a, p) => {
                    let n = (((d(p0, a) + d(a, p)) / step).ceil() as usize).clamp(2, 96);
                    for i in 1..=n {
                        let t = i as f64 / n as f64;
                        let m = 1.0 - t;
                        pts.push([
                            m * m * p0[0] + 2.0 * m * t * a[0] + t * t * p[0],
                            m * m * p0[1] + 2.0 * m * t * a[1] + t * t * p[1],
                        ]);
                    }
                    p0 = p;
                }
                Seg::Cubic(a, b, p) => {
                    let n = (((d(p0, a) + d(a, b) + d(b, p)) / step).ceil() as usize).clamp(2, 96);
                    for i in 1..=n {
                        let t = i as f64 / n as f64;
                        let m = 1.0 - t;
                        let w = [m * m * m, 3.0 * m * m * t, 3.0 * m * t * t, t * t * t];
                        pts.push([
                            w[0] * p0[0] + w[1] * a[0] + w[2] * b[0] + w[3] * p[0],
                            w[0] * p0[1] + w[1] * a[1] + w[2] * b[1] + w[3] * p[1],
                        ]);
                    }
                    p0 = p;
                }
            }
        }
        // The last point is the start again.
        pts.pop();
        pts
    }

    /// A loop of straight lines through `pts`.
    fn polygon(pts: &[P]) -> Contour {
        Contour {
            start: pts[0],
            segs: pts[1..]
                .iter()
                .copied()
                .chain(std::iter::once(pts[0]))
                .map(Seg::Line)
                .collect(),
        }
    }
}

/// One letter's piece of ink: an outer loop and the holes inside it (the counters of A, O, 8, g, e, ...).
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphFace {
    pub ch: char,
    pub outer: Contour,
    pub holes: Vec<Contour>,
}

impl GlyphFace {
    fn loops(&self) -> impl Iterator<Item = &Contour> {
        std::iter::once(&self.outer).chain(self.holes.iter())
    }

    /// The face's ink area, mm².
    pub fn area(&self) -> f64 {
        let ring = |c: &Contour| area(&c.flatten(FLAT_MM)).abs();
        ring(&self.outer) - self.holes.iter().map(ring).sum::<f64>()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    #[default]
    Centre,
    Right,
}

/// What a text step is typed as, apart from where it stands and how deep it goes.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub text: String,
    /// A bundled font id, with or without its version.
    pub font: String,
    /// `regular`, `bold`, `italic`, `bold-italic`.
    pub style: Option<String>,
    /// The capitals' height, mm.
    pub height: f64,
    /// Added after every letter, mm. 0 when absent.
    pub spacing: Option<f64>,
    /// Lines this many capital heights apart. 1.3 when absent.
    pub line_spacing: Option<f64>,
    pub align: Align,
    /// The layout turned this much about its anchor, degrees.
    pub angle_deg: f64,
    /// A variable font's weight, 100 to 900 (milestone 4). Absent: the font's own, or 700 for a bold style.
    pub weight: Option<f64>,
}

pub const DEFAULT_LINE_SPACING: f64 = 1.3;

/// A laid-out text, centred on (0, 0): horizontally by line and `align`, vertically the block of lines.
#[derive(Clone, Debug)]
pub struct Laid {
    pub faces: Vec<GlyphFace>,
    /// Each line's advance width, mm.
    pub widths: Vec<f64>,
    /// The ink's box: min u, min v, max u, max v. Empty text has none.
    pub bounds: Option<[f64; 4]>,
    pub ink_mm2: f64,
    /// The bundled font as a step stores it (`sans@4.0`).
    pub font: String,
}

/// The sentence for the characters a font lacks, each named once.
pub(crate) fn lacks(missing: &[char]) -> String {
    let names: Vec<String> = missing.iter().map(|ch| format!("‘{ch}’")).collect();
    match names.len() {
        1 => format!(
            "This font has no {}. Pick another font, or take it out.",
            names[0]
        ),
        n => format!(
            "This font has no {} and {}. Pick another font, or take them out.",
            names[..n - 1].join(", "),
            names[n - 1]
        ),
    }
}

/// What the layout reads from a font: a parsed face, or the letters a project saved of a font whose licence forbids
/// embedding it (`user::Pack`). Glyphs are named by a number the font itself gives out.
pub(crate) trait Glyphs {
    fn glyph(&self, ch: char) -> Option<u32>;
    /// The advance in font units.
    fn advance(&self, glyph: u32) -> f64;
    /// The gap after `left` before `right`, in font units.
    fn kerning(&self, left: u32, right: u32) -> f64;
    /// The glyph's closed outline pieces, in font units.
    fn outline(&self, glyph: u32) -> Vec<Contour>;
    /// The capitals' height, in font units.
    fn cap_height(&self) -> f64;
    /// The sentence for characters the font cannot draw.
    fn lacks(&self, missing: &[char]) -> String {
        lacks(missing)
    }
}

/// A parsed font file, at whatever variation was set on the face.
pub(crate) struct FaceGlyphs<'a>(pub Face<'a>);

impl Glyphs for FaceGlyphs<'_> {
    fn glyph(&self, ch: char) -> Option<u32> {
        self.0.glyph_index(ch).map(|id| u32::from(id.0))
    }
    fn advance(&self, glyph: u32) -> f64 {
        f64::from(self.0.glyph_hor_advance(GlyphId(glyph as u16)).unwrap_or(0))
    }
    fn kerning(&self, left: u32, right: u32) -> f64 {
        kerning(&self.0, GlyphId(left as u16), GlyphId(right as u16))
    }
    fn outline(&self, glyph: u32) -> Vec<Contour> {
        let mut collector = Collector {
            cur: None,
            out: Vec::new(),
            last: [0.0; 2],
        };
        if self
            .0
            .outline_glyph(GlyphId(glyph as u16), &mut collector)
            .is_some()
        {
            collector.finish();
        }
        collector.out
    }
    fn cap_height(&self) -> f64 {
        cap_height(&self.0)
    }
}

struct Collector {
    cur: Option<Contour>,
    out: Vec<Contour>,
    last: P,
}

impl OutlineBuilder for Collector {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish();
        self.last = [f64::from(x), f64::from(y)];
        self.cur = Some(Contour {
            start: self.last,
            segs: Vec::new(),
        });
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let p = [f64::from(x), f64::from(y)];
        if let Some(c) = self.cur.as_mut() {
            if (p[0] - self.last[0]).hypot(p[1] - self.last[1]) > 1e-6 {
                c.segs.push(Seg::Line(p));
                self.last = p;
            }
        }
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let p = [f64::from(x), f64::from(y)];
        if let Some(c) = self.cur.as_mut() {
            c.segs.push(Seg::Quad([f64::from(x1), f64::from(y1)], p));
            self.last = p;
        }
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let p = [f64::from(x), f64::from(y)];
        if let Some(c) = self.cur.as_mut() {
            c.segs.push(Seg::Cubic(
                [f64::from(x1), f64::from(y1)],
                [f64::from(x2), f64::from(y2)],
                p,
            ));
            self.last = p;
        }
    }
    fn close(&mut self) {
        self.finish();
    }
}

impl Collector {
    fn finish(&mut self) {
        if let Some(mut c) = self.cur.take() {
            if (self.last[0] - c.start[0]).hypot(self.last[1] - c.start[1]) > 1e-6 {
                c.segs.push(Seg::Line(c.start));
            }
            if !c.segs.is_empty() {
                self.out.push(c);
            }
        }
    }
}

/// `contour` without segments under 2 µm (CFF fonts carry a few), closed exactly on its start.
fn clean(contour: &Contour) -> Contour {
    let near = |a: P, b: P| (a[0] - b[0]).hypot(a[1] - b[1]) < TINY_MM;
    let mut out = Contour {
        start: contour.start,
        segs: Vec::new(),
    };
    let mut at = contour.start;
    for seg in &contour.segs {
        let tiny = match *seg {
            Seg::Line(p) => near(at, p),
            Seg::Quad(a, p) => near(at, p) && near(at, a),
            Seg::Cubic(a, b, p) => near(at, p) && near(at, a) && near(at, b),
        };
        if tiny {
            continue;
        }
        out.segs.push(*seg);
        at = seg.end();
    }
    let start = out.start;
    if let Some(last) = out.segs.last_mut() {
        match last {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p = start,
        }
    }
    out
}

fn area(poly: &[P]) -> f64 {
    let mut a = 0.0;
    for i in 0..poly.len() {
        let p = poly[i];
        let q = poly[(i + 1) % poly.len()];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
}

fn inside(poly: &[P], p: P) -> bool {
    let mut c = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            c = !c;
        }
        j = i;
    }
    c
}

fn bbox(poly: &[P]) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in poly {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

fn boxes_meet(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] <= b[2] + 1e-6 && b[0] <= a[2] + 1e-6 && a[1] <= b[3] + 1e-6 && b[1] <= a[3] + 1e-6
}

fn cross(o: P, a: P, b: P) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Whether the closed segments ab and cd share a point, touching ends included.
fn segments_meet(a: P, b: P, c: P, d: P) -> bool {
    let d1 = cross(a, b, c);
    let d2 = cross(a, b, d);
    let d3 = cross(c, d, a);
    let d4 = cross(c, d, b);
    let eps = 1e-9;
    if ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))
        && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
    {
        return true;
    }
    let on = |p: P, q: P, r: P| {
        r[0] >= p[0].min(q[0]) - 1e-9
            && r[0] <= p[0].max(q[0]) + 1e-9
            && r[1] >= p[1].min(q[1]) - 1e-9
            && r[1] <= p[1].max(q[1]) + 1e-9
    };
    (d1.abs() <= eps && on(a, b, c))
        || (d2.abs() <= eps && on(a, b, d))
        || (d3.abs() <= eps && on(c, d, a))
        || (d4.abs() <= eps && on(c, d, b))
}

/// Whether two closed polylines cross or touch.
fn rings_meet(a: &[P], b: &[P]) -> bool {
    if !boxes_meet(&bbox(a), &bbox(b)) {
        return false;
    }
    for i in 0..a.len() {
        let (p, q) = (a[i], a[(i + 1) % a.len()]);
        let seg = [
            p[0].min(q[0]),
            p[1].min(q[1]),
            p[0].max(q[0]),
            p[1].max(q[1]),
        ];
        if !boxes_meet(&seg, &bbox(b)) {
            continue;
        }
        for j in 0..b.len() {
            if segments_meet(p, q, b[j], b[(j + 1) % b.len()]) {
                return true;
            }
        }
    }
    false
}

/// A glyph's contours as faces by nesting depth: an outer loop, then the loops one level inside it as its holes, an island
/// in a hole as a face of its own. Outer loops come out counter-clockwise, holes clockwise.
fn faces_of(ch: char, contours: &[Contour]) -> Vec<GlyphFace> {
    let polys: Vec<Vec<P>> = contours.iter().map(|c| c.flatten(FLAT_MM)).collect();
    let areas: Vec<f64> = polys.iter().map(|p| area(p).abs()).collect();
    let n = contours.len();
    let mut depth = vec![0usize; n];
    let mut parent = vec![usize::MAX; n];
    for i in 0..n {
        let probe = polys[i][0];
        for j in 0..n {
            if i != j && areas[j] > areas[i] && inside(&polys[j], probe) {
                depth[i] += 1;
                if parent[i] == usize::MAX || areas[j] < areas[parent[i]] {
                    parent[i] = j;
                }
            }
        }
    }
    let turned = |c: &Contour, poly: &[P], ccw: bool| {
        if (area(poly) > 0.0) == ccw {
            c.clone()
        } else {
            c.reversed()
        }
    };
    let mut out = Vec::new();
    for i in 0..n {
        if depth[i] % 2 != 0 {
            continue;
        }
        let holes = (0..n)
            .filter(|&k| depth[k] % 2 == 1 && parent[k] == i)
            .map(|k| turned(&contours[k], &polys[k], false))
            .collect();
        out.push(GlyphFace {
            ch,
            outer: turned(&contours[i], &polys[i], true),
            holes,
        });
    }
    out
}

/// Whether a glyph's contours overlap each other: two cross, or one inside another runs the same way (the nonzero rule of a
/// variable font's overlapping strokes), which the nesting reading would take for a hole.
fn contours_overlap(contours: &[Contour]) -> bool {
    let polys: Vec<Vec<P>> = contours.iter().map(|c| c.flatten(FLAT_MM)).collect();
    for i in 0..polys.len() {
        for j in i + 1..polys.len() {
            if rings_meet(&polys[i], &polys[j]) {
                return true;
            }
            let (ai, aj) = (area(&polys[i]), area(&polys[j]));
            if (ai > 0.0) == (aj > 0.0)
                && (inside(&polys[i], polys[j][0]) || inside(&polys[j], polys[i][0]))
            {
                return true;
            }
        }
    }
    false
}

/// A glyph's contours united by the nonzero rule: those that run the way the biggest does are filled, the others cut out.
fn union_contours(ch: char, contours: &[Contour]) -> Vec<GlyphFace> {
    let polys: Vec<Vec<P>> = contours.iter().map(|c| c.flatten(0.1)).collect();
    let main = polys
        .iter()
        .map(|p| area(p))
        .fold(0.0f64, |m, a| if a.abs() > m.abs() { a } else { m });
    let mut fill = Region::empty();
    let mut holes = Region::empty();
    for poly in &polys {
        let region = Region::from_poly(&Poly::new(poly.clone()));
        if (area(poly) > 0.0) == (main > 0.0) {
            fill = fill.union(&region);
        } else {
            holes = holes.union(&region);
        }
    }
    faces_of_region(ch, &fill.difference(&holes))
}

/// How far a refitted loop may stray from the polyline it came from, mm.
const FIT_TOL_MM: f64 = 0.004;

/// The polyline loop `pts` as curves again (a united glyph is polylines about 0.1 mm apart, 7 to 10 times the edges of the
/// font's own curves), unless the fit moved the area by more than a third of a percent, when the lines stay.
fn refit(pts: &[P]) -> Contour {
    let fitted = fit::fit_loop(pts, FIT_TOL_MM);
    let before = area(pts).abs();
    let after = area(&fitted.flatten(FLAT_MM / 2.0)).abs();
    if before > 0.0 && (after - before).abs() <= 0.003 * before && fitted.segs.len() < pts.len() {
        fitted
    } else {
        Contour::polygon(pts)
    }
}

fn faces_of_region(ch: char, region: &Region) -> Vec<GlyphFace> {
    region
        .pieces()
        .iter()
        .filter_map(|piece| {
            let loops = piece.loops();
            let first = loops.first()?;
            let ring = |l: &Poly, ccw: bool| {
                let mut pts = l.pts.clone();
                if (area(&pts) > 0.0) != ccw {
                    pts.reverse();
                }
                refit(&pts)
            };
            (first.pts.len() >= 3).then(|| GlyphFace {
                ch,
                outer: ring(first, true),
                holes: loops[1..]
                    .iter()
                    .filter(|l| l.pts.len() >= 3)
                    .map(|l| ring(l, false))
                    .collect(),
            })
        })
        .collect()
}

/// Letters that touch or overlap are united in 2D, so the build never sees two outlines crossing. Only the faces that meet
/// another are rebuilt (as polylines); every other face keeps its curves. Faces keep their order, a united group taking the
/// place of its first.
pub fn merge_overlaps(faces: Vec<GlyphFace>) -> Vec<GlyphFace> {
    let n = faces.len();
    let rings: Vec<Vec<Vec<P>>> = faces
        .iter()
        .map(|f| f.loops().map(|c| c.flatten(FLAT_MM)).collect())
        .collect();
    let boxes: Vec<[f64; 4]> = rings.iter().map(|r| bbox(&r[0])).collect();
    let mut group: Vec<usize> = (0..n).collect();
    fn find(group: &mut [usize], mut i: usize) -> usize {
        while group[i] != i {
            group[i] = group[group[i]];
            i = group[i];
        }
        i
    }
    for i in 0..n {
        for j in i + 1..n {
            if !boxes_meet(&boxes[i], &boxes[j]) {
                continue;
            }
            // A letter wholly inside another's body touches no outline of it; one in a hole of it (the small a of an @) is apart.
            let covers = |a: usize, b: usize| {
                inside(&rings[a][0], rings[b][0][0])
                    && !rings[a][1..]
                        .iter()
                        .any(|hole| inside(hole, rings[b][0][0]))
            };
            let meet = rings[i]
                .iter()
                .any(|a| rings[j].iter().any(|b| rings_meet(a, b)))
                || covers(i, j)
                || covers(j, i);
            if meet {
                let (a, b) = (find(&mut group, i), find(&mut group, j));
                group[b.max(a)] = a.min(b);
            }
        }
    }
    let roots: Vec<usize> = (0..n).map(|i| find(&mut group, i)).collect();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        if roots[i] != i {
            continue;
        }
        let members: Vec<usize> = (0..n).filter(|&k| roots[k] == i).collect();
        if members.len() == 1 {
            out.push(faces[i].clone());
            continue;
        }
        let mut region = Region::empty();
        for &k in &members {
            let outer = Poly::new(rings[k][0].clone());
            let holes: Vec<Poly> = rings[k][1..].iter().map(|r| Poly::new(r.clone())).collect();
            region = region.union(&Region::with_holes(&outer, &holes));
        }
        out.extend(faces_of_region(faces[i].ch, &region));
    }
    out
}

/// The right gap after `left` before `right`, in font units: the `kern` feature's pair adjustments in `GPOS`, and when there
/// are none the old `kern` table. Nothing else (D6).
fn kerning(face: &Face, left: GlyphId, right: GlyphId) -> f64 {
    let mut total = 0.0;
    let mut found = false;
    if let Some(gpos) = face.tables().gpos {
        let mut lookups: Vec<u16> = Vec::new();
        for feature in gpos.features {
            if feature.tag == Tag::from_bytes(b"kern") {
                for index in feature.lookup_indices {
                    if !lookups.contains(&index) {
                        lookups.push(index);
                    }
                }
            }
        }
        for index in lookups {
            let Some(lookup) = gpos.lookups.get(index) else {
                continue;
            };
            for subtable in lookup
                .subtables
                .into_iter::<ttf_parser::gpos::PositioningSubtable>()
            {
                let ttf_parser::gpos::PositioningSubtable::Pair(pair) = subtable else {
                    continue;
                };
                let adjust = match pair {
                    ttf_parser::gpos::PairAdjustment::Format1 { coverage, sets } => coverage
                        .get(left)
                        .and_then(|at| sets.get(at))
                        .and_then(|set| set.get(right))
                        .map(|(first, _)| first.x_advance),
                    ttf_parser::gpos::PairAdjustment::Format2 {
                        coverage,
                        classes,
                        matrix,
                    } => {
                        if coverage.get(left).is_some() {
                            matrix
                                .get((classes.0.get(left), classes.1.get(right)))
                                .map(|(first, _)| first.x_advance)
                        } else {
                            None
                        }
                    }
                };
                if let Some(value) = adjust {
                    // The first subtable that holds the pair answers for its lookup.
                    total += f64::from(value);
                    found = true;
                    break;
                }
            }
        }
    }
    if !found {
        if let Some(kern) = face.tables().kern {
            for subtable in kern.subtables {
                if subtable.horizontal && !subtable.has_state_machine {
                    if let Some(value) = subtable.glyphs_kerning(left, right) {
                        total += f64::from(value);
                    }
                }
            }
        }
    }
    total
}

/// The capitals' height in font units: the font's own number, else the height of an H.
fn cap_height(face: &Face) -> f64 {
    if let Some(cap) = face.capital_height().filter(|cap| *cap > 0) {
        return f64::from(cap);
    }
    if let Some(h) = face.glyph_index('H') {
        if let Some(rect) = face.glyph_bounding_box(h) {
            return f64::from(rect.y_max);
        }
    }
    f64::from(face.units_per_em()) * 0.7
}

/// Lay out `spec`: its characters as faces, centred on (0, 0) and turned by `angle_deg`.
pub fn lay_out(spec: &Spec) -> Result<Laid, String> {
    if !spec.height.is_finite() || spec.height <= 0.0 {
        return Err("Text needs a height (the capitals') above 0, in millimetres.".into());
    }
    let count = spec.text.chars().count();
    if count > MAX_CHARS {
        return Err(format!(
            "Text takes at most {MAX_CHARS} characters a step; use several."
        ));
    }
    // --- A font the person added (milestone 4): found by its id among the fonts this engine was given.
    if user::is_user_id(&spec.font) {
        return user::lay_out(spec);
    }
    let family = fonts::family(&spec.font)?;
    let (bold, italic) = fonts::style_flags(spec.style.as_deref())?;
    if spec.weight.is_some() {
        return Err(format!(
            "‘{}’ has one weight. Use style bold, or a variable font to set a weight.",
            family.name
        ));
    }
    let (file, slant) = fonts::style_file(family, bold, italic)?;
    lay_out_face(spec, file.bytes, slant, fonts::versioned(family))
}

/// `lay_out` for the font file in `bytes`, slanted to make an italic when `slant`. `font` is what the laid text names.
pub fn lay_out_face(spec: &Spec, bytes: &[u8], slant: bool, font: String) -> Result<Laid, String> {
    let face = Face::parse(bytes, 0).map_err(|_| user::UNREADABLE.to_string())?;
    lay_out_with(spec, &FaceGlyphs(face), slant, font)
}

/// `lay_out` over any source of glyphs.
pub(crate) fn lay_out_with(
    spec: &Spec,
    glyphs: &dyn Glyphs,
    slant: bool,
    font: String,
) -> Result<Laid, String> {
    let k = spec.height / glyphs.cap_height();
    let spacing = spec.spacing.unwrap_or(0.0);
    let pitch = spec.line_spacing.unwrap_or(DEFAULT_LINE_SPACING) * spec.height;
    if !(spacing.is_finite() && pitch.is_finite() && pitch >= 0.0) {
        return Err(
            "Letter spacing and line spacing are numbers; line spacing is not negative.".into(),
        );
    }
    let lines: Vec<&str> = spec
        .text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let shear = if slant {
        fonts::SLANT_DEG.to_radians().tan()
    } else {
        0.0
    };
    let block_mid = (spec.height - (lines.len() as f64 - 1.0) * pitch) / 2.0;
    let turn = spec.angle_deg.to_radians();
    let (sin, cos) = turn.sin_cos();
    // Every character the font lacks is named, once, before anything is laid out.
    let mut missing: Vec<char> = Vec::new();
    for ch in spec.text.chars().filter(|ch| *ch != '\n' && *ch != '\r') {
        if ch.is_control() {
            return Err(format!(
                "Text takes letters, digits and symbols, not the control character U+{:04X}.",
                ch as u32
            ));
        }
        if glyphs.glyph(ch).is_none() && !missing.contains(&ch) {
            missing.push(ch);
        }
    }
    if !missing.is_empty() {
        return Err(glyphs.lacks(&missing));
    }
    let mut faces = Vec::new();
    let mut widths = Vec::with_capacity(lines.len());
    // Outlines are read once per distinct letter: a glyph's contours do not depend on where it stands.
    let mut cache: Vec<(u32, Vec<Contour>)> = Vec::new();
    for (row, line) in lines.iter().enumerate() {
        let mut placed: Vec<(u32, f64, char)> = Vec::new();
        let mut pen = 0.0;
        let mut prev: Option<u32> = None;
        for ch in line.chars() {
            let gid = glyphs.glyph(ch).expect("checked above");
            if let Some(prev) = prev {
                pen += glyphs.kerning(prev, gid) * k;
            }
            placed.push((gid, pen, ch));
            pen += glyphs.advance(gid) * k + spacing;
            prev = Some(gid);
        }
        let width = if placed.is_empty() {
            0.0
        } else {
            pen - spacing
        };
        widths.push(width);
        let x0 = match spec.align {
            Align::Left => 0.0,
            Align::Centre => -width / 2.0,
            Align::Right => -width,
        };
        let y0 = -(row as f64) * pitch - block_mid;
        for (gid, at, ch) in placed {
            if !cache.iter().any(|(g, _)| *g == gid) {
                cache.push((gid, glyphs.outline(gid)));
            }
            let contours = &cache.iter().find(|(g, _)| *g == gid).expect("read above").1;
            if contours.is_empty() {
                continue;
            }
            let place = |p: P| -> P {
                let (x, y) = (p[0] * k, p[1] * k);
                let (x, y) = (x + y * shear, y);
                let (x, y) = (x0 + at + x, y0 + y);
                [x * cos - y * sin, x * sin + y * cos]
            };
            let placed: Vec<Contour> = contours
                .iter()
                .map(|c| clean(&c.map(&place)))
                .filter(|c| c.segs.len() >= 2 && area(&c.flatten(FLAT_MM)).abs() > 1e-6)
                .collect();
            if placed.is_empty() {
                continue;
            }
            if contours_overlap(&placed) {
                faces.extend(union_contours(ch, &placed));
            } else {
                faces.extend(faces_of(ch, &placed));
            }
        }
    }
    let faces = merge_overlaps(faces);
    let mut bounds: Option<[f64; 4]> = None;
    let mut ink = 0.0;
    for glyph in &faces {
        ink += glyph.area();
        let b = bbox(&glyph.outer.flatten(FLAT_MM));
        bounds = Some(match bounds {
            None => b,
            Some(o) => [
                o[0].min(b[0]),
                o[1].min(b[1]),
                o[2].max(b[2]),
                o[3].max(b[3]),
            ],
        });
    }
    Ok(Laid {
        faces,
        widths,
        bounds,
        ink_mm2: ink,
        font,
    })
}

/// One letter too thin for the line width.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thin {
    pub ch: char,
    /// How much of the letter's area is narrower than the line, in percent. 100 when it is gone.
    pub lost_pct: f64,
}

/// The letters that lose more than a tenth of their area to an opening by `line_mm` (shrink by half the line, grow back):
/// the places a nozzle that wide cannot print (D8). Each distinct letter once, in order of first appearance.
pub fn thin_letters(laid: &Laid, line_mm: f64) -> Vec<Thin> {
    if line_mm.is_nan() || line_mm <= 0.0 {
        return Vec::new();
    }
    let mut seen: Vec<char> = Vec::new();
    let mut out = Vec::new();
    for glyph in &laid.faces {
        if seen.contains(&glyph.ch) {
            continue;
        }
        seen.push(glyph.ch);
        // Every piece of this letter wherever it stands: the ratio is the same for one copy or several.
        let mut region = Region::empty();
        for same in laid.faces.iter().filter(|other| other.ch == glyph.ch) {
            let outer = Poly::new(same.outer.flatten(FLAT_MM));
            let holes: Vec<Poly> = same
                .holes
                .iter()
                .map(|h| Poly::new(h.flatten(FLAT_MM)))
                .collect();
            region = region.union(&Region::with_holes(&outer, &holes));
        }
        let total = region.area();
        if total.is_nan() || total <= 1e-9 {
            continue;
        }
        let opened = region
            .offset(-line_mm / 2.0)
            .to_region(0.005)
            .offset(line_mm / 2.0)
            .to_region(0.005);
        let lost = (total - opened.area()).max(0.0);
        if lost > THIN_SHARE * total {
            out.push(Thin {
                ch: glyph.ch,
                lost_pct: (100.0 * lost / total).round().min(100.0),
            });
        }
    }
    out
}

/// The sentence under Apply for the letters that will not print: "e, m and 2 are thinner than your 0.4 mm line."
pub fn thin_sentence(thin: &[Thin], line_mm: f64) -> Option<String> {
    if thin.is_empty() {
        return None;
    }
    let names: Vec<String> = thin.iter().map(|t| t.ch.to_string()).collect();
    let list = match names.len() {
        1 => names[0].clone(),
        n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
    };
    let verb = if thin.len() == 1 { "is" } else { "are" };
    Some(format!("{list} {verb} thinner than your {line_mm} mm line. Use a larger size, Bold, or another font."))
}

/// A face's loops as the kernel takes them: `[ch, loops, then each loop: start u, start v, segment count, then each segment
/// as kind (1 line, 2 quad, 3 cubic) and its points]`. Outer loops run counter-clockwise, holes clockwise.
pub fn encode(faces: &[GlyphFace]) -> Vec<f64> {
    let mut out = vec![faces.len() as f64];
    for face in faces {
        out.push(f64::from(face.ch as u32));
        out.push((1 + face.holes.len()) as f64);
        for contour in face.loops() {
            out.push(contour.start[0]);
            out.push(contour.start[1]);
            out.push(contour.segs.len() as f64);
            for seg in &contour.segs {
                match *seg {
                    Seg::Line(p) => out.extend([1.0, p[0], p[1]]),
                    Seg::Quad(a, p) => out.extend([2.0, a[0], a[1], p[0], p[1]]),
                    Seg::Cubic(a, b, p) => out.extend([3.0, a[0], a[1], b[0], b[1], p[0], p[1]]),
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod user_tests;
