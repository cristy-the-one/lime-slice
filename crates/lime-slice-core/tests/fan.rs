//! The user's part-cooling fan: off for the first layers, then Fan %, with
//! Overhang fan % on overhangs and bridges and Support fan % on supports.

use base64::Engine;
use lime_slice_core::{
    slice_configured, slice_request, BlendMode, Job, Mesh, PrinterProfile, SliceRequest,
    SliceSettings, StrategyId, SupportStyle,
};
use serde_json::json;

fn face(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> [[[f64; 3]; 3]; 2] {
    [[a, b, c], [a, c, d]]
}

fn add_box(tris: &mut Vec<[[f64; 3]; 3]>, lo: [f64; 3], hi: [f64; 3]) {
    let [x0, y0, z0] = lo;
    let [x1, y1, z1] = hi;
    let corners = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
    ];
    for (a, b, c, d) in [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ] {
        tris.extend(face(corners[a], corners[b], corners[c], corners[d]));
    }
}

/// Two towers and a 14 mm deck: the deck's first layer bridges.
fn bridge_span() -> Mesh {
    let mut triangles = Vec::new();
    add_box(&mut triangles, [0.0, 0.0, 0.0], [8.0, 16.0, 8.0]);
    add_box(&mut triangles, [22.0, 0.0, 0.0], [30.0, 16.0, 8.0]);
    add_box(&mut triangles, [0.0, 4.0, 8.0], [30.0, 12.0, 10.0]);
    Mesh { triangles }
}

/// A body with a 10 mm ledge off +Y from z 6: the ledge's walls overhang,
/// and trees grow under it.
fn ledge() -> Mesh {
    let mut triangles = Vec::new();
    add_box(&mut triangles, [0.0, 0.0, 0.0], [16.0, 12.0, 10.0]);
    add_box(&mut triangles, [0.0, 12.0, 6.0], [16.0, 22.0, 10.0]);
    Mesh { triangles }
}

fn fans(
    fan: Option<u8>,
    overhang: Option<u8>,
    support: Option<u8>,
    off: Option<u32>,
) -> PrinterProfile {
    PrinterProfile {
        fan_percent: fan,
        overhang_fan_percent: overhang,
        support_fan_percent: support,
        fan_off_layers: off,
        ..PrinterProfile::default()
    }
}

fn slice(mesh: &Mesh, profile: &PrinterProfile, settings: SliceSettings) -> String {
    slice_configured(
        mesh,
        &BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        profile,
        &SliceSettings {
            include_preview: false,
            ..settings
        },
    )
    .expect("slice")
    .gcode
}

fn trees() -> SliceSettings {
    SliceSettings {
        supports: true,
        support_style: SupportStyle::Tree,
        ..SliceSettings::default()
    }
}

/// One printing move: its layer, its `; TYPE:`, and the fan it runs under.
#[derive(Debug)]
struct Bead {
    layer: usize,
    kind: String,
    fan: u32,
}

fn beads(gcode: &str) -> Vec<Bead> {
    let mut out = Vec::new();
    let (mut layer, mut kind, mut fan) = (0usize, String::new(), 0u32);
    for line in gcode.lines() {
        if let Some(rest) = line.strip_prefix(";LAYER:") {
            layer = rest.split_whitespace().next().unwrap().parse().unwrap();
        } else if let Some(rest) = line.strip_prefix("; TYPE:") {
            kind = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("M106 S") {
            fan = rest.trim().parse().unwrap();
        } else if (line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 "))
            && line.contains(" E")
            && (line.contains(" X") || line.contains(" Y"))
        {
            out.push(Bead {
                layer,
                kind: kind.clone(),
                fan,
            });
        }
    }
    out
}

fn fans_of<'a>(beads: &'a [Bead], pick: impl Fn(&Bead) -> bool + 'a) -> Vec<u32> {
    let mut seen: Vec<u32> = beads.iter().filter(|b| pick(b)).map(|b| b.fan).collect();
    seen.sort_unstable();
    seen.dedup();
    seen
}

fn is_support(kind: &str) -> bool {
    kind == "SUPPORT" || kind == "SUPPORT-INTERFACE"
}

#[test]
fn a_request_that_names_no_fan_keeps_its_bytes_and_its_ramp() {
    let named_none = fans(None, None, None, None);
    let plain = slice(&ledge(), &PrinterProfile::default(), trees());
    assert_eq!(plain, slice(&ledge(), &named_none, trees()));
    let features = plain
        .lines()
        .find(|l| l.starts_with("; features:"))
        .unwrap();
    assert!(!features.contains("fan"), "{features}");
    let all = beads(&plain);
    assert_eq!(fans_of(&all, |b| b.layer == 0), vec![0]);
    assert_eq!(fans_of(&all, |b| b.layer == 1), vec![128]);
    assert_eq!(
        fans_of(&all, |b| b.layer >= 2 && b.kind != "BRIDGE"),
        vec![255],
        "speed runs the fan full"
    );

    let req: SliceRequest = serde_json::from_str(r#"{"printer":{"name":"p","nozzleDiameter":0.4,"filamentDiameter":1.75,"nozzleTemp":200,"bedTemp":60,"bedX":220,"bedY":220}}"#).unwrap();
    let printer = req.printer.unwrap();
    assert!(!printer.names_fan());
    let text = serde_json::to_string(&printer).unwrap();
    assert!(!text.contains("fan") && !text.contains("Fan"), "{text}");
}

#[test]
fn the_first_layers_are_off_then_the_fan_percent_runs() {
    let gcode = slice(&ledge(), &fans(Some(20), Some(100), None, Some(3)), trees());
    let all = beads(&gcode);
    assert_eq!(fans_of(&all, |b| b.layer < 3), vec![0], "no 50% ramp");
    assert_eq!(
        fans_of(&all, |b| b.layer >= 3
            && b.layer < 20
            && !is_support(&b.kind)),
        vec![51],
        "below the ledge every part bead is at 20%"
    );
    assert!(!gcode.contains("M106 S128"), "no half-fan layer");
    let features = gcode
        .lines()
        .find(|l| l.starts_with("; features:"))
        .unwrap();
    assert!(
        features.ends_with("; fan 20%; overhang fan 100%; fan off for 3 layers"),
        "{features}"
    );

    let on_at_once = beads(&slice(
        &ledge(),
        &fans(Some(40), None, None, Some(0)),
        trees(),
    ));
    assert_eq!(
        fans_of(&on_at_once, |b| b.layer == 0 && !is_support(&b.kind)),
        vec![102]
    );
}

#[test]
fn overhangs_and_bridges_take_the_overhang_fan() {
    let profile = fans(Some(20), Some(70), None, Some(1));
    let ledge_beads = beads(&slice(&ledge(), &profile, SliceSettings::default()));
    // The ledge starts at z 6: layer 30 at 0.2 mm.
    let ledge_walls = fans_of(&ledge_beads, |b| b.layer == 30 && b.kind == "OUTER");
    assert!(
        ledge_walls.contains(&178),
        "the ledge's overhanging wall: {ledge_walls:?}"
    );
    assert!(
        ledge_walls.contains(&51),
        "its supported wall: {ledge_walls:?}"
    );
    assert!(
        ledge_walls.iter().all(|f| *f == 51 || *f == 178),
        "{ledge_walls:?}"
    );

    let bridge_beads = beads(&slice(&bridge_span(), &profile, SliceSettings::default()));
    assert_eq!(fans_of(&bridge_beads, |b| b.kind == "BRIDGE"), vec![178]);
    assert_eq!(
        fans_of(&bridge_beads, |b| b.layer >= 1 && b.layer < 40),
        vec![51]
    );
}

#[test]
fn a_set_bridge_fan_still_wins_on_bridges() {
    let profile = fans(Some(20), Some(100), None, Some(1));
    let gcode = slice(
        &bridge_span(),
        &profile,
        SliceSettings {
            bridge_fan_percent: Some(80),
            ..SliceSettings::default()
        },
    );
    let all = beads(&gcode);
    assert_eq!(fans_of(&all, |b| b.kind == "BRIDGE"), vec![204]);
    assert_eq!(
        fans_of(&all, |b| b.kind != "BRIDGE" && b.layer >= 1),
        vec![51, 255],
        "the deck's overhanging edges keep the overhang fan, everything else is at 20%"
    );
}

#[test]
fn supports_take_the_support_fan_and_no_overhang_boost() {
    let own = beads(&slice(
        &ledge(),
        &fans(Some(20), Some(100), Some(0), Some(1)),
        trees(),
    ));
    assert!(
        own.iter().any(|b| is_support(&b.kind)),
        "the ledge grows supports"
    );
    assert_eq!(fans_of(&own, |b| is_support(&b.kind)), vec![0]);

    let follows = beads(&slice(
        &ledge(),
        &fans(Some(20), Some(100), None, Some(1)),
        trees(),
    ));
    assert_eq!(
        fans_of(&follows, |b| is_support(&b.kind) && b.layer >= 1),
        vec![51],
        "support follows Fan % and never takes the overhang fan"
    );

    let alone = beads(&slice(&ledge(), &fans(None, None, Some(30), None), trees()));
    assert_eq!(
        fans_of(&alone, |b| is_support(&b.kind) && b.layer >= 2),
        vec![76]
    );
    assert_eq!(
        fans_of(&alone, |b| !is_support(&b.kind)
            && b.layer >= 2
            && b.layer < 30),
        vec![255],
        "the part keeps the strategy fan"
    );
}

#[test]
fn belt_contact_walls_stay_off() {
    let stl = {
        let mut tris = Vec::new();
        add_box(&mut tris, [0.0, 0.0, 0.0], [10.0, 10.0, 4.0]);
        let mut out = String::from("solid box\n");
        for t in tris {
            out.push_str("facet normal 0 0 0\nouter loop\n");
            for v in t {
                out.push_str(&format!("vertex {} {} {}\n", v[0], v[1], v[2]));
            }
            out.push_str("endloop\nendfacet\n");
        }
        out.push_str("endsolid box\n");
        out
    };
    let req: SliceRequest = serde_json::from_value(json!({
        "filename": "box.stl",
        "dataB64": base64::engine::general_purpose::STANDARD.encode(stl.as_bytes()),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "baseline": false,
        "compare": false,
        "includePreview": false,
        "includeGcode": true,
        "printer": {
            "name": "belt", "nozzleDiameter": 0.4, "filamentDiameter": 1.75,
            "nozzleTemp": 240, "bedTemp": 80, "bedX": 220, "bedY": 220,
            "fanPercent": 20, "overhangFanPercent": 100, "fanOffLayers": 0
        },
        "belt": { "angleDeg": 45.0, "axis": "z", "direction": 1, "widthMm": 220.0, "copies": 1, "gapMm": 5.0 },
    }))
    .unwrap();
    let gcode = slice_request(&req, Job::default()).unwrap().gcode;
    let all = beads(&gcode);
    let walls = fans_of(&all, |b| b.layer >= 1 && b.kind == "OUTER");
    assert!(
        walls.contains(&0),
        "the belt-contact wall is off: {walls:?}"
    );
    assert!(walls.contains(&51), "the free wall is at 20%: {walls:?}");
}
