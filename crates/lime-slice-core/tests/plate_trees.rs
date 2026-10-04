//! Two objects whose trees meet in the gap between them. One test, because
//! the kept slices are shared by the whole process.

use base64::Engine;
use lime_slice_core::{keep_support_bases, slice_payload, Job};
use serde_json::{json, Value};

const LEDGE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../samples/overhang_ledge.stl"
);

const ALL: [&str; 6] = [
    "contours",
    "toolpaths",
    "order",
    "comb",
    "supports",
    "supportPaths",
];

/// A binary STL of boxes, each `[x0, y0, z0, x1, y1, z1]`.
fn boxes_stl(boxes: &[[f32; 6]]) -> Vec<u8> {
    let mut out = vec![0u8; 80];
    out.extend(((boxes.len() * 12) as u32).to_le_bytes());
    for &[x0, y0, z0, x1, y1, z1] in boxes {
        let v = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        let faces = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
        ];
        for f in faces {
            out.extend([0u8; 12]);
            for i in f {
                for c in v[i] {
                    out.extend(c.to_le_bytes());
                }
            }
            out.extend([0u8; 2]);
        }
    }
    out
}

fn object(id: &str, bytes: Vec<u8>, pose: Value) -> Value {
    json!({
        "id": id,
        "filename": format!("{id}.stl"),
        "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "pose": pose,
    })
}

/// The ledge, its shelf over bed X 100 to 124 and Y 102 to 118 at Z 12, and
/// a low ledge turned half round whose 8 mm wide shelf at Z 6 sits under it,
/// centred at `by`. The ledge's trees come down beside the low shelf, where
/// the low ledge's own trees stand.
fn plate(by: f64) -> Value {
    let ledge = std::fs::read(LEDGE).unwrap();
    let low = boxes_stl(&[[0., 0., 0., 24., 24., 6.], [24., 8., 6., 48., 16., 8.]]);
    json!({
        "blend": {"mode": "single", "strategy": "toughness"},
        "supports": true,
        "supportStyle": "tree",
        "includeGcode": true,
        "includePreview": true,
        "baseline": false,
        "objects": [
            object("a", ledge, json!({"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "pivot": [24, 12, 8], "translation": [100, 110, 8]})),
            object("b", low, json!({"rotation": [-1, 0, 0, 0, -1, 0, 0, 0, 1], "pivot": [24, 12, 4], "translation": [124, by, 4]})),
        ],
    })
}
fn slice(req: &Value) -> Value {
    let reply = slice_payload(&req.to_string(), None, Job::default(), |g| g.text()).unwrap();
    serde_json::from_str(&reply).unwrap()
}

fn reused(reply: &Value, object: usize) -> Vec<&str> {
    reply["objects"][object]["reused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

type Segment = ([f64; 2], [f64; 2], f64);

fn seg_dist(a: &Segment, b: &Segment) -> f64 {
    let point_seg = |p: [f64; 2], s: &Segment| {
        let (u, v) = (s.0, s.1);
        let d = [v[0] - u[0], v[1] - u[1]];
        let len2 = d[0] * d[0] + d[1] * d[1];
        let t = if len2 > 0.0 {
            (((p[0] - u[0]) * d[0] + (p[1] - u[1]) * d[1]) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (p[0] - u[0] - t * d[0]).hypot(p[1] - u[1] - t * d[1])
    };
    let cross = |o: [f64; 2], p: [f64; 2], q: [f64; 2]| {
        (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    };
    let crosses = cross(a.0, a.1, b.0).signum() != cross(a.0, a.1, b.1).signum()
        && cross(b.0, b.1, a.0).signum() != cross(b.0, b.1, a.1).signum();
    if crosses {
        return 0.0;
    }
    [
        point_seg(a.0, b),
        point_seg(a.1, b),
        point_seg(b.0, a),
        point_seg(b.1, a),
    ]
    .into_iter()
    .fold(f64::INFINITY, f64::min)
}

/// Pairs of support beads from the two objects that overlap on one layer:
/// their centre lines closer than the sum of their half widths, less a hair.
fn shared_support(reply: &Value) -> usize {
    let offsets: Vec<[f64; 2]> = reply["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            [
                o["offset"][0].as_f64().unwrap(),
                o["offset"][1].as_f64().unwrap(),
            ]
        })
        .collect();
    let mut overlaps = 0;
    for layer in reply["layers"].as_array().unwrap() {
        let cols = &layer["paths"];
        let kinds = cols["kinds"].as_array().unwrap();
        let start = cols["start"].as_array().unwrap();
        let xy = cols["xy"].as_array().unwrap();
        let mut by_object: [Vec<Segment>; 2] = [Vec::new(), Vec::new()];
        for (i, kind) in cols["kind"].as_array().unwrap().iter().enumerate() {
            let name = kinds[kind.as_u64().unwrap() as usize].as_str().unwrap();
            if !name.starts_with("support") {
                continue;
            }
            let o = cols["object"].get(i).and_then(Value::as_u64).unwrap_or(0) as usize;
            let w = cols["width"][i].as_f64().unwrap();
            let (a, b) = (
                start[i].as_u64().unwrap() as usize,
                start[i + 1].as_u64().unwrap() as usize,
            );
            let p = |k: usize| {
                [
                    xy[2 * k].as_f64().unwrap() + offsets[o][0],
                    xy[2 * k + 1].as_f64().unwrap() + offsets[o][1],
                ]
            };
            for k in a..b.saturating_sub(1) {
                by_object[o].push((p(k), p(k + 1), w));
            }
        }
        for sa in &by_object[0] {
            for sb in &by_object[1] {
                if seg_dist(sa, sb) < (sa.2 + sb.2) * 0.5 - 0.02 {
                    overlaps += 1;
                }
            }
        }
    }
    overlaps
}

#[test]
fn trees_of_two_objects_never_print_in_the_same_place() {
    keep_support_bases(true);
    let near = slice(&plate(110.0));
    let far = slice(&plate(190.0));
    let farther = slice(&plate(200.0));
    keep_support_bases(false);
    let cold_near = slice(&plate(110.0));

    assert_eq!(shared_support(&near), 0, "no shared support beads");
    assert_eq!(near["gcode"], cold_near["gcode"], "kept equals cold");
    assert_eq!(reused(&farther, 0), ALL, "a far move reuses all of a");
    assert_eq!(reused(&farther, 1), ALL, "a far move reuses all of b");
    assert_eq!(far["collisions"], json!([]));
}
