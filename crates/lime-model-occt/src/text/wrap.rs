//! Text wrapped round a cylinder or a cone (docs/plan-text-on-curves-and-fonts.md, milestone 2).
//!
//! A cylinder and a cone are developable: unrolled flat they keep every length. So the layout (letters on a plane, in
//! millimetres) is mapped onto the surface's `(u, v)` through that unrolling, and a letter keeps its true size. On a
//! cylinder the map is affine, so lines stay lines and Béziers stay Béziers in `(u, v)`, exactly. On a cone it is not
//! (the angle round the apex is `u · sin(half angle)`, the distance from the apex is `v` plus a constant), so each outline
//! piece is first cut short enough that the map's bend stays under a few microns, then every point goes through the exact
//! map.
//!
//! This is the geometry half and needs no Open CASCADE: the kernel answers which face is under the anchor and what its
//! surface is (`SurfaceInfo`), this maps the loops, checks the text against the face, and the kernel builds the result.

use serde::Deserialize;

use super::{area, Contour, GlyphFace, Seg, P};

/// How far the unrolled straight line may stray from the mapped piece on a cone, mm.
const BEND_MM: f64 = 0.004;

/// How much of the way round an engraving may eat towards the axis: a letter cut deeper than this share of the radius folds
/// over itself.
const DEEP_SHARE: f64 = 0.9;

/// The face under the anchor, as the kernel describes it. `(u, v)` is Open CASCADE's own: a cylinder's `u` is the angle and
/// `v` the distance along its axis; a cone's `v` runs along a generator and `radius` is the radius at `v = 0`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceInfo {
    /// `cylinder` or `cone`.
    pub kind: String,
    pub origin: [f64; 3],
    pub xdir: [f64; 3],
    pub ydir: [f64; 3],
    pub zdir: [f64; 3],
    pub radius: f64,
    /// A cone's half angle, radians. 0 for a cylinder.
    #[serde(default)]
    pub semi_angle: f64,
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
    /// The face goes all the way round (a whole cylinder wall): `u` has no ends, only a seam.
    pub full_ring: bool,
}

/// How the text sits on the surface.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct How {
    /// The baseline runs up the axis (`along`) instead of round it.
    pub along: bool,
    /// The text turned half a turn: reads the other way round, upside down.
    pub flip: bool,
}

/// The letters mapped onto the surface: every loop in `(u, v)`, counter-clockwise for an outer loop and clockwise for a hole.
#[derive(Clone, Debug)]
pub struct Wrapped {
    pub faces: Vec<GlyphFace>,
    /// The ink's `(u, v)` box: min u, min v, max u, max v.
    pub bounds: [f64; 4],
    /// The ink leaves the face's `u` range through the seam of a face that goes all the way round.
    pub crosses_seam: bool,
}

#[cfg(test)]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn mul(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = dot(a, a).sqrt();
    if n < 1e-300 {
        a
    } else {
        mul(a, 1.0 / n)
    }
}

impl SurfaceInfo {
    fn is_cone(&self) -> bool {
        self.kind == "cone" && self.semi_angle.abs() > 1e-9
    }

    /// The radius of the ring at `v`.
    pub fn ring_radius(&self, v: f64) -> f64 {
        self.radius + v * self.semi_angle.sin()
    }

    fn radial(&self, u: f64) -> [f64; 3] {
        add(mul(self.xdir, u.cos()), mul(self.ydir, u.sin()))
    }

    /// The point `S(u, v)` in model space.
    pub fn point(&self, u: f64, v: f64) -> [f64; 3] {
        let (sin, cos) = self.semi_angle.sin_cos();
        let r = self.radius + v * sin;
        add(
            add(self.origin, mul(self.radial(u), r)),
            mul(self.zdir, v * cos),
        )
    }

    /// `(dS/du, dS/dv)`.
    fn partials(&self, u: f64, v: f64) -> ([f64; 3], [f64; 3]) {
        let (sin, cos) = self.semi_angle.sin_cos();
        let r = self.radius + v * sin;
        let tangent = add(mul(self.xdir, -u.sin()), mul(self.ydir, u.cos()));
        (
            mul(tangent, r),
            add(mul(self.radial(u), sin), mul(self.zdir, cos)),
        )
    }

    /// The face's outward normal at `(u, v)`: the side the letters rise towards.
    pub fn outward(&self, u: f64, v: f64) -> [f64; 3] {
        let (su, sv) = self.partials(u, v);
        mul(unit(cross(su, sv)), self.sigma)
    }

    /// `S(u, v)` moved `distance` along the outward normal (negative goes into the part).
    pub fn lifted(&self, u: f64, v: f64, distance: f64) -> [f64; 3] {
        add(self.point(u, v), mul(self.outward(u, v), distance))
    }

    /// The face's outward normal points away from the axis (a cylinder wall seen from outside).
    pub fn convex(&self) -> bool {
        let n = self.outward(self.u0, self.v0);
        dot(n, self.radial(self.u0)) > 0.0
    }

    /// The way round at `v`, mm.
    pub fn way_round(&self, v: f64) -> f64 {
        std::f64::consts::TAU * self.ring_radius(v).abs()
    }

    fn name(&self) -> &str {
        if self.kind == "cone" {
            "cone"
        } else {
            "cylinder"
        }
    }
}

/// The map from the layout's millimetres to `(u, v)`.
pub struct Mapper<'a> {
    s: &'a SurfaceInfo,
    /// Layout turned by this much first: 90 degrees for `along`, 180 for `flip`.
    cos: f64,
    sin: f64,
    /// Which way the layout's right and up run along `u` and `v`.
    su: f64,
    sv: f64,
    cone: Option<ConeChart>,
}

struct ConeChart {
    /// sin of the half angle, positive.
    k: f64,
    /// The anchor's distance from the apex, positive, and which way `v` runs from the apex (+1 or -1).
    rho0: f64,
    tau: f64,
    apex: f64,
}

impl<'a> Mapper<'a> {
    pub fn new(s: &'a SurfaceInfo, how: How) -> Self {
        let turn = (if how.along { 90.0f64 } else { 0.0 } + if how.flip { 180.0 } else { 0.0 })
            .to_radians();
        let (_, sv_axis) = s.partials(s.u0, s.v0);
        // Up is the way `v` runs, unless that points down in the world: then up is the other way, so a standing cylinder
        // reads upright whichever way its axis was made.
        let sv = if sv_axis[2] < -0.1 { -1.0 } else { 1.0 };
        // Right is up x normal, so that right, up and the outward normal are a right-handed set.
        let su = sv * s.sigma;
        let cone = s.is_cone().then(|| {
            let sin = s.semi_angle.sin();
            let apex = -s.radius / sin;
            let d0 = s.v0 - apex;
            ConeChart {
                k: sin.abs(),
                rho0: d0.abs(),
                tau: if d0 < 0.0 { -1.0 } else { 1.0 },
                apex,
            }
        });
        Mapper {
            s,
            cos: turn.cos(),
            sin: turn.sin(),
            su,
            sv,
            cone,
        }
    }

    /// A layout point `(x, y)` as `(u, v)`. `None` past a cone's tip.
    pub fn map(&self, p: P) -> Option<P> {
        let (x, y) = (
            p[0] * self.cos - p[1] * self.sin,
            p[0] * self.sin + p[1] * self.cos,
        );
        let (a, b) = (self.su * x, self.sv * y);
        match &self.cone {
            None => Some([self.s.u0 + a / self.s.radius, self.s.v0 + b]),
            Some(c) => {
                let along = c.rho0 + c.tau * b;
                if along < 1e-6 {
                    return None;
                }
                let rho = along.hypot(a);
                let phi = a.atan2(along);
                Some([self.s.u0 + phi / c.k, c.apex + c.tau * rho])
            }
        }
    }

    /// How long a piece of the layout may be before its map bends more than `BEND_MM`. Unbounded on a cylinder.
    fn longest_piece(&self) -> f64 {
        match &self.cone {
            None => f64::INFINITY,
            Some(c) => (8.0 * c.rho0 * BEND_MM).sqrt().max(0.4),
        }
    }
}

fn lerp(a: P, b: P, t: f64) -> P {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// `seg` (from `from`) in `n` pieces of the same curve, de Casteljau.
pub(super) fn split(from: P, seg: Seg, n: usize) -> Vec<(P, Seg)> {
    let mut out = Vec::with_capacity(n);
    let mut start = from;
    for i in 0..n {
        let (t0, t1) = (i as f64 / n as f64, (i + 1) as f64 / n as f64);
        let piece = match seg {
            Seg::Line(to) => Seg::Line(lerp(from, to, t1)),
            Seg::Quad(c, to) => {
                let at = |t: f64| lerp(lerp(from, c, t), lerp(c, to, t), t);
                // The piece's control point is where its end tangents meet: Q(t0) + (t1 - t0) Q'(t0) / 2.
                let slope = lerp(sub2(c, from), sub2(to, c), t0);
                let p0 = at(t0);
                Seg::Quad(
                    [p0[0] + (t1 - t0) * slope[0], p0[1] + (t1 - t0) * slope[1]],
                    at(t1),
                )
            }
            Seg::Cubic(c1, c2, to) => {
                let bez = |t: f64| {
                    let m = 1.0 - t;
                    let w = [m * m * m, 3.0 * m * m * t, 3.0 * m * t * t, t * t * t];
                    [
                        w[0] * from[0] + w[1] * c1[0] + w[2] * c2[0] + w[3] * to[0],
                        w[0] * from[1] + w[1] * c1[1] + w[2] * c2[1] + w[3] * to[1],
                    ]
                };
                let d = |t: f64| {
                    let m = 1.0 - t;
                    let w = [m * m, 2.0 * m * t, t * t];
                    let q = [
                        [3.0 * (c1[0] - from[0]), 3.0 * (c1[1] - from[1])],
                        [3.0 * (c2[0] - c1[0]), 3.0 * (c2[1] - c1[1])],
                        [3.0 * (to[0] - c2[0]), 3.0 * (to[1] - c2[1])],
                    ];
                    [
                        w[0] * q[0][0] + w[1] * q[1][0] + w[2] * q[2][0],
                        w[0] * q[0][1] + w[1] * q[1][1] + w[2] * q[2][1],
                    ]
                };
                let h = (t1 - t0) / 3.0;
                let (p0, p3) = (bez(t0), bez(t1));
                let (d0, d1) = (d(t0), d(t1));
                Seg::Cubic(
                    [p0[0] + d0[0] * h, p0[1] + d0[1] * h],
                    [p3[0] - d1[0] * h, p3[1] - d1[1] * h],
                    p3,
                )
            }
        };
        let end = match piece {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
        };
        out.push((start, piece));
        start = end;
    }
    out
}

fn sub2(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}

pub(super) fn piece_len(from: P, seg: &Seg) -> f64 {
    match *seg {
        Seg::Line(p) => dist(from, p),
        Seg::Quad(c, p) => dist(from, c) + dist(c, p),
        Seg::Cubic(a, b, p) => dist(from, a) + dist(a, b) + dist(b, p),
    }
}

/// `contour` mapped, every piece cut to at most `longest` mm first. `None` when a point falls past a cone's tip.
fn map_contour(contour: &Contour, mapper: &Mapper) -> Option<Contour> {
    let longest = mapper.longest_piece();
    let mut out = Contour {
        start: mapper.map(contour.start)?,
        segs: Vec::new(),
    };
    let mut at = contour.start;
    for seg in &contour.segs {
        let end = match *seg {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => p,
        };
        let n = if longest.is_finite() {
            (piece_len(at, seg) / longest).ceil().max(1.0) as usize
        } else {
            1
        };
        let pieces = if n > 1 {
            split(at, *seg, n)
        } else {
            vec![(at, *seg)]
        };
        for (_, piece) in pieces {
            out.segs.push(match piece {
                Seg::Line(p) => Seg::Line(mapper.map(p)?),
                Seg::Quad(c, p) => Seg::Quad(mapper.map(c)?, mapper.map(p)?),
                Seg::Cubic(a, b, p) => Seg::Cubic(mapper.map(a)?, mapper.map(b)?, mapper.map(p)?),
            });
        }
        at = end;
    }
    // The loop closes on its start exactly.
    let start = out.start;
    if let Some(last) = out.segs.last_mut() {
        match last {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p = start,
        }
    }
    Some(out)
}

/// `contour` running the way `ccw` says, as `(u, v)` points read it.
pub(super) fn turned(contour: Contour, ccw: bool) -> Contour {
    if (area(&contour.flatten(0.05)) > 0.0) == ccw {
        contour
    } else {
        contour.reversed()
    }
}

pub(super) fn bounds_of(faces: &[GlyphFace]) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    for face in faces {
        for c in std::iter::once(&face.outer).chain(face.holes.iter()) {
            // Control points bound a Bézier, so the box never misses ink.
            let mut pts = vec![c.start];
            for seg in &c.segs {
                match *seg {
                    Seg::Line(p) => pts.push(p),
                    Seg::Quad(a, p) => pts.extend([a, p]),
                    Seg::Cubic(a, bb, p) => pts.extend([a, bb, p]),
                }
            }
            for p in pts {
                b = Some(match b {
                    None => [p[0], p[1], p[0], p[1]],
                    Some(o) => [
                        o[0].min(p[0]),
                        o[1].min(p[1]),
                        o[2].max(p[0]),
                        o[3].max(p[1]),
                    ],
                });
            }
        }
    }
    b
}

pub(super) fn mm(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded}")
    }
}

/// The sentence for text that runs off the face.
pub const OFF_FACE: &str =
    "The text runs off this face. Move it, make it smaller, or put it on one face.";

/// Map `faces` (a laid-out text, centred on the anchor) onto the surface `s`, and check it against the face: not longer than
/// the way round, not off the face, not deeper than the curve allows. Refusals are sentences, one each.
pub fn wrap(
    faces: &[GlyphFace],
    s: &SurfaceInfo,
    how: How,
    depth: f64,
    cut: bool,
) -> Result<Wrapped, String> {
    let mapper = Mapper::new(s, how);
    let mut out = Vec::with_capacity(faces.len());
    for face in faces {
        let outer = map_contour(&face.outer, &mapper)
            .ok_or("The text runs past the tip of the cone. Move it, or make it smaller.")?;
        let mut holes = Vec::with_capacity(face.holes.len());
        for hole in &face.holes {
            holes.push(turned(
                map_contour(hole, &mapper).ok_or(
                    "The text runs past the tip of the cone. Move it, or make it smaller.",
                )?,
                false,
            ));
        }
        out.push(GlyphFace {
            ch: face.ch,
            outer: turned(outer, true),
            holes,
        });
    }
    let bounds = bounds_of(&out).ok_or("The text has no letters to build. Spaces leave no ink.")?;
    let (u_lo, v_lo, u_hi, v_hi) = (bounds[0], bounds[1], bounds[2], bounds[3]);
    // Round the face, the text must be shorter than the way round at its widest.
    if u_hi - u_lo >= std::f64::consts::TAU - 1e-3 {
        let ring = s.way_round(s.v0);
        return Err(format!(
            "The text is longer than the way round this {} ({} mm). Make it smaller or use two lines.",
            s.name(),
            mm(ring)
        ));
    }
    let eps = 1e-6;
    if v_lo < s.v_min - eps || v_hi > s.v_max + eps {
        return Err(OFF_FACE.into());
    }
    let mut crosses_seam = false;
    if s.full_ring {
        // The ink must stay within one turn of the face's seam to be read as one text; whether it crosses the seam decides
        // the build.
        let margin = 0.05
            / s.ring_radius(v_lo)
                .abs()
                .min(s.ring_radius(v_hi).abs())
                .max(1.0);
        crosses_seam = u_lo < s.u_min + margin || u_hi > s.u_max - margin;
    } else if u_lo < s.u_min - eps || u_hi > s.u_max + eps {
        return Err(OFF_FACE.into());
    }
    // Letters this deep fold over inside the curve.
    let inward = if s.convex() { cut } else { !cut };
    if inward {
        let rings = [s.ring_radius(v_lo), s.ring_radius(v_hi)];
        let smallest = rings[0].abs().min(rings[1].abs());
        let cos = s.semi_angle.cos().abs().max(1e-3);
        let limit = DEEP_SHARE * smallest / cos;
        if depth >= limit {
            return Err(format!(
                "Letters this deep would fold over inside this curve. Use a depth under {} mm.",
                mm((limit * 10.0).floor() / 10.0)
            ));
        }
    }
    Ok(Wrapped {
        faces: out,
        bounds,
        crosses_seam,
    })
}

#[cfg(test)]
mod tests;
