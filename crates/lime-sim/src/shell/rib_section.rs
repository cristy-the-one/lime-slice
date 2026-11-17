//! A rib's cross-section: its outline as a polygon and the beam properties
//! the solver needs, integrated exactly from that polygon.
//!
//! **The outline is the built one.** [`RibSection::outline`] mirrors
//! `ribShape` in `src/modeling/rib-net.ts` (the `ribNet` step that builds
//! the ribs), corner for corner, so the solver stiffens the wall with the
//! section that gets made. Only the part over the wall (`v ≥ 0`) is rib;
//! `ribNet` sinks its sections a little into the wall, and that part is
//! wall. Section frame: `u` across the rib (symmetric), `v` along the
//! wall's normal from its face. Right half from the wall up:
//!
//! - straight: `(w/2, 0)`, `(w/2, h)`; with a root, the root's foot and arc
//!   in place of the first point.
//! - drafted: the half-width at `v` is `w/2 + (h/2 − v)·tan(draft)`, so `w`
//!   is the width at half the height and the area over the wall, before
//!   the root, is `w·h`: `(w/2 + h·tan/2, 0)` or the root, then
//!   `(w/2 − h·tan/2, h)`.
//! - tee: `(w/2, 0)` or the root, the web's top `(w/2, h − ft − c)`, the
//!   flange `(F/2, h − ft)`, `(F/2, h)`, with `c = (F/2 − w/2)·tan(chamfer)`
//!   the chamfer under the flange (0 for a square flange). No draft on the
//!   web.
//! - root: an arc of radius `r` touching the wall and the flank, centre
//!   `(K − t r + r √(1 + t²), r)` with `K` the flank's foot and `t` the
//!   draft's tangent, from its foot on the wall to the flank, cut into
//!   2 to 6 chords so that each is within [`ARC_TOLERANCE`] of the circle
//!   (`ribNet`'s chord tolerance with its usual sink).
//!
//! `ribNet` builds a non-plain profile only when the rib stands more than
//! [`MIN_RISE`] above what its root, flange and chamfer need
//! ([`RibSection::least_height`]); [`RibSection::check`] refuses the same.
//! Below a blend height `ribNet` shrinks the section to flat over a rib's
//! tapered ends; a stretch of rib carries its full section at its own
//! height, which is what the solver models.
//!
//! **Properties.** Area, centroid and second moments come from Green's
//! theorem over the polygon, exact for it. The torsion constant is not a
//! polygon integral (it needs Saint-Venant's warping problem):
//!
//! - straight and drafted: Roark's rectangle,
//!   `J = a b³ (1/3 − 0.21 (b/a)(1 − b⁴ / (12 a⁴)))`, `a ≥ b`, on the
//!   rectangle of the same height and area (mean width). A drafted rib of
//!   a few degrees is within a few per cent of a rectangle; a root arc
//!   adds torsional stiffness it leaves out, so it errs low.
//! - tee: the open thin-walled sum of the two rectangles, the web (wall to
//!   the flange's underside at its edge, `h − ft`, width `w`) and the
//!   flange (`F × ft`). It leaves out the chamfer and the junction and errs
//!   low, by of the order of ten per cent on stocky tees. Twist carries
//!   little of a wall's load.
//!
//! **Shear areas.** For shear along the height (the rib bending as the
//! wall does) only the web carries it: `κ A` with κ = 5/6 for the straight
//! and drafted ribs, and `w × h` for the tee, the usual web-area rule. The
//! flange takes almost no vertical shear: its shear stress is the web's
//! times `w / F` where it meets the web and falls to zero at its free
//! edges. Checked against TET10 solids (`tests/rib_profiles.rs`): with the
//! web's area the clamped plate with a tee comes out 2.9 % stiffer than the
//! solid and the tee strip 0.06 %; with `κ A` of the whole tee, 10.5 % and
//! 0.6 %. Across the rib, `κ A` with κ = 5/6 for every profile.

use crate::error::SimError;

/// Largest gap between a root arc and its chords, mm (as `ribNet`).
pub const ARC_TOLERANCE: f64 = 0.05;
/// The fewest and most chords a root arc is cut into (as `ribNet`).
pub const ROOT_CHORDS: [usize; 2] = [2, 6];
/// How far a non-plain rib must stand above what its root and flange
/// need, mm (as `ribNet`).
pub const MIN_RISE: f64 = 0.1;

/// Shear correction of a solid rectangle.
const KAPPA: f64 = 5.0 / 6.0;

/// A rib's cross-section shape; its height is given separately.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RibSection {
    /// A rectangle `width` wide, with root arcs of `root_radius` (0: none).
    Rectangular { width: f64, root_radius: f64 },
    /// A trapezoid `width` wide at half its height, each flank leaning
    /// `draft_deg` from the wall's normal (wider at the wall), with root
    /// arcs.
    Drafted {
        width: f64,
        draft_deg: f64,
        root_radius: f64,
    },
    /// A web `web_width` wide under a flange `flange_width × flange_thickness`,
    /// its underside chamfered `flange_chamfer_deg` from the wall's plane
    /// (0: a square flange), with root arcs where the web meets the wall.
    Tee {
        web_width: f64,
        flange_width: f64,
        flange_thickness: f64,
        flange_chamfer_deg: f64,
        root_radius: f64,
    },
}

/// Beam properties of a section at one height. Lengths in mm.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SectionProperties {
    pub area: f64,
    /// Height of the centroid above the rib's foot on the wall.
    pub centroid: f64,
    /// Second moment about the centroidal axis across the rib: the rib
    /// bending out of the wall, as the wall does.
    pub i_across: f64,
    /// Second moment about the centroidal axis along the wall's normal:
    /// the rib bending sideways.
    pub i_normal: f64,
    /// Saint-Venant torsion constant (see the module notes).
    pub torsion: f64,
    /// Shear area for shear along the height.
    pub shear_height: f64,
    /// Shear area for shear across the rib.
    pub shear_across: f64,
}

impl RibSection {
    /// A plain rectangle, `width` wide.
    pub fn rectangular(width: f64) -> Self {
        Self::Rectangular {
            width,
            root_radius: 0.0,
        }
    }

    fn width(&self) -> f64 {
        match *self {
            Self::Rectangular { width, .. } | Self::Drafted { width, .. } => width,
            Self::Tee { web_width, .. } => web_width,
        }
    }

    fn root_radius(&self) -> f64 {
        match *self {
            Self::Rectangular { root_radius, .. }
            | Self::Drafted { root_radius, .. }
            | Self::Tee { root_radius, .. } => root_radius,
        }
    }

    /// The draft's tangent (0 but for a drafted rib).
    fn draft_tan(&self) -> f64 {
        match *self {
            Self::Drafted { draft_deg, .. } => draft_deg.to_radians().tan(),
            _ => 0.0,
        }
    }

    /// For a tee, the chamfer's rise under the flange; 0 otherwise.
    fn chamfer_rise(&self) -> f64 {
        match *self {
            Self::Tee {
                web_width,
                flange_width,
                flange_chamfer_deg,
                ..
            } => 0.5 * (flange_width - web_width) * flange_chamfer_deg.to_radians().tan(),
            _ => 0.0,
        }
    }

    /// A rectangle with no root: built as a plain box, any height.
    pub fn is_plain(&self) -> bool {
        matches!(*self, Self::Rectangular { root_radius, .. } if root_radius <= 0.0)
    }

    /// What the root, flange and chamfer need in height, mm; the section
    /// stands only when taller than this by [`MIN_RISE`]. 0 for a plain
    /// rectangle.
    pub fn least_height(&self) -> f64 {
        if self.is_plain() {
            return 0.0;
        }
        let t = self.draft_tan();
        let root_top = self.root_radius() * (1.0 - t / (1.0 + t * t).sqrt());
        let flange = match *self {
            Self::Tee {
                flange_thickness, ..
            } => flange_thickness + self.chamfer_rise(),
            _ => 0.0,
        };
        root_top + flange
    }

    /// Check the section can stand at `height`, with `ribNet`'s limits.
    pub fn check(&self, height: f64) -> Result<(), SimError> {
        let pos = |v: f64| v.is_finite() && v > 0.0;
        let within = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
        if !pos(height) {
            return Err(SimError::new("A rib's height must be above zero."));
        }
        if !pos(self.width()) {
            return Err(SimError::new("A rib's width must be above zero."));
        }
        if !within(self.root_radius(), 0.0, 50.0) {
            return Err(SimError::new(
                "A rib's root radius must be from 0 to 50 mm.",
            ));
        }
        match *self {
            Self::Rectangular { .. } => {}
            Self::Drafted {
                width, draft_deg, ..
            } => {
                if !within(draft_deg, 0.0, 15.0) {
                    return Err(SimError::new("A rib's draft must be from 0° to 15°."));
                }
                if width - height * self.draft_tan() < 0.1 {
                    return Err(SimError::new(
                        "The draft closes the rib to under 0.1 mm at its top.",
                    ));
                }
            }
            Self::Tee {
                web_width,
                flange_width,
                flange_thickness,
                flange_chamfer_deg,
                ..
            } => {
                // As ribNet: the flange's half-width past the web's by
                // more than 0.05 mm (a NaN width fails too).
                if flange_width.is_nan() || 0.5 * flange_width <= 0.5 * web_width + 0.05 {
                    return Err(SimError::new(
                        "A T-rib's flange must be wider than its web.",
                    ));
                }
                if !pos(flange_thickness) || !within(flange_chamfer_deg, 0.0, 75.0) {
                    return Err(SimError::new(
                        "A T-rib needs a flange thickness above zero and a chamfer from 0° to 75°.",
                    ));
                }
            }
        }
        if !self.is_plain() && height < self.least_height() + MIN_RISE {
            return Err(SimError::new(format!(
                "The rib's root and flange need it to stand more than {:.2} mm tall; it is {height:.2} mm.",
                self.least_height() + MIN_RISE
            )));
        }
        Ok(())
    }

    /// Chords a root arc is cut into at `tolerance` (as `ribNet`).
    fn arc_chords(&self, tolerance: f64) -> usize {
        let r = self.root_radius();
        let sweep = 0.5 * std::f64::consts::PI - self.draft_tan().atan();
        let step = 2.0 * (1.0 - tolerance.min(r) / r).max(-1.0).acos();
        ((sweep / step - 1e-9).ceil() as usize).clamp(ROOT_CHORDS[0], ROOT_CHORDS[1])
    }

    /// The outline at `height` over the wall, counter-clockwise.
    pub fn outline(&self, height: f64) -> Vec<[f64; 2]> {
        self.outline_with(height, None)
    }

    /// The outline with each root arc cut into `chords` chords instead of
    /// `ribNet`'s count: a finer polygon to measure the built one against.
    pub fn outline_with(&self, height: f64, chords: Option<usize>) -> Vec<[f64; 2]> {
        let h = height;
        let a = 0.5 * self.width();
        let t = self.draft_tan();
        let r = self.root_radius();
        // The flank's foot on the wall.
        let k = a + 0.5 * h * t;
        let mut right: Vec<[f64; 2]> = Vec::new();
        if r > 0.0 {
            let cu = k - t * r + r * (1.0 + t * t).sqrt();
            let sweep = 0.5 * std::f64::consts::PI - t.atan();
            let n = chords.unwrap_or_else(|| self.arc_chords(ARC_TOLERANCE));
            right.push([cu, 0.0]);
            for j in 1..=n {
                let ang = 1.5 * std::f64::consts::PI - sweep * j as f64 / n as f64;
                right.push([cu + r * ang.cos(), r + r * ang.sin()]);
            }
        } else {
            right.push([k, 0.0]);
        }
        match *self {
            Self::Tee {
                flange_width,
                flange_thickness,
                ..
            } => {
                let f = 0.5 * flange_width;
                right.push([a, h - flange_thickness - self.chamfer_rise()]);
                right.push([f, h - flange_thickness]);
                right.push([f, h]);
            }
            _ => right.push([a - 0.5 * h * t, h]),
        }
        let mut out = right.clone();
        for p in right.iter().rev() {
            out.push([-p[0], p[1]]);
        }
        out
    }

    /// Beam properties at `height`, from [`RibSection::outline`].
    pub fn properties(&self, height: f64) -> Result<SectionProperties, SimError> {
        self.check(height)?;
        Ok(self.properties_of(&self.outline(height), height))
    }

    /// Properties of this section's `outline` at `height`.
    pub fn properties_of(&self, outline: &[[f64; 2]], height: f64) -> SectionProperties {
        let m = polygon_moments(outline);
        let area = m.area;
        let centroid = m.sv / area;
        let i_across = m.svv - area * centroid * centroid;
        let i_normal = m.suu;
        let (torsion, shear_height) = match *self {
            Self::Tee {
                web_width,
                flange_width,
                flange_thickness,
                ..
            } => {
                let web = rectangle_torsion(web_width, height - flange_thickness);
                let flange = rectangle_torsion(flange_width, flange_thickness);
                (web + flange, web_width * height)
            }
            _ => (rectangle_torsion(area / height, height), KAPPA * area),
        };
        SectionProperties {
            area,
            centroid,
            i_across,
            i_normal,
            torsion,
            shear_height,
            shear_across: KAPPA * area,
        }
    }
}

/// Roark's torsion constant of a solid `w × h` rectangle.
pub fn rectangle_torsion(w: f64, h: f64) -> f64 {
    if w <= 0.0 || h <= 0.0 {
        return 0.0;
    }
    let a = w.max(h);
    let b = w.min(h);
    let r = b / a;
    a * b.powi(3) * (1.0 / 3.0 - 0.21 * r * (1.0 - r.powi(4) / 12.0))
}

/// Area integrals of a simple counter-clockwise polygon: `∫dA`, `∫v dA`,
/// `∫u² dA`, `∫v² dA`.
struct Moments {
    area: f64,
    sv: f64,
    suu: f64,
    svv: f64,
}

fn polygon_moments(p: &[[f64; 2]]) -> Moments {
    let mut m = Moments {
        area: 0.0,
        sv: 0.0,
        suu: 0.0,
        svv: 0.0,
    };
    for i in 0..p.len() {
        let [u0, v0] = p[i];
        let [u1, v1] = p[(i + 1) % p.len()];
        let cross = u0 * v1 - u1 * v0;
        m.area += 0.5 * cross;
        m.sv += cross * (v0 + v1) / 6.0;
        m.suu += cross * (u0 * u0 + u0 * u1 + u1 * u1) / 12.0;
        m.svv += cross * (v0 * v0 + v0 * v1 + v1 * v1) / 12.0;
    }
    m
}

/// The full width of a symmetric outline at height `v`: twice its
/// furthest crossing from `u = 0` (as `ribNet`'s `polygonHalf`).
pub fn width_at(outline: &[[f64; 2]], v: f64) -> f64 {
    let mut best = 0.0_f64;
    for i in 0..outline.len() {
        let p = outline[i];
        let q = outline[(i + 1) % outline.len()];
        if (p[1] - v) * (q[1] - v) > 0.0 {
            continue;
        }
        if (q[1] - p[1]).abs() < 1e-12 {
            best = best.max(p[0].abs()).max(q[0].abs());
        } else {
            best = best.max((p[0] + (q[0] - p[0]) * (v - p[1]) / (q[1] - p[1])).abs());
        }
    }
    2.0 * best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1e-30)
    }

    /// A rectangle's properties are the textbook ones, to round-off.
    #[test]
    fn rectangle_is_exact() {
        let (w, h) = (2.0, 8.0);
        let p = RibSection::rectangular(w).properties(h).unwrap();
        assert!(close(p.area, w * h, 1e-14));
        assert!(close(p.centroid, 0.5 * h, 1e-14));
        assert!(close(p.i_across, w * h.powi(3) / 12.0, 1e-13));
        assert!(close(p.i_normal, h * w.powi(3) / 12.0, 1e-13));
        assert!(close(p.shear_height, KAPPA * w * h, 1e-14));
        assert!(close(p.torsion, rectangle_torsion(w, h), 1e-14));
    }

    /// `ribNet`'s chord counts: 2 to 6 within 0.05 mm.
    #[test]
    fn root_arcs_are_cut_as_ribnet_cuts_them() {
        let s = |r: f64| RibSection::Rectangular {
            width: 1.2,
            root_radius: r,
        };
        // ⌈(π/2) / (2 acos(1 − tol/r))⌉, clamped to 2..6.
        assert_eq!(s(0.1).arc_chords(ARC_TOLERANCE), 2);
        assert_eq!(s(0.6).arc_chords(ARC_TOLERANCE), 2);
        assert_eq!(s(2.0).arc_chords(ARC_TOLERANCE), 4);
        assert_eq!(s(10.0).arc_chords(ARC_TOLERANCE), 6);
    }

    #[test]
    fn outlines_run_counter_clockwise() {
        let sections = [
            RibSection::rectangular(1.5),
            RibSection::Drafted {
                width: 1.2,
                draft_deg: 2.0,
                root_radius: 0.6,
            },
            RibSection::Tee {
                web_width: 1.2,
                flange_width: 3.6,
                flange_thickness: 1.2,
                flange_chamfer_deg: 45.0,
                root_radius: 0.5,
            },
        ];
        for s in sections {
            assert!(polygon_moments(&s.outline(6.0)).area > 0.0, "{s:?}");
            assert!(s.check(6.0).is_ok(), "{s:?}");
        }
    }
}
