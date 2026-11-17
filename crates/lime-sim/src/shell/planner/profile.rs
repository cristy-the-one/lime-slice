//! Rib cross-sections: the one place that turns a rib into material and
//! into solver stiffness.
//!
//! **The seam for more profiles.** Everything the planner knows about a
//! rib's section goes through [`RibProfile`]: its area per length
//! ([`RibProfile::area`], used for every volume), the bending proxy the
//! sizing pass ranks height cuts by ([`RibProfile::bending_proxy`]), and
//! the solver ribs that model a planned rib ([`RibProfile::solver_ribs`]).
//! A drafted or T profile is a new variant here plus its section in the
//! solver's beam element (`shell::beam::BeamSection`); the planner's
//! logic does not change.

use crate::shell::{Rib, RibSide};

/// A rib's cross-section shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RibProfile {
    /// A straight rectangle, width × height. The only one built.
    #[default]
    Rectangular,
}

impl RibProfile {
    /// Section area, mm²: rib volume per mm of length.
    pub fn area(self, width: f64, height: f64) -> f64 {
        match self {
            Self::Rectangular => width * height,
        }
    }

    /// Second moment of the section about the wall's mid-plane (the rib
    /// alone, standing `t/2` off it), mm⁴: what a height cut costs in
    /// stiffness, to first order.
    pub fn bending_proxy(self, width: f64, height: f64, wall: f64) -> f64 {
        match self {
            Self::Rectangular => {
                width * height.powi(3) / 12.0 + width * height * (0.5 * wall + 0.5 * height).powi(2)
            }
        }
    }

    /// The solver ribs that model a rib along `chain` whose edge `e` has
    /// height `heights[e]`: one per run of edges of one height (a stretch
    /// under a height cap is its own beam run, sharing the vertex with its
    /// neighbours).
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
                _ => out.push(match self {
                    Self::Rectangular => Rib {
                        edges: vec![(w[0], w[1])],
                        width,
                        height: h,
                        side,
                    },
                }),
            }
        }
        out
    }
}
