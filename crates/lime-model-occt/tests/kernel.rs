//! The kernel's answers through the history tree: a 10×20×30 box's faces, edges and distances,
//! its binary mesh decoded back to its triangulation, each boolean and primitive, split, fillet,
//! chamfer, hole and scale with their refusals, STEP export, and the bridge loaded with dlopen.
//! `LIME_REQUIRE_OCCT=1` makes a missing kernel a failure.
//!
//! The kernel's work counters are process-wide, so everything runs in one test, in order.

use std::f64::consts::{PI, SQRT_2};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};

fn require() -> bool {
    std::env::var_os("LIME_REQUIRE_OCCT").is_some()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn call(request: Value) -> Value {
    parse(&lime_model_occt::tree(&request.to_string()))
}

fn ok(request: Value) -> Value {
    let reply = call(request.clone());
    assert!(reply.get("error").is_none(), "{request} -> {reply}");
    reply
}

/// Apply `op` on the root of `key` as node `node`.
fn apply(key: &str, node: u32, op: Value) -> Value {
    call(json!({ "call": "apply", "key": key, "parent": 0, "node": node, "op": op }))
}

fn probe(key: &str, op: Value) -> Value {
    call(json!({ "call": "probe", "key": key, "node": 0, "op": op }))
}

fn refused(reply: &Value, message: &str) {
    assert_eq!(reply, &json!({ "error": message }));
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn volume(reply: &Value) -> f64 {
    assert!(reply.get("error").is_none(), "{reply}");
    reply["volumeMm3"].as_f64().expect("volumeMm3")
}

#[derive(Debug, PartialEq)]
struct Work {
    builds: i64,
    volumes: i64,
    tessellations: i64,
}

fn work(builds: i64, volumes: i64, tessellations: i64) -> Work {
    Work {
        builds,
        volumes,
        tessellations,
    }
}

fn counts() -> Work {
    let json = parse(&lime_model_occt::stats());
    let read = |key: &str| {
        json[key]
            .as_i64()
            .unwrap_or_else(|| panic!("{key} in {json}"))
    };
    work(read("builds"), read("volumes"), read("tessellations"))
}

/// Run `step` and return what it cost the kernel.
fn cost<T>(step: impl FnOnce() -> T) -> (T, Work) {
    let before = counts();
    let out = step();
    let after = counts();
    (
        out,
        work(
            after.builds - before.builds,
            after.volumes - before.volumes,
            after.tessellations - before.tessellations,
        ),
    )
}

fn boolean(op: &str, primitive: &str, origin: [f64; 3]) -> Value {
    json!({ "kind": "boolean", "op": op, "primitive": primitive, "origin": origin })
}

fn cube(op: &str, origin: [f64; 3], size: [f64; 3]) -> Value {
    let mut tool = boolean(op, "box", origin);
    tool["size"] = json!(size);
    tool
}

fn split_at(origin: [f64; 3]) -> Value {
    json!({ "kind": "split", "origin": origin, "normal": [0.0, 0.0, 1.0] })
}

fn blend(kind: &str, edges: Value, size: f64) -> Value {
    json!({ "kind": kind, "edges": edges, "size": size })
}

fn hole(origin: [f64; 3], radius: f64, depth: f64) -> Value {
    json!({ "kind": "hole", "origin": origin, "radius": radius, "depth": depth })
}

/// A solid reply's arrays, decoded from base64 of little-endian words as the client decodes them.
struct Mesh {
    positions: Vec<f32>,
    triangles: Vec<u32>,
    edge_points: Vec<f32>,
    edge_offsets: Vec<u32>,
}

fn words(reply: &Value, name: &str) -> Vec<[u8; 4]> {
    let text = reply[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is not base64 text"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap_or_else(|err| panic!("{name}: {err}"));
    assert_eq!(bytes.len() % 4, 0, "{name} is whole words");
    bytes
        .chunks_exact(4)
        .map(|word| word.try_into().expect("four bytes"))
        .collect()
}

fn mesh(reply: &Value) -> Mesh {
    assert_eq!(reply["format"], "lime-solid-2", "{reply}");
    let mesh = Mesh {
        positions: words(reply, "positions")
            .into_iter()
            .map(f32::from_le_bytes)
            .collect(),
        triangles: words(reply, "triangles")
            .into_iter()
            .map(u32::from_le_bytes)
            .collect(),
        edge_points: words(reply, "edgePoints")
            .into_iter()
            .map(f32::from_le_bytes)
            .collect(),
        edge_offsets: words(reply, "edgeOffsets")
            .into_iter()
            .map(u32::from_le_bytes)
            .collect(),
    };
    let faces = reply["faces"].as_array().expect("faces").len() as u32;
    let edges = reply["edgeLengths"].as_array().expect("edgeLengths").len();
    assert_eq!(mesh.positions.len(), mesh.triangles.len() * 9);
    assert!(mesh.triangles.iter().all(|face| *face < faces));
    assert_eq!(mesh.edge_offsets.len(), edges + 1);
    assert_eq!(mesh.edge_offsets[0], 0);
    assert!(mesh
        .edge_offsets
        .windows(2)
        .all(|pair| pair[1] >= pair[0] + 2));
    assert_eq!(
        mesh.edge_points.len(),
        *mesh.edge_offsets.last().unwrap() as usize * 3
    );
    mesh
}

impl Mesh {
    fn corners(&self, triangle: usize) -> [[f64; 3]; 3] {
        let at = |k: usize| {
            let i = triangle * 9 + k * 3;
            [0, 1, 2].map(|axis| f64::from(self.positions[i + axis]))
        };
        [at(0), at(1), at(2)]
    }

    fn edge(&self, edge: usize) -> Vec<[f64; 3]> {
        let from = self.edge_offsets[edge] as usize * 3;
        let to = self.edge_offsets[edge + 1] as usize * 3;
        self.edge_points[from..to]
            .chunks_exact(3)
            .map(|point| [0, 1, 2].map(|axis| f64::from(point[axis])))
            .collect()
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn length(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

#[test]
fn kernel_through_the_tree() {
    let opened = call(json!({ "call": "open", "key": "measure", "box": [10.0, 20.0, 30.0] }));
    if opened.get("error").is_some() {
        assert!(!require(), "OCCT was required: {opened}");
        bridge_exports(false);
        return;
    }
    box_faces_edges_and_distance(&opened);
    ok(json!({ "call": "close", "key": "measure" }));

    let step_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/step_cube.step");
    let step = call(json!({ "call": "open", "key": "cube", "stepPath": step_path }));
    let step_linked = match step["error"].as_str() {
        Some("STEP reader is not linked") if !require() => false,
        Some(err) => panic!("STEP cube was not measured ({err})"),
        None => true,
    };
    if step_linked {
        near(volume(&step), 1000.0);
        assert!(step["faces"].as_array().expect("step faces").len() >= 6);
        let fused = apply("cube", 1, cube("fuse", [10.0, 0.0, 0.0], [10.0; 3]));
        near(volume(&fused), 2000.0);
        ok(json!({ "call": "close", "key": "cube" }));
        assert_shared("TKDESTEP");
    }

    booleans_and_split();
    thin_plate_split();
    blends_holes_and_scale();
    if step_linked {
        step_export_round_trip();
    }
    assert_shared("TKPrim");
    bridge_exports(true);
}

fn box_faces_edges_and_distance(json: &Value) {
    near(volume(json), 6000.0);
    let stats = parse(&lime_model_occt::stats());
    assert!(
        stats["version"].as_str().unwrap_or("").starts_with("7.9"),
        "{stats}"
    );

    let faces = json["faces"].as_array().expect("faces");
    assert_eq!(faces.len(), 6);
    let mut axes = Vec::new();
    for face in faces {
        let normal = face["normal"].as_array().expect("face normal");
        assert_eq!(normal.len(), 3);
        let n: Vec<f64> = normal
            .iter()
            .map(|value| value.as_f64().expect("component"))
            .collect();
        near((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt(), 1.0);
        let dominant = n
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.abs().partial_cmp(&right.1.abs()).unwrap())
            .expect("component")
            .0;
        for (index, value) in n.iter().enumerate() {
            if index != dominant {
                assert!(value.abs() < 0.05, "face normal {n:?}");
            }
        }
        let mut rounded = [0.0, 0.0, 0.0];
        rounded[dominant] = if n[dominant] > 0.0 { 1.0 } else { -1.0 };
        axes.push(rounded);
    }
    axes.sort_by(|left, right| left.partial_cmp(right).unwrap());
    axes.dedup();
    assert_eq!(
        axes,
        vec![
            [-1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ]
    );
    let mut areas: Vec<f64> = faces
        .iter()
        .map(|face| face["areaMm2"].as_f64().expect("area"))
        .collect();
    areas.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (actual, expected) in areas.iter().zip([200.0, 200.0, 300.0, 300.0, 600.0, 600.0]) {
        near(*actual, expected);
    }

    let edges = json["edgeLengths"].as_array().expect("edgeLengths");
    assert_eq!(edges.len(), 12);
    let mut lengths: Vec<f64> = edges
        .iter()
        .map(|edge| edge.as_f64().expect("length"))
        .collect();
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for (actual, expected) in lengths.iter().zip([
        10.0, 10.0, 10.0, 10.0, 20.0, 20.0, 20.0, 20.0, 30.0, 30.0, 30.0, 30.0,
    ]) {
        near(*actual, expected);
    }

    box_mesh_is_its_triangulation(json);

    let mut distances = Vec::new();
    for a in 0..6 {
        for b in (a + 1)..6 {
            let measured = ok(json!({ "call": "distance", "key": "measure", "node": 0,
                "aKind": "face", "aIndex": a, "bKind": "face", "bIndex": b }));
            distances.push(measured["distanceMm"].as_f64().expect("distance"));
        }
    }
    for expected in [10.0, 20.0, 30.0] {
        assert!(
            distances
                .iter()
                .any(|value| (*value - expected).abs() < 0.05),
            "missing {expected} in {distances:?}"
        );
    }
    let off = call(json!({ "call": "distance", "key": "measure", "node": 0,
        "aKind": "face", "aIndex": 0, "bKind": "edge", "bIndex": 12 }));
    refused(&off, "That face or edge is not on this solid");
}

/// The decoded box is two triangles on each face, every corner exactly a corner of the box, each
/// triangle in its face's plane and wound outward, and the triangles cover each face's area. Each
/// edge's polyline runs between two corners along one axis and is as long as the edge.
fn box_mesh_is_its_triangulation(json: &Value) {
    let mesh = mesh(json);
    let size = [10.0, 20.0, 30.0];
    assert_eq!(mesh.triangles.len(), 12);
    for corner in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            let value = f64::from(corner[axis]);
            assert!(value == 0.0 || value == size[axis], "corner {corner:?}");
        }
    }
    let faces = json["faces"].as_array().expect("faces");
    let mut covered = vec![0.0; faces.len()];
    let mut count = vec![0; faces.len()];
    for (triangle, face) in mesh.triangles.iter().enumerate() {
        let face = *face as usize;
        let normal: Vec<f64> = faces[face]["normal"]
            .as_array()
            .expect("normal")
            .iter()
            .map(|value| value.as_f64().expect("component"))
            .collect();
        let normal = [normal[0], normal[1], normal[2]];
        let [a, b, c] = mesh.corners(triangle);
        assert_eq!(
            dot(sub(b, a), normal),
            0.0,
            "triangle {triangle} leaves face {face}"
        );
        assert_eq!(
            dot(sub(c, a), normal),
            0.0,
            "triangle {triangle} leaves face {face}"
        );
        let turn = cross(sub(b, a), sub(c, a));
        assert!(
            dot(turn, normal) > 0.0,
            "triangle {triangle} is wound inward"
        );
        covered[face] += length(turn) / 2.0;
        count[face] += 1;
    }
    assert_eq!(count, vec![2; 6]);
    for (face, area) in covered.iter().enumerate() {
        near(*area, faces[face]["areaMm2"].as_f64().expect("area"));
    }
    let lengths = json["edgeLengths"].as_array().expect("edgeLengths");
    for (edge, expected) in lengths.iter().enumerate() {
        let points = mesh.edge(edge);
        let run: f64 = points
            .windows(2)
            .map(|pair| length(sub(pair[1], pair[0])))
            .sum();
        near(run, expected.as_f64().expect("length"));
        for point in [points[0], *points.last().unwrap()] {
            for axis in 0..3 {
                assert!(
                    point[axis] == 0.0 || point[axis] == size[axis],
                    "edge {edge} ends at {point:?}"
                );
            }
        }
    }
}

/// A box drilled through by a hole of `radius` at (`x`, `y`): every corner and every edge point
/// lies on a wall of the box or on the hole's cylinder, and each face is all one or the other.
fn drilled_mesh_is_its_triangulation(json: &Value, size: f64, x: f64, y: f64, radius: f64) {
    let mesh = mesh(json);
    let wall = |point: [f64; 3]| point.iter().any(|value| *value == 0.0 || *value == size);
    let bore = |point: [f64; 3]| ((point[0] - x).hypot(point[1] - y) - radius).abs() < 1e-4;
    let faces = json["faces"].as_array().expect("faces").len();
    let mut on_bore = vec![true; faces];
    for (triangle, face) in mesh.triangles.iter().enumerate() {
        for corner in mesh.corners(triangle) {
            assert!(
                wall(corner) || bore(corner),
                "corner {corner:?} is off the solid"
            );
            on_bore[*face as usize] &= bore(corner);
        }
    }
    let bored = on_bore.iter().filter(|on| **on).count();
    assert!(bored >= 1, "no face lies on the hole");
    for (triangle, face) in mesh.triangles.iter().enumerate() {
        if !on_bore[*face as usize] {
            let [a, b, c] = mesh.corners(triangle);
            let flat = (0..3).any(|axis| {
                a[axis] == b[axis] && b[axis] == c[axis] && (a[axis] == 0.0 || a[axis] == size)
            });
            assert!(
                flat,
                "triangle {triangle} of face {face} is not on one wall"
            );
        }
    }
    for edge in 0..mesh.edge_offsets.len() - 1 {
        for point in mesh.edge(edge) {
            assert!(
                wall(point) || bore(point),
                "edge {edge} point {point:?} is off the solid"
            );
        }
    }
}

fn booleans_and_split() {
    let opened = ok(json!({ "call": "open", "key": "bool", "box": [10.0, 10.0, 10.0] }));
    near(volume(&opened), 1000.0);

    refused(
        &apply("bool", 1, cube("fuse", [0.0; 3], [0.0, 10.0, 10.0])),
        "A box needs a positive length on each side",
    );
    refused(
        &apply("bool", 1, split_at([0.0, 0.0, 100.0])),
        "The plane did not split this solid",
    );
    let apart = cube("common", [100.0, 0.0, 0.0], [10.0; 3]);
    refused(
        &apply("bool", 1, apart.clone()),
        "The solids do not overlap",
    );
    assert_eq!(
        probe("bool", apart),
        json!({ "ok": false, "error": "The solids do not overlap" })
    );

    let beside = cube("fuse", [10.0, 0.0, 0.0], [10.0; 3]);
    let (probed, probing) = cost(|| probe("bool", beside.clone()));
    assert_eq!(probed, json!({ "ok": true }));
    assert_eq!(
        probing,
        work(1, 1, 0),
        "a probe builds once and integrates its result once"
    );
    let (fused, applying) = cost(|| apply("bool", 1, beside.clone()));
    near(volume(&fused), 2000.0);
    assert_eq!(
        applying,
        work(0, 0, 1),
        "Apply after an equal probe commits the probed shape"
    );

    probe("bool", beside.clone());
    probe("bool", cube("fuse", [5.0, 0.0, 0.0], [10.0; 3]));
    let (again, superseded) = cost(|| apply("bool", 2, beside));
    near(volume(&again), 2000.0);
    assert_eq!(superseded, work(1, 1, 1), "only the newest probe is kept");

    near(
        volume(&apply(
            "bool",
            3,
            cube("cut", [0.0, 0.0, 5.0], [10.0, 10.0, 5.0]),
        )),
        500.0,
    );
    near(
        volume(&apply(
            "bool",
            4,
            cube("common", [0.0; 3], [10.0, 10.0, 5.0]),
        )),
        500.0,
    );
    let mut turned = cube("common", [0.0; 3], [10.0; 3]);
    turned["turn"] = json!([0.0, 0.0, 45.0]);
    near(
        volume(&apply("bool", 5, turned)),
        1000.0 * (2.0 * SQRT_2 - 2.0),
    );

    let mut cylinder = boolean("fuse", "cylinder", [0.0; 3]);
    cylinder["radius"] = json!(5.0);
    cylinder["height"] = json!(10.0);
    near(
        volume(&apply("bool", 6, cylinder)),
        1000.0 + PI * 25.0 * 10.0 * 0.75,
    );
    let mut sphere = boolean("cut", "sphere", [5.0; 3]);
    sphere["radius"] = json!(5.0);
    near(
        volume(&apply("bool", 7, sphere)),
        1000.0 - 4.0 / 3.0 * PI * 125.0,
    );

    let (split, splitting) = cost(|| split_off("bool", 8, [0.0, 0.0, 5.0], "bool-piece"));
    near(volume(&split), 500.0);
    near(volume(&split["other"]), 500.0);
    assert!(!mesh(&split).triangles.is_empty());
    assert!(!mesh(&split["other"]).triangles.is_empty());
    assert_eq!(splitting, work(1, 2, 2), "each piece is integrated once");
    let (unseen, replaying) = cost(|| apply("bool", 9, split_at([0.0, 0.0, 5.0])));
    assert!(
        unseen.get("other").is_none(),
        "a split without otherKey sends no piece"
    );
    assert_eq!(replaying, work(1, 2, 1), "nor tessellates one");
    ok(json!({ "call": "close", "key": "bool" }));
    ok(json!({ "call": "close", "key": "bool-piece" }));
}

/// Split the root of `key` as node `node`, with the piece opened as its own tree under `piece`.
fn split_off(key: &str, node: u32, origin: [f64; 3], piece: &str) -> Value {
    call(
        json!({ "call": "apply", "key": key, "parent": 0, "node": node,
        "op": split_at(origin), "otherKey": piece }),
    )
}

fn span_x(reply: &Value) -> f64 {
    let positions = mesh(reply).positions;
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    for x in positions.iter().step_by(3) {
        min_x = min_x.min(f64::from(*x));
        max_x = max_x.max(f64::from(*x));
    }
    max_x - min_x
}

/// A 220×220×5 plate cut on its top face must not become a 0.1 mm sliver.
fn thin_plate_split() {
    let opened = ok(json!({ "call": "open", "key": "plate", "box": [220.0, 220.0, 5.0] }));
    near(volume(&opened), 242_000.0);
    refused(
        &apply("plate", 1, split_at([0.0, 0.0, 5.0])),
        "The plane is too close to a face. Move it into the part.",
    );
    let mid = split_off("plate", 1, [0.0, 0.0, 2.5], "plate-piece");
    near(volume(&mid), 121_000.0);
    near(volume(&mid["other"]), 121_000.0);
    let kept_span = span_x(&mid);
    let other_span = span_x(&mid["other"]);
    assert!((200.0..230.0).contains(&kept_span), "kept span {kept_span}");
    assert!(
        (200.0..230.0).contains(&other_span),
        "other span {other_span}"
    );
    ok(json!({ "call": "close", "key": "plate" }));
    ok(json!({ "call": "close", "key": "plate-piece" }));
}

fn blends_holes_and_scale() {
    ok(json!({ "call": "open", "key": "edit", "box": [10.0, 10.0, 10.0] }));

    refused(
        &apply("edit", 1, blend("fillet", json!([-1]), 2.0)),
        "Pick an edge to fillet.",
    );
    refused(
        &apply("edit", 1, blend("fillet", json!([]), 2.0)),
        "Pick an edge to fillet.",
    );
    refused(
        &apply("edit", 1, blend("fillet", json!([0]), 0.0)),
        "A fillet needs a positive radius",
    );
    refused(
        &apply("edit", 1, blend("fillet", json!([0]), 11.0)),
        "The fillet did not fit this edge",
    );
    let unpicked = probe("edit", blend("fillet", json!([-1]), 2.0));
    assert_eq!(
        unpicked,
        json!({ "ok": false, "error": "Pick an edge to fillet." })
    );
    let tight = probe("edit", blend("fillet", json!([0]), 11.0));
    assert_eq!(tight["ok"], false, "{tight}");
    let max = tight["maxMm"].as_f64().expect("max fillet");
    assert!(max > 1.0 && max < 11.0, "max fillet {max}");

    let removed = 10.0 * 4.0 * (1.0 - PI / 4.0);
    assert_eq!(
        probe("edit", blend("fillet", json!([0]), 2.0)),
        json!({ "ok": true })
    );
    let (filleted, filleting) = cost(|| apply("edit", 1, blend("fillet", json!([0]), 2.0)));
    near(volume(&filleted), 1000.0 - removed);
    assert_eq!(filleting, work(0, 0, 1), "the apply took the probe's solid");

    refused(
        &apply("edit", 2, blend("chamfer", json!([99]), 1.0)),
        "That edge is not on this solid",
    );
    refused(
        &apply("edit", 2, blend("chamfer", json!([0]), 0.0)),
        "A chamfer needs a positive distance",
    );
    near(
        volume(&apply("edit", 2, blend("chamfer", json!([0]), 1.0))),
        995.0,
    );
    probe("edit", blend("fillet", json!([0]), 2.0));
    let (chamfered, other_kind) = cost(|| apply("edit", 3, blend("chamfer", json!([0]), 2.0)));
    near(volume(&chamfered), 980.0);
    assert_eq!(other_kind, work(1, 1, 1), "a fillet probe is not a chamfer");

    assert_eq!(
        probe("edit", blend("fillet", json!([0, 1]), 1.0)),
        json!({ "ok": true })
    );
    let two = volume(&apply("edit", 4, blend("fillet", json!([0, 1]), 1.0)));
    let one_mm = 10.0 * (1.0 - PI / 4.0);
    assert!(
        two < 1000.0 - one_mm - 0.5,
        "two edges should remove more than one: {two}"
    );
    assert!(two > 900.0, "two edges still leave a solid: {two}");

    refused(
        &apply("edit", 5, hole([5.0, 5.0, 10.0], 0.0, 12.0)),
        "A hole needs a positive radius and depth",
    );
    let miss = hole([100.0, 0.0, 10.0], 2.0, 12.0);
    refused(
        &apply("edit", 5, miss.clone()),
        "The hole missed this solid",
    );
    assert_eq!(
        probe("edit", miss),
        json!({ "ok": false, "error": "The hole missed this solid" })
    );
    refused(
        &apply("edit", 5, hole([5.0, 5.0, 11.0], 20.0, 12.0)),
        "The hole removed the solid",
    );
    let drilled = 1000.0 - PI * 4.0 * 10.0;
    let through = apply("edit", 5, hole([5.0, 5.0, 10.0], 2.0, 12.0));
    near(volume(&through), drilled);
    drilled_mesh_is_its_triangulation(&through, 10.0, 5.0, 5.0, 2.0);
    let mut side = hole([10.0, 5.0, 5.0], 2.0, 12.0);
    side["axis"] = json!([-1.0, 0.0, 0.0]);
    near(volume(&apply("edit", 6, side)), drilled);

    refused(
        &apply("edit", 7, json!({ "kind": "scale", "factor": 0.0 })),
        "Scale needs a positive factor",
    );
    let (grown, growing) = cost(|| apply("edit", 7, json!({ "kind": "scale", "factor": 2.0 })));
    near(volume(&grown), 8000.0);
    assert_eq!(growing.volumes, 0, "a scale's volume is the factor cubed");
    ok(json!({ "call": "close", "key": "edit" }));
    assert_shared("TKFillet");
}

fn exported(key: &str, node: u32) -> Vec<u8> {
    let reply = ok(json!({ "call": "export", "key": key, "node": node }));
    let data = reply["bytesBase64"].as_str().expect("bytesBase64");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64");
    assert_eq!(reply["byteLength"].as_u64(), Some(bytes.len() as u64));
    bytes
}

fn step_export_round_trip() {
    ok(json!({ "call": "open", "key": "export", "box": [10.0, 10.0, 10.0] }));
    let bytes = exported("export", 0);
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("AUTOMOTIVE_DESIGN"),
        "schema is not AP214: {text}"
    );
    assert!(
        text.contains("MANIFOLD_SOLID_BREP"),
        "not a manifold solid: {text}"
    );
    ok(json!({ "call": "close", "key": "export" }));

    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let reread = ok(json!({ "call": "open", "key": "reread", "dataB64": data }));
    near(volume(&reread), 1000.0);
    assert_eq!(reread["solid"], true);
    near(
        volume(&apply(
            "reread",
            1,
            cube("fuse", [10.0, 0.0, 0.0], [10.0; 3]),
        )),
        2000.0,
    );
    let edited = base64::engine::general_purpose::STANDARD.encode(exported("reread", 1));
    ok(json!({ "call": "close", "key": "reread" }));
    let again = ok(json!({ "call": "open", "key": "again", "dataB64": edited }));
    near(volume(&again), 2000.0);
    ok(json!({ "call": "close", "key": "again" }));
}

fn bridge_exports(measured: bool) {
    let path = bridge_path();
    if !path.is_file() {
        assert!(!require(), "bridge cdylib is missing at {}", path.display());
        return;
    }
    // The loader looks at LIME_OCCT_BRIDGE before the executable directory.
    unsafe { std::env::set_var("LIME_OCCT_BRIDGE", &path) };
    let loaded =
        |request: Value| parse(&lime_model_load::tree(&request.to_string()).expect("dlopen"));
    let opened = loaded(json!({ "call": "open", "key": "dlopen", "box": [10.0, 20.0, 30.0] }));
    if !measured {
        return;
    }
    near(volume(&opened), 6000.0);
    let fused = loaded(
        json!({ "call": "apply", "key": "dlopen", "parent": 0, "node": 1,
        "op": cube("fuse", [20.0, 0.0, 0.0], [10.0; 3]) }),
    );
    near(volume(&fused), 7000.0);
    let grown = loaded(
        json!({ "call": "apply", "key": "dlopen", "parent": 1, "node": 2,
        "op": { "kind": "scale", "factor": 2.0 } }),
    );
    near(volume(&grown), 56000.0);
    let export = loaded(json!({ "call": "export", "key": "dlopen", "node": 2 }));
    if export["error"] == "STEP writer is not linked" && !require() {
        return;
    }
    let data = export["bytesBase64"]
        .as_str()
        .unwrap_or_else(|| panic!("{export}"));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64");
    assert!(String::from_utf8_lossy(&bytes).contains("MANIFOLD_SOLID_BREP"));
}

fn bridge_path() -> PathBuf {
    let name = if cfg!(windows) {
        "lime_model_occt.dll"
    } else if cfg!(target_os = "macos") {
        "liblime_model_occt.dylib"
    } else {
        "liblime_model_occt.so"
    };
    let exe = std::env::current_exe().expect("test executable");
    let deps = exe.parent().expect("deps directory");
    let beside_tests = deps.join(name);
    if beside_tests.is_file() {
        return beside_tests;
    }
    deps.parent().expect("target directory").join(name)
}

fn assert_shared(stem: &str) {
    #[cfg(windows)]
    {
        let _ = stem;
    }
    #[cfg(not(windows))]
    {
        let exe = std::env::current_exe().expect("test executable");
        let tool = if cfg!(target_os = "macos") {
            "otool"
        } else {
            "ldd"
        };
        let mut cmd = std::process::Command::new(tool);
        if cfg!(target_os = "macos") {
            cmd.arg("-L");
        }
        let out = cmd.arg(&exe).output().expect(tool);
        assert!(out.status.success(), "{tool} failed");
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = if cfg!(target_os = "macos") {
            format!("lib{stem}.")
        } else {
            format!("lib{stem}.so")
        };
        assert!(
            text.lines()
                .any(|line| line.contains(&needle) && !line.contains("not found")),
            "{stem} is not a resolved dynamic import of {}. {text}",
            exe.display()
        );
    }
}
