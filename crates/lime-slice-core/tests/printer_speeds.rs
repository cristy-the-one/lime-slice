//! A printer's own speeds (`printer.speeds`): the default blend prints exactly
//! the printer's numbers, the first layer keeps to its first-layer feeds and
//! accel, and a printer that names none slices as it always has.

use base64::Engine;
use lime_slice_core::{
    slice_configured, slice_request, BlendMode, Job, Mesh, PrinterProfile, PrinterSpeeds,
    SliceRequest, SliceSettings, StrategyId,
};
use serde_json::{json, Value};

fn face(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> [[[f64; 3]; 3]; 2] {
    [[a, b, c], [a, c, d]]
}

fn block(x: f64, y: f64, z: f64) -> Mesh {
    let corners = [
        [0.0, 0.0, 0.0],
        [x, 0.0, 0.0],
        [x, y, 0.0],
        [0.0, y, 0.0],
        [0.0, 0.0, z],
        [x, 0.0, z],
        [x, y, z],
        [0.0, y, z],
    ];
    let mut triangles = Vec::new();
    for (a, b, c, d) in [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ] {
        triangles.extend(face(corners[a], corners[b], corners[c], corners[d]));
    }
    Mesh { triangles }
}

/// A printer that names every feed and accel.
fn table() -> PrinterSpeeds {
    PrinterSpeeds {
        outer_wall: Some(96.0),
        inner_wall: Some(160.0),
        sparse_infill: Some(160.0),
        solid_infill: Some(200.0),
        top_surface: Some(160.0),
        gap_infill: Some(90.0),
        support: Some(90.0),
        support_interface: Some(50.0),
        travel: Some(200.0),
        first_layer: Some(40.0),
        first_layer_infill: Some(84.0),
        accel: Some(4000.0),
        outer_wall_accel: Some(2000.0),
        inner_wall_accel: Some(4000.0),
        sparse_infill_accel: Some(4000.0),
        solid_infill_accel: Some(4000.0),
        top_surface_accel: Some(2000.0),
        travel_accel: Some(5000.0),
        first_layer_accel: Some(500.0),
    }
}

/// A printer whose flow and accel caps never bind, so the feeds are the planned ones.
fn printer(speeds: Option<PrinterSpeeds>) -> PrinterProfile {
    PrinterProfile {
        max_volumetric_mm3_s: 1000.0,
        max_accel: 20000.0,
        speeds,
        ..PrinterProfile::default()
    }
}

fn slice(blend: BlendMode, profile: &PrinterProfile) -> String {
    slice_configured(
        &block(40.0, 40.0, 6.0),
        &blend,
        profile,
        &SliceSettings {
            include_preview: false,
            ..SliceSettings::default()
        },
    )
    .expect("slice")
    .gcode
}

fn default_blend() -> BlendMode {
    BlendMode::Weight { toughness: 0.5 }
}

/// Each printing move: layer, `; TYPE:`, the feed in mm/s, and the accel last set.
struct Move {
    layer: usize,
    kind: String,
    feed: f64,
    accel: f64,
}

fn moves(gcode: &str) -> Vec<Move> {
    let mut out = Vec::new();
    let (mut layer, mut kind, mut feed, mut accel) = (0usize, String::new(), 0.0, 0.0);
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer = rest.split_whitespace().next().unwrap().parse().unwrap();
            continue;
        }
        if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("M204 S") {
            accel = rest.split_whitespace().next().unwrap().parse().unwrap();
            continue;
        }
        if !(line.starts_with("G0 ") || line.starts_with("G1 ")) {
            continue;
        }
        let code = line.split(';').next().unwrap();
        if let Some(f) = code.split_whitespace().find_map(|w| w.strip_prefix('F')) {
            feed = f.parse::<f64>().unwrap() / 60.0;
        }
        let prints = code.contains(" E") && (code.contains(" X") || code.contains(" Y"));
        if prints {
            out.push(Move {
                layer,
                kind: kind.clone(),
                feed,
                accel,
            });
        }
    }
    out
}

fn fastest(all: &[Move], pick: impl Fn(&Move) -> bool) -> f64 {
    all.iter().filter(|m| pick(m)).map(|m| m.feed).fold(0.0, f64::max)
}

#[test]
fn a_printer_with_no_speeds_slices_as_before() {
    let none = slice(default_blend(), &printer(None));
    let empty = slice(default_blend(), &printer(Some(PrinterSpeeds::default())));
    assert_eq!(none, empty, "an empty speeds block changed the G-code");
    let all = moves(&none);
    assert!(fastest(&all, |m| m.layer == 0) <= 30.0 + 1e-6, "the first layer left 30 mm/s");
}

#[test]
fn the_default_blend_prints_the_printers_numbers() {
    let all = moves(&slice(default_blend(), &printer(Some(table()))));
    let above = |kind: &'static str| move |m: &Move| m.layer >= 3 && m.kind == kind;
    let outer = fastest(&all, above("OUTER"));
    let inner = fastest(&all, above("INNER"));
    assert!((outer - 96.0).abs() < 0.02, "outer wall {outer}");
    assert!((inner - 160.0).abs() < 0.02, "inner wall {inner}");
    let top = fastest(&all, |m| m.kind == "TOP");
    assert!((top - 160.0).abs() < 0.02, "top surface {top}");
}

#[test]
fn the_first_layer_keeps_to_the_printers_first_layer_feeds_and_accel() {
    let all = moves(&slice(default_blend(), &printer(Some(table()))));
    let first: Vec<&Move> = all.iter().filter(|m| m.layer == 0).collect();
    assert!(!first.is_empty());
    let walls = first
        .iter()
        .filter(|m| matches!(m.kind.as_str(), "OUTER" | "INNER" | "WALL" | "SKIRT"))
        .map(|m| m.feed)
        .fold(0.0, f64::max);
    let fill = first
        .iter()
        .filter(|m| matches!(m.kind.as_str(), "SOLID" | "SPARSE" | "INFILL" | "TOP" | "GAP-FILL"))
        .map(|m| m.feed)
        .fold(0.0, f64::max);
    assert!((walls - 40.0).abs() < 0.02, "first-layer walls {walls}");
    assert!((fill - 84.0).abs() < 0.02, "first-layer infill {fill}");
    let accel = first.iter().map(|m| m.accel).fold(0.0, f64::max);
    assert!(accel <= 500.0 + 1e-6 && accel > 0.0, "first-layer accel {accel}");
    let later = all.iter().filter(|m| m.layer >= 3).map(|m| m.accel).fold(0.0, f64::max);
    assert!(later > 500.0, "the first-layer accel held past the first layer: {later}");
}

#[test]
fn the_slider_ends_move_with_the_printer() {
    let outer = |blend: BlendMode, speeds: Option<PrinterSpeeds>| {
        fastest(&moves(&slice(blend, &printer(speeds))), |m| {
            m.layer >= 3 && m.kind == "OUTER"
        })
    };
    let speed = || BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let own_speed = outer(speed(), None);
    let own_mid = outer(default_blend(), None);
    let ir3_speed = outer(speed(), Some(table()));
    // Speed stays faster than the default blend by the same ratio it always was.
    let want = own_speed * 96.0 / own_mid;
    assert!(
        (ir3_speed - want).abs() < 0.05,
        "Speed end {ir3_speed}, expected {want} (own Speed {own_speed}, own default {own_mid})"
    );
    assert!(ir3_speed > 96.0);
}

/// The built-in IR3 V2's block (src/ui/machine-library.ts): a slower, gentler first layer and a softer outer wall.
fn ir3_v2() -> PrinterSpeeds {
    PrinterSpeeds {
        first_layer: Some(25.0),
        outer_wall_accel: Some(2000.0),
        first_layer_accel: Some(500.0),
        ..PrinterSpeeds::default()
    }
}

#[test]
fn the_ir3_v2_keeps_every_feed_but_the_first_layers_and_softens_only_the_first_layer_and_outer_wall() {
    let own = moves(&slice(default_blend(), &printer(None)));
    let ir3 = moves(&slice(default_blend(), &printer(Some(ir3_v2()))));
    assert_eq!(own.len(), ir3.len());
    for (a, b) in own.iter().zip(&ir3) {
        assert!(a.layer == b.layer && a.kind == b.kind, "the moves differ at layer {}", a.layer);
        // The first layer's 30 mm/s becomes 25; every other feed stays.
        let want = if a.layer == 0 && (a.feed - 30.0).abs() < 1e-9 { 25.0 } else { a.feed };
        assert!((b.feed - want).abs() < 1e-9, "a feed moved: {} {} {} -> {}", a.layer, a.kind, a.feed, b.feed);
    }
    assert!(ir3.iter().any(|m| m.layer == 0 && (m.feed - 25.0).abs() < 1e-9), "no first-layer move at 25 mm/s");
    let first = ir3.iter().filter(|m| m.layer == 0).map(|m| m.accel).fold(0.0, f64::max);
    let own_first = own.iter().filter(|m| m.layer == 0).map(|m| m.accel).fold(0.0, f64::max);
    assert!(first <= 500.0 + 1e-6 && own_first > 500.0, "first layer {first}, before {own_first}");
    let outer = ir3.iter().filter(|m| m.layer >= 3 && m.kind == "OUTER").map(|m| m.accel).fold(0.0, f64::max);
    assert!((outer - 2000.0).abs() < 1e-6, "outer wall accel {outer}");
    // Nothing else got harsher.
    for (a, b) in own.iter().zip(&ir3) {
        assert!(b.accel <= a.accel + 1e-6, "accel rose: {} {} {} -> {}", a.layer, a.kind, a.accel, b.accel);
    }
}

fn stl(mesh: &Mesh) -> String {
    let mut out = String::from("solid part
");
    for t in &mesh.triangles {
        out.push_str("facet normal 0 0 0
outer loop
");
        for v in t {
            out.push_str(&format!("vertex {} {} {}
", v[0], v[1], v[2]));
        }
        out.push_str("endloop
endfacet
");
    }
    out.push_str("endsolid part
");
    out
}

/// Two copies of a block on a 45° belt, as the app sends it.
fn belt_request(speeds: Option<Value>) -> SliceRequest {
    let mut printer = json!({
        "name": "belt", "nozzleDiameter": 0.4, "filamentDiameter": 1.75,
        "nozzleTemp": 210, "bedTemp": 60, "bedX": 220, "bedY": 220,
        "maxAccel": 20000, "maxVolumetricMm3S": 1000
    });
    if let Some(speeds) = speeds {
        printer["speeds"] = speeds;
    }
    serde_json::from_value(json!({
        "filename": "block.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl(&block(12.0, 12.0, 3.0)).as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
        "printer": printer,
        "belt": { "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 220.0, "copies": 2, "gapMm": 5.0 },
    }))
    .unwrap()
}

/// Belt-contact moves after the first layer: the walls and support feet retouched to the first-layer feed.
fn contact_moves(all: &[Move]) -> Vec<&Move> {
    all.iter()
        .filter(|m| m.layer > 0 && (m.feed - 30.0).abs() < 1e-6)
        .collect()
}

#[test]
fn on_a_belt_everything_touching_the_belt_takes_the_first_layer_accel() {
    let plain = slice_request(&belt_request(None), Job::default()).unwrap().gcode;
    let empty = slice_request(&belt_request(Some(json!({}))), Job::default()).unwrap().gcode;
    assert_eq!(plain, empty, "an empty speeds block changed a belt slice");
    let gentle = slice_request(&belt_request(Some(json!({ "firstLayerAccel": 500 }))), Job::default())
        .unwrap()
        .gcode;
    let before = moves(&plain);
    let after = moves(&gentle);
    let touched_before = contact_moves(&before);
    let touched = contact_moves(&after);
    assert!(!touched.is_empty(), "no belt-contact move after the first layer");
    assert_eq!(touched.len(), touched_before.len(), "the contact edges moved");
    assert!(
        touched_before.iter().any(|m| m.accel > 500.0),
        "the belt edges were already gentle, so this proves nothing"
    );
    for m in &touched {
        assert!(m.accel <= 500.0 + 1e-6, "layer {} {} touches the belt at accel {}", m.layer, m.kind, m.accel);
    }
    // Moves clear of the belt keep their accel.
    let free = after
        .iter()
        .filter(|m| m.layer > 0 && (m.feed - 30.0).abs() > 1e-6)
        .map(|m| m.accel)
        .fold(0.0, f64::max);
    assert!(free > 500.0, "the whole part went gentle: {free}");
    // The second copy's first layer is a first layer too.
    let copy_first: Vec<&Move> = after
        .iter()
        .filter(|m| m.layer > 0 && m.feed <= 30.0 + 1e-6)
        .collect();
    assert!(copy_first.iter().all(|m| m.accel <= 500.0 + 1e-6));
}
