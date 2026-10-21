//! Layer normal for a belt printer.
//!
//! Copied from `Frame::lab` and `mirror_rotate_x` in `lime-slice-core`'s
//! `belt.rs`. Sharing that crate would put the G-code planner on the solve
//! path, so the six lines live here. `mirror_rotate_x` takes a design point
//! into the slice frame, where +Z stacks the layers. `Frame::lab` maps a
//! slice point back to the lab. A unit slice-Z is a direction, so the frame
//! shifts (they are translations) stay zero.

/// Unit layer normal in the lab, for a belt of `angle_deg`.
///
/// `axis` and `direction` are the firmware belt axis. They move the part
/// along the belt. They do not rotate the layers. Copies and the gap do the
/// same, and are not arguments: the study is of one object.
pub fn belt_layer_normal(angle_deg: f64, axis: &str, direction: i32) -> [f64; 3] {
    let _ = (axis, direction);
    let (sin_a, cos_a) = angle_deg.to_radians().sin_cos();
    let y_shift = 0.0;
    let z_drop = 0.0;
    let y = 0.0;
    let z = 1.0;
    let y_rot = y + y_shift;
    let z_rot = z + z_drop;
    let y_lab = -(y_rot * cos_a + z_rot * sin_a);
    let z_lab = -y_rot * sin_a + z_rot * cos_a;
    [0.0, y_lab, z_lab]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ir3_v2_layer_normal() {
        // angleDeg 45, firmware axis Z, direction +1. Not the belt travel.
        let v = belt_layer_normal(45.0, "z", 1);
        // The plan locks these digits. `FRAC_1_SQRT_2` is the same value.
        #[allow(clippy::approx_constant)]
        let expect = [0.0, -0.7071067811865476, 0.7071067811865476];
        for i in 0..3 {
            assert!(
                (v[i] - expect[i]).abs() < 1e-12,
                "component {i}: {} vs {}",
                v[i],
                expect[i]
            );
        }
        let again = belt_layer_normal(45.0, "z", 1);
        let ignored = belt_layer_normal(45.0, "x", -1);
        for i in 0..3 {
            assert!((again[i] - ignored[i]).abs() < 1e-15);
        }
    }
}
