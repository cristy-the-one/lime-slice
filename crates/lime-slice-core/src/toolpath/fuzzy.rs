use super::*;

/// The offset, after the seam and the scarf. A scarf ramp already has a
/// height and a flow on each point, so it is left alone. Taking the mark
/// means a second pass does nothing.
pub(crate) fn apply_fuzzy_skin(paths: &mut [Extrusion]) {
    for path in paths {
        fuzz_settled(path);
    }
}

pub(super) fn fuzz_settled(path: &mut Extrusion) {
    let Some(mark) = path.fuzzy.take() else {
        return;
    };
    if !matches!(path.kind, PathKind::Outer | PathKind::Wall) || path.points.len() < 2 {
        return;
    }
    if !path.z_frac.is_empty() || !path.flow_frac.is_empty() {
        return;
    }
    path.points = fuzz_polyline(&path.points, mark.skin, mark.z);
}

pub(super) fn fuzz_polyline(points: &[[f64; 2]], fuzzy: FuzzySkin, z: f64) -> Vec<[f64; 2]> {
    let mut length = 0.0;
    for w in points.windows(2) {
        length += hypot2(w[0], w[1]);
    }
    if length < fuzzy.point_distance * 1.5 {
        return points.to_vec();
    }
    let last = *points.last().unwrap();
    let mut out = vec![points[0]];
    let mut acc = 0.0;
    let mut next = fuzzy.point_distance;
    for w in points.windows(2) {
        let (a, b) = (w[0], w[1]);
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let seg = dx.hypot(dy);
        if seg < 1e-9 {
            continue;
        }
        while acc + seg + 1e-9 >= next && next < length - 1e-6 {
            let t = ((next - acc) / seg).clamp(0.0, 1.0);
            let sample = [a[0] + dx * t, a[1] + dy * t];
            let nx = -dy / seg;
            let ny = dx / seg;
            let n = fuzzy_noise(sample[0], sample[1], z);
            out.push([
                sample[0] + nx * n * fuzzy.thickness,
                sample[1] + ny * n * fuzzy.thickness,
            ]);
            next += fuzzy.point_distance;
        }
        acc += seg;
    }
    if hypot2(*out.last().unwrap(), last) > 1e-6 {
        out.push(last);
    } else {
        *out.last_mut().unwrap() = last;
    }
    out
}

pub(super) fn hypot2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// -1 to 1, stable for the same point and layer.
pub(super) fn fuzzy_noise(x: f64, y: f64, z: f64) -> f64 {
    let s = (x * 12.9898 + y * 78.233 + z * 45.164).sin() * 43758.5453;
    // `fract` of a negative value stays negative, which would push the
    // offset past one thickness. `floor` keeps the fraction in [0, 1).
    let frac = s - s.floor();
    frac * 2.0 - 1.0
}

#[cfg(test)]
mod fuzzy_tests {
    use super::*;
    use crate::strategy::{FuzzySkin, StrategyId};

    fn path(kind: PathKind, pts: Vec<[f64; 2]>) -> Extrusion {
        extrusion(kind, &crate::strategy::pure(StrategyId::Speed), pts, 0.45)
    }

    fn dist_seg(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ap = [p[0] - a[0], p[1] - a[1]];
        let ab2 = ab[0] * ab[0] + ab[1] * ab[1];
        if ab2 < 1e-18 {
            return ap[0].hypot(ap[1]);
        }
        let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / ab2).clamp(0.0, 1.0);
        (p[0] - (a[0] + ab[0] * t)).hypot(p[1] - (a[1] + ab[1] * t))
    }

    fn dist_poly(p: [f64; 2], poly: &[[f64; 2]]) -> f64 {
        poly.windows(2)
            .map(|w| dist_seg(p, w[0], w[1]))
            .fold(f64::MAX, f64::min)
    }

    #[test]
    fn fuzzy_skin_offsets_outer_walls_and_leaves_a_scarf_ramp() {
        let loop_pts = vec![[0.0, 0.0], [12.0, 0.0], [12.0, 8.0], [0.0, 8.0], [0.0, 0.0]];
        let features = PathFeatures {
            fuzzy_skin: Some(FuzzySkin::default()),
            z: 1.2,
            ..PathFeatures::default()
        };
        let mut plain = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        fuzz_settled(&mut plain[0]);
        assert_eq!(plain[0].points[0], loop_pts[0]);
        assert_eq!(*plain[0].points.last().unwrap(), *loop_pts.last().unwrap());
        assert!(plain[0].points.len() > loop_pts.len());
        let mut moved = false;
        for p in &plain[0].points {
            let d = dist_poly(*p, &loop_pts);
            assert!(d <= 0.3 + 1e-9, "{p:?} is {d} mm off the wall");
            if d > 0.05 {
                moved = true;
            }
        }
        assert!(moved, "the wall did not move");

        let mut scarfed = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        scarfed[0].z_frac = vec![0.2; loop_pts.len()];
        scarfed[0].flow_frac = vec![1.0; loop_pts.len()];
        fuzz_settled(&mut scarfed[0]);
        assert_eq!(scarfed[0].points, loop_pts);

        let mut inner = finish_paths(vec![path(PathKind::Inner, loop_pts.clone())], &features);
        fuzz_settled(&mut inner[0]);
        assert_eq!(inner[0].points, loop_pts);

        let mut smooth = finish_paths(
            vec![path(PathKind::Outer, loop_pts.clone())],
            &PathFeatures {
                fuzzy_skin: None,
                ..features
            },
        );
        fuzz_settled(&mut smooth[0]);
        assert_eq!(smooth[0].points, loop_pts);
    }

    #[test]
    fn seam_paint_starts_a_wall_inside_the_disk_and_leaves_infill() {
        let loop_pts = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [0.0, 10.0],
            [0.0, 0.0],
        ];
        let features = PathFeatures {
            z: 0.2,
            layer_height: 0.2,
            seam_paint: vec![crate::support::paint::SeamDisk {
                p: [10.0, 10.0, 0.1],
                n: [0.0, 0.0, 1.0],
                r: 1.5,
            }],
            ..PathFeatures::default()
        };
        let walls = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &features);
        assert_eq!(walls[0].points[0], [10.0, 10.0]);
        assert_eq!(walls[0].seam, Seam::Fixed);
        let fill = finish_paths(vec![path(PathKind::Solid, loop_pts.clone())], &features);
        assert_eq!(fill[0].points, loop_pts);
        let miss = PathFeatures {
            seam_paint: vec![crate::support::paint::SeamDisk {
                p: [5.0, 5.0, 0.1],
                n: [0.0, 0.0, 1.0],
                r: 1.0,
            }],
            ..features
        };
        let plain = finish_paths(vec![path(PathKind::Outer, loop_pts.clone())], &miss);
        assert_eq!(plain[0].points, loop_pts);
    }
}
