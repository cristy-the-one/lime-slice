//! A thin-shell solver with beam ribs, for planning reinforcement ribs on a
//! wall (docs/plan-auto-ribs.md §7.2). It stands beside the tetrahedral
//! study path and shares only its sparse LDLᵀ.
//!
//! The model is the one of Li et al. 2017 ("Rib-reinforced shell
//! structure", CGF 36(7)): every triangle of the wall's mid-surface is a
//! flat facet with a membrane triangle and a plate-bending triangle, and a
//! rib is a chain of beam elements on mesh edges whose stiffness adds to
//! the shell's.
//!
//! - **Nodes** carry six dofs in global axes: `[ux, uy, uz, θx, θy, θz]`.
//! - **Membrane**: Allman's triangle with vertex (drilling) rotations, or
//!   the constant-strain triangle to compare ([`membrane`]).
//! - **Bending**: the Discrete Kirchhoff Triangle ([`plate`]).
//! - **Ribs**: Timoshenko beams with a rectangular section, standing off
//!   the mid-surface on rigid links, with the web's own section rotation
//!   as one extra dof per rib vertex so the web can shear against the
//!   Kirchhoff wall ([`beam`]).
//! - **Material**: [`ShellSection`], with [`IsotropicShell`] for now; a
//!   layer-orthotropic card implements the same trait.
//! - **Solve**: faer's supernodal LDLᵀ under AMD, the symbolic analysis
//!   done once per model; a rib change re-runs only the numeric factor
//!   ([`ShellModel`]).
//!
//! Units: mm, N, MPa. Linear statics only.

mod beam;
mod geometry;
mod membrane;
mod model;
pub mod planner;
mod plate;
pub mod rib_section;
mod section;
mod sparse;
mod tensor;

pub use geometry::Frame;
pub use membrane::MembraneKind;
pub use model::{
    ElementResult, LoadCase, Rib, RibSide, ShellHold, ShellLoad, ShellMesh, ShellModel,
    ShellOptions, ShellResult, Timings, DRILL_PENALTY,
};
pub use rib_section::{RibSection, SectionProperties};
pub use section::{IsotropicShell, Mat3, ShellSection};
pub use tensor::Principal;

#[cfg(test)]
mod folded_probe;

// The folded-shell probe reads the planner's private mesh. These names exist
// only while tests build; the library's public surface is unchanged.
#[cfg(test)]
pub(crate) use planner::field::{Field, ALPHA as FIELD_ALPHA};
#[cfg(test)]
pub(crate) use planner::surface::Surface;
#[cfg(test)]
pub(crate) use planner::trace::{TraceRules, Tracer};
