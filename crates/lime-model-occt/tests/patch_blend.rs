//! Organic surfaces S5: a G0 patch.
//! A boundary of 2 to 4 sides at G0 uses GeomFill and sews into a solid.
//! The G1, G2, N-sided, and BlendSurface acceptance tests are unchanged at c184c54b.

use base64::Engine;
use serde_json::{json, Value};

/// GeomPlate is aimed at Tol3d 1e-5 mm, TolAng 0.001 rad (about 0.057°), and TolCurv 0.02 mm^-1.
/// The G2 acceptance bound is 0.05 mm^-1: half of Open CASCADE's default TolCurv (0.1),
/// the same as mistaking a flat for a 20 mm radius. The G0 and G1 bounds are the plan's.
const G0_GAP_MM: f64 = 1e-4;
const G1_ANGLE_DEG: f64 = 0.1;
const G2_JUMP: f64 = 0.05;

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
    points: Vec<[f32; 3]>,
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
            row.push([points[at], points[at + 1], points[at + 2]]);
            at += 3;
        }
        if !row.is_empty() {
            edges.push(SampledEdge { index, points: row });
        }
    }
    edges
}

fn midpoint(edge: &SampledEdge) -> [f64; 3] {
    let n = edge.points.len() as f64;
    let sum = edge.points.iter().fold([0.0, 0.0, 0.0], |acc, p| {
        [acc[0] + p[0] as f64, acc[1] + p[1] as f64, acc[2] + p[2] as f64]
    });
    [sum[0] / n, sum[1] / n, sum[2] / n]
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

struct AskedEdge {
    index: usize,
    mid: [f64; 3],
    continuity: &'static str,
}

fn top_edges(opened: &Value, continuity: impl Fn(usize, usize) -> &'static str) -> Vec<AskedEdge> {
    let mut top: Vec<AskedEdge> = sampled_edges(opened)
        .into_iter()
        .filter(|edge| edge.points.iter().all(|p| p[2] > 11.0))
        .map(|edge| AskedEdge {
            index: edge.index,
            mid: midpoint(&edge),
            continuity: "g1",
        })
        .collect();
    top.sort_by(|a, b| a.mid[1].atan2(a.mid[0]).total_cmp(&b.mid[1].atan2(b.mid[0])));
    let count = top.len();
    for (i, edge) in top.iter_mut().enumerate() {
        edge.continuity = continuity(i, count);
    }
    top
}

fn patch_op(edges: &[AskedEdge], points: Option<[f64; 3]>) -> Value {
    let boundaries: Vec<Value> = edges
        .iter()
        .map(|edge| json!({ "edges": [edge.index], "continuity": edge.continuity }))
        .collect();
    let mut op = json!({ "kind": "patch", "boundaries": boundaries });
    if let Some(point) = points {
        op["points"] = json!([point]);
    }
    op
}

fn check_sewn(case_name: &str, key: &str, node: i64, asked: &[AskedEdge]) {
    let inspect = ok(json!({
        "call": "surfaceInspect",
        "key": key,
        "node": node,
        "chordMm": 0.05,
        "curvature": false,
        "isoparms": false
    }));
    let rows = inspect["continuity"]["edges"].as_array().cloned().unwrap_or_default();
    println!("S5 case={case_name} sharedEdges={} listed={}", inspect["continuity"]["sharedEdges"], rows.len());
    for edge in asked {
        let row = rows.iter().min_by(|left, right| {
            let dl = dist2(mid_of(left), edge.mid);
            let dr = dist2(mid_of(right), edge.mid);
            dl.total_cmp(&dr)
        });
        let Some(row) = row else {
            panic!("S5 case={case_name} listed no shared edges");
        };
        let gap = row["gapMm"].as_f64().unwrap_or(99.0);
        let angle = row["angleDeg"].as_f64().unwrap_or(99.0);
        let jump = row["curvatureJump"].as_f64().unwrap_or(99.0);
        let near = dist2(mid_of(row), edge.mid).sqrt();
        println!(
            "S5 case={case_name} edge={} asked={} gapMm={gap} angleDeg={angle} curvatureJump={jump} matchMm={near}",
            edge.index, edge.continuity
        );
        assert!(near < 2.0, "S5 case={case_name} edge {} matched a seam {near} mm away: {row}", edge.index);
        assert!(gap < G0_GAP_MM, "S5 case={case_name} G0 gap {gap} mm is not under {G0_GAP_MM}");
        if edge.continuity == "g1" || edge.continuity == "g2" {
            assert!(angle < G1_ANGLE_DEG, "S5 case={case_name} G1 angle {angle}° is not under {G1_ANGLE_DEG}");
        }
        if edge.continuity == "g2" {
            assert!(jump < G2_JUMP, "S5 case={case_name} G2 curvature jump {jump} mm^-1 is not under {G2_JUMP}");
        }
    }
}

fn mid_of(row: &Value) -> [f64; 3] {
    let mid = row["mid"].as_array().cloned().unwrap_or_default();
    [
        mid.first().and_then(|v| v.as_f64()).unwrap_or(0.0),
        mid.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
        mid.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0),
    ]
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

fn fill_opening(case_name: &str, sides: usize, continuity: impl Fn(usize, usize) -> &'static str, point: Option<[f64; 3]>) {
    let key = format!("s5-{case_name}");
    let opened = ok(json!({
        "call": "open",
        "key": key,
        "chordMm": 0.05,
        "feature": opening_sheet(sides)
    }));
    assert_eq!(opened["solid"], json!(false), "{case_name} starts as a sheet");
    let asked = top_edges(&opened, continuity);
    assert_eq!(asked.len(), sides, "{case_name} should expose {sides} opening edges, got {}", asked.len());
    let patched = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 0,
        "node": 1,
        "chordMm": 0.05,
        "op": patch_op(&asked, point)
    }));
    assert_eq!(patched["solid"], json!(false), "{case_name} patch stays a sheet");
    let sewn = ok(json!({
        "call": "apply",
        "key": key,
        "parent": 1,
        "node": 2,
        "chordMm": 0.05,
        "op": { "kind": "sew", "tolerance": 0.05, "capPlanar": true, "makeSolid": true }
    }));
    assert_eq!(sewn["solid"], json!(true), "{case_name} sew must close the sheet");
    assert!(sewn.get("nakedEdges").is_none(), "{case_name} sewn solid must have zero naked edges, got {:?}", sewn.get("nakedEdges"));
    println!("S5 case={case_name} solid=true naked=0 brepCheck=accepted-by-promotion");
    check_sewn(case_name, &key, 2, &asked);
    ok(json!({ "call": "close", "key": key }));
}

#[test]
fn patch_uses_geomfill_for_a_clean_g0_quad() {
    if !has_occt() {
        return;
    }
    fill_opening("4-side-g0", 4, |_, _| "g0", None);
}
