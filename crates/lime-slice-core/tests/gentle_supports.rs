//! Supports that stay standing: gentle printing and a brim, the same for
//! every support style, on a flat bed and on the belt.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use lime_slice_core::{slice_request, Job, SliceRequest, SliceResponse};
use serde_json::{json, Value};

const STYLES: [&str; 2] = ["grid", "tree"];

fn ledge_b64() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/overhang_ledge.stl");
    base64::engine::general_purpose::STANDARD.encode(fs::read(path).unwrap())
}

fn belt() -> Value {
    json!({
        "angleDeg": 45.0,
        "axis": "z",
        "direction": 1,
        "widthMm": 220.0,
        "copies": 1,
        "gapMm": 5.0,
        "floorSupports": true,
    })
}

/// A mostly-Speed slice of the ledge (the pure Speed strategy grows no grid
/// shaft on the belt here) with supports of `style`, on the belt when
/// `on_belt`, with `extra` request fields.
fn slice(style: &str, on_belt: bool, extra: Value) -> SliceResponse {
    let mut body = json!({
        "filename": "overhang_ledge.stl",
        "dataB64": ledge_b64(),
        "layerHeight": 0.2,
        "lineWidth": 0.45,
        "blend": {"mode": "weight", "toughness": 0.3},
        "supports": true,
        "supportStyle": style,
        "arcFit": false,
        "baseline": false,
        "compare": false,
        "includePreview": true,
        "includeGcode": true,
    });
    if on_belt {
        body["belt"] = belt();
    }
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    let req: SliceRequest = serde_json::from_value(body).unwrap();
    slice_request(&req, Job::default()).unwrap()
}

fn is_support(kind: &str) -> bool {
    kind == "support" || kind == "support-interface"
}

fn word(line: &str, axis: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .find_map(|t| t.strip_prefix(axis)?.parse::<f64>().ok())
}

/// Support extrusion length, mm, by the `M204 S` in force while it printed.
fn support_accels(gcode: &str) -> Vec<(f64, f64)> {
    let (mut kind, mut accel, mut at) = (String::new(), 0.0, [0.0, 0.0]);
    let mut by: Vec<(f64, f64)> = Vec::new();
    for line in gcode.lines() {
        if let Some(k) = line.strip_prefix("; TYPE:") {
            kind = k.to_owned();
            continue;
        }
        if line.starts_with("M204") {
            accel = word(line, 'S').unwrap_or(accel);
            continue;
        }
        if !line.starts_with("G1 ") {
            continue;
        }
        let to = [
            word(line, 'X').unwrap_or(at[0]),
            word(line, 'Y').unwrap_or(at[1]),
        ];
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        if kind.starts_with("SUPPORT") && word(line, 'E').is_some() && len > 1e-9 {
            match by.iter_mut().find(|(a, _)| *a == accel) {
                Some(row) => row.1 += len,
                None => by.push((accel, len)),
            }
        }
        at = to;
    }
    by
}

/// Travels between two support paths that did not retract, as lengths in mm.
fn dry_support_travels(gcode: &str) -> Vec<f64> {
    let (mut kind, mut e, mut at) = (String::new(), 0.0, [0.0, 0.0]);
    let (mut last, mut pulled, mut travel) = (String::new(), false, 0.0);
    let mut out = Vec::new();
    for line in gcode.lines() {
        if let Some(k) = line.strip_prefix("; TYPE:") {
            kind = k.to_owned();
            continue;
        }
        if line.starts_with(";LAYER:") {
            last.clear();
            continue;
        }
        if !line.starts_with("G1 ") {
            continue;
        }
        let (x, y, ne) = (word(line, 'X'), word(line, 'Y'), word(line, 'E'));
        if x.is_none() && y.is_none() {
            if let Some(v) = ne {
                if v < e - 1e-6 {
                    pulled = true;
                }
                e = v;
            }
            continue;
        }
        let to = [x.unwrap_or(at[0]), y.unwrap_or(at[1])];
        let len = (to[0] - at[0]).hypot(to[1] - at[1]);
        match ne {
            Some(v) if v > e + 1e-9 => {
                if travel > 0.0
                    && !pulled
                    && last.starts_with("SUPPORT")
                    && kind.starts_with("SUPPORT")
                {
                    out.push(travel);
                }
                e = v;
                last = kind.clone();
                pulled = false;
                travel = 0.0;
            }
            _ => travel += len,
        }
        at = to;
    }
    out
}

fn part_seconds(reply: &SliceResponse) -> f64 {
    reply
        .estimate
        .by_feature
        .iter()
        .filter(|f| !f.kind.starts_with("support") && f.kind != "travel")
        .map(|f| f.seconds)
        .sum()
}

fn support_filament(reply: &SliceResponse) -> f64 {
    reply
        .estimate
        .by_feature
        .iter()
        .filter(|f| f.kind.starts_with("support"))
        .map(|f| f.filament_mm)
        .sum()
}

#[test]
fn gentle_supports_print_every_style_slower_and_softer_on_a_flat_bed_and_the_belt() {
    for on_belt in [false, true] {
        for style in STYLES {
            let base = slice(style, on_belt, json!({}));
            let gentle = slice(style, on_belt, json!({"supportSlowFragile": true}));
            let at = format!(
                "{style} on {}",
                if on_belt { "the belt" } else { "a flat bed" }
            );
            let fastest = |reply: &SliceResponse, kind: &str| {
                reply
                    .layers
                    .iter()
                    .flat_map(|l| &l.paths)
                    .filter(|p| p.kind == kind)
                    .map(|p| p.speed)
                    .fold(0.0, f64::max)
            };
            assert!(
                fastest(&base, "support") > 40.0,
                "{at}: {}",
                fastest(&base, "support")
            );
            assert!(fastest(&gentle, "support") <= 40.0 + 1e-9, "{at}");
            assert!(fastest(&gentle, "support-interface") <= 30.0 + 1e-9, "{at}");
            let base_accels = support_accels(&base.gcode);
            let accels = support_accels(&gentle.gcode);
            assert!(
                base_accels.iter().any(|(a, _)| *a > 2000.0),
                "{at}: {base_accels:?}"
            );
            assert!(!accels.is_empty(), "{at}");
            assert!(accels.iter().all(|(a, _)| *a <= 2000.0), "{at}: {accels:?}");
            assert!(gentle.estimate.seconds > base.estimate.seconds, "{at}");
            assert!(
                (part_seconds(&gentle) - part_seconds(&base)).abs() < 1e-6,
                "{at}: the part keeps its time"
            );
            assert!(gentle
                .gcode
                .contains("printed gently at 40 mm/s and 2000 mm/s²"));
        }
    }
}

#[test]
fn gentle_speed_and_acceleration_are_the_requested_ones() {
    for style in STYLES {
        let reply = slice(
            style,
            false,
            json!({"supportSlowFragile": true, "supportGentleSpeedMmS": 25, "supportGentleAccelMmS2": 1200}),
        );
        let speeds: Vec<f64> = reply
            .layers
            .iter()
            .flat_map(|l| &l.paths)
            .filter(|p| is_support(&p.kind))
            .map(|p| p.speed)
            .collect();
        assert!(!speeds.is_empty());
        assert!(
            speeds.iter().all(|s| *s <= 25.0 + 1e-9),
            "{style}: {speeds:?}"
        );
        let accels = support_accels(&reply.gcode);
        assert!(
            accels.iter().all(|(a, _)| *a <= 1200.0),
            "{style}: {accels:?}"
        );
        // The estimate times the lower acceleration too.
        let fast = slice(
            style,
            false,
            json!({"supportSlowFragile": true, "supportGentleSpeedMmS": 25, "supportGentleAccelMmS2": 5000}),
        );
        assert!(reply.estimate.seconds > fast.estimate.seconds, "{style}");
    }
}

#[test]
fn gentle_supports_retract_on_travels_between_supports() {
    for on_belt in [false, true] {
        for style in STYLES {
            let base = dry_support_travels(&slice(style, on_belt, json!({})).gcode);
            let gentle = dry_support_travels(
                &slice(style, on_belt, json!({"supportSlowFragile": true})).gcode,
            );
            let long = |t: &[f64]| t.iter().filter(|d| **d >= 4.0).count();
            assert!(long(&base) > 0, "{style} {on_belt}: {}", long(&base));
            assert!(
                long(&gentle) * 10 <= long(&base),
                "{style} {on_belt}: {} of {} unretracted travels of 4 mm or more are left",
                long(&gentle),
                long(&base)
            );
        }
    }
}

#[test]
fn classic_slices_are_left_as_they_were() {
    let plain = slice("grid", false, json!({"classic": true}));
    let asked = slice(
        "grid",
        false,
        json!({"classic": true, "supportSlowFragile": true, "supportGentleSpeedMmS": 20, "supportTreeBrimMm": 3}),
    );
    assert_eq!(plain.gcode, asked.gcode);
}

#[test]
fn a_support_brim_widens_every_style_where_it_stands_on_the_bed() {
    for style in STYLES {
        let base = slice(style, false, json!({}));
        let brim = slice(style, false, json!({"supportTreeBrimMm": 3}));
        let first = |reply: &SliceResponse| -> usize {
            reply.layers[0]
                .paths
                .iter()
                .filter(|p| p.kind == "support")
                .count()
        };
        assert!(
            first(&brim) > first(&base),
            "{style}: {} vs {}",
            first(&brim),
            first(&base)
        );
        assert!(support_filament(&brim) > support_filament(&base), "{style}");
        for layer in &brim.layers[1..] {
            let same = base.layers.iter().find(|l| l.index == layer.index).unwrap();
            assert_eq!(
                layer.support_paths, same.support_paths,
                "{style}: layer {}",
                layer.index
            );
        }
        assert!(brim.gcode.contains(", brim 3.0 mm)"));
    }
}

#[test]
fn a_support_brim_lies_on_the_belt_beside_every_style() {
    for style in STYLES {
        let base = slice(style, true, json!({}));
        let brim = slice(style, true, json!({"supportTreeBrimMm": 3}));
        // Support beads lying on the belt: every point's centreline within a
        // bead's half width of it.
        let on_belt = |reply: &SliceResponse| -> (usize, f64) {
            let mut n = 0;
            let mut lowest = f64::INFINITY;
            for path in reply.layers.iter().flat_map(|l| &l.paths) {
                if path.kind != "support" {
                    continue;
                }
                for z in &path.zs {
                    lowest = lowest.min(*z);
                }
                if !path.zs.is_empty() && path.zs.iter().all(|z| *z < 0.2) {
                    n += 1;
                }
            }
            (n, lowest)
        };
        let (was, _) = on_belt(&base);
        let (now, lowest) = on_belt(&brim);
        assert!(now > was + 10, "{style}: {was} -> {now} beads on the belt");
        assert!(
            lowest >= -0.05,
            "{style}: a brim bead went through the belt at {lowest}"
        );
        assert!(support_filament(&brim) > support_filament(&base), "{style}");
        assert!(brim.sanity.ok, "{style}: {:?}", brim.sanity.notes);
    }
}
