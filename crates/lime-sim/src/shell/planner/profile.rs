//! Rib cross-sections: the one place that turns a rib into material and
//! into solver stiffness.
//!
//! Everything the planner knows about a rib's section goes through
//! [`RibProfile`]: its area per length ([`RibProfile::area`], used for every
//! volume), the bending proxy the sizing pass ranks height cuts by
//! ([`RibProfile::bending_proxy`]), what two crossing ribs share
//! ([`RibProfile::crossing_overlap`]), and the solver ribs that model a
//! planned rib ([`RibProfile::solver_ribs`]). Each profile is a solver
//! [`RibSection`], whose outline is the one `ribNet` builds; the planner's
//! `width` is `ribNet`'s: a straight rib's width, a drafted rib's width at
//! half its height, a tee's web.
//!
//! **A stretch too low for its profile.** `ribNet` builds a root or a
//! flange only when the rib stands more than
//! [`RibSection::least_height`] + 0.1 mm. A stretch the planner lowers
//! under that (a height-capped zone, the clearance) is planned as a plain
//! straight rib of the same width, and is to be built so.
//!
//! [`choose_profile`] is the automatic choice by process and print pose.

use crate::shell::rib_section::width_at;
use crate::shell::{Rib, RibSection, RibSide, SectionProperties};

/// A rib's cross-section shape. Its width is the planner's rib width.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum RibProfile {
    /// A straight rectangle.
    #[default]
    Rectangular,
    /// Flanks leaning `draft_deg` from the wall's normal (wider at the
    /// wall), the width at half the height, and concave root arcs of
    /// `root_radius` into the wall.
    Drafted { draft_deg: f64, root_radius: f64 },
    /// A web the rib's width wide under a flange, its underside chamfered
    /// `flange_chamfer_deg` from the wall's plane (0: square), the web
    /// meeting the wall through root arcs of `root_radius`.
    Tee {
        flange_width: f64,
        flange_thickness: f64,
        flange_chamfer_deg: f64,
        root_radius: f64,
    },
}

/// What a part is made by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Process {
    #[default]
    Filament,
    Resin,
    Moulded,
}

/// The flange a tee may have in the current print pose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlangeShape {
    /// Underside chamfered at [`TEE_CHAMFER_DEG`]: prints without support
    /// standing up on a flat bed.
    Chamfered,
    /// Square underside: on a 45° belt with the rib across the belt, the
    /// chamfer is the overhang and the square flange is not.
    Square,
}

/// What [`choose_profile`] decides from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProfileRules {
    pub process: Process,
    /// The flange that prints in the current pose, or `None` when no
    /// flange does. The caller decides it from the printer and the ribs'
    /// direction.
    pub flange: Option<FlangeShape>,
    /// Rib width (straight, drafted at half height, a tee's web), mm.
    pub width: f64,
    /// Greatest rib height, mm.
    pub max_height: f64,
    /// Take this profile, whatever the rest says.
    pub force: Option<RibProfile>,
}

/// A tee's flange is this many webs wide and one web thick (as `ribNet`).
pub const TEE_FLANGE_WIDTHS: f64 = 3.0;
/// A chamfered flange's underside, degrees from the wall's plane (as
/// `ribNet`).
pub const TEE_CHAMFER_DEG: f64 = 45.0;
/// A drafted rib's draft, degrees per side (as `ribNet`).
pub const DRAFT_DEG: f64 = 1.0;

impl RibProfile {
    /// `ribNet`'s default tee for a web `width` wide: a flange three webs
    /// wide and one thick, the root half the web.
    pub fn default_tee(width: f64, flange: FlangeShape) -> Self {
        Self::Tee {
            flange_width: TEE_FLANGE_WIDTHS * width,
            flange_thickness: width,
            flange_chamfer_deg: match flange {
                FlangeShape::Chamfered => TEE_CHAMFER_DEG,
                FlangeShape::Square => 0.0,
            },
            root_radius: 0.5 * width,
        }
    }

    /// `ribNet`'s default drafted rib `width` wide and `height` tall:
    /// [`DRAFT_DEG`] a side, the root half its top width.
    pub fn default_drafted(width: f64, height: f64) -> Self {
        let top = width - height * DRAFT_DEG.to_radians().tan();
        Self::Drafted {
            draft_deg: DRAFT_DEG,
            root_radius: 0.5 * top.max(0.0),
        }
    }

    /// The full section, before any height is fitted.
    pub fn section(self, width: f64) -> RibSection {
        match self {
            Self::Rectangular => RibSection::rectangular(width),
            Self::Drafted {
                draft_deg,
                root_radius,
            } => RibSection::Drafted {
                width,
                draft_deg,
                root_radius,
            },
            Self::Tee {
                flange_width,
                flange_thickness,
                flange_chamfer_deg,
                root_radius,
            } => RibSection::Tee {
                web_width: width,
                flange_width,
                flange_thickness,
                flange_chamfer_deg,
                root_radius,
            },
        }
    }

    /// The section a stretch `height` tall carries: the full one, or a
    /// plain straight rib when the stretch is too low for its root and
    /// flange (see the module notes).
    pub fn section_at(self, width: f64, height: f64) -> RibSection {
        let full = self.section(width);
        if full.check(height).is_ok() {
            full
        } else {
            RibSection::rectangular(width)
        }
    }

    /// Whether the profile stands `height` tall at `width`, in full.
    pub fn check(self, width: f64, height: f64) -> Result<(), crate::error::SimError> {
        self.section(width).check(height)
    }

    /// Section area, mm²: rib volume per mm of length.
    pub fn area(self, width: f64, height: f64) -> f64 {
        match self {
            // Kept in closed form, so the planner's straight volumes do not
            // move by a rounding.
            Self::Rectangular => width * height,
            _ => self.properties(width, height).area,
        }
    }

    /// Second moment of the section about the wall's mid-plane (the rib
    /// alone, its foot `wall/2` off it), mm⁴: what a height cut costs in
    /// stiffness, to first order.
    pub fn bending_proxy(self, width: f64, height: f64, wall: f64) -> f64 {
        match self {
            Self::Rectangular => {
                width * height.powi(3) / 12.0 + width * height * (0.5 * wall + 0.5 * height).powi(2)
            }
            _ => {
                let p = self.properties(width, height);
                p.i_across + p.area * (0.5 * wall + p.centroid).powi(2)
            }
        }
    }

    fn properties(self, width: f64, height: f64) -> SectionProperties {
        let none = SectionProperties {
            area: 0.0,
            centroid: 0.0,
            i_across: 0.0,
            i_normal: 0.0,
            torsion: 0.0,
            shear_height: 0.0,
            shear_across: 0.0,
        };
        // A zero height has no section.
        self.section_at(width, height)
            .properties(height)
            .unwrap_or(none)
    }

    /// What two ribs crossing at `sin` (of the angle between them) share,
    /// mm³, up to `height`: `∫ w_a(v) w_b(v) dv / sin`, the two widths at
    /// each height over the wall, by the midpoint rule on 64 slices (exact
    /// for two straight ribs).
    pub fn crossing_overlap(
        self,
        width: f64,
        other: RibProfile,
        other_width: f64,
        height: f64,
        sin: f64,
    ) -> f64 {
        if self == Self::Rectangular && other == Self::Rectangular {
            return width * other_width * height / sin;
        }
        if height <= 0.0 {
            return 0.0;
        }
        let a = self.section_at(width, height).outline(height);
        let b = other.section_at(other_width, height).outline(height);
        let n = 64;
        let dv = height / n as f64;
        let mut v = 0.0;
        for k in 0..n {
            let at = (k as f64 + 0.5) * dv;
            v += width_at(&a, at) * width_at(&b, at) * dv;
        }
        v / sin
    }

    /// The planner's profile and width of a solver section. A straight
    /// section with a root has no planner profile: it reads as plain.
    pub fn of_section(section: RibSection) -> (Self, f64) {
        match section {
            RibSection::Rectangular { width, .. } => (Self::Rectangular, width),
            RibSection::Drafted {
                width,
                draft_deg,
                root_radius,
            } => (
                Self::Drafted {
                    draft_deg,
                    root_radius,
                },
                width,
            ),
            RibSection::Tee {
                web_width,
                flange_width,
                flange_thickness,
                flange_chamfer_deg,
                root_radius,
            } => (
                Self::Tee {
                    flange_width,
                    flange_thickness,
                    flange_chamfer_deg,
                    root_radius,
                },
                web_width,
            ),
        }
    }

    /// The solver ribs that model a rib along `chain` whose edge `e` has
    /// height `heights[e]`: one per run of edges of one height (a stretch
    /// under a height cap is its own beam run, sharing the vertex with its
    /// neighbours), each with the section that height carries.
    pub fn solver_ribs(
        self,
        chain: &[u32],
        heights: &[f64],
        width: f64,
        side: RibSide,
    ) -> Vec<Rib> {
        debug_assert_eq!(heights.len() + 1, chain.len());
        let mut out: Vec<Rib> = Vec::new();
        for (e, w) in chain.windows(2).enumerate() {
            let h = heights[e];
            match out.last_mut() {
                Some(r) if (r.height - h).abs() < 1e-12 => r.edges.push((w[0], w[1])),
                _ => out.push(Rib {
                    edges: vec![(w[0], w[1])],
                    section: self.section_at(width, h),
                    height: h,
                    side,
                }),
            }
        }
        out
    }
}

/// The profile for a process and a print pose.
///
/// - A forced profile wins.
/// - Filament or resin: a tee ([`RibProfile::default_tee`], with the
///   caller's flange shape) when a flange prints in this pose and the rib
///   may stand tall enough to carry one: its root, chamfer and flange
///   plus a web one width tall; a straight rib otherwise.
/// - Moulded: drafted ([`RibProfile::default_drafted`]).
pub fn choose_profile(rules: &ProfileRules) -> RibProfile {
    if let Some(p) = rules.force {
        return p;
    }
    match rules.process {
        Process::Moulded => RibProfile::default_drafted(rules.width, rules.max_height),
        Process::Filament | Process::Resin => match rules.flange {
            Some(shape) => {
                let tee = RibProfile::default_tee(rules.width, shape);
                let needs = tee.section(rules.width).least_height() + rules.width;
                if rules.max_height >= needs {
                    tee
                } else {
                    RibProfile::Rectangular
                }
            }
            None => RibProfile::Rectangular,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_choice_follows_process_pose_and_height() {
        let base = ProfileRules {
            process: Process::Filament,
            flange: None,
            width: 1.2,
            max_height: 6.0,
            force: None,
        };
        assert_eq!(choose_profile(&base), RibProfile::Rectangular);
        let bed = ProfileRules {
            flange: Some(FlangeShape::Chamfered),
            ..base
        };
        assert_eq!(
            choose_profile(&bed),
            RibProfile::default_tee(1.2, FlangeShape::Chamfered)
        );
        let belt = ProfileRules {
            flange: Some(FlangeShape::Square),
            ..base
        };
        let RibProfile::Tee {
            flange_chamfer_deg, ..
        } = choose_profile(&belt)
        else {
            panic!("a tee");
        };
        assert_eq!(flange_chamfer_deg, 0.0);
        // Chamfered default at 1.2: root 0.6 + chamfer 1.2 + flange 1.2,
        // then a web of 1.2: 4.2 mm.
        let short = ProfileRules {
            max_height: 4.1,
            ..bed
        };
        assert_eq!(choose_profile(&short), RibProfile::Rectangular);
        let mould = ProfileRules {
            process: Process::Moulded,
            ..base
        };
        assert_eq!(
            choose_profile(&mould),
            RibProfile::default_drafted(1.2, 6.0)
        );
        let forced = ProfileRules {
            force: Some(RibProfile::Rectangular),
            ..bed
        };
        assert_eq!(choose_profile(&forced), RibProfile::Rectangular);
    }

    #[test]
    fn a_stretch_too_low_for_a_tee_is_planned_straight() {
        let tee = RibProfile::default_tee(1.2, FlangeShape::Chamfered);
        assert_eq!(tee.section_at(1.2, 2.0), RibSection::rectangular(1.2));
        assert!((tee.area(1.2, 2.0) - 2.4).abs() < 1e-12);
    }

    #[test]
    fn crossing_overlap_matches_the_closed_form() {
        let r =
            RibProfile::Rectangular.crossing_overlap(1.0, RibProfile::Rectangular, 2.0, 3.0, 0.5);
        assert!((r - 12.0).abs() < 1e-12);
        // A square-flange tee, no root, crossing a straight rib square on:
        // under the flange the tee is its web, then the flange.
        let tee = RibProfile::Tee {
            flange_width: 3.0,
            flange_thickness: 1.0,
            flange_chamfer_deg: 0.0,
            root_radius: 0.0,
        };
        let v = tee.crossing_overlap(1.0, RibProfile::Rectangular, 1.0, 4.0, 1.0);
        let want = 1.0 * 3.0 + 3.0 * 1.0;
        assert!((v - want).abs() < 1e-9, "{v} {want}");
    }
}
