use super::outline::Outline;
use super::scarf::polyline_len;
use super::seams::dist2;
use super::void_fill::edge_box_meets;
use crate::poly::{loop_bounds, offset_loops, signed_area, Loop};

/// Inset the region by half a line, then by one line each ring, and extrude
/// each closed centerline.
pub(super) fn concentric_fill(loops: &[Loop], spacing: f64) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let mut paths = Vec::new();
    if spacing < 1e-4 || loops.is_empty() {
        sample.solid();
        return paths;
    }
    let mut inset = spacing * 0.5;
    let mut prev_area = f64::MAX;
    for _ in 0..2048 {
        let rings = offset_loops(loops, -inset);
        if rings.is_empty() {
            break;
        }
        let area: f64 = rings.iter().map(|ring| signed_area(ring).abs()).sum();
        if area < 1e-3 || area >= prev_area - 1e-4 {
            break;
        }
        prev_area = area;
        for ring in rings {
            if ring.len() < 3 {
                continue;
            }
            let mut path = ring;
            if dist2(path[0], *path.last().unwrap()) > 1e-8 {
                path.push(path[0]);
            }
            if polyline_len(&path) >= spacing {
                paths.push(path);
            }
        }
        inset += spacing;
    }
    sample.solid();
    paths
}

pub(super) fn scan_angle(loops: &[Loop], spacing: f64, angle: f64) -> Vec<Vec<[f64; 2]>> {
    scan_through(loops, spacing, angle, None)
}

/// Chords at `angle`, one row passing through `through` when it is given,
/// else half a spacing in from the region's edge.
pub(super) fn scan_through(
    loops: &[Loop],
    spacing: f64,
    angle: f64,
    through: Option<[f64; 2]>,
) -> Vec<Vec<[f64; 2]>> {
    let rotated = rotate_loops(loops, -angle);
    let chords = horizontal_chords(&rotated, spacing, through.map(|p| rot(p, -angle)[1]));
    let mut out = Vec::new();
    for (y, spans) in chords {
        for (x0, x1) in spans {
            let a = rot([x0, y], angle);
            let b = rot([x1, y], angle);
            out.push(vec![a, b]);
        }
    }
    out
}

pub(super) fn horizontal_chords(
    loops: &[Loop],
    spacing: f64,
    through: Option<f64>,
) -> Vec<(f64, Vec<(f64, f64)>)> {
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    let mut y = match through {
        Some(t) => t - ((t - min[1]) / spacing).floor() * spacing,
        None => min[1] + spacing * 0.5,
    };
    while y < max[1] - 0.05 {
        let mut xs = Vec::new();
        for loop_ in loops {
            let n = loop_.len();
            for i in 0..n {
                let a = loop_[i];
                let b = loop_[(i + 1) % n];
                if (a[1] < y && b[1] >= y) || (b[1] < y && a[1] >= y) {
                    let dy = b[1] - a[1];
                    if dy.abs() < 1e-12 {
                        continue;
                    }
                    let t = (y - a[1]) / dy;
                    xs.push(a[0] + (b[0] - a[0]) * t);
                }
            }
        }
        xs.sort_by(|a, b| a.total_cmp(b));
        xs.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
        let mut spans = Vec::new();
        let mut i = 0;
        while i + 1 < xs.len() {
            if xs[i + 1] - xs[i] > 0.2 {
                spans.push((xs[i], xs[i + 1]));
            }
            i += 2;
        }
        if !spans.is_empty() {
            rows.push((y, spans));
        }
        y += spacing;
    }
    rows
}

pub(super) fn gyroid(loops: &[Loop], spacing: f64, phase_bias: f64) -> Vec<Vec<[f64; 2]>> {
    let outline = Outline::new(loops);
    let Some((min, max)) = loop_bounds(loops) else {
        return Vec::new();
    };
    let amp = spacing * 0.38;
    let freq = std::f64::consts::TAU / (spacing * 3.2);
    let step = 0.7_f64;
    let mut polylines = Vec::new();
    let mut y = min[1] + spacing * 0.5;
    let mut row = 0i32;
    while y < max[1] {
        let mut pts = Vec::new();
        let mut x = min[0] - 0.5;
        while x <= max[0] + 0.5 {
            let wave = amp * ((x * freq) + phase_bias + row as f64 * 0.35).sin();
            pts.push([x, y + wave]);
            x += step;
        }
        polylines.extend(clip_polyline(&outline, &pts));
        y += spacing;
        row += 1;
    }
    let mut x = min[0] + spacing * 0.5;
    let mut col = 0i32;
    while x < max[0] {
        let mut pts = Vec::new();
        let mut y = min[1] - 0.5;
        while y <= max[1] + 0.5 {
            let wave = amp * ((y * freq) + phase_bias * 1.7 + col as f64 * 0.35).sin();
            pts.push([x + wave, y]);
            y += step;
        }
        polylines.extend(clip_polyline(&outline, &pts));
        x += spacing;
        col += 1;
    }
    polylines
}

pub(super) fn clip_polyline(outline: &Outline, pts: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    if pts.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut current: Vec<[f64; 2]> = Vec::new();
    for w in pts.windows(2) {
        for piece in outline.clip_segment(w[0], w[1]) {
            if current
                .last()
                .map(|p| dist2(*p, piece[0]) < 1e-6)
                .unwrap_or(false)
            {
                current.push(piece[1]);
            } else {
                if current.len() >= 2 {
                    out.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                current.push(piece[0]);
                current.push(piece[1]);
            }
        }
    }
    if current.len() >= 2 {
        out.push(current);
    }
    out
}

pub fn clip_open_segment(loops: &[Loop], a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
    Outline::new(loops).clip_segment(a, b)
}

/// The pieces of `a..b` inside the loops.
pub(super) fn clip_segment_in(outline: &Outline, a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
    let mut ts = vec![0.0, 1.0];
    // An edge whose box misses the segment's, grown by a Clipper unit for
    // rounding, cuts it nowhere.
    let lo = [a[0].min(b[0]) - 1e-3, a[1].min(b[1]) - 1e-3];
    let hi = [a[0].max(b[0]) + 1e-3, a[1].max(b[1]) + 1e-3];
    let mut cut = |c: [f64; 2], d: [f64; 2]| {
        if !edge_box_meets(c, d, lo, hi) {
            return;
        }
        if let Some(t) = segment_t(a, b, c, d) {
            if (0.0..=1.0).contains(&t) {
                ts.push(t);
            }
        }
    };
    if let Some(cells) = outline.cells() {
        // An edge listed twice adds its cut twice, which the dedup drops.
        for (l, k) in cells.near(a, b) {
            if outline.loop_meets(l, a, b) {
                let (c, d) = outline.edge(l, k);
                cut(c, d);
            }
        }
    } else {
        for loop_ in outline.touching(a, b) {
            let n = loop_.len();
            for i in 0..n {
                cut(loop_[i], loop_[(i + 1) % n]);
            }
        }
    }
    ts.sort_by(|a, b| a.total_cmp(b));
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    let mut pieces = Vec::new();
    for w in ts.windows(2) {
        let t0 = w[0];
        let t1 = w[1];
        if t1 - t0 < 1e-3 {
            continue;
        }
        let tm = (t0 + t1) * 0.5;
        let mx = a[0] + (b[0] - a[0]) * tm;
        let my = a[1] + (b[1] - a[1]) * tm;
        if outline.contains([mx, my]) {
            let p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
            let p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
            pieces.push([p0, p1]);
        }
    }
    pieces
}

pub(super) fn segment_t(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<f64> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let denom = r[0] * s[1] - r[1] * s[0];
    if denom.abs() < 1e-12 {
        return None;
    }
    let qp = [c[0] - a[0], c[1] - a[1]];
    let t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
    let u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
    if (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

pub(super) fn rotate_loops(loops: &[Loop], angle: f64) -> Vec<Loop> {
    loops
        .iter()
        .map(|l| l.iter().copied().map(|p| rot(p, angle)).collect())
        .collect()
}

/// `f64::sin_cos` calls the platform C library. The MSVC runtime rounds
/// sin(π/4) one ulp high, and that ulp changes which ends of the 45° top rows
/// weld, so a Windows file differed from the Linux and macOS one. `libm` is
/// the same Rust code everywhere.
pub(super) fn rot(p: [f64; 2], angle: f64) -> [f64; 2] {
    let (s, c) = (libm::sin(angle), libm::cos(angle));
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}
