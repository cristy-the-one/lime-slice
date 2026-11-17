//! What a wall and a rib are made of. The elements only ask a section for
//! its membrane matrix `A` (N = A ε) and bending matrix `D` (M = D κ) at a
//! thickness, in the element's frame, and for a rib's moduli along its
//! axis. That is the seam a layer-orthotropic card plugs into later: it
//! rotates its layer axes into the frame it is handed. A symmetric section
//! is assumed (no membrane–bending coupling matrix `B`).

use super::geometry::Frame;
use crate::error::SimError;

pub type Mat3 = [[f64; 3]; 3];

pub trait ShellSection: Send + Sync {
    /// Membrane stiffness, N/mm: `[Nxx, Nyy, Nxy] = A [εxx, εyy, γxy]` in
    /// the element frame.
    fn membrane(&self, thickness: f64, frame: &Frame) -> Mat3;
    /// Bending stiffness, N·mm: `[Mxx, Myy, Mxy] = D [κxx, κyy, 2κxy]` in
    /// the element frame.
    fn bending(&self, thickness: f64, frame: &Frame) -> Mat3;
    /// Young's and shear moduli, MPa, of a rib running along `axis`.
    fn rib_moduli(&self, axis: [f64; 3]) -> (f64, f64);
}

/// One isotropic linear-elastic material for wall and ribs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IsotropicShell {
    /// Young's modulus, MPa.
    pub e: f64,
    /// Poisson's ratio.
    pub nu: f64,
}

impl IsotropicShell {
    pub fn new(e: f64, nu: f64) -> Result<Self, SimError> {
        if !(e.is_finite() && e > 0.0) {
            return Err(SimError::new("Young's modulus must be above zero."));
        }
        if !(nu.is_finite() && nu > -1.0 && nu < 0.5) {
            return Err(SimError::new(
                "Poisson's ratio must be above -1 and below 0.5.",
            ));
        }
        Ok(Self { e, nu })
    }

    pub fn shear_modulus(&self) -> f64 {
        self.e / (2.0 * (1.0 + self.nu))
    }

    fn plane_stress(&self, scale: f64) -> Mat3 {
        let c = scale / (1.0 - self.nu * self.nu);
        [
            [c, c * self.nu, 0.0],
            [c * self.nu, c, 0.0],
            [0.0, 0.0, c * 0.5 * (1.0 - self.nu)],
        ]
    }
}

impl ShellSection for IsotropicShell {
    fn membrane(&self, thickness: f64, _frame: &Frame) -> Mat3 {
        self.plane_stress(self.e * thickness)
    }

    fn bending(&self, thickness: f64, _frame: &Frame) -> Mat3 {
        self.plane_stress(self.e * thickness.powi(3) / 12.0)
    }

    fn rib_moduli(&self, _axis: [f64; 3]) -> (f64, f64) {
        (self.e, self.shear_modulus())
    }
}
