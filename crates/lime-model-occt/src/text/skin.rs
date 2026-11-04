//! Text on a sphere, a torus or a freeform face (docs/plan-text-on-curves-and-fonts.md, milestone 3).
//!
//! Those faces are not developable: a flat sheet of letters cannot be unrolled onto them without stretching, so the letters are
//! placed the way a label is laid on a ball, by walking along the surface. The baseline is a geodesic from the anchor (step along
//! the tangent, project back, carry the direction with it), and a point `(x, y)` of the layout is where you arrive by walking `x`
//! along the baseline and then `y` square to it. Lengths along the baseline and along every square line are kept exactly; what
//! cannot be kept is the shortening of lines away from the baseline (a line of latitude is shorter than the equator), which is
//! measured per letter and refused when it passes `TOLERANCE`.
//!
//! The other way is `project`: the layout lies on the plane square to the anchor's normal, and each point is pushed onto the
//! surface along that normal, like a slide projector. Letters stretch where the surface leans away.
//!
//! Every outline piece is cut short enough that the bend of the map inside it stays under a few microns, then each control point
//! is mapped, so a loop stays a loop of Bézier pieces in the surface's `(u, v)`. This is the geometry half and needs no Open
//! CASCADE: the kernel answers the surface's points (`Surf`), this maps the loops, checks them against the face, and the kernel
//! builds the result (the same builds as a cylinder).

use std::cell::Cell;

use serde::Deserialize;

use super::wrap::{bounds_of, mm, piece_len, split, turned, Wrapped, OFF_FACE};
use super::{GlyphFace, Seg, P};

pub type V3 = [f64; 3];

/// How far a letter's size may stray from the layout's, as a share (2 %, the plan's tolerance).
pub const TOLERANCE: f64 = 0.02;

/// A walk on the surface goes in steps of this many millimetres at most.
const STEP_MM: f64 = 0.5;

/// How far a mapped Bézier piece may stray from where the map puts the layout's piece, at its middle, mm. A 20 micron outline is far
/// under the nozzle, and every piece costs an edge in the solid.
const BEND_MM: f64 = 0.02;

/// The share of its size a letter's walls may shrink to inside a tight curve: the area of the offset surface against the surface's.
const FOLD_SHARE: f64 = 0.02;

/// The surface of the face, asked for its points.
pub trait Surf {
    /// The point, `dS/du` and `dS/dv` at `(u, v)`; `None` outside the surface.
    fn d1(&self, u: f64, v: f64) -> Option<(V3, V3, V3)>;
}

/// The face under the anchor, as the kernel describes it. `(u, v)` is Open CASCADE's own.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    /// `sphere`, `torus` or `freeform`.
    pub kind: String,
    /// +1 when the face's outward normal is `Su x Sv`, -1 when it is the other way.
    pub sigma: f64,
    /// The anchor on the surface.
    pub u0: f64,
    pub v0: f64,
    /// The face's own `(u, v)` box.
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
    /// 0 when the surface is not periodic that way.
    #[serde(default)]
    pub u_period: f64,
    #[serde(default)]
    pub v_period: f64,
    /// The face goes all the way round in that direction: it has a seam there.
    #[serde(default)]
    pub full_u: bool,
    #[serde(default)]
    pub full_v: bool,
}

/// How the text sits on the surface.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SkinHow {
    /// The baseline starts along the surface's `v` instead of its `u`.
    pub v_first: bool,
    /// The text turned half a turn about its anchor.
    pub flip: bool,
    /// The text turned this much more about its anchor, degrees.
    pub angle_deg: f64,
    /// Project along the anchor's normal instead of walking along the surface.
    pub project: bool,
}

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn mul(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn len(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: V3) -> V3 {
    let n = len(a);
    if n < 1e-300 {
        a
    } else {
        mul(a, 1.0 / n)
    }
}

/// `t` with its part along `n` taken out, unit.
fn tangent_of(t: V3, n: V3) -> V3 {
    unit(sub(t, mul(n, dot(t, n))))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fail {
    /// Off the surface.
    Off,
    /// A pole, a pinch or a fold: the map is not defined or not trustworthy there.
    Sharp,
    /// Projection: the surface leans too far away from the way it is looked at.
    Steep,
    /// A walk that did not settle.
    Lost,
}

struct Frame {
    p: V3,
    su: V3,
    sv: V3,
    /// The face's outward normal, unit.
    n: V3,
}

/// A position on the surface and the direction a walk is going, a unit vector in the tangent plane.
#[derive(Clone, Copy, Debug)]
struct St {
    u: f64,
    v: f64,
    t: V3,
}

/// The surface with the side the letters rise towards.
pub struct Ground<'a> {
    pub surf: &'a dyn Surf,
    pub sigma: f64,
    sphere: bool,
}

impl<'a> Ground<'a> {
    pub fn new(surf: &'a dyn Surf, info: &SkinInfo) -> Self {
        Ground {
            surf,
            sigma: if info.sigma < 0.0 { -1.0 } else { 1.0 },
            sphere: info.kind == "sphere",
        }
    }

    fn frame(&self, u: f64, v: f64) -> Result<Frame, Fail> {
        let (p, su, sv) = self.surf.d1(u, v).ok_or(Fail::Off)?;
        let (a, b) = (len(su), len(sv));
        let c = cross(su, sv);
        // A pole or a pinch: a partial of no length, or two that lie on each other. A sphere's pole is where one of them shrinks
        // to a hair of the other.
        if a < 1e-6 || b < 1e-6 || len(c) < 1e-6 * a * b || (self.sphere && a.min(b) < 0.01 * a.max(b)) {
            return Err(Fail::Sharp);
        }
        Ok(Frame {
            p,
            su,
            sv,
            n: mul(c, self.sigma / len(c)),
        })
    }

    /// `(du, dv)` per unit of length for a tangent vector `w`.
    fn duv(f: &Frame, w: V3) -> (f64, f64) {
        let (e, g) = (dot(f.su, f.su), dot(f.sv, f.sv));
        let m = dot(f.su, f.sv);
        let det = e * g - m * m;
        let (a, b) = (dot(f.su, w), dot(f.sv, w));
        ((g * a - m * b) / det, (e * b - m * a) / det)
    }

    /// One step of `h` mm from `s` along its direction, which is carried along: a midpoint step, halved where the surface bends
    /// too sharply for it.
    fn step(&self, s: St, h: f64, depth: u8) -> Result<St, Fail> {
        let a = self.frame(s.u, s.v)?;
        let t0 = tangent_of(s.t, a.n);
        let (du, dv) = Self::duv(&a, t0);
        let (um, vm) = (s.u + du * h / 2.0, s.v + dv * h / 2.0);
        let b = self.frame(um, vm)?;
        let tm = tangent_of(t0, b.n);
        let (du2, dv2) = Self::duv(&b, tm);
        let (u1, v1) = (s.u + du2 * h, s.v + dv2 * h);
        let c = self.frame(u1, v1)?;
        let chord = len(sub(c.p, a.p));
        if (chord - h).abs() > 0.03 * h + 1e-9 {
            if depth < 6 {
                let half = self.step(s, h / 2.0, depth + 1)?;
                return self.step(half, h / 2.0, depth + 1);
            }
            return Err(Fail::Sharp);
        }
        Ok(St {
            u: u1,
            v: v1,
            t: tangent_of(tm, c.n),
        })
    }

    /// `s` after walking `dist` mm along its direction.
    fn walk(&self, mut s: St, dist: f64) -> Result<St, Fail> {
        if dist < 1e-9 {
            return Ok(s);
        }
        let n = (dist / STEP_MM).ceil().max(1.0) as usize;
        let h = dist / n as f64;
        for _ in 0..n {
            s = self.step(s, h, 0)?;
        }
        Ok(s)
    }
}

/// Where the sentences of a failed walk say what happened.
fn sentence(fail: Fail, kind: &str) -> String {
    match fail {
        Fail::Off => OFF_FACE.into(),
        Fail::Sharp if kind == "sphere" => {
            "The text crosses the pole of this sphere. Move it away from the pole, or make it smaller.".into()
        }
        Fail::Sharp => {
            "The text crosses a point where this face pinches or folds. Move it, or make it smaller.".into()
        }
        Fail::Steep => {
            "This face leans too far away to project the text onto it. Use wrap, or move the text.".into()
        }
        Fail::Lost => {
            "Part of the text would miss this face when projected onto it. Use wrap, move the text, or make it smaller.".into()
        }
    }
}

/// Newton's method for the point of the surface that lies along the projection direction from a point of the layout's plane.
struct Projector {
    origin: V3,
    right: V3,
    up: V3,
    normal: V3,
    last: Cell<[f64; 2]>,
}

/// The layout mapped onto the surface. `map` takes a layout point (mm, centred on the anchor) to `(u, v)`.
pub struct Placer<'a> {
    g: Ground<'a>,
    info: &'a SkinInfo,
    /// States along the baseline at 0, `STEP_MM`, ... in each direction; each one's direction is the way the walk went.
    pos: Vec<St>,
    neg: Vec<St>,
    project: Option<Projector>,
    /// Half the way round, mm, when the baseline came back on itself.
    pub half_round: Option<f64>,
}

/// The direction the baseline starts in at the anchor: along `u` or `v` (turned so that it reads upright for a part standing in
/// the world), the half turn of `flip`, then the angle, about the outward normal.
fn start_direction(g: &Ground, f: &Frame, how: SkinHow) -> V3 {
    let along = if how.v_first { f.sv } else { f.su };
    let mut right = unit(along);
    // Up is the normal crossed with right. A text that would read upside down in the world is turned over; a face that looks along
    // the world's up or down has no up of its own, and keeps U.
    let up = cross(f.n, right);
    if up[2] < -0.1 {
        right = mul(right, -1.0);
    }
    if how.flip {
        right = mul(right, -1.0);
    }
    let a = how.angle_deg.to_radians();
    let up = cross(f.n, right);
    let _ = g;
    unit(add(mul(right, a.cos()), mul(up, a.sin())))
}

impl<'a> Placer<'a> {
    /// Lay a baseline out over `x_lo ..= x_hi` mm from the anchor (both sides) and get ready to map.
    pub fn new(
        surf: &'a dyn Surf,
        info: &'a SkinInfo,
        how: SkinHow,
        x_lo: f64,
        x_hi: f64,
    ) -> Result<Self, String> {
        let g = Ground::new(surf, info);
        let fail = |f: Fail| sentence(f, &info.kind);
        let a = g.frame(info.u0, info.v0).map_err(fail)?;
        let right = start_direction(&g, &a, how);
        let first = St {
            u: info.u0,
            v: info.v0,
            t: right,
        };
        let mut half_round = None;
        let mut table = |dir: f64, reach: f64| -> Result<Vec<St>, String> {
            let count = (reach / STEP_MM).ceil().max(0.0) as usize + 2;
            let mut out = Vec::with_capacity(count);
            let mut s = St {
                t: mul(first.t, dir),
                ..first
            };
            out.push(s);
            let mut chords = vec![0.0f64];
            for _ in 1..count {
                s = g.step(s, STEP_MM, 0).map_err(fail)?;
                let f = g.frame(s.u, s.v).map_err(fail)?;
                chords.push(len(sub(f.p, a.p)));
                out.push(s);
            }
            // The baseline comes back towards the anchor once it is past half way round: the chord peaks there. The peak, between
            // three samples, by the parabola through them.
            let peak = (1..chords.len().saturating_sub(1))
                .find(|&i| chords[i] >= chords[i - 1] && chords[i] > chords[i + 1] + 1e-7);
            if let Some(peak) = peak {
                if half_round.is_none() {
                    let (c0, c1, c2) = (chords[peak - 1], chords[peak], chords[peak + 1]);
                    let bend = c0 - 2.0 * c1 + c2;
                    let shift = if bend.abs() > 1e-12 { 0.5 * (c0 - c2) / bend } else { 0.0 };
                    half_round = Some((peak as f64 + shift.clamp(-1.0, 1.0)) * STEP_MM);
                }
            }
            Ok(out)
        };
        let pos = table(1.0, x_hi.max(0.0))?;
        let neg = table(-1.0, (-x_lo).max(0.0))?;
        let project = how.project.then(|| Projector {
            origin: a.p,
            right,
            up: cross(a.n, right),
            normal: a.n,
            last: Cell::new([info.u0, info.v0]),
        });
        let placer = Placer {
            g,
            info,
            pos,
            neg,
            project,
            half_round,
        };
        Ok(placer)
    }

    /// The point of the surface at `(u, v)`.
    fn point_at(&self, uv: P) -> Option<V3> {
        self.g.surf.d1(uv[0], uv[1]).map(|t| t.0)
    }

    fn fermi(&self, x: f64, y: f64) -> Result<P, Fail> {
        let (table, sign) = if x >= 0.0 {
            (&self.pos, 1.0)
        } else {
            (&self.neg, -1.0)
        };
        let ax = x.abs();
        let i = ((ax / STEP_MM).floor() as usize).min(table.len() - 1);
        let at = self.g.walk(table[i], ax - i as f64 * STEP_MM)?;
        if y.abs() < 1e-12 {
            return Ok([at.u, at.v]);
        }
        let f = self.g.frame(at.u, at.v)?;
        // The walk's direction is `sign` times the text's right; up is the normal crossed with right.
        let right = mul(tangent_of(at.t, f.n), sign);
        let up = cross(f.n, right);
        let end = self.g.walk(
            St {
                u: at.u,
                v: at.v,
                t: mul(up, y.signum()),
            },
            y.abs(),
        )?;
        Ok([end.u, end.v])
    }

    fn projected(&self, x: f64, y: f64) -> Result<P, Fail> {
        let pr = self.project.as_ref().expect("a projector");
        let target = add(add(pr.origin, mul(pr.right, x)), mul(pr.up, y));
        let [mut u, mut v] = pr.last.get();
        for _ in 0..40 {
            let f = self.g.frame(u, v)?;
            let d = sub(f.p, target);
            let r = [dot(d, pr.right), dot(d, pr.up)];
            if r[0].hypot(r[1]) < 1e-7 {
                if dot(f.n, pr.normal) < 0.2 {
                    return Err(Fail::Steep);
                }
                pr.last.set([u, v]);
                return Ok([u, v]);
            }
            let j = [
                [dot(f.su, pr.right), dot(f.sv, pr.right)],
                [dot(f.su, pr.up), dot(f.sv, pr.up)],
            ];
            let det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
            if det.abs() < 1e-9 * len(f.su) * len(f.sv) {
                return Err(Fail::Steep);
            }
            let mut du = -(j[1][1] * r[0] - j[0][1] * r[1]) / det;
            let mut dv = -(-j[1][0] * r[0] + j[0][0] * r[1]) / det;
            // No step moves further than a few millimetres on the surface.
            let reach = du.abs() * len(f.su) + dv.abs() * len(f.sv);
            if reach > 5.0 {
                du *= 5.0 / reach;
                dv *= 5.0 / reach;
            }
            u += du;
            v += dv;
        }
        Err(Fail::Lost)
    }

    /// The point of the surface at `(u, v)` and the same point moved `lift` along its outward normal (negative goes into the part).
    pub fn base_and_top(&self, u: f64, v: f64, lift: f64) -> Option<(V3, V3)> {
        let f = self.g.frame(u, v).ok()?;
        Some((f.p, add(f.p, mul(f.n, lift))))
    }

    /// The way round the surface along the baseline, mm, when the baseline came back on itself.
    pub fn way_round(&self) -> Option<f64> {
        self.half_round.map(|half| 2.0 * half)
    }

    /// A layout point `(x, y)` (mm, centred on the anchor) as `(u, v)`.
    pub fn map(&self, p: P) -> Result<P, String> {
        let at = if self.project.is_some() {
            self.projected(p[0], p[1])
        } else {
            self.fermi(p[0], p[1])
        };
        at.map_err(|f| sentence(f, &self.info.kind))
    }

    /// How much a line `y` mm from the baseline is stretched along it: the surface's length over the layout's.
    fn stretch(&self, x: f64, y: f64) -> Result<f64, Fail> {
        let delta = 0.25;
        let a = self.fermi(x - delta, y)?;
        let b = self.fermi(x + delta, y)?;
        let pa = self.g.frame(a[0], a[1])?.p;
        let pb = self.g.frame(b[0], b[1])?.p;
        Ok(len(sub(pb, pa)) / (2.0 * delta))
    }
}

/// The middle of a piece from `from`.
fn mid_of(from: P, seg: &Seg) -> P {
    let at = |a: P, b: P, c: P, d: P, w: [f64; 4]| [w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0], w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1]];
    match *seg {
        Seg::Line(p) => [(from[0] + p[0]) / 2.0, (from[1] + p[1]) / 2.0],
        Seg::Quad(c, p) => at(from, c, p, p, [0.25, 0.5, 0.25, 0.0]),
        Seg::Cubic(a, b, p) => at(from, a, b, p, [0.125, 0.375, 0.375, 0.125]),
    }
}

/// The piece mapped, cut in two (and again) wherever the mapped Bézier's middle strays from where the map puts the layout's middle
/// by more than `BEND_MM` on the surface. `at` and `at_uv` are the piece's start in the layout and in `(u, v)`; the end in `(u, v)`
/// is returned.
fn map_piece(
    at: P,
    at_uv: P,
    seg: Seg,
    placer: &Placer,
    depth: u8,
    out: &mut Vec<Seg>,
) -> Result<P, String> {
    let map = |p: P| placer.map(p);
    let mapped = match seg {
        Seg::Line(p) => Seg::Line(map(p)?),
        Seg::Quad(c, p) => Seg::Quad(map(c)?, map(p)?),
        Seg::Cubic(a, b, p) => Seg::Cubic(map(a)?, map(b)?, map(p)?),
    };
    let end_uv = match mapped {
        Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
    };
    if depth < 6 && piece_len(at, &seg) > 0.3 {
        let exact = map(mid_of(at, &seg))?;
        let drawn = mid_of(at_uv, &mapped);
        let strays = match (placer.point_at(exact), placer.point_at(drawn)) {
            (Some(a), Some(b)) => len(sub(a, b)) > BEND_MM,
            _ => true,
        };
        if strays {
            let mut cur = at_uv;
            for (from, piece) in split(at, seg, 2) {
                cur = map_piece(from, cur, piece, placer, depth + 1, out)?;
            }
            return Ok(cur);
        }
    }
    out.push(mapped);
    Ok(end_uv)
}

/// `contour` mapped, piece by piece.
fn map_contour(contour: &super::Contour, placer: &Placer) -> Result<super::Contour, String> {
    let start = placer.map(contour.start)?;
    let mut out = super::Contour {
        start,
        segs: Vec::new(),
    };
    let (mut at, mut at_uv) = (contour.start, start);
    for seg in &contour.segs {
        at_uv = map_piece(at, at_uv, *seg, placer, 0, &mut out.segs)?;
        at = match *seg {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
        };
    }
    // The loop closes on its start exactly.
    if let Some(last) = out.segs.last_mut() {
        match last {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p = start,
        }
    }
    Ok(out)
}

/// The area of the surface moved `lift` along its normal, against the surface's own, at `(u, v)`: 1 on a flat face, under 1 where
/// the move goes towards the centre of a curve, 0 where it folds over.
fn scale_at(g: &Ground, u: f64, v: f64, lift: f64) -> Option<f64> {
    let f = g.frame(u, v).ok()?;
    let (hu, hv) = (0.01 / len(f.su), 0.01 / len(f.sv));
    let up = |uu: f64, vv: f64| -> Option<V3> {
        let o = g.frame(uu, vv).ok()?;
        Some(add(o.p, mul(o.n, lift)))
    };
    let pu = mul(sub(up(u + hu, v)?, up(u - hu, v)?), 0.5 / hu);
    let pv = mul(sub(up(u, v + hv)?, up(u, v - hv)?), 0.5 / hv);
    let base = dot(cross(f.su, f.sv), f.n);
    Some(dot(cross(pu, pv), f.n) / base)
}

/// Whether letters `depth` deep (raised, or cut when `cut`) fold over at any of `pts`. The sentence names a depth that works.
fn fold_check(g: &Ground, pts: &[P], depth: f64, cut: bool, kind: &str) -> Result<(), String> {
    let lift = if cut { -depth } else { depth };
    // At most a few hundred points, spread over the whole text.
    let stride = (pts.len() / 300).max(1);
    let samples: Vec<P> = pts.iter().step_by(stride).copied().collect();
    let worst = |t: f64| -> Result<(f64, P), Fail> {
        let mut at = (f64::INFINITY, [0.0, 0.0]);
        for p in &samples {
            let s = scale_at(g, p[0], p[1], t).ok_or(Fail::Sharp)?;
            if s < at.0 {
                at = (s, *p);
            }
        }
        Ok(at)
    };
    let (share, at) = worst(lift).map_err(|f| sentence(f, kind))?;
    if share >= FOLD_SHARE {
        return Ok(());
    }
    // The depth at the worst point that keeps the walls from folding, found by halving.
    let (mut lo, mut hi) = (0.0f64, depth);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        let t = if cut { -mid } else { mid };
        match scale_at(g, at[0], at[1], t) {
            Some(s) if s >= FOLD_SHARE => lo = mid,
            _ => hi = mid,
        }
    }
    // Everywhere else too: step down until no sample folds.
    let mut limit = lo;
    for _ in 0..40 {
        let t = if cut { -limit } else { limit };
        if worst(t).map(|w| w.0 >= FOLD_SHARE).unwrap_or(false) {
            break;
        }
        limit *= 0.95;
    }
    Err(format!(
        "Letters this deep would fold over inside this curve. Use a depth under {} mm.",
        mm((limit * 10.0).floor() / 10.0)
    ))
}

/// The sentence for text longer than the way round.
fn too_long(kind: &str, round_mm: f64) -> String {
    format!(
        "The text is longer than the way round this {kind} ({} mm). Make it smaller or use two lines.",
        mm(round_mm)
    )
}

/// Which way a periodic direction is crossed: `Ok(true)` when the ink crosses the face's seam, `Err` when it leaves the face.
fn range(
    lo: f64,
    hi: f64,
    min: f64,
    max: f64,
    full: bool,
    period: f64,
    margin: f64,
) -> Result<bool, String> {
    let eps = 1e-6;
    if full {
        if hi - lo >= period - 1e-3 {
            return Err("The text is longer than the way round this face. Make it smaller or use two lines.".into());
        }
        Ok(lo < min + margin || hi > max - margin)
    } else if lo < min - eps || hi > max + eps {
        Err(OFF_FACE.into())
    } else {
        Ok(false)
    }
}

/// Map `faces` (a laid-out text, centred on the anchor) onto the surface, and check it against the face: not longer than the way
/// round, not off the face, not across a pole, not deeper than the curve allows, letters of their size within `TOLERANCE`.
pub fn lay(
    faces: &[GlyphFace],
    info: &SkinInfo,
    surf: &dyn Surf,
    how: SkinHow,
    depth: f64,
    cut: bool,
) -> Result<Wrapped, String> {
    lay_placed(faces, info, surf, how, depth, cut).map(|(wrapped, _)| wrapped)
}

/// `lay`, and the placer that mapped it, for a preview that maps more points.
pub fn lay_placed<'a>(
    faces: &[GlyphFace],
    info: &'a SkinInfo,
    surf: &'a dyn Surf,
    how: SkinHow,
    depth: f64,
    cut: bool,
) -> Result<(Wrapped, Placer<'a>), String> {
    let layout = bounds_of(faces).ok_or("The text has no letters to build. Spaces leave no ink.")?;
    let placer = Placer::new(surf, info, how, layout[0] - 1.0, layout[2] + 1.0)?;
    if !how.project {
        if let Some(half) = placer.half_round {
            let span = layout[2] - layout[0];
            if span >= 2.0 * half - 0.5 {
                return Err(too_long(&info.kind, 2.0 * half));
            }
        }
    }
    let mut out = Vec::with_capacity(faces.len());
    for face in faces {
        let outer = map_contour(&face.outer, &placer)?;
        let mut holes = Vec::with_capacity(face.holes.len());
        for hole in &face.holes {
            holes.push(turned(map_contour(hole, &placer)?, false));
        }
        out.push(GlyphFace {
            ch: face.ch,
            outer: turned(outer, true),
            holes,
        });
    }
    // A letter keeps its size when the lines through it, at its bottom, middle and top, are stretched by the tolerance at most on
    // average. Measured, not hoped for: a line of latitude is shorter than the equator, and the further from the baseline the more.
    if !how.project {
        let mut worst = 0.0f64;
        for face in faces {
            let b = bounds_of(std::slice::from_ref(face)).expect("a letter has a box");
            let x = (b[0] + b[2]) / 2.0;
            let mut total = 0.0;
            for y in [b[1], (b[1] + b[3]) / 2.0, b[3]] {
                total += placer.stretch(x, y).map_err(|f| sentence(f, &info.kind))? - 1.0;
            }
            worst = worst.max((total / 3.0).abs());
        }
        if worst > TOLERANCE {
            let height = layout[3] - layout[1];
            let allowed = height * (TOLERANCE / worst).sqrt();
            return Err(format!(
                "The letters are too big for this curve to keep their size within {} %. Make the text smaller than {} mm across.",
                mm(TOLERANCE * 100.0),
                mm((allowed * 10.0).floor() / 10.0)
            ));
        }
    }
    let bounds = bounds_of(&out).ok_or("The text has no letters to build. Spaces leave no ink.")?;
    let ground = &placer.g;
    // The seam is crossed where the ink comes within 0.05 mm of the face's end in a direction that goes all the way round.
    let a = ground
        .frame(info.u0, info.v0)
        .map_err(|f| sentence(f, &info.kind))?;
    let (mu, mv) = (0.05 / len(a.su), 0.05 / len(a.sv));
    let crosses_u = range(bounds[0], bounds[2], info.u_min, info.u_max, info.full_u, info.u_period, mu)?;
    let crosses_v = range(bounds[1], bounds[3], info.v_min, info.v_max, info.full_v, info.v_period, mv)?;
    // The walls of the letters, and the points the fold check looks at.
    let mut pts: Vec<P> = Vec::new();
    for face in &out {
        for c in std::iter::once(&face.outer).chain(face.holes.iter()) {
            pts.push(c.start);
            for seg in &c.segs {
                match *seg {
                    Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => pts.push(p),
                }
            }
        }
    }
    fold_check(ground, &pts, depth, cut, &info.kind)?;
    let wrapped = Wrapped {
        faces: out,
        bounds,
        crosses_seam: crosses_u || crosses_v,
    };
    Ok((wrapped, placer))
}

#[cfg(test)]
mod tests;
