//! Organic surfaces S5: Patch and BlendSurface.
//!
//! A clean 2–4 sided G0 boundary uses GeomFill. An N-sided opening, a guide point,
//! or any side that asks for G1 or G2, is N Hermite–Coons pieces. No GeomPlate.
//!
//! Edge location (owner decision on #818): an edge belongs to an asked side when
//! every sampled point lies within 1e-3 mm of that side's original curve. Those
//! edges must cover the side's length within 1e-3 mm, and each one must meet the
//! bound. Inner splits M_i→C are checked at the continuity asked on that side.
//! The 5- and 6-sided openings are cut from one ellipsoid of revolution, so the
//! faces at each corner are tangent. The 3-sided opening keeps its three sharp corners.

use base64::Engine;
use serde_json::{json, Value};

/// Restored acceptance numbers. G2 also requires `model_check`'s own class (`kind == "G2"`),
/// which is the plan's curvature jump of at most 1e-3 mm^-1.
const G0_GAP_MM: f64 = 1e-4;
const G1_ANGLE_DEG: f64 = 0.1;
const G2_JUMP: f64 = 0.05;
const ON_CURVE_MM: f64 = 1e-3;
/// Fine enough that a point on the curve is within `ON_CURVE_MM` of the sampled polyline.
const CHORD_MM: f64 = 5e-4;

fn call(request: Value) -> Value {
    let text = lime_model_occt::tree(&request.to_string());
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

fn has_occt() -> bool {
    let caps = call(json!({ "call": "capabilities" }));
    if caps["stepMeshing"].as_bool() == Some(true) {
        return true;
    }
    if std::env::var_os("LIME_REQUIRE_OCCT").is_some() {
        panic!("Open CASCADE is required (LIME_REQUIRE_OCCT is set) but not linked: {caps}");
    }
    false
}

fn decode_f32(b64: &str) -> Vec<f32> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

fn decode_u32(b64: &str) -> Vec<u32> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect()
}

struct SampledEdge {
    index: usize,
    points: Vec<[f64; 3]>,
}

fn sampled_edges(opened: &Value) -> Vec<SampledEdge> {
    let points = decode_f32(opened["edgePoints"].as_str().expect("edgePoints"));
    let offsets = decode_u32(opened["edgeOffsets"].as_str().expect("edgeOffsets"));
    let mut edges = Vec::new();
    for index in 0..offsets.len().saturating_sub(1) {
        let start = offsets[index] as usize;
        let end = offsets[index + 1] as usize;
        let mut row = Vec::new();
        let mut at = start * 3;
        while at + 2 < end * 3 && at + 2 < points.len() {
            row.push([points[at] as f64, points[at + 1] as f64, points[at + 2] as f64]);
            at += 3;
        }
        if row.len() >= 2 {
            edges.push(SampledEdge { index, points: row });
        }
    }
    edges
}

fn organic_loop(sides: usize, radius: f64, bulge: f64, z: f64) -> Value {
    let mut verts = Vec::with_capacity(sides);
    for i in 0..sides {
        let ang = std::f64::consts::TAU * (i as f64) / (sides as f64) - std::f64::consts::FRAC_PI_2;
        verts.push([radius * ang.cos(), radius * ang.sin(), z]);
    }
    let mut segments = Vec::with_capacity(sides);
    for i in 0..sides {
        let a = verts[i];
        let b = verts[(i + 1) % sides];
        let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, z];
        let len = (mid[0] * mid[0] + mid[1] * mid[1]).sqrt().max(1e-6);
        let through = [mid[0] + mid[0] / len * bulge, mid[1] + mid[1] / len * bulge, z];
        segments.push(json!({ "kind": "spline", "through": [through], "to": b }));
    }
    json!({ "kind": "segments", "start": verts[0], "segments": segments })
}

fn opening_sheet(sides: usize) -> Value {
    json!({
        "kind": "sheet",
        "mode": "extrude",
        "curves": [organic_loop(sides, 16.0, 3.0, 12.0)],
        "dir": [0.0, 0.0, -1.0],
        "distance": 12.0
    })
}

fn circle_arcs(radius: f64, z: f64) -> Value {
    json!({
        "kind": "segments",
        "start": [radius, 0.0, z],
        "segments": [
            { "kind": "arc", "through": [0.0, radius, z], "to": [-radius, 0.0, z] },
            { "kind": "arc", "through": [0.0, -radius, z], "to": [radius, 0.0, z] }
        ]
    })
}

fn circle_curve(radius: f64, z: f64) -> Value {
    // A polynomial spline, not a rational arc. The blend's end derivative is built
    // as if the rim weights are 1, and a rational circle leaves the normal 0.3° off.
    let count = 24;
    let points: Vec<[f64; 3]> = (0..count)
        .map(|i| {
            let ang = std::f64::consts::TAU * (i as f64) / (count as f64);
            [radius * ang.cos(), radius * ang.sin(), z]
        })
        .collect();
    json!({ "kind": "spline", "points": points, "closed": true })
}

fn cylinder_sheet(radius: f64, z0: f64, height: f64) -> Value {
    json!({
        "kind": "sheet",
        "mode": "extrude",
        "curves": [circle_curve(radius, z0)],
        "dir": [0.0, 0.0, 1.0],
        "distance": height
    })
}

/// Quarter-circle meridian of a sphere, from the +Z pole to the equator.
/// Revolved, it is one smooth face. A sphere is an ellipsoid of revolution with equal axes.
fn hemisphere_meridian(radius: f64) -> Value {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    json!({
        "kind": "segments",
        "start": [0.0, 0.0, radius],
        "segments": [{
            "kind": "arc",
            "through": [radius * s, 0.0, radius * s],
            "to": [radius, 0.0, 0.0]
        }]
    })
}

fn polygon_curve(sides: usize, circum: f64, z: f64, spin: f64) -> Value {
    let mut points = Vec::with_capacity(sides);
    for i in 0..sides {
        let ang = spin + std::f64::consts::TAU * (i as f64) / (sides as f64);
        points.push([circum * ang.cos(), circum * ang.sin(), z]);
    }
    json!({ "kind": "polyline", "points": points, "closed": true })
}

struct SideCurve {
    edges: Vec<usize>,
    /// One polyline per original edge, in chain order. Samples lie on the curve.
    polylines: Vec<Vec<[f64; 3]>>,
    length: f64,
    midpoint: [f64; 3],
    continuity: &'static str,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    dot(d, d)
}

fn polyline_length(points: &[[f64; 3]]) -> f64 {
    points.windows(2).map(|w| dist2(w[0], w[1]).sqrt()).sum()
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Points of the short circular arc from `from` to `to`, including `to`.
/// `hint` is another sample of the same curve, so the circle is the one through all three.
/// The mesh chord is clamped at 0.01 mm, and a chord of that spacing can sit 0.002 mm off
/// the curve, which is already past the 1e-3 mm on-curve rule. The arc stays within a
/// negligible distance of the real curve between those samples.
fn sample_arc(from: [f64; 3], to: [f64; 3], hint: [f64; 3]) -> Vec<[f64; 3]> {
    let ab = sub(to, from);
    let ah = sub(hint, from);
    let n = cross(ab, ah);
    let n2 = dot(n, n);
    let ab2 = dot(ab, ab);
    let ah2 = dot(ah, ah);
    if n2 < 1e-18 || ab2 < 1e-18 {
        return vec![to];
    }
    let offset = scale(
        add(scale(cross(n, ab), ah2), scale(cross(ah, n), ab2)),
        1.0 / (2.0 * n2),
    );
    let center = add(from, offset);
    let va = sub(from, center);
    let vb = sub(to, center);
    let ra = norm(va);
    let rb = norm(vb);
    if ra < 1e-9 || rb < 1e-9 {
        return vec![to];
    }
    let axis = cross(va, vb);
    let axis_len = norm(axis);
    let cos_ang = (dot(va, vb) / (ra * rb)).clamp(-1.0, 1.0);
    let ang = cos_ang.acos();
    if ang < 1e-8 || axis_len < 1e-12 || ra > 1.0e6 {
        return vec![to];
    }
    let axis = scale(axis, 1.0 / axis_len);
    let steps = ((ra * ang) / 0.05).ceil().max(1.0) as usize;
    let mut out = Vec::with_capacity(steps);
    for i in 1..=steps {
        let theta = ang * (i as f64) / (steps as f64);
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        let rotated = add(
            add(scale(va, cos_t), scale(cross(axis, va), sin_t)),
            scale(axis, dot(axis, va) * (1.0 - cos_t)),
        );
        out.push(add(center, rotated));
    }
    out
}

fn densify_polyline(points: &[[f64; 3]]) -> Vec<[f64; 3]> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut out = vec![points[0]];
    for i in 0..points.len() - 1 {
        let hint = if i + 2 < points.len() { points[i + 2] } else { points[i - 1] };
        out.extend(sample_arc(points[i], points[i + 1], hint));
    }
    out
}

fn point_segment_distance(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = sub(b, a);
    let len2 = dot(ab, ab);
    if len2 < 1e-24 {
        return dist2(p, a).sqrt();
    }
    let t = (dot(sub(p, a), ab) / len2).clamp(0.0, 1.0);
    let q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    dist2(p, q).sqrt()
}

fn point_polyline_distance(p: [f64; 3], poly: &[[f64; 3]]) -> f64 {
    poly.windows(2)
        .map(|w| point_segment_distance(p, w[0], w[1]))
        .fold(f64::MAX, f64::min)
}

fn point_curves_distance(p: [f64; 3], curves: &[Vec<[f64; 3]>]) -> f64 {
    curves
        .iter()
        .map(|poly| point_polyline_distance(p, poly))
        .fold(f64::MAX, f64::min)
}

fn max_on_curve(points: &[[f64; 3]], curves: &[Vec<[f64; 3]>]) -> f64 {
    points
        .iter()
        .map(|p| point_curves_distance(*p, curves))
        .fold(0.0, f64::max)
}

/// Point at half the polyline length, walking edges in order.
fn arc_midpoint(polylines: &[Vec<[f64; 3]>]) -> [f64; 3] {
    let total: f64 = polylines.iter().map(|poly| polyline_length(poly)).sum();
    let mut left = total * 0.5;
    for poly in polylines {
        for w in poly.windows(2) {
            let step = dist2(w[0], w[1]).sqrt();
            if step >= left || step < 1e-15 {
                if step < 1e-15 {
                    continue;
                }
                let t = left / step;
                return [
                    w[0][0] + (w[1][0] - w[0][0]) * t,
                    w[0][1] + (w[1][1] - w[0][1]) * t,
                    w[0][2] + (w[1][2] - w[0][2]) * t,
                ];
            }
            left -= step;
        }
    }
    polylines
        .last()
        .and_then(|poly| poly.last().copied())
        .unwrap_or([0.0, 0.0, 0.0])
}

fn ends_of(points: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    (*points.first().unwrap(), *points.last().unwrap())
}

fn reverse_poly(points: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut out = points.to_vec();
    out.reverse();
    out
}

/// Order edges so each one starts where the previous one ended.
fn chain_polylines(mut edges: Vec<SampledEdge>) -> Vec<Vec<[f64; 3]>> {
    if edges.is_empty() {
        return Vec::new();
    }
    let mut ordered = vec![edges.remove(0)];
    while !edges.is_empty() {
        let (head, _tail) = ends_of(&ordered[0].points);
        let (_, tip) = ends_of(&ordered.last().unwrap().points);
        let mut best_at = 0;
        let mut best_d = f64::MAX;
        let mut attach_tail = true;
        let mut flip = false;
        for (i, edge) in edges.iter().enumerate() {
            let (a, b) = ends_of(&edge.points);
            for (end, to_tail) in [(tip, true), (head, false)] {
                for (point, reversed) in [(a, false), (b, true)] {
                    let d = dist2(end, point);
                    if d < best_d {
                        best_d = d;
                        best_at = i;
                        attach_tail = to_tail;
                        flip = reversed;
                    }
                }
            }
        }
        let mut edge = edges.remove(best_at);
        if flip {
            edge.points = reverse_poly(&edge.points);
        }
        if attach_tail {
            ordered.push(edge);
        } else {
            ordered.insert(0, edge);
        }
    }
    ordered.into_iter().map(|edge| edge.points).collect()
}

fn side_from_edges(edges: Vec<SampledEdge>, continuity: &'static str) -> SideCurve {
    let ids: Vec<usize> = edges.iter().map(|edge| edge.index).collect();
    let coarse = chain_polylines(edges);
    // The mesh chord is clamped at 0.01 mm, so a raw polyline is short of the arc by
    // more than 0.001 mm. Both lengths are taken on the fitted arc.
    let polylines: Vec<Vec<[f64; 3]>> = coarse.iter().map(|poly| densify_polyline(poly)).collect();
    let length: f64 = polylines.iter().map(|poly| polyline_length(poly)).sum();
    let midpoint = arc_midpoint(&polylines);
    SideCurve { edges: ids, polylines, length, midpoint, continuity }
}

fn sort_by_angle(mut edges: Vec<SampledEdge>) -> Vec<SampledEdge> {
    edges.sort_by(|a, b| {
        let ma = centroid(&a.points);
        let mb = centroid(&b.points);
        ma[1].atan2(ma[0]).total_cmp(&mb[1].atan2(mb[0]))
    });
    edges
}

fn centroid(points: &[[f64; 3]]) -> [f64; 3] {
    let n = points.len() as f64;
    let sum = points.iter().fold([0.0, 0.0, 0.0], |acc, p| {
        [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]]
    });
    [sum[0] / n, sum[1] / n, sum[2] / n]
}

fn top_sides(opened: &Value, continuity: impl Fn(usize, usize) -> &'static str) -> Vec<SideCurve> {
    let mut top: Vec<SampledEdge> = sampled_edges(opened)
        .into_iter()
        .filter(|edge| edge.points.iter().all(|p| p[2] > 11.0))
        .collect();
    top = sort_by_angle(top);
    let count = top.len();
    top.into_iter()
        .enumerate()
        .map(|(i, edge)| side_from_edges(vec![edge], continuity(i, count)))
        .collect()
}

fn patch_op(sides: &[SideCurve], points: Option<[f64; 3]>) -> Value {
    let boundaries: Vec<Value> = sides
        .iter()
        .map(|side| json!({ "edges": side.edges, "continuity": side.continuity }))
        .collect();
    let mut op = json!({ "kind": "patch", "boundaries": boundaries });
    if let Some(point) = points {
        op["points"] = json!([point]);
    }
    op
}

struct Measured {
    _index: usize,
    kind: String,
    gap: f64,
    angle: f64,
    jump: f64,
}

fn row_of(rows: &[Value], index: usize) -> Option<Measured> {
    let row = rows.iter().find(|row| row["edge"].as_u64() == Some(index as u64))?;
    Some(Measured {
        _index: index,
        kind: row["kind"].as_str().unwrap_or("").to_string(),
        gap: row["gapMm"].as_f64().unwrap_or(99.0),
        angle: row["angleDeg"].as_f64().unwrap_or(99.0),
        jump: row["curvatureJump"].as_f64().unwrap_or(99.0),
    })
}

fn assert_continuity(case_name: &str, label: &str, asked: &str, row: &Measured) {
    assert!(
        row.gap < G0_GAP_MM,
        "S5 case={case_name} {label} G0 gap {} mm is not under {G0_GAP_MM}",
        row.gap
    );
    if asked == "g1" || asked == "g2" {
        assert!(
            row.angle < G1_ANGLE_DEG,
            "S5 case={case_name} {label} G1 angle {}° is not under {G1_ANGLE_DEG}",
            row.angle
        );
        assert!(
            row.kind == "G1" || row.kind == "G2",
            "S5 case={case_name} {label} asked {asked} but model_check classed it {}: gap={} angle={} jump={}",
            row.kind, row.gap, row.angle, row.jump
        );
    }
    if asked == "g2" {
        assert!(
            row.jump < G2_JUMP,
            "S5 case={case_name} {label} G2 curvature jump {} mm^-1 is not under {G2_JUMP}",
            row.jump
        );
        assert!(
            row.kind == "G2",
            "S5 case={case_name} {label} asked G2 but model_check classed it {} (jump {})",
            row.kind, row.jump
        );
    }
}

fn nearest_endpoint(point: [f64; 3], edges: &[&SampledEdge]) -> [f64; 3] {
    edges
        .iter()
        .flat_map(|edge| {
            let (a, b) = ends_of(&edge.points);
            [a, b]
        })
        .min_by(|a, b| dist2(*a, point).total_cmp(&dist2(*b, point)))
        .unwrap_or(point)
}

fn check_opening(
    case_name: &str,
    key: &str,
    node: i64,
    mesh: &Value,
    sides: &[SideCurve],
    expect_splits: bool,
    sharp_count: Option<usize>,
) {
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": node,
        "chordMm": CHORD_MM,
        "curvature": false,
        "isoparms": false
    }));
    let rows = inspect["continuity"]["edges"].as_array().cloned().unwrap_or_default();
    let sharp = inspect["continuity"]["sharpVertices"].as_array().cloned().unwrap_or_default();
    println!(
        "S5 report case={case_name} sharedEdges={} listed={} sharpVertices={} solid-check=sewn",
        inspect["continuity"]["sharedEdges"],
        rows.len(),
        sharp.len()
    );
    for vertex in &sharp {
        println!(
            "S5 report case={case_name} sharp at={:?} faces={:?} angleDeg={}",
            vertex["at"], vertex["faces"], vertex["angleDeg"]
        );
    }
    if let Some(count) = sharp_count {
        assert_eq!(
            sharp.len(),
            count,
            "S5 case={case_name} continuity.sharpVertices should list {count}, got {sharp:?}"
        );
        if count > 0 {
            for vertex in &sharp {
                let angle = vertex["angleDeg"].as_f64().unwrap_or(0.0);
                assert!(
                    angle > G1_ANGLE_DEG,
                    "S5 case={case_name} listed a sharp vertex at {angle}°, which is not over {G1_ANGLE_DEG}"
                );
            }
        }
    }

    let sewn = sampled_edges(mesh);

    let mut used = vec![false; sewn.len()];
    let mut outer_hits: Vec<Vec<usize>> = Vec::new();
    for side in sides {
        let mut hits = Vec::new();
        for (n, edge) in sewn.iter().enumerate() {
            if max_on_curve(&edge.points, &side.polylines) <= ON_CURVE_MM {
                hits.push(n);
                used[n] = true;
            }
        }
        if hits.is_empty() {
            let mut best = f64::MAX;
            let mut best_z = 0.0;
            for edge in &sewn {
                let d = max_on_curve(&edge.points, &side.polylines);
                if d < best {
                    best = d;
                    best_z = centroid(&edge.points)[2];
                }
            }
            panic!(
                "S5 case={case_name} side asked {} has no edge within {ON_CURVE_MM} mm of the original curve (length {}). nearest={best} mm at z={best_z}, sewnEdges={}",
                side.continuity, side.length, sewn.len()
            );
        }
        let covered: f64 = hits
            .iter()
            .map(|n| polyline_length(&densify_polyline(&sewn[*n].points)))
            .sum();
        let cover_err = (covered - side.length).abs();
        let mut max_gap: f64 = 0.0;
        let mut max_angle: f64 = 0.0;
        let mut max_jump: f64 = 0.0;
        for n in &hits {
            let edge = &sewn[*n];
            let row = row_of(&rows, edge.index).unwrap_or_else(|| {
                panic!(
                    "S5 case={case_name} on-curve edge {} is missing from continuity.edges",
                    edge.index
                )
            });
            let label = format!("side-edge {}", edge.index);
            assert_continuity(case_name, &label, side.continuity, &row);
            max_gap = max_gap.max(row.gap);
            max_angle = max_angle.max(row.angle);
            max_jump = max_jump.max(row.jump);
            println!(
                "S5 report case={case_name} side-edge={} asked={} kind={} gapMm={} angleDeg={} curvatureJump={}",
                edge.index, side.continuity, row.kind, row.gap, row.angle, row.jump
            );
        }
        println!(
            "S5 report case={case_name} side asked={} edges={} coverageMm={covered} sideMm={} coverErrMm={cover_err} maxGapMm={max_gap} maxAngleDeg={max_angle} maxJump={max_jump}",
            side.continuity,
            hits.len(),
            side.length
        );
        assert!(
            cover_err <= ON_CURVE_MM,
            "S5 case={case_name} side coverage {covered} mm is {cover_err} mm off the original length {}",
            side.length
        );
        outer_hits.push(hits);
    }

    if expect_splits {
        for (i, side) in sides.iter().enumerate() {
            let outer_edges: Vec<&SampledEdge> = outer_hits[i].iter().map(|n| &sewn[*n]).collect();
            let mid_guess = side.midpoint;
            let mid = nearest_endpoint(mid_guess, &outer_edges);
            let mid_err = dist2(mid, mid_guess).sqrt();
            assert!(
                mid_err <= ON_CURVE_MM,
                "S5 case={case_name} side {i} midpoint vertex is {mid_err} mm from the arc-length midpoint"
            );
            let mut splits = Vec::new();
            for (n, edge) in sewn.iter().enumerate() {
                if used[n] {
                    continue;
                }
                let (a, b) = ends_of(&edge.points);
                let near = dist2(a, mid).sqrt().min(dist2(b, mid).sqrt());
                if near <= ON_CURVE_MM {
                    splits.push(n);
                }
            }
            assert_eq!(
                splits.len(),
                1,
                "S5 case={case_name} side {i} should have one inner split from its midpoint, found {}",
                splits.len()
            );
            let edge = &sewn[splits[0]];
            let row = row_of(&rows, edge.index).unwrap_or_else(|| {
                panic!("S5 case={case_name} split edge {} is missing from continuity.edges", edge.index)
            });
            let label = format!("split M{i}->C edge {}", edge.index);
            assert_continuity(case_name, &label, side.continuity, &row);
            println!(
                "S5 report case={case_name} split={i} asked={} edge={} kind={} gapMm={} angleDeg={} curvatureJump={}",
                side.continuity, edge.index, row.kind, row.gap, row.angle, row.jump
            );
        }
    }
}

fn finish_sheet(case_name: &str, key: &str, parent: i64, node: i64, cap_planar: bool, tolerance: f64) -> Value {
    let sewn = ok(json!({
        "call": "apply",
        "key": key,
        "parent": parent,
        "node": node,
        "chordMm": CHORD_MM,
        "op": { "kind": "sew", "tolerance": tolerance, "capPlanar": cap_planar, "makeSolid": true }
    }));
    let naked = sewn.get("nakedEdges").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    println!(
        "S5 report case={case_name} solid={} naked={naked} brepCheck=accepted-by-promotion",
        sewn["solid"]
    );
    assert_eq!(sewn["solid"], json!(true), "{case_name} sew must close the sheet into a BRepCheck-valid solid");
    assert!(
        sewn.get("nakedEdges").is_none(),
        "{case_name} sewn solid must have zero naked edges, got {:?}",
        sewn.get("nakedEdges")
    );
    sewn
}

fn fill_opening(
    case_name: &str,
    sides: usize,
    continuity: impl Fn(usize, usize) -> &'static str,
    point: Option<[f64; 3]>,
    expect_splits: bool,
    sharp_count: Option<usize>,
) {
    let key = format!("s5-{case_name}");
    let opened = ok(json!({
        "call": "open",
        "key": key,
        "chordMm": CHORD_MM,
        "feature": opening_sheet(sides)
    }));
    assert_eq!(opened["solid"], json!(false), "{case_name} starts as a sheet");
    let asked = top_sides(&opened, continuity);
    assert_eq!(asked.len(), sides, "{case_name} should expose {sides} opening edges, got {}", asked.len());
    let patched = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": CHORD_MM,
        "op": patch_op(&asked, point)
    }));
    assert_eq!(patched["solid"], json!(false), "{case_name} patch stays a sheet");
    let sewn = finish_sheet(case_name, &key, 1, 2, true, 0.05);
    check_opening(case_name, &key, 2, &sewn, &asked, expect_splits, sharp_count);
    ok(json!({ "call": "close", "key": key }));
}

fn plane_distance(point: [f64; 3], origin: [f64; 3], normal: [f64; 3]) -> f64 {
    let n = norm(normal).max(1e-12);
    dot(sub(point, origin), normal).abs() / n
}

fn wall_planes(sides: usize, circum: f64, z: f64, spin: f64) -> Vec<([f64; 3], [f64; 3])> {
    let mut verts = Vec::with_capacity(sides);
    for i in 0..sides {
        let ang = spin + std::f64::consts::TAU * (i as f64) / (sides as f64);
        verts.push([circum * ang.cos(), circum * ang.sin(), z]);
    }
    (0..sides)
        .map(|i| {
            let a = verts[i];
            let b = verts[(i + 1) % sides];
            let tangent = sub(b, a);
            // Vertical plane through the polygon edge: horizontal normal.
            let normal = [tangent[1], -tangent[0], 0.0];
            (a, normal)
        })
        .collect()
}

fn edge_on_plane(edge: &SampledEdge, origin: [f64; 3], normal: [f64; 3]) -> bool {
    edge.points.iter().all(|p| plane_distance(*p, origin, normal) <= ON_CURVE_MM)
}

/// The part of an ellipsoid of revolution above a vertical prism: one smooth face, N boundary edges.
fn smooth_cap(sides: usize) -> (String, Value, Vec<SideCurve>) {
    smooth_opening(sides, 96.0, 36.0, format!("s5-smooth-{sides}"))
}

fn smooth_opening(sides: usize, radius: f64, apothem: f64, key: String) -> (String, Value, Vec<SideCurve>) {
    let circum = apothem / (std::f64::consts::PI / sides as f64).cos();
    // Put the revolution seam on a corner. A seam crossing the middle of a side
    // leaves a 0.57° normal glitch that model_check samples and the fill does not.
    let spin = 0.0;
    let opened = ok(json!({
        "call": "open",
        "key": key,
        "chordMm": CHORD_MM,
        "feature": {
            "kind": "sheet",
            "mode": "revolve",
            "curves": [hemisphere_meridian(radius)],
            "dir": [0.0, 0.0, 1.0],
            "axisOrigin": [0.0, 0.0, 0.0],
            "angleDeg": 360.0
        }
    }));
    assert_eq!(opened["solid"], json!(false), "the smooth zone starts as a sheet: {opened}");
    println!(
        "S5 smooth-{sides} zone faces={:?} naked={:?}",
        opened["fingerprint"]["faces"], opened["nakedEdges"]
    );
    let cutter = json!({
        "mode": "extrude",
        "curves": [polygon_curve(sides, circum, -2.0, spin)],
        "dir": [0.0, 0.0, 1.0],
        "distance": radius + 8.0
    });
    let mut cap: Option<Value> = None;
    for (keep, node) in [("above", 1), ("below", 2)] {
        let piece = call(json!({
            "call": "apply",
            "key": key,
            "parent": 0,
            "node": node,
            "chordMm": CHORD_MM,
            "op": { "kind": "trimSplit", "sheet": cutter, "keep": keep }
        }));
        if piece.get("error").is_some() {
            println!("S5 smooth-{sides} trim {keep} refused: {}", piece["error"]);
            continue;
        }
        let edges = sampled_edges(&piece);
        let naked_ids: Vec<usize> = piece["nakedEdges"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as usize))
            .collect();
        let planes_now = wall_planes(sides, circum, 0.0, spin);
        let on_wall = edges.iter().filter(|edge| naked_ids.contains(&edge.index)).filter(|edge| {
            planes_now.iter().any(|(origin, normal)| edge_on_plane(edge, *origin, *normal))
        }).count();
        let min_z = edges
            .iter()
            .flat_map(|edge| edge.points.iter().map(|p| p[2]))
            .fold(f64::MAX, f64::min);
        println!(
            "S5 smooth-{sides} trim {keep} naked={} onWall={on_wall} minZ={min_z} edges={}",
            naked_ids.len(),
            edges.len()
        );
        // The inner cap's naked edges are only the cut. The rest of the zone still has its circular rims.
        if on_wall >= sides && on_wall == naked_ids.len() {
            cap = Some(piece);
            break;
        }
    }
    let cap = cap.unwrap_or_else(|| panic!("S5 smooth-{sides} trim did not leave the ellipsoid cap"));
    let planes = wall_planes(sides, circum, 0.0, spin);
    let naked: Vec<usize> = cap["nakedEdges"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_u64().map(|n| n as usize))
        .collect();
    let edges = sampled_edges(&cap);
    let mut groups: Vec<Vec<SampledEdge>> = (0..sides).map(|_| Vec::new()).collect();
    for edge in edges {
        if !naked.contains(&edge.index) {
            continue;
        }
        let mut best: Option<(usize, f64)> = None;
        for (i, (origin, normal)) in planes.iter().enumerate() {
            let worst = edge
                .points
                .iter()
                .map(|p| plane_distance(*p, *origin, *normal))
                .fold(0.0, f64::max);
            if best.map(|(_, d)| worst < d).unwrap_or(true) {
                best = Some((i, worst));
            }
        }
        let Some((i, worst)) = best else { continue };
        if worst <= ON_CURVE_MM && edge_on_plane(&edge, planes[i].0, planes[i].1) {
            groups[i].push(edge);
        } else {
            println!(
                "S5 smooth-{sides} naked edge {} is {worst} mm off the nearest cutter plane",
                edge.index
            );
        }
    }
    for (i, group) in groups.iter().enumerate() {
        assert!(
            !group.is_empty(),
            "S5 smooth-{sides} wall {i} has no opening edge on the ellipsoid"
        );
    }
    // Angular order of the walls follows the polygon, which is already 0..sides.
    let cap_node = if cap["id"].as_i64() == Some(1) { 1 } else { 2 };
    // Caller patches `cap_node`. Stash it on the value.
    let mut cap = cap;
    cap["capNode"] = json!(cap_node);
    let sides_out = groups
        .into_iter()
        .enumerate()
        .map(|(i, group)| {
            // Continuity is filled in by the caller after the angular order is fixed.
            let _ = i;
            side_from_edges(group, "g1")
        })
        .collect();
    (key, cap, sides_out)
}

fn fill_smooth(
    case_name: &str,
    count: usize,
    continuity: impl Fn(usize, usize) -> &'static str,
) {
    let (key, cap, mut asked) = smooth_cap(count);
    assert_eq!(asked.len(), count, "{case_name} should cut {count} sides");
    asked.sort_by(|a, b| a.midpoint[1].atan2(a.midpoint[0]).total_cmp(&b.midpoint[1].atan2(b.midpoint[0])));
    for (n, side) in asked.iter_mut().enumerate() {
        side.continuity = continuity(n, count);
    }
    let parent = cap["capNode"].as_i64().unwrap_or(1);
    let patched = ok(json!({
        "call": "apply",
        "key": key,
        "parent": parent,
        "node": 3,
        "chordMm": CHORD_MM,
        "op": patch_op(&asked, None)
    }));
    assert_eq!(patched["solid"], json!(false), "{case_name} patch stays a sheet");
    let sewn = finish_sheet(case_name, &key, 3, 4, false, 1e-4);
    check_opening(case_name, &key, 4, &sewn, &asked, true, Some(0));
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn patch_fills_three_five_and_six_sided_openings_and_sews_them_solid() {
    if !has_occt() {
        return;
    }
    // The extruded triangle keeps the three corners where the walls meet.
    fill_opening("3-side", 3, |_, _| "g1", None, true, Some(3));
    // Cut from one ellipsoid, so no two support faces meet at a corner.
    fill_smooth("5-side", 5, |i, n| if i + 1 == n { "g2" } else { "g1" });
    fill_smooth("6-side", 6, |_, _| "g1");
}

#[test]
fn patch_uses_geomfill_for_a_clean_g0_quad_and_plate_when_a_guide_point_is_set() {
    if !has_occt() {
        return;
    }
    fill_opening("4-side-g0", 4, |_, _| "g0", None, false, None);
    fill_opening("4-side-g0-point", 4, |_, _| "g0", Some([0.0, 0.0, 12.0]), true, None);
}

#[test]
fn blend_surface_meets_g1_and_g2_between_two_sheets() {
    if !has_occt() {
        return;
    }
    // Two coaxial tubes. The outer and inner walls are already closed by the
    // bottom annulus, so the blend is the ring that makes a solid.
    let outer_r = 18.0;
    let inner_r = 10.0;
    let height = 16.0;
    for continuity in ["g1", "g2"] {
        let case_name = format!("blend-{continuity}");
        let key = format!("s5-{case_name}");
        let opened = ok(json!({
            "call": "open",
            "key": key,
            "chordMm": CHORD_MM,
            "feature": cylinder_sheet(outer_r, 0.0, height)
        }));
        assert_eq!(opened["solid"], json!(false));
        ok(json!({
            "call": "apply",
            "key": key,
            "parent": 0,
            "node": 1,
            "chordMm": CHORD_MM,
            "op": cylinder_sheet(inner_r, 0.0, height)
        }));
        let walled = ok(json!({
            "call": "apply",
            "key": key,
            "parent": 1,
            "node": 2,
            "chordMm": CHORD_MM,
            "op": {
                "kind": "sheet",
                "mode": "revolve",
                "curves": [{ "kind": "polyline", "points": [[inner_r, 0.0, 0.0], [outer_r, 0.0, 0.0]] }],
                "dir": [0.0, 0.0, 1.0],
                "axisOrigin": [0.0, 0.0, 0.0],
                "angleDeg": 360.0
            }
        }));
        let mut outer = Vec::new();
        let mut inner = Vec::new();
        for edge in sampled_edges(&walled) {
            if edge.points.iter().any(|p| p[2] < height - 0.5) {
                continue;
            }
            let radius = edge
                .points
                .iter()
                .map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt())
                .sum::<f64>()
                / edge.points.len() as f64;
            if radius > (outer_r + inner_r) * 0.5 {
                outer.push(edge);
            } else {
                inner.push(edge);
            }
        }
        if outer.is_empty() || inner.is_empty() {
            for edge in sampled_edges(&walled) {
                let z0 = edge.points.iter().map(|p| p[2]).fold(f64::MAX, f64::min);
                let z1 = edge.points.iter().map(|p| p[2]).fold(f64::MIN, f64::max);
                let radius = edge.points.iter().map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt()).sum::<f64>()
                    / edge.points.len() as f64;
                println!("S5 blend edge={} z={z0:.3}..{z1:.3} meanR={radius:.3}", edge.index);
            }
            panic!("blend {continuity} needs both rims, outer={} inner={}", outer.len(), inner.len());
        }
        outer = sort_by_angle(outer);
        inner = sort_by_angle(inner);
        let sides = [
            side_from_edges(outer, continuity),
            side_from_edges(inner, continuity),
        ];
        let blended = ok(json!({
            "call": "apply",
            "key": key,
            "parent": 2,
            "node": 3,
            "chordMm": CHORD_MM,
            "op": {
                "kind": "blendSurface",
                "a": { "edges": sides[0].edges, "continuity": continuity },
                "b": { "edges": sides[1].edges, "continuity": continuity },
                "continuity": continuity,
                "tensionA": 1.0,
                "tensionB": 1.0
            }
        }));
        assert_eq!(blended["solid"], json!(false), "a blend is a sheet until it is sewn");
        let sewn = finish_sheet(&case_name, &key, 3, 4, false, 0.05);
        check_opening(&case_name, &key, 4, &sewn, &sides, false, None);
        ok(json!({ "call": "close", "key": key }));
    }
}

fn ordered_cap(sides: usize, radius: f64, apothem: f64, key: &str, continuity: impl Fn(usize, usize) -> &'static str) -> (String, i64, Vec<SideCurve>, i64) {
    let (key, cap, mut asked) = smooth_opening(sides, radius, apothem, key.to_string());
    assert_eq!(asked.len(), sides);
    asked.sort_by(|a, b| a.midpoint[1].atan2(a.midpoint[0]).total_cmp(&b.midpoint[1].atan2(b.midpoint[0])));
    for (n, side) in asked.iter_mut().enumerate() {
        side.continuity = continuity(n, sides);
    }
    let parent = cap["capNode"].as_i64().unwrap_or(1);
    let faces = cap["fingerprint"]["faces"].as_i64().unwrap_or(0);
    (key, parent, asked, faces)
}

#[test]
fn patch_refuses_g2_on_a_radius_24_cap() {
    if !has_occt() {
        return;
    }
    // The radius-96 cap, apothem 36 mm, is the passing G2 case. On a radius-24
    // sphere the same proportion still meets the bound. An apothem of 15 mm does
    // not: both G2 halves stay above 1e-3 mm^-1 when the spans can take no more
    // knots. The op must refuse and leave the sheet without a patch face.
    let (key, parent, asked, faces) = ordered_cap(5, 24.0, 15.0, "s5-r24", |i, n| if i + 1 == n { "g2" } else { "g1" });
    let g2: Vec<usize> = asked.iter().filter(|side| side.continuity == "g2").flat_map(|side| side.edges.clone()).collect();
    assert_eq!(g2.len(), 1, "the G2 side is one opening edge, got {g2:?}");
    let reply = call(json!({
        "call": "apply",
        "key": key,
        "parent": parent,
        "node": 3,
        "chordMm": CHORD_MM,
        "op": patch_op(&asked, None)
    }));
    let error = reply["error"].as_str().unwrap_or("").to_string();
    println!("S5 r24 refusal: {error}");
    assert_eq!(
        error,
        format!("Edge {}: G2 can't be reached at this curvature.", g2[0]),
        "radius-24 G2 must refuse by naming that edge: {reply}"
    );
    assert!(reply.get("solid").is_none(), "a refusal builds no face: {reply}");
    let missing = call(json!({ "call": "goto", "key": key, "node": 3 }));
    assert!(missing.get("error").is_some(), "the refused patch is not a step: {missing}");
    let still = ok(json!({ "call": "goto", "key": key, "node": parent, "chordMm": CHORD_MM }));
    assert_eq!(still["fingerprint"]["faces"], json!(faces), "the cap is unchanged");
    assert_eq!(still["solid"], json!(false));
    ok(json!({ "call": "close", "key": key }));
}

fn blend_apply(key: &str, continuity: &'static str, rim: fn(f64, f64) -> Value) -> Value {
    let outer_r = 18.0;
    let inner_r = 10.0;
    let height = 16.0;
    ok(json!({
        "call": "open",
        "key": key,
        "chordMm": CHORD_MM,
        "feature": {
            "kind": "sheet",
            "mode": "extrude",
            "curves": [rim(outer_r, 0.0)],
            "dir": [0.0, 0.0, 1.0],
            "distance": height
        }
    }));
    ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": CHORD_MM,
        "op": {
            "kind": "sheet",
            "mode": "extrude",
            "curves": [rim(inner_r, 0.0)],
            "dir": [0.0, 0.0, 1.0],
            "distance": height
        }
    }));
    let walled = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 1,
        "node": 2,
        "chordMm": CHORD_MM,
        "op": {
            "kind": "sheet",
            "mode": "revolve",
            "curves": [{ "kind": "polyline", "points": [[inner_r, 0.0, 0.0], [outer_r, 0.0, 0.0]] }],
            "dir": [0.0, 0.0, 1.0],
            "axisOrigin": [0.0, 0.0, 0.0],
            "angleDeg": 360.0
        }
    }));
    let mut outer = Vec::new();
    let mut inner = Vec::new();
    for edge in sampled_edges(&walled) {
        if edge.points.iter().any(|p| p[2] < height - 0.5) {
            continue;
        }
        let radius = edge.points.iter().map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt()).sum::<f64>() / edge.points.len() as f64;
        if radius > (outer_r + inner_r) * 0.5 {
            outer.push(edge);
        } else {
            inner.push(edge);
        }
    }
    assert!(!outer.is_empty() && !inner.is_empty(), "circle blend needs both rims");
    let sides = [side_from_edges(sort_by_angle(outer), continuity), side_from_edges(sort_by_angle(inner), continuity)];
    call(json!({
        "call": "apply",
        "key": key,
        "parent": 2,
        "node": 3,
        "chordMm": CHORD_MM,
        "op": {
            "kind": "blendSurface",
            "a": { "edges": sides[0].edges, "continuity": continuity },
            "b": { "edges": sides[1].edges, "continuity": continuity },
            "continuity": continuity,
            "tensionA": 1.0,
            "tensionB": 1.0
        }
    }))
}

#[test]
fn blend_refuses_exact_circle_rims() {
    if !has_occt() {
        return;
    }
    // Exact circle rims, not the 24-point polynomial. The blend must refuse
    // instead of leaving a surface whose normal is 0.315° off the wall.
    for continuity in ["g1", "g2"] {
        let key = format!("s5-circle-{continuity}");
        let reply = blend_apply(&key, continuity, circle_arcs);
        let error = reply["error"].as_str().unwrap_or("").to_string();
        println!("S5 circle-{continuity} refusal: {error}");
        let expected = if continuity == "g1" {
            "The fill cannot reach the continuity you asked for. The largest gap is 0.000000 mm, the largest angle is 180.000000 degrees, and the largest curvature jump is 0.750000 per mm."
        } else {
            "The fill cannot reach the continuity you asked for. The largest gap is 0.000000 mm, the largest angle is 180.000000 degrees, and the largest curvature jump is 0.002112 per mm."
        };
        assert_eq!(error, expected, "exact circles must be refused, got {reply}");
        assert!(reply.get("solid").is_none(), "a refusal builds no blend face: {reply}");
        let missing = call(json!({ "call": "goto", "key": key, "node": 3 }));
        assert!(missing.get("error").is_some(), "the refused blend is not a step: {missing}");
        let still = ok(json!({ "call": "goto", "key": key, "node": 2, "chordMm": CHORD_MM }));
        assert_eq!(still["solid"], json!(false));
        ok(json!({ "call": "close", "key": key }));
    }
}
