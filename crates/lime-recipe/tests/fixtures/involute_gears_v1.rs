//! ---
//! ingredient: involute-gears
//! title: involute gears
//! version: 1
//! description: Involute spur gear and rack outlines for extrude profiles, idler centre between two gears, and the mating tooth phase so a train meshes in any pose. Pure maths, no calls.
//! author: unknown
//! made-by: local-agent-mode-lime-slice
//! api: 1.4
//! lust: 7931db30
//! source-sha256: 03719946912c5a575363fc4500d078648a13171b002545114f60d87925f05924
//! created: 2026-11-06
//! ---
// Involute spur gears and racks for extrude profiles, plus the two things that make a
// gear train fit: where an idler goes between two gears, and the tooth phase a mating
// gear needs so its teeth sit in the other's gaps. Pure maths, no session calls.
//
// Angles: profiles are in the sketch plane's own (u, v); phase and direction are degrees
// in that same plane. For a gear turned onto +X with turn [0, 90, 0], a direction `d`
// measured on the face in (y, z) is `d + 90` in the gear's own plane.
// Check a train with model_check {interference:true, exact:true} in every pose.

pub type P2 = [f64; 2];

pub fn involute(a: f64) -> f64 { a.tan() - a }

/// Pitch radius of a z-tooth gear of module m.
pub fn pitch_radius(z: u32, m: f64) -> f64 { m * z as f64 / 2.0 }

/// One tooth centred on angle `c` (radians), counter-clockwise, root to root.
/// 20 degree pressure angle, addendum m, dedendum 1.25 m; `backlash` mm at the pitch
/// circle; `flank` points per flank (3 keeps a 24-tooth gear under 200 points).
pub fn gear_tooth(z: u32, m: f64, backlash: f64, flank: usize, c: f64, pts: &mut Vec<P2>) {
    let zf = z as f64;
    let r = m * zf / 2.0;
    let rb = r * 20f64.to_radians().cos();
    let (ra, rf) = (r + m, r - 1.25 * m);
    let r0 = rf.max(rb);
    let psi = std::f64::consts::PI / (2.0 * zf) - backlash / (2.0 * r);
    let ap = (rb / r).acos();
    let half = |rho: f64| psi + involute(ap) - involute((rb / rho.max(rb)).acos());
    let gap = std::f64::consts::PI / zf - half(r0);
    let n = flank.max(2);
    let h0 = half(r0) + 0.25 * gap;
    pts.push([rf * (c - h0).cos(), rf * (c - h0).sin()]);
    for i in 0..n {
        let rho = r0 + (ra - r0) * i as f64 / (n - 1) as f64;
        let a = c - half(rho);
        pts.push([rho * a.cos(), rho * a.sin()]);
    }
    for i in 0..n {
        let rho = ra - (ra - r0) * i as f64 / (n - 1) as f64;
        let a = c + half(rho);
        pts.push([rho * a.cos(), rho * a.sin()]);
    }
    pts.push([rf * (c + h0).cos(), rf * (c + h0).sin()]);
}

/// A whole gear outline with tooth 0 centred on `phase_deg`: (2 + 2 * flank) points a tooth.
pub fn gear_outline_with(z: u32, m: f64, backlash: f64, flank: usize, phase_deg: f64) -> Vec<P2> {
    let mut pts = Vec::new();
    let pitch = 2.0 * std::f64::consts::PI / z as f64;
    for t in 0..z { gear_tooth(z, m, backlash, flank, phase_deg.to_radians() + pitch * t as f64, &mut pts); }
    pts
}

/// gear_outline_with at 0.1 mm backlash and 3 flank points.
pub fn gear_outline(z: u32, m: f64, phase_deg: f64) -> Vec<P2> { gear_outline_with(z, m, 0.1, 3, phase_deg) }

/// Phase (degrees) for a mating gear of `mate_z` teeth whose centre lies in direction
/// `dir_deg` from a gear of `own_z` teeth with tooth 0 at `own_phase_deg`, so each tooth
/// meets a gap. Chain it along a train: drive -> idler -> output.
pub fn mate_phase(own_phase_deg: f64, own_z: u32, dir_deg: f64, mate_z: u32) -> f64 {
    let own_pitch = 360.0 / own_z as f64;
    let f = (((dir_deg - own_phase_deg) / own_pitch) % 1.0 + 1.0) % 1.0;
    dir_deg + 180.0 - (0.5 - f) * 360.0 / mate_z as f64
}

/// Turn of a mating gear when its driver turns `own_turn_deg`: opposite way, by the ratio.
pub fn mate_turn(own_turn_deg: f64, own_z: u32, mate_z: u32) -> f64 { -own_turn_deg * own_z as f64 / mate_z as f64 }

/// Direction in degrees from a to b.
pub fn dir_deg(a: P2, b: P2) -> f64 { (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees() }

/// Centre of an idler that sits `d1` from `a` and `d2` from `c` (centre distances, i.e.
/// sums of pitch radii). `left` picks the side to the left of a -> c. None if out of reach.
pub fn idler_centre(a: P2, c: P2, d1: f64, d2: f64, left: bool) -> Option<P2> {
    let (dx, dy) = (c[0] - a[0], c[1] - a[1]);
    let d = dx.hypot(dy);
    if d > d1 + d2 || d < (d1 - d2).abs() || d == 0.0 { return None; }
    let k = (d1 * d1 - d2 * d2 + d * d) / (2.0 * d);
    let h = (d1 * d1 - k * k).max(0.0).sqrt();
    let (px, py) = (a[0] + k * dx / d, a[1] + k * dy / d);
    let s = if left { 1.0 } else { -1.0 };
    Some([px - s * h * dy / d, py + s * h * dx / d])
}

/// Rack outline in (u along the rack, v up), pitch line at v = 0, teeth pointing to -v.
/// Teeth centred on `centres` (mm along u, one pitch = PI * m apart); the outline is closed
/// at v = `back` so it overlaps the bar it is fused to. Cut the root strip first:
/// box from the first tooth's root to the last one's, v from below the tips to 1.25 m.
pub fn rack_outline(m: f64, centres: &Vec<f64>, back: f64) -> Vec<P2> {
    let t20 = 20f64.to_radians().tan();
    let p4 = std::f64::consts::PI * m / 4.0;
    let (add, ded) = (0.9 * m, 1.25 * m);
    let (w_tip, w_root) = (p4 - add * t20, p4 + ded * t20);
    let n = centres.len();
    let mut pts: Vec<P2> = vec![[centres[0] - w_root, back]];
    for c in centres.iter() {
        pts.push([c - w_root, ded]);
        pts.push([c - w_tip, -add]);
        pts.push([c + w_tip, -add]);
        pts.push([c + w_root, ded]);
    }
    pts.push([centres[n - 1] + w_root, back]);
    pts
}
