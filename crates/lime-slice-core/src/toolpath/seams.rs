use super::*;

pub(super) fn seam_rotate(loop_: &[[f64; 2]], mode: SeamMode, hint: [f64; 2]) -> Vec<[f64; 2]> {
    if loop_.is_empty() {
        return Vec::new();
    }
    let idx = match mode {
        SeamMode::Aligned => aligned_seam(loop_),
        SeamMode::Nearest => nearest_seam(loop_, hint),
        SeamMode::Rear | SeamMode::Edge => rear_seam(loop_),
    };
    let mut pts: Vec<[f64; 2]> = loop_[idx..]
        .iter()
        .chain(loop_[..idx].iter())
        .copied()
        .collect();
    if let Some(first) = pts.first().copied() {
        pts.push(first);
    }
    pts
}

/// The sharpest real corner, ties to +X, or the +X vertex when the loop has
/// no corner. A smooth curve's sharpest vertex is only a kink that moves from
/// layer to layer, so the seam would not stack.
pub(super) fn aligned_seam(ring: &[[f64; 2]]) -> usize {
    let corner = sharpest_near(ring, |p| -p[0], f64::MAX);
    if real_corner(turn_penalty(ring, corner)) {
        return corner;
    }
    ring.iter()
        .enumerate()
        .fold(
            (0, f64::MIN),
            |best, (i, p)| if p[0] > best.1 { (i, p[0]) } else { best },
        )
        .0
}

/// The sharpest real corner within 1 mm of the loop's back, ties to +X, or
/// the rear-most vertex, ties to +X. The slice turns the part before it
/// cuts and only moves it after, so the part frame's +Y is the bed's back.
pub(super) fn rear_seam(ring: &[[f64; 2]]) -> usize {
    let back = ring.iter().fold(f64::MIN, |y, p| y.max(p[1]));
    let in_band = |p: [f64; 2]| {
        if p[1] >= back - 1.0 {
            -p[0]
        } else {
            f64::INFINITY
        }
    };
    let corner = sharpest_near(ring, in_band, f64::MAX);
    if real_corner(turn_penalty(ring, corner)) {
        return corner;
    }
    ring.iter()
        .enumerate()
        .fold((0, [f64::MIN; 2]), |best, (i, p)| {
            if p[1] > best.1[1] || (p[1] == best.1[1] && p[0] > best.1[0]) {
                (i, *p)
            } else {
                best
            }
        })
        .0
}

/// The vertices of `ring` a `Seam::Edge` loop may start at: the real corners
/// within 1 mm of its back that turn as sharply as `rear_seam`'s corner, or
/// that vertex alone when the back has no corner. A U cut by the belt has a
/// foot on each side, and the nozzle may be at either.
pub(super) fn edge_sites(ring: &[[f64; 2]]) -> Vec<usize> {
    let first = rear_seam(ring);
    let sharp = turn_penalty(ring, first);
    if !real_corner(sharp) {
        return vec![first];
    }
    let back = ring.iter().fold(f64::MIN, |y, p| y.max(p[1]));
    (0..ring.len())
        .filter(|&i| ring[i][1] >= back - 1.0 && turn_penalty(ring, i) <= sharp + 1e-3)
        .collect()
}

/// The start of the closed `path` that a `Seam::Edge` loop takes with the
/// nozzle at `hint`, as an index of its ring.
pub(super) fn edge_start(path: &Extrusion, hint: [f64; 2]) -> usize {
    let ring = &path.points[..path.points.len() - 1];
    edge_sites(ring)
        .into_iter()
        .min_by(|&a, &b| dist2(ring[a], hint).total_cmp(&dist2(ring[b], hint)))
        .unwrap_or(0)
}

/// A turn of at least 30°, convex or concave, by `turn_penalty`'s scale.
pub(super) fn real_corner(turn: f64) -> bool {
    turn <= 0.5 || (2.0..=2.0 + 30f64.to_radians().cos()).contains(&turn)
}

/// The sharpest corner close to the vertex nearest `hint`, or that vertex
/// when nothing close turns at least 30°. On a smooth curve the "sharpest"
/// vertex is only a kink in the polyline, and starting there splits an arc.
pub(super) fn nearest_seam(ring: &[[f64; 2]], hint: [f64; 2]) -> usize {
    let (near_at, nearest) = ring
        .iter()
        .enumerate()
        .map(|(i, p)| (i, dist2(*p, hint)))
        .fold(
            (0, f64::MAX),
            |best, cur| if cur.1 < best.1 { cur } else { best },
        );
    let corner = sharpest_near(ring, |p| dist2(p, hint), nearest + 1.6 * 1.6);
    if real_corner(turn_penalty(ring, corner)) {
        corner
    } else {
        near_at
    }
}

pub(super) fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

pub(super) fn orient_path(path: &mut Extrusion, cursor: [f64; 2], has: bool, rotate_seams: bool) {
    if path.points.is_empty() || !has {
        return;
    }
    if path.is_loop() {
        match path.seam {
            Seam::Fixed | Seam::Cut => {}
            Seam::Corner if geom_closed(path) => {
                let ring = path.points.len() - 1;
                let at = nearest_seam(&path.points[..ring], cursor);
                rotate_closed_at(path, at);
            }
            Seam::Corner => {}
            Seam::Edge if geom_closed(path) => {
                let at = edge_start(path, cursor);
                rotate_closed_at(path, at);
            }
            Seam::Edge => {}
            Seam::Nearest => rotate_closed_extrusion(path, cursor),
        }
        return;
    }
    if rotate_seams && geom_closed(path) {
        rotate_closed_extrusion(path, cursor);
        return;
    }
    let a = path.points[0];
    let b = *path.points.last().unwrap();
    if path.points.len() >= 2 && dist2(cursor, b) + 1e-9 < dist2(cursor, a) {
        reverse_open(path);
    }
}

pub(super) fn rotate_closed_extrusion(path: &mut Extrusion, hint: [f64; 2]) {
    let n = path.points.len();
    if n < 4 || dist2(path.points[0], path.points[n - 1]) >= 1e-8 {
        return;
    }
    let ring = n - 1;
    let mut best = 0usize;
    let mut best_d = f64::MAX;
    for (i, p) in path.points.iter().take(ring).enumerate() {
        let d = dist2(*p, hint);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    rotate_closed_at(path, best);
}

/// The vertex of `ring` that sits inside a seam disk on this layer, closest
/// to that disk's centre. `None` when the paint misses the loop, so the
/// picker's start stays.
pub(super) fn painted_vertex(
    ring: &[[f64; 2]],
    disks: &[SeamDisk],
    z: f64,
    height: f64,
) -> Option<usize> {
    let lo = z - height;
    let mut best: Option<(usize, f64)> = None;
    for disk in disks {
        let dz = (lo - disk.p[2]).max(disk.p[2] - z).max(0.0);
        if dz >= disk.r {
            continue;
        }
        let reach2 = disk.r * disk.r - dz * dz;
        for (i, p) in ring.iter().enumerate() {
            let dx = p[0] - disk.p[0];
            let dy = p[1] - disk.p[1];
            let dist = dx * dx + dy * dy;
            if dist <= reach2 + 1e-8 && best.map(|(_, b)| dist < b).unwrap_or(true) {
                best = Some((i, dist));
            }
        }
    }
    best.map(|(i, _)| i)
}

/// The segment of the closed `points` that passes nearest a disk centre
/// within the disk, and that nearest point, strictly between its ends.
pub(super) fn painted_edge(
    points: &[[f64; 2]],
    disks: &[SeamDisk],
    z: f64,
    height: f64,
) -> Option<(usize, [f64; 2])> {
    let lo = z - height;
    let mut best: Option<(usize, [f64; 2], f64)> = None;
    for disk in disks {
        let dz = (lo - disk.p[2]).max(disk.p[2] - z).max(0.0);
        if dz >= disk.r {
            continue;
        }
        let reach2 = disk.r * disk.r - dz * dz;
        for (i, w) in points.windows(2).enumerate() {
            let d = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
            let len2 = d[0] * d[0] + d[1] * d[1];
            if len2 < 1e-12 {
                continue;
            }
            let t = ((disk.p[0] - w[0][0]) * d[0] + (disk.p[1] - w[0][1]) * d[1]) / len2;
            if t <= 1e-6 || t >= 1.0 - 1e-6 {
                continue;
            }
            let q = [w[0][0] + d[0] * t, w[0][1] + d[1] * t];
            let dist = (q[0] - disk.p[0]).powi(2) + (q[1] - disk.p[1]).powi(2);
            if dist <= reach2 + 1e-8 && best.is_none_or(|(_, _, b)| dist < b) {
                best = Some((i, q, dist));
            }
        }
    }
    best.map(|(i, q, _)| (i, q))
}

pub(super) fn rotate_closed_at(path: &mut Extrusion, at: usize) {
    let n = path.points.len();
    if at == 0 || at + 1 >= n {
        return;
    }
    path.points.pop();
    path.points.rotate_left(at);
    let first = path.points[0];
    path.points.push(first);
    rotate_frac(&mut path.z_frac, at, n);
    rotate_frac(&mut path.flow_frac, at, n);
}

pub(super) fn rotate_frac(frac: &mut Vec<f64>, best: usize, n: usize) {
    if frac.len() != n || best == 0 {
        return;
    }
    frac.pop();
    frac.rotate_left(best);
    let first = frac[0];
    frac.push(first);
}

pub(super) fn reverse_open(path: &mut Extrusion) {
    let n = path.points.len();
    path.points.reverse();
    if path.z_frac.len() == n {
        path.z_frac.reverse();
    }
    if path.flow_frac.len() == n {
        path.flow_frac.reverse();
    }
}
