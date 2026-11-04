//! Refit a polyline loop to curves (docs/plan-text-on-curves-and-fonts.md, milestone 4).
//!
//! A glyph drawn from overlapping contours (every variable font) is united in 2D on polylines about 0.1 mm apart, which
//! makes 7 to 10 times more edges than the font's own curves. This turns each such loop back into a few Bézier pieces:
//! the loop is cut at its corners, a run with no bend in it becomes one line, and a bent run is fitted with cubic Béziers
//! (Schneider's method: least squares on the chord-length parameter, reparametrised, split where the error is largest).
//! The fit stays within `tol` of the polyline, and the caller keeps the polyline when the area moved more than it allows.

use super::{Contour, Seg};

type P = [f64; 2];

/// A turn at a vertex sharper than this, radians, is a corner: the fit does not run across it.
const CORNER_RAD: f64 = 0.70;

/// Newton steps that improve the parameter of each point before a fit is judged.
const REPARAM_STEPS: usize = 4;

const MAX_DEPTH: usize = 14;

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn mul(a: P, k: f64) -> P {
    [a[0] * k, a[1] * k]
}
fn dot(a: P, b: P) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn len(a: P) -> f64 {
    a[0].hypot(a[1])
}
fn unit(a: P) -> P {
    let l = len(a);
    if l < 1e-12 {
        [0.0, 0.0]
    } else {
        mul(a, 1.0 / l)
    }
}

/// `pts` as a loop of straight lines.
fn polygon(pts: &[P]) -> Contour {
    Contour::polygon(pts)
}

/// The loop `pts` (no repeated closing point) as curves within `tol` mm, or the same loop as lines when it is too short to
/// fit. The result closes exactly on its start.
pub fn fit_loop(pts: &[P], tol: f64) -> Contour {
    let n = pts.len();
    if n < 8 {
        return polygon(pts);
    }
    let turn = |i: usize| {
        let a = sub(pts[i], pts[(i + n - 1) % n]);
        let b = sub(pts[(i + 1) % n], pts[i]);
        if len(a) < 1e-9 || len(b) < 1e-9 {
            return 0.0;
        }
        (a[0] * b[1] - a[1] * b[0]).atan2(dot(a, b)).abs()
    };
    let corners: Vec<usize> = (0..n).filter(|&i| turn(i) > CORNER_RAD).collect();
    let mut segs: Vec<Seg> = Vec::new();
    let start;
    if corners.is_empty() {
        // A smooth loop: two runs, from the first point to the opposite one and back, tangents taken across the joins.
        start = pts[0];
        let half = n / 2;
        let tangent = |i: usize| unit(sub(pts[(i + 1) % n], pts[(i + n - 1) % n]));
        let first: Vec<P> = pts[..=half].to_vec();
        let mut second: Vec<P> = pts[half..].to_vec();
        second.push(pts[0]);
        let (t0, tm) = (tangent(0), tangent(half));
        fit_run(&first, t0, mul(tm, -1.0), tol, 0, &mut segs);
        fit_run(&second, tm, mul(t0, -1.0), tol, 0, &mut segs);
    } else {
        start = pts[corners[0]];
        for k in 0..corners.len() {
            let (a, b) = (corners[k], corners[(k + 1) % corners.len()]);
            let mut run = vec![pts[a]];
            let mut i = a;
            loop {
                i = (i + 1) % n;
                run.push(pts[i]);
                if i == b {
                    break;
                }
            }
            if run.len() < 2 {
                continue;
            }
            let t1 = unit(sub(run[1], run[0]));
            let t2 = unit(sub(run[run.len() - 2], run[run.len() - 1]));
            fit_run(&run, t1, t2, tol, 0, &mut segs);
        }
    }
    if segs.is_empty() {
        return polygon(pts);
    }
    // Close exactly on the start.
    if let Some(last) = segs.last_mut() {
        match last {
            Seg::Line(p) | Seg::Quad(_, p) | Seg::Cubic(_, _, p) => *p = start,
        }
    }
    Contour { start, segs }
}

/// A run of points from a corner to the next: a line when it is straight, else cubic pieces appended to `out`.
/// `t1` points forward from the first point, `t2` backward from the last.
fn fit_run(pts: &[P], t1: P, t2: P, tol: f64, depth: usize, out: &mut Vec<Seg>) {
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let chord = sub(last, first);
    let chord_len = len(chord);
    if pts.len() == 2 {
        out.push(Seg::Line(last));
        return;
    }
    // Straight: every point within `tol` of the chord (a closed run, first = last, is never straight).
    if chord_len > 1e-9 {
        let along = unit(chord);
        let off = |p: P| {
            let d = sub(p, first);
            (d[0] * along[1] - d[1] * along[0]).abs()
        };
        if pts.iter().all(|&p| off(p) <= tol) {
            out.push(Seg::Line(last));
            return;
        }
    }
    if pts.len() == 3 && chord_len > 1e-9 {
        // Three points: a corner's two lines, or a short bend; lines are exact.
        out.push(Seg::Line(pts[1]));
        out.push(Seg::Line(last));
        return;
    }
    let mut u = chord_params(pts);
    let mut bez = generate(pts, &u, t1, t2);
    let (mut err, mut split) = max_error(pts, &bez, &u);
    if err < tol {
        out.push(Seg::Cubic(bez[1], bez[2], bez[3]));
        return;
    }
    if err < tol * 16.0 {
        for _ in 0..REPARAM_STEPS {
            u = reparam(pts, &u, &bez);
            bez = generate(pts, &u, t1, t2);
            let (e, s) = max_error(pts, &bez, &u);
            err = e;
            split = s;
            if err < tol {
                out.push(Seg::Cubic(bez[1], bez[2], bez[3]));
                return;
            }
        }
    }
    if depth >= MAX_DEPTH || pts.len() < 4 {
        for &p in &pts[1..] {
            out.push(Seg::Line(p));
        }
        return;
    }
    let split = split.clamp(1, pts.len() - 2);
    let centre = unit(sub(pts[split - 1], pts[split + 1]));
    fit_run(&pts[..=split], t1, centre, tol, depth + 1, out);
    fit_run(&pts[split..], mul(centre, -1.0), t2, tol, depth + 1, out);
}

fn chord_params(pts: &[P]) -> Vec<f64> {
    let mut u = vec![0.0];
    for i in 1..pts.len() {
        u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
    }
    let total = *u.last().expect("points");
    if total < 1e-12 {
        return (0..pts.len())
            .map(|i| i as f64 / (pts.len() - 1) as f64)
            .collect();
    }
    u.iter().map(|v| v / total).collect()
}

fn bezier(b: &[P; 4], t: f64) -> P {
    let m = 1.0 - t;
    let w = [m * m * m, 3.0 * m * m * t, 3.0 * m * t * t, t * t * t];
    let mut p = [0.0, 0.0];
    for i in 0..4 {
        p = add(p, mul(b[i], w[i]));
    }
    p
}

fn bezier_d1(b: &[P; 4], t: f64) -> P {
    let m = 1.0 - t;
    let q = [sub(b[1], b[0]), sub(b[2], b[1]), sub(b[3], b[2])];
    add(
        add(mul(q[0], 3.0 * m * m), mul(q[1], 6.0 * m * t)),
        mul(q[2], 3.0 * t * t),
    )
}

fn bezier_d2(b: &[P; 4], t: f64) -> P {
    let m = 1.0 - t;
    let q = [
        add(sub(b[2], mul(b[1], 2.0)), b[0]),
        add(sub(b[3], mul(b[2], 2.0)), b[1]),
    ];
    add(mul(q[0], 6.0 * m), mul(q[1], 6.0 * t))
}

/// The cubic from `pts[0]` to the last point with the end tangents `t1` and `t2`, least squares on the parameters `u`.
fn generate(pts: &[P], u: &[f64], t1: P, t2: P) -> [P; 4] {
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let mut c = [[0.0; 2]; 2];
    let mut x = [0.0; 2];
    for (i, &p) in pts.iter().enumerate() {
        let t = u[i];
        let m = 1.0 - t;
        let (b0, b1, b2, b3) = (m * m * m, 3.0 * m * m * t, 3.0 * m * t * t, t * t * t);
        let a1 = mul(t1, b1);
        let a2 = mul(t2, b2);
        c[0][0] += dot(a1, a1);
        c[0][1] += dot(a1, a2);
        c[1][1] += dot(a2, a2);
        let tmp = sub(
            p,
            add(add(mul(first, b0 + b1), mul(last, b2 + b3)), [0.0, 0.0]),
        );
        x[0] += dot(a1, tmp);
        x[1] += dot(a2, tmp);
    }
    c[1][0] = c[0][1];
    let det = c[0][0] * c[1][1] - c[1][0] * c[0][1];
    let chord = len(sub(last, first));
    let eps = 1e-6 * chord;
    let (mut a1, mut a2) = if det.abs() > 1e-12 {
        (
            (x[0] * c[1][1] - x[1] * c[0][1]) / det,
            (c[0][0] * x[1] - c[1][0] * x[0]) / det,
        )
    } else {
        (0.0, 0.0)
    };
    if a1 < eps || a2 < eps || !a1.is_finite() || !a2.is_finite() {
        // The fit folded back or failed: a third of the chord each, the standard fallback.
        a1 = chord / 3.0;
        a2 = chord / 3.0;
    }
    [first, add(first, mul(t1, a1)), add(last, mul(t2, a2)), last]
}

/// The largest distance from a point to the curve at its parameter, and the index of that point.
fn max_error(pts: &[P], b: &[P; 4], u: &[f64]) -> (f64, usize) {
    let mut worst = (0.0, pts.len() / 2);
    for i in 1..pts.len() - 1 {
        let d = len(sub(bezier(b, u[i]), pts[i]));
        if d >= worst.0 {
            worst = (d, i);
        }
    }
    worst
}

/// One Newton step of each interior parameter toward the closest point on the curve.
fn reparam(pts: &[P], u: &[f64], b: &[P; 4]) -> Vec<f64> {
    let mut out = u.to_vec();
    for i in 1..pts.len() - 1 {
        let t = u[i];
        let diff = sub(bezier(b, t), pts[i]);
        let d1 = bezier_d1(b, t);
        let d2 = bezier_d2(b, t);
        let num = dot(diff, d1);
        let den = dot(d1, d1) + dot(diff, d2);
        if den.abs() > 1e-12 {
            out[i] = (t - num / den).clamp(0.0, 1.0);
        }
    }
    // Parameters stay in order.
    for i in 1..out.len() {
        if out[i] < out[i - 1] {
            out[i] = out[i - 1];
        }
    }
    out
}
