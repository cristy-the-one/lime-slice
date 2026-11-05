use super::*;

/// Spread a closed wall's seam into a scarf joint.
///
/// The loop still starts at the corner-or-nearest seam. When that vertex is a
/// sharp convex corner, the corner hide wins and the path is left alone. On a
/// smooth seam the start ramps from `start_height` up to the layer Z over
/// `length`, the body stays at full height, and the end retraces that same
/// length at full Z while flow ramps back down. The second pass never drops
/// below plastic the start ramp already deposited. The first layer, open paths,
/// bridges, overhang spans, and loops shorter than 8 mm are skipped. Tiny
/// loops that clear 8 mm clamp the scarf to 45% of the perimeter so the two
/// ramps cannot wrap around each other.
pub fn apply_scarf(paths: &mut [Extrusion], params: &ScarfParams) {
    for path in paths.iter_mut() {
        scarf_one(path, params);
    }
}

pub(super) fn scarf_one(path: &mut Extrusion, params: &ScarfParams) {
    if params.layer_index == 0 || params.length < 0.5 || params.steps < 2 {
        return;
    }
    if !scarf_kind(path, params.mode) || path.on_overhang || path.kind == PathKind::Bridge {
        return;
    }
    let h0 = params.start_height.clamp(0.0, 0.9);
    let f0 = params.start_flow.clamp(0.05, 1.0);
    scarf_path(path, params.length, params.steps, h0, f0);
}

pub struct ScarfParams {
    pub mode: ScarfSeam,
    pub length: f64,
    pub steps: u32,
    pub start_height: f64,
    pub start_flow: f64,
    pub layer_index: usize,
}

pub(super) fn scarf_kind(path: &Extrusion, requested: ScarfSeam) -> bool {
    let mode = match requested {
        ScarfSeam::Blend => path_blend_scarf(path.strategy),
        other => other,
    };
    match mode {
        ScarfSeam::Off | ScarfSeam::Blend => false,
        ScarfSeam::Outer => matches!(path.kind, PathKind::Outer | PathKind::Wall),
        ScarfSeam::All => matches!(
            path.kind,
            PathKind::Outer | PathKind::Inner | PathKind::Wall
        ),
    }
}

pub(super) fn path_blend_scarf(strategy: StrategyId) -> ScarfSeam {
    match strategy {
        StrategyId::Toughness => ScarfSeam::Outer,
        StrategyId::Speed => ScarfSeam::Off,
    }
}

pub(super) fn scarf_path(path: &mut Extrusion, length: f64, steps: u32, h0: f64, f0: f64) {
    let pts = &path.points;
    if pts.len() < 4 || dist2(pts[0], *pts.last().unwrap()) > 1e-8 {
        return;
    }
    let ring_len = pts.len() - 1;
    if seam_is_sharp(&pts[..ring_len]) {
        return;
    }
    let perim = polyline_len(pts);
    if perim < 8.0 {
        return;
    }
    let scarf = length.min(perim * 0.45);
    if scarf < 1.0 {
        return;
    }
    let steps = (steps as usize).clamp(2, 64);
    let ramp = ramp_points(pts, scarf, steps);
    let mut out = Vec::new();
    let mut z = Vec::new();
    let mut flow = Vec::new();
    for &(p, along) in &ramp {
        let t = along / scarf;
        out.push(p);
        z.push(h0 + (1.0 - h0) * t);
        flow.push(f0 + (1.0 - f0) * t);
    }
    let mut acc = 0.0;
    for w in pts.windows(2) {
        let seg = (dist2(w[0], w[1])).sqrt();
        let next = acc + seg;
        if acc >= scarf - 1e-4 && next < perim - 1e-4 {
            push_unique(&mut out, &mut z, &mut flow, w[0], 1.0, 1.0);
            push_unique(&mut out, &mut z, &mut flow, w[1], 1.0, 1.0);
        } else if acc < scarf && next > scarf + 1e-4 && next < perim - 1e-4 {
            push_unique(&mut out, &mut z, &mut flow, w[1], 1.0, 1.0);
        }
        acc = next;
    }
    push_unique(&mut out, &mut z, &mut flow, pts[0], 1.0, 1.0);
    for &(p, along) in &ramp[1..] {
        out.push(p);
        z.push(1.0);
        flow.push((1.0 - (1.0 - f0) * along / scarf).clamp(0.05, 1.0));
    }
    path.points = out;
    path.z_frac = z;
    path.flow_frac = flow;
    path.scarf_mm = scarf;
}

/// The loop from its start to `scarf` along it, with each point's distance
/// from the start: every vertex in that stretch, plus `steps` evenly spaced
/// marks so no Z step is larger than a mark apart. Keeping the vertices is
/// what keeps the ramp on a curved wall; the marks alone are chords that cut
/// inside it.
pub(super) fn ramp_points(pts: &[[f64; 2]], scarf: f64, steps: usize) -> Vec<([f64; 2], f64)> {
    let mut out = vec![(pts[0], 0.0)];
    let mut mark = 1;
    let mut acc = 0.0;
    for w in pts.windows(2) {
        let seg = dist2(w[0], w[1]).sqrt();
        if seg < 1e-12 {
            continue;
        }
        let next = acc + seg;
        while mark <= steps {
            let at = scarf * mark as f64 / steps as f64;
            if at > next + 1e-9 {
                break;
            }
            let t = ((at - acc) / seg).clamp(0.0, 1.0);
            out.push((
                [
                    w[0][0] + (w[1][0] - w[0][0]) * t,
                    w[0][1] + (w[1][1] - w[0][1]) * t,
                ],
                at,
            ));
            mark += 1;
        }
        if mark > steps {
            break;
        }
        if out.last().is_none_or(|(_, along)| next - along > 1e-9) {
            out.push((w[1], next));
        }
        acc = next;
    }
    out
}

pub(super) fn seam_is_sharp(ring: &[[f64; 2]]) -> bool {
    ring.len() >= 3 && turn_penalty(ring, 0) < 0.45
}

pub(super) fn push_unique(
    pts: &mut Vec<[f64; 2]>,
    z: &mut Vec<f64>,
    flow: &mut Vec<f64>,
    p: [f64; 2],
    zf: f64,
    ff: f64,
) {
    if let Some(last) = pts.last() {
        if dist2(*last, p) < 1e-10 {
            return;
        }
    }
    pts.push(p);
    z.push(zf);
    flow.push(ff);
}

pub(super) fn point_along(pts: &[[f64; 2]], dist: f64) -> [f64; 2] {
    if pts.len() < 2 || dist <= 0.0 {
        return pts[0];
    }
    let mut left = dist;
    for w in pts.windows(2) {
        let seg = dist2(w[0], w[1]).sqrt();
        if left <= seg || seg < 1e-12 {
            if seg < 1e-12 {
                continue;
            }
            let t = (left / seg).clamp(0.0, 1.0);
            return [
                w[0][0] + (w[1][0] - w[0][0]) * t,
                w[0][1] + (w[1][1] - w[0][1]) * t,
            ];
        }
        left -= seg;
    }
    *pts.last().unwrap()
}

pub(super) fn polyline_len(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| {
            let dx = w[1][0] - w[0][0];
            let dy = w[1][1] - w[0][1];
            dx.hypot(dy)
        })
        .sum()
}
