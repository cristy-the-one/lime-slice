//! One unit system for the whole crate.
//!
//! Length is millimetres, force is newtons, stress and modulus are MPa
//! (N/mm²). Mass is grams. Density on a card is g/cm³.

/// Standard gravity, millimetres per second squared. 9.81 m/s² in a
/// millimetre model is 9810, not 9.81.
pub const GRAVITY_MM_S2: f64 = 9810.0;

/// The most nodes a solve will allocate. Past this the study is refused.
pub const NODE_CAP: usize = 200_000;

/// The most nodes a sliced grid will allocate. A sliced study sizes its
/// grids by memory (`sliced_study::run`), so this only stops a runaway: the
/// jet study's 217k-node grid peaked at 6.4 GB.
pub const SLICED_NODE_CAP: usize = 1_000_000;

/// Card density times a volume in mm³, in grams.
pub fn mass_g(volume_mm3: f64, density_g_cm3: f64) -> f64 {
    density_g_cm3 * volume_mm3 / 1000.0
}

/// Body force, N/mm³, for a density and a downward gravity magnitude.
///
/// `g` is 9810 when gravity is on. The direction is lab −Z, applied by the
/// caller. One cubic centimetre of water (1 g) then weighs 0.00981 N.
pub fn specific_weight_n_per_mm3(density_g_cm3: f64, g_mm_s2: f64) -> f64 {
    let rho_g_per_mm3 = density_g_cm3 / 1000.0;
    rho_g_per_mm3 * g_mm_s2 / 1.0e6
}

pub fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

pub fn normalize(v: [f64; 3]) -> Option<[f64; 3]> {
    let n = norm(v);
    if n < 1e-15 || !n.is_finite() {
        None
    } else {
        Some([v[0] / n, v[1] / n, v[2] / n])
    }
}

pub fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub fn midpoint(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    scale(add(a, b), 0.5)
}

pub fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(sub(a, b))
}

/// An orthonormal frame whose third row is `axis`. Rows of the returned
/// matrix map global vectors into the material frame (`v_local = Q v_global`).
pub fn material_frame(axis: [f64; 3]) -> Option<[[f64; 3]; 3]> {
    let e3 = normalize(axis)?;
    let helper = if e3[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let e1 = normalize(cross(helper, e3))?;
    let e2 = cross(e3, e1);
    Some([e1, e2, e3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cubic_centimetre_of_water_weighs_9_81_millinewtons() {
        let volume = 1000.0;
        let mass = mass_g(volume, 1.0);
        assert!((mass - 1.0).abs() < 1e-12);
        let weight = specific_weight_n_per_mm3(1.0, GRAVITY_MM_S2) * volume;
        assert!((weight - 0.00981).abs() < 1e-12);
    }
}
