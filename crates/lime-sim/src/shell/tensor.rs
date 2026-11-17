//! Principal values and directions of a symmetric in-plane tensor.

use super::geometry::Frame;

/// A symmetric 2×2 tensor in an element's tangent plane, with its
/// principal decomposition.
///
/// "Major" is the principal value of larger magnitude, "minor" the other;
/// their directions are unit vectors in the tangent plane, in global
/// coordinates, square to each other. A direction is a line, not an arrow:
/// `d` and `−d` are the same answer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Principal {
    /// `[xx, yy, xy]` along the element frame's `e1`, `e2`.
    pub local: [f64; 3],
    pub major: f64,
    pub minor: f64,
    pub major_dir: [f64; 3],
    pub minor_dir: [f64; 3],
    /// `1 − |major − minor| / (|major| + |minor|)`, from 0 to 1. Near 1 the
    /// two principal values are close and the directions mean little (an
    /// umbilic point, or nothing there at all: a zero tensor reads 1). Near
    /// 0 one direction clearly dominates, or the tensor is a pure shear
    /// (major = −minor) whose directions are well defined at ±45°.
    pub isotropy: f64,
}

impl Principal {
    pub(crate) fn of(local: [f64; 3], frame: &Frame) -> Self {
        let [xx, yy, xy] = local;
        let mean = 0.5 * (xx + yy);
        let half = 0.5 * (xx - yy);
        let r = (half * half + xy * xy).sqrt();
        let (l1, l2) = (mean + r, mean - r);
        // Direction of l1: angle ½ atan2(2xy, xx − yy) from e1.
        let angle = 0.5 * xy.atan2(half);
        let (c, s) = (angle.cos(), angle.sin());
        let d1 = frame.to_global([c, s, 0.0]);
        let d2 = frame.to_global([-s, c, 0.0]);
        let (major, minor, major_dir, minor_dir) = if l1.abs() >= l2.abs() {
            (l1, l2, d1, d2)
        } else {
            (l2, l1, d2, d1)
        };
        let sum = l1.abs() + l2.abs();
        let isotropy = if sum > 0.0 {
            1.0 - (l1 - l2).abs() / sum
        } else {
            1.0
        };
        Self {
            local,
            major,
            minor,
            major_dir,
            minor_dir,
            isotropy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Frame {
        Frame {
            e1: [1.0, 0.0, 0.0],
            e2: [0.0, 1.0, 0.0],
            normal: [0.0, 0.0, 1.0],
        }
    }

    #[test]
    fn decomposes_and_orders_by_magnitude() {
        // Principal values 5 and −8 at 30° and 120°.
        let t = 30f64.to_radians();
        let (a, b) = (5.0, -8.0);
        let (c, s) = (t.cos(), t.sin());
        let local = [
            a * c * c + b * s * s,
            a * s * s + b * c * c,
            (a - b) * s * c,
        ];
        let p = Principal::of(local, &frame());
        assert!((p.major + 8.0).abs() < 1e-12 && (p.minor - 5.0).abs() < 1e-12);
        // Major along 120°.
        let want = [(-s), c, 0.0];
        let dotp: f64 = (0..3).map(|i| p.major_dir[i] * want[i]).sum();
        assert!((dotp.abs() - 1.0).abs() < 1e-12);
        let cross: f64 = (0..3).map(|i| p.major_dir[i] * p.minor_dir[i]).sum();
        assert!(cross.abs() < 1e-12);
        assert!((p.isotropy - (1.0 - 13.0 / 13.0)).abs() < 1e-12);
    }

    #[test]
    fn equal_values_read_isotropic() {
        let p = Principal::of([3.0, 3.0, 0.0], &frame());
        assert!((p.isotropy - 1.0).abs() < 1e-12);
        let q = Principal::of([3.0, 1.0, 0.0], &frame());
        assert!((q.isotropy - 0.5).abs() < 1e-12);
    }
}
